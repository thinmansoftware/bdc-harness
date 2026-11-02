import { describe, expect, mock, test } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { RunAuthorityRecord, RunLeaseRecord } from '@archon/workflows/reliability/types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  claimAndResumeInterruptedRun,
  reconcileExpiredWorkflowLeases,
  reconcilePendingWorkflowRunsAtBoot,
  reconcileRunningWorkflowRunsAtBoot,
} from './recovery';

const authority: RunAuthorityRecord = {
  runId: 'run-1',
  dispatchId: 'dispatch-1',
  woId: 'WO-1',
  specSource: 'spec.md',
  specRevision: '1',
  specHash: 'hash',
  workflowName: 'feature',
  codebaseId: 'codebase-1',
  canonicalRemote: 'origin',
  baseBranch: 'dev',
  baseSha: 'base',
  runScopeSha: 'scope',
  headBranch: 'work/run-1',
  worktreePath: 'C:/worktrees/run-1',
  workflowRevision: 'workflow',
  bundleRevision: 'bundle',
  engineRevision: 'engine',
  runtimeImageRevision: null,
  createdAt: '2026-07-09T18:00:00.000Z',
};

function recoveryStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    listExpiredRunLeases: mock(async () => [
      {
        runId: 'run-1',
        workflowName: 'feature',
        workingPath: 'C:/worktrees/run-1',
        ownerId: 'worker-old',
        leaseToken: 'token-old',
        expiresAt: '2026-07-09T19:00:00.000Z',
      },
    ]),
    getRunAuthority: mock(async () => authority),
    interruptExpiredRunLease: mock(async () => true),
    ...overrides,
  } as IWorkflowStore;
}

const pendingRun: WorkflowRun = {
  id: 'run-pending-1',
  workflow_name: 'feature',
  conversation_id: 'conversation-1',
  parent_conversation_id: null,
  codebase_id: 'codebase-1',
  status: 'pending',
  user_message: 'build it',
  metadata: {},
  started_at: new Date('2026-07-13T17:46:29.000Z'),
  completed_at: null,
  last_activity_at: new Date('2026-07-13T17:46:29.000Z'),
  working_path: null,
  archived_at: null,
  archived_by: null,
  archive_reason: null,
};
const runningRun: WorkflowRun = { ...pendingRun, id: 'run-running-1', status: 'running' };

