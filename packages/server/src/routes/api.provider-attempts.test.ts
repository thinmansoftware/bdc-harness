import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
} from '../test/workflow-mock-factories';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set in the environment. Match the sibling test
// contract (api.host-metrics.test.ts): unset by default, set per-test only
// when exercising the auth gate, so this file passes deterministically
// regardless of the surrounding container environment (the Cauldron build
// image exports ARCHON_OPERATOR_TOKEN, which would otherwise 401 every
// request).
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;
delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;

// ---------------------------------------------------------------------------
// Mock setup -- must be before dynamic imports.
//
// mockListProviderAttemptsFeed is the DB layer the route handler calls. Tests
// control its return value (row shape, null outcome_class) and assert the
// forwarded query params (since/limit) via its mock.calls.
// ---------------------------------------------------------------------------

interface FeedRow {
  provider: string;
  model: string;
  outcome_class: string | null;
  reason_code: string | null;
  started_at: string;
  completed_at: string | null;
  served_model_id: string | null;
}

function sampleRow(overrides: Partial<FeedRow> = {}): FeedRow {
  return {
    provider: 'claude',
    model: 'sonnet',
    outcome_class: 'success',
    reason_code: 'execution_completed',
    started_at: '2026-08-01T12:00:00.000Z',
    completed_at: '2026-08-01T12:01:00.000Z',
    served_model_id: 'claude-sonnet-4-5',
    ...overrides,
  };
}

const mockListProviderAttemptsFeed = mock(
  async (_opts: { since?: string; limit?: number }): Promise<FeedRow[]> => [sampleRow()]
);

const loggerStub = () => ({
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
});

mock.module('fs/promises', () => ({
  readFile: mock(async () => '{}'),
  rm: mock(async () => {}),
  writeFile: mock(async () => {}),
  unlink: mock(async () => {}),
  mkdir: mock(async () => {}),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mock(() => 'sqlite' as const),
  loadConfig: mock(async () => ({
    assistants: { claude: { model: 'sonnet' } },
    worktree: { baseBranch: 'main' },
  })),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
  createLogger: loggerStub,
}));

mock.module('@archon/paths', () => ({
  createLogger: loggerStub,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  isDocker: mock(() => false),
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
  listProviderAttemptsFeed: mockListProviderAttemptsFeed,
  getCauldronDrainState: mock(async () => ({
    mode: 'active',
    activeLeaseCount: 0,
    activeRunCount: 0,
  })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({})),
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
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

const ROUTE = '/api/dashboard/provider-attempts';

// ---------------------------------------------------------------------------
// Tests: GET /api/dashboard/provider-attempts
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/provider-attempts', () => {
  beforeEach(() => {
    mockListProviderAttemptsFeed.mockReset();
    mockListProviderAttemptsFeed.mockImplementation(async () => [sampleRow()]);
  });

  // Test 1 -- returns rows as JSON with all seven named fields.
  test('returns provider-attempt rows as JSON with all seven fields', async () => {
    const app = makeApp();
    const response = await app.request(ROUTE);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: FeedRow[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(1);
    const row = body.items[0]!;
    // Assert exact field set -- the seven columns named by the WO.
    expect(Object.keys(row).sort()).toEqual(
      [
        'completed_at',
        'model',
        'outcome_class',
        'provider',
        'reason_code',
        'served_model_id',
        'started_at',
      ].sort()
    );
    expect(row.provider).toBe('claude');
    expect(row.model).toBe('sonnet');
    expect(row.outcome_class).toBe('success');
  });

  // Test 2 -- the catch-all trap. A SPA HTML catch-all also returns 200, so a
  // status check proves nothing. Assert on the JSON body shape instead.
  test('body is real JSON (not the SPA HTML catch-all)', async () => {
    const app = makeApp();
    const response = await app.request(ROUTE);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as { items: unknown };
    // The catch-all would yield HTML (json() throws) or an object with no
    // `items` array; a registered route yields { items: [...] }.
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
  });

  // Test 3 -- rows with NULL outcome_class are RETURNED, not filtered.
  test('rows with null outcome_class are returned, not filtered', async () => {
    mockListProviderAttemptsFeed.mockImplementation(async () => [
      sampleRow({ outcome_class: null, reason_code: null }),
      sampleRow({ outcome_class: 'success' }),
    ]);
    const app = makeApp();
    const response = await app.request(ROUTE);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: FeedRow[] };
    expect(body.items.length).toBe(2);
    const nullRows = body.items.filter(r => r.outcome_class === null);
    expect(nullRows.length).toBe(1);
    expect(nullRows[0]!.reason_code).toBeNull();
  });

  // Test 5 -- since/limit params are forwarded to the DB layer.
  test('forwards since and limit query params to the DB layer', async () => {
    const app = makeApp();
    const since = '2026-07-01T00:00:00.000Z';
    const response = await app.request(`${ROUTE}?since=${encodeURIComponent(since)}&limit=5`);
    expect(response.status).toBe(200);

    expect(mockListProviderAttemptsFeed).toHaveBeenCalledTimes(1);
    const callArgs = mockListProviderAttemptsFeed.mock.calls[0]?.[0];
    expect(callArgs?.since).toBe(since);
    expect(callArgs?.limit).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Test 4 -- auth. Isolated describe block that sets ARCHON_OPERATOR_TOKEN so
// the global /api/* operator-token middleware engages, then restores the env.
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/provider-attempts -- auth', () => {
  beforeEach(() => {
    mockListProviderAttemptsFeed.mockReset();
    mockListProviderAttemptsFeed.mockImplementation(async () => [sampleRow()]);
    process.env.ARCHON_OPERATOR_TOKEN = 'secret-operator-token';
  });

  afterEach(() => {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  });

  test('missing operator token returns 401 and no row data', async () => {
    const app = makeApp();
    const response = await app.request(ROUTE);
    expect(response.status).toBe(401);

    const text = await response.text();
    expect(text).not.toContain('claude');
    expect(text).not.toContain('served_model_id');
    expect(mockListProviderAttemptsFeed).not.toHaveBeenCalled();
  });

  test('wrong operator token returns 401 and no row data', async () => {
    const app = makeApp();
    const response = await app.request(ROUTE, {
      headers: { 'x-archon-operator-token': 'wrong-token' },
    });
    expect(response.status).toBe(401);

    const text = await response.text();
    expect(text).not.toContain('claude');
    expect(mockListProviderAttemptsFeed).not.toHaveBeenCalled();
  });

  test('valid operator token returns 200 with rows', async () => {
    const app = makeApp();
    const response = await app.request(ROUTE, {
      headers: { 'x-archon-operator-token': 'secret-operator-token' },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: FeedRow[] };
    expect(body.items.length).toBe(1);
    expect(mockListProviderAttemptsFeed).toHaveBeenCalledTimes(1);
  });
});
