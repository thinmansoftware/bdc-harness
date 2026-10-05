import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchWorker } from '@archon/core/db/dispatch';
import type { TmActionOutcome } from '@archon/core/db/taskmaster';
import {
  runWorkerHeartbeatAlarm,
  startWorkerHeartbeatAlarmTimer,
  stopWorkerHeartbeatAlarmTimer,
  type WorkerHeartbeatAlarmDeps,
  type WorkerHeartbeatAlarmJournal,
} from './worker-heartbeat-alarm';

const MINUTE = 60_000;

function worker(
  workerId: string,
  lastHeartbeatMs: number,
  capabilities: Record<string, unknown> = {}
): DispatchWorker {
  return {
    worker_id: workerId,
    host: 'test-host',
    capabilities,
    max_concurrency: 1,
    status: 'available',
    registered_at: new Date(0).toISOString(),
    last_heartbeat_at: new Date(lastHeartbeatMs).toISOString(),
  };
}

interface JournalRow {
  id: string;
  thread_ref: string;
  action_type: string;
  proposal_json: string;
  idempotency_key: string;
  outcome: TmActionOutcome;
}

/** In-memory journal mirroring recordAction (row-first, idempotent) + updateActionOutcome. */
function makeJournal(
  seed: Array<{ idempotency_key: string; outcome: TmActionOutcome }> = []
): WorkerHeartbeatAlarmJournal & { rows: Map<string, JournalRow> } {
  const rows = new Map<string, JournalRow>();
  let counter = 0;
  for (const s of seed) {
    counter += 1;
    rows.set(s.idempotency_key, {
      id: `seed-${counter}`,
      thread_ref: '',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: s.idempotency_key,
      outcome: s.outcome,
    });
  }
  return {
    rows,
    recordAction: mock(
      async (data: {
        thread_ref: string;
        action_type: string;
        proposal_json: string;
        idempotency_key: string;
        outcome: TmActionOutcome;
      }) => {
        const existing = rows.get(data.idempotency_key);
        if (existing) return { id: existing.id, outcome: existing.outcome };
        counter += 1;
        const id = `row-${counter}`;
        rows.set(data.idempotency_key, {
          id,
          thread_ref: data.thread_ref,
          action_type: data.action_type,
          proposal_json: data.proposal_json,
          idempotency_key: data.idempotency_key,
          outcome: data.outcome,
        });
        return { id, outcome: data.outcome };
      }
    ) as WorkerHeartbeatAlarmJournal['recordAction'],
    updateActionOutcome: mock(async (id: string, outcome: TmActionOutcome) => {
      for (const r of rows.values()) if (r.id === id) r.outcome = outcome;
      return null;
    }),
  };
}

function getWorkerStub(workers: Record<string, DispatchWorker | null>) {
  return mock(async (workerId: string) =>
    Object.prototype.hasOwnProperty.call(workers, workerId) ? workers[workerId] : null
  );
}

