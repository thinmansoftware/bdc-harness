// WO-HARNESS-ATOMIC-FIRE-FROM-BRANCH-01 -- background worker dispatch.
//
// Imports the REAL exported dispatchBackgroundWorkflow() and mocks only its
// dependencies. Asserts:
//  - task/from-branch hints from the parent dispatch reach the worker isolation
//    resolve() with workflowType 'task', fromBranch, and a UNIQUE worker
//    workflowId (not the parent's);
//  - the no-flag / thread default is preserved;
//  - the run_authority freeze precedes worker conversation creation + isolation;
//  - freeze rejection creates no worker conversation or isolation.
//
// A test that replaces dispatchBackgroundWorkflow itself with a mock would NOT
// satisfy the stop condition; this file exercises the real implementation.

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// --- Shared observability ----------------------------------------------------

const callOrder: string[] = [];
const workerConv = { id: 'worker-db-id', platform_conversation_id: 'unset', hidden: true };

// --- Mock setup (BEFORE importing module under test) -------------------------

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mock(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: mock(() => '/home/test/.archon'),
}));

const mockGetOrCreateConversation = mock(() => {
  callOrder.push('getOrCreateConversation');
  return Promise.resolve(workerConv);
});
const mockUpdateConversation = mock(() => {
  callOrder.push('updateConversation');
  return Promise.resolve();
});
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

const mockGetCodebase = mock(() =>
  Promise.resolve({
    id: 'cb-1',
    name: 'test-repo',
    default_cwd: '/workspace/test-repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mock(() => Promise.resolve([])),
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

mock.module('../db/isolation-environments', () => ({
  createIsolationStore: mock(() => ({ updateStatus: mock(() => Promise.resolve()) })),
}));

// Freeze mock -- default resolves; individual tests override to reject.
const mockFreeze = mock(() => {
  callOrder.push('freeze');
  return Promise.resolve({ frozen: true });
});
mock.module('../workflows/work-order-source', () => ({
  freezeWorkOrderSource: mockFreeze,
}));

// Isolation resolver -- capture resolve() args to assert worker hints.
const mockResolve = mock((_input: unknown) => {
  callOrder.push('resolve');
  return Promise.resolve({ status: 'none' as const, cwd: '/workspace/worker' });
});
class MockIsolationResolver {
  resolve = mockResolve;
  constructor(_deps: unknown) {}
}
mock.module('@archon/isolation', () => ({
  IsolationResolver: MockIsolationResolver,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    constructor(
      message: string,
      public reason?: string
    ) {
      super(message);
      this.name = 'IsolationBlockedError';
    }
  },
  configureIsolation: mock(() => undefined),
  getIsolationProvider: mock(() => ({})),
}));

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    store: { createWorkflowRun: mock(() => Promise.resolve({ id: 'run-1' })) },
    getAgentProvider: () => ({}),
    loadConfig: async () => ({}),
  })),
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({})),
  loadRepoConfig: mock(() => Promise.resolve(null)),
}));

mock.module('../services/cleanup-service', () => ({
  cleanupToMakeRoom: mock(() => Promise.resolve({ removed: [] })),
  getWorktreeStatusBreakdown: mock(() => Promise.resolve({ active: 0, stale: 0, merged: 0 })),
  STALE_THRESHOLD_DAYS: 7,
}));

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(() =>
    Promise.resolve({ success: true, summary: '', workflowRunId: 'run-1' })
  ),
}));

// Dynamic imports inside dispatchBackgroundWorkflow (escalation linker).
mock.module('../escalation', () => ({
  prepareDispatchWithEscalation: mock((userMessage: string) =>
    Promise.resolve({
      userMessage,
      link: { woId: undefined, escalatedRunIds: [], packet: '' },
    })
  ),
}));
mock.module('../db/workflows', () => ({
  listWorkflowRuns: mock(() => Promise.resolve([])),
  updateWorkflowRun: mock(() => Promise.resolve()),
}));
mock.module('../db/workflow-events', () => ({
  listWorkflowEvents: mock(() => Promise.resolve([])),
}));

// --- Import module under test AFTER all mocks --------------------------------

const { dispatchBackgroundWorkflow } = await import('./orchestrator');

