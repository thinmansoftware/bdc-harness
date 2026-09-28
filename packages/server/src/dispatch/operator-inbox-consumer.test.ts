/**
 * Operator inbox consumer tests -- WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / bdc-xo#1455.
 *
 * Section 11 scenarios:
 *   1. backlog drain (MUST FAIL on untouched tree -- no consumer exists)
 *   2. idempotent re-run
 *   3. unrecognized blocker surfaces with full original text
 *   4. digest-only acknowledgment (no human-surface escalation)
 *   5. consumer failure is loud (not swallowed)
 *
 * All deps injected; no mock.module; no real network / real DB.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  classifyOperatorMessage,
  drainOperatorInbox,
  resolveOperatorInboxIntervalMs,
  startOperatorInboxConsumer,
  stopOperatorInboxConsumer,
  getOperatorInboxRuntime,
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
    route_disposition: null,
    ...overrides,
  };
}

interface FakeWorld {
  messages: OperatorInboxMessage[];
  surfaces: SurfaceEntry[];
  disposeCalls: string[];
}

function makeWorld(seed: OperatorInboxMessage[] = []): FakeWorld {
  return {
    messages: seed.map(m => ({ ...m })),
    surfaces: [],
    disposeCalls: [],
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<OperatorInboxDeps> = {}): OperatorInboxDeps {
  return {
    listMessages: async filters => {
      return world.messages.filter(m => {
        if (filters.recipient && m.recipient !== filters.recipient) return false;
        if (filters.status === 'queued') {
          if (m.status !== 'queued') return false;
          if (m.addressed_at !== null) return false;
          if (m.route_disposition !== null) return false;
        }
        return true;
      });
    },
    disposeMessageByMachine: async data => {
      world.disposeCalls.push(data.id);
      const msg = world.messages.find(m => m.id === data.id);
      if (!msg) return { ok: false as const, reason: 'not_found' as const };
      if (msg.route_disposition !== null)
        return { ok: false as const, reason: 'already_disposed' as const };
      msg.route_disposition = data.disposition;
      return { ok: true as const, message: msg };
    },
    surface: async entry => {
      world.surfaces.push(entry);
    },
    ...overrides,
  };
}

describe('operator inbox consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01)', () => {
  afterEach(() => {
    stopOperatorInboxConsumer();
  });

  test('backlog drain: every seeded queued operator row receives an honest disposition', async () => {
    // Seed shape matches live 2026-08-07 evidence: many run_report + one digest.
    const seed: OperatorInboxMessage[] = [
      makeMessage({
        id: 'rr-1',
        body: JSON.stringify({
          kind: 'overseer_run_report',
          blocker:
            'Overseer judge health failure (evidence_unavailable) after 3 retries: judge_daily_budget_exceeded',
          woId: 'WO-HARNESS-JUDGE-BUDGET-01',
        }),
      }),
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
        body:
          'Taskmaster daily digest for 2026-08-07: no actions in the last 24h. ' +
          'Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
      }),
      makeMessage({
        id: 'rr-unknown',
        body: JSON.stringify({
          kind: 'overseer_run_report',
          blocker: 'completely novel failure mode never seen before XYZ-999',
          woId: 'WO-UNKNOWN-NOVEL-01',
        }),
      }),
    ];
    const world = makeWorld(seed);
    const result = await drainOperatorInbox(makeDeps(world));

    expect(result.found).toBe(4);
    expect(result.processed).toBe(4);
    expect(result.failed).toBe(0);

    const stillQueued = world.messages.filter(
      m => m.status === 'queued' && m.route_disposition === null
    );
    expect(stillQueued).toHaveLength(0);
    expect(world.disposeCalls.sort()).toEqual(['digest-1', 'rr-1', 'rr-2', 'rr-unknown'].sort());
  });

  test('idempotent re-run: already-addressed messages are not reprocessed', async () => {
    const addressed = makeMessage({
      id: 'done-1',
      acknowledged_at: T0,
      acknowledged_by: 'operator',
      addressed_at: T0,
      addressed_by: 'operator',
    });
    const pending = makeMessage({ id: 'pending-1' });
    const world = makeWorld([addressed, pending]);
    const deps = makeDeps(world);

    const first = await drainOperatorInbox(deps);
    expect(first.found).toBe(1);
    expect(first.processed).toBe(1);
    expect(world.disposeCalls).toEqual(['pending-1']);

    // A second tick must not surface or dispose the same row twice.
    const second = await drainOperatorInbox(deps);
    expect(second.found).toBe(0);
    expect(second.processed).toBe(0);
    expect(world.disposeCalls).toEqual(['pending-1']);
    expect(world.surfaces.filter(s => s.messageId === 'pending-1').length).toBeLessThanOrEqual(1);
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
    expect(entry.originalBody).toContain(originalBlocker);
    expect(entry.originalBody).toBe(body);
    expect(world.messages[0]!.route_disposition).toBe('auto_surfaced');
    expect(world.messages[0]!.acknowledged_at).toBeNull();
    expect(world.messages[0]!.addressed_at).toBeNull();
  });

  test('digest-only message is expired without human-surface escalation', async () => {
    const world = makeWorld([
      makeMessage({
        id: 'digest-only',
        task_type: 'agent_message',
        sender: 'taskmaster',
        body:
          'Taskmaster daily digest for 2026-08-07: no actions in the last 24h. ' +
          'Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
      }),
    ]);
    await drainOperatorInbox(makeDeps(world));

    expect(world.disposeCalls).toEqual(['digest-only']);
    expect(world.surfaces).toHaveLength(0);
    expect(world.messages[0]!.route_disposition).toBe('expired');
    expect(world.messages[0]!.acknowledged_at).toBeNull();
    expect(world.messages[0]!.addressed_at).toBeNull();
  });

  test('consumer failure is loud: mid-drain throw is reported, not swallowed', async () => {
    const world = makeWorld([makeMessage({ id: 'boom-1' }), makeMessage({ id: 'ok-2' })]);
    const deps = makeDeps(world, {
      disposeMessageByMachine: async data => {
        if (data.id === 'boom-1') throw new Error('simulated_mid_drain_failure');
        return makeDeps(world).disposeMessageByMachine!(data);
      },
    });

    const result = await drainOperatorInbox(deps);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.errors.some(e => e.includes('simulated_mid_drain_failure'))).toBe(true);
    // Other messages still process -- one failure must not permanently stop drain.
    expect(world.disposeCalls).toContain('ok-2');
  });

  test('rollback freeze makes legacy-style receipt processing fail without receipt writes', async () => {
    const world = makeWorld([makeMessage({ id: 'legacy-frozen' })]);
    const result = await drainOperatorInbox(
      makeDeps(world, {
        disposeMessageByMachine: async () => {
          throw new Error('dispatch_receipts_frozen');
        },
      })
    );
    expect(result.failed).toBe(world.messages.length);
    expect(world.messages[0]).toMatchObject({
      acknowledged_at: null,
      acknowledged_by: null,
      addressed_at: null,
      addressed_by: null,
    });
  });

  test('classifier: known budget/PR patterns are code_actionable; novel is needs_human; digest is digest_only', () => {
    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({
            blocker: 'judge_daily_budget_exceeded after retries',
            woId: 'WO-X',
          }),
        })
      ).kind
    ).toBe('code_actionable');

    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({
            blocker: 'PR lookup failed / pull request creation error',
            woId: 'WO-Y',
          }),
        })
      ).kind
    ).toBe('code_actionable');

    expect(
      classifyOperatorMessage(
        makeMessage({
          body: JSON.stringify({ blocker: 'totally unknown zebra failure' }),
        })
      ).kind
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
