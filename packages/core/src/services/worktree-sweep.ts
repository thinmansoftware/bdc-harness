import { mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, join, relative, resolve } from 'path';
import {
  execFileAsync,
  getCanonicalRepoPath,
  getLastCommitDate,
  getWorktreeBase,
  toRepoPath,
  toWorktreePath,
} from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { getActiveSession as defaultGetActiveSession } from '../db/sessions';
import {
  getConversationsUsingEnv as defaultGetConversationsUsingEnv,
  listActiveEnvironmentsForSweep,
  updateStatus as defaultUpdateEnvStatus,
} from '../db/isolation-environments';
import { listWorkflowRunsWithWorkingPath } from '../db/workflows';

const HOURS_TO_MS = 60 * 60 * 1000;
const DAYS_TO_MS = 24 * HOURS_TO_MS;

// A 24h default gives a human a full day to inspect a failed run's worktree before it is reclaimed.
export const WORKTREE_SWEEP_GRACE_PERIOD_MS =
  parseInt(process.env.WORKTREE_SWEEP_GRACE_PERIOD_HOURS ?? '24', 10) * HOURS_TO_MS;
export const WORKTREE_ORPHAN_AGE_MS =
  parseInt(process.env.WORKTREE_ORPHAN_AGE_DAYS ?? '7', 10) * DAYS_TO_MS;
export const WORKTREE_QUARANTINE_RETENTION_MS =
  parseInt(process.env.WORKTREE_QUARANTINE_RETENTION_DAYS ?? '7', 10) * DAYS_TO_MS;

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
  quarantined: string[];
  quarantineDeleted: string[];
  skipped: { path: string; reason: string; runId?: string }[];
  orphaned: string[];
  errors: { path: string; error: string; runId?: string }[];
  bytesFreed: number;
  quarantinedBytes: number;
  quarantineDeletedBytes: number;
}

export type WorktreeSweepEnvironment = Pick<
  IsolationEnvironmentRow,
  'id' | 'working_path' | 'created_by_platform' | 'created_at' | 'branch_name' | 'codebase_id'
>;

interface QuarantineResult {
  quarantinePath: string;
  bytes: number;
}

