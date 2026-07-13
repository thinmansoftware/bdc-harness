import { readdir, stat } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { getWorktreeBase, toRepoPath } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { listWorkflowRunsWithWorkingPath } from '../db/workflows';

const HOURS_TO_MS = 60 * 60 * 1000;

// A 24h default gives a human a full day to inspect a failed run's worktree before it is reclaimed.
export const WORKTREE_SWEEP_GRACE_PERIOD_MS =
  parseInt(process.env.WORKTREE_SWEEP_GRACE_PERIOD_HOURS ?? '24', 10) * HOURS_TO_MS;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-sweep');
  return cachedLog;
}

export interface WorktreeSweepRun {
  id: string;
  status: WorkflowRunStatus;
  working_path: string | null;
  completed_at: string | Date | null;
}

export interface WorktreeSweepReport {
  scanned: number;
  removed: string[];
  skipped: { path: string; reason: string; runId?: string }[];
  orphaned: string[];
  errors: { path: string; error: string; runId?: string }[];
  bytesFreed: number;
}

export interface WorktreeSweepOptions {
  gracePeriodMs?: number;
  workspacesRoot?: string;
  now?: Date;
  listRuns?: () => Promise<WorktreeSweepRun[]>;
  destroyWorktree?: (worktreePath: string) => Promise<void>;
}

function defaultWorkspacesRoot(): string {
  const { base } = getWorktreeBase(toRepoPath(process.cwd()));
  return dirname(dirname(dirname(base)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function listArchonWorktreeDirs(workspacesRoot: string): Promise<string[]> {
  if (!(await pathExists(workspacesRoot))) return [];

  const dirs: string[] = [];
  const owners = await readdir(workspacesRoot, { withFileTypes: true });
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    const ownerPath = join(workspacesRoot, owner.name);
    const repos = await readdir(ownerPath, { withFileTypes: true });
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      // Cleanup scope is the Cauldron-managed worktrees/archon subtree only.
      const archonPath = join(ownerPath, repo.name, 'worktrees', 'archon');
      if (!(await pathExists(archonPath))) continue;
      const entries = await readdir(archonPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.push(join(archonPath, entry.name));
      }
    }
  }
  return dirs;
}

async function directorySize(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;

  let total = info.size;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(childPath);
    } else {
      total += (await stat(childPath)).size;
    }
  }
  return total;
}

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_WORKFLOW_STATUSES.includes(status);
}

function completedAtAgeMs(completedAt: string | Date | null, now: Date): number | null {
  if (!completedAt) return null;
  const terminalAt = completedAt instanceof Date ? completedAt : new Date(completedAt);
  const timestamp = terminalAt.getTime();
  if (Number.isNaN(timestamp)) return null;
  return now.getTime() - timestamp;
}

async function defaultDestroyWorktree(worktreePath: string): Promise<void> {
  await getIsolationProvider().destroy(worktreePath, { force: true });
}

export async function sweepTerminalWorkflowWorktrees(
  opts: WorktreeSweepOptions = {}
): Promise<WorktreeSweepReport> {
  const gracePeriodMs = opts.gracePeriodMs ?? WORKTREE_SWEEP_GRACE_PERIOD_MS;
  const workspacesRoot = opts.workspacesRoot ?? defaultWorkspacesRoot();
  const now = opts.now ?? new Date();
  const listRuns = opts.listRuns ?? listWorkflowRunsWithWorkingPath;
  const destroyWorktree = opts.destroyWorktree ?? defaultDestroyWorktree;

  const report: WorktreeSweepReport = {
    scanned: 0,
    removed: [],
    skipped: [],
    orphaned: [],
    errors: [],
    bytesFreed: 0,
  };

  const runs = await listRuns();
  const runsByPath = new Map<string, WorktreeSweepRun>();
  for (const run of runs) {
    if (run.working_path) runsByPath.set(resolve(run.working_path), run);
  }

  const worktreeDirs = await listArchonWorktreeDirs(workspacesRoot);
  report.scanned = worktreeDirs.length;

  for (const worktreeDir of worktreeDirs) {
    const normalizedPath = resolve(worktreeDir);
    const run = runsByPath.get(normalizedPath);

    if (!run) {
      report.orphaned.push(worktreeDir);
      getLog().warn({ worktreePath: worktreeDir }, 'worktree_sweep_orphaned_worktree');
      continue;
    }

    if (!isTerminalStatus(run.status)) {
      report.skipped.push({ path: worktreeDir, runId: run.id, reason: `status:${run.status}` });
      continue;
    }

    const ageMs = completedAtAgeMs(run.completed_at, now);
    if (ageMs === null) {
      report.skipped.push({ path: worktreeDir, runId: run.id, reason: 'missing_terminal_at' });
      continue;
    }
    if (ageMs < gracePeriodMs) {
      report.skipped.push({ path: worktreeDir, runId: run.id, reason: 'inside_grace_period' });
      continue;
    }

    try {
      const bytes = await directorySize(worktreeDir);
      await destroyWorktree(worktreeDir);
      report.removed.push(worktreeDir);
      report.bytesFreed += bytes;
      getLog().info(
        { worktreePath: worktreeDir, runId: run.id, bytesFreed: bytes },
        'worktree_sweep_removed'
      );
    } catch (error) {
      const err = error as Error;
      report.errors.push({ path: worktreeDir, runId: run.id, error: err.message });
      getLog().error(
        { err, worktreePath: worktreeDir, runId: run.id },
        'worktree_sweep_remove_failed'
      );
    }
  }

  getLog().info(
    {
      scanned: report.scanned,
      removed: report.removed.length,
      bytesFreed: report.bytesFreed,
      errors: report.errors.length,
      orphaned: report.orphaned.length,
    },
    'worktree_sweep_disk_report'
  );

  return report;
}
