import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { createRealWorkerHeartbeatAlarmDeps, pageOnce } from '../dispatch/worker-heartbeat-alarm';
import {
  decideEscalateP0,
  DEFAULT_ESCALATE_P0_COOLDOWN_MS,
  ESCALATE_P0_COOLDOWN_ENV,
  escalationReason,
  planEscalateDelivery,
} from './escalation-dedupe';
import { createTaskmasterState, tick, type ListedThread, type TaskmasterDeps } from './loop';

const THREAD = 'dispatch-worker:A';

describe('escalate_p0 cooldown dedupe', () => {
  test('Test 1: a duplicate inside the cooldown is suppressed with the cooldown marker', () => {
    const nowMs = Date.parse('2026-11-05T12:00:00.000Z');
    const first = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs,
      priorSentAtMs: null,
    });
    expect(first).toEqual({ send: true, suppressed: null });

    const duplicate = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: nowMs + 60_000,
      priorSentAtMs: nowMs,
      cooldownMs: 60 * 60 * 1000,
    });
    expect(duplicate).toEqual({ send: false, suppressed: 'cooldown' });
  });

  test('Test 2: a prior send exactly one default cooldown old still sends', () => {
    const priorSentAtMs = Date.parse('2026-11-04T12:00:00.000Z');
    expect(DEFAULT_ESCALATE_P0_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);

    const atBoundary = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: priorSentAtMs + DEFAULT_ESCALATE_P0_COOLDOWN_MS,
      priorSentAtMs,
    });
    expect(atBoundary).toEqual({ send: true, suppressed: null });

    const stillInside = decideEscalateP0({
      threadRef: THREAD,
      reason: 'worker_down',
      nowMs: priorSentAtMs + DEFAULT_ESCALATE_P0_COOLDOWN_MS - 1,
      priorSentAtMs,
    });
    expect(stillInside).toEqual({ send: false, suppressed: 'cooldown' });
  });

  test('Test 3: a quiet day stays under 10 sends and the injected probe still sends', async () => {
    const previousCooldown = process.env[ESCALATE_P0_COOLDOWN_ENV];
    const previousHome = process.env.ARCHON_HOME;
    const previousUrl = process.env.DATABASE_URL;
    const previousToIssue = process.env.TASKMASTER_ESCALATE_TO_ISSUE;
    const previousFire = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    const previousBlocker = process.env.TASKMASTER_BLOCKER_REPORT;
    const home = mkdtempSync(join(tmpdir(), 'tm-p0-dedupe-'));
    const hourMs = 60 * 60 * 1000;
    // Longer than the 24h idempotency bucket so the second Taskmaster key is
    // still inside the cooldown. A caller stuck on the 24h default would send it.
    const cooldownMs = 48 * hourMs;
    process.env[ESCALATE_P0_COOLDOWN_ENV] = String(cooldownMs);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    process.env.TASKMASTER_ESCALATE_TO_ISSUE = 'false';
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'false';
    process.env.TASKMASTER_BLOCKER_REPORT = 'false';
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    try {
      await closeDatabase();
      resetDatabase();
      await getDatabase().query('SELECT 1');
      const journal = createRealWorkerHeartbeatAlarmDeps().journal;
      if (!journal?.commitCooldownDecision) throw new Error('cooldown claim missing');

      const startMs = Date.parse('2026-11-05T00:00:00.000Z');
      const stepMs = 30 * 60 * 1000;
      const pages: string[] = [];
      const page = async (
        idempotencyKey: string,
        proposal: unknown,
        nowMs: number
      ): Promise<void> => {
        await pageOnce(
          {
            pageOperator: async (text: string) => {
              pages.push(text);
            },
            journal,
          },
          {
            idempotencyKey,
            threadRef: THREAD,
            text: `page ${idempotencyKey}`,
            proposal,
          },
          nowMs
        );
      };
      for (let i = 0; i < 48; i += 1) {
        await page(
          `quiet:${String(i)}`,
          { kind: 'worker_down', worker_id: 'A', tick: i },
          startMs + i * stepMs
        );
      }
      await page(
        'quiet:probe',
        { kind: 'worker_down', token: 'P0-INJECTED-PROBE' },
        startMs + 24 * stepMs
      );

      // Two claims with different keys must not both become sendable.
      const claimNow = startMs + 24 * stepMs;
      const [firstClaim, secondClaim] = await Promise.all([
        journal.commitCooldownDecision({
          threadRef: 'dispatch-worker:race',
          reason: 'worker_down',
          idempotencyKey: 'race-a',
          proposal: { kind: 'worker_down', worker_id: 'race' },
          nowMs: claimNow,
          cooldownMs,
        }),
        journal.commitCooldownDecision({
          threadRef: 'dispatch-worker:race',
          reason: 'worker_down',
          idempotencyKey: 'race-b',
          proposal: { kind: 'worker_down', worker_id: 'race' },
          nowMs: claimNow,
          cooldownMs,
        }),
      ]);
      const claimSends = [firstClaim, secondClaim].filter(claim => claim.disposition === 'send');
      expect(claimSends).toHaveLength(1);

      // A suppression must not expire a pending row another delivery still owns.
      const pending = await journal.recordAction({
        thread_ref: THREAD,
        action_type: 'escalate_p0',
        proposal_json: JSON.stringify({ kind: 'worker_down', worker_id: 'A' }),
        idempotency_key: 'quiet:inflight',
        outcome: 'pending',
      });
      const suppressedClaim = await journal.commitCooldownDecision({
        threadRef: THREAD,
        reason: 'worker_down',
        idempotencyKey: 'quiet:inflight',
        proposal: { kind: 'worker_down', worker_id: 'A' },
        nowMs: startMs + 24 * stepMs,
        cooldownMs,
      });
      expect(suppressedClaim.disposition).toBe('suppressed');
      const pendingRow = await getDatabase().query<{ outcome: string }>(
        'SELECT outcome FROM tm_journal WHERE id = $1',
        [pending.id]
      );
      expect(pendingRow.rows[0]?.outcome).toBe('pending');

      const wall = Date.now();
      const clock = { nowMs: wall };
      const threadRef = 'dispatch:3f0c8d2a-1b4e-4c7d-9a10-5e2f6b7c8d9e';
      const deps = (title: string): TaskmasterDeps => ({
        now: () => new Date(clock.nowMs),
        headroom: async () => ({
          state: 'OK',
          tokensRemaining: 500_000,
          isUnknown: false,
          source: 'local_artifacts',
          observedAt: new Date(clock.nowMs).toISOString(),
        }),
        listThreads: async (): Promise<ListedThread[]> => [
          {
            ref: threadRef,
            priority: 'P0',
            lastActivityAt: new Date(wall - 2 * hourMs).toISOString(),
            isUnclaimedP0: true,
            recipient: 'xo',
            title,
            ownerLogin: null,
            labels: ['wo', 'prio:P0'],
          },
        ],
        listUndeliveredRulings: async () => [],
        getGithubIssueEvidence: async () => null,
        getDispatchReceiptCutoverAt: async () => new Date(wall - 86_400_000).toISOString(),
        checkExpectations: async () => {},
        refreshLaneHealth: async () => {},
        reconcileWoClaims: async () => [],
        pageOperator: async () => {},
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps('Unclaimed P0 item'));
      clock.nowMs = wall + 25 * hourMs;
      await tick(state, deps('Unclaimed P0 item'));

      const rows = await getDatabase().query<{
        thread_ref: string;
        outcome: string;
        proposal_json: string;
        idempotency_key: string | null;
      }>(
        `SELECT thread_ref, outcome, proposal_json, idempotency_key
         FROM tm_journal WHERE action_type = 'escalate_p0' ORDER BY created_at, id`
      );
      const sent = rows.rows.filter(row => row.outcome === 'sent');
      expect(sent.length).toBeLessThan(10);
      const workerSent = sent.filter(row => {
        const proposal = JSON.parse(row.proposal_json) as { kind?: string; token?: string };
        return row.thread_ref === THREAD && proposal.kind === 'worker_down' && !proposal.token;
      });
      expect(workerSent).toHaveLength(1);
      const workerSuppressed = rows.rows.filter(row => {
        if (row.thread_ref !== THREAD || row.outcome !== 'expired') return false;
        const proposal = JSON.parse(row.proposal_json) as { suppressed?: string; token?: string };
        return proposal.suppressed === 'cooldown' && !proposal.token;
      });
      expect(workerSuppressed.length).toBeGreaterThanOrEqual(47);
      const probe = sent.filter(row => row.proposal_json.includes('P0-INJECTED-PROBE'));
      expect(probe.length).toBeGreaterThanOrEqual(1);

      const taskmaster = rows.rows.filter(row => row.thread_ref === threadRef);
      const taskmasterSent = taskmaster.filter(row => row.outcome === 'sent');
      const taskmasterSuppressed = taskmaster.filter(row => {
        if (row.outcome !== 'expired') return false;
        const proposal = JSON.parse(row.proposal_json) as { suppressed?: string };
        return proposal.suppressed === 'cooldown';
      });
      expect(taskmasterSent).toHaveLength(1);
      expect(taskmasterSuppressed.length).toBeGreaterThanOrEqual(1);
      expect(pages.filter(text => text.startsWith('page quiet:'))).toHaveLength(2);
    } finally {
      await closeDatabase();
      resetDatabase();
      restore(ESCALATE_P0_COOLDOWN_ENV, previousCooldown);
      restore('ARCHON_HOME', previousHome);
      restore('DATABASE_URL', previousUrl);
      restore('TASKMASTER_ESCALATE_TO_ISSUE', previousToIssue);
      restore('TASKMASTER_FIRE_VERB_ENABLED', previousFire);
      restore('TASKMASTER_BLOCKER_REPORT', previousBlocker);
      removeTempDirWithRetry(home);
    }
  });

  test('Test 4: a distinct worker_death sends inside a worker_down cooldown', () => {
    const nowMs = Date.parse('2026-11-05T12:00:00.000Z');
    const downReason = escalationReason({ kind: 'worker_down', worker_id: 'A' }, THREAD);
    expect(downReason).toBe('worker_down');
    const down = decideEscalateP0({
      threadRef: THREAD,
      reason: downReason,
      nowMs,
      priorSentAtMs: nowMs - 60_000,
    });
    expect(down).toEqual({ send: false, suppressed: 'cooldown' });

    const deathA = escalationReason(
      {
        kind: 'worker_death',
        previous_pid: 4242,
        previous_started_at: '2026-11-05T11:00:00.000Z',
      },
      THREAD
    );
    const deathB = escalationReason(
      {
        kind: 'worker_death',
        previous_pid: 4343,
        previous_started_at: '2026-11-05T11:00:00.000Z',
      },
      THREAD
    );
    expect(deathA).toBe('worker_death:4242:2026-11-05T11:00:00.000Z');
    expect(deathB).toBe('worker_death:4343:2026-11-05T11:00:00.000Z');
    expect(deathA).not.toBe(deathB);

    const deathSend = decideEscalateP0({
      threadRef: THREAD,
      reason: deathA,
      nowMs,
      priorSentAtMs: null,
    });
    expect(deathSend).toEqual({ send: true, suppressed: null });

    expect(escalationReason({ kind: 'worker_down', note: 'P0-INJECTED-PROBE' }, THREAD)).toBe(
      'P0-INJECTED-PROBE'
    );

    const circular: { self?: unknown; kind?: string } = { kind: 'worker_down' };
    circular.self = circular;
    expect(escalationReason(circular, THREAD)).toBe('worker_down');

    const bare: { self?: unknown } = {};
    bare.self = bare;
    expect(escalationReason(bare, 'remediation:item-1')).toBe('unroutable_remediation');
    expect(escalationReason(undefined, 'plain-thread')).toBe('unclaimed_p0');

    const aliasNow = Date.parse('2026-11-05T12:00:00.000Z');
    expect(
      planEscalateDelivery({
        rows: [
          {
            thread_ref: 'gh:bluedevilcollectibles/bdc-xo#10',
            action_type: 'escalate_p0',
            proposal_json: JSON.stringify({ kind: 'worker_down' }),
            idempotency_key: 'alias-old',
            outcome: 'sent',
            created_at: new Date(aliasNow - 60_000).toISOString(),
          },
        ],
        threadRef: 'gh:thinmansoftware/bdc-xo#10',
        reason: 'worker_down',
        idempotencyKey: 'alias-new',
        nowMs: aliasNow,
        cooldownMs: 60 * 60 * 1000,
      })
    ).toBe('suppress');
    expect(
      planEscalateDelivery({
        rows: [
          {
            thread_ref: THREAD,
            action_type: 'escalate_p0',
            proposal_json: JSON.stringify({ kind: 'worker_down' }),
            idempotency_key: 'live',
            outcome: 'pending',
            created_at: new Date(aliasNow - 1000).toISOString(),
          },
        ],
        threadRef: THREAD,
        reason: 'worker_down',
        idempotencyKey: 'other',
        nowMs: aliasNow,
      })
    ).toBe('wait');
  });
});
