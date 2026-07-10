import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  mockAllWorkflowModules,
  mockDiscoverWorkflowsWithConfig,
} from '../test/workflow-mock-factories';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set. Clear it at module level so these tests run
// deterministically in container envs (Cauldron build image exports this var).
// Tests that need to exercise the auth gate set the token in their own scope.
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

// ---------------------------------------------------------------------------
// Mock setup -- must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockCancelWorkflowRun = mock(async (_id: string) => {});
const mockListWorkflowRuns = mock(async () => [] as MockWorkflowRun[]);
const mockSumWorkflowTokensInWindow = mock(
  async (_opts: { sinceMs: number; codebaseId?: string }) => 0
);
const mockListDashboardRuns = mock(async () => ({
  runs: [] as MockWorkflowRun[],
  total: 0,
  counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
}));
const mockGetWorkflowRunByWorkerPlatformId = mock(
  async (_id: string) => null as null | MockWorkflowRun
);
const mockListWorkflowEvents = mock(async (_runId: string) => [] as MockWorkflowEvent[]);
const mockListNodeEvents = mock(
  async (_runId: string, _stepName: string, _limit: number) => [] as MockWorkflowEvent[]
);
const mockGetConversationById = mock(
  async (_id: string) =>
    null as null | { id: string; platform_conversation_id: string; platform_type: string }
);
const mockFindConversationByPlatformId = mock(
  async (_id: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      ai_assistant_type: string;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockHandleMessage = mock(async () => {});
const mockAddMessage = mock(async () => ({
  id: 'msg-1',
  conversation_id: 'conv-1',
  role: 'user' as const,
  content: 'hi',
  metadata: '{}',
  created_at: new Date().toISOString(),
}));
const mockGenerateAndSetTitle = mock(async () => {});
const mockExecuteWorkflow = mock(async () => ({
  success: true,
  workflowRunId: 'run-uuid-approval',
}));
const mockCreateWorkflowDeps = mock(() => ({ store: {} }));
const mockResolveWebLane = mock(
  async (req: { workflowName?: string; task_class?: string; routerYamlPath: string }) =>
    req.workflowName ?? undefined
);
const normalDrainState = {
  mode: 'normal' as const,
  activeLeaseCount: 0,
  activeRunCount: 0,
  activeRunIds: [] as string[],
  drained: false,
  updatedAt: null as string | null,
};
const mockGetCauldronDrainState = mock(async () => normalDrainState);
const mockSetCauldronDrainMode = mock(async (data: { mode: 'normal' | 'draining' }) => ({
  changed: true,
  mode: data.mode,
}));

// Type aliases for clarity in tests
type MockWorkflowRun = {
  id: string;
  workflow_name: string;
  conversation_id: string | null;
  parent_conversation_id: string | null;
  codebase_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  user_message: string;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  working_path: string | null;
  last_activity_at: string | null;
};

type MockWorkflowEvent = {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mockGenerateAndSetTitle,
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mockAllWorkflowModules();

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

mock.module('../adapters/web/workflow-bridge', () => ({
  resolveWebLane: mockResolveWebLane,
}));

mock.module('@archon/core/workflows', () => ({
  createWorkflowDeps: mockCreateWorkflowDeps,
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mockGetConversationById,
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

const mockDeleteWorkflowRun = mock(async (_id: string) => {});
const mockUpdateWorkflowRun = mock(async (_id: string, _update: unknown) => {});

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: mockListDashboardRuns,
  getWorkflowRun: mockGetWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  deleteWorkflowRun: mockDeleteWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  getWorkflowRunByWorkerPlatformId: mockGetWorkflowRunByWorkerPlatformId,
  sumWorkflowTokensInWindow: mockSumWorkflowTokensInWindow,
  getCauldronDrainState: mockGetCauldronDrainState,
  setCauldronDrainMode: mockSetCauldronDrainMode,
}));

const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mockListWorkflowEvents,
  listNodeEvents: mockListNodeEvents,
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const MOCK_RUNNING_RUN: MockWorkflowRun = {
  id: 'run-uuid-1',
  workflow_name: 'deploy',
  conversation_id: 'conv-uuid-1',
  parent_conversation_id: null,
  codebase_id: 'cb-uuid-1',
  status: 'running',
  user_message: 'Deploy to staging',
  started_at: NOW,
  completed_at: null,
  metadata: {},
  working_path: '/tmp/worktrees/feature',
  last_activity_at: NOW,
};

const MOCK_COMPLETED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-2',
  status: 'completed',
  completed_at: NOW,
};

const MOCK_FAILED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-4',
  status: 'failed',
  completed_at: NOW,
};

const MOCK_PAUSED_INTERACTIVE_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-approval',
  workflow_name: 'build-portal-login-phone-pin',
  conversation_id: 'worker-conv-uuid',
  parent_conversation_id: 'parent-conv-uuid',
  status: 'paused',
  completed_at: null,
  user_message: 'Build the portal login',
  working_path: '/tmp/worktrees/portal-login',
  metadata: {
    approval: {
      nodeId: 'human-approve',
      message: 'Approve PR creation?',
      type: 'interactive_loop',
    },
  },
};

// Standard (non-loop) approval-gate pause, mirroring bdc-harness-wo-onramp's
// `approval-gate` node. The onramp incident (run 032da37, 2026-06-09) paused
// here and a re-submitted Approve must be idempotent, not a confusing 400.
const MOCK_PAUSED_STANDARD_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-standard-approval',
  workflow_name: 'bdc-harness-wo-onramp',
  conversation_id: 'worker-conv-uuid',
  parent_conversation_id: 'parent-conv-uuid',
  status: 'paused',
  completed_at: null,
  user_message: 'On-ramp the WO',
  working_path: '/tmp/worktrees/onramp',
  metadata: {
    approval: {
      nodeId: 'approval-gate',
      message: 'Review the pre-fire packet above.',
      type: 'approval',
    },
  },
};

