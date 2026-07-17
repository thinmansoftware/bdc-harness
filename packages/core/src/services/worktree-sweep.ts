import { readdir, stat, rename, mkdir, rm } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { execFileAsync, getWorktreeBase, pruneWorktrees, toRepoPath } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { listWorkflowRunsWithWorkingPath } from '../db/workflows';
import {
  getConversationsUsingEnv,
  listActiveEnvironmentsWithWorkingPath,
  updateStatus as updateEnvStatus,
} from '../db/isolation-environments';
import { getActiveSession } from '../db/sessions';

const HOURS_TO_MS = 60 * 60 * 1000;
const DAYS_TO_MS = 24 * HOURS_TO_MS;

// A 24h default gives a human a full day to inspect a failed run's worktree before it is reclaimed.
export const WORKTREE_SWEEP_GRACE_PERIOD_MS =
  parseInt(process.env.WORKTREE_SWEEP_GRACE_PERIOD_HOURS ?? '24', 10) * HOURS_TO_MS;

// How old an unmatched/env-only worktree dir must be before it is eligible for
// quarantine. Measured from the newest available age signal (see below) so an
// idle-looking dir that still has recent activity is never touched.
export const WORKTREE_ORPHAN_AGE_MS =
  parseInt(process.env.WORKTREE_ORPHAN_AGE_DAYS ?? '7', 10) * DAYS_TO_MS;

// How long a quarantined dir is retained before it is permanently deleted from
// the quarantine tree.
export const WORKTREE_QUARANTINE_RETENTION_DAYS = parseInt(
  process.env.WORKTREE_QUARANTINE_RETENTION_DAYS ?? '7',
  10
);

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

export interface WorktreeSweepEnv {
  id: string;
  working_path: string;
  created_by_platform: string | null;
  created_at: string | Date;
}

export type QuarantineClass = 'env-only' | 'unmatched';

export interface WorktreeSweepReport {
  scanned: number;
  removed: string[];
  skipped: { path: string; reason: string; runId?: string }[];
  orphaned: string[];
  quarantined: { path: string; quarantinePath: string; class: QuarantineClass; bytes: number }[];
  quarantineDeleted: { path: string; bytesFreed: number }[];
  errors: { path: string; error: string; runId?: string }[];
  bytesFreed: number;
}

export interface WorktreeSweepOptions {
  gracePeriodMs?: number;
  orphanAgeMs?: number;
  quarantineRetentionDays?: number;
  workspacesRoot?: string;
  quarantineRoot?: string;
  now?: Date;
  listRuns?: () => Promise<WorktreeSweepRun[]>;
  listActiveEnvs?: () => Promise<WorktreeSweepEnv[]>;
  hasActiveSessionForEnv?: (envId: string) => Promise<boolean>;
  getLastCommitTime?: (worktreePath: string) => Promise<Date | null>;
  markEnvDestroyed?: (envId: string) => Promise<void>;
  pruneCanonicalRepo?: (repoPath: string) => Promise<void>;
  destroyWorktree?: (worktreePath: string) => Promise<void>;
}

interface ScannedWorktreeDir {
  path: string;
  owner: string;
  repo: string;
}

function defaultWorkspacesRoot(): string {
  const { base } = getWorktreeBase(toRepoPath(process.cwd()));
  return dirname(dirname(dirname(base)));
}

// Quarantine root lives OUTSIDE workspaces/ so the scanner never re-scans it.
function defaultQuarantineRoot(workspacesRoot: string): string {
  return resolve(workspacesRoot, '..', 'worktree-quarantine');
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

async function listArchonWorktreeDirs(workspacesRoot: string): Promise<ScannedWorktreeDir[]> {
  if (!(await pathExists(workspacesRoot))) return [];

  const dirs: ScannedWorktreeDir[] = [];
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
        if (entry.isDirectory()) {
          dirs.push({ path: join(archonPath, entry.name), owner: owner.name, repo: repo.name });
        }
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

async function dirMtime(path: string): Promise<Date> {
  const info = await stat(path);
  return info.mtime;
}

function toDate(value: string | Date): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

// True if ANY conversation referencing the env still has an active session.
async function defaultHasActiveSessionForEnv(envId: string): Promise<boolean> {
  const conversationIds = await getConversationsUsingEnv(envId);
  for (const conversationId of conversationIds) {
    const session = await getActiveSession(conversationId);
    if (session) return true;
  }
  return false;
}

// Best-effort: newest commit timestamp in the worktree, or null when the dir is
// not a git repo / has no commits / git is unavailable.
async function defaultGetLastCommitTime(worktreePath: string): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'log', '-1', '--format=%cI'],
      { timeout: 10000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return toDate(trimmed);
  } catch {
    return null;
  }
}

