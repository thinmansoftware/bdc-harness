import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLogger } from '../test/mocks/logger';
import type {
  MoveDirAcrossDevicesDeps,
  WorktreeSweepEnvironment,
  WorktreeSweepRun,
} from './worktree-sweep';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

mock.module('@archon/git', () => ({
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
  getCanonicalRepoPath: mock(async (path: string) => path),
  getLastCommitDate: mock(async () => null),
  getWorktreeBase: () => ({
    base: '/unused/workspaces/owner/repo/worktrees',
    layout: 'workspace-scoped',
  }),
  toRepoPath: (path: string) => path,
}));

const mockDestroy = mock(async () => undefined);
mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));

const mockListWorkflowRunsWithWorkingPath = mock(async () => [] as WorktreeSweepRun[]);
mock.module('../db/workflows', () => ({
  listWorkflowRunsWithWorkingPath: mockListWorkflowRunsWithWorkingPath,
}));

const mockListActiveEnvironmentsForSweep = mock(async () => [] as WorktreeSweepEnvironment[]);
const mockGetConversationsUsingEnv = mock(async () => [] as string[]);
const mockUpdateEnvStatus = mock(async () => undefined);
mock.module('../db/isolation-environments', () => ({
  listActiveEnvironmentsForSweep: mockListActiveEnvironmentsForSweep,
  getConversationsUsingEnv: mockGetConversationsUsingEnv,
  updateStatus: mockUpdateEnvStatus,
}));

const mockGetActiveSession = mock(async () => null);
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
}));

import {
  MoveDirDestinationExistsError,
  moveDirAcrossDevices,
  sweepTerminalWorkflowWorktrees,
} from './worktree-sweep';

async function createWorktree(
  root: string,
  owner: string,
  repo: string,
  thread: string
): Promise<string> {
  const worktreePath = join(root, owner, repo, 'worktrees', 'archon', thread);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(join(worktreePath, 'artifact.txt'), 'debug artifact');
  return worktreePath;
}

async function setMtime(path: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await utimes(path, date, date);
}