// Same run AFTER a successful approve: the approve route flips status to the
// 'failed' auto-resume sentinel and records approval_response=approved. A
// duplicate click (the user clicking again because the UI looked stuck) lands
// here and MUST be treated as already-approved, not rejected with a 400.
const MOCK_ALREADY_APPROVED_RUN: MockWorkflowRun = {
  ...MOCK_PAUSED_STANDARD_RUN,
  status: 'failed',
  metadata: {
    approval: {
      nodeId: 'approval-gate',
      message: 'Review the pre-fire packet above.',
      type: 'approval',
    },
    approval_response: 'approved',
    rejection_reason: '',
    rejection_count: 0,
  },
};

const MOCK_PENDING_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-3',
  status: 'pending',
};

const MOCK_EVENTS: MockWorkflowEvent[] = [
  {
    id: 'evt-1',
    workflow_run_id: 'run-uuid-1',
    event_type: 'step_started',
    step_index: 0,
    step_name: 'plan',
    data: {},
    created_at: NOW,
  },
  {
    id: 'evt-2',
    workflow_run_id: 'run-uuid-1',
    event_type: 'step_completed',
    step_index: 0,
    step_name: 'plan',
    data: { duration_ms: 1234 },
    created_at: NOW,
  },
  {
    id: 'evt-3',
    workflow_run_id: 'run-uuid-1',
    event_type: 'tool_called',
    step_index: 0,
    step_name: 'plan',
    data: { tool_name: 'Read', tool_input: { file_path: '/tmp/test.ts' } },
    created_at: NOW,
  },
];

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  ai_assistant_type: 'claude',
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

