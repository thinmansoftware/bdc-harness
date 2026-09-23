import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';
import {
  createAuthenticatedMessage,
  registerWorker,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';
import { DispatchNonSystemCapability } from '../auth/dispatch-principal';

function setSenderAuthMode(mode: 'enforce'): void {
  process.env.DISPATCH_SENDER_AUTH_MODE = mode;
}

/** Test-local fixture constructor -- production path is createAuthenticatedMessage. */
async function createMessage(
  data: CreateAuthenticatedMessageData & { sender: string; sender_principal_id?: string | null }
): Promise<DispatchMessage> {
  if (data.sender_principal_id) {
    return createAuthenticatedMessage(
      testAuthenticatedCapability(data.sender_principal_id, data.sender),
      data
    );
  }
  return createAuthenticatedMessage(testLegacyCapability(data.sender), data);
}

function testAuthenticatedCapability(principalId: string, sender: string) {
  const token = `test-token-${principalId}-${sender}`;
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    setSenderAuthMode('enforce');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: `test-${principalId}-${sender}`,
        principal_id: principalId,
        token_sha256: createHash('sha256').update(token).digest('hex'),
        status: 'active',
        send_as: [sender],
        receive_as: [sender],
        roles: ['send', 'receive'],
      },
    ]);
    return DispatchNonSystemCapability.fromAuthenticatedRequest({
      principal_id: principalId,
      token,
      requested_sender: sender,
    });
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

function testLegacyCapability(sender: string) {
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'off';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'test-legacy-registry',
        principal_id: 'test-legacy-principal',
        token_sha256: '0'.repeat(64),
        status: 'active',
        send_as: ['claude'],
        receive_as: [],
        roles: ['send'],
      },
    ]);
    return DispatchNonSystemCapability.fromHttpRequest({ requested_sender: sender }).capability;
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

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

/**
 * Stand up the sibling WO's schema additions (route_disposed_at column, the
 * dispatch_receipt_cutover table, and the widened disposition enum) so this WO's
 * cutover-split buckets and disposition pass-through can be exercised even when
 * this WO lands first. `ignore_check_constraints` relaxes the current
 * route_disposition CHECK, which the sibling widens to include 'expired' /
 * 'auto_surfaced'.
 */
