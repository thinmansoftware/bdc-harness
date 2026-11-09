import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => db,
}));

mock.module('@archon/core/db/dispatch', () => ({
  createMessage: mock(async () => ({})),
  listMessages: mock(async () => []),
  claimMessage: mock(async () => null),
  postResult: mock(async () => null),
  cancelMessage: mock(async () => null),
  registerWorker: mock(async () => ({})),
  heartbeatWorker: mock(async () => null),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x' })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
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
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/env-vars', () => ({
  listEnvVars: mock(async () => []),
  setEnvVar: mock(async () => null),
  deleteEnvVar: mock(async () => false),
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
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    drained: false,
    updatedAt: null,
  })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function makeApp(token?: string): OpenAPIHono {
  if (token) {
    process.env.ARCHON_OPERATOR_TOKEN = token;
  } else {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  }
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

describe('board authority API', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-api-board-authority-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    setBoardPrincipalResolverForTests(async ({ principal_token }) => ({
      principal_id: 'xo-model',
      seat_id: 'xo',
      roles: ['acting_xo'],
      principal_token,
    }));
  });

  afterEach(async () => {
    setBoardPrincipalResolverForTests(undefined);
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('requires global operator token for XO lease mutation when configured', async () => {
    const app = makeApp('secret-token');
    const response = await app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holder_id: 'holder-1', holder_token: 'session-secret' }),
    });

    expect(response.status).toBe(401);
  });

  test('rejects spoofed principal body fields before lease mutation', async () => {
    const app = makeApp('secret-token');
    const response = await app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify({
        principal_id: 'spoofed-body-principal',
        holder_id: 'holder-1',
        holder_token: 'session-secret',
      }),
    });

    expect(response.status).toBe(400);
    const rows = await db.query('SELECT id FROM board_xo_leases');
    expect(rows.rowCount).toBe(0);
  });

  test('rejects invalid board principal before lease mutation', async () => {
    setBoardPrincipalResolverForTests(async () => null);
    const app = makeApp('secret-token');
    const response = await app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify({
        principal_token: 'bad-token',
        holder_id: 'holder-1',
        holder_token: 'session-secret',
      }),
    });

    expect(response.status).toBe(401);
    const rows = await db.query('SELECT id FROM board_xo_leases');
    expect(rows.rowCount).toBe(0);
  });

  test('acquires lease without leaking holder token hash', async () => {
    const app = makeApp('secret-token');
    const response = await app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify({ holder_id: 'holder-1', holder_token: 'session-secret' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.fencing_token).toBe(1);
    expect(body.holder_token_hash).toBeUndefined();
  });

  // WO-HARNESS-XO-LEASE-8H-CAP-01: the XO lease may last up to 8 hours, no more.
  const EIGHT_HOURS_MS = 28_800_000;
  const xoHeaders = {
    'Content-Type': 'application/json',
    'x-archon-operator-token': 'secret-token',
  };
  const acquireXoLease = async (
    app: OpenAPIHono,
    extra: Record<string, unknown> = {}
  ): Promise<Response> =>
    app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers: xoHeaders,
      body: JSON.stringify({ holder_id: 'holder-1', holder_token: 'session-secret', ...extra }),
    });
  const renewXoLease = async (
    app: OpenAPIHono,
    extra: Record<string, unknown> = {}
  ): Promise<Response> =>
    app.request('/api/board/xo-lease/renew', {
      method: 'POST',
      headers: xoHeaders,
      body: JSON.stringify({
        holder_id: 'holder-1',
        holder_token: 'session-secret',
        fencing_token: 1,
        ...extra,
      }),
    });
  const msUntil = (iso: string): number => Date.parse(iso) - Date.now();
  const storedExpiry = async (): Promise<string> => {
    const result = await db.query<{ expires_at: string }>(
      'SELECT expires_at FROM board_xo_leases WHERE id = 1'
    );
    return String(result.rows[0].expires_at);
  };

  test('acquire accepts exactly the 8 hour XO lease cap', async () => {
    const response = await acquireXoLease(makeApp('secret-token'), {
      lease_duration_ms: EIGHT_HOURS_MS,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { expires_at: string };
    expect(msUntil(body.expires_at)).toBeGreaterThan(EIGHT_HOURS_MS - 10_000);
    expect(msUntil(body.expires_at)).toBeLessThanOrEqual(EIGHT_HOURS_MS);
  });

  test('acquire rejects an XO lease longer than 8 hours and writes nothing', async () => {
    const response = await acquireXoLease(makeApp('secret-token'), {
      lease_duration_ms: EIGHT_HOURS_MS + 1,
    });

    expect(response.status).toBe(400);
    const rows = await db.query('SELECT id FROM board_xo_leases');
    expect(rows.rowCount).toBe(0);
  });

  test('renew accepts exactly the 8 hour XO lease cap', async () => {
    const app = makeApp('secret-token');
    expect((await acquireXoLease(app)).status).toBe(200);

    const response = await renewXoLease(app, { lease_duration_ms: EIGHT_HOURS_MS });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { expires_at: string };
    expect(msUntil(body.expires_at)).toBeGreaterThan(EIGHT_HOURS_MS - 10_000);
    expect(msUntil(body.expires_at)).toBeLessThanOrEqual(EIGHT_HOURS_MS);
  });

  test('renew rejects an XO lease longer than 8 hours and leaves the lease untouched', async () => {
    const app = makeApp('secret-token');
    expect((await acquireXoLease(app)).status).toBe(200);
    const before = await storedExpiry();

    const response = await renewXoLease(app, { lease_duration_ms: EIGHT_HOURS_MS + 1 });

    expect(response.status).toBe(400);
    expect(await storedExpiry()).toBe(before);
  });

  test('acquire without a duration still grants the 5 minute core default', async () => {
    const response = await acquireXoLease(makeApp('secret-token'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { expires_at: string };
    expect(msUntil(body.expires_at)).toBeGreaterThan(300_000 - 10_000);
    expect(msUntil(body.expires_at)).toBeLessThanOrEqual(300_000);
  });

  test('recipient route returns typed deferral', async () => {
    const app = makeApp();
    const response = await app.request('/api/board/recipient');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'no_valid_xo_lease' });
  });
});
