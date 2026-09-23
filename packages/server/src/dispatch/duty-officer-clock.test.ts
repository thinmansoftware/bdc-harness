import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { normalizeDispatchSubjectKey } from '@archon/core/db/dispatch';
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
    now: () => new Date(0),
  };
}

afterEach(() => {
  stopDutyOfficerClock();
  delete process.env.DUTY_OFFICER_CLOCK_ENABLED;
  delete process.env.DUTY_OFFICER_GH_NUDGE;
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.DUTY_OFFICER_SECURITY_DETECTOR_TIMEOUT_MS;
  delete process.env.ARCHON_BUILD_SHA;
});

describe('duty officer clock', () => {
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

  test('a never-resolving detector does not wedge the tick (W1)', async () => {
    const queued = [message({ id: 'wedge' })];
    const deps = fakeDeps(queued);
    deps.securityDetector = mock(() => new Promise<never>(() => {}));
    process.env.DUTY_OFFICER_SECURITY_DETECTOR_TIMEOUT_MS = '50';

    const started = Date.now();
    await tickDutyOfficerClock(deps);
    const firstElapsed = Date.now() - started;
    await tickDutyOfficerClock(deps);

    expect(firstElapsed).toBeLessThan(1000);
    // listMessages is called once per recipient (duty-officer, do) each tick, so
    // two ticks means it ran on both -- the second tick did NOT return early.
    const listCalls = (deps.listMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .length;
    expect(listCalls).toBeGreaterThanOrEqual(4);
    // The run_report escalated on the first tick (inbox drain ran before the detector).
    expect(deps.createAuthenticatedMessage).toHaveBeenCalledTimes(1);
    expect(deps.createAuthenticatedMessage).toHaveBeenCalledWith(
      { kind: 'system', sender: 'dispatch' },
      expect.objectContaining({ recipient: 'xo', idempotency_key: 'do-clock-escalation:wedge' })
    );
  });

  test('the detector runs before the nudge gate and never touches the judge (N6)', async () => {
    const queued = [
      message({ id: 'agent', task_type: 'agent_message', body: JSON.stringify({ detail: 'x' }) }),
    ];
    const deps = fakeDeps(queued);
    deps.securityDetector = mock(async () => null);
    // Nudge disabled: no token, flag unset -> the nudge gate returns early.
    delete process.env.DUTY_OFFICER_GH_NUDGE;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    await tickDutyOfficerClock(deps);

    expect(deps.securityDetector).toHaveBeenCalledTimes(1);
    // The one queued agent_message drives exactly one judge call; the detector adds none.
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(deps.listStaleIssues).not.toHaveBeenCalled();
  });

  test('tick end writes completion fields into the worker capabilities (C9, N5)', async () => {
    const fixedNow = new Date('2026-09-23T12:00:00.000Z');
    process.env.ARCHON_BUILD_SHA = 'abc1234';

    const deps = fakeDeps([message({ id: 'complete' })]);
    deps.now = () => fixedNow;
    deps.securityDetector = mock(async () => ({
      verdict: 'clean' as const,
      reasons: [],
      evaluated_at: fixedNow.toISOString(),
      marker_home: null,
      wrote: [],
      error_count: 0,
      last_error: null,
    }));

    await tickDutyOfficerClock(deps);

    const calls = (deps.registerWorker as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(2);
    const lastCapabilities = (
      calls[calls.length - 1][0] as { capabilities: Record<string, unknown> }
    ).capabilities;
    expect(lastCapabilities.task_types).toEqual(['run_report', 'agent_message']);
    expect(lastCapabilities.principal).toBe('duty-officer');
    expect(typeof lastCapabilities.started_at).toBe('string');
    expect(lastCapabilities.build_sha).toBe('abc1234');
    expect(lastCapabilities.last_tick_completed_at).toBe(fixedNow.toISOString());
    expect((lastCapabilities.security_detector as { verdict: string }).verdict).toBe('clean');

    // A tick whose inbox drain throws still writes last_tick_completed_at in finally.
    const throwingNow = new Date('2026-09-23T13:00:00.000Z');
    const throwing = fakeDeps([]);
    throwing.now = () => throwingNow;
    throwing.listMessages = mock(async () => {
      throw new Error('inbox_drain_boom');
    });

    await tickDutyOfficerClock(throwing);

    const throwingCalls = (throwing.registerWorker as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(throwingCalls.length).toBe(2);
    const throwingCapabilities = (
      throwingCalls[throwingCalls.length - 1][0] as { capabilities: Record<string, unknown> }
    ).capabilities;
    expect(throwingCapabilities.last_tick_completed_at).toBe(throwingNow.toISOString());
  });
});
