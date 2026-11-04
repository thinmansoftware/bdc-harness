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
 * default_cwd is hard-reset; a worktree or a locally registered repo is never touched
 * (a reset would destroy uncommitted work). Failure is non-fatal: discovery proceeds
 * against the local state, as it did before.
 */
import { syncWorkspace, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import { createLogger, getArchonWorkspacesPath } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.discovery-sync');
  return cachedLog;
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
 * Reset the managed source clone at `defaultCwd` to origin before discovery from
 * `workflowCwd`. A no-op (returns undefined) unless `workflowCwd` is the default_cwd
 * itself and it is a managed clone. Never throws.
 */
export async function syncManagedSourceBeforeDiscovery(
  workflowCwd: string,
  defaultCwd: string | null | undefined
): Promise<WorkspaceSyncResult | undefined> {
  if (!defaultCwd || norm(workflowCwd) !== norm(defaultCwd)) return undefined;
  if (!isManagedSourceClone(defaultCwd)) return undefined;
  try {
    const result = await syncWorkspace(toRepoPath(defaultCwd), undefined, {
      resetAfterFetch: true,
    });
    getLog().debug({ repoPath: defaultCwd, ...result }, 'discovery_sync.completed');
    return result;
  } catch (error) {
    getLog().warn({ err: error as Error, repoPath: defaultCwd }, 'discovery_sync.failed');
    return undefined;
  }
}
