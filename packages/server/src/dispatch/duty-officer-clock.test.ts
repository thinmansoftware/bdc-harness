import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
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
    createAuthenticatedMessage: mock(async () => ({ id: 'xo-msg' })),
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
  };
}

afterEach(() => {
  stopDutyOfficerClock();
  delete process.env.DUTY_OFFICER_CLOCK_ENABLED;
  delete process.env.DUTY_OFFICER_GH_NUDGE;
  delete process.env.DUTY_OFFICER_GH_REPO;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
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

    expect(deps.createAuthenticatedMessage).toHaveBeenCalledWith(
      { kind: 'system', sender: 'dispatch' },
      expect.objectContaining({
        recipient: 'xo',
        correlation_id: 'tm-self-pause-3',
        subject_key: 'taskmaster:self-pause',
      })
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pause', status: 'done', task_outcome: 'succeeded' })
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

  test('judge outage holds the item instead of escalating to xo', async () => {
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

    expect(deps.createAuthenticatedMessage).not.toHaveBeenCalled();
    expect(deps.releaseMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'outage', worker_id: 'duty-officer-clock' })
    );
    expect(deps.postResult).not.toHaveBeenCalled();
  });
});
