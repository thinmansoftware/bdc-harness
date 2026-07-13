import {
  createWorkflowStore,
  reconcileExpiredWorkflowLeases,
  reconcilePendingWorkflowRunsAtBoot,
  type PendingReconcileReport,
  type StartupRecoveryReport,
} from '@archon/core';
import type { IWorkflowStore } from '@archon/workflows/store';

/** Observe restart recovery candidates before the server accepts new dispatch. */
export async function observeStartupRecovery(
  store: IWorkflowStore = createWorkflowStore(),
  now = new Date().toISOString()
): Promise<StartupRecoveryReport> {
  return reconcileExpiredWorkflowLeases(store, { now, mode: 'observe' });
}

/** Mark pending rows from before this boot as explicit orphaned runs. */
export async function reconcilePendingRunsAtBoot(
  store: IWorkflowStore = createWorkflowStore(),
  now = new Date().toISOString()
): Promise<PendingReconcileReport> {
  return reconcilePendingWorkflowRunsAtBoot(store, { now });
}
