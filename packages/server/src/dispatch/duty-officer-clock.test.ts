import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { normalizeDispatchSubjectKey } from '@archon/core/db/dispatch';
import { resetOpsRouteSuppressionForTests } from './ops-event-routing';
import type { OpsInboxGitHub } from './ops-inbox';
import {
  resetSecurityDetectorStateForTests,
  runSecurityDetector,
  type SecurityDetectorResult,
} from './duty-officer-security-detector';
import {
  githubIssueInAllowList,
  githubNudgeEnabled,
  startDutyOfficerClock,
  stopDutyOfficerClock,
  tickDutyOfficerClock,
  type DutyOfficerClockDeps,
} from './duty-officer-clock';

test('explicit GitHub nudge switch still requires a usable authenticated identity', () => {
  process.env.DUTY_OFFICER_GH_NUDGE = 'true';
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  expect(githubNudgeEnabled()).toBe(false);
  process.env.GH_TOKEN = '   ';
  expect(githubNudgeEnabled()).toBe(false);
  process.env.GH_TOKEN = 'synthetic-pat';
  expect(githubNudgeEnabled()).toBe(true);
});

function message(overrides: Partial<DispatchMessage> & { id: string }): DispatchMessage {
  return {
    correlation_id: `correlation-${overrides.id}`,
    idempotency_key: `do-${overrides.id}`,
    task_type: 'run_report',
    sender: 'overseer',
    recipient: 'duty-officer',
    body: JSON.stringify({ kind: 'run_report', detail: 'failed' }),
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: null,
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
    ...overrides,
  };
}

/** Records every upsertDigestSection write so tests can assert section contents. */
interface SectionWrite {
  dateUtc: string;
  sectionKey: string;
  markdown: string;
}

function fakeOpsInbox(): OpsInboxGitHub {
  return {
    findOpenIssueByLabel: mock(async () => ({ number: 1 })),
    labelExists: mock(async () => true),
    createLabel: mock(async () => {}),
    createIssue: mock(async () => ({ number: 1 })),
    listComments: mock(async () => []),
    createComment: mock(async () => ({ id: 1 })),
    updateComment: mock(async () => {}),
  };
}

function fakeDeps(queued: DispatchMessage[]): DutyOfficerClockDeps & {
  llm: ReturnType<typeof mock>;
  sectionWrites: SectionWrite[];
} {
  const terminal = new Set<string>();
  const sectionWrites: SectionWrite[] = [];
  const llm = mock(async () => {
    throw new Error('llm_must_not_run');
  });
  return {
    llm,
    sectionWrites,
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
    listMessages: mock(async ({ recipient }) =>
      recipient === 'duty-officer' || recipient === 'do' ? queued : []
    ),
    claimMessage: mock(async ({ id, worker_id }) => {
      if (terminal.has(id)) return null;
      const found = queued.find(item => item.id === id);
      return found
        ? { ...found, status: 'claimed' as const, lease_owner: worker_id, fencing_token: 1 }
        : null;
    }),
    postResult: mock(async input => {
      terminal.add(input.id);
      const found = queued.find(item => item.id === input.id);
      return found
        ? {
            ...found,
            status: input.status ?? 'done',
            result_body: input.result_body,
            task_outcome: input.task_outcome ?? null,
          }
        : null;
    }),
    releaseMessage: mock(async input => {
      const found = queued.find(item => item.id === input.id);
      return found ? { ...found, status: 'queued' as const, lease_owner: null } : null;
    }),
    createAuthenticatedMessage: mock(async (_context, data) => {
      if (data.subject_key != null) normalizeDispatchSubjectKey(data.subject_key);
      return { id: 'xo-msg' };
    }),
    getCurrentXoLease: mock(async () => null),
    listStaleIssues: mock(async () => {
      throw new Error('github_must_not_run_without_token');
    }),
    postIssueComment: mock(async () => {
      throw new Error('github_must_not_run_without_nudge_flag');
    }),
    opsInboxGitHub: fakeOpsInbox(),
    upsertDigestSection: mock(async (_gh, dateUtc, sectionKey, markdown) => {
      sectionWrites.push({ dateUtc, sectionKey, markdown });
      return { issueNumber: 1, commentId: 1, created: false };
    }),
    readReaderDigest: mock(async () => null),
    judge: mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: item.task_type === 'run_report' ? ('escalate_xo' as const) : ('hold' as const),
      reason: 'test',
      body: item.body,
      failures: [],
    })),
    securityDetector: mock(async () => null),
  };
}

