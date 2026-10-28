import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { DispatchWorker } from '@archon/core/db/dispatch';
import { clearServiceGitHubTokenCache } from '@archon/core/github/service-identity';
import {
  evaluateWorkerHeartbeats,
  listWorkerAlarmIssueComments,
  runWorkerHeartbeatAlarm,
  type WorkerAlarmIssueComment,
  type WorkerHeartbeatAlarmDeps,
} from './worker-heartbeat-alarm';
import { tickDutyOfficerClock, type DutyOfficerClockDeps } from './duty-officer-clock';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function worker(workerId: string, lastHeartbeatMs: number): DispatchWorker {
  return {
    worker_id: workerId,
    host: 'test-host',
    capabilities: {},
    max_concurrency: 1,
    status: 'available',
    registered_at: new Date(0).toISOString(),
    last_heartbeat_at: new Date(lastHeartbeatMs).toISOString(),
  };
}

/**
 * Build an in-memory alarm-deps stub. The comment store is shared between
 * listIssueComments (reads) and postAlarmComment (appends) so dedup behaves the
 * way it would against a real issue.
 */
function alarmDeps(options: {
  workers: Record<string, DispatchWorker | null>;
  now: () => number;
  seedComments?: WorkerAlarmIssueComment[];
  postThrowsTimes?: number;
}): WorkerHeartbeatAlarmDeps & {
  comments: WorkerAlarmIssueComment[];
  workers: Record<string, DispatchWorker | null>;
} {
  const comments: WorkerAlarmIssueComment[] = [...(options.seedComments ?? [])];
  let remainingThrows = options.postThrowsTimes ?? 0;
  return {
    comments,
    workers: options.workers,
    getWorker: mock(async (workerId: string) =>
      Object.prototype.hasOwnProperty.call(options.workers, workerId)
        ? options.workers[workerId]
        : null
    ),
    listIssueComments: mock(async () => comments.map(entry => ({ ...entry }))),
    postAlarmComment: mock(async (_issue, body: string) => {
      if (remainingThrows > 0) {
        remainingThrows -= 1;
        throw new Error('github_post_failed');
      }
      comments.push({ body, created_at: new Date(options.now()).toISOString() });
    }),
    now: () => new Date(options.now()),
  };
}

function downCount(comments: WorkerAlarmIssueComment[], workerId: string): number {
  return comments.filter(c => c.body.includes(`dispatch-worker-alarm:${workerId}:down`)).length;
}

function upCount(comments: WorkerAlarmIssueComment[], workerId: string): number {
  return comments.filter(c => c.body.includes(`dispatch-worker-alarm:${workerId}:up`)).length;
}

afterEach(() => {
  delete process.env.DISPATCH_WORKER_ALARM_ENABLED;
  delete process.env.DISPATCH_WORKER_ALARM_WORKERS;
  delete process.env.DISPATCH_WORKER_ALARM_STALE_MINUTES;
  delete process.env.DISPATCH_WORKER_ALARM_REPEAT_HOURS;
  delete process.env.DISPATCH_WORKER_ALARM_ISSUE;
  delete process.env.DUTY_OFFICER_GH_NUDGE;
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe('runWorkerHeartbeatAlarm', () => {
  test('Test 1: stale_watched_worker_posts_one_down_alarm', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const lastHb = nowMs - 11 * MINUTE;

    // Pure evaluator: a stale row (age > staleMinutes) is classified stale,
    // ignoring the worker's own status column.
    expect(
      evaluateWorkerHeartbeats([{ workerId: 'A', row: worker('A', lastHb) }], nowMs, {
        staleMinutes: 10,
      })
    ).toEqual({ A: 'stale' });

    const deps = alarmDeps({ workers: { A: worker('A', lastHb) }, now: () => nowMs });

    await runWorkerHeartbeatAlarm(deps);
    await runWorkerHeartbeatAlarm(deps);

    expect(downCount(deps.comments, 'A')).toBe(1);
    const body = deps.comments[0].body;
    expect(body).toContain('dispatch-worker-alarm:A:down');
    expect(body).toContain('`A`');
    expect(body).toContain(new Date(lastHb).toISOString());
  });

  test('Test 2: healthy_and_unwatched_workers_never_alarm', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'B';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');

    // Pure evaluator: a fresh row is healthy; a missing row is stale.
    expect(
      evaluateWorkerHeartbeats(
        [
          { workerId: 'B', row: worker('B', nowMs - 2 * MINUTE) },
          { workerId: 'missing', row: null },
        ],
        nowMs,
        { staleMinutes: 10 }
      )
    ).toEqual({ B: 'healthy', missing: 'stale' });

    const deps = alarmDeps({
      workers: {
        B: worker('B', nowMs - 2 * MINUTE),
        // Silent since 2026-07-14 but NOT in the watched list -- must never alarm.
        'dispatch-worker-john-desktop': worker(
          'dispatch-worker-john-desktop',
          Date.parse('2026-07-14T00:00:00.000Z')
        ),
      },
      now: () => nowMs,
    });

    await runWorkerHeartbeatAlarm(deps);

    expect(deps.comments.length).toBe(0);
    expect(deps.postAlarmComment).not.toHaveBeenCalled();
  });

  test('Test 3: repeat_after_window_and_recovery_once', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    let nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const staleHb = nowMs - 30 * MINUTE;
    const deps = alarmDeps({
      workers: { A: worker('A', staleHb) },
      now: () => nowMs,
      seedComments: [
        {
          body: '<!-- dispatch-worker-alarm:A:down -->\nold alarm',
          created_at: new Date(nowMs - 7 * HOUR).toISOString(),
        },
      ],
    });

    // Still stale, prior DOWN is 7h old (> 6h repeat window) -> one new DOWN.
    await runWorkerHeartbeatAlarm(deps);
    expect(downCount(deps.comments, 'A')).toBe(2);

    // A heartbeats again; run the alarm twice -> exactly one recovery UP.
    nowMs += 5 * MINUTE;
    deps.workers.A = worker('A', nowMs);
    await runWorkerHeartbeatAlarm(deps);
    nowMs += 5 * MINUTE;
    await runWorkerHeartbeatAlarm(deps);

    expect(downCount(deps.comments, 'A')).toBe(2);
    expect(upCount(deps.comments, 'A')).toBe(1);
  });

  test('Test 4: alarm_ignores_nudge_switch_and_obeys_its_own', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DUTY_OFFICER_GH_NUDGE = 'false';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const deps = alarmDeps({ workers: { A: worker('A', nowMs - 11 * MINUTE) }, now: () => nowMs });

    // Enabled by default even though the nudge switch is off.
    await runWorkerHeartbeatAlarm(deps);
    expect(downCount(deps.comments, 'A')).toBe(1);

    // Explicit disable -> no further posts.
    process.env.DISPATCH_WORKER_ALARM_ENABLED = 'false';
    await runWorkerHeartbeatAlarm(deps);
    expect(downCount(deps.comments, 'A')).toBe(1);
  });
});