describe('sweepTerminalWorkflowWorktrees', () => {
  let workspacesRoot: string;
  let quarantineRoot: string;

  beforeEach(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-sweep-'));
    quarantineRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-quarantine-'));
    mockDestroy.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockResolvedValue([]);
    mockListActiveEnvironmentsForSweep.mockClear();
    mockListActiveEnvironmentsForSweep.mockResolvedValue([]);
    mockGetConversationsUsingEnv.mockClear();
    mockGetConversationsUsingEnv.mockResolvedValue([]);
    mockGetActiveSession.mockClear();
    mockGetActiveSession.mockResolvedValue(null);
    mockUpdateEnvStatus.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
    await rm(quarantineRoot, { recursive: true, force: true });
  });

  test('removes completed worktrees older than the grace period and logs the removal', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-old');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-old',
        status: 'completed',
        working_path: worktreePath,
        completed_at: '2026-07-11T00:00:00Z',
      },
    ]);
    mockDestroy.mockImplementationOnce(async path => {
      await rm(path as string, { recursive: true, force: true });
    });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(false);
    expect(mockDestroy).toHaveBeenCalledWith(worktreePath, { force: true });
    expect(report.removed).toEqual([worktreePath]);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, runId: 'run-old' }),
      'worktree_sweep_removed'
    );
  });

  test('does not touch running worktrees regardless of mtime', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-running');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-running',
        status: 'running',
        working_path: worktreePath,
        completed_at: null,
      },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([
      { path: worktreePath, runId: 'run-running', reason: 'status:running' },
    ]);
  });

  test('does not remove failed worktrees inside the grace period', async () => {
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-recent-failed'
    );
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-recent-failed',
        status: 'failed',
        working_path: worktreePath,
        completed_at: '2026-07-12T12:00:00Z',
      },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([
      { path: worktreePath, runId: 'run-recent-failed', reason: 'inside_grace_period' },
    ]);
  });

  test('quarantines unmatched worktrees older than the orphan age without deleting them', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-old');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');
    const prunedRepos: string[] = [];

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async repoPath => {
        prunedRepos.push(repoPath);
      },
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-old');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(report.orphaned).toEqual([]);
    expect(report.quarantined).toEqual([quarantinePath]);
    expect(report.quarantinedBytes).toBeGreaterThan(0);
    expect(report.bytesFreed).toBe(0);
    expect(prunedRepos).toEqual(['/repos/owner/repo']);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath,
        quarantinePath,
        class: 'unmatched',
        reason: 'older_than_orphan_age',
      }),
      'worktree_sweep_quarantined_worktree'
    );
  });

  test('reports and preserves unmatched worktrees when quarantine move fails', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-move-fails');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      moveDir: async () => {
        throw new Error('rename failed');
      },
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.orphaned).toEqual([worktreePath]);
    expect(report.quarantined).toEqual([]);
    expect(report.errors).toEqual([{ path: worktreePath, error: 'rename failed' }]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath }),
      'worktree_sweep_quarantine_failed'
    );
  });

  test('warns and preserves recent unmatched worktrees with no matching run row', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-orphaned');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.orphaned).toEqual([worktreePath]);
    expect(report.quarantined).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { worktreePath },
      'worktree_sweep_orphaned_worktree'
    );
  });

  test('quarantines old env-only web worktrees with no active session and marks env destroyed', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-env');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-1',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: new Date('2026-07-01T00:00:00Z'),
        branch_name: 'thread-env',
        codebase_id: 'codebase-1',
      },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => new Date('2026-07-02T00:00:00Z'),
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-env');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(report.quarantined).toEqual([quarantinePath]);
    expect(mockUpdateEnvStatus).toHaveBeenCalledWith('env-1', 'destroyed');
  });

  test('rolls back env-only quarantine when marking the env destroyed fails', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-env');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-1',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: new Date('2026-07-01T00:00:00Z'),
        branch_name: 'thread-env',
        codebase_id: 'codebase-1',
      },
    ]);
    mockUpdateEnvStatus.mockRejectedValueOnce(new Error('db unavailable'));

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      moveDir: async (from, to) => {
        await rename(from, to);
      },
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-env');
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(quarantinePath)).toBe(false);
    expect(report.quarantined).toEqual([]);
    expect(report.quarantinedBytes).toBe(0);
    expect(report.errors).toEqual([{ path: worktreePath, error: 'db unavailable' }]);
    expect(mockUpdateEnvStatus).toHaveBeenCalledWith('env-1', 'destroyed');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, quarantinePath, envId: 'env-1' }),
      'worktree_sweep_env_quarantine_rolled_back'
    );
  });

  test('reports and preserves env-only worktrees when quarantine move fails', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-env');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-1',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: new Date('2026-07-01T00:00:00Z'),
        branch_name: 'thread-env',
        codebase_id: 'codebase-1',
      },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      moveDir: async () => {
        throw new Error('rename failed');
      },
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.errors).toEqual([{ path: worktreePath, error: 'rename failed' }]);
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, envId: 'env-1' }),
      'worktree_sweep_quarantine_failed'
    );
  });

  test('preserves env-only worktrees with active sessions or telegram platform', async () => {
    const activeSessionPath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-active-session'
    );
    const telegramPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-telegram');
    await setMtime(activeSessionPath, '2026-07-01T00:00:00Z');
    await setMtime(telegramPath, '2026-07-01T00:00:00Z');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-active',
        working_path: activeSessionPath,
        created_by_platform: 'web',
        created_at: new Date('2026-07-01T00:00:00Z'),
        branch_name: 'thread-active-session',
        codebase_id: 'codebase-1',
      },
      {
        id: 'env-telegram',
        working_path: telegramPath,
        created_by_platform: 'telegram',
        created_at: new Date('2026-07-01T00:00:00Z'),
        branch_name: 'thread-telegram',
        codebase_id: 'codebase-1',
      },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-active']);
    mockGetActiveSession.mockResolvedValueOnce({ id: 'session-1' });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(activeSessionPath)).toBe(true);
    expect(existsSync(telegramPath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped).toContainEqual({
      path: activeSessionPath,
      reason: 'env_has_active_session',
    });
    expect(report.skipped).toContainEqual({
      path: telegramPath,
      reason: 'env_platform:telegram',
    });
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
  });

  test('deletes quarantine date folders older than retention and reports freed bytes', async () => {
    const expiredPath = join(quarantineRoot, '2026-07-01', 'owner__repo__thread-old');
    await mkdir(expiredPath, { recursive: true });
    await writeFile(join(expiredPath, 'artifact.txt'), 'old quarantine');

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      quarantineRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(join(quarantineRoot, '2026-07-01'))).toBe(false);
    expect(report.quarantineDeleted).toEqual([join(quarantineRoot, '2026-07-01')]);
    expect(report.quarantineDeletedBytes).toBeGreaterThan(0);
    expect(report.bytesFreed).toBe(report.quarantineDeletedBytes);
  });

  test('keeps quarantine date folders inside retention', async () => {
    const retainedPath = join(quarantineRoot, '2026-07-10', 'owner__repo__thread-recent');
    await mkdir(retainedPath, { recursive: true });
    await writeFile(join(retainedPath, 'artifact.txt'), 'recent quarantine');

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      quarantineRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(retainedPath)).toBe(true);
    expect(report.quarantineDeleted).toEqual([]);
  });

  test('quarantines an env-only worktree whose dir mtime is fresh but whose real evidence is old (2026-09-22 production bug)', async () => {
    // This is the exact production defect: an incidental touch (git op, restart, scan)
    // refreshes dirStat.mtime to "now", but the env was created long ago and the last
    // real commit is also long ago. mtime must not be able to outvote that evidence.
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-fresh-mtime'
    );
    await setMtime(worktreePath, '2026-07-12T23:00:00Z'); // touched an hour before "now"
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-stale',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: new Date('2026-06-01T00:00:00Z'), // 6+ weeks old
        branch_name: 'thread-fresh-mtime',
        codebase_id: 'codebase-1',
      },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => new Date('2026-06-02T00:00:00Z'), // 6+ weeks old
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-fresh-mtime');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(report.quarantined).toEqual([quarantinePath]);
    expect(report.skipped).toEqual([]);
    expect(mockUpdateEnvStatus).toHaveBeenCalledWith('env-stale', 'destroyed');
  });

  test('never touches a worktree with an active session, however old its evidence', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-active');
    await setMtime(worktreePath, '2026-05-01T00:00:00Z');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      {
        id: 'env-active',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: new Date('2026-05-01T00:00:00Z'),
        branch_name: 'thread-active',
        codebase_id: 'codebase-1',
      },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce({ id: 'session-1' });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => new Date('2026-05-02T00:00:00Z'),
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.skipped).toEqual([{ path: worktreePath, reason: 'env_has_active_session' }]);
  });

  test('reclaims a no-commit, no-session worktree once it is older than the orphan age (the never-swept class)', async () => {
    // No run row, no env row: exactly the class the incident found alive forever
    // because getLastCommitDate returns null (no-git) and mtime was the only signal.
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-no-git');
    await setMtime(worktreePath, '2026-06-01T00:00:00Z');

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => null, // no-git: no commits ever made
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-no-git');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(report.quarantined).toEqual([quarantinePath]);
    expect(report.orphaned).toEqual([]);
  });

  test('preserves a genuinely recent no-commit, no-session worktree (mtime still applies with zero other evidence)', async () => {
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-recent-no-git'
    );
    await setMtime(worktreePath, '2026-07-12T00:00:00Z'); // 1 day old

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => null,
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.orphaned).toEqual([worktreePath]);
  });

  test('quarantine retention deletes only date folders past its own window, keeping newer ones', async () => {
    const expiredPath = join(quarantineRoot, '2026-07-01', 'owner__repo__thread-expired');
    const retainedPath = join(quarantineRoot, '2026-07-08', 'owner__repo__thread-retained');
    await mkdir(expiredPath, { recursive: true });
    await writeFile(join(expiredPath, 'artifact.txt'), 'expired');
    await mkdir(retainedPath, { recursive: true });
    await writeFile(join(retainedPath, 'artifact.txt'), 'retained');

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      quarantineRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(existsSync(join(quarantineRoot, '2026-07-01'))).toBe(false);
    expect(existsSync(retainedPath)).toBe(true);
    expect(report.quarantineDeleted).toEqual([join(quarantineRoot, '2026-07-01')]);
  });

  const DIRTY_ENV = {
    id: 'env-dirty',
    working_path: '',
    created_by_platform: 'web',
    created_at: new Date('2026-05-01T00:00:00Z'), // 10+ weeks old
    branch_name: 'thread-dirty',
    codebase_id: 'codebase-1',
  } as const;

  function oldEnvSweepOpts(root: string, qroot: string) {
    return {
      workspacesRoot: root,
      quarantineRoot: qroot,
      now: new Date('2026-07-13T00:00:00Z'),
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      getLastCommitDateFn: async () => new Date('2026-05-02T00:00:00Z'), // 10+ weeks old
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    };
  }

  test('preserves an old env-only worktree with no session but GENUINE uncommitted work, and logs why', async () => {
    // Overseer finding on #870: old env + old commit + no session must NOT be enough
    // to quarantine when the tree holds real modified/staged files. Session absence
    // does not prove the work is worthless.
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-dirty');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      { ...DIRTY_ENV, working_path: worktreePath },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);
    const dirtyCheck = mock(async () => true);

    const report = await sweepTerminalWorkflowWorktrees({
      ...oldEnvSweepOpts(workspacesRoot, quarantineRoot),
      hasUncommittedWorkFn: dirtyCheck,
    });

    expect(dirtyCheck).toHaveBeenCalledWith(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.skipped).toEqual([{ path: worktreePath, reason: 'env_has_uncommitted_work' }]);
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath,
        envId: 'env-dirty',
        reason: 'env_has_uncommitted_work',
      }),
      'worktree_sweep_env_only_skipped'
    );
  });

  test('reclaims an old env-only worktree with no session and a CLEAN tree (the original never-sweep bug stays fixed)', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-dirty');
    await setMtime(worktreePath, '2026-07-12T23:00:00Z'); // incidental fresh touch, still irrelevant
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      { ...DIRTY_ENV, working_path: worktreePath },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);

    const report = await sweepTerminalWorkflowWorktrees({
      ...oldEnvSweepOpts(workspacesRoot, quarantineRoot),
      hasUncommittedWorkFn: async () => false,
    });

    const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-dirty');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(quarantinePath)).toBe(true);
    expect(report.quarantined).toEqual([quarantinePath]);
    expect(report.skipped).toEqual([]);
    expect(mockUpdateEnvStatus).toHaveBeenCalledWith('env-dirty', 'destroyed');
  });

  test('preserves the worktree when the dirty check itself fails (fail safe toward preservation)', async () => {
    // A corrupt worktree, missing gitdir, or git timeout does not prove the tree is
    // clean. Undeterminable must mean "might have work", never "reclaim".
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-dirty');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      { ...DIRTY_ENV, working_path: worktreePath },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);

    const report = await sweepTerminalWorkflowWorktrees({
      ...oldEnvSweepOpts(workspacesRoot, quarantineRoot),
      hasUncommittedWorkFn: async () => {
        throw new Error('fatal: not a git repository: .git file is missing');
      },
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.skipped).toEqual([{ path: worktreePath, reason: 'env_dirty_check_failed' }]);
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath,
        reason: 'env_dirty_check_failed',
        error: 'fatal: not a git repository: .git file is missing',
      }),
      'worktree_sweep_env_only_skipped'
    );
  });

  test('untracked-files-only counts as dirty through the default git status check', async () => {
    // No hasUncommittedWorkFn override: exercise the real default, which shells out to
    // `git status --porcelain --untracked-files=all`. A lone untracked file is work.
    const { execFileAsync } = await import('@archon/git');
    const mockedExec = execFileAsync as unknown as ReturnType<typeof mock>;
    mockedExec.mockClear();
    mockedExec.mockImplementationOnce(async () => ({
      stdout: '?? notes/scratch.md\n',
      stderr: '',
    }));

    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-dirty');
    mockListActiveEnvironmentsForSweep.mockResolvedValueOnce([
      { ...DIRTY_ENV, working_path: worktreePath },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1']);
    mockGetActiveSession.mockResolvedValueOnce(null);

    const report = await sweepTerminalWorkflowWorktrees(
      oldEnvSweepOpts(workspacesRoot, quarantineRoot)
    );

    expect(mockedExec).toHaveBeenCalledWith(
      'git',
      ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all'],
      expect.anything()
    );
    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.skipped).toEqual([{ path: worktreePath, reason: 'env_has_uncommitted_work' }]);
  });

  test('preserves an old unmatched (no run, no env) worktree that holds uncommitted work', async () => {
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-unmatched-dirty'
    );
    await setMtime(worktreePath, '2026-05-01T00:00:00Z');

    const report = await sweepTerminalWorkflowWorktrees({
      ...oldEnvSweepOpts(workspacesRoot, quarantineRoot),
      hasUncommittedWorkFn: async () => true,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.orphaned).toEqual([worktreePath]);
    expect(report.skipped).toEqual([
      { path: worktreePath, reason: 'unmatched_has_uncommitted_work' },
    ]);
  });

  test('preserves a recent unmatched worktree whose checked-out commit is old (mid-provision, no rows yet)', async () => {
    // Overseer finding on #870 (cfe7b124): a worktree cut moments ago from an old
    // commit, before its env/run row lands, must not be quarantined on commit age.
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-provisioning'
    );
    await setMtime(worktreePath, '2026-07-12T23:30:00Z'); // created 30 minutes before "now"
    const dirtyCheck = mock(async () => false);

    const report = await sweepTerminalWorkflowWorktrees({
      ...oldEnvSweepOpts(workspacesRoot, quarantineRoot),
      getLastCommitDateFn: async () => new Date('2026-03-01T00:00:00Z'), // checked out at an old commit
      hasUncommittedWorkFn: dirtyCheck,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.orphaned).toEqual([worktreePath]);
    expect(dirtyCheck).not.toHaveBeenCalled();
  });

  test('logs a noop warning when a sweep scans worktrees but reclaims nothing', async () => {
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-running-noop'
    );
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-running',
        status: 'running',
        working_path: worktreePath,
        completed_at: null,
      },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(report.removed).toEqual([]);
    expect(report.quarantined).toEqual([]);
    expect(report.bytesFreed).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scanned: 1, removed: 0, quarantined: 0, bytesFreed: 0 }),
      'worktree_sweep_disk_report_noop'
    );
  });

  test('logs total directories scanned, removed, and bytes freed on completion', async () => {
    const oldPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-old');
    const runningPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-running');
    const orphanPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-orphan-old');
    await setMtime(orphanPath, '2026-07-01T00:00:00Z');
    const expiredPath = join(quarantineRoot, '2026-07-01', 'owner__repo__thread-expired');
    await mkdir(expiredPath, { recursive: true });
    await writeFile(join(expiredPath, 'artifact.txt'), 'expired quarantine');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-old',
        status: 'completed',
        working_path: oldPath,
        completed_at: '2026-07-11T00:00:00Z',
      },
      {
        id: 'run-running',
        status: 'running',
        working_path: runningPath,
        completed_at: null,
      },
    ]);
    mockDestroy.mockImplementationOnce(async path => {
      await rm(path as string, { recursive: true, force: true });
    });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
      orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
      quarantineRetentionMs: 7 * 24 * 60 * 60 * 1000,
      getCanonicalRepoPathFn: async () => '/repos/owner/repo',
      pruneWorktree: async () => undefined,
    });

    expect(report.scanned).toBe(3);
    expect(report.removed).toEqual([oldPath]);
    expect(report.quarantined).toEqual([
      join(quarantineRoot, '2026-07-13', 'owner__repo__thread-orphan-old'),
    ]);
    expect(report.quarantineDeleted).toEqual([join(quarantineRoot, '2026-07-01')]);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scanned: 3,
        removed: 1,
        quarantined: 1,
        quarantineDeleted: 1,
        bytesFreed: report.bytesFreed,
        quarantinedBytes: report.quarantinedBytes,
        quarantineDeletedBytes: report.quarantineDeletedBytes,
        errors: 0,
        orphaned: 0,
      }),
      'worktree_sweep_disk_report'
    );
  });
});

