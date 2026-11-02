import { randomUUID } from 'crypto';
import type { IWorkflowStore } from '../store';
import type { ScheduledProviderWaitRecord } from './types';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export interface ProviderWaitSchedulerResult {
  due: number;
  resumed: number;
  cancelled: number;
  deferred: number;
}

/**
 * Claim and wake due provider waits without owning workflow execution policy.
 * The injected resume callback re-loads the workflow, provider health, and node
 * capabilities at wake time. A cancellation observed before that callback wins.
 */
export async function processDueProviderWaits(
  store: IWorkflowStore,
  resume: (wait: ScheduledProviderWaitRecord) => Promise<void>,
  options: {
    ownerId: string;
    now?: () => Date;
    batchSize?: number;
    retryDelayMs?: number;
  }
): Promise<ProviderWaitSchedulerResult> {
  const now = options.now ?? ((): Date => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const claimedAt = now().toISOString();
  const waits = await store.listDueProviderWaits(claimedAt, batchSize);
  const result: ProviderWaitSchedulerResult = {
    due: waits.length,
    resumed: 0,
    cancelled: 0,
    deferred: 0,
  };

  for (const wait of waits) {
    const statusBeforeClaim = await store.getWorkflowRunStatus(wait.runId);
    if (statusBeforeClaim !== 'waiting_provider') {
      await store.cancelProviderWaits(wait.runId, now().toISOString());
      result.cancelled += 1;
      continue;
    }

    const claimToken = randomUUID();
    const claimed = await store.claimProviderWait({
      waitId: wait.waitId,
      ownerId: options.ownerId,
      claimToken,
      claimedAt,
    });
    if (!claimed) continue;

    // Cancellation may race the claim. Re-read after the CAS and never invoke
    // the resume callback unless the run is still explicitly waiting.
    const statusAfterClaim = await store.getWorkflowRunStatus(wait.runId);
    if (statusAfterClaim !== 'waiting_provider') {
      await store.cancelProviderWaits(wait.runId, now().toISOString());
      result.cancelled += 1;
      continue;
    }

    try {
      await resume(wait);
      const completed = await store.completeProviderWait({
        waitId: wait.waitId,
        claimToken,
        completedAt: now().toISOString(),
      });
      if (!completed) throw new Error(`provider_wait_complete_failed: ${wait.waitId}`);
      result.resumed += 1;
    } catch (error) {
      if (!store.releaseProviderWaitClaim) throw error;
      const released = await store.releaseProviderWaitClaim({
        waitId: wait.waitId,
        claimToken,
        resumeAt: new Date(now().getTime() + retryDelayMs).toISOString(),
      });
      if (!released) throw error;
      result.deferred += 1;
    }
  }

  return result;
}