// --- Helpers -----------------------------------------------------------------

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'bdc-feature-development',
    description: 'test workflow',
    steps: [],
    ...overrides,
  } as unknown as WorkflowDefinition;
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    platform: new MockPlatformAdapter(),
    conversationId: 'parent-platform-conv',
    cwd: '/workspace/test-repo',
    originalMessage: '/workflow run bdc-feature-development --from origin/release/ce',
    conversationDbId: 'parent-db-id',
    codebaseId: 'cb-1',
    availableWorkflows: [],
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe('dispatchBackgroundWorkflow (real implementation)', () => {
  beforeEach(() => {
    callOrder.length = 0;
    mockResolve.mockClear();
    mockGetOrCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockFreeze.mockClear();
    mockGetCodebase.mockClear();
    mockResolve.mockImplementation((_input: unknown) => {
      callOrder.push('resolve');
      return Promise.resolve({ status: 'none' as const, cwd: '/workspace/worker' });
    });
    // Restore default freeze behavior (a test overrides it to reject).
    mockFreeze.mockImplementation(() => {
      callOrder.push('freeze');
      return Promise.resolve({ frozen: true });
    });
  });

  test('preserves task + fromBranch hints and assigns a unique worker workflowId', async () => {
    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/release/ce',
      },
    });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    expect(mockResolve).toHaveBeenCalledTimes(1);
    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints).toBeDefined();
    expect(resolveArg.hints?.workflowType).toBe('task');
    expect(resolveArg.hints?.fromBranch).toBe('origin/release/ce');
    // The worker gets its OWN unique id, not the parent's conversation id.
    expect(resolveArg.hints?.workflowId).not.toBe('parent-platform-conv');
    expect(String(resolveArg.hints?.workflowId)).toMatch(/^web-worker-/);
  });

  test('no isolation hints -> preserves thread default with worker workflowId', async () => {
    const ctx = makeCtx({ isolationHints: undefined });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    expect(mockResolve).toHaveBeenCalledTimes(1);
    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.workflowType).toBe('thread');
    expect(resolveArg.hints?.fromBranch).toBeUndefined();
    expect(String(resolveArg.hints?.workflowId)).toMatch(/^web-worker-/);
  });

  test('two fires create distinct workers, branches, worktrees, and environments', async () => {
    const environments: Array<{
      id: string;
      branch_name: string;
      working_path: string;
    }> = [];
    mockResolve.mockImplementation((input: unknown) => {
      callOrder.push('resolve');
      const hints = (input as { hints?: Record<string, unknown> }).hints;
      const workerId = String(hints?.workflowId);
      const env = {
        id: `env-${workerId}`,
        codebase_id: 'cb-1',
        workflow_type: 'task' as const,
        workflow_id: workerId,
        provider: 'worktree' as const,
        working_path: `/worktrees/${workerId}`,
        branch_name: `archon/${workerId}`,
        status: 'active' as const,
        created_at: new Date(),
        created_by_platform: 'web',
        metadata: {},
      };
      environments.push(env);
      return Promise.resolve({
        status: 'resolved' as const,
        cwd: env.working_path,
        env,
        method: { type: 'created' as const },
      });
    });

    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/release/ce',
      },
    });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());
    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenCalledTimes(2);
    const workerIds = mockGetOrCreateConversation.mock.calls.map(call => String(call[1]));
    const resolveHints = mockResolve.mock.calls.map(
      call => (call[0] as { hints?: Record<string, unknown> }).hints
    );
    expect(new Set(workerIds).size).toBe(2);
    expect(resolveHints.map(hints => hints?.workflowId)).toEqual(workerIds);
    expect(resolveHints.map(hints => hints?.workflowType)).toEqual(['task', 'task']);
    expect(resolveHints.map(hints => hints?.fromBranch)).toEqual([
      'origin/release/ce',
      'origin/release/ce',
    ]);
    expect(new Set(environments.map(env => env.id)).size).toBe(2);
    expect(new Set(environments.map(env => env.branch_name)).size).toBe(2);
    expect(new Set(environments.map(env => env.working_path)).size).toBe(2);
  });

  test('thread-typed hints are NOT promoted to task', async () => {
    const ctx = makeCtx({
      isolationHints: { workflowType: 'thread', workflowId: 'parent-platform-conv' },
    });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.workflowType).toBe('thread');
    expect(resolveArg.hints?.fromBranch).toBeUndefined();
  });

  test('run_authority freeze precedes worker conversation creation and isolation', async () => {
    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/release/ce',
      },
    });
    const workflow = makeWorkflow({
      run_authority: {
        required: true,
        spec_repository: 'owner/repo',
        spec_revision: 'abc123',
        spec_paths: ['docs/x.md'],
      },
    } as Partial<WorkflowDefinition>);

    await dispatchBackgroundWorkflow(ctx as never, workflow);

    expect(mockFreeze).toHaveBeenCalledTimes(1);
    const freezeIdx = callOrder.indexOf('freeze');
    const convIdx = callOrder.indexOf('getOrCreateConversation');
    const resolveIdx = callOrder.indexOf('resolve');
    expect(freezeIdx).toBe(0);
    expect(convIdx).toBeGreaterThan(freezeIdx);
    expect(resolveIdx).toBeGreaterThan(convIdx);
  });

  test('freeze rejection creates no worker conversation or isolation', async () => {
    mockFreeze.mockImplementationOnce(() => {
      callOrder.push('freeze');
      return Promise.reject(new Error('run_authority freeze failed'));
    });
    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/release/ce',
      },
    });
    const workflow = makeWorkflow({
      run_authority: {
        required: true,
        spec_repository: 'owner/repo',
        spec_revision: 'abc123',
        spec_paths: ['docs/x.md'],
      },
    } as Partial<WorkflowDefinition>);

    await expect(dispatchBackgroundWorkflow(ctx as never, workflow)).rejects.toThrow(
      'run_authority freeze failed'
    );

    expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(0);
    expect(mockUpdateConversation).toHaveBeenCalledTimes(0);
    expect(mockResolve).toHaveBeenCalledTimes(0);
  });
});