function exdevError(): NodeJS.ErrnoException {
  const error = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
  error.code = 'EXDEV';
  return error;
}

describe('moveDirAcrossDevices', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-move-dir-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('same-device rename moves the directory and does not copy', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'a.txt'), 'alpha');
    const cpSpy = mock(async () => undefined);

    await moveDirAcrossDevices(src, dst, {
      rename,
      cp: cpSpy,
      rm,
    });

    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('alpha');
    expect(existsSync(src)).toBe(false);
    expect(cpSpy).toHaveBeenCalledTimes(0);
  });

  test('EXDEV falls back to copy then delete and keeps symlinks', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(join(src, 'sub'), { recursive: true });
    await writeFile(join(src, 'a.txt'), 'alpha');
    await writeFile(join(src, 'sub', 'b.txt'), 'beta');
    await symlink('a.txt', join(src, 'link'));

    const deps: MoveDirAcrossDevicesDeps = {
      rename: async () => {
        throw exdevError();
      },
      cp,
      rm,
    };

    await moveDirAcrossDevices(src, dst, deps);

    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(join(dst, 'sub', 'b.txt'), 'utf8')).toBe('beta');
    expect((await lstat(join(dst, 'link'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dst, 'link'))).toBe('a.txt');
    expect(existsSync(src)).toBe(false);
  });

  test('rethrows non-EXDEV rename errors and cleans a partial copy', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'a.txt'), 'alpha');
    const cpSpy = mock(async () => undefined);
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    await expect(
      moveDirAcrossDevices(src, dst, {
        rename: async () => {
          throw denied;
        },
        cp: cpSpy,
        rm,
      })
    ).rejects.toBe(denied);
    expect(cpSpy).not.toHaveBeenCalled();
    expect(existsSync(join(src, 'a.txt'))).toBe(true);

    const partialDst = join(root, 'partial-dst');
    await expect(
      moveDirAcrossDevices(src, partialDst, {
        rename: async () => {
          throw exdevError();
        },
        cp: async (_from, to) => {
          await mkdir(to, { recursive: true });
          await writeFile(join(to, 'partial.txt'), 'x');
          throw new Error('disk full');
        },
        rm,
      })
    ).rejects.toThrow('disk full');
    expect(existsSync(partialDst)).toBe(false);
    expect(await readFile(join(src, 'a.txt'), 'utf8')).toBe('alpha');
  });

  test('rethrows the copy error when partial-copy cleanup also fails', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'a.txt'), 'alpha');
    const cpError = new Error('disk full');
    const rmError = new Error('EACCES removing partial copy');
    mockLogger.warn.mockClear();

    await expect(
      moveDirAcrossDevices(src, dst, {
        rename: async () => {
          throw exdevError();
        },
        cp: async (_from, to) => {
          await mkdir(to, { recursive: true });
          await writeFile(join(to, 'partial.txt'), 'x');
          throw cpError;
        },
        rm: async () => {
          throw rmError;
        },
      })
    ).rejects.toBe(cpError);

    expect(existsSync(join(dst, 'partial.txt'))).toBe(true);
    expect(await readFile(join(src, 'a.txt'), 'utf8')).toBe('alpha');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: rmError, path: dst },
      'worktree_sweep_partial_copy_cleanup_failed'
    );
  });

  // Overseer review, bdc-harness#947, [major]: the EXDEV fallback used to
  // unconditionally rm `to` on a failed cp, regardless of whether `to`
  // already held content this call did not create -- a name collision or a
  // retry landing on a destination a prior attempt already populated. That
  // deleted pre-existing quarantine content, not just a partial copy this
  // call itself wrote.
  test('refuses to move onto an existing destination and leaves its content untouched', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'a.txt'), 'alpha');
    // `dst` already holds unrelated content this call did not create --
    // e.g. a prior quarantine attempt, or a name collision.
    await mkdir(dst);
    await writeFile(join(dst, 'pre-existing.txt'), 'do not touch me');
    const cpSpy = mock(async () => undefined);
    const rmSpy = mock(rm);

    await expect(
      moveDirAcrossDevices(src, dst, {
        rename: async () => {
          throw exdevError();
        },
        cp: cpSpy,
        rm: rmSpy,
      })
    ).rejects.toBeInstanceOf(MoveDirDestinationExistsError);

    // cp/rm are never called on the pre-existing destination: no attempt was
    // made to write onto it, and nothing was deleted trying to clean it up.
    expect(cpSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
    expect(await readFile(join(dst, 'pre-existing.txt'), 'utf8')).toBe('do not touch me');
    // The source is left in place too -- this failed move is a no-op, not a
    // partial one.
    expect(await readFile(join(src, 'a.txt'), 'utf8')).toBe('alpha');
  });

  test('MoveDirDestinationExistsError names the colliding path', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await mkdir(dst);

    let caught: unknown;
    try {
      await moveDirAcrossDevices(src, dst, {
        rename: async () => {
          throw exdevError();
        },
        cp,
        rm,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MoveDirDestinationExistsError);
    expect((caught as MoveDirDestinationExistsError).path).toBe(dst);
    expect((caught as Error).message).toContain(dst);
  });
});

