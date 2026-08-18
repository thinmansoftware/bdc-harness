// WO-HARNESS-BASE-LANE-AUTHORITY-01 -- Test 1 (disjoint-lane declared base).
//
// Exercises the REAL dispatchBackgroundWorkflow() and the REAL
// parseDeclaredBaseBranch() parser. Asserts that when the frozen WO spec declares
// a "Base branch:" (e.g. an orphan release/ce lane disjoint from main), the worker
// isolation resolve() is driven to cut the worktree from origin/<declared> --
// making the pinned authority triple lane-correct by construction -- INDEPENDENT of
// (and overriding) any inherited parent hints. Also asserts:
//  - a declared base that does not exist on origin fails fast (no worktree cut);
//  - a spec with no declared base preserves today's parent-hint / thread behavior.
//
// Only dependencies are mocked; the parser and dispatch control flow are real, so
// this test would fail if the declared-base wiring regressed.

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

const workerConv = { id: 'worker-db-id', platform_conversation_id: 'unset', hidden: true };

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mock(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: mock(() => '/home/test/.archon'),
}));

mock.module('../db/conversations', () => ({
  getOrCreateConversation: mock(() => Promise.resolve(workerConv)),
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mock(() => Promise.resolve()),
  touchConversation: mock(() => Promise.resolve()),
}));

mock.module('../db/codebases', () => ({
  getCodebase: mock(() =>
    Promise.resolve({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/workspace/test-repo',
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    })
  ),
  listCodebases: mock(() => Promise.resolve([])),
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

mock.module('../db/isolation-environments', () => ({
  createIsolationStore: mock(() => ({ updateStatus: mock(() => Promise.resolve()) })),
}));

// Freeze mock -- each test sets specBytes via mockFreeze.mockImplementation.
const mockFreeze = mock(() =>
  Promise.resolve({
    woId: 'WO-X',
    specSource: 's',
    specRevision: 'r',
    specBytes: Buffer.from('no base here'),
  })
);
mock.module('../workflows/work-order-source', () => ({
  freezeWorkOrderSource: mockFreeze,
}));

// node:child_process execFile drives originBranchExists' `git ls-remote` check
// (orchestrator wraps it with util.promisify). Control success/failure per test.
type ExecCb = (err: Error | null, stdout?: string, stderr?: string) => void;
let lsRemoteShouldFail = false;
const execFileCalls: Array<{ file: string; args: string[] }> = [];
mock.module('node:child_process', () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: ExecCb) => {
    execFileCalls.push({ file, args });
    if (lsRemoteShouldFail) callback(new Error('ls-remote --exit-code: no match'));
    else callback(null, '', '');
  },
}));

const mockResolve = mock((_input: unknown) =>
  Promise.resolve({ status: 'none' as const, cwd: '/workspace/worker' })
);
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

const { dispatchBackgroundWorkflow } = await import('./orchestrator');

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'bdc-feature-development',
    description: 'test workflow',
    steps: [],
    run_authority: {
      required: true,
      spec_repository: 'owner/repo',
      spec_revision: 'abc123',
      spec_paths: ['docs/x.md'],
    },
    ...overrides,
  } as unknown as WorkflowDefinition;
}

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    platform: new MockPlatformAdapter(),
    conversationId: 'parent-platform-conv',
    cwd: '/workspace/test-repo',
    originalMessage: '/workflow run bdc-feature-development WO-X',
    conversationDbId: 'parent-db-id',
    codebaseId: 'cb-1',
    availableWorkflows: [],
    ...overrides,
  };
}

function freezeWithSpec(specText: string): void {
  mockFreeze.mockImplementation(() =>
    Promise.resolve({
      woId: 'WO-X',
      specSource: 's',
      specRevision: 'r',
      specBytes: Buffer.from(specText),
    })
  );
}

describe('dispatchBackgroundWorkflow declared base-lane authority', () => {
  beforeEach(() => {
    mockResolve.mockClear();
    mockFreeze.mockClear();
    execFileCalls.length = 0;
    lsRemoteShouldFail = false;
    freezeWithSpec('no base here');
  });

  test('declared "Base branch: release/ce" cuts the worker worktree from origin/release/ce', async () => {
    freezeWithSpec('# WO-X\n\nBase branch: release/ce\n\nBody...');
    // No parent hints at all: the declared base alone must drive a task worktree.
    const ctx = makeCtx({ isolationHints: undefined });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    // Declared base validated against origin before allocation.
    expect(execFileCalls.length).toBe(1);
    expect(execFileCalls[0].file).toBe('git');
    expect(execFileCalls[0].args).toContain('ls-remote');
    expect(execFileCalls[0].args).toContain('refs/heads/release/ce');

    expect(mockResolve).toHaveBeenCalledTimes(1);
    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.workflowType).toBe('task');
    expect(resolveArg.hints?.fromBranch).toBe('origin/release/ce');
    expect(String(resolveArg.hints?.workflowId)).toMatch(/^web-worker-/);
  });

  test('declared base overrides a DIFFERENT inherited parent from-branch', async () => {
    freezeWithSpec('Base branch: release/ce\n');
    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/dev',
      },
    });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.fromBranch).toBe('origin/release/ce');
  });

  test('markdown-bold "**Base branch:** `release/ce`" form is honored', async () => {
    freezeWithSpec('Header\n**Base branch:** `release/ce`\nmore\n');
    const ctx = makeCtx({ isolationHints: undefined });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.fromBranch).toBe('origin/release/ce');
  });

  test('declared base missing on origin -> fail fast, no worktree cut', async () => {
    freezeWithSpec('Base branch: release/does-not-exist\n');
    lsRemoteShouldFail = true;
    const ctx = makeCtx({ isolationHints: undefined });

    await expect(dispatchBackgroundWorkflow(ctx as never, makeWorkflow())).rejects.toThrow(
      /declared_base_branch_not_found/
    );
    expect(mockResolve).toHaveBeenCalledTimes(0);
  });

  test('no declared base -> preserves inherited parent task hint (no ls-remote)', async () => {
    freezeWithSpec('# WO-X\n\nNo base declared here.\n');
    const ctx = makeCtx({
      isolationHints: {
        workflowType: 'task',
        workflowId: 'parent-platform-conv',
        fromBranch: 'origin/dev',
      },
    });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    expect(execFileCalls.length).toBe(0);
    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.workflowType).toBe('task');
    expect(resolveArg.hints?.fromBranch).toBe('origin/dev');
  });

  test('no declared base and no parent hints -> plain thread isolation', async () => {
    freezeWithSpec('No base at all.\n');
    const ctx = makeCtx({ isolationHints: undefined });

    await dispatchBackgroundWorkflow(ctx as never, makeWorkflow());

    expect(execFileCalls.length).toBe(0);
    const resolveArg = mockResolve.mock.calls[0][0] as { hints?: Record<string, unknown> };
    expect(resolveArg.hints?.workflowType).toBe('thread');
    expect(resolveArg.hints?.fromBranch).toBeUndefined();
  });
});
