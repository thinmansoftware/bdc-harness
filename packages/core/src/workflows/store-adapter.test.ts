import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { IWorkflowStore } from '@archon/workflows/store';

// Mock DB modules before importing store-adapter
const mockCreateWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockGetActiveWorkflowRunByPath = mock(() => Promise.resolve(null));
const mockFailOrphanedRuns = mock(() => Promise.resolve({ count: 0 }));
const mockFindResumableRun = mock(() => Promise.resolve(null));
const mockResumeWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockUpdateWorkflowActivity = mock(() => Promise.resolve());
const mockGetWorkflowRunStatus = mock(() => Promise.resolve('running'));
const mockCompleteWorkflowRun = mock(() => Promise.resolve());
const mockFailWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());
const mockPauseWorkflowRun = mock(() => Promise.resolve());
const mockCreateRunAuthority = mock(() => Promise.resolve('created' as const));
const mockGetRunAuthority = mock(() => Promise.resolve(null));
const mockClaimRunLease = mock(() => Promise.resolve(null));
const mockHeartbeatRunLease = mock(() => Promise.resolve(false));
const mockReleaseRunLease = mock(() => Promise.resolve(false));
const mockCreateProviderAttempt = mock(() => Promise.resolve(false));
const mockCompleteProviderAttempt = mock(() => Promise.resolve(false));
const mockListProviderAttempts = mock(() => Promise.resolve([]));
const mockUpsertRunOutcome = mock(() => Promise.resolve(false));
const mockGetRunOutcome = mock(() => Promise.resolve(null));
const mockScheduleProviderWait = mock(() => Promise.resolve(false));
const mockListDueProviderWaits = mock(() => Promise.resolve([]));
const mockClaimProviderWait = mock(() => Promise.resolve(false));
const mockCancelProviderWaits = mock(() => Promise.resolve(0));
const mockCompleteProviderWait = mock(() => Promise.resolve(false));

mock.module('../db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  getWorkflowRun: mockGetWorkflowRun,
  getActiveWorkflowRunByPath: mockGetActiveWorkflowRunByPath,
  failOrphanedRuns: mockFailOrphanedRuns,
  findResumableRun: mockFindResumableRun,
  resumeWorkflowRun: mockResumeWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  updateWorkflowActivity: mockUpdateWorkflowActivity,
  getWorkflowRunStatus: mockGetWorkflowRunStatus,
  completeWorkflowRun: mockCompleteWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  pauseWorkflowRun: mockPauseWorkflowRun,
  createRunAuthority: mockCreateRunAuthority,
  getRunAuthority: mockGetRunAuthority,
  claimRunLease: mockClaimRunLease,
  heartbeatRunLease: mockHeartbeatRunLease,
  releaseRunLease: mockReleaseRunLease,
  createProviderAttempt: mockCreateProviderAttempt,
  completeProviderAttempt: mockCompleteProviderAttempt,
  listProviderAttempts: mockListProviderAttempts,
  upsertRunOutcome: mockUpsertRunOutcome,
  getRunOutcome: mockGetRunOutcome,
  scheduleProviderWait: mockScheduleProviderWait,
  listDueProviderWaits: mockListDueProviderWaits,
  claimProviderWait: mockClaimProviderWait,
  cancelProviderWaits: mockCancelProviderWaits,
  completeProviderWait: mockCompleteProviderWait,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
const mockListWorkflowEvents = mock(() => Promise.resolve([]));
const mockGetCompletedDagNodeOutputs = mock(() => Promise.resolve(new Map<string, string>()));
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
  listWorkflowEvents: mockListWorkflowEvents,
  getCompletedDagNodeOutputs: mockGetCompletedDagNodeOutputs,
}));

const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({})),
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({ assistant: 'claude' })),
}));

const { createWorkflowStore, createWorkflowDeps } = await import('./store-adapter');