function makeApp(): { app: OpenAPIHono; mockWebAdapter: WebAdapter } {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    setupEventBridge: mock((_workerId: string, _parentId: string) => mock(() => {})),
    sendMessage: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return { app, mockWebAdapter };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/:name/run
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:name/run', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
    mockGenerateAndSetTitle.mockReset();
    mockGetCauldronDrainState.mockReset();
    mockGetCauldronDrainState.mockResolvedValue(normalDrainState);
    // Pre-dispatch validation resolves the workflow name against discovery
    // before accepting -- seed the names these tests dispatch.
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [
        { workflow: { name: 'deploy' } as never, source: 'project' as const },
        { workflow: { name: 'test-suite' } as never, source: 'project' as const },
      ],
      errors: [],
    }));
  });

  afterEach(() => {
    // Restore the factory default ([] workflows) for other describes.
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [],
      errors: [],
    }));
  });

  test('rejects a nonexistent workflow name with accepted:false before dispatch', async () => {
    // Regression: 2026-07-07 false-dispatch incident -- unknown lane names
    // must be rejected at the API boundary, not accepted then failed
    // in-conversation with no run row.
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Go',
      metadata: '{}',
      created_at: NOW,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/no-such-lane/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { accepted: boolean; error: string };
    expect(body.accepted).toBe(false);
    expect(body.error).toContain('no-such-lane');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('dispatches workflow run to orchestrator and returns accepted', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy to staging',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('started');
  });

  test('rejects new workflow dispatch while draining without touching in-flight work', async () => {
    mockGetCauldronDrainState.mockResolvedValueOnce({
      ...normalDrainState,
      mode: 'draining',
      activeLeaseCount: 1,
      activeRunCount: 1,
      activeRunIds: ['run-active'],
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    expect(response.status).toBe(503);
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('sends /workflow run <name> <message> to orchestrator', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Run tests',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Run tests' }),
    });

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run test-suite Run tests',
      expect.objectContaining({
        isolationHints: { workflowType: 'thread', workflowId: 'web-test-abc' },
      })
    );
  });

  test('persists user message to DB when conversation found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(MOCK_CONV.id, 'user', 'Deploy');
  });

  test('fires title generation for conversations without title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => ({
      ...MOCK_CONV,
      title: null,
    }));
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    // generateAndSetTitle is fire-and-forget; just verify it was called
    // (it runs asynchronously so we check the mock was called, not the result)
    // Allow the microtask queue to flush
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGenerateAndSetTitle).toHaveBeenCalled();
  });

  test('returns 400 when conversationId is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 when message is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  test('returns 400 for invalid workflow name (path traversal)', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/../secret/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    // Hono routes won't match ../secret as /:name due to path normalization -- either 400 or 404
    expect([400, 404]).toContain(response.status);
  });

  test('returns 400 when isValidCommandName rejects the name', async () => {
    const { isValidCommandName } = await import('@archon/workflows/command-validation');
    (isValidCommandName as ReturnType<typeof mock>).mockReturnValueOnce(false);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/.hidden/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET/POST /api/admin/drain', () => {
  beforeEach(() => {
    mockGetCauldronDrainState.mockReset();
    mockGetCauldronDrainState.mockResolvedValue(normalDrainState);
    mockSetCauldronDrainMode.mockReset();
    mockSetCauldronDrainMode.mockImplementation(async data => ({
      changed: true,
      mode: data.mode,
    }));
  });

  test('reuses operator authentication for drain controls', async () => {
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
    try {
      const { app } = makeApp();
      const response = await app.request('/api/admin/drain');
      expect(response.status).toBe(401);
      expect(mockGetCauldronDrainState).not.toHaveBeenCalled();
    } finally {
      if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
    }
  });

  test('enables drain idempotently and reports active work without cancelling it', async () => {
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
    mockGetCauldronDrainState.mockResolvedValue({
      ...normalDrainState,
      mode: 'draining',
      activeLeaseCount: 1,
      activeRunCount: 1,
      activeRunIds: ['run-active'],
    });
    try {
      const { app } = makeApp();
      const response = await app.request('/api/admin/drain', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-operator-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ draining: true, reason: 'maintenance' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        mode: string;
        activeRunIds: string[];
        drained: boolean;
      };
      expect(body).toMatchObject({
        mode: 'draining',
        activeRunIds: ['run-active'],
        drained: false,
      });
      expect(mockSetCauldronDrainMode).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'draining',
          actor: 'operator',
          reason: 'maintenance',
        })
      );
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    } finally {
      if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/cancel
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/cancel', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
  });

  test('cancels a running workflow run and returns success', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('deploy');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1');
  });

  test('cancels a pending workflow run and returns success', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PENDING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-3/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 422 when trying to cancel a completed run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_COMPLETED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(422);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('completed');
  });

  test('returns 409 when trying to cancel an already-cancelled run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(409);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('cancelled');
  });

  test('returns 422 when trying to cancel a failed run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'failed' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(422);
  });

  test('returns 500 when DB throws during cancel', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB locked');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to cancel');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/approve
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/approve', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
    mockGetConversationById.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockExecuteWorkflow.mockReset();
    mockCreateWorkflowDeps.mockReset();
    mockResolveWebLane.mockReset();
    mockCreateWorkflowDeps.mockImplementation(() => ({ store: {} }));
    mockResolveWebLane.mockImplementation(
      async (req: { workflowName?: string; task_class?: string; routerYamlPath: string }) =>
        req.workflowName ?? undefined
    );
    mockExecuteWorkflow.mockImplementation(async () => ({
      success: true,
      workflowRunId: 'run-uuid-approval',
    }));
  });

  test('stores interactive_loop input and starts executor resume directly', async () => {
    const workflow = {
      name: 'build-portal-login-phone-pin',
      description: 'fixture workflow',
      nodes: [],
    };
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PAUSED_INTERACTIVE_RUN);
    mockGetConversationById.mockImplementation(async (id: string) => {
      if (id === 'parent-conv-uuid') {
        return {
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-parent-abc',
          platform_type: 'web',
        };
      }
      if (id === 'worker-conv-uuid') {
        return {
          id: 'worker-conv-uuid',
          platform_conversation_id: 'web-worker-xyz',
          platform_type: 'web',
        };
      }
      return null;
    });
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
      workflows: [{ workflow: workflow as never, source: 'project' }],
      errors: [],
    }));

    const { app, mockWebAdapter } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-approval/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'approved' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Resuming workflow');

    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-uuid-approval', {
      status: 'failed',
      metadata: { loop_user_input: 'approved' },
    });
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/tmp/worktrees/portal-login',
      expect.any(Function)
    );
    expect(mockResolveWebLane).toHaveBeenCalledWith({
      workflowName: 'build-portal-login-phone-pin',
      task_class: undefined,
      routerYamlPath: join('/tmp/worktrees/portal-login', 'config', 'router.yaml'),
    });
    expect(mockWebAdapter.setConversationDbId).toHaveBeenCalledWith(
      'web-worker-xyz',
      'worker-conv-uuid'
    );
    expect(mockWebAdapter.setupEventBridge).toHaveBeenCalledWith(
      'web-worker-xyz',
      'web-parent-abc'
    );
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      mockWebAdapter,
      'web-worker-xyz',
      '/tmp/worktrees/portal-login',
      workflow,
      'Build the portal login',
      'worker-conv-uuid',
      'cb-uuid-1',
      undefined,
      undefined,
      'parent-conv-uuid'
    );
  });

  test('routes auto-resume through Layer 2 when metadata carries task_class', async () => {
    const workflow = {
      name: 'bdc-feature-development-codex',
      description: 'resolved workflow',
      nodes: [],
    };
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_PAUSED_INTERACTIVE_RUN,
      workflow_name: '',
      metadata: {
        ...MOCK_PAUSED_INTERACTIVE_RUN.metadata,
        task_class: 'single-builder-pr',
      },
    }));
    mockGetConversationById.mockImplementation(async (id: string) => {
      if (id === 'parent-conv-uuid') {
        return {
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-parent-abc',
          platform_type: 'web',
        };
      }
      if (id === 'worker-conv-uuid') {
        return {
          id: 'worker-conv-uuid',
          platform_conversation_id: 'web-worker-xyz',
          platform_type: 'web',
        };
      }
      return null;
    });
    mockResolveWebLane.mockImplementationOnce(async () => 'bdc-feature-development-codex');
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
      workflows: [{ workflow: workflow as never, source: 'project' }],
      errors: [],
    }));

    const { app, mockWebAdapter } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-approval/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'approved' }),
    });

    expect(response.status).toBe(200);
    expect(mockResolveWebLane).toHaveBeenCalledWith({
      workflowName: undefined,
      task_class: 'single-builder-pr',
      routerYamlPath: join('/tmp/worktrees/portal-login', 'config', 'router.yaml'),
    });
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      mockWebAdapter,
      'web-worker-xyz',
      '/tmp/worktrees/portal-login',
      workflow,
      'Build the portal login',
      'worker-conv-uuid',
      'cb-uuid-1',
      undefined,
      undefined,
      'parent-conv-uuid'
    );
  });

  test('records gate decision but does not resume when workflow definition is missing', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PAUSED_INTERACTIVE_RUN);
    mockGetConversationById.mockImplementation(async (id: string) => {
      if (id === 'parent-conv-uuid') {
        return {
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-parent-abc',
          platform_type: 'web',
        };
      }
      if (id === 'worker-conv-uuid') {
        return {
          id: 'worker-conv-uuid',
          platform_conversation_id: 'web-worker-xyz',
          platform_type: 'web',
        };
      }
      return null;
    });
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
      workflows: [],
      errors: [],
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-approval/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'approved' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Send a message to continue');
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-uuid-approval', {
      status: 'failed',
      metadata: { loop_user_input: 'approved' },
    });
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  // WO-MC-APPROVE-GATE-RELIABILITY-01: idempotency. The 2026-06-09 onramp
  // incident showed users re-clicking Approve when the UI looked stuck. A
  // duplicate approve on an already-approved run previously returned 400
  // "Cannot approve workflow in 'failed' status" -- indistinguishable from a
  // real failure. It must now report success (already approved) and NOT write
  // a second approval_received event.
  test('idempotent: re-approving an already-approved run returns success, no duplicate event', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_ALREADY_APPROVED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-standard-approval/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'approved' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/already approved/i);
    // No new approval_received event written on the duplicate.
    const approvalReceivedCalls = mockCreateWorkflowEvent.mock.calls.filter(
      call => (call[0] as { event_type?: string }).event_type === 'approval_received'
    );
    expect(approvalReceivedCalls.length).toBe(0);
    // Status is NOT re-mutated on the duplicate.
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  // WO-MC-APPROVE-GATE-RELIABILITY-01: a standard (non-loop) approval gate --
  // the exact shape the onramp run paused on -- records approval_received and
  // a node_completed exactly once on the first submit.
  test('standard approval gate records approval_received once on first submit', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PAUSED_STANDARD_RUN);
    mockGetConversationById.mockImplementation(async () => null); // no auto-resume; just record

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-standard-approval/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'Approved' }),
    });

    expect(response.status).toBe(200);
    const approvalReceivedCalls = mockCreateWorkflowEvent.mock.calls.filter(
      call => (call[0] as { event_type?: string }).event_type === 'approval_received'
    );
    expect(approvalReceivedCalls.length).toBe(1);
    expect((approvalReceivedCalls[0]?.[0] as { step_name?: string }).step_name).toBe(
      'approval-gate'
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockReset();
    mockListWorkflowEvents.mockReset();
  });

  test('requires operator token when ARCHON_OPERATOR_TOKEN is configured', async () => {
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);
    try {
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs');

      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('operator token');
      expect(mockListWorkflowRuns).not.toHaveBeenCalled();
    } finally {
      if (previousToken === undefined) {
        delete process.env.ARCHON_OPERATOR_TOKEN;
      } else {
        process.env.ARCHON_OPERATOR_TOKEN = previousToken;
      }
    }
  });

  test('accepts a valid bearer operator token for private workflow runs', async () => {
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);
    try {
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs', {
        headers: { Authorization: 'Bearer test-operator-token' },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: Array<{ id: string }> };
      expect(body.runs[0]?.id).toBe('run-uuid-1');
    } finally {
      if (previousToken === undefined) {
        delete process.env.ARCHON_OPERATOR_TOKEN;
      } else {
        process.env.ARCHON_OPERATOR_TOKEN = previousToken;
      }
    }
  });

  test('public workflow runs endpoint returns sanitized workflow and node progress without a token', async () => {
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
    mockListWorkflowRuns.mockImplementationOnce(async () => [
      {
        ...MOCK_RUNNING_RUN,
        workflow_name: 'bdc-feature-development',
        metadata: { cost_usd: 12.34, prompt: 'private prompt' },
        user_message: 'ship the secret thing',
        working_path: 'C:/Users/pcmed/private/worktree',
      },
    ]);
    mockListWorkflowEvents.mockImplementationOnce(async () => [
      {
        id: 'evt-secret-1',
        workflow_run_id: 'run-uuid-1',
        event_type: 'node_started',
        step_index: 0,
        step_name: 'read-spec',
        data: {
          prompt: 'private node prompt',
          node_output: 'private node output',
          working_path: 'C:/Users/pcmed/private/worktree',
        },
        created_at: NOW,
      },
      {
        id: 'evt-secret-2',
        workflow_run_id: 'run-uuid-1',
        event_type: 'node_completed',
        step_index: 0,
        step_name: 'read-spec',
        data: { costUsd: 99, node_output: 'private node output' },
        created_at: NOW,
      },
      {
        id: 'evt-secret-3',
        workflow_run_id: 'run-uuid-1',
        event_type: 'node_started',
        step_index: 1,
        step_name: 'implement-fix',
        data: { tool_input: { file_path: 'C:/Users/pcmed/private/source.ts' } },
        created_at: NOW,
      },
    ]);
    try {
      const { app } = makeApp();
      const response = await app.request('/api/public/workflows/runs');

      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: Array<Record<string, unknown>> };
      expect(body.runs).toEqual([
        {
          workflow_label: 'Feature Development',
          status: 'running',
          started_at: MOCK_RUNNING_RUN.started_at,
          completed_at: null,
          last_activity_at: MOCK_RUNNING_RUN.last_activity_at,
          nodes: [
            {
              label: 'Read Spec',
              status: 'completed',
              updated_at: NOW,
            },
            {
              label: 'Implement Fix',
              status: 'running',
              updated_at: NOW,
            },
          ],
        },
      ]);
      expect(JSON.stringify(body)).not.toContain('run-uuid-1');
      expect(JSON.stringify(body)).not.toContain('conv-uuid-1');
      expect(JSON.stringify(body)).not.toContain('cb-uuid-1');
      expect(JSON.stringify(body)).not.toContain('evt-secret');
      expect(JSON.stringify(body)).not.toContain('workflow_run_id');
      expect(JSON.stringify(body)).not.toContain('private prompt');
      expect(JSON.stringify(body)).not.toContain('private node prompt');
      expect(JSON.stringify(body)).not.toContain('private node output');
      expect(JSON.stringify(body)).not.toContain('deploy');
      expect(JSON.stringify(body)).not.toContain('ship the secret thing');
      expect(JSON.stringify(body)).not.toContain('private/worktree');
      expect(JSON.stringify(body)).not.toContain('cost_usd');
      expect(JSON.stringify(body)).not.toContain('costUsd');
      expect(JSON.stringify(body)).not.toContain('tool_input');
    } finally {
      if (previousToken === undefined) {
        delete process.env.ARCHON_OPERATOR_TOKEN;
      } else {
        process.env.ARCHON_OPERATOR_TOKEN = previousToken;
      }
    }
  });

  test('returns empty runs array when no runs exist', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(0);
  });

  test('returns list of workflow runs', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN, MOCK_COMPLETED_RUN]);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.id).toBe('run-uuid-1');
  });

  test('filters by status query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=running');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [
      [{ status?: string; limit?: number }],
    ][];
    expect(callArgs?.status).toBe('running');
  });

  test('ignores invalid status values', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=invalid_status');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [
      [{ status?: string; limit?: number }],
    ][];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by conversationId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?conversationId=conv-123');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ conversationId?: string }]][];
    expect(callArgs?.conversationId).toBe('conv-123');
  });

  test('filters by codebaseId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?codebaseId=cb-uuid-1');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ codebaseId?: string }]][];
    expect(callArgs?.codebaseId).toBe('cb-uuid-1');
  });

  test('caps limit at 200', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?limit=9999');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ limit?: number }]][];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('uses default limit of 50 when not specified', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ limit?: number }]][];
    expect(callArgs?.limit).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => {
      throw new Error('DB failure');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list workflow runs');
  });

  // -------------------------------------------------------------------------
  // WO-HARNESS-TOKEN-ATTRIBUTION-01 -- Scenario 5: quota window summary
  // -------------------------------------------------------------------------
  // computeQuotaWindow reads process.env at CALL time (not at module load),
  // so these tests set/unset MAX20X_WINDOW_TOKENS inline within each case and
  // rely on that design for the override to take effect without mock.module()
  // or a separate process. windowTokens comes from a SEPARATE DB call
  // (sumWorkflowTokensInWindow) -- independent of the runs-page LIMIT -- so
  // these tests stub that mock rather than computing from the listed runs.

  test('Scenario 5A -- quotaWindow includes windowTokens + windowBudget when MAX20X_WINDOW_TOKENS configured', async () => {
    const recent = new Date().toISOString();
    const runWithTokens: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-a-1',
      metadata: { total_tokens: 1000 },
      last_activity_at: recent,
      started_at: recent,
    };
    const runWithTokens2: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-a-2',
      metadata: { total_tokens: 1000 },
      last_activity_at: recent,
      started_at: recent,
    };
    mockListWorkflowRuns.mockImplementationOnce(async () => [runWithTokens, runWithTokens2]);
    // Authoritative quota sum comes from the DB aggregation -- independent of
    // the page-of-runs.
    mockSumWorkflowTokensInWindow.mockImplementationOnce(async () => 2000);

    process.env['MAX20X_WINDOW_TOKENS'] = '40000';
    try {
      const { app } = makeApp();
      const response = await app.request('/api/workflows/runs');
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        runs: Array<{ id: string }>;
        quotaWindow: {
          windowTokens: number;
          windowBudget: number | null;
          windowResetAt: string;
        };
      };
      expect(body.runs.length).toBe(2);
      expect(body.quotaWindow.windowTokens).toBe(2000);
      expect(body.quotaWindow.windowBudget).toBe(40000);
      // windowResetAt must be a valid ISO-8601 timestamp
      expect(typeof body.quotaWindow.windowResetAt).toBe('string');
      expect(Number.isNaN(new Date(body.quotaWindow.windowResetAt).getTime())).toBe(false);
    } finally {
      delete process.env['MAX20X_WINDOW_TOKENS'];
    }
  });

  test('Scenario 5B -- quotaWindow.windowBudget is null when MAX20X_WINDOW_TOKENS unset (raw-first fallback)', async () => {
    const recent = new Date().toISOString();
    const runWithTokens: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-b-1',
      metadata: { total_tokens: 1000 },
      last_activity_at: recent,
      started_at: recent,
    };
    const runWithTokens2: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-b-2',
      metadata: { total_tokens: 1000 },
      last_activity_at: recent,
      started_at: recent,
    };
    mockListWorkflowRuns.mockImplementationOnce(async () => [runWithTokens, runWithTokens2]);
    mockSumWorkflowTokensInWindow.mockImplementationOnce(async () => 2000);

    // Ensure unset for this case
    delete process.env['MAX20X_WINDOW_TOKENS'];

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      quotaWindow: {
        windowTokens: number;
        windowBudget: number | null;
        windowResetAt: string;
      };
    };
    expect(body.quotaWindow.windowBudget).toBeNull();
    // Raw windowTokens still surfaced even without a budget.
    expect(body.quotaWindow.windowTokens).toBe(2000);
  });

  // Scenario 5C addresses the Codex-finding: windowTokens MUST aggregate the
  // full window via the dedicated DB function, NOT just the listed page. The
  // page returns 1 run worth 50 tokens; the DB aggregation correctly returns
  // 5000 (covering 100 in-window runs that spill past the page LIMIT).
  test('Scenario 5C -- quotaWindow.windowTokens is full-window DB aggregation, NOT just the page-of-runs', async () => {
    const recent = new Date().toISOString();
    const pageRun: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-c-page',
      metadata: { total_tokens: 50 },
      last_activity_at: recent,
      started_at: recent,
    };
    mockListWorkflowRuns.mockImplementationOnce(async () => [pageRun]);
    // The DB aggregation knows about runs outside the page -- it returns the
    // authoritative full-window total.
    mockSumWorkflowTokensInWindow.mockImplementationOnce(async () => 5000);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: string }>;
      quotaWindow: { windowTokens: number };
    };
    expect(body.runs.length).toBe(1);
    // CRITICAL: if windowTokens were summed from the page (50), this would
    // fail. The fix routes through sumWorkflowTokensInWindow (5000).
    expect(body.quotaWindow.windowTokens).toBe(5000);

    // And confirm the DB function was called with a sinceMs cutoff that lies
    // within the past 24h (sanity-check the window math without binding to a
    // specific MAX20X_WINDOW_HOURS default).
    const lastCall =
      mockSumWorkflowTokensInWindow.mock.calls[mockSumWorkflowTokensInWindow.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const sinceMs = lastCall?.[0]?.sinceMs;
    expect(typeof sinceMs).toBe('number');
    const now = Date.now();
    expect(sinceMs).toBeLessThan(now);
    expect(sinceMs).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
  });

  test('Scenario 5D -- quotaWindow degrades to 0 windowTokens when DB aggregation throws (raw-first fallback)', async () => {
    const recent = new Date().toISOString();
    const pageRun: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-d-page',
      metadata: { total_tokens: 99 },
      last_activity_at: recent,
      started_at: recent,
    };
    mockListWorkflowRuns.mockImplementationOnce(async () => [pageRun]);
    mockSumWorkflowTokensInWindow.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    // The runs list must still succeed -- the quota line is auxiliary.
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: string }>;
      quotaWindow: { windowTokens: number; windowBudget: number | null };
    };
    expect(body.runs.length).toBe(1);
    expect(body.quotaWindow.windowTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockListWorkflowEvents.mockReset();
    mockGetConversationById.mockReset();
  });

  test('returns run with events for a known runId', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => MOCK_EVENTS);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { id: string; workflow_name: string };
      events: Array<{ event_type: string }>;
    };
    expect(body.run.id).toBe('run-uuid-1');
    expect(body.run.workflow_name).toBe('deploy');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(3);
    expect(body.events[0]?.event_type).toBe('step_started');
    expect(body.events[2]?.event_type).toBe('tool_called');
  });

  // ------------------------------------------------------------------------
  // WO-HARNESS-TOKEN-ATTRIBUTION-01 -- Scenario 4: API exposes tokens
  // ------------------------------------------------------------------------
  // Proves the runs/events detail API surfaces:
  //   * data.tokens on a node_completed event (per-node persistence)
  //   * metadata.total_tokens on the run (per-run aggregate)
  // without stripping the JSONB keys persisted by the dag-executor.
  test('Scenario 4 -- API exposes tokens: data.tokens per event + metadata.total_tokens per run', async () => {
    const runWithTokens: MockWorkflowRun = {
      ...MOCK_COMPLETED_RUN,
      id: 'run-tok-detail-1',
      metadata: { total_tokens: 2300, total_cost_usd: 0.005 },
    };
    const eventWithTokens: MockWorkflowEvent = {
      id: 'evt-tok-1',
      workflow_run_id: 'run-tok-detail-1',
      event_type: 'node_completed',
      step_index: 0,
      step_name: 'step',
      data: {
        duration_ms: 1234,
        node_output: 'done',
        cost_usd: 0.005,
        tokens: { input: 1000, output: 500, total: 1500 },
      },
      created_at: NOW,
    };
    const tokenTotalsEvent: MockWorkflowEvent = {
      id: 'evt-rollup-1',
      workflow_run_id: 'run-tok-detail-1',
      event_type: 'run_token_totals',
      step_index: null,
      step_name: null,
      data: {
        by_model: { 'claude-sonnet-5': { input_tokens: 1000, output_tokens: 500 } },
        total_input_tokens: 1000,
        total_output_tokens: 500,
      },
      created_at: NOW,
    };

    mockGetWorkflowRun.mockImplementationOnce(async () => runWithTokens);
    mockListWorkflowEvents.mockImplementationOnce(async () => [eventWithTokens, tokenTotalsEvent]);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-tok-detail-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        metadata: { total_tokens?: number; total_cost_usd?: number };
        token_totals?: Record<string, unknown>;
      };
      events: Array<{
        event_type: string;
        data: { tokens?: { input: number; output: number; total: number } };
      }>;
    };
    expect(body.run.metadata.total_tokens).toBe(2300);
    expect(body.run.metadata.total_cost_usd).toBe(0.005);
    expect(body.run.token_totals).toEqual(tokenTotalsEvent.data);
    expect(body.events.length).toBe(2);
    expect(body.events[0]?.data.tokens).toEqual({ input: 1000, output: 500, total: 1500 });
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run-id');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('includes conversation_platform_id for CLI runs (no parent_conversation_id)', async () => {
    // CLI run: conversation_id set, no parent_conversation_id
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'cli-conv-xyz',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        conversation_platform_id: string | null;
        worker_platform_id: string | undefined;
      };
    };
    // CLI run: conversation_platform_id should be set, worker_platform_id should be undefined
    expect(body.run.conversation_platform_id).toBe('cli-conv-xyz');
    expect(body.run.worker_platform_id).toBeUndefined();
  });

  test('includes worker_platform_id for web runs (with parent_conversation_id)', async () => {
    // Web run: conversation_id is the worker, parent_conversation_id is the parent
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: 'parent-conv-uuid',
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    // First call: worker conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'worker-platform-id',
    }));
    // Second call: parent conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'parent-platform-id',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        worker_platform_id: string | undefined;
        parent_platform_id: string | undefined;
        conversation_platform_id: string | null;
      };
    };
    expect(body.run.worker_platform_id).toBe('worker-platform-id');
    expect(body.run.parent_platform_id).toBe('parent-platform-id');
  });

  test('returns run with null conversation fields when no conversation_id', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      conversation_id: null,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { conversation_platform_id: null };
    };
    expect(body.run.conversation_platform_id).toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get workflow run');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs/:runId/nodes/:nodeId/events (WO-MC-NODE-PEEK-01)
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs/:runId/nodes/:nodeId/events', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockListNodeEvents.mockReset();
  });

  test('returns last N events for the node, newest first', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    const planEvents: MockWorkflowEvent[] = [
      {
        id: 'evt-3',
        workflow_run_id: 'run-uuid-1',
        event_type: 'node_completed',
        step_index: 0,
        step_name: 'plan',
        data: { node_output: 'plan complete', duration_ms: 4321 },
        created_at: NOW,
      },
      {
        id: 'evt-1',
        workflow_run_id: 'run-uuid-1',
        event_type: 'node_started',
        step_index: 0,
        step_name: 'plan',
        data: { command: 'plan' },
        created_at: NOW,
      },
    ];
    mockListNodeEvents.mockImplementationOnce(async () => planEvents);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/nodes/plan/events?limit=5');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: Array<{ event_type: string }> };
    expect(body.events.length).toBe(2);
    expect(body.events[0]?.event_type).toBe('node_completed');
    expect(mockListNodeEvents).toHaveBeenCalledWith('run-uuid-1', 'plan', 5);
  });

  test('defaults limit to 5 when not provided', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListNodeEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/nodes/plan/events');
    expect(response.status).toBe(200);
    expect(mockListNodeEvents).toHaveBeenCalledWith('run-uuid-1', 'plan', 5);
  });

  test('clamps limit to maximum of 20', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListNodeEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request(
      '/api/workflows/runs/run-uuid-1/nodes/plan/events?limit=1000'
    );
    expect(response.status).toBe(200);
    expect(mockListNodeEvents).toHaveBeenCalledWith('run-uuid-1', 'plan', 20);
  });

  test('clamps limit to minimum of 1 for non-positive values', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListNodeEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/nodes/plan/events?limit=0');
    expect(response.status).toBe(200);
    expect(mockListNodeEvents).toHaveBeenCalledWith('run-uuid-1', 'plan', 1);
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/nope/nodes/plan/events');
    expect(response.status).toBe(404);
    expect(mockListNodeEvents).not.toHaveBeenCalled();
  });

  test('returns 500 when DB throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListNodeEvents.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/nodes/plan/events');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get node events');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/dashboard/runs
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/runs', () => {
  beforeEach(() => {
    mockListDashboardRuns.mockReset();
  });

  test('returns paginated runs with total and counts', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [MOCK_RUNNING_RUN, MOCK_COMPLETED_RUN],
      total: 2,
      counts: { all: 5, running: 1, completed: 2, failed: 1, cancelled: 1, pending: 0 },
    }));

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: unknown[];
      total: number;
      counts: { all: number };
    };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(2);
    expect(body.total).toBe(2);
    expect(body.counts.all).toBe(5);
  });

  test('filters by status query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=running');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBe('running');
  });

  test('accepts paused as valid status', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=paused');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBe('paused');
  });

  test('ignores invalid status values in dashboard runs', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=bogus');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by codebaseId query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?codebaseId=cb-1');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ codebaseId?: string }]][];
    expect(callArgs?.codebaseId).toBe('cb-1');
  });

  test('filters by search query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?search=deploy');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ search?: string }]][];
    expect(callArgs?.search).toBe('deploy');
  });

  test('supports after and before date filters', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?after=2024-01-01T00:00:00Z&before=2024-12-31T23:59:59Z');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [
      [{ after?: string; before?: string }],
    ][];
    expect(callArgs?.after).toBe('2024-01-01T00:00:00Z');
    expect(callArgs?.before).toBe('2024-12-31T23:59:59Z');
  });

  test('caps limit at 200', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?limit=9999');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ limit?: number }]][];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('supports offset for pagination', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?offset=50');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ offset?: number }]][];
    expect(callArgs?.offset).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => {
      throw new Error('query timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list dashboard runs');
  });
});

