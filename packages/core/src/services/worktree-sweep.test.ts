import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLogger } from '../test/mocks/logger';
import type { WorktreeSweepEnvironment, WorktreeSweepRun } from './worktree-sweep';

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

import { sweepTerminalWorkflowWorktrees } from './worktree-sweep';

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
    expect(report.orphaned).toEqual([worktreePath]);
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
      }),
      'worktree_sweep_disk_report'
    );
  });
});
