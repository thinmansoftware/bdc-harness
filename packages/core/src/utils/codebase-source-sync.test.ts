import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { Codebase } from '../types';

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
}));

import * as git from '@archon/git';
import { syncCodebaseSourceClone } from './codebase-source-sync';

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
  let syncWorkspaceSpy: ReturnType<typeof spyOn>;
  let execFileAsyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    syncWorkspaceSpy = spyOn(git, 'syncWorkspace').mockResolvedValue({
      branch: 'main',
      synced: true,
      previousHead: 'aaaa1111',
      newHead: 'bbbb2222',
      updated: true,
    });
    execFileAsyncSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
      stdout: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222\n',
      stderr: '',
    });
  });

  afterEach(() => {
    syncWorkspaceSpy.mockRestore();
    execFileAsyncSpy.mockRestore();
  });

  test('hard-resets managed clones before discovery', async () => {
    const codebase = makeCodebase('/home/test/.archon/workspaces/owner/repo/source');

    const result = await syncCodebaseSourceClone(codebase);

    expect(syncWorkspaceSpy).toHaveBeenCalledWith(codebase.default_cwd, undefined, {
      resetAfterFetch: true,
    });
    expect(result.headSha).toBe('bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222');
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1', headSha: result.headSha }),
      'workspace.sync_completed'
    );
  });

  test('fetches without reset for unmanaged clones', async () => {
    const codebase = makeCodebase('/repos/owner/repo');

    await syncCodebaseSourceClone(codebase);

    expect(syncWorkspaceSpy).toHaveBeenCalledWith('/repos/owner/repo', undefined, {
      resetAfterFetch: false,
    });
  });

  test('returns syncError and logs warn with clone HEAD when sync fails', async () => {
    const codebase = makeCodebase('/repos/owner/repo');
    syncWorkspaceSpy.mockRejectedValueOnce(new Error('Network timeout'));
    execFileAsyncSpy.mockResolvedValueOnce({
      stdout: 'currentheadcurrentheadcurrentheadcurrenthead1234\n',
      stderr: '',
    });

    const result = await syncCodebaseSourceClone(codebase);

    expect(result).toEqual({
      syncError: 'Network timeout',
      headSha: 'currentheadcurrentheadcurrentheadcurrenthead1234',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        codebaseId: 'codebase-1',
        repoPath: '/repos/owner/repo',
        headSha: 'currentheadcurrentheadcurrentheadcurrenthead1234',
      }),
      'workspace.sync_failed'
    );
  });

  test('uses null headSha when HEAD cannot be read', async () => {
    const codebase = makeCodebase('/repos/owner/repo');
    execFileAsyncSpy.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await syncCodebaseSourceClone(codebase);

    expect(result.headSha).toBeNull();
  });
});