export interface WorktreeSweepOptions {
  gracePeriodMs?: number;
  orphanAgeMs?: number;
  quarantineRetentionMs?: number;
  workspacesRoot?: string;
  quarantineRoot?: string;
  now?: Date;
  listRuns?: () => Promise<WorktreeSweepRun[]>;
  listActiveEnvironments?: () => Promise<readonly WorktreeSweepEnvironment[]>;
  getConversationsUsingEnv?: (envId: string) => Promise<string[]>;
  getActiveSession?: (conversationId: string) => Promise<object | null>;
  updateEnvStatus?: (envId: string, status: 'active' | 'destroyed') => Promise<void>;
  getLastCommitDateFn?: (worktreePath: string) => Promise<Date | null>;
  getCanonicalRepoPathFn?: (worktreePath: string) => Promise<string>;
  moveDir?: (from: string, to: string) => Promise<void>;
  pruneWorktree?: (repoPath: string) => Promise<void>;
  removeQuarantineDir?: (path: string) => Promise<void>;
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

function defaultQuarantineRoot(workspacesRoot: string): string {
  return resolve(join(workspacesRoot, '..', 'worktree-quarantine'));
}

function quarantineDateFolder(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function quarantineLeafName(workspacesRoot: string, worktreePath: string): string {
  const parts = relative(workspacesRoot, worktreePath).split(/[\\/]+/);
  const owner = parts[0] || 'unknown-owner';
  const repo = parts[1] || 'unknown-repo';
  return `${owner}__${repo}__${basename(worktreePath)}`;
}

async function uniqueQuarantinePath(targetPath: string): Promise<string> {
  if (!(await pathExists(targetPath))) return targetPath;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = `${targetPath}-${suffix}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Unable to choose unique quarantine path for ${targetPath}`);
}

function newestDate(...dates: (Date | null)[]): Date | null {
  let newest: Date | null = null;
  for (const date of dates) {
    if (!date || Number.isNaN(date.getTime())) continue;
    if (!newest || date.getTime() > newest.getTime()) newest = date;
  }
  return newest;
}

async function getWorktreeLastCommitDate(
  worktreePath: string,
  getLastCommitDateFn: (worktreePath: string) => Promise<Date | null>
): Promise<Date | null> {
  try {
    return await getLastCommitDateFn(worktreePath);
  } catch (error) {
    getLog().warn({ err: error, worktreePath }, 'worktree_sweep_last_commit_date_lookup_failed');
    return null;
  }
}

async function hasActiveSessionForEnvironment(
  envId: string,
  getConversationsUsingEnv: (envId: string) => Promise<string[]>,
  getActiveSession: (conversationId: string) => Promise<object | null>
): Promise<boolean> {
  const conversationIds = await getConversationsUsingEnv(envId);
  for (const conversationId of conversationIds) {
    const session = await getActiveSession(conversationId);
    if (session) return true;
  }
  return false;
}

async function quarantineWorktreeDir(params: {
  workspacesRoot: string;
  quarantineRoot: string;
  worktreePath: string;
  now: Date;
  moveDir: (from: string, to: string) => Promise<void>;
  getCanonicalRepoPathFn: (worktreePath: string) => Promise<string>;
  pruneWorktree: (repoPath: string) => Promise<void>;
}): Promise<QuarantineResult> {
  const bytes = await directorySize(params.worktreePath);
  let repoPath: string | null = null;
  try {
    repoPath = await params.getCanonicalRepoPathFn(params.worktreePath);
  } catch (error) {
    getLog().warn(
      { err: error, worktreePath: params.worktreePath },
      'worktree_sweep_canonical_repo_lookup_failed'
    );
  }

  const targetDir = join(params.quarantineRoot, quarantineDateFolder(params.now));
  await mkdir(targetDir, { recursive: true });
  const quarantinePath = await uniqueQuarantinePath(
    join(targetDir, quarantineLeafName(params.workspacesRoot, params.worktreePath))
  );
  await params.moveDir(params.worktreePath, quarantinePath);

  if (repoPath) {
    try {
      await params.pruneWorktree(repoPath);
    } catch (error) {
      getLog().warn(
        { err: error, repoPath, worktreePath: params.worktreePath },
        'worktree_sweep_git_worktree_prune_failed'
      );
    }
  }

  return { quarantinePath, bytes };
}

async function deleteExpiredQuarantineDirs(params: {
  quarantineRoot: string;
  now: Date;
  retentionMs: number;
  removeQuarantineDir: (path: string) => Promise<void>;
  report: WorktreeSweepReport;
}): Promise<void> {
  if (!(await pathExists(params.quarantineRoot))) return;

  const entries = await readdir(params.quarantineRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderDate = new Date(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(folderDate.getTime())) continue;
    if (params.now.getTime() - folderDate.getTime() <= params.retentionMs) continue;

    const quarantinePath = join(params.quarantineRoot, entry.name);
    try {
      const bytes = await directorySize(quarantinePath);
      await params.removeQuarantineDir(quarantinePath);
      params.report.quarantineDeleted.push(quarantinePath);
      params.report.quarantineDeletedBytes += bytes;
      params.report.bytesFreed += bytes;
      getLog().info({ quarantinePath, bytesFreed: bytes }, 'worktree_sweep_quarantine_deleted');
    } catch (error) {
      const err = error as Error;
      params.report.errors.push({ path: quarantinePath, error: err.message });
      getLog().error({ err, quarantinePath }, 'worktree_sweep_quarantine_delete_failed');
    }
  }
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

async function defaultPruneWorktree(repoPath: string): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 30000 });
}