describe('sweepTerminalWorkflowWorktrees EXDEV fallback', () => {
  let workspacesRoot: string;
  let quarantineRoot: string;

  beforeEach(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-sweep-'));
    quarantineRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-quarantine-'));
    mockDestroy.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockResolvedValue([]);
    mockListActiveEnvironmentsForSweep.mockClear();
    mockListActiveEnvironmentsForSweep.mockResolvedValue([]);
    mockGetConversationsUsingEnv.mockClear();
    mockGetConversationsUsingEnv.mockResolvedValue([]);
    mockGetActiveSession.mockClear();
    mockGetActiveSession.mockResolvedValue(null);
    mockUpdateEnvStatus.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
    await rm(quarantineRoot, { recursive: true, force: true });
  });

  test('quarantines through the default move when rename returns EXDEV', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-exdev');
    await setMtime(worktreePath, '2026-07-01T00:00:00Z');
    const renameSpy = spyOn(fsPromises, 'rename').mockImplementation(async () => {
      throw exdevError();
    });

    try {
      const report = await sweepTerminalWorkflowWorktrees({
        workspacesRoot,
        quarantineRoot,
        now: new Date('2026-07-13T00:00:00Z'),
        orphanAgeMs: 7 * 24 * 60 * 60 * 1000,
        getCanonicalRepoPathFn: async () => '/repos/owner/repo',
        pruneWorktree: async () => undefined,
      });

      const quarantinePath = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-exdev');
      expect(renameSpy).toHaveBeenCalled();
      expect(report.errors).toEqual([]);
      expect(report.quarantined).toEqual([quarantinePath]);
      expect(existsSync(worktreePath)).toBe(false);
      expect(await readFile(join(quarantinePath, 'artifact.txt'), 'utf8')).toBe('debug artifact');
    } finally {
      renameSpy.mockRestore();
    }
  });
});