describe('GET /api/workflows/runs/by-worker/:platformId', () => {
  beforeEach(() => {
    mockGetWorkflowRunByWorkerPlatformId.mockReset();
  });

  test('returns run when found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/some-platform-id');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: unknown };
    expect(body.run).toBeDefined();
  });

  test('returns 404 when not found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/unknown-id');
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/resume
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/resume', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not in failed status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot resume');
  });

  test('returns 200 with message when run is failed', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('ready to resume');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/abandon
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/abandon', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is already terminal', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
  });

  test('returns 200 and calls cancelWorkflowRun for running run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Abandoned');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1');
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('DELETE /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockDeleteWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not terminal', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot delete');
  });

  test('returns 200 and deletes a completed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Deleted');
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-2', false);
  });

  test('returns 200 and deletes a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-4', false);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/approve
// ---------------------------------------------------------------------------

const MOCK_PAUSED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-paused-1',
  status: 'paused',
  metadata: {
    approval: {
      type: 'approval',
      nodeId: 'review-gate',
      message: 'Review the plan',
    },
  },
};

describe('POST /api/workflows/runs/:runId/approve', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not paused', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  // Design A: node_output is now a JSON object when captureResponse is true,
  // so the DAG condition-evaluator can route on $<gate>.output.decision_verb.
  test('stores user comment as node_output when captureResponse is true (Design A JSON shape)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-capture',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-capture/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'Looks great, proceed' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    // node_output is now a JSON string; parse it to assert structure.
    const rawOutput = (nodeCompletedCall?.[0] as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;
    expect(rawOutput?.approval_decision).toBe('approved');
    const parsed = JSON.parse(rawOutput?.node_output as string) as Record<string, unknown>;
    expect(parsed.decision_verb).toBe('approve_as_is');
    expect(parsed.comment).toBe('Looks great, proceed');
    expect(parsed.authorized_fix_ids).toEqual([]);
  });

  test('stores empty node_output when captureResponse is not set', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'a comment' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedCall?.[0]).toMatchObject({
      data: { node_output: '', approval_decision: 'approved' },
    });
  });

  // TDD new tests: Design A graded verb persistence
  test('persists decision_verb + authorized_fix_ids as JSON node_output on approve', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-verb-full',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-verb-full/approve', {
      method: 'POST',
      body: JSON.stringify({
        comment: 'Fix the imports',
        decision_verb: 'approve_with_fix',
        authorized_fix_ids: ['locg-migration'],
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    const rawData = (nodeCompletedCall?.[0] as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;
    expect(rawData?.approval_decision).toBe('approved');
    const parsed = JSON.parse(rawData?.node_output as string) as Record<string, unknown>;
    expect(parsed.decision_verb).toBe('approve_with_fix');
    expect(parsed.authorized_fix_ids).toEqual(['locg-migration']);
    expect(parsed.comment).toBe('Fix the imports');
  });

  test('defaults decision_verb to approve_as_is when body omits it', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-verb-default',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-verb-default/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    const rawData = (nodeCompletedCall?.[0] as Record<string, unknown> | undefined)?.data as
      | Record<string, unknown>
      | undefined;
    const parsed = JSON.parse(rawData?.node_output as string) as Record<string, unknown>;
    expect(parsed.decision_verb).toBe('approve_as_is');
  });

  // Guard: decision_verb drives DAG routing into the DB, so an invalid enum value
  // MUST be rejected with 400 by schema validation and nothing may be persisted.
  test('rejects an invalid decision_verb with 400', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-verb-bogus',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-verb-bogus/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM', decision_verb: 'bogus' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    // Nothing may be persisted when validation fails.
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedCall).toBeUndefined();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/reject
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/reject', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not paused', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  test('cancels immediately when no on_reject configured', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'needs work' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-paused-1');
  });

  test('records rejection and increments count when on_reject configured and under limit', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-on-reject',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-on-reject/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'needs more tests' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('On-reject prompt');
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-on-reject', {
      status: 'failed',
      metadata: { rejection_reason: 'needs more tests', rejection_count: 1 },
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('cancels when max attempts reached', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-max-attempts',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 2,
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-max-attempts/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'still bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('max attempts reached');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-max-attempts');
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-resume: approve/reject endpoints resume the executor directly when the
// run has parent_conversation_id set (web-dispatched foreground/interactive
// workflows). This avoids routing approval through a second natural-language
// `/workflow run ...` command.
// ---------------------------------------------------------------------------

describe('approve/reject auto-resume', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockCancelWorkflowRun.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockExecuteWorkflow.mockReset();
    mockCreateWorkflowDeps.mockReset();
    mockCreateWorkflowDeps.mockImplementation(() => ({ store: {} }));
    mockExecuteWorkflow.mockImplementation(async () => ({ success: true, workflowRunId: 'run' }));
  });

  test('approve: starts direct executor resume when parent_conversation_id is set', async () => {
    const workflow = { name: 'deploy', description: 'fixture workflow', nodes: [] };
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-auto-resume-approve',
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Deploy feature X',
    });
    mockGetConversationById.mockImplementation(async (id: string) => {
      if (id === 'parent-conv-uuid') {
        return {
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-plat-abc',
          platform_type: 'web',
        };
      }
      if (id === 'conv-uuid-1') {
        return {
          id: 'conv-uuid-1',
          platform_conversation_id: 'web-worker-abc',
          platform_type: 'web',
        };
      }
      return null;
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [{ workflow: workflow as never, source: 'project' }],
      errors: [],
    });

    const { app, mockWebAdapter } = makeApp();
    const response = await app.request('/api/workflows/runs/run-auto-resume-approve/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Resuming workflow');

    // dispatchToOrchestrator -> lockManager -> handleMessage
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      mockWebAdapter,
      'web-worker-abc',
      '/tmp/worktrees/feature',
      workflow,
      'Deploy feature X',
      'conv-uuid-1',
      'cb-uuid-1',
      undefined,
      undefined,
      'parent-conv-uuid'
    );
  });

  test('approve: skips dispatch when parent_conversation_id is null (CLI-dispatched run)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: null,
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Send a message to continue');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
  });

  test('approve: skips dispatch when parent conversation no longer exists', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'deleted-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce(null); // conversation deleted

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Send a message to continue');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('approve: skips dispatch when parent conversation is on a non-web platform', async () => {
    // A Slack/Telegram/GitHub-sourced run being approved via the dashboard
    // must not route through dispatchToOrchestrator -- that helper is wired
    // to the web adapter + lock manager, so dispatching a Slack thread_ts
    // or Telegram chat_id would misroute through the wrong adapter.
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'slack-parent-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'slack-parent-conv-uuid',
      platform_conversation_id: '1234567890.123456', // a Slack thread_ts
      platform_type: 'slack',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    // Same fallback text as no-parent case -- user re-runs from the originating platform.
    expect(body.message).toContain('Send a message to continue');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('reject: starts direct executor resume for on_reject flows when parent is set', async () => {
    const workflow = { name: 'deploy', description: 'fixture workflow', nodes: [] };
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-auto-resume-reject',
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Review PR',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetConversationById.mockImplementation(async (id: string) => {
      if (id === 'parent-conv-uuid') {
        return {
          id: 'parent-conv-uuid',
          platform_conversation_id: 'web-plat-xyz',
          platform_type: 'web',
        };
      }
      if (id === 'conv-uuid-1') {
        return {
          id: 'conv-uuid-1',
          platform_conversation_id: 'web-worker-xyz',
          platform_type: 'web',
        };
      }
      return null;
    });
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [{ workflow: workflow as never, source: 'project' }],
      errors: [],
    });

    const { app, mockWebAdapter } = makeApp();
    const response = await app.request('/api/workflows/runs/run-auto-resume-reject/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'tests missing' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Running on-reject prompt');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      mockWebAdapter,
      'web-worker-xyz',
      '/tmp/worktrees/feature',
      workflow,
      'Review PR',
      'conv-uuid-1',
      'cb-uuid-1',
      undefined,
      undefined,
      'parent-conv-uuid'
    );
  });

  test('reject: does NOT dispatch when the run is being cancelled (no on_reject configured)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'parent-conv-uuid', // set, but doesn't matter -- reject cancels
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'no' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    // Cancellation path doesn't auto-resume -- nothing to resume to.
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-paused-1');
  });
});
