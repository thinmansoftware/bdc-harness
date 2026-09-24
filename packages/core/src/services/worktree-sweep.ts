import { cp, mkdir, readdir, rename, rm, stat } from 'fs/promises';
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
  hasUncommittedWorkFn?: (worktreePath: string) => Promise<boolean>;
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

/**
 * Reliable "genuine work" signal: `git status --porcelain --untracked-files=all`.
 *
 * Directory mtime says a worktree was TOUCHED; git status says it HOLDS WORK.
 * Any non-empty output -- modified tracked files, staged-but-uncommitted changes,
 * or untracked files -- means a human or an agent left something in this worktree
 * that exists nowhere else, and reclaiming it would destroy that work no matter how
 * old the last commit or the env row is.
 *
 * Stashes are deliberately NOT consulted: `refs/stash` is repository-wide, not
 * per-worktree, so one stash anywhere in the repo would preserve every worktree of
 * that repo forever and reintroduce the never-sweep bug this file exists to fix.
 */
async function defaultHasUncommittedWork(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'],
    { timeout: 30000 }
  );
  return stdout.trim().length > 0;
}

type UncommittedWorkVerdict =
  | { preserve: false }
  | { preserve: true; reason: 'has_uncommitted_work' | 'dirty_check_failed'; error?: string };

/**
 * Wraps the dirty check so that FAILURE TO DETERMINE dirtiness fails safe toward
 * preservation. A corrupt worktree, a missing gitdir, a git timeout -- none of
 * these prove the tree is clean, so none of them may authorize reclamation. The
 * only path to "reclaim" is a successful git status that returns nothing.
 */
async function checkUncommittedWork(
  worktreePath: string,
  hasUncommittedWorkFn: (worktreePath: string) => Promise<boolean>
): Promise<UncommittedWorkVerdict> {
  try {
    if (await hasUncommittedWorkFn(worktreePath)) {
      return { preserve: true, reason: 'has_uncommitted_work' };
    }
    return { preserve: false };
  } catch (error) {
    const err = error as Error;
    return { preserve: true, reason: 'dirty_check_failed', error: err.message };
  }
}

/**
 * Decide the age of a worktree using DURABLE evidence only, never directory mtime.
 *
 * Directory mtime is not evidence of real activity: a git operation, a container
 * restart, a filesystem scan, or any stray write refreshes it, which can make a
 * months-dead worktree look brand new forever (the 2026-09-22 production incident --
 * 70 worktrees scanned, 0 reclaimed, every one skipped with `env_inside_orphan_age`
 * because dirStat.mtime kept outvoting the real signals).
 *
 * Precedence, most trustworthy first:
 *   1. Last commit date -- real work happened, verified via git log.
 *   2. Env row's created_at -- the environment is provably that old at minimum.
 * If NEITHER exists (no commits ever made, no env row at all -- the "no-git"
 * class from the incident), there is no durable signal: treat the worktree as
 * having no recorded activity (returns null), which callers must treat as
 * immediately eligible for reclamation once the active-session check has
 * already cleared it. Directory mtime never participates in this decision --
 * it cannot resurrect a dead worktree, and it cannot preserve one either.
 */