async function applySiblingSchema(cutoverAt: string): Promise<void> {
  try {
    await db.query('ALTER TABLE agent_dispatch_messages ADD COLUMN route_disposed_at TEXT');
  } catch {
    /* column already present */
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS dispatch_receipt_cutover (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       applied_at TEXT NOT NULL
     )`
  );
  await db.query(
    `INSERT INTO dispatch_receipt_cutover (id, applied_at) VALUES (1, $1)
     ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at`,
    [cutoverAt]
  );
  await db.query('PRAGMA ignore_check_constraints = ON');
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
    // Headerless off/warn create paths still require a parseable registry.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'default-claude',
        principal_id: 'claude-principal',
        token_sha256: sha('claude-secret'),
        status: 'active',
        send_as: ['claude'],
        receive_as: ['claude'],
        roles: ['send', 'receive'],
      },
      {
        credential_id: 'default-xo',
        principal_id: 'xo-principal',
        token_sha256: sha('xo-secret'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['send'],
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
    delete process.env.DISPATCH_PRINCIPALS_JSON;
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
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

  test('returns an existing HTTP idempotency row after its recipient becomes inactive', async () => {
    const app = makeApp('secret-token');
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' Operator ' }),
    });
    expect(first.status).toBe(200);
    const original = (await first.json()) as { id: string; body: string };
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");

    const retry = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        correlation_id: 'retry-correlation',
        recipient: 'operator',
        body: 'This retry must return the original row.',
      }),
    });

    expect(retry.status).toBe(200);
    expect((await retry.json()) as { id: string; body: string }).toMatchObject(original);
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
  });

  test('publishes Phase 0 dispatch priority and mailbox fields in OpenAPI schemas', async () => {
    const response = await makeApp().request('/api/openapi.json');
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const messageProperties = spec.components.schemas.DispatchMessage?.properties;
    const createProperties = spec.components.schemas.CreateDispatchMessageBody?.properties;
    expect(messageProperties).toMatchObject({
      priority: { enum: ['blocker', 'normal', 'heartbeat'] },
      task_outcome: { nullable: true },
      acknowledged_at: { nullable: true },
      acknowledged_by: { nullable: true },
      addressed_at: { nullable: true },
      addressed_by: { nullable: true },
      escalated_tg_at: { nullable: true },
      escalated_sms_at: { nullable: true },
      subject_key: { nullable: true },
      route_disposition: { nullable: true },
      supersedes_id: { nullable: true },
    });
    expect(createProperties).toMatchObject({
      priority: { enum: ['blocker', 'normal', 'heartbeat'] },
    });
  });

  test('rejects an absent recipient with a named error before insert', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' Missing ' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'dispatch_recipient_rejected:missing_principal'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
  });

  test('rejects an inactive recipient with a named error before insert', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' John ' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'dispatch_recipient_rejected:inactive_principal'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
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

  test('authorizes a canonicalized board petition recipient', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'agent_message',
        recipient: ' BOARD ',
        body: JSON.stringify({
          motion_id: 'M-27',
          file_path: 'docs/board/motions/M-27.md',
          requested_action: 'open discussion',
        }),
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { recipient: string }).toMatchObject({ recipient: 'board' });
  });

  test('does not let a canonicalized board idempotency retry bypass board authorization', async () => {
    const app = makeApp();
    const body = {
      ...VALID_BODY,
      recipient: ' BOARD ',
      body: JSON.stringify({
        motion_id: 'M-27',
        file_path: 'docs/board/motions/M-27.md',
        requested_action: 'open discussion',
      }),
    };
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    principal = { principal_id: 'john-ranson', seat_id: 'john', roles: [] };
    const retry = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify(body),
    });

    expect(retry.status).toBe(403);
    expect(((await retry.json()) as { error: string }).error).toBe(
      'board_petition_principal_required'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
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

  test('dispatch status expires stale workers and surfaces queued operator reports', async () => {
    const app = makeApp('secret-token');
    await registerWorker({
      worker_id: 'worker-stale',
      host: 'host',
      capabilities: { providers: ['claude', 'codex'] },
      max_concurrency: 2,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-stale', new Date(Date.now() - 10 * 60_000).toISOString()]
    );
    await createMessage({
      correlation_id: 'report-correlation',
      idempotency_key: 'report-idempotency',
      task_type: 'run_report',
      sender: 'claude',
      recipient: 'xo',
      body: 'Overnight report is ready for John.',
    });

    const response = await app.request('/api/dispatch/status?worker_stale_after_ms=1000', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });

    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      queue: Record<string, number>;
      workers: { worker_id: string; status: string }[];
      operator_reports: { recipient: string; body_preview: string }[];
    };
    expect(status.queue.queued).toBe(1);
    expect(status.workers[0]?.status).toBe('unavailable');
    expect(status.operator_reports).toEqual([
      expect.objectContaining({
        recipient: 'xo',
        body_preview: 'Overnight report is ready for John.',
      }),
    ]);
  });

  test('acknowledges a mailbox message without changing its queue status', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-success',
      recipient: 'operator',
      priority: 'blocker',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: ' Operator ' }),
      }
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()) as { status: string; priority: string; acknowledged_by: string }
    ).toMatchObject({
      status: 'queued',
      priority: 'blocker',
      acknowledged_by: 'operator',
    });
    const stored = await db.query<{ status: string; acknowledged_by: string | null }>(
      'SELECT status, acknowledged_by FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]).toEqual({ status: 'queued', acknowledged_by: 'operator' });
  });

  test('maps acknowledgement lifecycle outcomes without cancellation side effects', async () => {
    const wrongMode = await createMessage({ ...VALID_BODY, idempotency_key: 'ack-wrong-mode' });
    const wrongRecipient = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-wrong-recipient',
      recipient: 'xo',
    });
    const notQueued = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-not-queued',
      recipient: 'operator',
    });
    const actorMismatch = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-actor-mismatch',
      recipient: 'operator',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'cancelled' WHERE id = $1", [
      notQueued.id,
    ]);
    await db.query(
      'UPDATE agent_dispatch_messages SET acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1',
      [actorMismatch.id, 'xo', new Date().toISOString()]
    );
    const app = makeApp('secret-token');
    // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01: the operator token binds actor
    // 'operator'; the body principal_id is a cross-check only.
    const cases = [
      { id: 'missing', principal_id: 'operator', status: 404, error: 'not_found' },
      { id: wrongRecipient.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: notQueued.id, principal_id: 'operator', status: 409, error: 'not_queued' },
      { id: actorMismatch.id, principal_id: 'operator', status: 409, error: 'actor_mismatch' },
    ];
    for (const expected of cases) {
      const response = await app.request(`/api/dispatch/messages/${expected.id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: expected.principal_id }),
      });
      expect(response.status).toBe(expected.status);
      expect(((await response.json()) as { error: string }).error).toBe(expected.error);
    }
    // wrong_mode requires the actor to BE the recipient. Under the new binding
    // that means authenticating as 'codex' (worker_poll) via a dispatch-principal
    // credential -- the body can no longer conjure the actor.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'codex-cred',
        principal_id: 'codex',
        token_sha256: sha('codex-secret'),
        status: 'active',
        send_as: ['codex'],
        receive_as: ['codex'],
        roles: ['send', 'receive'],
      },
    ]);
    const codexWrongMode = await app.request(`/api/dispatch/messages/${wrongMode.id}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
        'x-dispatch-principal-id': 'codex',
        'x-dispatch-principal-token': 'codex-secret',
      },
      body: JSON.stringify({ principal_id: 'codex' }),
    });
    expect(codexWrongMode.status).toBe(409);
    expect(((await codexWrongMode.json()) as { error: string }).error).toBe('wrong_mode');
    const preserved = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM agent_dispatch_messages WHERE id IN ($1, $2, $3, $4) ORDER BY id',
      [wrongMode.id, wrongRecipient.id, notQueued.id, actorMismatch.id]
    );
    expect(preserved.rows.map(row => row.status).sort()).toEqual([
      'cancelled',
      'queued',
      'queued',
      'queued',
    ]);
  });

  test('addresses an acknowledged mailbox message without changing its queue status', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-success',
      recipient: 'operator',
    });
    const app = makeApp('secret-token');
    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'operator' }),
    });
    expect(ack.status).toBe(200);
    const response = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'operator' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string; addressed_by: string }).toMatchObject({
      status: 'queued',
      addressed_by: 'operator',
    });
  });

  test('maps address lifecycle outcomes without cancellation side effects', async () => {
    const wrongMode = await createMessage({ ...VALID_BODY, idempotency_key: 'address-wrong-mode' });
    const wrongRecipient = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-wrong-recipient',
      recipient: 'xo',
    });
    const notQueued = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-not-queued',
      recipient: 'operator',
    });
    const beforeAck = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-before-ack',
      recipient: 'operator',
    });
    const actorMismatch = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-actor-mismatch',
      recipient: 'operator',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'cancelled' WHERE id = $1", [
      notQueued.id,
    ]);
    await db.query(
      'UPDATE agent_dispatch_messages SET acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1',
      [actorMismatch.id, 'xo', new Date().toISOString()]
    );
    const app = makeApp('secret-token');
    const cases = [
      { id: 'missing', principal_id: 'operator', status: 404, error: 'not_found' },
      { id: wrongRecipient.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: notQueued.id, principal_id: 'operator', status: 409, error: 'not_queued' },
      { id: beforeAck.id, principal_id: 'operator', status: 409, error: 'address_before_ack' },
      { id: actorMismatch.id, principal_id: 'operator', status: 409, error: 'actor_mismatch' },
    ];
    for (const expected of cases) {
      const response = await app.request(`/api/dispatch/messages/${expected.id}/address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: expected.principal_id }),
      });
      expect(response.status).toBe(expected.status);
      expect(((await response.json()) as { error: string }).error).toBe(expected.error);
    }
    // wrong_mode requires the actor to be the (worker_poll) recipient 'codex',
    // reached only via a dispatch-principal credential.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'codex-cred',
        principal_id: 'codex',
        token_sha256: sha('codex-secret'),
        status: 'active',
        send_as: ['codex'],
        receive_as: ['codex'],
        roles: ['send', 'receive'],
      },
    ]);
    const codexWrongMode = await app.request(`/api/dispatch/messages/${wrongMode.id}/address`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
        'x-dispatch-principal-id': 'codex',
        'x-dispatch-principal-token': 'codex-secret',
      },
      body: JSON.stringify({ principal_id: 'codex' }),
    });
    expect(codexWrongMode.status).toBe(409);
    expect(((await codexWrongMode.json()) as { error: string }).error).toBe('wrong_mode');
    const preserved = await db.query<{ status: string }>(
      'SELECT status FROM agent_dispatch_messages WHERE id IN ($1, $2, $3, $4, $5)',
      [wrongMode.id, wrongRecipient.id, notQueued.id, beforeAck.id, actorMismatch.id]
    );
    expect(preserved.rows.map(row => row.status).sort()).toEqual([
      'cancelled',
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
  });

  test('requires operator authentication before a mailbox lifecycle action', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-auth',
      recipient: 'operator',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ principal_id: 'operator' }),
      }
    );
    expect(response.status).toBe(401);
    const stored = await db.query<{ acknowledged_by: string | null }>(
      'SELECT acknowledged_by FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]?.acknowledged_by).toBeNull();
  });

  // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01 (M-187a item 2): the mailbox
  // receipt actor is the authenticated caller, never the body.
  describe('mailbox actor binding', () => {
    const LEASE_ID = 'lease-xo-route';
    const FENCING = 5;
    const HOLDER_TOKEN = 'holder-secret-route';
    const BOARD_TOKEN = 'board-token-route';

    async function seedLease(overrides?: {
      fencing?: number;
      leaseId?: string;
      holderToken?: string;
      expiresInMs?: number;
      released?: boolean;
    }): Promise<void> {
      const now = new Date();
      await db.query(
        `INSERT INTO board_xo_leases (
           id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
           fencing_token, acquired_at, renewed_at, expires_at, released_at
         )
         VALUES (1, $1, 'xo', 'xo', 'holder-xo', $2, $3, $4, NULL, $5, $6)
         ON CONFLICT(id) DO UPDATE SET
           lease_id = excluded.lease_id, holder_token_hash = excluded.holder_token_hash,
           fencing_token = excluded.fencing_token, expires_at = excluded.expires_at,
           released_at = excluded.released_at`,
        [
          overrides?.leaseId ?? LEASE_ID,
          sha(overrides?.holderToken ?? HOLDER_TOKEN),
          overrides?.fencing ?? FENCING,
          now.toISOString(),
          new Date(now.getTime() + (overrides?.expiresInMs ?? 60_000)).toISOString(),
          overrides?.released ? now.toISOString() : null,
        ]
      );
    }

    function leaseHeaders(overrides?: {
      board?: string | null;
      holder?: string | null;
      leaseId?: string | null;
      fencing?: string | null;
    }): Record<string, string> {
      // No Content-Type / body: an empty json body would fail request validation.
      const headers: Record<string, string> = {};
      const board = overrides?.board === undefined ? BOARD_TOKEN : overrides.board;
      const holder = overrides?.holder === undefined ? HOLDER_TOKEN : overrides.holder;
      const leaseId = overrides?.leaseId === undefined ? LEASE_ID : overrides.leaseId;
      const fencing = overrides?.fencing === undefined ? String(FENCING) : overrides.fencing;
      if (board !== null) headers['x-board-principal-token'] = board;
      if (holder !== null) headers['x-xo-holder-token'] = holder;
      if (leaseId !== null) headers['x-xo-lease-id'] = leaseId;
      if (fencing !== null) headers['x-xo-fencing-token'] = fencing;
      return headers;
    }

    async function ackedAt(id: string): Promise<string | null> {
      const row = await db.query<{ acknowledged_at: string | null }>(
        'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
        [id]
      );
      return row.rows[0]?.acknowledged_at ?? null;
    }

    test('operator token + body {principal_id:xo} on an xo row is 409 actor_mismatch', async () => {
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-mismatch',
        recipient: 'xo',
      });
      const response = await makeApp('secret-token').request(
        `/api/dispatch/messages/${message.id}/ack`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
          },
          body: JSON.stringify({ principal_id: 'xo' }),
        }
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('actor_mismatch');
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('operator token + NO body on an xo row is 409 wrong_recipient (omission path)', async () => {
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-omit-xo',
        recipient: 'xo',
      });
      const response = await makeApp('secret-token').request(
        `/api/dispatch/messages/${message.id}/ack`,
        { method: 'POST', headers: { 'x-archon-operator-token': 'secret-token' } }
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('wrong_recipient');
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('operator token + NO body on an operator row acknowledges as operator', async () => {
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-omit-op',
        recipient: 'operator',
      });
      const response = await makeApp('secret-token').request(
        `/api/dispatch/messages/${message.id}/ack`,
        { method: 'POST', headers: { 'x-archon-operator-token': 'secret-token' } }
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { acknowledged_by: string }).acknowledged_by).toBe(
        'operator'
      );
    });

    test('the four lease proofs acknowledge an xo row as xo', async () => {
      await seedLease();
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-xo-ok',
        recipient: 'xo',
      });
      const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { acknowledged_by: string }).acknowledged_by).toBe('xo');
      expect(await ackedAt(message.id)).not.toBeNull();
    });

    test('any one missing lease proof is 401 dispatch_actor_unbound, nothing written', async () => {
      await seedLease();
      for (const drop of ['board', 'holder', 'leaseId', 'fencing'] as const) {
        const message = await createMessage({
          ...VALID_BODY,
          idempotency_key: `bind-missing-${drop}`,
          recipient: 'xo',
        });
        const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
          method: 'POST',
          headers: leaseHeaders({ [drop]: null }),
        });
        expect(response.status).toBe(401);
        expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
        expect(await ackedAt(message.id)).toBeNull();
      }
    });

    test('a stale fencing token, an expired lease, and a released lease are each 401', async () => {
      // Stale fencing (F-1): route-level lease read rejects it before the DAL.
      await seedLease({ fencing: FENCING });
      const staleMsg = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-stale-fence',
        recipient: 'xo',
      });
      const stale = await makeApp().request(`/api/dispatch/messages/${staleMsg.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders({ fencing: String(FENCING - 1) }),
      });
      expect(stale.status).toBe(401);
      expect(await ackedAt(staleMsg.id)).toBeNull();

      // Expired lease: getCurrentXoLease returns null -> unbound.
      await seedLease({ expiresInMs: -1000 });
      const expMsg = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-expired',
        recipient: 'xo',
      });
      const expired = await makeApp().request(`/api/dispatch/messages/${expMsg.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect(expired.status).toBe(401);
      expect(await ackedAt(expMsg.id)).toBeNull();

      // Released lease: getCurrentXoLease returns null -> unbound.
      await seedLease({ released: true });
      const relMsg = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-released',
        recipient: 'xo',
      });
      const released = await makeApp().request(`/api/dispatch/messages/${relMsg.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect(released.status).toBe(401);
      expect(await ackedAt(relMsg.id)).toBeNull();
    });

    test('a wrong holder token slips past the route but the DAL re-check rejects lease_fence_stale', async () => {
      // The route verifies board principal + lease_id + fencing; the holder-token
      // hash is the authoritative fourth proof re-checked INSIDE the DAL write
      // transaction. A holder token that does not hash to the live lease (e.g. a
      // lease re-keyed between the route read and the write) is lease_fence_stale.
      await seedLease();
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-stale',
        recipient: 'xo',
      });
      const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders({ holder: 'wrong-holder-token' }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('lease_fence_stale');
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('a credential presented for principal_id=xo is rejected even with a matching registry token', async () => {
      process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
        {
          credential_id: 'xo-cred',
          principal_id: 'xo',
          token_sha256: sha('xo-token'),
          status: 'active',
          send_as: ['xo'],
          receive_as: ['xo'],
          roles: ['send', 'receive'],
        },
      ]);
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-cred-xo',
        recipient: 'xo',
      });
      const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: {
          'x-dispatch-principal-id': 'xo',
          'x-dispatch-principal-token': 'xo-token',
        },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('an invalid credential does not fall back to a valid operator token', async () => {
      process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
        {
          credential_id: 'codex-cred',
          principal_id: 'codex',
          token_sha256: sha('codex-token'),
          status: 'active',
          send_as: ['codex'],
          receive_as: ['codex'],
          roles: ['send', 'receive'],
        },
      ]);
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-cred-invalid',
        recipient: 'operator',
      });
      const response = await makeApp('secret-token').request(
        `/api/dispatch/messages/${message.id}/ack`,
        {
          method: 'POST',
          headers: {
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'codex',
            'x-dispatch-principal-token': 'wrong-token',
          },
        }
      );
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('headers for an unregistered principal are 401, the row untouched', async () => {
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-fable',
        recipient: 'operator',
      });
      const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: {
          'x-dispatch-principal-id': 'fable',
          'x-dispatch-principal-token': 'fable-token',
        },
      });
      expect(response.status).toBe(401);
      expect(await ackedAt(message.id)).toBeNull();
    });

    test('/address before /ack under a valid lease is 409 address_before_ack', async () => {
      await seedLease();
      const message = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'bind-addr-before-ack',
        recipient: 'xo',
      });
      const response = await makeApp().request(`/api/dispatch/messages/${message.id}/address`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('address_before_ack');
    });

    // A valid lease acks an auto_surfaced row (disposition is not terminal for
    // it); disposition_terminal on an 'expired' row is the SIBLING's DAL gate,
    // so this branch tolerates either outcome for the expired case.
    test('auto_surfaced acks under a lease; expired is the sibling disposition_terminal gate', async () => {
      await applySiblingSchema(new Date().toISOString());
      await seedLease();

      const surfaced = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'disp-surfaced',
        recipient: 'xo',
      });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
        [surfaced.id, new Date().toISOString()]
      );
      const surfacedAck = await makeApp().request(`/api/dispatch/messages/${surfaced.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect(surfacedAck.status).toBe(200);
      const surfacedBody = (await surfacedAck.json()) as {
        acknowledged_by: string;
        route_disposition: string;
      };
      expect(surfacedBody.acknowledged_by).toBe('xo');
      expect(surfacedBody.route_disposition).toBe('auto_surfaced');

      const expired = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'disp-expired',
        recipient: 'xo',
      });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'expired', route_disposed_at = $2 WHERE id = $1",
        [expired.id, new Date().toISOString()]
      );
      const expiredAck = await makeApp().request(`/api/dispatch/messages/${expired.id}/ack`, {
        method: 'POST',
        headers: leaseHeaders(),
      });
      expect([200, 409]).toContain(expiredAck.status);
      if (expiredAck.status === 409) {
        expect(((await expiredAck.json()) as { error: string }).error).toBe('disposition_terminal');
      }
    });
  });

  // WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01 (M-187a item 5): /api/dispatch/status
  // mailbox depth in seven exclusive, exhaustive cutover-split buckets. These
  // tests stand up the sibling's schema (cutover table + route_disposed_at +
  // relaxed disposition CHECK) so the combination is exercised even when this WO
  // lands first.
  describe('dispatch status mailbox depth', () => {
    test('status reports mailbox buckets keyed by principal and keeps worker_lifecycle', async () => {
      const response = await makeApp('secret-token').request('/api/dispatch/status', {
        headers: { 'x-archon-operator-token': 'secret-token' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        mailbox: Record<string, Record<string, number>>;
        worker_lifecycle: Record<string, number>;
        cutover_at: string | null;
      };
      expect(Object.keys(body.mailbox.xo ?? {}).sort()).toEqual(
        [
          'acked_open',
          'addressed_by_mind',
          'disposed_by_machine',
          'legacy_unverified',
          'surfaced_acked',
          'surfaced_unacked',
          'unread',
        ].sort()
      );
      expect(body.worker_lifecycle).toBeDefined();
      // With the sibling's cutover table absent, cutover_at is null.
      expect(body.cutover_at).toBeNull();
    });

    test('the eight-row fixture lands each row in exactly one bucket, summing to eight', async () => {
      const cutover = new Date('2026-09-23T12:00:00.000Z');
      const pre = new Date(cutover.getTime() - 60_000).toISOString();
      const post = new Date(cutover.getTime() + 60_000).toISOString();
      await applySiblingSchema(cutover.toISOString());

      // (a) untouched -> unread
      await createMessage({ ...VALID_BODY, idempotency_key: 'fx-a', recipient: 'xo' });
      // (b) acked pre-C, not addressed -> legacy_unverified
      const b = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-b', recipient: 'xo' });
      await db.query(
        'UPDATE agent_dispatch_messages SET acknowledged_at = $2, acknowledged_by = $3 WHERE id = $1',
        [b.id, pre, 'xo']
      );
      // (c) acked + addressed pre-C -> legacy_unverified
      const c = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-c', recipient: 'xo' });
      await db.query(
        `UPDATE agent_dispatch_messages
         SET acknowledged_at = $2, acknowledged_by = 'xo', addressed_at = $2, addressed_by = 'xo'
         WHERE id = $1`,
        [c.id, pre]
      );
      // (d) acked post-C, not addressed -> acked_open
      const d = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-d', recipient: 'xo' });
      await db.query(
        "UPDATE agent_dispatch_messages SET acknowledged_at = $2, acknowledged_by = 'xo' WHERE id = $1",
        [d.id, post]
      );
      // (e) acked + addressed post-C -> addressed_by_mind
      const e = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-e', recipient: 'xo' });
      await db.query(
        `UPDATE agent_dispatch_messages
         SET acknowledged_at = $2, acknowledged_by = 'xo', addressed_at = $2, addressed_by = 'xo'
         WHERE id = $1`,
        [e.id, post]
      );
      // (f) disposed 'expired' post-C, unacked -> disposed_by_machine
      const f = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-f', recipient: 'xo' });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'expired', route_disposed_at = $2 WHERE id = $1",
        [f.id, post]
      );
      // (g) disposed 'auto_surfaced', unacked -> surfaced_unacked
      const g = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-g', recipient: 'xo' });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
        [g.id, post]
      );
      // (h) disposed 'auto_surfaced', acked post-C -> surfaced_acked
      const h = await createMessage({ ...VALID_BODY, idempotency_key: 'fx-h', recipient: 'xo' });
      await db.query(
        `UPDATE agent_dispatch_messages
         SET route_disposition = 'auto_surfaced', route_disposed_at = $2,
             acknowledged_at = $2, acknowledged_by = 'xo'
         WHERE id = $1`,
        [h.id, post]
      );

      const response = await makeApp('secret-token').request('/api/dispatch/status', {
        headers: { 'x-archon-operator-token': 'secret-token' },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        mailbox: Record<string, Record<string, number>>;
        cutover_at: string | null;
      };
      expect(body.cutover_at).toBe(cutover.toISOString());
      const xo = body.mailbox.xo;
      expect(xo).toEqual({
        unread: 1,
        legacy_unverified: 2,
        acked_open: 1,
        addressed_by_mind: 1,
        disposed_by_machine: 1,
        surfaced_unacked: 1,
        surfaced_acked: 1,
      });
      const sum = Object.values(xo).reduce((total, n) => total + n, 0);
      expect(sum).toBe(8);
    });

    test('the messages list filters by route_disposition, returning surfaced but not expired', async () => {
      await applySiblingSchema(new Date().toISOString());
      const surfaced = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'flt-surfaced',
        recipient: 'operator',
      });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
        [surfaced.id, new Date().toISOString()]
      );
      const expired = await createMessage({
        ...VALID_BODY,
        idempotency_key: 'flt-expired',
        recipient: 'operator',
      });
      await db.query(
        "UPDATE agent_dispatch_messages SET route_disposition = 'expired', route_disposed_at = $2 WHERE id = $1",
        [expired.id, new Date().toISOString()]
      );
      const response = await makeApp('secret-token').request(
        '/api/dispatch/messages?recipient=operator&route_disposition=auto_surfaced',
        { headers: { 'x-archon-operator-token': 'secret-token' } }
      );
      expect(response.status).toBe(200);
      const ids = ((await response.json()) as { id: string }[]).map(row => row.id);
      expect(ids).toContain(surfaced.id);
      expect(ids).not.toContain(expired.id);
    });
  });

  test('accepts only approved structured non-production execution handoffs', async () => {
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'xo-active',
        principal_id: 'xo-principal',
        token_sha256: digest('xo-secret'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['send'],
      },
    ]);
    const app = makeApp('secret-token');
    const valid = {
      correlation_id: 'handoff-correlation',
      idempotency_key: 'handoff-idempotency',
      target: 'cauldron',
      work_order_id: 'WO-HARNESS-DISPATCH-RESTORE-01',
      environment: 'staging',
      target_repo: 'thinmansoftware/bdc-harness',
      target_ref: 'c8ee059de5a5aecf550e5298db8a24aba46809cd',
      approved: true,
      approved_by: 'john-ranson',
      approval_ref: 'M-48',
      objective: 'Run the approved staging-only verification workflow.',
      constraints: ['no production deploy', 'no customer sends'],
    };
    const principalHeaders = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
      'x-dispatch-principal-id': 'xo-principal',
      'x-dispatch-principal-token': 'xo-secret',
    } as const;
    const accepted = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: { ...principalHeaders },
      body: JSON.stringify(valid),
    });
    expect(accepted.status).toBe(200);
    const message = (await accepted.json()) as {
      task_type: string;
      recipient: string;
      body: string;
      sender: string;
      sender_principal_id: string | null;
    };
    expect(message.task_type).toBe('run_report');
    expect(message.recipient).toBe('cauldron');
    expect(message.sender).toBe('xo');
    expect(message.sender_principal_id).toBe('xo-principal');
    expect(JSON.parse(message.body)).toEqual(
      expect.objectContaining({
        kind: 'approved_execution_handoff',
        approved: true,
        environment: 'staging',
      })
    );

    const overseer = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: { ...principalHeaders },
      body: JSON.stringify({
        ...valid,
        correlation_id: 'handoff-overseer-correlation',
        idempotency_key: 'handoff-overseer-idempotency',
        target: 'overseer',
      }),
    });
    expect(overseer.status).toBe(200);

    const status = await app.request('/api/dispatch/status', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    expect(status.status).toBe(200);
    expect(
      (
        (await status.json()) as { execution_handoffs: { recipient: string }[] }
      ).execution_handoffs.map(handoff => handoff.recipient)
    ).toEqual(expect.arrayContaining(['cauldron', 'overseer']));

    const rejected = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify({ ...valid, environment: 'production' }),
    });
    expect(rejected.status).toBe(400);
  });

  test('rejects repo mutation hidden in a free-form run_report', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'run_report',
        body: 'Commit the patch and push the branch.',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'repo_mutating_dispatch_body_rejected'
    );
  });

  describe('Phase 1.5 sender authentication HTTP modes', () => {
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    const principalsJson = () =>
      JSON.stringify([
        {
          credential_id: 'claude-active',
          principal_id: 'claude-principal',
          token_sha256: digest('claude-secret'),
          status: 'active',
          send_as: ['claude'],
          receive_as: ['claude'],
          roles: ['send', 'receive'],
        },
        {
          credential_id: 'xo-active',
          principal_id: 'xo-principal',
          token_sha256: digest('xo-secret'),
          status: 'active',
          send_as: ['xo'],
          receive_as: ['xo'],
          roles: ['send'],
        },
        {
          credential_id: 'disabled',
          principal_id: 'disabled-principal',
          token_sha256: digest('disabled-secret'),
          status: 'disabled',
          send_as: ['claude'],
          receive_as: [],
          roles: ['send'],
        },
      ]);

    function applySenderAuthMode(mode: string): void {
      process.env.DISPATCH_SENDER_AUTH_MODE = mode;
    }

    beforeEach(() => {
      process.env.DISPATCH_PRINCIPALS_JSON = principalsJson();
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
    });

    afterEach(() => {
      delete process.env.DISPATCH_PRINCIPALS_JSON;
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
    });

    test('off admits legacy silence; warn admits with null principal; enforce rejects missing', async () => {
      applySenderAuthMode('off');
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'Legacy.Agent',
          idempotency_key: 'legacy-off',
        }),
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { sender_principal_id: string | null }).sender_principal_id
      ).toBeNull();

      applySenderAuthMode('warn');
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'Legacy.Agent',
          idempotency_key: 'legacy-warn',
        }),
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { sender_principal_id: string | null }).sender_principal_id
      ).toBeNull();

      applySenderAuthMode('enforce');
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'legacy-enforce' }),
      });
      expect(response.status).toBe(401);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'legacy-enforce',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('execution handoff rejects an invalid sender auth mode without mutation', async () => {
      applySenderAuthMode('invalid-mode');
      const response = await makeApp('secret-token').request('/api/dispatch/execution-handoffs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo-principal',
          'x-dispatch-principal-token': 'xo-secret',
        },
        body: JSON.stringify({
          correlation_id: 'invalid-mode-handoff-correlation',
          idempotency_key: 'invalid-mode-handoff',
          target: 'overseer',
          work_order_id: 'WO-TEST-INVALID-MODE',
          environment: 'local',
          target_repo: 'thinmansoftware/bdc-harness',
          target_ref: 'a'.repeat(40),
          approved: true,
          approved_by: 'xo',
          approval_ref: 'test-invalid-mode',
          objective: 'prove invalid sender auth mode fails closed',
          constraints: [],
        }),
      });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toBe(
        'dispatch_sender_auth_mode_invalid'
      );
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'invalid-mode-handoff',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('partial and invalid credentials fail closed in every mode without mutation', async () => {
      for (const mode of ['off', 'warn', 'enforce'] as const) {
        applySenderAuthMode(mode);
        const before = (await db.query('SELECT id FROM agent_dispatch_messages')).rowCount;
        let response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'claude-principal',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `partial-${mode}` }),
        });
        expect(response.status).toBe(401);

        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'claude-principal',
            'x-dispatch-principal-token': 'wrong',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `invalid-${mode}` }),
        });
        expect(response.status).toBe(401);

        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'disabled-principal',
            'x-dispatch-principal-token': 'disabled-secret',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `disabled-${mode}` }),
        });
        expect(response.status).toBe(401);
        expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(before);
      }
    });

    test('valid principal binds sender and rejects forged selector', async () => {
      applySenderAuthMode('enforce');
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'auth-ok', sender: 'claude' }),
      });
      expect(response.status).toBe(200);
      const message = (await response.json()) as {
        sender: string;
        sender_principal_id: string;
      };
      expect(message.sender).toBe('claude');
      expect(message.sender_principal_id).toBe('claude-principal');

      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'auth-forge', sender: 'xo' }),
      });
      expect(response.status).toBe(403);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'auth-forge',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('board path namespaces principal and execution handoff requires xo send_as', async () => {
      applySenderAuthMode('enforce');
      let response = await makeApp().request('/api/dispatch/messages', {
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
      expect(response.status).toBe(200);
      expect(((await response.json()) as { sender_principal_id: string }).sender_principal_id).toBe(
        'board:claude'
      );

      response = await makeApp('secret-token').request('/api/dispatch/execution-handoffs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo-principal',
          'x-dispatch-principal-token': 'xo-secret',
        },
        body: JSON.stringify({
          correlation_id: 'corr-handoff',
          idempotency_key: 'handoff-1',
          target: 'overseer',
          work_order_id: 'WO-TEST-1',
          environment: 'local',
          target_repo: 'thinmansoftware/bdc-harness',
          target_ref: 'a'.repeat(40),
          approved: true,
          approved_by: 'xo',
          approval_ref: 'ref-1',
          objective: 'ship phase15',
          constraints: [],
        }),
      });
      expect(response.status).toBe(200);
      const handoff = (await response.json()) as { sender: string; sender_principal_id: string };
      expect(handoff.sender).toBe('xo');
      expect(handoff.sender_principal_id).toBe('xo-principal');
    });

    test('malformed registry fails closed and never becomes legacy traffic', async () => {
      applySenderAuthMode('warn');
      process.env.DISPATCH_PRINCIPALS_JSON = '{';
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'bad-registry' }),
      });
      expect(response.status).toBe(500);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'bad-registry',
          ])
        ).rowCount
      ).toBe(0);

      // Headerless off/warn must also parse the registry; never silently downgrade.
      for (const mode of ['off', 'warn'] as const) {
        applySenderAuthMode(mode);
        process.env.DISPATCH_PRINCIPALS_JSON = '{';
        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
          },
          body: JSON.stringify({
            ...VALID_BODY,
            idempotency_key: `bad-registry-headerless-${mode}`,
          }),
        });
        expect(response.status).toBe(500);
        expect(
          (
            await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
              `bad-registry-headerless-${mode}`,
            ])
          ).rowCount
        ).toBe(0);
      }

      applySenderAuthMode('off');
      delete process.env.DISPATCH_PRINCIPALS_JSON;
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'missing-registry-headerless' }),
      });
      expect(response.status).toBe(500);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'missing-registry-headerless',
          ])
        ).rowCount
      ).toBe(0);
    });
  });
});
