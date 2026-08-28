/**
 * Operator inbox consumer tests.
 *
 * Base drain behavior: WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / bdc-xo#1455.
 * Backpressure behavior: WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01, Section 11:
 *   1. bounded drain (batch cap + bounded external calls)
 *   2. watermark prevents re-processing (no external call on repeat pass)
 *   3. retirement preserves history, terminal + non-draining, not cancelled
 *   5. alarm fires ONCE per episode, not once per pass
 *   7. empty backlog unchanged
 *
 * All deps injected; no mock.module; no real network / real DB.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  classifyOperatorMessage,
  drainOperatorInbox,
  resolveOperatorInboxIntervalMs,
  resolveOperatorInboxBatchCapacity,
  resolveOperatorInboxRetentionMs,
  resolveOperatorInboxAlarmThreshold,
  resetOperatorInboxAlarmEpisode,
  startOperatorInboxConsumer,
  stopOperatorInboxConsumer,
  getOperatorInboxRuntime,
  DEFAULT_OPERATOR_INBOX_BATCH_CAP,
  DEFAULT_OPERATOR_INBOX_RETENTION_MS,
  DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD,
  type OperatorInboxAlarm,
  type OperatorInboxDeps,
  type OperatorInboxMessage,
  type SurfaceEntry,
} from './operator-inbox-consumer';

const T0 = '2026-07-31T13:24:05.000Z';

function makeMessage(overrides: Partial<OperatorInboxMessage> = {}): OperatorInboxMessage {
  const id = overrides.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    task_type: 'run_report',
    sender: 'overseer',
    recipient: 'operator',
    body: JSON.stringify({
      kind: 'overseer_run_report',
      blocker:
        'Overseer judge health failure (evidence_unavailable) after 3 retries: judge_daily_budget_exceeded',
      woId: 'WO-HARNESS-JUDGE-BUDGET-01',
      runId: 'run-1',
    }),
    status: 'queued',
    created_at: T0,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    ...overrides,
  };
}

interface FakeRow {
  message: OperatorInboxMessage;
  watermarkedAt: string | null;
  retiredAt: string | null;
}

interface FakeWorld {
  rows: FakeRow[];
  surfaces: SurfaceEntry[];
  ackCalls: string[];
  addressCalls: string[];
  watermarkCalls: string[];
  commentCalls: string[];
  alarms: OperatorInboxAlarm[];
}

function makeWorld(seed: OperatorInboxMessage[] = []): FakeWorld {
  return {
    rows: seed.map(m => ({ message: { ...m }, watermarkedAt: null, retiredAt: null })),
    surfaces: [],
    ackCalls: [],
    addressCalls: [],
    watermarkCalls: [],
    commentCalls: [],
    alarms: [],
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<OperatorInboxDeps> = {}): OperatorInboxDeps {
  return {
    listUnwatermarked: async limit => {
      return world.rows
        .filter(
          r =>
            r.message.recipient === 'operator' &&
            r.message.status === 'queued' &&
            r.message.addressed_at === null &&
            r.watermarkedAt === null &&
            r.retiredAt === null
        )
        .sort((a, b) => a.message.created_at.localeCompare(b.message.created_at))
        .slice(0, limit)
        .map(r => ({ ...r.message }));
    },
    markWatermark: async id => {
      world.watermarkCalls.push(id);
      const row = world.rows.find(r => r.message.id === id);
      if (!row || row.watermarkedAt !== null) return false;
      row.watermarkedAt = new Date().toISOString();
      return true;
    },
    retireStale: async (retentionMs, limit) => {
      const cutoff = Date.now() - retentionMs;
      const retired: string[] = [];
      for (const row of world.rows) {
        if (retired.length >= limit) break;
        if (
          row.message.recipient === 'operator' &&
          row.message.status === 'queued' &&
          row.message.addressed_at === null &&
          row.retiredAt === null &&
          new Date(row.message.created_at).getTime() < cutoff
        ) {
          row.retiredAt = new Date().toISOString();
          retired.push(row.message.id);
        }
      }
      return retired;
    },
    getBacklogStatus: async () => {
      const backlog = world.rows.filter(
        r =>
          r.message.recipient === 'operator' &&
          r.message.status === 'queued' &&
          r.message.addressed_at === null &&
          r.retiredAt === null
      );
      const senderCounts = new Map<string, number>();
      let oldest: string | null = null;
      for (const r of backlog) {
        senderCounts.set(r.message.sender, (senderCounts.get(r.message.sender) ?? 0) + 1);
        if (oldest === null || r.message.created_at < oldest) oldest = r.message.created_at;
      }
      const topSenders = [...senderCounts.entries()]
        .map(([sender, count]) => ({ sender, count }))
        .sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender))
        .slice(0, 5);
      return { count: backlog.length, oldestCreatedAt: oldest, topSenders };
    },
    emitAlarm: alarm => {
      world.alarms.push(alarm);
    },
    acknowledgeMessage: async data => {
      world.ackCalls.push(data.id);
      const row = world.rows.find(r => r.message.id === data.id);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      const msg = row.message;
      if (msg.acknowledged_by !== null && msg.acknowledged_by !== data.principal_id) {
        return { ok: false as const, reason: 'actor_mismatch' as const };
      }
      msg.acknowledged_at = msg.acknowledged_at ?? new Date().toISOString();
      msg.acknowledged_by = data.principal_id;
      return { ok: true as const, message: msg };
    },
    addressMessage: async data => {
      world.addressCalls.push(data.id);
      const row = world.rows.find(r => r.message.id === data.id);
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      const msg = row.message;
      if (msg.acknowledged_by === null)
        return { ok: false as const, reason: 'address_before_ack' as const };
      if (msg.acknowledged_by !== data.principal_id) {
        return { ok: false as const, reason: 'actor_mismatch' as const };
      }
      msg.addressed_at = msg.addressed_at ?? new Date().toISOString();
      msg.addressed_by = data.principal_id;
      return { ok: true as const, message: msg };
    },
    surface: async entry => {
      world.surfaces.push(entry);
    },
    commentOnIssue: async issueRef => {
      world.commentCalls.push(issueRef);
    },
    principalId: 'operator',
    ...overrides,
  };
}

describe('operator inbox consumer', () => {
  afterEach(() => {
    stopOperatorInboxConsumer();
    resetOperatorInboxAlarmEpisode();
  });

  test('scenario 7 (empty backlog): drain behavior unchanged, no alarm, no calls', async () => {
    const world = makeWorld();
    const result = await drainOperatorInbox(makeDeps(world, { alarmThreshold: 1 }));
    expect(result.found).toBe(0);
    expect(result.processed).toBe(0);
    expect(result.retired).toBe(0);
    expect(result.externalCalls).toBe(0);
    expect(result.alarmEmitted).toBe(false);
    expect(world.alarms).toHaveLength(0);
    expect(world.ackCalls).toHaveLength(0);
  });

  test('backlog drain: every seeded queued operator row leaves queued (ack+address)', async () => {
    const seed: OperatorInboxMessage[] = [
      makeMessage({ id: 'rr-1' }),
      makeMessage({
        id: 'rr-2',
        body: JSON.stringify({
          kind: 'overseer_run_report',
          blocker: 'PR lookup failed for branch feature/x -- quote-wrap class',
          woId: 'WO-HARNESS-PR-LOOKUP-01',
        }),
      }),
      makeMessage({
        id: 'digest-1',
        task_type: 'agent_message',
        sender: 'taskmaster',
        body: 'Taskmaster daily digest for 2026-08-07: no actions in the last 24h.',
      }),
      makeMessage({
        id: 'rr-unknown',
        body: JSON.stringify({ kind: 'overseer_run_report', blocker: 'novel XYZ-999' }),
      }),
    ];
    const world = makeWorld(seed);
    const result = await drainOperatorInbox(makeDeps(world));

    expect(result.found).toBe(4);
    expect(result.processed).toBe(4);
    expect(result.failed).toBe(0);
    expect(world.ackCalls.sort()).toEqual(['digest-1', 'rr-1', 'rr-2', 'rr-unknown'].sort());
    expect(world.addressCalls.sort()).toEqual(['digest-1', 'rr-1', 'rr-2', 'rr-unknown'].sort());
    // Every processed row is watermarked.
    expect(world.watermarkCalls.sort()).toEqual(['digest-1', 'rr-1', 'rr-2', 'rr-unknown'].sort());
  });

  test('scenario 1 (bounded drain): at most the cap is processed, bounded external calls', async () => {
    // 200 code-actionable messages that each carry an issue ref, far above cap.
    const seed: OperatorInboxMessage[] = [];
    for (let i = 0; i < 200; i += 1) {
      seed.push(
        makeMessage({
          id: `rr-${i}`,
          created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
          body: JSON.stringify({
            kind: 'overseer_run_report',
            blocker: 'judge_daily_budget_exceeded again',
            issueRef: 'thinmansoftware/bdc-harness#42',
          }),
        })
      );
    }
    const world = makeWorld(seed);
    const cap = 25;
    const result = await drainOperatorInbox(makeDeps(world, { batchCap: cap }));

    // At most `cap` processed this pass...
    expect(result.processed).toBe(cap);
    expect(result.found).toBe(cap);
    // ...and external (GitHub comment) calls are bounded by the cap.
    expect(result.externalCalls).toBeLessThanOrEqual(cap);
    expect(world.commentCalls.length).toBeLessThanOrEqual(cap);
    // The whole backlog is NOT read every pass -- only `cap` rows were touched.
    expect(world.ackCalls.length).toBe(cap);
  });

  test('scenario 2 (watermark): a processed, unchanged row is not re-processed and makes no external call on the repeat pass', async () => {
    const world = makeWorld([
      makeMessage({
        id: 'code-1',
        body: JSON.stringify({
          kind: 'overseer_run_report',
          blocker: 'judge_daily_budget_exceeded',
          issueRef: 'thinmansoftware/bdc-harness#7',
        }),
      }),
    ]);
    const deps = makeDeps(world, {
      // Retention effectively off so the ONLY mechanism that can stop
      // reprocessing is the watermark (reproduces the incident: rows that never
      // get addressed but must not be re-read every pass).
      retentionMs: 10 * 365 * 24 * 60 * 60 * 1000,
      // Force ack to fail so address never happens.
      acknowledgeMessage: async data => {
        world.ackCalls.push(data.id);
        return { ok: false as const, reason: 'actor_mismatch' as const };
      },
    });

    const first = await drainOperatorInbox(deps);
    expect(first.found).toBe(1);
    expect(first.failed).toBe(1); // ack failed
    expect(world.commentCalls).toEqual(['thinmansoftware/bdc-harness#7']); // one external call
    expect(world.watermarkCalls).toEqual(['code-1']); // watermarked despite ack failure

    const second = await drainOperatorInbox(deps);
    expect(second.found).toBe(0); // watermark excluded it from the bounded read
    expect(second.processed).toBe(0);
    expect(world.commentCalls).toEqual(['thinmansoftware/bdc-harness#7']); // NO new external call
  });

  test('scenario 3 (retirement): a stale unaddressed row is retired -- preserved, terminal, non-draining, not cancelled', async () => {
    const stale = makeMessage({
      id: 'stale-1',
      created_at: '2026-06-01T00:00:00.000Z',
      // Give it a body that will FAIL ack, so it is never addressed and only
      // retirement can take it out of the drain.
      body: JSON.stringify({ kind: 'overseer_run_report', blocker: 'novel unknown' }),
    });
    const world = makeWorld([stale]);
    const deps = makeDeps(world, {
      retentionMs: 24 * 60 * 60 * 1000,
      acknowledgeMessage: async () => ({ ok: false as const, reason: 'actor_mismatch' as const }),
    });

    const result = await drainOperatorInbox(deps);
    expect(result.retired).toBe(1);

    const row = world.rows.find(r => r.message.id === 'stale-1')!;
    expect(row.retiredAt).not.toBeNull(); // terminal marker set
    expect(row.message.status).toBe('queued'); // NOT reused as cancelled
    expect(row.message.status).not.toBe('cancelled');
    // Row still exists (never deleted) and no longer appears in drain reads.
    expect(row.message.body).toContain('novel unknown');
    expect(await deps.listUnwatermarked!(100)).toHaveLength(0);
  });

  test('scenario 5 (alarm dedupe): exactly one alarm per episode across many passes', async () => {
    const seed: OperatorInboxMessage[] = [];
    for (let i = 0; i < 5; i += 1) {
      seed.push(
        makeMessage({
          id: `nag-${i}`,
          sender: i < 3 ? 'overseer' : 'taskmaster',
          created_at: new Date(Date.UTC(2026, 6, 15, 0, 0, i)).toISOString(),
          body: JSON.stringify({ kind: 'overseer_run_report', blocker: 'novel unknown blocker' }),
        })
      );
    }
    const world = makeWorld(seed);
    // Keep rows queued+unaddressed across passes: ack always fails, so the
    // backlog stays above threshold every pass.
    const deps = makeDeps(world, {
      alarmThreshold: 3,
      retentionMs: 10 * 365 * 24 * 60 * 60 * 1000, // effectively never retire
      acknowledgeMessage: async () => ({ ok: false as const, reason: 'actor_mismatch' as const }),
    });

    await drainOperatorInbox(deps);
    await drainOperatorInbox(deps);
    await drainOperatorInbox(deps);

    // Backlog (5) is >= threshold (3) on every pass, but the alarm fires ONCE.
    expect(world.alarms).toHaveLength(1);
    expect(world.alarms[0]!.count).toBe(5);
    expect(world.alarms[0]!.threshold).toBe(3);
    expect(world.alarms[0]!.topSender).toBe('overseer');
    expect(world.alarms[0]!.topSenderCount).toBe(3);
  });

  test('alarm re-arms after the backlog drops back under the threshold', async () => {
    const world = makeWorld();
    // Script the backlog count so the episode latch is exercised directly:
    // high -> high -> low -> high. The alarm must fire on the FIRST high, stay
    // silent on the repeat high, re-arm on the low, and fire again on the next
    // high -> two alarms total across four passes.
    const counts = [5, 5, 0, 5];
    let pass = 0;
    const deps = makeDeps(world, {
      alarmThreshold: 3,
      getBacklogStatus: async () => ({
        count: counts[pass++] ?? 0,
        oldestCreatedAt: T0,
        topSenders: [{ sender: 'overseer', count: 5 }],
      }),
    });

    await drainOperatorInbox(deps); // 5 -> fire
    await drainOperatorInbox(deps); // 5 -> silent (same episode)
    await drainOperatorInbox(deps); // 0 -> re-arm
    await drainOperatorInbox(deps); // 5 -> fire again

    expect(world.alarms).toHaveLength(2);
  });

  test('unrecognized blocker surfaces with full original text intact', async () => {
    const originalBlocker = 'completely novel failure mode never seen before XYZ-999';
    const body = JSON.stringify({
      kind: 'overseer_run_report',
      blocker: originalBlocker,
      woId: 'WO-UNKNOWN-NOVEL-01',
    });
    const world = makeWorld([makeMessage({ id: 'unk-1', body })]);
    await drainOperatorInbox(makeDeps(world));

    expect(world.surfaces.length).toBe(1);
    const entry = world.surfaces[0]!;
    expect(entry.classification).toBe('needs_human');
    expect(entry.originalBody).toBe(body);
  });

  test('digest-only message is acknowledged without human-surface escalation', async () => {
    const world = makeWorld([
      makeMessage({
        id: 'digest-only',
        task_type: 'agent_message',
        sender: 'taskmaster',
        body: 'Taskmaster daily digest for 2026-08-07: no actions in the last 24h.',
      }),
    ]);
    await drainOperatorInbox(makeDeps(world));

    expect(world.ackCalls).toEqual(['digest-only']);
    expect(world.addressCalls).toEqual(['digest-only']);
    expect(world.surfaces).toHaveLength(0);
  });

  test('consumer failure is loud: mid-drain throw is reported, not swallowed, and the row is still watermarked', async () => {
    const world = makeWorld([makeMessage({ id: 'boom-1' }), makeMessage({ id: 'ok-2' })]);
    const base = makeDeps(world);
    const deps = makeDeps(world, {
      acknowledgeMessage: async data => {
        if (data.id === 'boom-1') throw new Error('simulated_mid_drain_failure');
        return base.acknowledgeMessage!(data);
      },
    });

    const result = await drainOperatorInbox(deps);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.includes('simulated_mid_drain_failure'))).toBe(true);
    expect(world.addressCalls).toContain('ok-2');
    // Even the throwing row is watermarked so it cannot loop forever.
    expect(world.watermarkCalls.sort()).toEqual(['boom-1', 'ok-2'].sort());
  });

  test('classifier: known budget/PR patterns are code_actionable; novel is needs_human; digest is digest_only', () => {
    expect(
      classifyOperatorMessage(
        makeMessage({ body: JSON.stringify({ blocker: 'judge_daily_budget_exceeded' }) })
      ).kind
    ).toBe('code_actionable');
    expect(
      classifyOperatorMessage(makeMessage({ body: JSON.stringify({ blocker: 'unknown zebra' }) }))
        .kind
    ).toBe('needs_human');
    expect(
      classifyOperatorMessage(
        makeMessage({
          task_type: 'agent_message',
          sender: 'taskmaster',
          body: 'Taskmaster daily digest for 2026-08-07: no actions in the last 24h.',
        })
      ).kind
    ).toBe('digest_only');
  });

  test('resolveOperatorInboxIntervalMs: default 60000, 0 disables, invalid falls back', () => {
    expect(resolveOperatorInboxIntervalMs(undefined)).toBe(60_000);
    expect(resolveOperatorInboxIntervalMs('0')).toBe(0);
    expect(resolveOperatorInboxIntervalMs('15000')).toBe(15_000);
    expect(resolveOperatorInboxIntervalMs('nope')).toBe(60_000);
  });

  test('backpressure env knobs: parse positive ints, fall back on 0/invalid', () => {
    expect(resolveOperatorInboxBatchCapacity(undefined)).toBe(DEFAULT_OPERATOR_INBOX_BATCH_CAP);
    expect(resolveOperatorInboxBatchCapacity('0')).toBe(DEFAULT_OPERATOR_INBOX_BATCH_CAP);
    expect(resolveOperatorInboxBatchCapacity('nope')).toBe(DEFAULT_OPERATOR_INBOX_BATCH_CAP);
    expect(resolveOperatorInboxBatchCapacity('25')).toBe(25);

    expect(resolveOperatorInboxRetentionMs(undefined)).toBe(DEFAULT_OPERATOR_INBOX_RETENTION_MS);
    expect(resolveOperatorInboxRetentionMs('86400000')).toBe(86_400_000);

    expect(resolveOperatorInboxAlarmThreshold(undefined)).toBe(
      DEFAULT_OPERATOR_INBOX_ALARM_THRESHOLD
    );
    expect(resolveOperatorInboxAlarmThreshold('500')).toBe(500);
  });

  test('startOperatorInboxConsumer is a singleton and respects interval=0', () => {
    process.env.OPERATOR_INBOX_INTERVAL_MS = '0';
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    expect(getOperatorInboxRuntime()).toBeUndefined();
    delete process.env.OPERATOR_INBOX_INTERVAL_MS;

    process.env.OPERATOR_INBOX_INTERVAL_MS = '60000';
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    const first = getOperatorInboxRuntime();
    startOperatorInboxConsumer(makeDeps(makeWorld()));
    expect(getOperatorInboxRuntime()).toBe(first);
    stopOperatorInboxConsumer();
    delete process.env.OPERATOR_INBOX_INTERVAL_MS;
  });
});
