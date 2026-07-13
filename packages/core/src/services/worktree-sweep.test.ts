import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLogger } from '../test/mocks/logger';
import type { WorktreeSweepRun } from './worktree-sweep';
import type { DestroyResult } from '@archon/isolation';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

let mockWorktreeBase = '/unused/workspaces/owner/repo/worktrees';
mock.module('@archon/git', () => ({
  getWorktreeBase: () => ({
    base: mockWorktreeBase,
    layout: 'workspace-scoped',
  }),
  toRepoPath: (path: string) => path,
}));

function destroyResult(overrides: Partial<DestroyResult> = {}): DestroyResult {
  return {
    worktreeRemoved: true,
    branchDeleted: null,
    remoteBranchDeleted: null,
    directoryClean: true,
    warnings: [],
    ...overrides,
  };
}

const mockDestroy = mock(async () => destroyResult());
mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));

const mockListWorkflowRunsWithWorkingPath = mock(async () => [] as WorktreeSweepRun[]);
mock.module('../db/workflows', () => ({
  listWorkflowRunsWithWorkingPath: mockListWorkflowRunsWithWorkingPath,
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

describe('sweepTerminalWorkflowWorktrees', () => {
  let workspacesRoot: string;

  beforeEach(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-sweep-'));
    mockWorktreeBase = '/unused/workspaces/owner/repo/worktrees';
    mockDestroy.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
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
      return destroyResult();
    });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
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

  test('records a non-throwing destroy failure as an error without crediting bytes freed', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-stuck');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-stuck',
        status: 'completed',
        working_path: worktreePath,
        completed_at: '2026-07-11T00:00:00Z',
      },
    ]);
    mockDestroy.mockResolvedValueOnce(
      destroyResult({
        worktreeRemoved: false,
        directoryClean: false,
        warnings: ['worktree still registered in git'],
      })
    );

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.bytesFreed).toBe(0);
    expect(report.errors).toEqual([
      {
        path: worktreePath,
        runId: 'run-stuck',
        error: 'destroy did not remove worktree cleanly: worktree still registered in git',
      },
    ]);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, runId: 'run-stuck' }),
      'worktree_sweep_removed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath,
        runId: 'run-stuck',
        result: expect.objectContaining({ worktreeRemoved: false }),
      }),
      'worktree_sweep_remove_failed'
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
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([
      { path: worktreePath, runId: 'run-recent-failed', reason: 'inside_grace_period' },
    ]);
  });

  test('warns and preserves orphaned worktrees with no matching run row', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-orphaned');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.orphaned).toEqual([worktreePath]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { worktreePath },
      'worktree_sweep_orphaned_worktree'
    );
  });

  test('logs total directories scanned, removed, and bytes freed on completion', async () => {
    const oldPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-old');
    const runningPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-running');
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
      return destroyResult();
    });

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(report.scanned).toBe(2);
    expect(report.removed).toEqual([oldPath]);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scanned: 2,
        removed: 1,
        bytesFreed: report.bytesFreed,
        errors: 0,
      }),
      'worktree_sweep_disk_report'
    );
  });

  test('uses the default workspace root derived from getWorktreeBase', async () => {
    mockWorktreeBase = join(workspacesRoot, 'owner', 'repo', 'worktrees');
    const worktreePath = await createWorktree(
      workspacesRoot,
      'owner',
      'repo',
      'thread-default-root'
    );
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      {
        id: 'run-default-root',
        status: 'completed',
        working_path: worktreePath,
        completed_at: '2026-07-11T00:00:00Z',
      },
    ]);
    mockDestroy.mockImplementationOnce(async path => {
      await rm(path as string, { recursive: true, force: true });
      return destroyResult();
    });

    const report = await sweepTerminalWorkflowWorktrees({
      now: new Date('2026-07-13T00:00:00Z'),
      gracePeriodMs: 24 * 60 * 60 * 1000,
    });

    expect(mockDestroy).toHaveBeenCalledWith(worktreePath, { force: true });
    expect(report.scanned).toBe(1);
    expect(report.removed).toEqual([worktreePath]);
  });
});
