import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { Codebase } from '../types';

const mockLogger = createMockLogger();
const mockSyncWorkspace = mock(() =>
  Promise.resolve({
    branch: 'main',
    synced: true,
    previousHead: '11111111',
    newHead: '22222222',
    updated: true,
  })
);
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '33333333\n', stderr: '' }));
const mockToRepoPath = mock((p: string) => p);

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
}));

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  syncWorkspace: mockSyncWorkspace,
  toRepoPath: mockToRepoPath,
}));

const { syncCodebaseSourceClone } = await import('./codebase-sync');

function makeCodebase(default_cwd: string): Codebase {
  return {
    id: 'codebase-1',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo',
    default_cwd,
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('syncCodebaseSourceClone', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    mockSyncWorkspace.mockClear();
    mockExecFileAsync.mockClear();
    mockToRepoPath.mockClear();
    mockSyncWorkspace.mockResolvedValue({
      branch: 'main',
      synced: true,
      previousHead: '11111111',
      newHead: '22222222',
      updated: true,
    });
    mockExecFileAsync.mockResolvedValue({ stdout: '33333333\n', stderr: '' });
  });

  test('hard-resets managed clones under the Archon workspaces directory', async () => {
    const codebase = makeCodebase('/home/test/.archon/workspaces/owner/repo/source');

    const result = await syncCodebaseSourceClone(codebase);

    expect(mockSyncWorkspace).toHaveBeenCalledWith(codebase.default_cwd, undefined, {
      resetAfterFetch: true,
    });
    expect(result.definitionSourceSha).toBe('22222222');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1', isManagedClone: true }),
      'workspace.sync_completed'
    );
  });

  test('uses fetch-only mode for locally registered repos', async () => {
    const codebase = makeCodebase('/repos/owner/repo');

    await syncCodebaseSourceClone(codebase);

    expect(mockSyncWorkspace).toHaveBeenCalledWith(codebase.default_cwd, undefined, {
      resetAfterFetch: false,
    });
  });

  test('returns syncError and current clone HEAD when sync fails', async () => {
    const codebase = makeCodebase('/home/test/.archon/workspaces/owner/repo/source');
    mockSyncWorkspace.mockRejectedValueOnce(new Error('remote unavailable'));

    const result = await syncCodebaseSourceClone(codebase);

    expect(result.syncError).toBe('remote unavailable');
    expect(result.definitionSourceSha).toBe('33333333');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        codebaseId: 'codebase-1',
        definitionSourceSha: '33333333',
      }),
      'workspace.sync_failed'
    );
  });
});
