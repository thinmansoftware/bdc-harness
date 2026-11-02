/**
 * api.cascade-frontier-approval.test.ts -- route-level tests for the Smart
 * Cauldron frontier-approval endpoints (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01).
 *
 * POST /api/cascades/{id}/approve-frontier  -- resume + fire (idempotent)
 * POST /api/cascades/{id}/reject-frontier   -- terminate as needs-human, no fire
 *
 * The smart-cauldron helpers are mocked so these tests exercise ONLY the HTTP
 * wiring: 404 unknown id, 422 wrong state, 200 approve, 200 idempotent no-op,
 * 200 reject, and 401 without the operator token.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

// Clear operator-token env so most requests are not gated (mirrors api.cancel-run.test.ts).
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

// ---------------------------------------------------------------------------
// Mock setup -- must be before dynamic import of ./api
// ---------------------------------------------------------------------------

type MockFrontierPacket = {
  tierName: string;
  workflowName: string;
  resolution: 'approved' | 'rejected' | null;
  resumeCascadeId: string | null;
  rejectReason: string | null;
};

type MockCascadeRecord = {
  cascadeId: string;
  woId: string;
  status: string;
  frontierApproval?: MockFrontierPacket;
};

const mockReadCascadeRecordById = mock(
  async (_id: string): Promise<MockCascadeRecord | null> => null
);
const mockClaimFrontierResolution = mock(
  async (_id: string, resolution: 'approved' | 'rejected') => ({
    claimed: true,
    resolution,
    path: '/tmp/claim.json',
  })
);
const mockResumeFrontierTier = mock(
  async (
    _record: MockCascadeRecord,
    opts?: { onAdmission?: (r: MockCascadeRecord, created: boolean) => void }
  ) => {
    const resumed: MockCascadeRecord = {
      cascadeId: 'resumed-cascade-1',
      woId: _record.woId,
      status: 'won',
    };
    opts?.onAdmission?.(resumed, true);
    return resumed;
  }
);
const mockRejectFrontierTier = mock(
  async (record: MockCascadeRecord, reason: string): Promise<MockCascadeRecord> => ({
    ...record,
    status: 'frontier-rejected',
    frontierApproval: {
      tierName: 'frontier',
      workflowName: 'bdc-feature-development-fable',
      resolution: 'rejected',
      resumeCascadeId: null,
      rejectReason: reason,
    },
  })
);

mock.module('@archon/smart-cauldron/frontier-approval', () => ({
  readCascadeRecordById: mockReadCascadeRecordById,
  claimFrontierResolution: mockClaimFrontierResolution,
  resumeFrontierTier: mockResumeFrontierTier,
  rejectFrontierTier: mockRejectFrontierTier,
}));

mock.module('@archon/smart-cauldron/cascade', () => ({
  runCascade: mock(async () => ({ cascadeId: 'x', status: 'running' })),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => makeStubLogger(),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => makeStubLogger(),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
}));

mock.module('@archon/workflows/loader', () => ({
  parseWorkflow: mock(() => ({
    workflow: null,
    error: { filename: '', error: 'stub', errorType: 'parse_error' },
  })),
  getLoaderErrors: mock(() => []),
}));

mock.module('@archon/workflows/command-validation', () => ({
  isValidCommandName: mock(() => true),
}));

mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(async () => ({ success: true, workflowRunId: 'run-uuid-1' })),
}));

mock.module('@archon/core/workflows', () => ({
  createWorkflowDeps: mock(() => ({ store: {} })),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
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

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  cancelStaleWorkflowRuns: mock(async () => ({ count: 0, ids: [] })),
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user' as const,
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

function makeStubLogger() {
  return {
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
  };
}

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    setupEventBridge: mock(() => mock(() => {})),
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
  return app;
}

const PAUSED_RECORD: MockCascadeRecord = {
  cascadeId: 'cascade-1',
  woId: 'WO-TEST-001',
  status: 'pending-frontier-approval',
  frontierApproval: {
    tierName: 'frontier',
    workflowName: 'bdc-feature-development-fable',
    resolution: null,
    resumeCascadeId: null,
    rejectReason: null,
  },
};

const NON_GATED_RECORD: MockCascadeRecord = {
  cascadeId: 'cascade-2',
  woId: 'WO-TEST-002',
  status: 'won',
};

// ---------------------------------------------------------------------------
// approve-frontier
// ---------------------------------------------------------------------------

describe('POST /api/cascades/:id/approve-frontier', () => {
  beforeEach(() => {
    mockReadCascadeRecordById.mockReset();
    mockClaimFrontierResolution.mockReset();
    mockResumeFrontierTier.mockReset();
    mockClaimFrontierResolution.mockImplementation(async (_id, resolution) => ({
      claimed: true,
      resolution,
      path: '/tmp/claim.json',
    }));
    mockResumeFrontierTier.mockImplementation(async (_record, opts) => {
      const resumed: MockCascadeRecord = {
        cascadeId: 'resumed-cascade-1',
        woId: _record.woId,
        status: 'won',
      };
      opts?.onAdmission?.(resumed, true);
      return resumed;
    });
  });

  test('404 when cascade record does not exist', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => null);
    const res = await makeApp().request('/api/cascades/unknown/approve-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(mockResumeFrontierTier).not.toHaveBeenCalled();
  });

  test('422 when cascade is not awaiting frontier approval', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => NON_GATED_RECORD);
    const res = await makeApp().request('/api/cascades/cascade-2/approve-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(422);
    expect(mockResumeFrontierTier).not.toHaveBeenCalled();
  });

  test('200 resumes and fires exactly once on first approve', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => PAUSED_RECORD);
    const res = await makeApp().request('/api/cascades/cascade-1/approve-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      resolution: string;
      resumeCascadeId?: string;
      status: string;
    };
    expect(body.success).toBe(true);
    expect(body.resolution).toBe('approved');
    expect(body.resumeCascadeId).toBe('resumed-cascade-1');
    expect(mockResumeFrontierTier).toHaveBeenCalledTimes(1);
  });

  test('200 idempotent no-op when already resolved (no second fire)', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => PAUSED_RECORD);
    mockClaimFrontierResolution.mockImplementationOnce(async () => ({
      claimed: false,
      resolution: 'approved',
      path: '/tmp/claim.json',
    }));
    const res = await makeApp().request('/api/cascades/cascade-1/approve-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyResolved?: boolean; resolution: string };
    expect(body.alreadyResolved).toBe(true);
    expect(body.resolution).toBe('approved');
    expect(mockResumeFrontierTier).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reject-frontier
// ---------------------------------------------------------------------------

describe('POST /api/cascades/:id/reject-frontier', () => {
  beforeEach(() => {
    mockReadCascadeRecordById.mockReset();
    mockClaimFrontierResolution.mockReset();
    mockRejectFrontierTier.mockReset();
    mockClaimFrontierResolution.mockImplementation(async (_id, resolution) => ({
      claimed: true,
      resolution,
      path: '/tmp/claim.json',
    }));
    mockRejectFrontierTier.mockImplementation(async (record, reason) => ({
      ...record,
      status: 'frontier-rejected',
      frontierApproval: {
        tierName: 'frontier',
        workflowName: 'bdc-feature-development-fable',
        resolution: 'rejected',
        resumeCascadeId: null,
        rejectReason: reason,
      },
    }));
  });

  test('404 when cascade record does not exist', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => null);
    const res = await makeApp().request('/api/cascades/unknown/reject-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
    expect(mockRejectFrontierTier).not.toHaveBeenCalled();
  });

  test('200 terminates as frontier-rejected without firing', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => PAUSED_RECORD);
    const res = await makeApp().request('/api/cascades/cascade-1/reject-frontier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'structurally impossible WO' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolution: string; status: string };
    expect(body.resolution).toBe('rejected');
    expect(body.status).toBe('frontier-rejected');
    expect(mockRejectFrontierTier).toHaveBeenCalledTimes(1);
  });

  test('200 idempotent no-op when already resolved', async () => {
    mockReadCascadeRecordById.mockImplementationOnce(async () => PAUSED_RECORD);
    mockClaimFrontierResolution.mockImplementationOnce(async () => ({
      claimed: false,
      resolution: 'approved',
      path: '/tmp/claim.json',
    }));
    const res = await makeApp().request('/api/cascades/cascade-1/reject-frontier', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyResolved?: boolean; resolution: string };
    expect(body.alreadyResolved).toBe(true);
    // Reflects the winning (approved) resolution, not the attempted reject.
    expect(body.resolution).toBe('approved');
    expect(mockRejectFrontierTier).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// operator-token gate
// ---------------------------------------------------------------------------

describe('operator-token gate on cascade endpoints', () => {
  test('401 when operator token is required but not presented', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'secret-token';
    try {
      const res = await makeApp().request('/api/cascades/cascade-1/approve-frontier', {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.ARCHON_OPERATOR_TOKEN;
    }
  });
});