function durableActivityDate(lastCommitDate: Date | null, envCreatedAt: Date | null): Date | null {
  return newestDate(lastCommitDate, envCreatedAt);
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

/** Options passed to fs.cp when rename(2) fails with EXDEV (cross-mount move). */
const MOVE_DIR_CP_OPTIONS = {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
  errorOnExist: true,
  force: false,
} as const;

export interface MoveDirAcrossDevicesDeps {
  rename: (from: string, to: string) => Promise<void>;
  cp: (
    from: string,
    to: string,
    options: {
      recursive: true;
      preserveTimestamps: true;
      verbatimSymlinks: true;
      errorOnExist: true;
      force: false;
    }
  ) => Promise<void>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
}

/**
 * Thrown by moveDirAcrossDevices when `to` already exists at call time. There
 * is no safe move onto an occupied destination: the EXDEV fallback copies
 * then deletes, and if the destination already held unrelated content (a
 * name collision, or a retry landing on the same quarantine path a prior
 * attempt already partially populated), a failed copy's cleanup would delete
 * that pre-existing content, not just what this call wrote. Refusing up
 * front means the caller decides the collision, rather than this function
 * silently destroying data it did not create.
 */
export class MoveDirDestinationExistsError extends Error {
  constructor(public readonly path: string) {
    super(`worktree_sweep_move_dir_destination_exists: ${path}`);
    this.name = 'MoveDirDestinationExistsError';
  }
}

/**
 * Move a directory. rename(2) is used first. Between two mount points rename
 * returns EXDEV even when both mounts are the same filesystem type, so that
 * case copies then deletes the source. Any other rename error is rethrown.
 *
 * Before the EXDEV fallback touches `to`, it refuses to proceed if `to`
 * already exists (throws MoveDirDestinationExistsError) -- this call did not
 * create that content, so it must not be the one to delete it on a later
 * failure. Only once `to` is confirmed absent does this call "own" it: from
 * that point, if the copy fails, the destination this call created is
 * removed and the source is left in place. If that cleanup removal also
 * fails, the cleanup error is logged and the original copy error is still
 * rethrown.
 *
 * Default deps read the fs/promises bindings at call time so tests can spy on
 * rename without injecting moveDir into the sweep.
 */
export async function moveDirAcrossDevices(
  from: string,
  to: string,
  deps: MoveDirAcrossDevicesDeps = { rename, cp, rm }
): Promise<void> {
  try {
    await deps.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
  }

  if (await pathExists(to)) {
    throw new MoveDirDestinationExistsError(to);
  }

  try {
    await deps.cp(from, to, MOVE_DIR_CP_OPTIONS);
  } catch (cpError) {
    // `to` did not exist a moment ago (checked above) and cp failed, so
    // whatever now sits at `to` is only what THIS call's failed copy wrote --
    // safe to remove. errorOnExist means cp never partially overwrites
    // pre-existing content it did not itself create.
    try {
      await deps.rm(to, { recursive: true, force: true });
    } catch (rmError) {
      getLog().warn({ err: rmError, path: to }, 'worktree_sweep_partial_copy_cleanup_failed');
    }
    throw cpError;
  }

  await deps.rm(from, { recursive: true, force: true });
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
  const hasUncommittedWorkFn = opts.hasUncommittedWorkFn ?? defaultHasUncommittedWork;
  const getCanonicalRepoPathFn =
    opts.getCanonicalRepoPathFn ??
    ((path: string): Promise<string> => getCanonicalRepoPath(toWorktreePath(path)));
  const moveDir = opts.moveDir ?? moveDirAcrossDevices;
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
        // Directory mtime deliberately does NOT participate here -- see durableActivityDate().
        // A no-git worktree with no commits falls back to envCreatedAt, which is still real
        // evidence (the environment row itself has a provable creation time); only in the
        // theoretical case where neither exists does this collapse to "no evidence", and an
        // absent active session (already checked above) means it is immediately reclaimable.
        const activityDate = durableActivityDate(lastCommitDate, envCreatedAt);
        const ageMs = activityDate ? now.getTime() - activityDate.getTime() : Infinity;
        if (ageMs <= orphanAgeMs) {
          report.skipped.push({ path: worktreeDir, reason: 'env_inside_orphan_age' });
          getLog().warn(
            { worktreePath: worktreeDir, envId: env.id, reason: 'env_inside_orphan_age' },
            'worktree_sweep_env_only_skipped'
          );
          continue;
        }

        // Age says reclaim and no session owns it -- but session absence does not prove
        // the tree holds no work. Genuine uncommitted changes (modified, staged, or
        // untracked files) are valuable regardless of commit age and must be preserved.
        // Only a clean tree, proven by a successful git status, may be reclaimed.
        const workVerdict = await checkUncommittedWork(worktreeDir, hasUncommittedWorkFn);
        if (workVerdict.preserve) {
          const reason = `env_${workVerdict.reason}`;
          report.skipped.push({ path: worktreeDir, reason });
          getLog().warn(
            {
              worktreePath: worktreeDir,
              envId: env.id,
              reason,
              ...(workVerdict.error ? { error: workVerdict.error } : {}),
            },
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

      // No run row AND no env row: Archon's own bookkeeping has nothing on this
      // worktree at all, so there is no created_at to prove how old it is. This is
      // also the window a worktree sits in while it is still being provisioned --
      // checked out (possibly at an OLD commit) but its env/run row not yet written.
      // Judging it by commit date alone would quarantine it mid-provision, so here
      // directory mtime DOES participate: the worktree is as recent as the newest of
      // its last commit and its mtime. mtime only ever makes an unmatched worktree
      // look newer, never older, and the uncommitted-work guard below still applies
      // once it does age out. The env-backed path above keeps mtime out because it
      // has created_at as durable evidence (the actual 2026-09-22 incident class).
      const lastCommitDate = await getWorktreeLastCommitDate(worktreeDir, getLastCommitDateFn);
      const activityDate = newestDate(lastCommitDate, dirStat.mtime) ?? dirStat.mtime;
      if (now.getTime() - activityDate.getTime() <= orphanAgeMs) {
        report.orphaned.push(worktreeDir);
        getLog().warn({ worktreePath: worktreeDir }, 'worktree_sweep_orphaned_worktree');
        continue;
      }

      // Same rule as the env-backed path: old is not the same as empty. A worktree
      // Archon has no record of can still hold someone's uncommitted work.
      const workVerdict = await checkUncommittedWork(worktreeDir, hasUncommittedWorkFn);
      if (workVerdict.preserve) {
        const reason = `unmatched_${workVerdict.reason}`;
        report.orphaned.push(worktreeDir);
        report.skipped.push({ path: worktreeDir, reason });
        getLog().warn(
          {
            worktreePath: worktreeDir,
            reason,
            ...(workVerdict.error ? { error: workVerdict.error } : {}),
          },
          'worktree_sweep_orphaned_worktree'
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

  const reportPayload = {
    scanned: report.scanned,
    removed: report.removed.length,
    quarantined: report.quarantined.length,
    quarantineDeleted: report.quarantineDeleted.length,
    skipped: report.skipped.length,
    orphaned: report.orphaned.length,
    bytesFreed: report.bytesFreed,
    quarantinedBytes: report.quarantinedBytes,
    quarantineDeletedBytes: report.quarantineDeletedBytes,
    errors: report.errors.length,
  };

  // A sweep that scans real worktrees and reclaims nothing is a problem, not a clean
  // run -- surface it at warn so it does not read as routine success in the logs
  // (the exact shape of the 2026-09-22 incident: scanned:70, removed:0, quarantined:0,
  // bytesFreed:0, every one silently skipped).
  const didNothing =
    report.scanned > 0 &&
    report.removed.length === 0 &&
    report.quarantined.length === 0 &&
    report.bytesFreed === 0;

  if (didNothing) {
    getLog().warn(reportPayload, 'worktree_sweep_disk_report_noop');
  } else {
    getLog().info(reportPayload, 'worktree_sweep_disk_report');
  }

  return report;
}
