import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { normalizeDispatchSubjectKey } from '@archon/core/db/dispatch';
import {
  resetSecurityDetectorStateForTests,
  runSecurityDetector,
  type SecurityDetectorResult,
} from './duty-officer-security-detector';
import {
  githubIssueInAllowList,
  startDutyOfficerClock,
  stopDutyOfficerClock,
  tickDutyOfficerClock,
  type DutyOfficerClockDeps,
} from './duty-officer-clock';

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

function fakeDeps(queued: DispatchMessage[]): DutyOfficerClockDeps & {
  llm: ReturnType<typeof mock>;
} {
  const terminal = new Set<string>();
  const llm = mock(async () => {
    throw new Error('llm_must_not_run');
  });
  return {
    llm,
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
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_ENABLED;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_REPO;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_BRANCH;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_GRACE_MS;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_INTERVAL_MS;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_TIMEOUT_MS;
  delete process.env.DUTY_OFFICER_DEPLOY_DRIFT_RECIPIENT;
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

  test('escalates a queued run_report to xo with no LLM and no GitHub call', async () => {
    const queued = [message({ id: 'one' })];
    const deps = fakeDeps(queued);
    const previousGh = process.env.GH_TOKEN;
    const previousGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    await tickDutyOfficerClock(deps);
    await tickDutyOfficerClock(deps);

    expect(deps.claimMessage).toHaveBeenCalled();
    expect(deps.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    const createCall = (
      deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0];
    expect(createCall[0]).toEqual({ kind: 'system', sender: 'dispatch' });
    expect(createCall[1]).toEqual(
      expect.objectContaining({
        recipient: 'xo',
        task_type: 'agent_message',
        correlation_id: 'correlation-one',
        idempotency_key: 'do-clock-escalation:one',
      })
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'one', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.llm).not.toHaveBeenCalled();
    expect(deps.listStaleIssues).not.toHaveBeenCalled();
    expect(deps.postIssueComment).not.toHaveBeenCalled();

    if (previousGh !== undefined) process.env.GH_TOKEN = previousGh;
    if (previousGithub !== undefined) process.env.GITHUB_TOKEN = previousGithub;
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

    expect(deps.createAuthenticatedMessage).not.toHaveBeenCalled();
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

    expect(deps.createAuthenticatedMessage).not.toHaveBeenCalled();
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'digest-nudge', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  test('Taskmaster self-pause copies to xo then succeeds the source row', async () => {
    const queued = [
      message({
        id: 'pause',
        correlation_id: 'tm-self-pause-3',
        idempotency_key: 'tm:self-pause:3',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'taskmaster:self-pause',
        body: 'Taskmaster self-paused',
      }),
    ];
    const deps = fakeDeps(queued);

    await tickDutyOfficerClock(deps);

    const createCall = (
      deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0];
    expect(createCall[0]).toEqual({ kind: 'system', sender: 'dispatch' });
    expect(createCall[1]).toEqual(
      expect.objectContaining({
        recipient: 'xo',
        correlation_id: 'tm-self-pause-3',
      })
    );
    expect((createCall[1] as { subject_key?: string }).subject_key).toBeUndefined();
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pause', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  test('judge-disabled mechanical path copies self-pause to xo without a subject_key', async () => {
    const queued = [
      message({
        id: 'pause-mech',
        correlation_id: 'tm-self-pause-4',
        idempotency_key: 'tm:self-pause:4',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'taskmaster:self-pause',
        body: 'Taskmaster self-paused',
      }),
    ];
    const deps = fakeDeps(queued);
    deps.judge = mock(async () => ({
      status: 'unconfigured' as const,
      action: 'hold' as const,
      reason: 'judge_disabled',
      body: '',
      failures: [],
    }));

    await tickDutyOfficerClock(deps);

    const payload = (deps.createAuthenticatedMessage as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as { recipient: string; subject_key?: string };
    expect(payload.recipient).toBe('xo');
    expect(payload.subject_key).toBeUndefined();
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pause-mech', status: 'done', task_outcome: 'succeeded' })
    );
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

  test('judge outage on a run_report still mechanical-escalates to xo', async () => {
    const queued = [message({ id: 'outage' })];
    const deps = fakeDeps(queued);
    deps.judge = mock(async () => ({
      status: 'failed' as const,
      action: 'hold' as const,
      reason: 'duty_officer_judge_outage',
      body: 'DO judge outage',
      failures: [{ transport: 'openrouter:x-ai/grok-4.6', error: '402' }],
    }));

    await tickDutyOfficerClock(deps);

    expect(deps.createAuthenticatedMessage).toHaveBeenCalledWith(
      { kind: 'system', sender: 'dispatch' },
      expect.objectContaining({ recipient: 'xo', idempotency_key: 'do-clock-escalation:outage' })
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'outage', status: 'done', task_outcome: 'succeeded' })
    );
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  test('self-pause is held when the xo copy throws so Taskmaster can retry', async () => {
    const queued = [
      message({
        id: 'pause-fail',
        correlation_id: 'tm-self-pause-5',
        idempotency_key: 'tm:self-pause:5',
        task_type: 'agent_message',
        sender: 'taskmaster',
        subject_key: 'taskmaster:self-pause',
        body: 'Taskmaster self-paused',
      }),
    ];
    const deps = fakeDeps(queued);
    deps.createAuthenticatedMessage = mock(async () => {
      throw new Error('dispatch_unavailable');
    });

    await tickDutyOfficerClock(deps);

    expect(deps.releaseMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pause-fail', worker_id: 'duty-officer-clock' })
    );
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  test('never resolving detector does not wedge tick', async () => {
    const queued = [message({ id: 'detector-timeout' })];
    const deps = fakeDeps(queued);
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
      queued.push(message({ id: 'after-detector-timeout' }));
      await tickDutyOfficerClock({ ...deps });
      expect(deps.securityDetector).toHaveBeenCalledTimes(1);
      expect(
        lines.some(line => line.includes('duty_officer_security_detector_skipped_in_flight'))
      ).toBe(true);
      expect(deps.listMessages).toHaveBeenCalledTimes(4);
      expect(deps.createAuthenticatedMessage).toHaveBeenCalledTimes(2);
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

  test('clock wiring records deploy drift status and survives a throw', async () => {
    const deps = fakeDeps([]);
    deps.deployDriftDetector = mock(async () => ({
      verdict: 'drift_alerted' as const,
      reasons: ['behind_dev'],
      running_sha: 'a'.repeat(40),
      target_sha: 'b'.repeat(40),
      behind_by: 3,
      last_error: null,
      evaluated_at: '2026-09-24T12:00:00.000Z',
    }));
    await tickDutyOfficerClock(deps);
    expect(deps.deployDriftDetector).toHaveBeenCalledTimes(1);
    const calls = (deps.registerWorker as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const finalCaps = (calls.at(-1)?.[0] as { capabilities: { deploy_drift: { verdict: string } } })
      .capabilities;
    expect(finalCaps.deploy_drift.verdict).toBe('drift_alerted');

    const throwing = fakeDeps([]);
    throwing.deployDriftDetector = mock(async () => {
      throw new Error('detector_boom');
    });
    await tickDutyOfficerClock(throwing);
    expect(throwing.deployDriftDetector).toHaveBeenCalledTimes(1);
    const throwCalls = (throwing.registerWorker as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const throwCaps = (
      throwCalls.at(-1)?.[0] as {
        capabilities: {
          last_tick_completed_at: string;
          deploy_drift: { last_tick_outcome: string };
        };
      }
    ).capabilities;
    expect(throwCaps.last_tick_completed_at).toEqual(expect.any(String));
    expect(throwCaps.deploy_drift.last_tick_outcome).toBe('error');
  });
});
