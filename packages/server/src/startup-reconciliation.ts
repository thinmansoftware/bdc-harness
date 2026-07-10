import {
  createWorkflowStore,
  reconcileExpiredWorkflowLeases,
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