/** Count recipient 'xo' rows created via createAuthenticatedMessage. */
function xoRowCount(deps: DutyOfficerClockDeps): number {
  const calls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  return calls.filter(c => (c[1] as { recipient?: string }).recipient === 'xo').length;
}

/** The parsed body of the Nth recipient 'xo' row. */
function xoRowBody(deps: DutyOfficerClockDeps, n = 0): Record<string, unknown> {
  const calls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const xo = calls.filter(c => (c[1] as { recipient?: string }).recipient === 'xo');
  return JSON.parse((xo[n][1] as { body: string }).body) as Record<string, unknown>;
}

/** The priority of the Nth recipient 'xo' row. */
function xoRowPriority(deps: DutyOfficerClockDeps, n = 0): string {
  const calls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const xo = calls.filter(c => (c[1] as { recipient?: string }).recipient === 'xo');
  return (xo[n][1] as { priority: string }).priority;
}

function routineLines(deps: DutyOfficerClockDeps & { sectionWrites: SectionWrite[] }): string[] {
  return deps.sectionWrites
    .filter(w => w.sectionKey === 'routine')
    .flatMap(w => w.markdown.split('\n'))
    .filter(line => line.trim().length > 0);
}

function sectionWritesFor(
  deps: DutyOfficerClockDeps & { sectionWrites: SectionWrite[] },
  sectionKey: string
): SectionWrite[] {
  return deps.sectionWrites.filter(w => w.sectionKey === sectionKey);
}

beforeEach(() => {
  resetOpsRouteSuppressionForTests();
});

afterEach(() => {
  stopDutyOfficerClock();
  resetSecurityDetectorStateForTests();
  delete process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_CLOCK_ENABLED;
  delete process.env.DUTY_OFFICER_GH_NUDGE;
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_TIMEOUT_MS;
  delete process.env.ARCHON_BUILD_SHA;
});

const priorDetectorResult: SecurityDetectorResult = {
  verdict: 'observation_error',
  reasons: [{ code: 'scan_unavailable' }],
  evaluated_at: '2026-09-23T12:00:00.000Z',
  marker_home: 1,
  wrote: [],
  last_error: 'scan_fetch_failed',
};

function registeredDetector(deps: DutyOfficerClockDeps, call = -1): Record<string, unknown> {
  const calls = (
    deps.registerWorker as unknown as {
      mock: { calls: [Parameters<DutyOfficerClockDeps['registerWorker']>[0]][] };
    }
  ).mock.calls;
  return calls.at(call)![0].capabilities.security_detector as Record<string, unknown>;
}

async function seedDetector(): Promise<DutyOfficerClockDeps> {
  const deps = fakeDeps([]);
  process.env.ARCHON_BUILD_SHA = 'prior-build';
  deps.now = () => new Date(priorDetectorResult.evaluated_at);
  deps.securityDetector = mock(async () => priorDetectorResult);
  await tickDutyOfficerClock(deps);
  return deps;
}

