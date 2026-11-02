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
    setBoardPrincipalResolverForTests(async ({ principal_token }) => {
      if (principal_token === 'john-token') {
        return { principal_id: 'john-operator', seat_id: 'john', roles: ['board'] };
      }
      if (principal_token === 'general-token') {
        return { principal_id: 'general-model', seat_id: 'general', roles: ['board'] };
      }
      if (principal_token === 'xo-other-token') {
        return { principal_id: 'xo-other', seat_id: 'xo', roles: ['acting_xo'] };
      }
      return { principal_id: 'xo-model', seat_id: 'xo', roles: ['acting_xo'] };
    });
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

  test('recipient route returns typed deferral', async () => {
    const app = makeApp();
    const response = await app.request('/api/board/recipient');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'no_valid_xo_lease' });
  });

  test('non-john seats cannot direct an XO lease handoff', async () => {
    const app = makeApp('secret-token');
    const headers = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
    };
    const acquired = await app.request('/api/board/xo-lease/acquire', {
      method: 'POST',
      headers,
      body: JSON.stringify({ holder_id: 'holder-1', holder_token: 'session-secret' }),
    });
    expect(acquired.status).toBe(200);

    for (const principalToken of ['general-token', 'xo-other-token']) {
      const response = await app.request('/api/board/xo-lease/handoff', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          principal_token: principalToken,
          expected_fencing_token: 1,
          successor_principal_id: 'xo-successor',
        }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'handoff_requires_john_seat' });
    }

    const current = await app.request('/api/board/xo-lease/current', { headers });
    expect(await current.json()).toEqual(
      expect.objectContaining({
        principal_id: 'xo-model',
        holder_id: 'holder-1',
        fencing_token: 1,
        released_at: null,
      })
    );
  });

  test('old holder renew and release after handoff return handed-off conflict', async () => {
    const previous = process.env.BOARD_PRINCIPALS_JSON;
    process.env.BOARD_PRINCIPALS_JSON = JSON.stringify([
      {
        principal_id: 'xo-successor',
        seat_id: 'xo',
        roles: ['board'],
        token_sha256: 'a'.repeat(64),
        status: 'active',
      },
    ]);
    try {
      const app = makeApp('secret-token');
      const headers = {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      };
      const acquired = await app.request('/api/board/xo-lease/acquire', {
        method: 'POST',
        headers,
        body: JSON.stringify({ holder_id: 'holder-1', holder_token: 'session-secret' }),
      });
      expect(acquired.status).toBe(200);

      const handoff = await app.request('/api/board/xo-lease/handoff', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          principal_token: 'john-token',
          expected_fencing_token: 1,
          successor_principal_id: 'xo-successor',
        }),
      });
      expect(handoff.status).toBe(200);
      const handed = (await handoff.json()) as Record<string, unknown>;
      expect(handed.reason).toBeUndefined();
      expect(handed.fencing_token).toBe(1);
      expect(handed.successor_principal_id).toBe('xo-successor');
      expect(handed.handed_off_lease_id).toEqual(expect.any(String));
      expect(handed.reserved_until).toEqual(expect.any(String));

      const current = await app.request('/api/board/xo-lease/current', { headers });
      expect(await current.json()).toBeNull();

      const renew = await app.request('/api/board/xo-lease/renew', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          holder_id: 'holder-1',
          holder_token: 'session-secret',
          fencing_token: 1,
        }),
      });
      const release = await app.request('/api/board/xo-lease/release', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          holder_id: 'holder-1',
          holder_token: 'session-secret',
          fencing_token: 1,
        }),
      });
      expect(renew.status).toBe(409);
      expect(await renew.json()).toEqual({ error: 'xo_lease_handed_off' });
      expect(release.status).toBe(409);
      expect(await release.json()).toEqual({ error: 'xo_lease_handed_off' });

      const reservation = await app.request('/api/board/xo-lease/handoff', { headers });
      expect(reservation.status).toBe(200);
      expect(await reservation.json()).toEqual({
        successor_principal_id: 'xo-successor',
        reserved_until: handed.reserved_until,
        directed_by: 'john-operator',
      });

      await db.query('UPDATE board_xo_leases SET handoff_reserved_until = $1 WHERE id = 1', [
        '2000-01-01T00:00:00.000Z',
      ]);
      const expired = await app.request('/api/board/xo-lease/handoff', { headers });
      expect(expired.status).toBe(200);
      expect(await expired.json()).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.BOARD_PRINCIPALS_JSON;
      else process.env.BOARD_PRINCIPALS_JSON = previous;
    }
  });

  test('handoff rejects unauthenticated principals and undeclared body fields', async () => {
    const app = makeApp('secret-token');
    const headers = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
    };
    setBoardPrincipalResolverForTests(async () => null);
    const rejected = await app.request('/api/board/xo-lease/handoff', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principal_token: 'john-token',
        expected_fencing_token: 1,
        successor_principal_id: 'xo-successor',
      }),
    });
    expect(rejected.status).toBe(401);

    const appWithPrincipal = makeApp('secret-token');
    const spoofed = await appWithPrincipal.request('/api/board/xo-lease/handoff', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        principal_token: 'john-token',
        principal_id: 'spoofed-body-principal',
        expected_fencing_token: 1,
        successor_principal_id: 'xo-successor',
      }),
    });
    expect(spoofed.status).toBe(400);
    const rows = await db.query('SELECT id FROM board_xo_leases');
    expect(rows.rowCount).toBe(0);
  });
});
