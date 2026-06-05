import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
} from '../test/workflow-mock-factories';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set in the environment. Sibling test files
// (api.workflow-runs.test.ts, api.workflows.test.ts) assume the token is
// unset by default and only set it per-test to exercise the gate. Match
// that contract so this file passes deterministically regardless of the
// surrounding container environment (the Cauldron build image exports
// ARCHON_OPERATOR_TOKEN, which would otherwise 401 every request).
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

// ---------------------------------------------------------------------------
// Mock setup -- must be before dynamic imports
//
// Test 1 (success), 2 (stale), 3 (missing file) mock fs/promises.readFile so
// the handler reads from a fake source instead of /host-artifacts. Test 4
// (duration parse) intercepts workflowDb.bulkDeleteArchivedFailedRuns to
// assert that the API handler converts the human-readable duration shortcut
// ("14d") to an ISO timestamp BEFORE forwarding to the DB layer.
//
// IMPORTANT: api.ts imports from 'fs/promises' (NOT 'node:fs/promises'); the
// mock path string must match exactly or the mock will not intercept the
// real import.
// ---------------------------------------------------------------------------

const mockReadFile = mock(async (_path: string, _enc?: string) => '{}');
const mockBulkDeleteArchivedFailedRuns = mock(
  async (_opts: { olderThan?: string; dryRun?: boolean }) => ({
    deletedCount: 0,
    runIds: [] as string[],
  })
);

mock.module('fs/promises', () => ({
  // Only readFile is used by the host-metrics handler; the other named
  // imports (rm, writeFile, unlink, mkdir) are stubs so api.ts still loads.
  readFile: mockReadFile,
  rm: mock(async () => {}),
  writeFile: mock(async () => {}),
  unlink: mock(async () => {}),
  mkdir: mock(async () => {}),
}));