describe('duty officer clock', () => {
  test('fresh deps each tick preserve detector throttle and verdict until the interval expires', async () => {
    resetSecurityDetectorStateForTests();
    process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS = 'owner/scan';
    process.env.DUTY_OFFICER_GH_REPO = 'owner/write';
    const interval = 21_600_000;
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS = String(interval);
    const start = Date.parse('2026-09-30T12:00:00Z');
    let tickTime = start;
    const fetchImpl = mock(async (url: string | URL | Request) =>
      Response.json(String(url).includes('/runs?') ? { workflow_runs: [] } : [])
    );
    const writeTokenProvider = mock(async () => null);
    // Mirror createRealDutyOfficerClockDeps: construct detector deps on every invocation.
    const createTickDeps = (): DutyOfficerClockDeps => ({
      ...fakeDeps([]),
      now: () => new Date(tickTime),
      securityDetector: signal =>
        runSecurityDetector(
          {
            fetchImpl: fetchImpl as typeof fetch,
            readToken: () => 'test-read-token',
            writeTokenProvider,
            now: () => new Date(tickTime),
            buildSha: 'test-build',
          },
          signal
        ),
    });

    const first = createTickDeps();
    await tickDutyOfficerClock(first);
    const prior = registeredDetector(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writeTokenProvider).toHaveBeenCalledTimes(1);
    expect(prior.last_run_at).toBe(new Date(start).toISOString());

    tickTime += 900_000;
    const second = createTickDeps();
    await tickDutyOfficerClock(second);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writeTokenProvider).toHaveBeenCalledTimes(1);
    expect(registeredDetector(second)).toEqual({
      ...prior,
      last_tick_detector_outcome: 'skipped_throttled',
      last_tick_at: new Date(tickTime).toISOString(),
    });

    tickTime = start + interval + 1;
    const third = createTickDeps();
    await tickDutyOfficerClock(third);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(writeTokenProvider).toHaveBeenCalledTimes(2);
    expect(registeredDetector(third).last_run_at).toBe(new Date(tickTime).toISOString());
  });

  test('completed detector evidence survives three throttled ticks and both registrations', async () => {
    const deps = await seedDetector();
    const prior = registeredDetector(deps);
    deps.securityDetector = mock(async () => null);
    process.env.ARCHON_BUILD_SHA = 'new-build';
    for (let tick = 1; tick <= 3; tick++) {
      const now = new Date(Date.parse(priorDetectorResult.evaluated_at) + tick * 900_000);
      deps.now = () => now;
      const before = registeredDetector(deps);
      await tickDutyOfficerClock(deps);
      expect(registeredDetector(deps, -2)).toEqual(before);
      expect(registeredDetector(deps)).toEqual({
        ...prior,
        last_tick_detector_outcome: 'skipped_throttled',
        last_tick_at: now.toISOString(),
      });
    }
  });

  test('timed-out detector increments errors and in-flight skip retains prior evidence', async () => {
    const deps = await seedDetector();
    const prior = registeredDetector(deps);
    let finish!: (result: SecurityDetectorResult | null) => void;
    let signal: AbortSignal | undefined;
    deps.securityDetector = mock(received => {
      signal = received;
      return new Promise<SecurityDetectorResult | null>(resolve => {
        finish = resolve;
      });
    });
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_TIMEOUT_MS = '10';
    deps.now = () => new Date('2026-09-23T18:00:00.000Z');
    try {
      await tickDutyOfficerClock(deps);
      expect(signal?.aborted).toBe(true);
      const timedOut = registeredDetector(deps);
      expect(timedOut).toEqual({
        ...prior,
        error_count: Number(prior.error_count) + 1,
        last_error: 'duty_officer_security_detector_timeout',
        last_tick_detector_outcome: 'timed_out',
        last_tick_at: '2026-09-23T18:00:00.000Z',
      });
      deps.now = () => new Date('2026-09-23T18:15:00.000Z');
      await tickDutyOfficerClock(deps);
      expect(deps.securityDetector).toHaveBeenCalledTimes(1);
      expect(registeredDetector(deps, -2)).toEqual(timedOut);
      expect(registeredDetector(deps)).toEqual({
        ...timedOut,
        last_tick_detector_outcome: 'skipped_in_flight',
        last_tick_at: '2026-09-23T18:15:00.000Z',
      });
    } finally {
      finish({ ...priorDetectorResult, verdict: 'clean' });
      await Promise.resolve();
    }
    // A late result from an aborted run must not replace completed evidence.
    deps.securityDetector = mock(async () => null);
    await tickDutyOfficerClock(deps);
    expect(registeredDetector(deps).verdict).toBe(prior.verdict);
  });

  test('failed detector increments errors while retaining the prior verdict and run time', async () => {
    const deps = await seedDetector();
    const prior = registeredDetector(deps);
    deps.securityDetector = mock(async () => {
      throw new Error('detector_failed');
    });
    await tickDutyOfficerClock(deps);
    expect(registeredDetector(deps)).toEqual({
      ...prior,
      error_count: Number(prior.error_count) + 1,
      last_error: 'detector_failed',
      last_tick_detector_outcome: 'error',
    });
  });

  test('fresh completed detector result replaces the prior evidence', async () => {
    const deps = await seedDetector();
    const prior = registeredDetector(deps);
    process.env.ARCHON_BUILD_SHA = 'fresh-build';
    deps.now = () => new Date('2026-09-23T18:00:00.000Z');
    deps.securityDetector = mock(async () => ({
      verdict: 'clean' as const,
      reasons: [],
      evaluated_at: '2026-09-23T18:00:00.000Z',
      marker_home: 1,
      wrote: [],
    }));
    await tickDutyOfficerClock(deps);
    expect(registeredDetector(deps, -2)).toEqual(prior);
    expect(registeredDetector(deps)).toEqual({
      last_run_at: '2026-09-23T18:00:00.000Z',
      verdict: 'clean',
      reasons: [],
      error_count: 0,
      last_error: null,
      build_sha: 'fresh-build',
      last_tick_detector_outcome: 'completed',
      last_tick_at: '2026-09-23T18:00:00.000Z',
    });
  });

  test('startDutyOfficerClock is a no-op in test env and when disabled', async () => {
    const deps = fakeDeps([message({ id: 'never' })]);
    const originalNodeEnv = process.env.NODE_ENV;

    startDutyOfficerClock(deps);
    await Bun.sleep(5);
    expect(deps.registerWorker).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'production';
    process.env.DUTY_OFFICER_CLOCK_ENABLED = 'false';
    try {
      startDutyOfficerClock(deps);
      await Bun.sleep(5);
      expect(deps.registerWorker).not.toHaveBeenCalled();
    } finally {
      stopDutyOfficerClock();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('GitHub token alone does not nudge; Taskmaster digest is succeeded not held', async () => {
    const queued = [
      message({
        id: 'digest',
        correlation_id: 'tm-journal-digest',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'digest:2026-09-18',
        body: 'sent=0, parked=0',
      }),
    ];
    const deps = fakeDeps(queued);
    process.env.GITHUB_TOKEN = 'ghs_test_not_a_nudge_grant';

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(0);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'digest', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.releaseMessage).not.toHaveBeenCalled();
    expect(deps.listStaleIssues).not.toHaveBeenCalled();
    expect(deps.postIssueComment).not.toHaveBeenCalled();
  });

  test('Taskmaster digest is succeeded even when the judge returns nudge', async () => {
    const queued = [
      message({
        id: 'digest-nudge',
        correlation_id: 'tm-journal-digest-nudge',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'digest:2026-09-18',
        body: 'sent=0, parked=0',
      }),
    ];
    const deps = fakeDeps(queued);
    deps.judge = mock(async () => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'nudge' as const,
      reason: 'judge_said_nudge',
      body: '',
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(0);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'digest-nudge', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  test('opt-in GitHub nudge posts stale issues; foreign repos are refused', async () => {
    const deps = fakeDeps([]);
    deps.listStaleIssues = mock(async () => [
      { owner: 'thinmansoftware', repo: 'bdc-xo', number: 12 },
    ]);
    deps.postIssueComment = mock(async () => {});
    process.env.DUTY_OFFICER_GH_NUDGE = 'true';
    process.env.GITHUB_TOKEN = 'ghs_test';

    await tickDutyOfficerClock(deps);

    expect(deps.listStaleIssues).toHaveBeenCalled();
    expect(deps.postIssueComment).toHaveBeenCalledWith(
      { owner: 'thinmansoftware', repo: 'bdc-xo', number: 12 },
      expect.stringContaining('duty-officer-nudge')
    );
    expect(githubIssueInAllowList({ owner: 'thinmansoftware', repo: 'bdc-xo', number: 1 })).toBe(
      true
    );
    expect(githubIssueInAllowList({ owner: 'other', repo: 'bdc-xo', number: 1 })).toBe(false);
  });

  test('never resolving detector does not wedge tick', async () => {
    // A NEEDS_A_PERSON interrupt item so each tick creates exactly one xo row.
    const interruptMsg = (id: string): DispatchMessage =>
      message({
        id,
        task_type: 'agent_message',
        sender: 'overseer',
        body: 'decision needed: approve deploy',
      });
    const queued = [interruptMsg('detector-timeout')];
    const deps = fakeDeps(queued);
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));
    let finish!: () => void;
    let receivedSignal: AbortSignal | undefined;
    deps.securityDetector = mock(signal => {
      receivedSignal = signal;
      return new Promise(resolve => {
        finish = () => resolve(null);
      });
    });
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
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_TIMEOUT_MS = '50';
    try {
      await tickDutyOfficerClock(deps);
      expect(receivedSignal?.aborted).toBe(true);
      queued.push(interruptMsg('after-detector-timeout'));
      await tickDutyOfficerClock({ ...deps });
      expect(deps.securityDetector).toHaveBeenCalledTimes(1);
      expect(
        lines.some(line => line.includes('duty_officer_security_detector_skipped_in_flight'))
      ).toBe(true);
      expect(deps.listMessages).toHaveBeenCalledTimes(4);
      expect(xoRowCount(deps)).toBe(2);
      expect(deps.judge).toHaveBeenCalledTimes(2);
      expect(deps.llm).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      finish();
      await Promise.resolve();
    }
    // The guard releases when the underlying run finally settles.
    deps.securityDetector = mock(async () => null);
    await tickDutyOfficerClock(deps);
    expect(deps.securityDetector).toHaveBeenCalledTimes(1);
  });

  test('detector runs before nudge gate and never touches judge', async () => {
    const queued = [message({ id: 'detector-before-gate', task_type: 'agent_message' })];
    const deps = fakeDeps(queued);
    await tickDutyOfficerClock(deps);
    expect(deps.securityDetector).toHaveBeenCalledTimes(1);
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(deps.listStaleIssues).not.toHaveBeenCalled();
  });

  test('tick end writes completion fields to worker capabilities', async () => {
    const deps = fakeDeps([]);
    process.env.ARCHON_BUILD_SHA = 'abc1234';
    deps.securityDetector = mock(async () => ({
      verdict: 'clean' as const,
      reasons: [],
      evaluated_at: '2026-09-23T12:00:00.000Z',
      marker_home: 1,
      wrote: [],
    }));
    await tickDutyOfficerClock(deps);
    expect(deps.registerWorker).toHaveBeenCalledTimes(2);
    const calls = (deps.registerWorker as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[1][0]).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({
          started_at: expect.any(String),
          build_sha: 'abc1234',
          last_tick_completed_at: expect.any(String),
          security_detector: expect.objectContaining({ verdict: 'clean' }),
        }),
      })
    );
  });

  // --- WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01 routing tests ---

  test('Test 1 routine_events_land_in_digest_only', async () => {
    const routineFixtures: DispatchMessage[] = [
      message({ id: 'r-run-finished', task_type: 'agent_message', body: 'run finished cleanly' }),
      message({
        id: 'r-run-failed-retry',
        task_type: 'agent_message',
        body: 'run failed; retry scheduled',
      }),
      message({ id: 'r-pr-opened', task_type: 'agent_message', body: 'PR opened for review' }),
      message({ id: 'r-checks-green', task_type: 'agent_message', body: 'checks green on main' }),
      message({
        id: 'r-rate-limit',
        task_type: 'agent_message',
        body: 'rate-limit window reset',
      }),
      message({ id: 'r-session', task_type: 'agent_message', body: 'session archived' }),
    ];
    const deps = fakeDeps(routineFixtures);
    // Judge returns escalate_xo but the ops-event router reclassifies to ROUTINE.
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(0);
    expect(routineLines(deps)).toHaveLength(6);
    // Exactly one upsertDigestSection call for the routine section (batched).
    expect(sectionWritesFor(deps, 'routine')).toHaveLength(1);
    for (const fixture of routineFixtures) {
      expect(routineLines(deps).some(line => line.includes(fixture.id))).toBe(true);
    }
  });

  test('Test 2 needs_person_interrupts_naming_item_and_default', async () => {
    const queued = [
      message({
        id: 'np-1',
        task_type: 'agent_message',
        subject_key: 'gh:thinmansoftware/bdc-xo#1538',
        body: 'decision needed: approve deploy for gh:thinmansoftware/bdc-xo#1538',
      }),
    ];
    const deps = fakeDeps(queued);
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(1);
    expect(xoRowPriority(deps)).toBe('normal');
    const body = xoRowBody(deps);
    expect(body.kind).toBe('ops_interrupt');
    expect(body.class).toBe('NEEDS_A_PERSON');
    expect(body.item).toBe('gh:thinmansoftware/bdc-xo#1538');
    expect(typeof body.default_if_unanswered).toBe('string');
    expect((body.default_if_unanswered as string).length).toBeGreaterThan(0);
    expect(routineLines(deps)).toHaveLength(0);
  });

  test('Test 3 blocker_interrupts_with_blocker_priority', async () => {
    const blockerReport = message({
      id: 'b-tm-report',
      sender: 'taskmaster',
      task_type: 'agent_message',
      idempotency_key: 'tm:blocker_report:gh:thinmansoftware/bdc-xo#9001:1',
      subject_key: 'gh:thinmansoftware/bdc-xo#9001',
      body: 'Blocker report (P1): WO-Z-01 stuck.',
    });
    const securityMsg = message({
      id: 'b-security',
      task_type: 'agent_message',
      sender: 'overseer',
      subject_key: 'gh:thinmansoftware/bdc-xo#9002',
      body: 'service_role key exposed in logs',
    });
    const deps = fakeDeps([blockerReport, securityMsg]);
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(2);
    const calls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    for (const call of calls) {
      const data = call[1] as { priority: string; body: string };
      expect(data.priority).toBe('blocker');
      expect((JSON.parse(data.body) as { class: string }).class).toBe('BLOCKER');
    }
    expect(routineLines(deps)).toHaveLength(0);
  });

  test('Test 4 each_fixture_lands_in_exactly_one_place', async () => {
    const routineFixtures: DispatchMessage[] = [
      message({ id: 'r-run-finished', task_type: 'agent_message', body: 'run finished cleanly' }),
      message({
        id: 'r-run-failed-retry',
        task_type: 'agent_message',
        body: 'run failed; retry scheduled',
      }),
      message({ id: 'r-pr-opened', task_type: 'agent_message', body: 'PR opened for review' }),
      message({ id: 'r-checks-green', task_type: 'agent_message', body: 'checks green on main' }),
      message({ id: 'r-rate-limit', task_type: 'agent_message', body: 'rate-limit window reset' }),
      message({ id: 'r-session', task_type: 'agent_message', body: 'session archived' }),
    ];
    const interruptFixtures: DispatchMessage[] = [
      message({
        id: 'np-1',
        task_type: 'agent_message',
        subject_key: 'gh:thinmansoftware/bdc-xo#1538',
        body: 'decision needed: approve deploy for gh:thinmansoftware/bdc-xo#1538',
      }),
      message({
        id: 'b-tm-report',
        sender: 'taskmaster',
        task_type: 'agent_message',
        idempotency_key: 'tm:blocker_report:gh:thinmansoftware/bdc-xo#9001:1',
        subject_key: 'gh:thinmansoftware/bdc-xo#9001',
        body: 'Blocker report (P1): WO-Z-01 stuck.',
      }),
      message({
        id: 'b-security',
        task_type: 'agent_message',
        sender: 'overseer',
        subject_key: 'gh:thinmansoftware/bdc-xo#9002',
        body: 'service_role key exposed in logs',
      }),
    ];
    const all = [...routineFixtures, ...interruptFixtures];
    const deps = fakeDeps(all);
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    // 6 routine -> digest lines, 3 interrupts -> xo rows. Each exactly one place.
    expect(routineLines(deps)).toHaveLength(6);
    expect(xoRowCount(deps)).toBe(3);
    // No routine fixture produced an xo row.
    const xoCalls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const xoSourceIds = xoCalls.map(
      c => (JSON.parse((c[1] as { body: string }).body) as { source_id: string }).source_id
    );
    for (const fixture of routineFixtures) {
      expect(xoSourceIds).not.toContain(fixture.id);
      expect(routineLines(deps).some(line => line.includes(fixture.id))).toBe(true);
    }
    for (const fixture of interruptFixtures) {
      expect(xoSourceIds).toContain(fixture.id);
      expect(routineLines(deps).some(line => line.includes(fixture.id))).toBe(false);
    }
  });

  test('Test 15 duty_officer_escalation_routine_never_creates_xo_row', async () => {
    const queued = [
      message({
        id: 'do-routine',
        task_type: 'agent_message',
        sender: 'overseer',
        body: 'run finished cleanly, nothing to see here',
      }),
    ];
    const deps = fakeDeps(queued);
    // The DO judge says escalate, but the ops-event router classifies ROUTINE.
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    const calls = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const xoOrOperator = calls.filter(c => {
      const recipient = (c[1] as { recipient?: string }).recipient;
      return recipient === 'xo' || recipient === 'operator';
    });
    expect(xoOrOperator).toHaveLength(0);
    expect(routineLines(deps).some(line => line.includes('do-routine'))).toBe(true);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'do-routine', status: 'done', task_outcome: 'succeeded' })
    );
  });

  test('interrupt relay failure holds the item and retries with the same escalation key', async () => {
    const queued = [
      message({
        id: 'np-fail',
        task_type: 'agent_message',
        subject_key: 'gh:thinmansoftware/bdc-xo#1600',
        body: 'decision needed: approve rotation',
      }),
    ];
    const deps = fakeDeps(queued);
    deps.judge = mock(async (item: DispatchMessage) => ({
      status: 'ok' as const,
      transport: 'test',
      action: 'escalate_xo' as const,
      reason: 'test',
      body: item.body,
      failures: [],
    }));
    let relayCalls = 0;
    deps.createAuthenticatedMessage = mock(async (_context, data) => {
      relayCalls += 1;
      if (relayCalls === 1) throw new Error('dispatch_unavailable');
      if (data.subject_key != null) normalizeDispatchSubjectKey(data.subject_key);
      return { id: 'xo-msg' };
    });

    // Tick 1: relay throws -> item held (releaseMessage), not finished.
    await tickDutyOfficerClock(deps);
    expect(deps.releaseMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'np-fail' }));
    const postedAfter1 = (deps.postResult as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(postedAfter1).toHaveLength(0);

    // Tick 2: claimable again, relays once with the SAME escalation key.
    await tickDutyOfficerClock(deps);
    const keys = (
      deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map(c => (c[1] as { idempotency_key: string }).idempotency_key);
    expect(keys).toEqual(['do-clock-escalation:np-fail', 'do-clock-escalation:np-fail']);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'np-fail', status: 'done', task_outcome: 'succeeded' })
    );
  });

  test('Test 29 overdue_xo_row_does_not_create_another_xo_row', async () => {
    const queued = [
      message({
        id: 'overdue-1',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'gh:thinmansoftware/bdc-xo#4242',
        body: JSON.stringify({
          kind: 'owner_ack_overdue',
          overdue_recipient: 'xo',
          item: 'gh:thinmansoftware/bdc-xo#4242',
        }),
      }),
    ];
    const deps = fakeDeps(queued);

    await tickDutyOfficerClock(deps);

    expect(xoRowCount(deps)).toBe(0);
    const escalated = sectionWritesFor(deps, 'escalated');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].markdown).toContain('overdue-1');
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'overdue-1', status: 'done', task_outcome: 'succeeded' })
    );
  });
});
