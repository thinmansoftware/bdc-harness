import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from 'bun:test';
import { join } from 'path';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
  getArchonHome: () => '/archon',
  getArchonWorkspacesPath: () => '/archon/workspaces',
  getArchonWorktreesPath: () => '/archon/worktrees',
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join('/archon/workspaces', owner, repo, 'worktrees'),
  isDocker: () => false,
}));

import * as git from '@archon/git';
import { createStageWorktree } from './stage-allocator';

const opts = {
  woId: 'WO-MULTI-001',
  stageId: 'backend',
  codebaseId: 'codebase-1',
  codebaseName: 'owner/repo',
  canonicalRepoPath: '/repos/repo',
  targetBranch: 'main',
};

describe('createStageWorktree authority and adoption', () => {
  let syncSpy: Mock<typeof git.syncWorkspace>;
  let existsSpy: Mock<typeof git.worktreeExists>;
  let ownershipSpy: Mock<typeof git.verifyWorktreeOwnership>;
  let listSpy: Mock<typeof git.listWorktrees>;
  let execSpy: Mock<typeof git.execFileAsync>;
  let mkdirSpy: Mock<typeof git.mkdirAsync>;

  beforeEach(() => {
    syncSpy = spyOn(git, 'syncWorkspace').mockResolvedValue({
      branch: 'main',
      synced: true,
      previousHead: 'before',
      newHead: 'after',
      updated: true,
    });
    existsSpy = spyOn(git, 'worktreeExists').mockResolvedValue(false);
    ownershipSpy = spyOn(git, 'verifyWorktreeOwnership').mockResolvedValue(undefined);
    listSpy = spyOn(git, 'listWorktrees').mockResolvedValue([]);
    execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (_file, args) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    mkdirSpy = spyOn(git, 'mkdirAsync').mockResolvedValue(undefined);
  });

  afterEach(() => {
    syncSpy.mockRestore();
    existsSpy.mockRestore();
    ownershipSpy.mockRestore();
    listSpy.mockRestore();
    execSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  test('fetches authority without hard-resetting the canonical checkout', async () => {
    const result = await createStageWorktree(opts);

    expect(syncSpy).toHaveBeenCalledWith('/repos/repo', 'main', { resetAfterFetch: false });
    expect(result.baseSha).toBe('a'.repeat(40));
  });

  test('adopts only an owned worktree on the exact deterministic branch', async () => {
    existsSpy.mockResolvedValue(true);
    const expectedPath = join('/archon/workspaces', 'owner', 'repo', 'worktrees', resultBranch());
    listSpy.mockResolvedValue([{ path: expectedPath, branch: resultBranch() }]);

    const result = await createStageWorktree(opts);

    expect(ownershipSpy).toHaveBeenCalledWith(expectedPath, '/repos/repo');
    expect(result.adopted).toBe(true);
    expect(result.branchName).toBe(resultBranch());
  });

  test('refuses a path that points at the wrong branch', async () => {
    existsSpy.mockResolvedValue(true);
    const expectedPath = join('/archon/workspaces', 'owner', 'repo', 'worktrees', resultBranch());
    listSpy.mockResolvedValue([{ path: expectedPath, branch: 'archon/another-stage' }]);

    await expect(createStageWorktree(opts)).rejects.toThrow('expected branch');
  });

  test('refuses a worktree path owned by a different canonical clone', async () => {
    existsSpy.mockResolvedValue(true);
    ownershipSpy.mockRejectedValue(
      new Error('Worktree belongs to a different clone (/repos/other-repo)')
    );

    await expect(createStageWorktree(opts)).rejects.toThrow('different clone');
    expect(listSpy).not.toHaveBeenCalled();
  });
});

function resultBranch(): string {
  return 'archon/WO-MULTI-001/backend';
}