const mockLoadConfig = mock(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
}));
const mockGetDatabaseType = mock(() => 'sqlite' as const);
const mockIsDocker = mock(() => false);
const mockGetStats = mock(() => ({
  active: 0,
  queuedTotal: 0,
  queuedByConversation: [] as { conversationId: string; queuedMessages: number }[],
  maxConcurrent: 10,
  activeConversationIds: [] as string[],
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  loadConfig: mockLoadConfig,
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
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
  isDocker: mockIsDocker,
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
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
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
  bulkDeleteArchivedFailedRuns: mockBulkDeleteArchivedFailedRuns,
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mockGetStats,
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/host-metrics
// ---------------------------------------------------------------------------

describe('GET /api/host-metrics', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
  });

  test('returns fresh metrics when collectedAt is recent', async () => {
    const collectedAt = new Date().toISOString();
    mockReadFile.mockImplementationOnce(async () =>
      JSON.stringify({
        disk: { used_gb: 100, total_gb: 500, pct: 20 },
        cpu: { pct: 15.5 },
        mem: { used_gb: 8, total_gb: 32, pct: 25 },
        collectedAt,
      })
    );

    const app = makeApp();
    const response = await app.request('/api/host-metrics');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      disk: { used_gb: number; total_gb: number; pct: number } | null;
      cpu: { pct: number } | null;
      mem: { used_gb: number; total_gb: number; pct: number } | null;
      collectedAt: string | null;
      stale: boolean;
    };
    expect(body.status).toBe('ok');
    expect(body.stale).toBe(false);
    expect(body.collectedAt).toBe(collectedAt);
    expect(body.disk).toEqual({ used_gb: 100, total_gb: 500, pct: 20 });
    expect(body.cpu).toEqual({ pct: 15.5 });
    expect(body.mem).toEqual({ used_gb: 8, total_gb: 32, pct: 25 });
  });

  test('returns stale=true when collectedAt is older than 10 minutes', async () => {
    const collectedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    mockReadFile.mockImplementationOnce(async () =>
      JSON.stringify({
        disk: { used_gb: 100, total_gb: 500, pct: 20 },
        cpu: { pct: 15.5 },
        mem: { used_gb: 8, total_gb: 32, pct: 25 },
        collectedAt,
      })
    );

    const app = makeApp();
    const response = await app.request('/api/host-metrics');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      stale: boolean;
      collectedAt: string | null;
      disk: { pct: number } | null;
    };
    expect(body.stale).toBe(true);
    expect(body.status).toBe('stale');
    expect(body.collectedAt).toBe(collectedAt);
    // Last-known values still surface even when stale
    expect(body.disk?.pct).toBe(20);
  });

  test('accepts partial-null per-field numerics on documented contract', async () => {
    // The collector documents that individual numeric fields can be null
    // when the resource section was read but a specific value could not
    // be sampled (e.g. df returned a row but "used" was unreadable).
    // The schema MUST permit this so the dashboard sees the partial data
    // instead of a no-data fallback, and the handler must NOT crash or
    // discard the row as a contract violation.
    const collectedAt = new Date().toISOString();
    mockReadFile.mockImplementationOnce(async () =>
      JSON.stringify({
        disk: { used_gb: null, total_gb: 500, pct: null },
        cpu: { pct: 15.5 },
        mem: { used_gb: 8, total_gb: 32, pct: 25 },
        collectedAt,
      })
    );

    const app = makeApp();
    const response = await app.request('/api/host-metrics');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      disk: { used_gb: number | null; total_gb: number | null; pct: number | null } | null;
    };
    expect(body.status).toBe('ok');
    expect(body.disk).not.toBeNull();
    expect(body.disk?.used_gb).toBeNull();
    expect(body.disk?.total_gb).toBe(500);
    expect(body.disk?.pct).toBeNull();
  });

  test('falls back to no-data when collector emits an off-contract type', async () => {
    // Strings in numeric fields are NOT in the contract (only numbers or
    // null). The handler must validate parsed JSON against the schema
    // and fall back to the no-data shape so malformed collector output
    // cannot reach the generated client.
    mockReadFile.mockImplementationOnce(async () =>
      JSON.stringify({
        disk: { used_gb: 'not-a-number', total_gb: 500, pct: 20 },
        cpu: { pct: 15.5 },
        mem: { used_gb: 8, total_gb: 32, pct: 25 },
        collectedAt: new Date().toISOString(),
      })
    );

    const app = makeApp();
    const response = await app.request('/api/host-metrics');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      disk: unknown;
      cpu: unknown;
      mem: unknown;
      collectedAt: unknown;
      stale: boolean;
    };
    expect(body.status).toBe('no-data');
    expect(body.disk).toBeNull();
    expect(body.cpu).toBeNull();
    expect(body.mem).toBeNull();
    expect(body.collectedAt).toBeNull();
    expect(body.stale).toBe(false);
  });

  test('returns no-data shape (NOT 500) when collector file is missing', async () => {
    mockReadFile.mockImplementationOnce(async () => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const app = makeApp();
    const response = await app.request('/api/host-metrics');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      status: string;
      disk: unknown;
      cpu: unknown;
      mem: unknown;
      collectedAt: unknown;
      stale: boolean;
    };
    expect(body.status).toBe('no-data');
    expect(body.disk).toBeNull();
    expect(body.cpu).toBeNull();
    expect(body.mem).toBeNull();
    expect(body.collectedAt).toBeNull();
    expect(body.stale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/workflows/runs/bulk-failed -- duration parse
// ---------------------------------------------------------------------------

describe('DELETE /api/workflows/runs/bulk-failed duration parse', () => {
  beforeEach(() => {
    mockBulkDeleteArchivedFailedRuns.mockReset();
    mockBulkDeleteArchivedFailedRuns.mockImplementation(
      async (_opts: { olderThan?: string; dryRun?: boolean }) => ({
        deletedCount: 0,
        runIds: [] as string[],
      })
    );
  });

  test('converts olderThan=14d to ISO timestamp before calling DB layer', async () => {
    const app = makeApp();
    const response = await app.request('/api/workflows/runs/bulk-failed?olderThan=14d', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);

    expect(mockBulkDeleteArchivedFailedRuns).toHaveBeenCalledTimes(1);
    const callArgs = mockBulkDeleteArchivedFailedRuns.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    // The handler must NOT forward the literal "14d" string -- it must
    // convert to ISO so bulkDeleteArchivedFailedRuns can bind it directly
    // into `started_at < $1` without a Postgres cast error.
    expect(callArgs?.olderThan).not.toBe('14d');
    expect(callArgs?.olderThan).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // 14 days ago should be in the past
    const cutoffMs = Date.parse(callArgs?.olderThan ?? '');
    expect(Number.isFinite(cutoffMs)).toBe(true);
    expect(cutoffMs).toBeLessThan(Date.now());
    // Approximately 14 days ago (allow 1 minute drift)
    const expected = Date.now() - 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(60 * 1000);
  });

  test('passes ISO timestamp through unchanged', async () => {
    const iso = '2026-01-01T00:00:00.000Z';
    const app = makeApp();
    const response = await app.request(
      `/api/workflows/runs/bulk-failed?olderThan=${encodeURIComponent(iso)}`,
      { method: 'DELETE' }
    );
    expect(response.status).toBe(200);

    const callArgs = mockBulkDeleteArchivedFailedRuns.mock.calls[0]?.[0];
    expect(callArgs?.olderThan).toBe(iso);
  });

  test('forwards undefined olderThan when query param is absent (no-op path)', async () => {
    const app = makeApp();
    const response = await app.request('/api/workflows/runs/bulk-failed', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);

    const callArgs = mockBulkDeleteArchivedFailedRuns.mock.calls[0]?.[0];
    expect(callArgs?.olderThan).toBeUndefined();
  });

  test('returns 400 on unrecognized olderThan value', async () => {
    const app = makeApp();
    const response = await app.request(
      '/api/workflows/runs/bulk-failed?olderThan=garbage-not-a-duration',
      { method: 'DELETE' }
    );
    expect(response.status).toBe(400);
    expect(mockBulkDeleteArchivedFailedRuns).not.toHaveBeenCalled();
  });
});
