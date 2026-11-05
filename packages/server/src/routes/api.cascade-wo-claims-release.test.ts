import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set in the environment. The Cauldron build image
// exports ARCHON_OPERATOR_TOKEN, which would otherwise 401 every request here.
// Clear it at module level (same pattern as api.host-metrics.test.ts) so
// these tests run deterministically in any container environment.
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

// ---------------------------------------------------------------------------
// Mock setup -- must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockCancelWorkflowRun = mock(async (_id: string) => {});
const mockCancelStaleWorkflowRuns = mock(async (_minutes: number) => ({
  count: 0,
  ids: [] as string[],
}));

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

const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
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
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })),
  getWorkflowRun: mockGetWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelStaleWorkflowRuns: mockCancelStaleWorkflowRuns,
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mockCreateWorkflowEvent,
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

import { registerApiRoutes } from './api';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import {
  acquireWoClaim,
  findActiveWoClaim,
  retainWoClaim,
} from '@archon/core/db/cascade-wo-claims';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { IN_PROCESS_API_ORIGIN, createInProcessApiFetch } from './in-process-authority';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(): OpenAPIHono {
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
  return app;
}

const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
let currentHome = '';

function post(app: OpenAPIHono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/api/cascade-wo-claims/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function seedClaim(woId: string, cascadeId: string, retained = false): Promise<void> {
  await acquireWoClaim({
    woId,
    project: 'bdc-harness',
    cascadeId,
    holder: 'taskmaster',
    now: '2026-11-03T12:00:00.000Z',
  });
  if (retained) {
    await retainWoClaim({ woId, cascadeId, reason: 'run_not_terminal', runIds: ['r1'] });
  }
}

describe('POST /api/cascade-wo-claims/release', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = mkdtempSync(join(tmpdir(), 'wo-claims-release-test-'));
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    delete process.env.ARCHON_OPERATOR_TOKEN;
    expect(getDatabase().dialect).toBe('sqlite');
  });

  afterEach(async () => {
    delete process.env.ARCHON_OPERATOR_TOKEN;
    await closeDatabase();
    resetDatabase();
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    removeTempDirWithRetry(currentHome);
  });

  test('releases a retained claim held by the named cascade', async () => {
    await seedClaim('WO-A-01', 'casc-1', true);
    const res = await post(makeApp(), { woId: 'WO-A-01', cascadeId: 'casc-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    const rows = await getDatabase().query(
      'SELECT state, released_at FROM cascade_wo_claims WHERE wo_id = $1',
      ['WO-A-01']
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { state: string }).state).toBe('released');
    expect(typeof (rows.rows[0] as { released_at: string }).released_at).toBe('string');
  });

  test('also releases a non-retained active claim (route does not check retention)', async () => {
    await seedClaim('WO-A-01', 'casc-1', false);
    const res = await post(makeApp(), { woId: 'WO-A-01', cascadeId: 'casc-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(await findActiveWoClaim('WO-A-01')).toBeNull();
  });

  test('a wrong cascade id releases nothing and leaves the claim intact', async () => {
    await seedClaim('WO-A-01', 'casc-1', true);
    const res = await post(makeApp(), { woId: 'WO-A-01', cascadeId: 'casc-WRONG' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
    const claim = await findActiveWoClaim('WO-A-01');
    expect(claim?.cascade_id).toBe('casc-1');
    expect(claim?.retained_reason).toBe('run_not_terminal');
  });

  test('an unknown WO returns released:false', async () => {
    const res = await post(makeApp(), { woId: 'WO-NOPE', cascadeId: 'casc-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
  });

  test('releasing twice: the second call is released:false', async () => {
    await seedClaim('WO-A-01', 'casc-1', true);
    const app = makeApp();
    expect(await (await post(app, { woId: 'WO-A-01', cascadeId: 'casc-1' })).json()).toEqual({
      released: true,
    });
    expect(await (await post(app, { woId: 'WO-A-01', cascadeId: 'casc-1' })).json()).toEqual({
      released: false,
    });
  });

  test('only the named WO is released when several are held', async () => {
    await seedClaim('WO-A-01', 'casc-1', true);
    await seedClaim('WO-B-01', 'casc-2', true);
    await post(makeApp(), { woId: 'WO-A-01', cascadeId: 'casc-1' });
    expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    expect((await findActiveWoClaim('WO-B-01'))?.cascade_id).toBe('casc-2');
  });

  test('malformed JSON returns 400 invalid_body', async () => {
    const res = await post(makeApp(), '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });

  test.each([
    ['empty object', {}],
    ['missing cascadeId', { woId: 'WO-A-01' }],
    ['missing woId', { cascadeId: 'casc-1' }],
    ['numeric woId', { woId: 5, cascadeId: 'casc-1' }],
    ['null cascadeId', { woId: 'WO-A-01', cascadeId: null }],
  ])('%s returns 400 with the validation message and releases nothing', async (_name, body) => {
    await seedClaim('WO-A-01', 'casc-1', true);
    const res = await post(makeApp(), body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'woId and cascadeId are required' });
    expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
  });

  test.each(['null', '5', '"str"', '[]'])(
    'non-object JSON body %s is a 400 invalid_body',
    async raw => {
      await seedClaim('WO-A-01', 'casc-1', true);
      const res = await post(makeApp(), raw);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    }
  );

  describe('operator auth (ARCHON_OPERATOR_TOKEN set)', () => {
    test('no token is rejected with 401 and the claim survives', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      const res = await post(makeApp(), { woId: 'WO-A-01', cascadeId: 'casc-1' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Missing or invalid operator token' });
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });

    test('a wrong token is rejected with 401', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      const res = await post(
        makeApp(),
        { woId: 'WO-A-01', cascadeId: 'casc-1' },
        { 'x-archon-operator-token': 'nope' }
      );
      expect(res.status).toBe(401);
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });

    test('the right token (header or bearer) releases', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      await seedClaim('WO-B-01', 'casc-2', true);
      const app = makeApp();
      const viaHeader = await post(
        app,
        { woId: 'WO-A-01', cascadeId: 'casc-1' },
        { 'x-archon-operator-token': 'op-secret' }
      );
      expect(viaHeader.status).toBe(200);
      expect(await viaHeader.json()).toEqual({ released: true });
      const viaBearer = await post(
        app,
        { woId: 'WO-B-01', cascadeId: 'casc-2' },
        { authorization: 'Bearer op-secret' }
      );
      expect(viaBearer.status).toBe(200);
      expect(await viaBearer.json()).toEqual({ released: true });
    });

    test('a dispatch principal (no operator token) is refused with 403', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      const res = await post(
        makeApp(),
        { woId: 'WO-A-01', cascadeId: 'casc-1' },
        { 'x-dispatch-principal-id': 'agent-x', 'x-dispatch-principal-token': 'pt' }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'dispatch_principal_forbidden' });
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });

    test('an in-process request passes without any token', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      const app = makeApp();
      const f = createInProcessApiFetch(app);
      const res = await f(`${IN_PROCESS_API_ORIGIN}/api/cascade-wo-claims/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ woId: 'WO-A-01', cascadeId: 'casc-1' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ released: true });
      expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    });

    test('a spoofed in-process origin from outside is still 401', async () => {
      process.env.ARCHON_OPERATOR_TOKEN = 'op-secret';
      await seedClaim('WO-A-01', 'casc-1', true);
      const res = await makeApp().request(
        `${IN_PROCESS_API_ORIGIN}/api/cascade-wo-claims/release`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: IN_PROCESS_API_ORIGIN },
          body: JSON.stringify({ woId: 'WO-A-01', cascadeId: 'casc-1' }),
        }
      );
      expect(res.status).toBe(401);
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });
  });
});
