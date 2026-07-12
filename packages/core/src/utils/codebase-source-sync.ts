import { getArchonWorkspacesPath, createLogger } from '@archon/paths';
import { execFileAsync, syncWorkspace, toRepoPath } from '@archon/git';
import type { WorkspaceSyncResult } from '@archon/git';
import type { Codebase } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('codebase-source-sync');
  return cachedLog;
}

export interface CodebaseSourceSyncResult {
  syncResult?: WorkspaceSyncResult;
  syncError?: string;
  headSha: string | null;
}

async function getCloneHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function isManagedClone(repoPath: string): boolean {
  const normalizedRepoPath = repoPath.replace(/\\/g, '/');
  const normalizedManagedRoot = getArchonWorkspacesPath().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedRepoPath.startsWith(`${normalizedManagedRoot}/`);
}

export async function syncCodebaseSourceClone(
  codebase: Codebase
): Promise<CodebaseSourceSyncResult> {
  const repoPath = codebase.default_cwd;
  const managedClone = isManagedClone(repoPath);

  try {
    const syncResult = await syncWorkspace(toRepoPath(repoPath), undefined, {
      resetAfterFetch: managedClone,
    });
    const headSha = await getCloneHeadSha(repoPath);
    getLog().debug(
      {
        codebaseId: codebase.id,
        repoPath,
        isManagedClone: managedClone,
        headSha,
        ...syncResult,
      },
      'workspace.sync_completed'
    );
    return { syncResult, headSha };
  } catch (err) {
    const error = err as Error;
    const headSha = await getCloneHeadSha(repoPath);
    getLog().warn(
      {
        err: error,
        codebaseId: codebase.id,
        repoPath,
        isManagedClone: managedClone,
        headSha,
      },
      'workspace.sync_failed'
    );
    return { syncError: error.message, headSha };
  }
}