// Full DutyOfficerClockDeps stub mirroring duty-officer-clock.test.ts, so Test 5
// proves the alarm runs inside a real tick without breaking it.
function tickDeps(
  alarm: WorkerHeartbeatAlarmDeps,
  now: () => Date
): DutyOfficerClockDeps & { getWorker: WorkerHeartbeatAlarmDeps['getWorker'] } {
  return {
    registerWorker: mock(async data => ({
      ...data,
      status: 'available' as const,
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    heartbeatWorker: mock(async data => ({
      worker_id: data.worker_id,
      host: 'test',
      capabilities: {},
      max_concurrency: 1,
      status: data.status ?? 'available',
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    listMessages: mock(async () => []),
    claimMessage: mock(async () => null),
    postResult: mock(async () => null),
    releaseMessage: mock(async () => null),
    createAuthenticatedMessage: mock(async () => ({ id: 'xo-msg' })),
    getCurrentXoLease: mock(async () => null),
    listStaleIssues: mock(async () => []),
    postIssueComment: mock(async () => false),
    getWorker: alarm.getWorker,
    postAlarmComment: alarm.postAlarmComment,
    listAlarmIssueComments: alarm.listIssueComments,
    judge: mock(async () => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'hold' as const,
      reason: 'test',
      body: '',
      failures: [],
    })),
    securityDetector: mock(async () => null),
    now,
  };
}

describe('worker heartbeat alarm inside the Duty Officer tick', () => {
  test('Test 5: missing_row_counts_as_stale_and_errors_do_not_break_tick', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'C';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    // C has no row (missing => stale); the first post attempt throws once.
    const alarm = alarmDeps({ workers: { C: null }, now: () => nowMs, postThrowsTimes: 1 });
    const deps = tickDeps(alarm, () => new Date(nowMs));

    // First tick: post throws but is caught; the tick still completes.
    await expect(tickDutyOfficerClock(deps)).resolves.toBeUndefined();
    expect(deps.registerWorker).toHaveBeenCalled();
    expect(alarm.comments.length).toBe(0);

    // Next tick: C is still stale and the post now succeeds.
    await expect(tickDutyOfficerClock(deps)).resolves.toBeUndefined();
    expect(downCount(alarm.comments, 'C')).toBe(1);
  });
});

describe('worker heartbeat alarm GitHub reads route through serviceGitHubFetch', () => {
  afterEach(() => {
    delete process.env.GITHUB_APP_TASKMASTER_ID;
    delete process.env.GITHUB_APP_TASKMASTER_INSTALLATION_ID;
    delete process.env.GITHUB_APP_TASKMASTER_PRIVATE_KEY;
    clearServiceGitHubTokenCache();
  });

  test('a 401 on the comment read re-mints once and retries instead of throwing', async () => {
    // Regression guard (Codex diff review): the read used a raw fetch, so a 401
    // threw worker_heartbeat_alarm_http_401 with no refresh. Routed through
    // serviceGitHubFetch for the duty_officer App identity, a 401 now clears the
    // cached installation token, re-mints once, and retries.
    clearServiceGitHubTokenCache();
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.GITHUB_APP_TASKMASTER_ID = '77';
    process.env.GITHUB_APP_TASKMASTER_INSTALLATION_ID = '88';
    process.env.GITHUB_APP_TASKMASTER_PRIVATE_KEY = key;

    let mints = 0;
    let reads = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string | URL | Request,
      _init?: RequestInit
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        mints += 1;
        return Response.json({
          token: `mint-${mints}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      reads += 1;
      // First read is a 401 (stale token); the retry after re-mint succeeds.
      if (reads === 1) return new Response('unauthorized', { status: 401 });
      return new Response('[]', { status: 200 });
    }) as typeof fetch);

    try {
      const result = await listWorkerAlarmIssueComments({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 1234,
      });
      expect(result).toEqual([]);
      // One initial mint (presence guard), one re-mint after the 401; the read
      // was attempted twice, the second carrying the freshly minted token.
      expect(mints).toBe(2);
      expect(reads).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
