import { expect, mock, test } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';

const reconcileExpiredWorkflowLeases = mock(async () => ({
  observed: 1,
  recoverable: 1,
  interrupted: 0,
  blocked: 0,
  entries: [{ runId: 'run-1', disposition: 'recoverable' as const }],
}));
const reconcilePendingWorkflowRunsAtBoot = mock(async () => ({
  observed: 1,
  orphaned: 1,
  raced: 0,
  entries: [{ runId: 'run-pending-1', disposition: 'orphaned' as const }],
}));

mock.module('@archon/core', () => ({
  createWorkflowStore: mock(() => ({})),
  reconcileExpiredWorkflowLeases,
  reconcilePendingWorkflowRunsAtBoot,
}));

const { observeStartupRecovery, reconcilePendingRunsAtBoot } =
  await import('./startup-reconciliation');

test('startup reconciliation is observe-only', async () => {
  const store = {} as IWorkflowStore;
  await expect(observeStartupRecovery(store, '2026-07-09T20:00:00.000Z')).resolves.toMatchObject({
    observed: 1,
    interrupted: 0,
  });
  expect(reconcileExpiredWorkflowLeases).toHaveBeenCalledWith(store, {
    now: '2026-07-09T20:00:00.000Z',
    mode: 'observe',
  });
});

test('startup pending reconciliation delegates to core boot reconcile', async () => {
  const store = {} as IWorkflowStore;
  await expect(
    reconcilePendingRunsAtBoot(store, '2026-07-13T17:53:00.000Z')
  ).resolves.toMatchObject({
    observed: 1,
    orphaned: 1,
  });
  expect(reconcilePendingWorkflowRunsAtBoot).toHaveBeenCalledWith(store, {
    now: '2026-07-13T17:53:00.000Z',
  });
});
