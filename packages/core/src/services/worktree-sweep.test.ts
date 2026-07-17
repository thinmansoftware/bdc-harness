import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockLogger } from '../test/mocks/logger';
import type { WorktreeSweepRun, WorktreeSweepEnv } from './worktree-sweep';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockPruneWorktrees = mock(async () => undefined);
const mockExecFileAsync = mock(async () => ({ stdout: '', stderr: '' }));
mock.module('@archon/git', () => ({
  getWorktreeBase: () => ({
    base: '/unused/workspaces/owner/repo/worktrees',
    layout: 'workspace-scoped',
  }),
  toRepoPath: (path: string) => path,
  pruneWorktrees: mockPruneWorktrees,
  execFileAsync: mockExecFileAsync,
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

const mockListActiveEnvs = mock(async () => [] as WorktreeSweepEnv[]);
const mockGetConversationsUsingEnv = mock(async () => [] as string[]);
const mockUpdateEnvStatus = mock(async () => undefined);
mock.module('../db/isolation-environments', () => ({
  listActiveEnvironmentsWithWorkingPath: mockListActiveEnvs,
  getConversationsUsingEnv: mockGetConversationsUsingEnv,
  updateStatus: mockUpdateEnvStatus,
}));

const mockGetActiveSession = mock(async () => null as unknown);
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
}));

import { sweepTerminalWorkflowWorktrees } from './worktree-sweep';

const DAY_MS = 24 * 60 * 60 * 1000;

