import { describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { ReworkPullRequest } from '@archon/overseer/pr-rework';
import {
  createRealReworkWorkerDeps,
  tickReworkWorkerClock,
  type ReworkFireRequest,
  type ReworkWorkerDeps,
} from './rework-worker-clock';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

const OPEN_PR: ReworkPullRequest = {
  state: 'open',
  draft: false,
  baseRef: 'dev',
  headSha: HEAD,
  headRef: 'rework-branch',
  headRepoFullName: 'thinmansoftware/bdc-harness',
  labels: [],
};

function message(fencingToken = 0): DispatchMessage {
  return {
    id: 'rework-1',
    correlation_id: 'correlation-rework-1',
    idempotency_key: 'rework-rework-1',
    task_type: 'run_rework',
    sender: 'overseer-rework-route',
    sender_principal_id: null,
    recipient: 'overseer-rework',
    body: JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 730,
      headSha: HEAD,
      branch: 'rework-branch',
      baseRef: 'dev',
      woId: 'WO-1',
      project: 'bdc-harness',
      originatingRunId: 'run-1',
      reviewMessageId: 'review-1',
    }),
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: fencingToken,
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
    route_disposed_at: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

function workerStub(): Pick<
  ReworkWorkerDeps,
  | 'registerWorker'
  | 'heartbeatWorker'
  | 'listMessages'
  | 'getPullRequest'
  | 'getRepoBasePolicy'
  | 'hasActiveRun'
> {
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
    listMessages: mock(async () => [message()]),
    getPullRequest: mock(async () => OPEN_PR),
    getRepoBasePolicy: mock(() => ({ unattended: true, docsOnly: 'skip' })),
    hasActiveRun: mock(async () => false),
  };
}

describe('rework worker clock', () => {
  test('fails closed when the live PR base is production or unlisted', async () => {
    for (const liveBaseRef of ['main', 'release/unlisted']) {
      const item = message();
      const getRepoBasePolicy = mock((ownerRepo: string, baseRef: string) => {
        if (ownerRepo === 'thinmansoftware/bdc-harness' && baseRef === 'main') {
          return { unattended: false, docsOnly: 'skip' as const };
        }
        return undefined;
      });
      const deps = {
        ...workerStub(),
        getPullRequest: mock(async () => ({ ...OPEN_PR, baseRef: liveBaseRef })),
        getRepoBasePolicy,
        listMessages: mock(async () => [item]),
        claimMessage: mock(async ({ worker_id }) => ({
          ...item,
          status: 'claimed' as const,
          lease_owner: worker_id,
          fencing_token: item.fencing_token + 1,
        })),
        postResult: mock(async () => item),
        releaseMessage: mock(async () => item),
        deferMessage: mock(async () => item),
        fire: mock(async () => ({ status: 200, body: { runId: 'must-not-fire' } })),
        escalate: mock(async () => ({})),
        env: { ARCHON_OPERATOR_TOKEN: 'injected-token' },
      } as ReworkWorkerDeps & {
        getRepoBasePolicy: typeof getRepoBasePolicy;
      };

      await tickReworkWorkerClock(deps);

      expect(getRepoBasePolicy).toHaveBeenCalledWith('thinmansoftware/bdc-harness', liveBaseRef);
      expect(deps.postResult).toHaveBeenCalledWith(
        expect.objectContaining({
          fencing_token: 1,
          status: 'done',
          task_outcome: 'succeeded',
          result_body: JSON.stringify({ reason: 'production_or_unlisted_base' }),
        })
      );
      expect(deps.hasActiveRun).not.toHaveBeenCalled();
      expect(deps.fire).not.toHaveBeenCalled();
      expect(deps.releaseMessage).not.toHaveBeenCalled();
      expect(deps.deferMessage).not.toHaveBeenCalled();
      expect(deps.escalate).not.toHaveBeenCalled();
    }
  });

  test('sends the operator token from deps.env on the fire request', async () => {
    let seen: ReworkFireRequest | undefined;
    const item = message();
    const deps: ReworkWorkerDeps = {
      ...workerStub(),
      listMessages: mock(async () => [item]),
      claimMessage: mock(async ({ worker_id }) => ({
        ...item,
        status: 'claimed' as const,
        lease_owner: worker_id,
        fencing_token: item.fencing_token + 1,
      })),
      postResult: mock(async () => item),
      releaseMessage: mock(async () => item),
      deferMessage: mock(async () => item),
      fire: mock(async request => {
        seen = request;
        return { status: 200, body: { runId: 'run-fired' } };
      }),
      escalate: mock(async () => ({})),
      env: {
        ARCHON_API_BASE_URL: 'http://api.test',
        ARCHON_OPERATOR_TOKEN: 'injected-token',
      },
    };

    await tickReworkWorkerClock(deps);

    expect(seen?.headers['x-archon-operator-token']).toBe('injected-token');
    expect(seen?.url).toBe('http://api.test/api/workflows/bdc-feature-development-codex/run');
  });

  test('fire forwards request.headers to fetch', async () => {
    const original = globalThis.fetch;
    let seen: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.headers;
      return new Response(JSON.stringify({ runId: 'r1' }), { status: 200 });
    }) as typeof fetch;
    try {
      await createRealReworkWorkerDeps().fire({
        url: 'http://example.test/run',
        headers: {
          'content-type': 'application/json',
          'x-archon-operator-token': 'injected-token',
        },
        body: {
          conversationId: 'c',
          message: 'm',
          modelOverride: { nodes: {} },
        } as ReworkFireRequest['body'],
      });
      expect(seen).toEqual({
        'content-type': 'application/json',
        'x-archon-operator-token': 'injected-token',
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('releases the first two fire failures and fails closed on the third claim', async () => {
    const item = message(0);
    let storedToken = 0;
    const releases: number[] = [];
    const deps: ReworkWorkerDeps = {
      ...workerStub(),
      listMessages: mock(async () => [item]),
      claimMessage: mock(async ({ worker_id }) => {
        storedToken += 1;
        return {
          ...item,
          status: 'claimed' as const,
          lease_owner: worker_id,
          fencing_token: storedToken,
        };
      }),
      postResult: mock(async () => item),
      releaseMessage: mock(async input => {
        releases.push(input.fencing_token);
        return item;
      }),
      deferMessage: mock(async () => item),
      fire: mock(async () => ({ status: 500, body: { error: 'no' } })),
      escalate: mock(async () => ({})),
      env: { ARCHON_OPERATOR_TOKEN: 'injected-token' },
    };

    await tickReworkWorkerClock(deps);
    await tickReworkWorkerClock(deps);
    expect(releases).toEqual([1, 2]);
    expect(deps.postResult).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();

    await tickReworkWorkerClock(deps);

    expect(deps.releaseMessage).toHaveBeenCalledTimes(2);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        fencing_token: 3,
        status: 'failed',
        task_outcome: 'failed',
      })
    );
    expect(deps.escalate).toHaveBeenCalledTimes(1);
  });
});