afterEach(() => {
  stopWorkerHeartbeatAlarmTimer();
  delete process.env.DISPATCH_WORKER_ALARM_ENABLED;
  delete process.env.DISPATCH_WORKER_ALARM_WORKERS;
  delete process.env.DISPATCH_WORKER_ALARM_STALE_MINUTES;
  delete process.env.DISPATCH_WORKER_ALARM_PAGE_STALE_MINUTES;
  delete process.env.DISPATCH_WORKER_ALARM_REPEAT_HOURS;
  delete process.env.DISPATCH_WORKER_ALARM_INTERVAL_MS;
  delete process.env.DISPATCH_WORKER_ALARM_ISSUE;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe('worker heartbeat page path', () => {
  test('Test 1: stale_worker_pages_john_once_and_journals_sent', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const lastHb = nowMs - 6 * MINUTE;
    const pages: string[] = [];
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({ A: worker('A', lastHb) }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);
    await runWorkerHeartbeatAlarm(deps);

    expect(pages.length).toBe(1);
    expect(pages[0]).toContain('A');
    expect(pages[0]).toContain(new Date(lastHb).toISOString());
    const rows = [...journal.rows.values()];
    expect(rows.length).toBe(1);
    expect(rows[0].action_type).toBe('escalate_p0');
    expect(rows[0].thread_ref).toBe('dispatch-worker:A');
    expect(rows[0].outcome).toBe('sent');
  });

  test('Test 2: fresh_worker_never_pages', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const pages: string[] = [];
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({ A: worker('A', nowMs - 2 * MINUTE) }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);

    expect(pages.length).toBe(0);
    expect(journal.rows.size).toBe(0);
  });

  test('Test 3: page_threshold_is_five_minutes_independent_of_the_comment_threshold', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const lastHb = nowMs - 6 * MINUTE; // > 5m page, < 10m comment
    const pages: string[] = [];
    const journal = makeJournal();
    const postAlarmComment = mock(async () => {});
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({ A: worker('A', lastHb) }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      // Comment deps wired so the 10-minute threshold is genuinely exercised.
      postAlarmComment,
      listIssueComments: mock(async () => []),
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);

    expect(pages.length).toBe(1);
    // The comment path evaluated the worker as healthy (6m < 10m) -> no DOWN comment.
    expect(postAlarmComment).not.toHaveBeenCalled();
  });

  test('Test 4: failed_page_is_journaled_failed_then_retried_without_duplicate_sent', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const lastHb = nowMs - 6 * MINUTE;
    let calls = 0;
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({ A: worker('A', lastHb) }),
      pageOperator: mock(async () => {
        calls += 1;
        if (calls === 1) throw new Error('telegram_down');
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);
    const afterRun1 = [...journal.rows.values()];
    expect(afterRun1.length).toBe(1);
    expect(afterRun1[0].outcome).toBe('failed');

    await runWorkerHeartbeatAlarm(deps);
    const afterRun2 = [...journal.rows.values()];
    expect(afterRun2.length).toBe(1);
    expect(afterRun2[0].outcome).toBe('sent');
    expect(calls).toBe(2);
  });

  test('Test 5: page_fires_even_without_a_github_token', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const pages: string[] = [];
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({ A: worker('A', nowMs - 6 * MINUTE) }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);

    expect(pages.length).toBe(1);
    expect([...journal.rows.values()][0].outcome).toBe('sent');
  });

  test('Test 6: alarm_timer_runs_on_its_own_short_interval', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const intervals: number[] = [];
    let unrefCalls = 0;
    let clearCalls = 0;
    const setIntervalFn = (_fn: () => void, ms: number): unknown => {
      intervals.push(ms);
      return { unref: () => (unrefCalls += 1) };
    };
    const clearIntervalFn = (): void => {
      clearCalls += 1;
    };
    const timerDeps: WorkerHeartbeatAlarmDeps = { getWorker: async () => null };
    const start = (): void =>
      startWorkerHeartbeatAlarmTimer({ setIntervalFn, clearIntervalFn, deps: timerDeps });

    try {
      process.env.NODE_ENV = 'production';

      // Default -> 60000, handle unref-ed.
      start();
      expect(intervals).toEqual([60_000]);
      expect(unrefCalls).toBe(1);

      // Second start with a live timer is a no-op.
      start();
      expect(intervals).toEqual([60_000]);

      // Stop clears it.
      stopWorkerHeartbeatAlarmTimer();
      expect(clearCalls).toBe(1);

      // Too-small value is clamped to 5000.
      process.env.DISPATCH_WORKER_ALARM_INTERVAL_MS = '1000';
      start();
      expect(intervals).toEqual([60_000, 5_000]);
      stopWorkerHeartbeatAlarmTimer();

      // Override honored.
      process.env.DISPATCH_WORKER_ALARM_INTERVAL_MS = '120000';
      start();
      expect(intervals).toEqual([60_000, 5_000, 120_000]);
      stopWorkerHeartbeatAlarmTimer();

      // Under NODE_ENV=test nothing starts.
      process.env.NODE_ENV = 'test';
      start();
      expect(intervals).toEqual([60_000, 5_000, 120_000]);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      stopWorkerHeartbeatAlarmTimer();
    }
  });

  test('Test 14: fresh_heartbeat_with_multiple_deaths_pages_and_journals_each_once', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T21:10:05.000Z');
    const evidence = [
      { previous_pid: 4242, previous_started_at: '2026-09-28T21:00:00.000Z' },
      { previous_pid: 4343, previous_started_at: '2026-09-28T21:05:00.000Z' },
    ];
    const pages: string[] = [];
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({
        A: worker('A', nowMs - 5_000, { restart_evidence: evidence }),
      }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await runWorkerHeartbeatAlarm(deps);
    await runWorkerHeartbeatAlarm(deps);

    expect(pages.length).toBe(2);
    expect(pages.filter(p => p.includes('4242')).length).toBe(1);
    expect(pages.filter(p => p.includes('4343')).length).toBe(1);
    const key1 = 'dispatch-worker-death:A:4242:2026-09-28T21:00:00.000Z';
    const key2 = 'dispatch-worker-death:A:4343:2026-09-28T21:05:00.000Z';
    expect(journal.rows.get(key1)?.outcome).toBe('sent');
    expect(journal.rows.get(key2)?.outcome).toBe('sent');
    expect(journal.rows.get(key1)?.thread_ref).toBe('dispatch-worker:A');
    expect(journal.rows.size).toBe(2);
  });

  test('Test 15: alarm_restart_mid_drain_is_idempotent', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T21:15:05.000Z');
    const evidence = [
      { previous_pid: 4242, previous_started_at: '2026-09-28T21:00:00.000Z' },
      { previous_pid: 4343, previous_started_at: '2026-09-28T21:05:00.000Z' },
      { previous_pid: 4444, previous_started_at: '2026-09-28T21:10:00.000Z' },
    ];
    const key3 = 'dispatch-worker-death:A:4444:2026-09-28T21:10:00.000Z';
    // Pre-existing row for the third entry stuck at pending (crash after row-first).
    const journal = makeJournal([{ idempotency_key: key3, outcome: 'pending' }]);
    const pages: string[] = [];
    let thrown4343 = false;
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({
        A: worker('A', nowMs - 5_000, { restart_evidence: evidence }),
      }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
        if (text.includes('4343') && !thrown4343) {
          thrown4343 = true;
          throw new Error('telegram_down');
        }
      }),
      journal,
      now: () => new Date(nowMs),
    };

    // Run 1, then a fresh invocation with no carried in-memory state.
    await runWorkerHeartbeatAlarm(deps);
    const key1 = 'dispatch-worker-death:A:4242:2026-09-28T21:00:00.000Z';
    const key2 = 'dispatch-worker-death:A:4343:2026-09-28T21:05:00.000Z';
    expect(journal.rows.get(key1)?.outcome).toBe('sent');
    expect(journal.rows.get(key2)?.outcome).toBe('failed');

    await runWorkerHeartbeatAlarm(deps);
    expect(journal.rows.get(key1)?.outcome).toBe('sent');
    expect(journal.rows.get(key2)?.outcome).toBe('sent');
    expect(journal.rows.get(key3)?.outcome).toBe('sent');

    // Exactly one row per key; total pages = one per entry (3) + the failed retry (1).
    expect(journal.rows.size).toBe(3);
    expect(pages.length).toBe(4);
    expect(pages.filter(p => p.includes('4242')).length).toBe(1);
    expect(pages.filter(p => p.includes('4343')).length).toBe(2);
    expect(pages.filter(p => p.includes('4444')).length).toBe(1);
  });

  test('Test 16: malformed_evidence_and_clock_skew_do_not_change_paging', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'W_str,W_obj,W_bad,W_valid';
    const nowMs = Date.parse('2026-09-28T22:00:00.000Z');
    const pages: string[] = [];
    const journal = makeJournal();
    const deps: WorkerHeartbeatAlarmDeps = {
      getWorker: getWorkerStub({
        W_str: worker('W_str', nowMs - 5_000, { restart_evidence: 'nope' }),
        W_obj: worker('W_obj', nowMs - 5_000, { restart_evidence: {} }),
        W_bad: worker('W_bad', nowMs - 5_000, {
          restart_evidence: [
            { previous_started_at: '2026-09-28T21:00:00.000Z' }, // missing previous_pid
            { previous_pid: 5, previous_started_at: 123 }, // non-string previous_started_at
          ],
        }),
        W_valid: worker('W_valid', nowMs - 5_000, {
          restart_evidence: [
            {
              previous_pid: 7,
              previous_started_at: '2026-09-28T21:00:00.000Z',
              reclaimed_at: '2099-01-01T00:00:00.000Z', // clock far ahead
            },
            {
              previous_pid: 8,
              previous_started_at: '2026-09-28T21:05:00.000Z',
              reclaimed_at: '2001-01-01T00:00:00.000Z', // clock far behind
            },
          ],
        }),
      }),
      pageOperator: mock(async (text: string) => {
        pages.push(text);
      }),
      journal,
      now: () => new Date(nowMs),
    };

    await expect(runWorkerHeartbeatAlarm(deps)).resolves.toBeUndefined();

    // Only the two valid W_valid entries page; malformed shapes produce nothing.
    expect(pages.length).toBe(2);
    expect(journal.rows.size).toBe(2);
    // Keys built only from previous_pid + previous_started_at (never reclaimed_at / server clock).
    expect(journal.rows.has('dispatch-worker-death:W_valid:7:2026-09-28T21:00:00.000Z')).toBe(true);
    expect(journal.rows.has('dispatch-worker-death:W_valid:8:2026-09-28T21:05:00.000Z')).toBe(true);
  });
});
