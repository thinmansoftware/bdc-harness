/**
 * Sync a codebase's persistent source clone with origin BEFORE workflow
 * definition resolution (WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01).
 *
 * Root cause anchor (run f29b04fa, 2026-07-11): dispatch resolved the DAG from
 * the persistent source clone before the clone was synced -- the sync ran
 * ~0.5s later during worktree creation -- so a stale definition could pair
 * with a fresh RUN_START_SHA. Calling this helper before
 * discoverWorkflowsWithConfig guarantees the resolved definition and the
 * worktree share one commit.
 *
 * Reuses syncWorkspace -- the SAME helper worktree creation and
 * discoverAllWorkflows use -- with the same managed-clone detection:
 * clones under ~/.archon/workspaces/ are hard-reset to origin, locally
 * registered repos get fetch-only so uncommitted work is never destroyed.
 *
 * Fail-open by design: a sync failure (offline, no remote) must never block
 * dispatch. The clone HEAD sha actually used for resolution is always
 * returned as evidence so DAG-vs-RUN_START_SHA divergence stays detectable.
 */
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { syncWorkspace, toRepoPath, execFileAsync } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('source-clone-sync');
  return cachedLog;
}

export interface SourceCloneSyncOutcome {
  /**
   * Full HEAD sha of the clone after the sync attempt -- the commit workflow
   * definitions will actually be resolved from. Undefined only if rev-parse
   * itself failed (e.g. path is not a git repository).
   */
  headSha?: string;
  /** Sync result when the sync succeeded. */
  syncResult?: WorkspaceSyncResult;
  /** Error message when the sync failed (dispatch proceeds on current contents). */
  syncError?: string;
}

/**
 * Fetch + reset the codebase source clone to its tracked branch, then report
 * the HEAD sha definitions will be resolved from. Never throws.
 */
export async function syncSourceCloneBeforeResolve(codebase: {
  id: string;
  default_cwd: string;
}): Promise<SourceCloneSyncOutcome> {
  let syncResult: WorkspaceSyncResult | undefined;
  let caughtError: Error | undefined;

  // Sync canonical source with remote before resolving workflow definitions.
  // Only hard-reset for Archon-managed clones (under ~/.archon/workspaces/).
  // Locally-registered repos get fetch-only to avoid destroying uncommitted work.
  // Non-fatal: if fetch fails (network, no remote), proceed with local state.
  try {
    const isManagedClone = codebase.default_cwd
      .replace(/\\/g, '/')
      .startsWith(getArchonWorkspacesPath().replace(/\\/g, '/'));
    syncResult = await syncWorkspace(toRepoPath(codebase.default_cwd), undefined, {
      resetAfterFetch: isManagedClone,
    });
    getLog().debug(
      {
        codebaseId: codebase.id,
        repoPath: codebase.default_cwd,
        isManagedClone,
        ...syncResult,
      },
      'workspace.sync_completed'
    );
  } catch (err) {
    caughtError = err as Error;
  }

  // Record the clone HEAD actually used for definition resolution (full sha)
  // so run events can evidence DAG-vs-RUN_START_SHA divergence.
  let headSha: string | undefined;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', codebase.default_cwd, 'rev-parse', 'HEAD'],
      {
        timeout: 10000,
      }
    );
    headSha = stdout.trim() || undefined;
  } catch (revParseError) {
    getLog().debug(
      { err: revParseError as Error, repoPath: codebase.default_cwd },
      'workspace.head_sha_read_failed'
    );
  }

  if (caughtError) {
    // Fail-open with evidence: WARN includes the clone HEAD dispatch will use.
    getLog().warn(
      { err: caughtError, codebaseId: codebase.id, repoPath: codebase.default_cwd, headSha },
      'workspace.sync_failed'
    );
    return { headSha, syncError: caughtError.message };
  }

  return { headSha, syncResult };
}