describe('createWorkflowStore', () => {
  test('returns object with all IWorkflowStore methods', () => {
    const store = createWorkflowStore();
    const requiredMethods: (keyof IWorkflowStore)[] = [
      'createWorkflowRun',
      'getWorkflowRun',
      'getActiveWorkflowRunByPath',
      'failOrphanedRuns',
      'findResumableRun',
      'resumeWorkflowRun',
      'updateWorkflowRun',
      'updateWorkflowActivity',
      'getWorkflowRunStatus',
      'completeWorkflowRun',
      'failWorkflowRun',
      'pauseWorkflowRun',
      'cancelWorkflowRun',
      'createRunAuthority',
      'getRunAuthority',
      'claimRunLease',
      'heartbeatRunLease',
      'releaseRunLease',
      'createProviderAttempt',
      'completeProviderAttempt',
      'listProviderAttempts',
      'upsertRunOutcome',
      'getRunOutcome',
      'scheduleProviderWait',
      'listDueProviderWaits',
      'claimProviderWait',
      'cancelProviderWaits',
      'completeProviderWait',
      'createWorkflowEvent',
      'listWorkflowEvents',
      'getCompletedDagNodeOutputs',
      'getCodebase',
      'getCodebaseEnvVars',
    ];
    for (const method of requiredMethods) {
      expect(typeof store[method]).toBe('function');
    }
  });

  test('delegates getWorkflowRunStatus to DB and returns typed status', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce('completed');
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('run-123');
    expect(result).toBe('completed');
    expect(mockGetWorkflowRunStatus).toHaveBeenCalledWith('run-123');
  });

  test('delegates getWorkflowRunStatus returns null for missing run', async () => {
    mockGetWorkflowRunStatus.mockResolvedValueOnce(null);
    const store = createWorkflowStore();
    const result = await store.getWorkflowRunStatus('nonexistent');
    expect(result).toBeNull();
  });

  test('createWorkflowEvent catches and logs unexpected throws', async () => {
    mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('DB connection lost'));
    const store = createWorkflowStore();
    // Should not throw -- the wrapper guarantees the non-throwing contract
    await expect(
      store.createWorkflowEvent({
        workflow_run_id: 'run-1',
        event_type: 'step_started',
        step_index: 0,
        step_name: 'test-step',
      })
    ).resolves.toBeUndefined();
  });

  test('delegates getCompletedDagNodeOutputs to DB', async () => {
    const expected = new Map([['step1', 'output text']]);
    mockGetCompletedDagNodeOutputs.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.getCompletedDagNodeOutputs('run-123');
    expect(result).toBe(expected);
    expect(mockGetCompletedDagNodeOutputs).toHaveBeenCalledWith('run-123');
  });

  test('delegates listWorkflowEvents to DB', async () => {
    const expected = [
      {
        id: 'evt-1',
        workflow_run_id: 'run-123',
        event_type: 'run_token_totals',
        step_index: null,
        step_name: null,
        data: {},
        created_at: '2026-07-02T00:00:00.000Z',
      },
    ];
    mockListWorkflowEvents.mockResolvedValueOnce(expected);
    const store = createWorkflowStore();
    const result = await store.listWorkflowEvents('run-123');
    expect(result).toBe(expected);
    expect(mockListWorkflowEvents).toHaveBeenCalledWith('run-123');
  });

  test('delegates cancelWorkflowRun to DB', async () => {
    mockCancelWorkflowRun.mockResolvedValueOnce(undefined);
    const store = createWorkflowStore();
    await store.cancelWorkflowRun('run-123');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123');
  });

  test('delegates reliability lease and wait operations to DB', async () => {
    const store = createWorkflowStore();
    const lease = {
      runId: 'run-123',
      ownerId: 'worker-1',
      leaseToken: 'lease-token',
      acquiredAt: '2026-07-09T12:00:00.000Z',
      lastHeartbeatAt: '2026-07-09T12:00:00.000Z',
      expiresAt: '2026-07-09T12:01:00.000Z',
      releasedAt: null,
    };
    mockClaimRunLease.mockResolvedValueOnce(lease);
    await expect(store.claimRunLease(lease)).resolves.toEqual(lease);
    expect(mockClaimRunLease).toHaveBeenCalledWith(lease);

    mockCancelProviderWaits.mockResolvedValueOnce(2);
    await expect(store.cancelProviderWaits('run-123', '2026-07-09T12:02:00.000Z')).resolves.toBe(2);
    expect(mockCancelProviderWaits).toHaveBeenCalledWith('run-123', '2026-07-09T12:02:00.000Z');
  });

  test('delegates getCodebase to DB', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
    const store = createWorkflowStore();
    const result = await store.getCodebase('cb-1');
    expect(result).toEqual({
      id: 'cb-1',
      name: 'owner/repo',
      repository_url: 'https://github.com/owner/repo',
      default_cwd: '/workspace/repo',
    });
  });
});

describe('createWorkflowDeps', () => {
  test('returns WorkflowDeps with store, getAgentProvider, and loadConfig', () => {
    const deps = createWorkflowDeps();
    expect(deps.store).toBeDefined();
    expect(typeof deps.getAgentProvider).toBe('function');
    expect(typeof deps.loadConfig).toBe('function');
  });

  test('store from createWorkflowDeps has all IWorkflowStore methods', () => {
    const deps = createWorkflowDeps();
    expect(typeof deps.store.createWorkflowRun).toBe('function');
    expect(typeof deps.store.getWorkflowRun).toBe('function');
    expect(typeof deps.store.createWorkflowEvent).toBe('function');
    expect(typeof deps.store.getCodebase).toBe('function');
  });
});
