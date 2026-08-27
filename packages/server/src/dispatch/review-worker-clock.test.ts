import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import {
  startReviewWorkerClock,
  stopReviewWorkerClock,
  tickReviewWorkerClock,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

function message(id: string, headSha = `head-${id}`): DispatchMessage {
  return {
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `review-${id}`,
    task_type: 'run_review',
    sender: 'overseer-review-route',
    recipient: 'overseer-reviewer',
    body: JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 730,
      headSha,
      baseRef: 'dev',
      author: 'contributor',
    }),
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
    subject_key: 'gh:thinmansoftware/bdc-harness#730',
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

function fakeDeps(
  queued: DispatchMessage[],
  outcomeFor: (id: string) => SubmitOutcome = () => ({ disposition: 'approved' })
): ReviewWorkerDeps {
  const terminal = new Set<string>();
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
    listMessages: mock(async () => queued),
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
    runAndSubmitReview: mock(async work => outcomeFor(work.messageId)),
    createSubmitDeps: mock(() => ({ reviewerIdentity: CONFIG.reviewerIdentity }) as SubmitDeps),
  };
}

afterEach(() => stopReviewWorkerClock());

describe('review worker clock', () => {
  test('submits the queued exact head once and marks the item done', async () => {
    const queued = [message('one', 'exact-head')];
    const deps = fakeDeps(queued);

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'exact-head', messageId: 'one' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'one',
        fencing_token: 1,
        status: 'done',
        task_outcome: 'succeeded',
      })
    );
  });

  test('records a stale-head outcome as terminal without retrying submission', async () => {
    const deps = fakeDeps([message('stale', 'old-head')], () => ({
      disposition: 'stale_head',
      reason: 'head_advanced_during_review',
    }));

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', task_outcome: 'succeeded' })
    );
  });

  test('isolates a failed item and continues through the batch', async () => {
    const deps = fakeDeps([message('bad'), message('good')]);
    const originalClaim = deps.claimMessage;
    deps.claimMessage = mock(async input => {
      if (input.id === 'bad') throw new Error('claim failed');
      return originalClaim(input);
    }) as typeof deps.claimMessage;

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'good' }));
  });

  test('does not start when review route configuration is absent', async () => {
    const deps = fakeDeps([message('never')]);

    startReviewWorkerClock(null, deps);
    startReviewWorkerClock(undefined, deps);
    await Bun.sleep(5);

    expect(deps.registerWorker).not.toHaveBeenCalled();
  });
});