async function setMtime(path: string, when: Date): Promise<void> {
  await utimes(path, when, when);
}

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
  let quarantineRoot: string;

  beforeEach(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-sweep-'));
    quarantineRoot = await mkdtemp(join(tmpdir(), 'archon-worktree-quarantine-'));
    mockDestroy.mockClear();
    mockListWorkflowRunsWithWorkingPath.mockClear();
    mockListActiveEnvs.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockUpdateEnvStatus.mockClear();
    mockGetActiveSession.mockClear();
    mockPruneWorktrees.mockClear();
    mockExecFileAsync.mockClear();
    mockGetConversationsUsingEnv.mockResolvedValue([]);
    mockGetActiveSession.mockResolvedValue(null as unknown);
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
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

  // ==========================================================================
  // Age-based quarantine ladder (WO-HARNESS-WORKTREE-ORPHAN-QUARANTINE-01)
  // ==========================================================================

  const NOW = new Date('2026-07-13T00:00:00Z');
  const ORPHAN_AGE_MS = 7 * DAY_MS;
  const OLD = new Date('2026-07-01T00:00:00Z'); // 12 days before NOW -> past orphan age
  const RECENT = new Date('2026-07-12T00:00:00Z'); // 1 day before NOW -> inside orphan age

  // Scenario 1: matched to a running run -> untouched (regression guard).
  test('scenario 1: dir matched to a running run is never quarantined', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-running');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([
      { id: 'run-running', status: 'running', working_path: worktreePath, completed_at: null },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(report.quarantined).toEqual([]);
    expect(report.skipped).toEqual([
      { path: worktreePath, runId: 'run-running', reason: 'status:running' },
    ]);
  });

  // Scenario 2: UNMATCHED older than orphan age -> moved to quarantine, not deleted.
  test('scenario 2: old unmatched dir is quarantined (moved), logged, and not deleted', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-orphan');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    const expectedDest = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-orphan');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(expectedDest)).toBe(true);
    expect(report.quarantined).toEqual([
      {
        path: worktreePath,
        quarantinePath: expectedDest,
        class: 'unmatched',
        bytes: expect.any(Number),
      },
    ]);
    expect(report.quarantineDeleted).toEqual([]);
    expect(report.orphaned).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath, quarantinePath: expectedDest, class: 'unmatched' }),
      'worktree_sweep_quarantined'
    );
  });

  // Scenario 3: UNMATCHED inside orphan age -> warn only (preserve predecessor behavior).
  test('scenario 3: young unmatched dir is only warned about, not quarantined', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-young');
    await setMtime(worktreePath, RECENT);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(report.orphaned).toEqual([worktreePath]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { worktreePath },
      'worktree_sweep_orphaned_worktree'
    );
  });

  // Scenario 4: ENV-ONLY (active env, web, no active session) older than orphan age
  //   -> quarantined AND env row marked destroyed; canonical repo pruned.
  test('scenario 4: old env-only dir is quarantined and its env row marked destroyed', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-envonly');
    await setMtime(worktreePath, OLD);
    // Provide a canonical source clone so the prune path is exercised.
    const sourcePath = join(workspacesRoot, 'owner', 'repo', 'source');
    await mkdir(sourcePath, { recursive: true });

    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([
      {
        id: 'env-web-1',
        working_path: worktreePath,
        created_by_platform: 'web',
        created_at: OLD,
      },
    ]);
    // No conversations -> no active session.
    mockGetConversationsUsingEnv.mockResolvedValue([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    const expectedDest = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-envonly');
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(expectedDest)).toBe(true);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0].class).toBe('env-only');
    expect(mockUpdateEnvStatus).toHaveBeenCalledWith('env-web-1', 'destroyed');
    expect(mockPruneWorktrees).toHaveBeenCalledWith(sourcePath);
  });

  // Scenario 4b: the quarantine log carries the required structured fields --
  // path, class, reason, and bytes (WO contract).
  test('scenario 4b: quarantine log includes path, class, reason, and bytes', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-reason');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([
      { id: 'env-reason', working_path: worktreePath, created_by_platform: 'web', created_at: OLD },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValue([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    const expectedDest = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-reason');
    expect(report.quarantined).toHaveLength(1);
    const quarantineLog = mockLogger.info.mock.calls.find(
      ([, event]) => event === 'worktree_sweep_quarantined'
    );
    expect(quarantineLog).toBeDefined();
    const [fields] = quarantineLog as [Record<string, unknown>, string];
    expect(fields.worktreePath).toBe(worktreePath);
    expect(fields.quarantinePath).toBe(expectedDest);
    expect(fields.class).toBe('env-only');
    expect(typeof fields.reason).toBe('string');
    expect((fields.reason as string).length).toBeGreaterThan(0);
    expect(typeof fields.bytes).toBe('number');
  });

  // Scenario 4c: DB status update fails AFTER the dir has already been moved to
  // quarantine. The move must stand, the failure must be retried, and the
  // stranded env row must be surfaced via report.errors (not misreported as a
  // quarantine failure).
  test('scenario 4c: mark-destroyed failure after quarantine is retried and surfaced', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-dbfail');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([
      { id: 'env-dbfail', working_path: worktreePath, created_by_platform: 'web', created_at: OLD },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValue([]);
    // Every attempt to mark the env destroyed fails.
    mockUpdateEnvStatus.mockRejectedValue(new Error('db unavailable'));

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    const expectedDest = join(quarantineRoot, '2026-07-13', 'owner__repo__thread-dbfail');
    // The move still stands -- we do NOT roll back a successful quarantine.
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(expectedDest)).toBe(true);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0].class).toBe('env-only');
    // Retried the max number of attempts.
    expect(mockUpdateEnvStatus).toHaveBeenCalledTimes(3);
    // The stranded env row is surfaced as an error referencing the env id.
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].path).toBe(worktreePath);
    expect(report.errors[0].error).toContain('env-dbfail');
    expect(report.errors[0].error).toContain('db unavailable');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-dbfail', worktreePath }),
      'worktree_sweep_mark_destroyed_failed'
    );
    // Reset for other tests (mockRejectedValue is sticky).
    mockUpdateEnvStatus.mockReset();
    mockUpdateEnvStatus.mockResolvedValue(undefined);
  });

  // Scenario 5a: ENV-ONLY with an active session -> untouched, skip logged.
  test('scenario 5a: env-only dir with an active session is left alone', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-live');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([
      { id: 'env-live', working_path: worktreePath, created_by_platform: 'web', created_at: OLD },
    ]);
    mockGetConversationsUsingEnv.mockResolvedValue(['conv-1']);
    mockGetActiveSession.mockResolvedValue({ id: 'session-1' } as unknown);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
    expect(report.skipped).toContainEqual({ path: worktreePath, reason: 'active_session' });
  });

  // Scenario 5b: ENV-ONLY created by telegram -> untouched (persistent by doctrine).
  test('scenario 5b: telegram env-only dir is left alone', async () => {
    const worktreePath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-tg');
    await setMtime(worktreePath, OLD);
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([
      {
        id: 'env-tg',
        working_path: worktreePath,
        created_by_platform: 'telegram',
        created_at: OLD,
      },
    ]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(report.quarantined).toEqual([]);
    expect(mockUpdateEnvStatus).not.toHaveBeenCalled();
    expect(report.skipped).toContainEqual({ path: worktreePath, reason: 'telegram_env' });
  });

  // Scenario 6: quarantine date-folder older than retention -> deleted, bytes logged.
  test('scenario 6: expired quarantine folder is deleted and bytes freed are logged', async () => {
    const expiredFolder = join(quarantineRoot, '2026-07-01');
    await mkdir(join(expiredFolder, 'owner__repo__thread-x'), { recursive: true });
    await writeFile(join(expiredFolder, 'owner__repo__thread-x', 'blob.txt'), 'stale bytes');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
      quarantineRetentionDays: 7,
    });

    expect(existsSync(expiredFolder)).toBe(false);
    expect(report.quarantineDeleted).toHaveLength(1);
    expect(report.quarantineDeleted[0].path).toBe(expiredFolder);
    expect(report.quarantineDeleted[0].bytesFreed).toBeGreaterThan(0);
    expect(report.bytesFreed).toBeGreaterThan(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ quarantinePath: expiredFolder }),
      'worktree_sweep_quarantine_deleted'
    );
  });

  // Scenario 7: quarantine date-folder inside the retention window -> kept.
  test('scenario 7: quarantine folder inside retention window is kept', async () => {
    const recentFolder = join(quarantineRoot, '2026-07-10');
    await mkdir(join(recentFolder, 'owner__repo__thread-y'), { recursive: true });
    await writeFile(join(recentFolder, 'owner__repo__thread-y', 'blob.txt'), 'fresh bytes');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
      quarantineRetentionDays: 7,
    });

    expect(existsSync(recentFolder)).toBe(true);
    expect(report.quarantineDeleted).toEqual([]);
  });

  // Scenario 8: disk report includes scanned, quarantined, quarantine-deleted, bytesFreed.
  test('scenario 8: disk report log line includes quarantine counts and bytesFreed', async () => {
    const orphanPath = await createWorktree(workspacesRoot, 'owner', 'repo', 'thread-orphan');
    await setMtime(orphanPath, OLD);
    const expiredFolder = join(quarantineRoot, '2026-07-01');
    await mkdir(join(expiredFolder, 'owner__repo__thread-x'), { recursive: true });
    await writeFile(join(expiredFolder, 'owner__repo__thread-x', 'blob.txt'), 'stale bytes');
    mockListWorkflowRunsWithWorkingPath.mockResolvedValueOnce([]);
    mockListActiveEnvs.mockResolvedValueOnce([]);

    const report = await sweepTerminalWorkflowWorktrees({
      workspacesRoot,
      quarantineRoot,
      now: NOW,
      orphanAgeMs: ORPHAN_AGE_MS,
      quarantineRetentionDays: 7,
    });

    expect(report.scanned).toBe(1);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantineDeleted).toHaveLength(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scanned: 1,
        quarantined: 1,
        quarantineDeleted: 1,
        bytesFreed: report.bytesFreed,
      }),
      'worktree_sweep_disk_report'
    );
  });
});
