import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';
import { registerWorker } from '@archon/core/db/dispatch';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

let db: SqliteAdapter;
let currentDbPath = '';
let principal = {
  principal_id: 'claude',
  seat_id: 'xo' as const,
  roles: ['motion_notifier', 'petition_eligible'],
};

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => db,
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
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

for (const moduleName of [
  '@archon/core/db/conversations',
  '@archon/core/db/codebases',
  '@archon/core/db/env-vars',
  '@archon/core/db/isolation-environments',
  '@archon/core/db/workflows',
  '@archon/core/db/workflow-events',
  '@archon/core/db/messages',
  '@archon/core/utils/commands',
]) {
  mock.module(moduleName, () => ({
    listConversations: mock(async () => []),
    findConversationByPlatformId: mock(async () => null),
    getOrCreateConversation: mock(async () => null),
    softDeleteConversation: mock(async () => {}),
    updateConversationTitle: mock(async () => {}),
    getConversationById: mock(async () => null),
    listCodebases: mock(async () => []),
    getCodebase: mock(async () => null),
    deleteCodebase: mock(async () => {}),
    listEnvVars: mock(async () => []),
    setEnvVar: mock(async () => null),
    deleteEnvVar: mock(async () => false),
    listByCodebase: mock(async () => []),
    updateStatus: mock(async () => {}),
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
    listWorkflowEvents: mock(async () => []),
    addMessage: mock(async () => null),
    listMessages: mock(async () => []),
    findMarkdownFilesRecursive: mock(async () => []),
  }));
}

import { registerApiRoutes } from './api';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
  if (token) process.env.ARCHON_OPERATOR_TOKEN = token;
  else delete process.env.ARCHON_OPERATOR_TOKEN;
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerApiRoutes(
    app,
    {
      setConversationDbId: mock(() => {}),
      emitSSE: mock(async () => {}),
      emitLockEvent: mock(async () => {}),
      registerStream: mock(() => {}),
      removeStream: mock(() => {}),
    } as unknown as WebAdapter,
    {
      acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' };
      }),
      getStats: mock(() => ({ active: 0, queued: 0 })),
    } as unknown as ConversationLockManager
  );
  return app;
}

const VALID_BODY = {
  correlation_id: 'corr-1',
  idempotency_key: 'idem-1',
  task_type: 'agent_message',
  sender: 'claude',
  recipient: 'codex',
  body: 'Please summarize this.',
};

describe('dispatch API', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.DISPATCH_WORKER_CREDENTIALS_JSON = JSON.stringify([
      {
        credential_id: 'board-worker-1',
        worker_id: 'worker-a',
        role: 'board_delivery_worker',
        allowed_principals: ['claude'],
        token_sha256: sha('worker-secret'),
        status: 'active',
      },
    ]);
    principal = {
      principal_id: 'claude',
      seat_id: 'xo',
      roles: ['motion_notifier', 'petition_eligible'],
    };
    setBoardPrincipalResolverForTests(async () => principal);
    currentDbPath = join(
      import.meta.dir,
      `.test-api-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/git/ref/heads/main')) {
        return Response.json({ object: { sha: 'b'.repeat(40) } });
      }
      return Response.json({
        type: 'file',
        sha: 'a'.repeat(40),
        content: Buffer.from('# M-27: Board Motion Dispatch\n', 'utf8').toString('base64'),
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    setBoardPrincipalResolverForTests(undefined);
    delete process.env.ARCHON_OPERATOR_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.DISPATCH_WORKER_CREDENTIALS_JSON;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('rejects unsupported task_type with named validation error', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, task_type: 'run_bash' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('task_type');
  });

  test('rejects repo-mutating agent_message body before insert', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        body: 'Commit the patch, push the branch, merge it to dev, and deploy production.',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'repo_mutating_agent_message_rejected'
    );
  });

  test('requires operator token when configured', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(401);
  });

  test('creates and deduplicates dispatch messages with operator token', async () => {
    const app = makeApp('secret-token');
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify(VALID_BODY),
    });
    const second = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, body: 'second body' }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { body: string }).body).toBe('Please summarize this.');
  });

  test('requires seated motion_notifier for board_motion before insert', async () => {
    principal = { principal_id: 'john-ranson', seat_id: 'john', roles: [] };
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'board_motion',
        sender: 'spoof',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    expect(response.status).toBe(403);
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
  });

  test('creates board_motion with server-derived sender and idempotency key', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        idempotency_key: 'caller-spoof',
        task_type: 'board_motion',
        sender: 'spoof',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as {
      sender: string;
      idempotency_key: string;
      recipient_alias: string;
    };
    expect(message.sender).toBe('claude');
    expect(message.recipient_alias).toBe('board');
    expect(message.idempotency_key).toBe(`board-motion:M-27:${'a'.repeat(40)}:board`);
  });

  test('records board petition evidence without approval side effects', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          file_path: 'docs/board/motions/M-27.md',
          requested_action: 'open discussion',
        }),
      }),
    });
    expect(response.status).toBe(200);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events'
    );
    expect(events.rows.map(row => row.event_type)).toContain('board_petition_delivered');
  });

  test('uses dedicated worker credential for alias list and concrete-principal claim', async () => {
    const app = makeApp();
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, 'lease-1', 'claude', 'xo', 'holder', $1, 3, $2, NULL, $3, NULL)`,
      ['c'.repeat(64), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()]
    );
    const created = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'board_motion',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    const message = (await created.json()) as { id: string };

    const list = await app.request('/api/dispatch/messages?recipient=claude&status=queued', {
      headers: {
        'x-dispatch-worker-id': 'worker-a',
        'x-dispatch-worker-credential-id': 'board-worker-1',
        'x-dispatch-worker-token': 'worker-secret',
      },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { id: string }[]).map(item => item.id)).toContain(message.id);

    const claim = await app.request(`/api/dispatch/messages/${message.id}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dispatch-worker-credential-id': 'board-worker-1',
        'x-dispatch-worker-token': 'worker-secret',
      },
      body: JSON.stringify({ worker_id: 'worker-a', delivery_principal: 'claude' }),
    });
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { resolved_recipient: string }).resolved_recipient).toBe(
      'claude'
    );
  });
});
