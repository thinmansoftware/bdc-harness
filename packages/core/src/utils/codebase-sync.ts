import { createLogger, getArchonWorkspacesPath } from '@archon/paths';
import { execFileAsync, syncWorkspace, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import type { Codebase } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('codebase-sync');
  return cachedLog;
}

export interface CodebaseSourceCloneSyncResult {
  syncResult?: WorkspaceSyncResult;
  syncError?: string;
  definitionSourceSha?: string;
}

async function readCloneHead(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--short=8', 'HEAD'],
      {
        timeout: 10000,
      }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function definitionSourceShaFromSync(
  result: Pick<CodebaseSourceCloneSyncResult, 'syncResult' | 'definitionSourceSha'>
): string | undefined {
  return (
    result.definitionSourceSha ||
    result.syncResult?.newHead ||
    result.syncResult?.previousHead ||
    undefined
  );
}

/**
 * Sync the canonical source clone before resolving workflow definitions.
 *
 * This preserves the existing discoverAllWorkflows behavior: managed Archon
 * clones are fetch+reset, locally registered repos are fetch-only, and sync
 * failures are non-fatal.
 */
export async function syncCodebaseSourceClone(
  codebase: Codebase
): Promise<CodebaseSourceCloneSyncResult> {
  const repoPath = codebase.default_cwd;
  const isManagedClone = repoPath
    .replace(/\\/g, '/')
    .startsWith(getArchonWorkspacesPath().replace(/\\/g, '/'));

  try {
    const syncResult = await syncWorkspace(toRepoPath(repoPath), undefined, {
      resetAfterFetch: isManagedClone,
    });
    const definitionSourceSha =
      syncResult.newHead || syncResult.previousHead || (await readCloneHead(repoPath));
    getLog().debug(
      {
        codebaseId: codebase.id,
        repoPath,
        isManagedClone,
        definitionSourceSha,
        ...syncResult,
      },
      'workspace.sync_completed'
    );
    return { syncResult, definitionSourceSha };
  } catch (err) {
    const error = err as Error;
    const definitionSourceSha = await readCloneHead(repoPath);
    getLog().warn(
      { err: error, codebaseId: codebase.id, repoPath, definitionSourceSha },
      'workspace.sync_failed'
    );
    return { syncError: error.message, definitionSourceSha };
  }
}