async function defaultPruneCanonicalRepo(repoPath: string): Promise<void> {
  await pruneWorktrees(toRepoPath(repoPath));
}

function quarantineDateFolder(now: Date): string {
  // YYYY-MM-DD in UTC.
  return now.toISOString().slice(0, 10);
}

function parseDateFolder(name: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const parsed = new Date(`${name}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Move a worktree dir into the dated quarantine folder.
 * Returns the destination path. Same-filesystem rename (fast, atomic).
 */
async function moveToQuarantine(
  dir: ScannedWorktreeDir,
  quarantineRoot: string,
  now: Date
): Promise<string> {
  const dateFolder = join(quarantineRoot, quarantineDateFolder(now));
  await mkdir(dateFolder, { recursive: true });

  const baseName = `${dir.owner}__${dir.repo}__${basename(dir.path)}`;
  let dest = join(dateFolder, baseName);
  // Guard against same-day collisions on identical owner/repo/basename.
  let suffix = 1;
  while (await pathExists(dest)) {
    dest = join(dateFolder, `${baseName}-${suffix}`);
    suffix += 1;
  }

  await rename(dir.path, dest);
  return dest;
}

/**
 * Delete quarantine date-folders whose folder-name date is older than the
 * retention window. Returns the deleted folders with bytes freed.
 */
async function deleteExpiredQuarantine(
  quarantineRoot: string,
  retentionDays: number,
  now: Date
): Promise<{ path: string; bytesFreed: number }[]> {
  if (!(await pathExists(quarantineRoot))) return [];

  const deleted: { path: string; bytesFreed: number }[] = [];
  const retentionMs = retentionDays * DAYS_TO_MS;
  const entries = await readdir(quarantineRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderDate = parseDateFolder(entry.name);
    if (!folderDate) continue; // Not a dated folder -- leave it alone.
    const ageMs = now.getTime() - folderDate.getTime();
    if (ageMs > retentionMs) {
      const folderPath = join(quarantineRoot, entry.name);
      const bytes = await directorySize(folderPath);
      await rm(folderPath, { recursive: true, force: true });
      deleted.push({ path: folderPath, bytesFreed: bytes });
    }
  }
  return deleted;
}

export async function sweepTerminalWorkflowWorktrees(
  opts: WorktreeSweepOptions = {}
): Promise<WorktreeSweepReport> {
  const gracePeriodMs = opts.gracePeriodMs ?? WORKTREE_SWEEP_GRACE_PERIOD_MS;
  const orphanAgeMs = opts.orphanAgeMs ?? WORKTREE_ORPHAN_AGE_MS;
  const quarantineRetentionDays =
    opts.quarantineRetentionDays ?? WORKTREE_QUARANTINE_RETENTION_DAYS;
  const workspacesRoot = opts.workspacesRoot ?? defaultWorkspacesRoot();
  const quarantineRoot = opts.quarantineRoot ?? defaultQuarantineRoot(workspacesRoot);
  const now = opts.now ?? new Date();
  const listRuns = opts.listRuns ?? listWorkflowRunsWithWorkingPath;
  const listActiveEnvs = opts.listActiveEnvs ?? listActiveEnvironmentsWithWorkingPath;
  const hasActiveSessionForEnv = opts.hasActiveSessionForEnv ?? defaultHasActiveSessionForEnv;
  const getLastCommitTime = opts.getLastCommitTime ?? defaultGetLastCommitTime;
  const markEnvDestroyed =
    opts.markEnvDestroyed ??
    ((envId: string): Promise<void> => updateEnvStatus(envId, 'destroyed'));
  const pruneCanonicalRepo = opts.pruneCanonicalRepo ?? defaultPruneCanonicalRepo;
  const destroyWorktree = opts.destroyWorktree ?? defaultDestroyWorktree;

  const report: WorktreeSweepReport = {
    scanned: 0,
    removed: [],
    skipped: [],
    orphaned: [],
    quarantined: [],
    quarantineDeleted: [],
    errors: [],
    bytesFreed: 0,
  };

  const runs = await listRuns();
  const runsByPath = new Map<string, WorktreeSweepRun>();
  for (const run of runs) {
    if (run.working_path) runsByPath.set(resolve(run.working_path), run);
  }

  const envs = await listActiveEnvs();
  const envsByPath = new Map<string, WorktreeSweepEnv>();
  for (const env of envs) {
    if (env.working_path) envsByPath.set(resolve(env.working_path), env);
  }

  const worktreeDirs = await listArchonWorktreeDirs(workspacesRoot);
  report.scanned = worktreeDirs.length;

  for (const worktreeDir of worktreeDirs) {
    const dirPath = worktreeDir.path;
    const normalizedPath = resolve(dirPath);
    const run = runsByPath.get(normalizedPath);

    // -- MATCHED-RUN: predecessor behavior, unchanged. --
    if (run) {
      if (!isTerminalStatus(run.status)) {
        report.skipped.push({ path: dirPath, runId: run.id, reason: `status:${run.status}` });
        continue;
      }

      const ageMs = completedAtAgeMs(run.completed_at, now);
      if (ageMs === null) {
        report.skipped.push({ path: dirPath, runId: run.id, reason: 'missing_terminal_at' });
        continue;
      }
      if (ageMs < gracePeriodMs) {
        report.skipped.push({ path: dirPath, runId: run.id, reason: 'inside_grace_period' });
        continue;
      }

      try {
        const bytes = await directorySize(dirPath);
        await destroyWorktree(dirPath);
        report.removed.push(dirPath);
        report.bytesFreed += bytes;
        getLog().info(
          { worktreePath: dirPath, runId: run.id, bytesFreed: bytes },
          'worktree_sweep_removed'
        );
      } catch (error) {
        const err = error as Error;
        report.errors.push({ path: dirPath, runId: run.id, error: err.message });
        getLog().error(
          { err, worktreePath: dirPath, runId: run.id },
          'worktree_sweep_remove_failed'
        );
      }
      continue;
    }

    const env = envsByPath.get(normalizedPath);

    // -- ENV-ONLY: active env row, no run row. --
    if (env) {
      if (env.created_by_platform === 'telegram') {
        report.skipped.push({ path: dirPath, reason: 'telegram_env' });
        getLog().info({ worktreePath: dirPath, envId: env.id }, 'worktree_sweep_skip_telegram_env');
        continue;
      }

      let activeSession: boolean;
      try {
        activeSession = await hasActiveSessionForEnv(env.id);
      } catch (error) {
        const err = error as Error;
        report.errors.push({ path: dirPath, error: err.message });
        getLog().error(
          { err, worktreePath: dirPath, envId: env.id },
          'worktree_sweep_session_check_failed'
        );
        continue;
      }
      if (activeSession) {
        report.skipped.push({ path: dirPath, reason: 'active_session' });
        getLog().info(
          { worktreePath: dirPath, envId: env.id },
          'worktree_sweep_skip_active_session'
        );
        continue;
      }

      // Age from the NEWEST available signal -- conservative so a live dir is
      // never quarantined on a stale mtime alone.
      const signals: Date[] = [];
      const envCreatedAt = toDate(env.created_at);
      if (envCreatedAt) signals.push(envCreatedAt);
      try {
        const commitTime = await getLastCommitTime(dirPath);
        if (commitTime) signals.push(commitTime);
        signals.push(await dirMtime(dirPath));
      } catch (error) {
        const err = error as Error;
        report.errors.push({ path: dirPath, error: err.message });
        getLog().error(
          { err, worktreePath: dirPath, envId: env.id },
          'worktree_sweep_age_probe_failed'
        );
        continue;
      }
      const newest = signals.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
      const ageMs = now.getTime() - newest.getTime();
      if (ageMs <= orphanAgeMs) {
        report.skipped.push({ path: dirPath, reason: 'inside_orphan_age' });
        continue;
      }

      await quarantineOrphan(worktreeDir, 'env-only', {
        report,
        quarantineRoot,
        workspacesRoot,
        now,
        pruneCanonicalRepo,
        envId: env.id,
        markEnvDestroyed,
      });
      continue;
    }

    // -- UNMATCHED: no run row, no env row. --
    let mtime: Date;
    try {
      mtime = await dirMtime(dirPath);
    } catch (error) {
      const err = error as Error;
      report.errors.push({ path: dirPath, error: err.message });
      getLog().error({ err, worktreePath: dirPath }, 'worktree_sweep_age_probe_failed');
      continue;
    }
    const ageMs = now.getTime() - mtime.getTime();
    if (ageMs <= orphanAgeMs) {
      // Preserve predecessor behavior for young unmatched dirs: warn only.
      report.orphaned.push(dirPath);
      getLog().warn({ worktreePath: dirPath }, 'worktree_sweep_orphaned_worktree');
      continue;
    }

    await quarantineOrphan(worktreeDir, 'unmatched', {
      report,
      quarantineRoot,
      workspacesRoot,
      now,
      pruneCanonicalRepo,
    });
  }

  // Retention sweep of the quarantine tree.
  try {
    const deleted = await deleteExpiredQuarantine(quarantineRoot, quarantineRetentionDays, now);
    for (const entry of deleted) {
      report.quarantineDeleted.push(entry);
      report.bytesFreed += entry.bytesFreed;
      getLog().info(
        { quarantinePath: entry.path, bytesFreed: entry.bytesFreed },
        'worktree_sweep_quarantine_deleted'
      );
    }
  } catch (error) {
    const err = error as Error;
    report.errors.push({ path: quarantineRoot, error: err.message });
    getLog().error({ err, quarantineRoot }, 'worktree_sweep_quarantine_retention_failed');
  }

  getLog().info(
    {
      scanned: report.scanned,
      removed: report.removed.length,
      quarantined: report.quarantined.length,
      quarantineDeleted: report.quarantineDeleted.length,
      bytesFreed: report.bytesFreed,
      errors: report.errors.length,
      orphaned: report.orphaned.length,
    },
    'worktree_sweep_disk_report'
  );

  return report;
}

interface QuarantineContext {
  report: WorktreeSweepReport;
  quarantineRoot: string;
  workspacesRoot: string;
  now: Date;
  pruneCanonicalRepo: (repoPath: string) => Promise<void>;
  envId?: string;
  markEnvDestroyed?: (envId: string) => Promise<void>;
}

// Move a dir to quarantine, prune stale git metadata, and (env-only) mark the
// env destroyed so the DB stops pointing at the moved path.
async function quarantineOrphan(
  dir: ScannedWorktreeDir,
  cls: QuarantineClass,
  ctx: QuarantineContext
): Promise<void> {
  const { report, quarantineRoot, workspacesRoot, now, pruneCanonicalRepo } = ctx;
  try {
    const bytes = await directorySize(dir.path);
    const quarantinePath = await moveToQuarantine(dir, quarantineRoot, now);
    report.quarantined.push({ path: dir.path, quarantinePath, class: cls, bytes });
    getLog().info(
      { worktreePath: dir.path, quarantinePath, class: cls, bytes },
      'worktree_sweep_quarantined'
    );

    // A moved worktree leaves stale metadata in the canonical repo's
    // .git/worktrees/ -- prune it when the canonical clone is resolvable.
    const sourcePath = join(workspacesRoot, dir.owner, dir.repo, 'source');
    if (await pathExists(sourcePath)) {
      try {
        await pruneCanonicalRepo(sourcePath);
      } catch (error) {
        const err = error as Error;
        getLog().warn({ err, sourcePath, worktreePath: dir.path }, 'worktree_sweep_prune_failed');
      }
    } else {
      getLog().info(
        { sourcePath, worktreePath: dir.path },
        'worktree_sweep_prune_no_canonical_repo'
      );
    }

    // ENV-ONLY: stop the DB pointing at a path that no longer exists.
    if (cls === 'env-only' && ctx.envId && ctx.markEnvDestroyed) {
      await ctx.markEnvDestroyed(ctx.envId);
    }
  } catch (error) {
    const err = error as Error;
    report.errors.push({ path: dir.path, error: err.message });
    getLog().error({ err, worktreePath: dir.path, class: cls }, 'worktree_sweep_quarantine_failed');
  }
}