export async function sweepTerminalWorkflowWorktrees(
  opts: WorktreeSweepOptions = {}
): Promise<WorktreeSweepReport> {
  const gracePeriodMs = opts.gracePeriodMs ?? WORKTREE_SWEEP_GRACE_PERIOD_MS;
  const orphanAgeMs = opts.orphanAgeMs ?? WORKTREE_ORPHAN_AGE_MS;
  const quarantineRetentionMs = opts.quarantineRetentionMs ?? WORKTREE_QUARANTINE_RETENTION_MS;
  const workspacesRoot = opts.workspacesRoot ?? defaultWorkspacesRoot();
  const quarantineRoot = opts.quarantineRoot ?? defaultQuarantineRoot(workspacesRoot);
  const now = opts.now ?? new Date();
  const listRuns = opts.listRuns ?? listWorkflowRunsWithWorkingPath;
  const listActiveEnvironments = opts.listActiveEnvironments ?? listActiveEnvironmentsForSweep;
  const getConversationsUsingEnv = opts.getConversationsUsingEnv ?? defaultGetConversationsUsingEnv;
  const getActiveSession = opts.getActiveSession ?? defaultGetActiveSession;
  const updateEnvStatus = opts.updateEnvStatus ?? defaultUpdateEnvStatus;
  const getLastCommitDateFn =
    opts.getLastCommitDateFn ??
    ((path: string): Promise<Date | null> => getLastCommitDate(toWorktreePath(path)));
  const getCanonicalRepoPathFn =
    opts.getCanonicalRepoPathFn ??
    ((path: string): Promise<string> => getCanonicalRepoPath(toWorktreePath(path)));
  const moveDir = opts.moveDir ?? rename;
  const pruneWorktree = opts.pruneWorktree ?? defaultPruneWorktree;
  const removeQuarantineDir =
    opts.removeQuarantineDir ??
    (async (path: string): Promise<void> => {
      await rm(path, { recursive: true, force: true });
    });
  const destroyWorktree = opts.destroyWorktree ?? defaultDestroyWorktree;

  const report: WorktreeSweepReport = {
    scanned: 0,
    removed: [],
    quarantined: [],
    quarantineDeleted: [],
    skipped: [],
    orphaned: [],
    errors: [],
    bytesFreed: 0,
    quarantinedBytes: 0,
    quarantineDeletedBytes: 0,
  };

  await deleteExpiredQuarantineDirs({
    quarantineRoot,
    now,
    retentionMs: quarantineRetentionMs,
    removeQuarantineDir,
    report,
  });

  const [runs, environments] = await Promise.all([listRuns(), listActiveEnvironments()]);
  const runsByPath = new Map<string, WorktreeSweepRun>();
  for (const run of runs) {
    if (run.working_path) runsByPath.set(resolve(run.working_path), run);
  }
  const envsByPath = new Map<string, WorktreeSweepEnvironment>();
  for (const env of environments) {
    if (env.working_path) envsByPath.set(resolve(env.working_path), env);
  }

  const worktreeDirs = await listArchonWorktreeDirs(workspacesRoot);
  report.scanned = worktreeDirs.length;

  for (const worktreeDir of worktreeDirs) {
    const normalizedPath = resolve(worktreeDir);
    const run = runsByPath.get(normalizedPath);

    if (!run) {
      const env = envsByPath.get(normalizedPath);
      const dirStat = await stat(worktreeDir);

      if (env) {
        if (env.created_by_platform === 'telegram') {
          report.skipped.push({ path: worktreeDir, reason: 'env_platform:telegram' });
          getLog().warn(
            { worktreePath: worktreeDir, envId: env.id, reason: 'env_platform:telegram' },
            'worktree_sweep_env_only_skipped'
          );
          continue;
        }

        if (
          await hasActiveSessionForEnvironment(env.id, getConversationsUsingEnv, getActiveSession)
        ) {
          report.skipped.push({ path: worktreeDir, reason: 'env_has_active_session' });
          getLog().warn(
            { worktreePath: worktreeDir, envId: env.id, reason: 'env_has_active_session' },
            'worktree_sweep_env_only_skipped'
          );
          continue;
        }

        const lastCommitDate = await getWorktreeLastCommitDate(worktreeDir, getLastCommitDateFn);
        const envCreatedAt =
          env.created_at instanceof Date ? env.created_at : new Date(env.created_at);
        const newestActivity = newestDate(envCreatedAt, lastCommitDate, dirStat.mtime);
        const ageMs = newestActivity ? now.getTime() - newestActivity.getTime() : 0;
        if (ageMs <= orphanAgeMs) {
          report.skipped.push({ path: worktreeDir, reason: 'env_inside_orphan_age' });
          getLog().warn(
            { worktreePath: worktreeDir, envId: env.id, reason: 'env_inside_orphan_age' },
            'worktree_sweep_env_only_skipped'
          );
          continue;
        }

        try {
          const quarantine = await quarantineWorktreeDir({
            workspacesRoot,
            quarantineRoot,
            worktreePath: worktreeDir,
            now,
            moveDir,
            getCanonicalRepoPathFn,
            pruneWorktree,
          });
          try {
            await updateEnvStatus(env.id, 'destroyed');
            report.quarantined.push(quarantine.quarantinePath);
            report.quarantinedBytes += quarantine.bytes;
            getLog().info(
              {
                worktreePath: worktreeDir,
                quarantinePath: quarantine.quarantinePath,
                class: 'env-only',
                reason: 'older_than_orphan_age',
                envId: env.id,
                bytes: quarantine.bytes,
              },
              'worktree_sweep_quarantined_worktree'
            );
          } catch (error) {
            const err = error as Error;
            report.errors.push({ path: worktreeDir, error: err.message });
            getLog().error(
              { err, worktreePath: worktreeDir, envId: env.id },
              'worktree_sweep_env_status_update_failed'
            );
            try {
              await moveDir(quarantine.quarantinePath, worktreeDir);
              getLog().warn(
                {
                  worktreePath: worktreeDir,
                  quarantinePath: quarantine.quarantinePath,
                  envId: env.id,
                },
                'worktree_sweep_env_quarantine_rolled_back'
              );
            } catch (rollbackError) {
              const rollbackErr = rollbackError as Error;
              report.quarantined.push(quarantine.quarantinePath);
              report.quarantinedBytes += quarantine.bytes;
              report.errors.push({ path: quarantine.quarantinePath, error: rollbackErr.message });
              getLog().error(
                {
                  err: rollbackErr,
                  worktreePath: worktreeDir,
                  quarantinePath: quarantine.quarantinePath,
                  envId: env.id,
                },
                'worktree_sweep_env_quarantine_rollback_failed'
              );
            }
          }
        } catch (error) {
          const err = error as Error;
          report.errors.push({ path: worktreeDir, error: err.message });
          getLog().error(
            { err, worktreePath: worktreeDir, envId: env.id },
            'worktree_sweep_quarantine_failed'
          );
        }
        continue;
      }

      if (now.getTime() - dirStat.mtime.getTime() <= orphanAgeMs) {
        report.orphaned.push(worktreeDir);
        getLog().warn({ worktreePath: worktreeDir }, 'worktree_sweep_orphaned_worktree');
        continue;
      }

      try {
        const quarantine = await quarantineWorktreeDir({
          workspacesRoot,
          quarantineRoot,
          worktreePath: worktreeDir,
          now,
          moveDir,
          getCanonicalRepoPathFn,
          pruneWorktree,
        });
        report.quarantined.push(quarantine.quarantinePath);
        report.quarantinedBytes += quarantine.bytes;
        getLog().info(
          {
            worktreePath: worktreeDir,
            quarantinePath: quarantine.quarantinePath,
            class: 'unmatched',
            reason: 'older_than_orphan_age',
            bytes: quarantine.bytes,
          },
          'worktree_sweep_quarantined_worktree'
        );
      } catch (error) {
        const err = error as Error;
        report.orphaned.push(worktreeDir);
        report.errors.push({ path: worktreeDir, error: err.message });
        getLog().error({ err, worktreePath: worktreeDir }, 'worktree_sweep_quarantine_failed');
      }
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
      quarantined: report.quarantined.length,
      quarantineDeleted: report.quarantineDeleted.length,
      bytesFreed: report.bytesFreed,
      quarantinedBytes: report.quarantinedBytes,
      quarantineDeletedBytes: report.quarantineDeletedBytes,
      errors: report.errors.length,
      orphaned: report.orphaned.length,
    },
    'worktree_sweep_disk_report'
  );

  return report;
}