describe('startup lease reconciliation', () => {
  test('observe mode verifies authority and worktree without mutating state', async () => {
    const store = recoveryStore();
    const report = await reconcileExpiredWorkflowLeases(store, {
      now: '2026-07-09T20:00:00.000Z',
      pathExists: () => true,
    });

    expect(report).toEqual({
      observed: 1,
      recoverable: 1,
      interrupted: 0,
      blocked: 0,
      entries: [{ runId: 'run-1', disposition: 'recoverable' }],
    });
    expect(store.interruptExpiredRunLease).not.toHaveBeenCalled();
  });

  test('interrupt mode refuses missing worktrees', async () => {
    const store = recoveryStore();
    const report = await reconcileExpiredWorkflowLeases(store, {
      now: '2026-07-09T20:00:00.000Z',
      mode: 'interrupt',
      pathExists: () => false,
    });

    expect(report.blocked).toBe(1);
    expect(report.entries[0]?.disposition).toBe('worktree_missing');
    expect(store.interruptExpiredRunLease).not.toHaveBeenCalled();
  });

  test('interrupt mode uses lease CAS so competing recovery mutates once', async () => {
    const interrupt = mock(async () => true);
    const store = recoveryStore({ interruptExpiredRunLease: interrupt });
    const first = await reconcileExpiredWorkflowLeases(store, {
      now: '2026-07-09T20:00:00.000Z',
      mode: 'interrupt',
      pathExists: () => true,
    });
    interrupt.mockResolvedValueOnce(false);
    const second = await reconcileExpiredWorkflowLeases(store, {
      now: '2026-07-09T20:00:00.000Z',
      mode: 'interrupt',
      pathExists: () => true,
    });

    expect(first.interrupted).toBe(1);
    expect(second.interrupted).toBe(0);
    expect(second.entries[0]?.disposition).toBe('lease_race_lost');
  });

  test('claims a new lease before invoking existing resume semantics', async () => {
    const lease: RunLeaseRecord = {
      runId: 'run-1',
      ownerId: 'worker-new',
      leaseToken: 'token-new',
      acquiredAt: '2026-07-09T20:00:00.000Z',
      lastHeartbeatAt: '2026-07-09T20:00:00.000Z',
      expiresAt: '2026-07-09T20:01:00.000Z',
      releasedAt: null,
    };
    const resumed = { id: 'run-1', status: 'running' };
    const store = recoveryStore({
      getWorkflowRun: mock(async () => ({
        ...resumed,
        workflow_name: 'feature',
        conversation_id: 'conversation-1',
        parent_conversation_id: null,
        codebase_id: 'codebase-1',
        user_message: 'resume',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: 'C:/worktrees/run-1',
        status: 'interrupted' as const,
      })),
      claimRunLease: mock(async () => lease),
      resumeWorkflowRun: mock(async () => resumed as never),
    });

    await expect(claimAndResumeInterruptedRun(store, lease, () => true)).resolves.toBe(resumed);
    expect(store.claimRunLease).toHaveBeenCalledWith(lease);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('releases the recovery lease when resume fails', async () => {
    const lease: RunLeaseRecord = {
      runId: 'run-1',
      ownerId: 'worker-new',
      leaseToken: 'token-new',
      acquiredAt: '2026-07-09T20:00:00.000Z',
      lastHeartbeatAt: '2026-07-09T20:00:00.000Z',
      expiresAt: '2026-07-09T20:01:00.000Z',
      releasedAt: null,
    };
    const releaseRunLease = mock(async () => true);
    const store = recoveryStore({
      getWorkflowRun: mock(async () => ({
        id: 'run-1',
        workflow_name: 'feature',
        conversation_id: 'conversation-1',
        parent_conversation_id: null,
        codebase_id: 'codebase-1',
        user_message: 'resume',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: 'C:/worktrees/run-1',
        status: 'interrupted' as const,
      })),
      claimRunLease: mock(async () => lease),
      resumeWorkflowRun: mock(async () => {
        throw new Error('resume failed');
      }),
      releaseRunLease,
    });

    await expect(claimAndResumeInterruptedRun(store, lease, () => true)).rejects.toThrow(
      'resume failed'
    );
    expect(releaseRunLease).toHaveBeenCalledWith({
      runId: lease.runId,
      ownerId: lease.ownerId,
      leaseToken: lease.leaseToken,
      releasedAt: expect.any(String),
    });
  });
});

describe('boot pending reconciliation', () => {
  test('orphans pending rows that predate boot and records an event', async () => {
    const store = recoveryStore({
      listPendingWorkflowRunsBefore: mock(async () => [pendingRun]),
      orphanPendingWorkflowRun: mock(async () => true),
      createWorkflowEvent: mock(async () => {}),
    });

    const report = await reconcilePendingWorkflowRunsAtBoot(store, {
      now: '2026-07-13T17:53:00.000Z',
    });

    expect(report).toEqual({
      observed: 1,
      orphaned: 1,
      raced: 0,
      entries: [{ runId: 'run-pending-1', disposition: 'orphaned' }],
    });
    expect(store.listPendingWorkflowRunsBefore).toHaveBeenCalledWith('2026-07-13T17:53:00.000Z');
    expect(store.orphanPendingWorkflowRun).toHaveBeenCalledWith({
      runId: 'run-pending-1',
      reason: 'pending_run_predates_orchestrator_boot',
      orphanedAt: '2026-07-13T17:53:00.000Z',
    });
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'run-pending-1',
      event_type: 'workflow_orphaned',
      data: {
        reason: 'pending_run_predates_orchestrator_boot',
        orphaned_at: '2026-07-13T17:53:00.000Z',
        previous_status: 'pending',
      },
    });
  });

  test('does not mutate when no pending rows predate the boot cutoff', async () => {
    const store = recoveryStore({
      listPendingWorkflowRunsBefore: mock(async () => []),
      orphanPendingWorkflowRun: mock(async () => true),
      createWorkflowEvent: mock(async () => {}),
    });

    await expect(
      reconcilePendingWorkflowRunsAtBoot(store, { now: '2026-07-13T17:53:00.000Z' })
    ).resolves.toMatchObject({ observed: 0, orphaned: 0 });
    expect(store.orphanPendingWorkflowRun).not.toHaveBeenCalled();
    expect(store.createWorkflowEvent).not.toHaveBeenCalled();
  });

  test('leaves running rows untouched because the DB candidate query is pending-only', async () => {
    const store = recoveryStore({
      listPendingWorkflowRunsBefore: mock(async () => []),
      orphanPendingWorkflowRun: mock(async () => true),
      createWorkflowEvent: mock(async () => {}),
    });

    await reconcilePendingWorkflowRunsAtBoot(store, { now: '2026-07-13T17:53:00.000Z' });
    expect(store.listPendingWorkflowRunsBefore).toHaveBeenCalledWith('2026-07-13T17:53:00.000Z');
    expect(store.orphanPendingWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('boot running reconciliation', () => {
  test.each(['no lease', 'expired lease'])(
    'fails a stale running row with %s immediately',
    async () => {
      const store = recoveryStore({
        listStaleRunningWorkflowRunsBefore: mock(async () => [runningRun]),
        failStaleRunningWorkflowRun: mock(async () => true),
        createWorkflowEvent: mock(async () => {}),
      });
      const now = '2026-07-13T17:53:00.000Z';

      const report = await reconcileRunningWorkflowRunsAtBoot(store, { now });

      expect(report).toMatchObject({ observed: 1, orphaned: 1, raced: 0 });
      expect(store.listStaleRunningWorkflowRunsBefore).toHaveBeenCalledWith(now);
      expect(store.failStaleRunningWorkflowRun).toHaveBeenCalledWith({
        runId: runningRun.id,
        reason: 'server_restart_orphaned',
        failedAt: now,
      });
      expect(store.createWorkflowEvent).toHaveBeenCalledWith({
        workflow_run_id: runningRun.id,
        event_type: 'workflow_orphaned',
        data: { reason: 'server_restart_orphaned', orphaned_at: now, previous_status: 'running' },
      });
    }
  );

  test('leaves a running row with a fresh lease untouched', async () => {
    const store = recoveryStore({
      listStaleRunningWorkflowRunsBefore: mock(async () => []),
      failStaleRunningWorkflowRun: mock(async () => true),
      createWorkflowEvent: mock(async () => {}),
    });

    await expect(
      reconcileRunningWorkflowRunsAtBoot(store, { now: '2026-07-13T17:53:00.000Z' })
    ).resolves.toMatchObject({ observed: 0, orphaned: 0 });
    expect(store.failStaleRunningWorkflowRun).not.toHaveBeenCalled();
    expect(store.createWorkflowEvent).not.toHaveBeenCalled();
  });
});
