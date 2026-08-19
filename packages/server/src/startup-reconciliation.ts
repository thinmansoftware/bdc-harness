import {
  createWorkflowStore,
  reconcileExpiredWorkflowLeases,
  reconcilePendingWorkflowRunsAtBoot,
  reconcileRunningWorkflowRunsAtBoot,
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

/** Fail running rows from a previous server process unless a fresh lease owns them. */
export async function reconcileRunningRunsAtBoot(
  store: IWorkflowStore = createWorkflowStore(),
  now = new Date().toISOString()
): Promise<PendingReconcileReport> {
  return reconcileRunningWorkflowRunsAtBoot(store, { now });
}

/** Mark pending rows from before this boot as explicit orphaned runs. */
export async function reconcilePendingRunsAtBoot(
  store: IWorkflowStore = createWorkflowStore(),
  now = new Date().toISOString()
): Promise<PendingReconcileReport> {
  return reconcilePendingWorkflowRunsAtBoot(store, { now });
}
