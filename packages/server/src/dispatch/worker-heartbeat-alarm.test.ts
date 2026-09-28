import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { DispatchWorker } from '@archon/core/db/dispatch';
import { rootLogger } from '@archon/paths';
import {
  evaluateWorkerHeartbeats,
  postWorkerAlarmComment,
  runWorkerHeartbeatAlarm,
  type WorkerAlarmIssueComment,
  type WorkerHeartbeatAlarmDeps,
} from './worker-heartbeat-alarm';
import {
  tickDutyOfficerClock,
  type DutyOfficerClockDeps,
  type DutyOfficerStaleIssue,
} from './duty-officer-clock';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Capture NDJSON log lines emitted through the shared root Pino stream, so tests
// can assert a specific event fired at a specific level. Mirrors the stream-spy
// pattern in duty-officer-clock.test.ts. Child loggers created via
// createLogger() write through this same stream, so alarm-module logs are seen.
function captureLogLines(): { lines: string[]; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  )!;
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(line);
  });
  return { lines, restore: () => write.mockRestore() };
}

// Count captured log lines whose Pino `msg` matches `event` at the given numeric
// level (error = 50, warn = 40). Non-JSON lines are ignored.
function logCount(lines: string[], event: string, level: number): number {
  return lines.filter(line => {
    try {
      const parsed = JSON.parse(line) as { msg?: unknown; level?: unknown };
      return parsed.msg === event && parsed.level === level;
    } catch {
      return false;
    }
  }).length;
}

const ERROR_LEVEL = 50;
const WARN_LEVEL = 40;

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
    postIssueComment: mock(async () => {}),
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

// These tests exercise the REAL production posting path (postWorkerAlarmComment)
// with global fetch stubbed, instead of the injected in-memory stub used above.
// They prove the three contract guarantees Codex flagged as unverified: the path
// never consults DUTY_OFFICER_GH_NUDGE, it enforces the repo allowlist, and it
// fails closed (throws) when no GitHub token is present.
const ALLOWED_ISSUE: DutyOfficerStaleIssue = {
  owner: 'thinmansoftware',
  repo: 'bdc-xo',
  number: 2489,
};

describe('postWorkerAlarmComment (real GitHub posting path)', () => {
  test('Test 6: posts_regardless_of_disabled_nudge_switch', async () => {
    // DUTY_OFFICER_GH_NUDGE=false disables the Duty Officer nudge, but the alarm
    // path must ignore that switch entirely and still POST.
    process.env.DUTY_OFFICER_GH_NUDGE = 'false';
    process.env.GITHUB_TOKEN = 'ghs_test';
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 201 })
    );
    try {
      await postWorkerAlarmComment(ALLOWED_ISSUE, 'body-under-test');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/repos/thinmansoftware/bdc-xo/issues/2489/comments');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghs_test');
      expect(JSON.parse(init.body as string)).toEqual({ body: 'body-under-test' });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('Test 7: refuses_repo_outside_allowlist_without_posting', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    // Allowlist is derived from DUTY_OFFICER_GH_REPO (default thinmansoftware/bdc-xo).
    const outsideIssue: DutyOfficerStaleIssue = { owner: 'evil', repo: 'nope', number: 1 };
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 201 })
    );
    const captured = captureLogLines();
    try {
      // Resolves (does not throw) but never touches the network.
      await expect(
        postWorkerAlarmComment(outsideIssue, 'should-not-send')
      ).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logCount(captured.lines, 'worker_heartbeat_alarm_repo_refused', WARN_LEVEL)).toBe(1);
    } finally {
      captured.restore();
      fetchSpy.mockRestore();
    }
  });

  test('Test 8: throws_when_no_github_token', async () => {
    // No GH_TOKEN / GITHUB_TOKEN in env (afterEach clears them).
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(null, { status: 201 })
    );
    try {
      await expect(postWorkerAlarmComment(ALLOWED_ISSUE, 'body')).rejects.toThrow(
        'worker_heartbeat_alarm_token_missing'
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('Test 9: throws_on_non_ok_github_response', async () => {
    process.env.GITHUB_TOKEN = 'ghs_test';
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('forbidden', { status: 403 })
    );
    try {
      await expect(postWorkerAlarmComment(ALLOWED_ISSUE, 'body')).rejects.toThrow(
        'worker_heartbeat_alarm_http_403'
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('runWorkerHeartbeatAlarm token gate', () => {
  test('Test 10: logs_no_token_error_each_tick_and_never_calls_deps', async () => {
    // Enabled, watched worker set, issue in allowlist -- but NO token present.
    // The alarm must fail loud (error-level log) on EVERY tick and must not touch
    // the injected getWorker / listIssueComments / postAlarmComment deps.
    process.env.DISPATCH_WORKER_ALARM_WORKERS = 'A';
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    const deps = alarmDeps({ workers: { A: worker('A', nowMs - 11 * MINUTE) }, now: () => nowMs });
    const captured = captureLogLines();
    try {
      await runWorkerHeartbeatAlarm(deps);
      await runWorkerHeartbeatAlarm(deps);
      expect(logCount(captured.lines, 'worker_heartbeat_alarm_no_token', ERROR_LEVEL)).toBe(2);
    } finally {
      captured.restore();
    }
    expect(deps.getWorker).not.toHaveBeenCalled();
    expect(deps.listIssueComments).not.toHaveBeenCalled();
    expect(deps.postAlarmComment).not.toHaveBeenCalled();
    expect(deps.comments.length).toBe(0);
  });
});
