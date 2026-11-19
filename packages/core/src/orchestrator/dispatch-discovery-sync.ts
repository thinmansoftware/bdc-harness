/**
 * Sync a managed source clone to origin BEFORE workflows are discovered from it
 * (WO-HARNESS-A2-ENGAGES-ALL-REPOS-01).
 *
 * Workflow discovery overlays the codebase's `.archon/workflows/` (including the
 * deprecated `defaults/` folder bdc-harness carries in its own source) over the app
 * defaults. Discovering from a managed clone that is still one commit behind origin
 * loads the previous lane definition, so the first run fired after a merge to dev ran
 * the pre-merge lane (run 8849e767: discovery 3 seconds before the clone was reset).
 *
 * Only an Archon-managed clone (under the workspaces root) that IS the codebase's
 * default_cwd is hard-reset; a worktree or a locally registered repo is never touched.
 * A managed clone holding uncommitted changes or local commits not on origin is NEVER
 * reset: the reset is refused with an error log and discovery proceeds on the clone as
 * it is. The reset and the discovery read share one per-clone lock. Failure is
 * non-fatal: discovery proceeds against the local state, as it did before.
 */
import {
  syncWorkspace,
  toRepoPath,
  toBranchName,
  execFileAsync,
  getDefaultBranch,
} from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { loadRepoConfig } from '../config/config-loader';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.discovery-sync');
  return cachedLog;
}

/** Test hook: capture log calls without mocking modules. Pass undefined to restore. */
export function setDiscoverySyncLoggerForTest(
  logger: ReturnType<typeof createLogger> | undefined
): void {
  cachedLog = logger;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True when cwd is a managed clone: strictly inside the workspaces root. */
export function isManagedSourceClone(cwd: string): boolean {
  const root = norm(getArchonWorkspacesPath());
  const dir = norm(cwd);
  return dir.startsWith(`${root}/`);
}

/**
 * Per-clone-path async mutex (in-process). Only the archon server process dispatches
 * workflows against a managed source clone, so an in-process lock is sufficient; a
 * second dispatching process would need a file lock in the clone's .git dir.
 */
const cloneLocks = new Map<string, Promise<void>>();

async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloneLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  cloneLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (cloneLocks.get(key) === tail) cloneLocks.delete(key);
  }
}

async function gitOut(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { timeout: 30000 });
  return stdout.trim();
}

function countLines(out: string): number {
  return out === '' ? 0 : out.split('\n').length;
}

/**
 * The branch discovery syncs to and compares against: the repo's configured
 * `worktree.baseBranch` (the same config path isolation sync uses, see
 * configureIsolation in orchestrator.ts), else origin/HEAD via getDefaultBranch.
 * Resolved once per sync so the safety comparison and the reset target never diverge.
 */
export async function resolveDiscoveryBaseBranch(repo: string): Promise<string> {
  const config = await loadRepoConfig(repo);
  const configured = config?.worktree?.baseBranch?.trim();
  if (configured) return configured;
  return getDefaultBranch(toRepoPath(repo));
}

/**
 * Local state a hard reset would destroy: uncommitted changes (git status --porcelain)
 * or commits not on origin/<base branch>. Throws when the state cannot be read
 * (the caller treats that as unsafe and refuses).
 */
export async function localStateCounts(
  repo: string,
  baseBranch?: string
): Promise<{ dirtyEntries: number; unpushedCommits: number; branch: string }> {
  const dirtyEntries = countLines(await gitOut(repo, ['status', '--porcelain']));
  const branch = baseBranch ?? (await resolveDiscoveryBaseBranch(repo));
  const unpushedCommits = countLines(await gitOut(repo, ['rev-list', `origin/${branch}..HEAD`]));
  return { dirtyEntries, unpushedCommits, branch };
}

/**
 * Reset the managed source clone at `defaultCwd` to origin before discovery from
 * `workflowCwd`. A no-op (returns undefined) unless `workflowCwd` is the default_cwd
 * itself and it is a managed clone. REFUSES (error log with the counts, returns
 * undefined) when the clone has uncommitted changes or local commits not on origin.
 * Never throws. Callers that also read the clone use withSyncedManagedSource so the
 * reset and the read share one lock.
 */
export async function syncManagedSourceBeforeDiscovery(
  workflowCwd: string,
  defaultCwd: string | null | undefined
): Promise<WorkspaceSyncResult | undefined> {
  if (!defaultCwd || norm(workflowCwd) !== norm(defaultCwd)) return undefined;
  if (!isManagedSourceClone(defaultCwd)) return undefined;
  let baseBranch: string;
  try {
    baseBranch = await resolveDiscoveryBaseBranch(defaultCwd);
    const counts = await localStateCounts(defaultCwd, baseBranch);
    if (counts.dirtyEntries > 0 || counts.unpushedCommits > 0) {
      getLog().error(
        { repoPath: defaultCwd, ...counts },
        'discovery_sync.refused_local_state: managed source clone has uncommitted changes or local commits not on origin; NOT resetting, discovering from the clone as it is'
      );
      return undefined;
    }
  } catch (error) {
    getLog().error(
      { err: error as Error, repoPath: defaultCwd },
      'discovery_sync.refused_state_unreadable: cannot prove the clone is clean; NOT resetting'
    );
    return undefined;
  }
  try {
    const result = await syncWorkspace(toRepoPath(defaultCwd), toBranchName(baseBranch), {
      resetAfterFetch: true,
    });
    getLog().debug({ repoPath: defaultCwd, ...result }, 'discovery_sync.completed');
    return result;
  } catch (error) {
    getLog().warn({ err: error as Error, repoPath: defaultCwd }, 'discovery_sync.failed');
    return undefined;
  }
}

/**
 * Run `read` (workflow discovery) under one per-clone lock that also covers the
 * reset, so a second dispatch cannot reset the clone while the first is still reading
 * its workflow YAML. Unmanaged paths run `read` without a lock.
 */
export async function withSyncedManagedSource<T>(
  workflowCwd: string,
  defaultCwd: string | null | undefined,
  read: () => Promise<T>
): Promise<T> {
  if (!defaultCwd || norm(workflowCwd) !== norm(defaultCwd) || !isManagedSourceClone(defaultCwd)) {
    return read();
  }
  return withCloneLock(norm(defaultCwd), async () => {
    await syncManagedSourceBeforeDiscovery(workflowCwd, defaultCwd);
    return read();
  });
}
