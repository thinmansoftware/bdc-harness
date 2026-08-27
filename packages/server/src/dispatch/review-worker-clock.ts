import {
  claimMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  type DispatchTaskOutcome,
} from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';
import {
  createRealSubmitDeps,
  parseReviewWorkBody,
  REVIEW_RECIPIENT,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import {
  runAndSubmitReview,
  type ReviewWorkItem,
  type SubmitDisposition,
  type SubmitOutcome,
} from '@archon/overseer/pr-review-submit';

const log = createLogger('dispatch/review-worker-clock');
const REVIEW_WORKER_ID = 'overseer-review-worker';
const REVIEW_TASK_TYPE = 'run_review';
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export interface ReviewWorkerDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  runAndSubmitReview: typeof runAndSubmitReview;
  createSubmitDeps: (reviewerIdentity: string) => ReturnType<typeof createRealSubmitDeps>;
}

interface ResultMapping {
  status: 'done' | 'failed';
  task_outcome: DispatchTaskOutcome;
}

function mapSubmitOutcome(disposition: SubmitDisposition): ResultMapping {
  switch (disposition) {
    case 'approved':
    case 'changes_requested':
    case 'stale_head':
      return { status: 'done', task_outcome: 'succeeded' };
    case 'custody_conflict':
    case 'merge_custody_conflict':
      return { status: 'failed', task_outcome: 'blocked' };
    case 'reviewer_failed':
    case 'submission_failed':
      return { status: 'failed', task_outcome: 'failed' };
    default: {
      const exhaustive: never = disposition;
      throw new Error(`unknown_review_submit_disposition:${String(exhaustive)}`);
    }
  }
}

export function createRealReviewWorkerDeps(): ReviewWorkerDeps {
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    runAndSubmitReview,
    createSubmitDeps: createRealSubmitDeps,
  };
}

export async function tickReviewWorkerClock(
  config: ReviewRouteConfig,
  deps: ReviewWorkerDeps
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await deps.registerWorker({
      worker_id: REVIEW_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: [REVIEW_TASK_TYPE], principal: REVIEW_RECIPIENT },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: REVIEW_WORKER_ID, status: 'available' });

    // listMessages has no task_type filter. Restrict the recipient in SQL and
    // then filter its generic dispatch queue locally before claiming.
    const messages = (
      await deps.listMessages({ recipient: REVIEW_RECIPIENT, status: 'queued' })
    ).filter(message => message.task_type === REVIEW_TASK_TYPE);

    for (const message of messages) {
      try {
        const claimed = await deps.claimMessage({ id: message.id, worker_id: REVIEW_WORKER_ID });
        if (!claimed) continue;
        const body = parseReviewWorkBody(claimed.body);
        if (!body) throw new Error('invalid_review_work_body');
        const work: ReviewWorkItem = {
          correlationId: claimed.correlation_id,
          messageId: claimed.id,
          owner: body.owner,
          repo: body.repo,
          prNumber: body.prNumber,
          headSha: body.headSha,
          author: body.author,
        };
        const outcome: SubmitOutcome = await deps.runAndSubmitReview(
          work,
          deps.createSubmitDeps(config.reviewerIdentity)
        );
        const result = mapSubmitOutcome(outcome.disposition);
        await deps.postResult({
          id: claimed.id,
          worker_id: REVIEW_WORKER_ID,
          fencing_token: claimed.fencing_token,
          ...result,
          result_body: JSON.stringify(outcome),
        });
      } catch (error) {
        log.error({ err: error, messageId: message.id }, 'overseer_review_work_item_failed');
      }
    }
  } catch (error) {
    log.error({ err: error }, 'overseer_review_worker_tick_failed');
  } finally {
    inFlight = false;
  }
}

export function startReviewWorkerClock(
  config: ReviewRouteConfig | null | undefined,
  deps: ReviewWorkerDeps = createRealReviewWorkerDeps()
): void {
  if (!config || timer || process.env.NODE_ENV === 'test') return;
  void tickReviewWorkerClock(config, deps);
  const interval = Math.max(
    1_000,
    Number(process.env.OVERSEER_REVIEW_WORKER_INTERVAL_MS) || 60_000
  );
  timer = setInterval(() => void tickReviewWorkerClock(config, deps), interval);
  timer.unref?.();
}

export function stopReviewWorkerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
