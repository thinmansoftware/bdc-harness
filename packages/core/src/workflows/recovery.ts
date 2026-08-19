import { existsSync } from 'fs';
import { resolve } from 'path';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { RunLeaseRecord } from '@archon/workflows/reliability/types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createLogger } from '@archon/paths';

const log = createLogger('workflow.recovery');

export type StartupRecoveryDisposition =
  | 'recoverable'
  | 'scope_authority_missing'
  | 'authority_conflict'
  | 'worktree_missing'
  | 'lease_race_lost';

export interface StartupRecoveryEntry {
  runId: string;
  disposition: StartupRecoveryDisposition;
}

export interface StartupRecoveryReport {
  observed: number;
  recoverable: number;
  interrupted: number;
  blocked: number;
  entries: StartupRecoveryEntry[];
}

export type PendingReconcileDisposition = 'orphaned' | 'cas_race_lost';

export interface PendingReconcileEntry {
  runId: string;
  disposition: PendingReconcileDisposition;
}

export interface PendingReconcileReport {
  observed: number;
  orphaned: number;
  raced: number;
  entries: PendingReconcileEntry[];
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Inspect expired run leases before dispatch admission. Observation is the default;
 * callers must explicitly request interruption after reviewing the same evidence.
 */
export async function reconcileExpiredWorkflowLeases(
  store: IWorkflowStore,
  options: {
    now: string;
    mode?: 'observe' | 'interrupt';
    pathExists?: (path: string) => boolean;
  }
): Promise<StartupRecoveryReport> {
  const pathExists = options.pathExists ?? existsSync;
  const candidates = await store.listExpiredRunLeases(options.now);
  const report: StartupRecoveryReport = {
    observed: candidates.length,
    recoverable: 0,
    interrupted: 0,
    blocked: 0,
    entries: [],
  };

  for (const candidate of candidates) {
    const authority = await store.getRunAuthority(candidate.runId);
    let disposition: StartupRecoveryDisposition;
    if (!authority) {
      disposition = 'scope_authority_missing';
    } else if (
      !candidate.workingPath ||
      !samePath(candidate.workingPath, authority.worktreePath) ||
      authority.workflowName !== candidate.workflowName
    ) {
      disposition = 'authority_conflict';
    } else if (!pathExists(authority.worktreePath)) {
      disposition = 'worktree_missing';
    } else {
      disposition = 'recoverable';
    }

    if (disposition !== 'recoverable') {
      report.blocked += 1;
      report.entries.push({ runId: candidate.runId, disposition });
      continue;
    }

    report.recoverable += 1;
    if (options.mode === 'interrupt') {
      const interrupted = await store.interruptExpiredRunLease({
        runId: candidate.runId,
        leaseToken: candidate.leaseToken,
        expiredAt: options.now,
        interruptedAt: options.now,
      });
      if (interrupted) {
        report.interrupted += 1;
      } else {
        disposition = 'lease_race_lost';
        report.blocked += 1;
      }
    }
    report.entries.push({ runId: candidate.runId, disposition });
  }
  return report;
}

export async function reconcilePendingWorkflowRunsAtBoot(
  store: IWorkflowStore,
  options: { now: string }
): Promise<PendingReconcileReport> {
  const candidates = await store.listPendingWorkflowRunsBefore(options.now);
  const report: PendingReconcileReport = {
    observed: candidates.length,
    orphaned: 0,
    raced: 0,
    entries: [],
  };
  const reason = 'pending_run_predates_orchestrator_boot';

  for (const candidate of candidates) {
    const orphaned = await store.orphanPendingWorkflowRun({
      runId: candidate.id,
      reason,
      orphanedAt: options.now,
    });
    if (!orphaned) {
      report.raced += 1;
      report.entries.push({ runId: candidate.id, disposition: 'cas_race_lost' });
      continue;
    }

    report.orphaned += 1;
    report.entries.push({ runId: candidate.id, disposition: 'orphaned' });
    await store.createWorkflowEvent({
      workflow_run_id: candidate.id,
      event_type: 'workflow_orphaned',
      data: {
        reason,
        orphaned_at: options.now,
        previous_status: 'pending',
      },
    });
  }

  log.info(report, 'orchestrator_boot_reconcile');
  return report;
}

export async function reconcileRunningWorkflowRunsAtBoot(
  store: IWorkflowStore,
  options: { now: string }
): Promise<PendingReconcileReport> {
  const candidates = await store.listStaleRunningWorkflowRunsBefore(options.now);
  const report: PendingReconcileReport = {
    observed: candidates.length,
    orphaned: 0,
    raced: 0,
    entries: [],
  };
  const reason = 'server_restart_orphaned';

  for (const candidate of candidates) {
    const failed = await store.failStaleRunningWorkflowRun({
      runId: candidate.id,
      reason,
      failedAt: options.now,
    });
    if (!failed) {
      report.raced += 1;
      report.entries.push({ runId: candidate.id, disposition: 'cas_race_lost' });
      continue;
    }

    report.orphaned += 1;
    report.entries.push({ runId: candidate.id, disposition: 'orphaned' });
    await store.createWorkflowEvent({
      workflow_run_id: candidate.id,
      event_type: 'workflow_orphaned',
      data: {
        reason,
        orphaned_at: options.now,
        previous_status: 'running',
      },
    });
  }

  log.info(report, 'orchestrator_boot_running_reconcile');
  return report;
}

/** Claim a released/expired lease before using the existing resume transition. */
export async function claimAndResumeInterruptedRun(
  store: IWorkflowStore,
  lease: RunLeaseRecord,
  pathExists: (path: string) => boolean = existsSync
): Promise<WorkflowRun | null> {
  const run = await store.getWorkflowRun(lease.runId);
  if (run?.status !== 'interrupted') return null;
  const authority = await store.getRunAuthority(lease.runId);
  if (
    !authority ||
    !run.working_path ||
    !samePath(run.working_path, authority.worktreePath) ||
    authority.workflowName !== run.workflow_name ||
    !pathExists(authority.worktreePath)
  ) {
    return null;
  }
  const claimed = await store.claimRunLease(lease);
  if (!claimed) return null;
  try {
    return await store.resumeWorkflowRun(lease.runId);
  } catch (error) {
    await store.releaseRunLease({
      runId: lease.runId,
      ownerId: lease.ownerId,
      leaseToken: lease.leaseToken,
      releasedAt: new Date().toISOString(),
    });
    throw error;
  }
}
