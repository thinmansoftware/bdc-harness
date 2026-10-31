import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BASE_TOOL_NAMES } from '../../../companion-mcp/src/constants';
import { loadCompanionRegistry } from '../../../companion-mcp/src/registry';
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

async function seedXoHolderLease(
  holderPrincipalId: string,
  options?: { expiresAt?: string; releasedAt?: string | null }
): Promise<{ holderToken: string; leaseId: string; fencingToken: number }> {
  const holderToken = `holder-${holderPrincipalId}`;
  const leaseId = `lease-${holderPrincipalId}`;
  const fencingToken = 44;
  await db.query('DELETE FROM board_xo_leases');
  await db.query(
    `INSERT INTO board_xo_leases
     (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
      acquired_at, renewed_at, expires_at, released_at)
     VALUES (1, $1, $2, 'xo', $2, $3, $4, $5, NULL, $6, $7)`,
    [
      leaseId,
      holderPrincipalId,
      sha(holderToken),
      fencingToken,
      new Date().toISOString(),
      options?.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      options?.releasedAt ?? null,
    ]
  );
  return { holderToken, leaseId, fencingToken };
}

function xoSeatHeaders(proof: {
  holderToken: string;
  leaseId: string;
  fencingToken: number;
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-archon-operator-token': 'secret-token',
    'x-board-principal-token': 'board-proof',
    'x-xo-holder-token': proof.holderToken,
    'x-xo-lease-id': proof.leaseId,
    'x-xo-fencing-token': String(proof.fencingToken),
  };
}

async function storedReceipt(id: string): Promise<{
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  addressed_by: string | null;
  addressed_at: string | null;
}> {
  const stored = await db.query<{
    status: string;
    acknowledged_by: string | null;
    acknowledged_at: string | null;
    addressed_by: string | null;
    addressed_at: string | null;
  }>(
    `SELECT status, acknowledged_by, acknowledged_at, addressed_by, addressed_at
     FROM agent_dispatch_messages WHERE id = $1`,
    [id]
  );
  const row = stored.rows[0];
  if (!row) throw new Error(`missing dispatch message ${id}`);
  return row;
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

async function insertSyntheticDispatch(input: {
  id: string;
  recipient: string;
  correlationId: string;
  seq: number;
  body: string;
  acknowledged: boolean;
  notBefore?: string | null;
}): Promise<void> {
  const createdAt = new Date(Date.UTC(2020, 0, 1) + input.seq * 1000).toISOString();
  await db.query(
    `INSERT INTO agent_dispatch_messages (
       id, correlation_id, idempotency_key, task_type, sender, recipient, body, status,
       created_at, priority, fencing_token, acknowledged_at, acknowledged_by, not_before, seq
     ) VALUES (
       $1, $2, $3, 'agent_message', 'xo', $4, $5, 'queued', $6, 'normal', 0, $7, $8, $9, $10
     )`,
    [
      input.id,
      input.correlationId,
      `idem-${input.id}`,
      input.recipient,
      input.body,
      createdAt,
      input.acknowledged ? createdAt : null,
      input.acknowledged ? input.recipient : null,
      input.notBefore ?? null,
      input.seq,
    ]
  );
}

function makeApp(
  token?: string,
  dispatchMailboxActorResolvedHook?: () => Promise<void>
): OpenAPIHono {
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
    } as unknown as ConversationLockManager,
    undefined,
    undefined,
    dispatchMailboxActorResolvedHook
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
    delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
    delete process.env.ARCHON_OPERATOR_EMAILS;
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

  test('passes route_disposition through the HTTP list route', async () => {
    const surfaced = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'list-surfaced',
      recipient: 'operator',
    });
    await createMessage({
      ...VALID_BODY,
      idempotency_key: 'list-undisposed',
      recipient: 'operator',
    });
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
      [surfaced.id, new Date().toISOString()]
    );

    const response = await makeApp().request(
      '/api/dispatch/messages?recipient=operator&route_disposition=auto_surfaced'
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Array<{ id: string }>).map(row => row.id)).toEqual([
      surfaced.id,
    ]);
  });

  // WO-HARNESS-DISPATCH-ASTRA-MAILBOX-01: a message to astra is accepted,
  // never claimed by any worker, and only its own actor may ack/address it.
  test('routes astra as an unclaimable mailbox recipient over HTTP', async () => {
    const app = makeApp('secret-token');
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude', 'codex', 'grok', 'cursor'] },
      max_concurrency: 1,
    });

    // (a) posting to astra succeeds and queues the row.
    const created = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        idempotency_key: 'idem-astra-http',
        recipient: 'astra',
        body: 'Arc D ruling for Astra.',
      }),
    });
    expect(created.status).toBe(200);
    const message = (await created.json()) as { id: string; recipient: string; status: string };
    expect(message.recipient).toBe('astra');
    expect(message.status).toBe('queued');

    // (b) a worker with every agent configured cannot claim the astra row --
    // claimMessage refuses any non-worker_poll principal, so the drop-box
    // desktop worker's generic codex leg never takes it. It stays queued/unleased.
    const claim = await app.request(`/api/dispatch/messages/${message.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ worker_id: 'worker-a' }),
    });
    expect(claim.status).toBe(404);
    const stored = await db.query<{ status: string; lease_owner: string | null }>(
      'SELECT status, lease_owner FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]).toEqual({ status: 'queued', lease_owner: null });

    // A body principal is only a cross-check against the authenticated operator actor.
    const wrongAck = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'codex' }),
    });
    expect(wrongAck.status).toBe(409);
    expect(((await wrongAck.json()) as { error: string }).error).toBe('actor_mismatch');

    // No credential binding exists for astra, so the operator token cannot sign for it.
    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: ' Astra ' }),
    });
    expect(ack.status).toBe(409);
    expect(((await ack.json()) as { error: string }).error).toBe('actor_mismatch');
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
      worker_lifecycle: Record<string, number>;
      mailbox: Record<string, unknown>;
      workers: { worker_id: string; status: string }[];
      operator_reports: { recipient: string; body_preview: string }[];
    };
    expect(status.queue.queued).toBe(1);
    expect(status.worker_lifecycle).toEqual(status.queue);
    expect(status.mailbox.xo).toEqual(
      expect.objectContaining({
        unread: 1,
        legacy_unverified: expect.any(Number),
        acked_open: expect.any(Number),
        addressed_by_mind: expect.any(Number),
        disposed_by_machine: expect.any(Number),
        surfaced_unacked: expect.any(Number),
        surfaced_acked: expect.any(Number),
      })
    );
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
    const cases = [
      { id: 'missing', principal_id: 'operator', status: 404, error: 'not_found' },
      { id: wrongMode.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
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

  test('rejects disposition_terminal but permits acknowledgement after auto_surfaced', async () => {
    const expired = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'expired-ack',
      recipient: 'operator',
    });
    const surfaced = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'surfaced-ack',
      recipient: 'operator',
    });
    const stamp = new Date().toISOString();
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'expired', route_disposed_at = $2 WHERE id = $1",
      [expired.id, stamp]
    );
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
      [surfaced.id, stamp]
    );
    const app = makeApp('secret-token');
    const requestAck = (id: string) =>
      app.request(`/api/dispatch/messages/${id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: '{}',
      });
    const refused = await requestAck(expired.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('disposition_terminal');
    const accepted = await requestAck(surfaced.id);
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { route_disposition: string }).route_disposition).toBe(
      'auto_surfaced'
    );
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
      { id: wrongMode.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
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

  test('binds XO receipts to all four live lease proofs and rejects stale fences', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-holder-secret';
    const leaseId = 'xo-lease-current';
    const fencingToken = 17;
    await db.query(
      `INSERT INTO board_xo_leases
       (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
        acquired_at, renewed_at, expires_at, released_at)
       VALUES (1, $1, 'xo', 'xo', 'holder', $2, $3, $4, NULL, $5, NULL)`,
      [
        leaseId,
        sha(holderToken),
        fencingToken,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      ]
    );
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-bound-ack',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const baseHeaders = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
      'x-board-principal-token': 'board-proof',
      'x-xo-holder-token': holderToken,
      'x-xo-lease-id': leaseId,
      'x-xo-fencing-token': String(fencingToken),
    };
    const missingProof = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { ...baseHeaders, 'x-xo-lease-id': '' },
      body: '{}',
    });
    expect(missingProof.status).toBe(401);
    expect(((await missingProof.json()) as { error: string }).error).toBe('dispatch_actor_unbound');

    const staleHolder = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { ...baseHeaders, 'x-xo-holder-token': 'turned-over-holder' },
      body: '{}',
    });
    expect(staleHolder.status).toBe(409);
    expect(((await staleHolder.json()) as { error: string }).error).toBe('lease_fence_stale');

    const acknowledged = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: baseHeaders,
      body: '{}',
    });
    expect(acknowledged.status).toBe(200);
    expect(((await acknowledged.json()) as { acknowledged_by: string }).acknowledged_by).toBe('xo');
  });

  test('rejects expired and released XO leases before mailbox mutation', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-expiry-holder';
    const leaseId = 'xo-expiry-lease';
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-expiry',
      recipient: 'xo',
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-board-principal-token': 'board-proof',
      'x-xo-holder-token': holderToken,
      'x-xo-lease-id': leaseId,
      'x-xo-fencing-token': '21',
    };
    const insertLease = async (expiresAt: string, releasedAt: string | null) => {
      await db.query('DELETE FROM board_xo_leases');
      await db.query(
        `INSERT INTO board_xo_leases
         (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
          acquired_at, renewed_at, expires_at, released_at)
         VALUES (1, $1, 'xo', 'xo', 'holder', $2, 21, $3, NULL, $4, $5)`,
        [leaseId, sha(holderToken), new Date().toISOString(), expiresAt, releasedAt]
      );
    };
    await insertLease(new Date(Date.now() - 1_000).toISOString(), null);
    expect(
      (
        await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status
    ).toBe(401);
    await insertLease(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    expect(
      (
        await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('rejects an unregistered fable identity and leaves its mailbox row untouched', async () => {
    await db.query(
      "INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active) VALUES ('fable', 'Fable', 'drain_on_start', 1)"
    );
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'fable-unbound',
      recipient: 'fable',
    });
    const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dispatch-principal-id': 'fable',
        'x-dispatch-principal-token': 'no-registry-entry',
      },
      body: JSON.stringify({ principal_id: 'fable' }),
    });
    expect(response.status).toBe(401);
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('transactional lease re-read rejects a fencing-token turnover after actor resolution', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-race-holder';
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-race',
      recipient: 'xo',
    });
    await db.query(
      `INSERT INTO board_xo_leases
       (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
        acquired_at, renewed_at, expires_at, released_at)
       VALUES (1, 'lease-old', 'xo', 'xo', 'holder', $1, 30, $2, NULL, $3, NULL)`,
      [sha(holderToken), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]
    );
    const app = makeApp(undefined, async () => {
      await db.query(
        `UPDATE board_xo_leases SET lease_id = 'lease-new', fencing_token = 31,
         acquired_at = $1, expires_at = $2, released_at = NULL WHERE id = 1`,
        [new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]
      );
    });
    const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-board-principal-token': 'board-proof',
        'x-xo-holder-token': holderToken,
        'x-xo-lease-id': 'lease-old',
        'x-xo-fencing-token': '30',
      },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('lease_fence_stale');
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('xo seat ack: claude holder acks an xo row', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-claude',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      acknowledged_by: string;
      acknowledged_at: string | null;
      status: string;
    };
    expect(body.acknowledged_by).toBe('xo');
    expect(body.acknowledged_at).not.toBeNull();
    expect(body.status).toBe('queued');
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_by).toBe('xo');
    expect(stored.acknowledged_at).not.toBeNull();
    expect(stored.status).toBe('queued');
  });

  test('xo seat ack: codex holder acks an xo row', async () => {
    const holder = 'xo-codex-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-codex',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      acknowledged_by: string;
      acknowledged_at: string | null;
    };
    expect(body.acknowledged_by).toBe('xo');
    expect(body.acknowledged_at).not.toBeNull();
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_by).toBe('xo');
    expect(stored.acknowledged_at).not.toBeNull();
  });

  test('xo seat ack: a non-holder xo-seat principal is rejected', async () => {
    principal = { principal_id: 'xo-codex-board-work', seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease('xo-claude-board-work');
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-non-holder',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a principal whose seat is not xo is rejected even when its id equals the holder', async () => {
    principal = { principal_id: 'xo-claude-board-work', seat_id: 'general', roles: [] };
    const proof = await seedXoHolderLease('xo-claude-board-work');
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-wrong-seat',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: expired and released leases held by a real holder are rejected', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-expired',
      recipient: 'xo',
    });
    const expired = await seedXoHolderLease(holder, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const expiredResponse = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(expired), body: '{}' }
    );
    expect(expiredResponse.status).toBe(401);
    const released = await seedXoHolderLease(holder, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      releasedAt: new Date().toISOString(),
    });
    const releasedResponse = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(released), body: '{}' }
    );
    expect(releasedResponse.status).toBe(401);
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a holder-bound ack on a non-xo row is wrong_recipient', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-wrong-recipient',
      recipient: 'operator',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('wrong_recipient');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: acking twice is idempotent', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-twice',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const first = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: xoSeatHeaders(proof),
      body: '{}',
    });
    expect(first.status).toBe(200);
    const firstStored = await storedReceipt(message.id);
    const second = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: xoSeatHeaders(proof),
      body: '{}',
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { acknowledged_by: string };
    expect(secondBody.acknowledged_by).toBe('xo');
    const secondStored = await storedReceipt(message.id);
    expect(secondStored.acknowledged_at).toBe(firstStored.acknowledged_at);
    expect(secondStored.acknowledged_by).toBe('xo');
    expect(firstStored.acknowledged_by).toBe('xo');
  });

  test('xo seat ack: address lifecycle queued to acked_open to addressed', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-lifecycle',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = xoSeatHeaders(proof);
    const earlyAddress = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(earlyAddress.status).toBe(409);
    expect(((await earlyAddress.json()) as { error: string }).error).toBe('address_before_ack');
    expect((await storedReceipt(message.id)).status).toBe('queued');

    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(ack.status).toBe(200);
    expect((await storedReceipt(message.id)).status).toBe('queued');

    const address = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(address.status).toBe(200);
    const addressed = (await address.json()) as {
      addressed_by: string;
      addressed_at: string | null;
      status: string;
    };
    expect(addressed.addressed_by).toBe('xo');
    expect(addressed.addressed_at).not.toBeNull();
    expect(addressed.status).toBe('queued');
    const afterAddress = await storedReceipt(message.id);

    const repeat = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(repeat.status).toBe(200);
    const repeated = await storedReceipt(message.id);
    expect(repeated.addressed_at).toBe(afterAddress.addressed_at);
    expect(repeated.addressed_by).toBe('xo');
    expect(repeated.status).toBe('queued');
  });

  test('xo seat ack: the body may name the holder but no other principal', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const accepted = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-body-holder',
      recipient: 'xo',
    });
    const rejected = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-body-other',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = xoSeatHeaders(proof);
    const ok = await app.request(`/api/dispatch/messages/${accepted.id}/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principal_id: holder }),
    });
    expect(ok.status).toBe(200);
    const mismatch = await app.request(`/api/dispatch/messages/${rejected.id}/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principal_id: 'someone-else' }),
    });
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: string }).error).toBe('actor_mismatch');
    expect((await storedReceipt(rejected.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a bare operator token naming the holder in the body stays actor_mismatch', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-operator-body',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
    };
    for (const principalId of ['xo-claude-board-work', 'xo']) {
      const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ principal_id: principalId }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('actor_mismatch');
    }
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('never falls back from an invalid identity request to the operator token', async () => {
    // Both credential-only XO and invalid-credential-plus-operator paths are dispatch_actor_unbound.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'credential-xo',
        principal_id: 'xo',
        token_sha256: sha('xo-token'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['receive'],
      },
    ]);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'identity-no-fallback',
      recipient: 'operator',
    });
    const app = makeApp('secret-token');
    for (const token of ['xo-token', 'invalid-token']) {
      const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo',
          'x-dispatch-principal-token': token,
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    }
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

  test('lists every dispatch principal with its ack path and no token material', async () => {
    await db.query('DELETE FROM dispatch_principals');
    await db.query(
      `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
       VALUES
         ('codex', 'Codex', 'worker_poll', 1),
         ('john', 'John', 'notify_only', 0),
         ('operator', 'Operator', 'drain_on_start', 1),
         ('xo', 'XO', 'drain_on_start', 1),
         ('xo-fable', 'XO Fable', 'drain_on_start', 1)`
    );
    const secret = 'tok-TESTSECRET-3';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'codex-mcp-receive',
        principal_id: 'codex-mcp',
        token_sha256: sha(secret),
        status: 'active',
        send_as: ['codex-mcp'],
        receive_as: [],
        roles: ['receive'],
      },
    ]);
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as {
      principals: Array<{
        principal_id: string;
        display_name: string;
        delivery_mode: string;
        active: boolean;
        credential_configured: boolean;
        ack_path: string;
      }>;
    };
    expect(body.principals.map(entry => entry.principal_id)).toEqual([
      'codex',
      'john',
      'operator',
      'xo',
      'xo-fable',
    ]);
    expect(body.principals.map(entry => entry.ack_path)).toEqual([
      'worker_claim',
      'none',
      'operator_token',
      'xo_lease',
      'none',
    ]);
    expect(body.principals.map(entry => entry.credential_configured)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(body.principals.map(entry => entry.active)).toEqual([true, false, true, true, true]);
    for (const entry of body.principals) {
      expect(Object.keys(entry).sort()).toEqual([
        'ack_path',
        'active',
        'credential_configured',
        'delivery_mode',
        'display_name',
        'principal_id',
      ]);
    }
    expect(text).not.toContain(secret);
    expect(text).not.toContain(sha(secret));
    expect(text).not.toContain('token_sha256');
  });

  test('credential_configured is true via principal_id or receive_as and selects principal_credential', async () => {
    await db.query('DELETE FROM dispatch_principals');
    await db.query(
      `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
       VALUES
         ('codex', 'Codex', 'worker_poll', 1),
         ('john', 'John', 'notify_only', 1),
         ('operator', 'Operator', 'drain_on_start', 1),
         ('xo', 'XO', 'drain_on_start', 1),
         ('xo-fable', 'XO Fable', 'drain_on_start', 1)`
    );
    const principalSecret = 'tok-TESTSECRET-4';
    const receiveSecret = 'tok-TESTSECRET-5';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'xo-fable-receive',
        principal_id: 'xo-fable',
        token_sha256: sha(principalSecret),
        status: 'active',
        send_as: ['xo-fable'],
        receive_as: [],
        roles: ['receive'],
      },
      {
        credential_id: 'desk-alias-receive',
        principal_id: 'desk-alias',
        token_sha256: sha(receiveSecret),
        status: 'active',
        send_as: ['desk-alias'],
        receive_as: ['john'],
        roles: ['receive'],
      },
    ]);
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as {
      principals: Array<{
        principal_id: string;
        display_name: string;
        delivery_mode: string;
        active: boolean;
        credential_configured: boolean;
        ack_path: string;
      }>;
    };
    expect(body.principals.map(entry => entry.principal_id)).toEqual([
      'codex',
      'john',
      'operator',
      'xo',
      'xo-fable',
    ]);
    const byId = new Map(body.principals.map(entry => [entry.principal_id, entry]));
    expect(byId.get('xo-fable')).toMatchObject({
      credential_configured: true,
      ack_path: 'principal_credential',
      delivery_mode: 'drain_on_start',
    });
    expect(byId.get('john')).toMatchObject({
      credential_configured: true,
      ack_path: 'principal_credential',
      delivery_mode: 'notify_only',
    });
    expect(byId.get('codex')).toMatchObject({
      credential_configured: false,
      ack_path: 'worker_claim',
    });
    expect(byId.get('operator')).toMatchObject({
      credential_configured: false,
      ack_path: 'operator_token',
    });
    expect(byId.get('xo')).toMatchObject({
      credential_configured: false,
      ack_path: 'xo_lease',
    });
    expect(text).not.toContain('desk-alias');
    expect(text).not.toContain(principalSecret);
    expect(text).not.toContain(receiveSecret);
    expect(text).not.toContain(sha(principalSecret));
    expect(text).not.toContain(sha(receiveSecret));
    expect(text).not.toContain('token_sha256');
    expect(text).not.toContain('credential_id');
  });

  test('principals listing requires the operator token', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/principals');
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('principals');
  });

  test('principals listing fails closed when the registry is malformed', async () => {
    process.env.DISPATCH_PRINCIPALS_JSON = '{not json';
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('dispatch_principal_config_invalid');
    expect(body).not.toHaveProperty('principals');
  });

  test('operator token cannot acknowledge an xo mailbox row', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-operator-cannot-ack',
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
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_at).toBeNull();
    expect(stored.acknowledged_by).toBeNull();
  });

  test('test119 reads an own message behind an acknowledged 500-row backlog', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `old-${index}`,
        recipient: 'grokbot',
        correlationId: `old-corr-${index}`,
        seq: index + 1,
        body: `OLD-BODY-${index}`,
        acknowledged: true,
      });
    }
    await insertSyntheticDispatch({
      id: 'newer-own',
      recipient: 'grokbot',
      correlationId: 'newer-corr',
      seq: 600,
      body: 'NEWER-OWN-BODY',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'foreign-own-id',
      recipient: 'xo',
      correlationId: 'foreign-corr',
      seq: 601,
      body: 'FOREIGN-SECRET-BODY',
      acknowledged: false,
    });

    const app = makeApp();
    const legacy = await app.request('/api/dispatch/messages?recipient=grokbot&limit=500');
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{ id: string }>;
    expect(Array.isArray(legacyRows)).toBe(true);
    expect(legacyRows).toHaveLength(500);
    expect(legacyRows.map(row => row.id)).not.toContain('newer-own');

    const own = await app.request(
      '/api/dispatch/messages?recipient=%20GrokBot%20&message_id=newer-own'
    );
    expect(own.status).toBe(200);
    const ownRows = (await own.json()) as Array<{ id: string; body: string; recipient: string }>;
    expect(ownRows.map(row => row.id)).toEqual(['newer-own']);
    expect(ownRows[0]?.recipient).toBe('grokbot');
    expect(ownRows[0]?.body).toBe('NEWER-OWN-BODY');
    expect(ownRows[0]).not.toHaveProperty('cursor_seq');

    const foreign = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=foreign-own-id'
    );
    const unknown = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=missing-message'
    );
    expect(foreign.status).toBe(200);
    expect(unknown.status).toBe(200);
    const foreignBody = await foreign.json();
    const unknownBody = await unknown.json();
    expect(foreignBody).toEqual([]);
    expect(unknownBody).toEqual(foreignBody);
    expect(JSON.stringify(foreignBody)).not.toContain('FOREIGN-SECRET-BODY');

    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret-must-not-gate-reads';
    const blocked = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=newer-own'
    );
    expect(blocked.status).toBe(401);
    expect(JSON.stringify(await blocked.json())).not.toContain('NEWER-OWN-BODY');
    const gated = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=newer-own',
      { headers: { 'x-archon-operator-token': 'operator-secret-must-not-gate-reads' } }
    );
    expect(gated.status).toBe(200);
    expect((await gated.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: 'newer-own' }),
    ]);
    const stillHidden = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=foreign-own-id',
      { headers: { 'x-archon-operator-token': 'operator-secret-must-not-gate-reads' } }
    );
    expect(await stillHidden.json()).toEqual([]);
  });

  test('test120 pages an own inbox past interleaved foreign rows', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `own-${index}`,
        recipient: 'grokbot',
        correlationId: `own-corr-${index}`,
        seq: index * 2 + 1,
        body: `OWN-BODY-${index}`,
        acknowledged: false,
      });
      await insertSyntheticDispatch({
        id: `other-${index}`,
        recipient: 'xo',
        correlationId: `other-corr-${index}`,
        seq: index * 2 + 2,
        body: `OTHER-SECRET-${index}`,
        acknowledged: false,
      });
    }
    const app = makeApp();
    const firstResponse = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=500'
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      messages: Array<{ id: string; recipient: string; cursor_seq?: number }>;
      next_after_seq: number;
      page_full: boolean;
    };
    expect(Array.isArray(first)).toBe(false);
    expect(first.page_full).toBe(true);
    expect(first.messages).toHaveLength(500);
    expect(first.messages.every(message => message.recipient === 'grokbot')).toBe(true);
    expect(first.messages.some(message => message.cursor_seq !== undefined)).toBe(false);
    expect(first.messages.map(message => message.id)).toEqual(
      Array.from({ length: 500 }, (_unused, index) => `own-${index}`)
    );
    const seen = new Set(first.messages.map(message => message.id));

    const secondResponse = await app.request(
      `/api/dispatch/messages?recipient=grokbot&after_seq=${first.next_after_seq}&limit=500`
    );
    const second = (await secondResponse.json()) as {
      messages: Array<{ id: string; recipient: string }>;
      next_after_seq: number;
      page_full: boolean;
    };
    expect(second.messages.map(message => message.id)).toEqual(['own-500']);
    expect(second.page_full).toBe(false);
    expect(seen.has('own-500')).toBe(false);
    expect(second.next_after_seq).toBeGreaterThan(first.next_after_seq);

    const emptyResponse = await app.request(
      `/api/dispatch/messages?recipient=grokbot&after_seq=${second.next_after_seq}&limit=500`
    );
    expect(await emptyResponse.json()).toEqual({
      messages: [],
      next_after_seq: second.next_after_seq,
      page_full: false,
    });
    const text = JSON.stringify({ first, second });
    expect(text).not.toContain('OTHER-SECRET');
  });

  test('test121 returns own correlation replies behind unrelated history', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `unrelated-${index}`,
        recipient: 'grokbot',
        correlationId: `unrelated-${index}`,
        seq: index + 1,
        body: `UNRELATED-${index}`,
        acknowledged: true,
      });
    }
    await insertSyntheticDispatch({
      id: 'own-reply-1',
      recipient: 'grokbot',
      correlationId: 'board-brief-target',
      seq: 700,
      body: 'OWN-REPLY-1',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'own-reply-2',
      recipient: 'grokbot',
      correlationId: 'board-brief-target',
      seq: 701,
      body: 'OWN-REPLY-2',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'foreign-reply',
      recipient: 'xo',
      correlationId: 'board-brief-target',
      seq: 702,
      body: 'FOREIGN-REPLY-SECRET',
      acknowledged: false,
    });
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `capped-${index}`,
        recipient: 'grokbot',
        correlationId: 'capped-correlation',
        seq: 1000 + index,
        body: `CAPPED-${index}`,
        acknowledged: false,
      });
    }

    const app = makeApp();
    const own = await app.request(
      '/api/dispatch/messages?recipient=grokbot&correlation_id=board-brief-target&limit=500'
    );
    expect(own.status).toBe(200);
    const ownRows = (await own.json()) as Array<{ id: string; body: string }>;
    expect(ownRows.map(row => row.id).sort()).toEqual(['own-reply-1', 'own-reply-2']);
    expect(JSON.stringify(ownRows)).not.toContain('FOREIGN-REPLY-SECRET');
    expect(JSON.stringify(ownRows)).not.toContain('UNRELATED-0');

    const foreign = await app.request(
      '/api/dispatch/messages?recipient=xo&correlation_id=board-brief-target&limit=500'
    );
    const foreignRows = (await foreign.json()) as Array<{ id: string }>;
    expect(foreignRows.map(row => row.id)).toEqual(['foreign-reply']);

    const capped = await app.request(
      '/api/dispatch/messages?recipient=grokbot&correlation_id=capped-correlation&limit=500'
    );
    expect(capped.status).toBe(200);
    const cappedRows = (await capped.json()) as Array<{ id: string }>;
    expect(Array.isArray(cappedRows)).toBe(true);
    expect(cappedRows).toHaveLength(500);
    expect(cappedRows.map(row => row.id)).not.toContain('capped-0');
  });

  test('test122 keeps legacy list arrays and rejects bad selectors', async () => {
    const visible = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-visible',
      recipient: 'codex',
      body: 'LEGACY-VISIBLE',
    });
    await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-other',
      correlation_id: 'other-corr',
      recipient: 'operator',
      body: 'LEGACY-OTHER',
    });
    const deferred = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-deferred',
      recipient: 'grokbot',
      body: 'DEFERRED-BODY',
      not_before: '2999-01-01T00:00:00.000Z',
    });
    const app = makeApp();

    const legacy = await app.request(
      '/api/dispatch/messages?recipient=codex&status=queued&limit=10'
    );
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{ id: string }>;
    expect(legacyRows.map(row => row.id)).toEqual([visible.id]);

    const unknownKey = await app.request('/api/dispatch/messages?recipient=codex&not_a_selector=1');
    expect(unknownKey.status).toBe(200);
    expect(Array.isArray(await unknownKey.json())).toBe(true);

    const clamped = await app.request('/api/dispatch/messages?recipient=codex&limit=9999');
    expect(clamped.status).toBe(200);
    expect(Array.isArray(await clamped.json())).toBe(true);

    const queued = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&status=queued&limit=50'
    );
    expect(await queued.json()).toEqual({ messages: [], next_after_seq: 0, page_full: false });
    const anyStatus = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=50'
    );
    const anyPage = (await anyStatus.json()) as { messages: Array<{ id: string }> };
    expect(anyPage.messages.map(message => message.id)).toContain(deferred.id);

    const invalidUrls = [
      '/api/dispatch/messages?recipient=grokbot&message_id=&after_seq=0',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&correlation_id=def',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&after_seq=0',
      '/api/dispatch/messages?message_id=abc',
      '/api/dispatch/messages?recipient=%20%20&message_id=abc',
      '/api/dispatch/messages?recipient=grokbot&recipient=xo&message_id=abc',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&message_id=def',
      '/api/dispatch/messages?recipient=grokbot&message_id=',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=',
      '/api/dispatch/messages?recipient=grokbot&after_seq=',
      '/api/dispatch/messages?recipient=grokbot&after_seq=-1',
      '/api/dispatch/messages?recipient=grokbot&after_seq=1.5',
      '/api/dispatch/messages?recipient=grokbot&after_seq=00',
      '/api/dispatch/messages?recipient=grokbot&after_seq=1e2',
      '/api/dispatch/messages?recipient=grokbot&after_seq=%2B1',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&limit=1',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&status=queued',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&route_disposition=auto_surfaced',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&status=queued',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&route_disposition=auto_surfaced',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&extra=1',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&limit=0',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&limit=501',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=1.2',
    ];
    for (const url of invalidUrls) {
      const response = await app.request(url);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        'dispatch_list_selector_invalid'
      );
    }

    const badStatus = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&status=not-a-status'
    );
    expect(badStatus.status).toBe(400);
    const badStatusBody = (await badStatus.json()) as { error?: string; body?: string };
    expect(badStatusBody.body).toBeUndefined();
    expect(JSON.stringify(badStatusBody)).not.toContain('DEFERRED-BODY');

    const specResponse = await app.request('/api/openapi.json');
    const spec = (await specResponse.json()) as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(spec.paths['/api/dispatch/messages']?.get?.responses?.['400']).toBeDefined();
    expect(spec.components.schemas.DispatchMessage?.properties?.cursor_seq).toBeUndefined();
    expect(spec.components.schemas.DispatchMessageCursorPage?.properties).toMatchObject({
      messages: expect.anything(),
      next_after_seq: expect.anything(),
      page_full: expect.anything(),
    });
  });

  test('test129 rejects duplicated legacy list filters with the historical validation body', async () => {
    await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-dup-visible',
      recipient: 'codex',
      body: 'LEGACY-DUP-VISIBLE',
    });
    const app = makeApp('synthetic-operator-token');
    const headers = { 'x-archon-operator-token': 'synthetic-operator-token' };
    const duplicates = [
      {
        url: '/api/dispatch/messages?recipient=codex&recipient=xo',
        error: 'recipient: Expected string, received array',
      },
      {
        url: '/api/dispatch/messages?recipient=codex&status=queued&status=done',
        error:
          "status: Expected 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled', received array",
      },
      {
        url: '/api/dispatch/messages?recipient=codex&limit=10&limit=20',
        error: 'limit: Expected string, received array',
      },
      {
        url: '/api/dispatch/messages?recipient=codex&subject_key=wo:WO-MAILBOX&subject_key=other',
        error: 'subject_key: Expected string, received array',
      },
      {
        url: '/api/dispatch/messages?recipient=codex&route_disposition=auto_surfaced&route_disposition=expired',
        error:
          "route_disposition: Expected 'unroutable' | 'superseded' | 'expired' | 'auto_surfaced', received array",
      },
    ];
    for (const item of duplicates) {
      const response = await app.request(item.url, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: item.error });
    }

    const unknown = await app.request(
      '/api/dispatch/messages?recipient=codex&not_a_selector=1&not_a_selector=2',
      { headers }
    );
    expect(unknown.status).toBe(200);
    expect(Array.isArray(await unknown.json())).toBe(true);
  });

  test('test124 config does not activate inactive companion principals', async () => {
    const seeded = await db.query<{
      principal_id: string;
      active: number;
      delivery_mode: string;
    }>(
      `SELECT principal_id, active, delivery_mode
       FROM dispatch_principals
       WHERE principal_id IN ('dot', 'duet', 'grokbot', 'muse')
       ORDER BY principal_id`
    );
    expect(seeded.rows).toEqual([
      { principal_id: 'dot', active: 0, delivery_mode: 'drain_on_start' },
      { principal_id: 'duet', active: 0, delivery_mode: 'drain_on_start' },
      { principal_id: 'grokbot', active: 1, delivery_mode: 'drain_on_start' },
      { principal_id: 'muse', active: 0, delivery_mode: 'drain_on_start' },
    ]);

    const app = makeApp('secret-token');
    for (const recipient of ['dot', 'muse', 'duet']) {
      const rejected = await app.request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          idempotency_key: `inactive-${recipient}`,
          recipient,
          body: `delivery to inactive ${recipient}`,
        }),
      });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toBe(
        'dispatch_recipient_rejected:inactive_principal'
      );
    }

    const slotDir = await mkdtemp(join(tmpdir(), 'companion-configured-slot-'));
    try {
      const slotIds = ['dot', 'muse', 'duet', 'synth-active-slot'] as const;
      const slotTokens = Object.fromEntries(slotIds.map(id => [id, `token-for-${id}`])) as Record<
        (typeof slotIds)[number],
        string
      >;
      const slots = [];
      for (const id of slotIds) {
        const credentialFile = join(slotDir, `${id}.dispatch`);
        const digestFile = join(slotDir, `${id}.sha256`);
        await writeFile(credentialFile, `${slotTokens[id]}\n`);
        await writeFile(digestFile, `${sha(`bearer-for-${id}`)}\n`);
        slots.push({
          companion_id: id,
          enabled: true,
          dispatch_principal_id: id,
          token_sha256_file: digestFile,
          token_expires_at: '2099-01-01T00:00:00.000Z',
          dispatch_credential_file: credentialFile,
          tools: [...BASE_TOOL_NAMES],
          allowed_recipients: ['astra'],
          board_secretary: false,
          board_seat_recipients: ['astra'],
        });
      }
      const configPath = join(slotDir, 'companions.json');
      await writeFile(configPath, JSON.stringify({ slots }));
      const loaded = loadCompanionRegistry(configPath);
      expect(loaded.slots.map(slot => [slot.companion_id, slot.enabled])).toEqual(
        slotIds.map(id => [id, true])
      );
      for (const id of slotIds) {
        const slot = loaded.byPrincipal.get(id);
        expect(slot?.enabled).toBe(true);
        expect((await readFile(slot?.dispatch_credential_file ?? '', 'utf8')).trim()).toBe(
          slotTokens[id]
        );
      }

      const afterConfig = await db.query<{ principal_id: string; active: number }>(
        `SELECT principal_id, active FROM dispatch_principals
         WHERE principal_id IN ('dot', 'muse', 'duet')
         ORDER BY principal_id`
      );
      expect(afterConfig.rows).toEqual([
        { principal_id: 'dot', active: 0 },
        { principal_id: 'duet', active: 0 },
        { principal_id: 'muse', active: 0 },
      ]);

      const priorRegistry = JSON.parse(process.env.DISPATCH_PRINCIPALS_JSON ?? '[]') as unknown[];
      process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
      process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
        ...priorRegistry,
        ...slotIds.map(id => ({
          credential_id: `configured-${id}`,
          principal_id: id,
          token_sha256: sha(slotTokens[id]),
          status: 'active',
          send_as: [id],
          receive_as: [id],
          roles: ['send', 'receive'],
        })),
      ]);

      async function postSlot(
        principalId: string,
        token: string | undefined,
        idempotencyKey: string
      ): Promise<Response> {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        };
        if (token !== undefined) {
          headers['x-dispatch-principal-id'] = principalId;
          headers['x-dispatch-principal-token'] = token;
        }
        return app.request('/api/dispatch/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...VALID_BODY,
            sender: principalId,
            recipient: principalId,
            idempotency_key: idempotencyKey,
            body: `synthetic delivery for ${principalId}`,
          }),
        });
      }

      for (const recipient of ['dot', 'muse', 'duet'] as const) {
        const rejected = await postSlot(
          recipient,
          slotTokens[recipient],
          `configured-${recipient}`
        );
        expect(rejected.status).toBe(400);
        expect(((await rejected.json()) as { error: string }).error).toBe(
          'dispatch_recipient_rejected:inactive_principal'
        );
      }

      await db.query(
        `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
         VALUES ('synth-active-slot', 'Synthetic active slot', 'drain_on_start', 0)`
      );
      const inactiveSynth = await postSlot(
        'synth-active-slot',
        slotTokens['synth-active-slot'],
        'synth-inactive-configured'
      );
      expect(inactiveSynth.status).toBe(400);
      expect(((await inactiveSynth.json()) as { error: string }).error).toBe(
        'dispatch_recipient_rejected:inactive_principal'
      );

      await db.query(
        `UPDATE dispatch_principals SET active = 1 WHERE principal_id = 'synth-active-slot'`
      );
      const operatorOnly = await postSlot(
        'synth-active-slot',
        undefined,
        'synth-operator-token-only'
      );
      expect(operatorOnly.status).toBe(401);
      expect(((await operatorOnly.json()) as { error: string }).error).toBe(
        'dispatch_principal_missing'
      );
      const wrongCredential = await postSlot(
        'synth-active-slot',
        'not-the-slot-credential',
        'synth-wrong-credential'
      );
      expect(wrongCredential.status).toBe(401);
      expect(((await wrongCredential.json()) as { error: string }).error).toBe(
        'dispatch_principal_unauthorized'
      );

      const accepted = await postSlot(
        'synth-active-slot',
        (await readFile(join(slotDir, 'synth-active-slot.dispatch'), 'utf8')).trim(),
        'synth-active-create'
      );
      expect(accepted.status).toBe(200);
      expect((await accepted.json()) as { recipient: string; sender_principal_id: string }).toEqual(
        expect.objectContaining({
          recipient: 'synth-active-slot',
          sender: 'synth-active-slot',
          sender_principal_id: 'synth-active-slot',
        })
      );

      const stillInactive = await db.query<{ principal_id: string; active: number }>(
        `SELECT principal_id, active FROM dispatch_principals
         WHERE principal_id IN ('dot', 'muse', 'duet')
         ORDER BY principal_id`
      );
      expect(stillInactive.rows).toEqual([
        { principal_id: 'dot', active: 0 },
        { principal_id: 'duet', active: 0 },
        { principal_id: 'muse', active: 0 },
      ]);
      expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
    } finally {
      await rm(slotDir, { recursive: true, force: true });
    }
  });

  describe('principal-only ordinary mail transport', () => {
    const grokbotToken = 'grokbot-token';
    const sendOnlyToken = 'grokbot-send-only-token';
    const receiveOnlyToken = 'grokbot-receive-only-token';
    const foreignSendToken = 'foreign-send-token';
    const disabledToken = 'disabled-token';
    const aliasToken = 'alias-token';
    const accessHost = 'ops.example.test';
    const accessEmail = 'operator@example.test';
    const ownBody = 'OWN-ROUND-TRIP-BODY';
    const foreignBody = 'FOREIGN-MAILBOX-BODY';
    const aliasBody = 'ALIAS-MAILBOX-BODY';
    const boardAliasBody = 'BOARD-ALIAS-FOREIGN-BODY';

    function record(input: {
      credential_id: string;
      principal_id: string;
      token: string;
      status?: 'active' | 'retiring' | 'disabled';
      send_as: string[];
      receive_as: string[];
      roles: string[];
    }): {
      credential_id: string;
      principal_id: string;
      token_sha256: string;
      status: string;
      send_as: string[];
      receive_as: string[];
      roles: string[];
    } {
      return {
        credential_id: input.credential_id,
        principal_id: input.principal_id,
        token_sha256: sha(input.token),
        status: input.status ?? 'active',
        send_as: input.send_as,
        receive_as: input.receive_as,
        roles: input.roles,
      };
    }

    function useRegistry(
      records: Array<{
        credential_id: string;
        principal_id: string;
        token_sha256: string;
        status: string;
        send_as: string[];
        receive_as: string[];
        roles: string[];
      }>
    ): void {
      process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify(records);
    }

    function fullGrokbot() {
      return record({
        credential_id: 'grokbot-active',
        principal_id: 'grokbot',
        token: grokbotToken,
        send_as: ['grokbot'],
        receive_as: ['grokbot'],
        roles: ['send', 'receive'],
      });
    }

    function principalHeaders(
      principalId: string | undefined,
      token: string | undefined,
      extra: Record<string, string> = {}
    ): Record<string, string> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...extra,
      };
      if (principalId !== undefined) headers['x-dispatch-principal-id'] = principalId;
      if (token !== undefined) headers['x-dispatch-principal-token'] = token;
      return headers;
    }

    function enableMatchingAccess(): void {
      process.env.ARCHON_OPERATOR_ACCESS_HOSTS = accessHost;
      process.env.ARCHON_OPERATOR_EMAILS = accessEmail;
    }

    function clearMatchingAccess(): void {
      delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
      delete process.env.ARCHON_OPERATOR_EMAILS;
    }

    function matchingAccessHeaders(extra: Record<string, string> = {}): Record<string, string> {
      return {
        Host: accessHost,
        'Cf-Access-Authenticated-User-Email': accessEmail,
        ...extra,
      };
    }

    async function messageCount(): Promise<number> {
      return (await db.query('SELECT id FROM agent_dispatch_messages')).rowCount;
    }

    async function readError(response: Response): Promise<{ error: string; text: string }> {
      const text = await response.text();
      let error = '';
      try {
        const parsed = JSON.parse(text) as { error?: string };
        error = parsed.error ?? '';
      } catch {
        error = text;
      }
      return { error, text };
    }

    function expectNoSecret(text: string, token: string): void {
      expect(text.includes(token)).toBe(false);
      expect(text.includes(sha(token))).toBe(false);
    }

    function listUrl(query: Record<string, string | string[]>): string {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) params.append(key, item);
      }
      const encoded = params.toString();
      return encoded.length > 0 ? `/api/dispatch/messages?${encoded}` : '/api/dispatch/messages';
    }

    async function postMessage(
      app: OpenAPIHono,
      headers: Record<string, string>,
      overrides: Record<string, unknown>
    ): Promise<Response> {
      return app.request('/api/dispatch/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'grokbot',
          recipient: 'grokbot',
          body: ownBody,
          ...overrides,
        }),
      });
    }

    test('principal_only_round_trip', async () => {
      useRegistry([fullGrokbot()]);
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
      const app = makeApp('secret-token');
      const headers = principalHeaders('grokbot', grokbotToken);
      const created = await postMessage(app, headers, { idempotency_key: 'principal-round-trip' });
      expect(created.status).toBe(200);
      const message = (await created.json()) as {
        id: string;
        sender: string;
        sender_principal_id: string | null;
        recipient: string;
        body: string;
      };
      expect(message.sender).toBe('grokbot');
      expect(message.sender_principal_id).toBe('grokbot');
      expect(message.recipient).toBe('grokbot');
      expect(message.body).toBe(ownBody);

      const repeat = await postMessage(app, headers, {
        idempotency_key: 'principal-round-trip',
        body: 'DIFFERENT-BODY-SHOULD-NOT-PERSIST',
      });
      expect(repeat.status).toBe(200);
      const repeated = (await repeat.json()) as { id: string; body: string };
      expect(repeated.id).toBe(message.id);
      expect(repeated.body).toBe(ownBody);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'principal-round-trip',
          ])
        ).rowCount
      ).toBe(1);

      const listed = await app.request(listUrl({ recipient: 'grokbot' }), { headers });
      expect(listed.status).toBe(200);
      const inbox = (await listed.json()) as Array<{ id: string; body: string }>;
      expect(Array.isArray(inbox)).toBe(true);
      expect(inbox.map(row => row.id)).toEqual([message.id]);
      expect(inbox[0]?.body).toBe(ownBody);

      const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(ack.status).toBe(200);
      const receipt = (await ack.json()) as {
        acknowledged_by: string;
        acknowledged_at: string | null;
        status: string;
      };
      expect(receipt.acknowledged_by).toBe('grokbot');
      expect(receipt.acknowledged_at).not.toBeNull();
      expect(receipt.status).toBe('queued');

      const ackAgain = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(ackAgain.status).toBe(200);
      const secondReceipt = (await ackAgain.json()) as { acknowledged_at: string | null };
      expect(secondReceipt.acknowledged_at).toBe(receipt.acknowledged_at);
      const stored = await storedReceipt(message.id);
      expect(stored.acknowledged_by).toBe('grokbot');
      expect(stored.acknowledged_at).toBe(receipt.acknowledged_at);
      expect(stored.addressed_by).toBeNull();
      expect(stored.status).toBe('queued');
    });

    test('credentials_and_send_scope', async () => {
      const app = makeApp('secret-token');
      const privilegedTypes = ['run_review', 'draft_spec', 'run_report', 'board_motion'] as const;

      for (const mode of ['off', 'warn', 'enforce'] as const) {
        process.env.DISPATCH_SENDER_AUTH_MODE = mode;
        for (const withAccess of [false, true]) {
          if (withAccess) enableMatchingAccess();
          else clearMatchingAccess();
          const extra = withAccess ? matchingAccessHeaders() : {};
          useRegistry([fullGrokbot()]);
          const before = await messageCount();

          const missing = await postMessage(
            app,
            { 'Content-Type': 'application/json', ...extra },
            {
              idempotency_key: `missing-${mode}-${String(withAccess)}`,
            }
          );
          if (!withAccess) {
            const missingBody = await readError(missing);
            expect(missing.status).toBe(401);
            expect(missingBody.error).toBe('Missing or invalid operator token');
            expectNoSecret(missingBody.text, grokbotToken);
          } else if (mode === 'enforce') {
            const missingBody = await readError(missing);
            expect(missing.status).toBe(401);
            expect(missingBody.error).toBe('dispatch_principal_missing');
            expectNoSecret(missingBody.text, grokbotToken);
          } else {
            expect(missing.status).toBe(200);
            expect(
              ((await missing.json()) as { sender_principal_id: string | null }).sender_principal_id
            ).toBeNull();
          }

          const emptyHeaders = new Headers({
            'Content-Type': 'application/json',
            ...(withAccess ? matchingAccessHeaders() : {}),
          });
          emptyHeaders.set('x-dispatch-principal-id', '');
          emptyHeaders.set('x-dispatch-principal-token', '');
          const empty = await app.request('/api/dispatch/messages', {
            method: 'POST',
            headers: emptyHeaders,
            body: JSON.stringify({
              ...VALID_BODY,
              sender: 'grokbot',
              recipient: 'grokbot',
              body: ownBody,
              idempotency_key: `empty-${mode}-${String(withAccess)}`,
            }),
          });
          const emptyBody = await readError(empty);
          expect(empty.status).toBe(401);
          expect(emptyBody.error).toBe('dispatch_principal_missing');
          expectNoSecret(emptyBody.text, grokbotToken);

          const partial = await postMessage(app, principalHeaders('grokbot', undefined, extra), {
            idempotency_key: `partial-${mode}-${String(withAccess)}`,
          });
          const partialBody = await readError(partial);
          expect(partial.status).toBe(401);
          expect(partialBody.error).toBe('dispatch_principal_partial');
          expectNoSecret(partialBody.text, grokbotToken);

          const invalid = await postMessage(
            app,
            principalHeaders('grokbot', 'not-the-token', extra),
            { idempotency_key: `invalid-${mode}-${String(withAccess)}` }
          );
          const invalidBody = await readError(invalid);
          expect(invalid.status).toBe(401);
          expect(invalidBody.error).toBe('dispatch_principal_unauthorized');
          expectNoSecret(invalidBody.text, 'not-the-token');

          useRegistry([
            record({
              credential_id: 'grokbot-disabled',
              principal_id: 'grokbot',
              token: disabledToken,
              status: 'disabled',
              send_as: ['grokbot'],
              receive_as: ['grokbot'],
              roles: ['send', 'receive'],
            }),
          ]);
          const disabled = await postMessage(
            app,
            principalHeaders('grokbot', disabledToken, extra),
            { idempotency_key: `disabled-${mode}-${String(withAccess)}` }
          );
          const disabledBody = await readError(disabled);
          expect(disabled.status).toBe(401);
          expect(disabledBody.error).toBe('dispatch_principal_unauthorized');
          expectNoSecret(disabledBody.text, disabledToken);
          expect(disabledBody.text.includes('dispatch_principal_disabled')).toBe(false);

          useRegistry([
            record({
              credential_id: 'grokbot-receive-only',
              principal_id: 'grokbot',
              token: receiveOnlyToken,
              send_as: ['grokbot'],
              receive_as: ['grokbot'],
              roles: ['receive'],
            }),
          ]);
          const receiveOnly = await postMessage(
            app,
            principalHeaders('grokbot', receiveOnlyToken, extra),
            { idempotency_key: `receive-only-${mode}-${String(withAccess)}` }
          );
          const receiveOnlyBody = await readError(receiveOnly);
          expect(receiveOnly.status).toBe(403);
          expect(receiveOnlyBody.error).toBe('dispatch_principal_forbidden');
          expectNoSecret(receiveOnlyBody.text, receiveOnlyToken);

          useRegistry([
            record({
              credential_id: 'foreign-send',
              principal_id: 'grokbot',
              token: foreignSendToken,
              send_as: ['codex'],
              receive_as: ['grokbot'],
              roles: ['send', 'receive'],
            }),
          ]);
          const foreignSend = await postMessage(
            app,
            principalHeaders('grokbot', foreignSendToken, extra),
            { idempotency_key: `foreign-send-${mode}-${String(withAccess)}` }
          );
          const foreignSendBody = await readError(foreignSend);
          expect(foreignSend.status).toBe(403);
          expect(foreignSendBody.error).toBe('dispatch_sender_selector_forbidden');
          expectNoSecret(foreignSendBody.text, foreignSendToken);

          useRegistry([fullGrokbot()]);
          const headers = principalHeaders('grokbot', grokbotToken, extra);
          for (const taskType of privilegedTypes) {
            const denied = await postMessage(app, headers, {
              task_type: taskType,
              idempotency_key: `priv-${taskType}-${mode}-${String(withAccess)}`,
              recipient: 'grokbot',
            });
            const deniedBody = await readError(denied);
            expect(denied.status).toBe(403);
            expect(deniedBody.error).toBe('dispatch_principal_forbidden');
            expectNoSecret(deniedBody.text, grokbotToken);
          }
          const petition = await postMessage(app, headers, {
            task_type: 'agent_message',
            recipient: 'board',
            idempotency_key: `petition-${mode}-${String(withAccess)}`,
          });
          const petitionBody = await readError(petition);
          expect(petition.status).toBe(403);
          expect(petitionBody.error).toBe('dispatch_principal_forbidden');

          const statusRoute = await app.request('/api/dispatch/status', { headers });
          const statusBody = await readError(statusRoute);
          expect(statusRoute.status).toBe(403);
          expect(statusBody.error).toBe('dispatch_principal_forbidden');

          const nearMiss = await app.request('/api/dispatch/messages/not-ack', {
            method: 'POST',
            headers,
            body: '{}',
          });
          expect(nearMiss.status).toBe(403);
          expect((await readError(nearMiss)).error).toBe('dispatch_principal_forbidden');

          const allowed = await postMessage(app, headers, {
            idempotency_key: `allowed-${mode}-${String(withAccess)}`,
          });
          expect(allowed.status).toBe(200);
          expect(
            ((await allowed.json()) as { sender_principal_id: string | null }).sender_principal_id
          ).toBe('grokbot');

          const deniedKeys = [
            `empty-${mode}-${String(withAccess)}`,
            `partial-${mode}-${String(withAccess)}`,
            `invalid-${mode}-${String(withAccess)}`,
            `disabled-${mode}-${String(withAccess)}`,
            `receive-only-${mode}-${String(withAccess)}`,
            `foreign-send-${mode}-${String(withAccess)}`,
            ...privilegedTypes.map(taskType => `priv-${taskType}-${mode}-${String(withAccess)}`),
            `petition-${mode}-${String(withAccess)}`,
          ];
          for (const key of deniedKeys) {
            expect(
              (
                await db.query(
                  'SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1',
                  [key]
                )
              ).rowCount
            ).toBe(0);
          }
          if (!withAccess || mode === 'enforce') {
            expect(await messageCount()).toBe(before + 1);
          } else {
            expect(await messageCount()).toBe(before + 2);
          }
        }
      }

      clearMatchingAccess();
      useRegistry([fullGrokbot()]);
      process.env.DISPATCH_SENDER_AUTH_MODE = 'off';
      const wrongOperator = principalHeaders('grokbot', grokbotToken, {
        'x-archon-operator-token': 'wrong-token',
      });
      const stillPrincipal = await postMessage(app, wrongOperator, {
        task_type: 'run_report',
        idempotency_key: 'wrong-operator-run-report',
      });
      expect(stillPrincipal.status).toBe(403);
      expect((await readError(stillPrincipal)).error).toBe('dispatch_principal_forbidden');

      const options = await app.request('/api/dispatch/messages', {
        method: 'OPTIONS',
        headers: principalHeaders('grokbot', grokbotToken),
      });
      expect(options.status).not.toBe(401);
      expect(options.status).not.toBe(403);
    });

    test('receive_scope_and_selectors', async () => {
      useRegistry([fullGrokbot()]);
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
      const app = makeApp('secret-token');
      const headers = principalHeaders('grokbot', grokbotToken);
      const subjectKey = 'gh:thinmansoftware/bdc-harness#1377';
      const created = await postMessage(app, headers, {
        idempotency_key: 'selector-own',
        correlation_id: 'principal-corr',
        subject_key: subjectKey,
      });
      expect(created.status).toBe(200);
      const own = (await created.json()) as { id: string };
      const second = await postMessage(app, headers, {
        idempotency_key: 'selector-own-2',
        correlation_id: 'principal-corr',
        body: 'SECOND-OWN-BODY',
      });
      expect(second.status).toBe(200);
      const secondMessage = (await second.json()) as { id: string };
      await db.query('UPDATE agent_dispatch_messages SET status = $2 WHERE id = $1', [
        secondMessage.id,
        'done',
      ]);
      await createMessage({
        ...VALID_BODY,
        sender: 'xo',
        recipient: 'codex',
        body: foreignBody,
        idempotency_key: 'selector-foreign',
        correlation_id: 'foreign-corr',
      });
      const foreign = await db.query<{ id: string }>(
        'SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1',
        ['selector-foreign']
      );
      const foreignId = foreign.rows[0]?.id ?? '';
      expect(foreignId).not.toBe('');

      process.env.DISPATCH_WORKER_CREDENTIALS_JSON = JSON.stringify([
        {
          credential_id: 'board-worker-1',
          worker_id: 'worker-a',
          role: 'board_delivery_worker',
          allowed_principals: ['grokbot'],
          token_sha256: sha('worker-secret'),
          status: 'active',
        },
      ]);
      await seedXoHolderLease('grokbot');
      await insertSyntheticDispatch({
        id: 'board-alias-foreign',
        recipient: 'codex',
        correlationId: 'board-alias-corr',
        seq: 80,
        body: boardAliasBody,
        acknowledged: false,
      });
      await db.query(
        "UPDATE agent_dispatch_messages SET recipient_alias = 'board' WHERE id = 'board-alias-foreign'"
      );

      for (const withAccess of [false, true]) {
        if (withAccess) enableMatchingAccess();
        else clearMatchingAccess();
        const requestHeaders = principalHeaders(
          'grokbot',
          grokbotToken,
          withAccess ? matchingAccessHeaders() : {}
        );
        const workerHeaders = {
          ...requestHeaders,
          'x-dispatch-worker-credential-id': 'board-worker-1',
          'x-dispatch-worker-token': 'worker-secret',
          'x-dispatch-worker-id': 'worker-a',
        };

        const ownList = await app.request(listUrl({ recipient: 'grokbot' }), {
          headers: requestHeaders,
        });
        expect(ownList.status).toBe(200);
        const ownRows = (await ownList.json()) as Array<{ id: string; body: string }>;
        expect(Array.isArray(ownRows)).toBe(true);
        expect(ownRows.map(row => row.id)).toContain(own.id);
        expect(ownRows.map(row => row.id)).not.toContain(foreignId);
        expect(ownRows.map(row => row.id)).not.toContain('board-alias-foreign');
        expect(JSON.stringify(ownRows).includes(foreignBody)).toBe(false);
        expect(JSON.stringify(ownRows).includes(boardAliasBody)).toBe(false);

        const encoded = await app.request(listUrl({ recipient: 'GrokBot' }), {
          headers: requestHeaders,
        });
        expect(encoded.status).toBe(200);
        expect(((await encoded.json()) as Array<{ id: string }>).map(row => row.id)).toContain(
          own.id
        );

        const subjectList = await app.request(
          listUrl({ recipient: 'grokbot', subject_key: subjectKey }),
          { headers: requestHeaders }
        );
        expect(subjectList.status).toBe(200);
        expect(((await subjectList.json()) as Array<{ id: string }>).map(row => row.id)).toEqual([
          own.id,
        ]);

        const doneList = await app.request(listUrl({ recipient: 'grokbot', status: 'done' }), {
          headers: requestHeaders,
        });
        expect(doneList.status).toBe(200);
        expect(((await doneList.json()) as Array<{ id: string }>).map(row => row.id)).toEqual([
          secondMessage.id,
        ]);

        const limited = await app.request(listUrl({ recipient: 'grokbot', limit: '1' }), {
          headers: requestHeaders,
        });
        expect(limited.status).toBe(200);
        const limitedRows = (await limited.json()) as Array<{ id: string }>;
        expect(limitedRows).toHaveLength(1);
        expect(limitedRows[0]?.id).not.toBe(foreignId);

        const byId = await app.request(listUrl({ recipient: 'grokbot', message_id: own.id }), {
          headers: requestHeaders,
        });
        expect(byId.status).toBe(200);
        expect((await byId.json()) as Array<{ id: string }>).toEqual([
          expect.objectContaining({ id: own.id }),
        ]);

        const foreignById = await app.request(
          listUrl({ recipient: 'grokbot', message_id: foreignId }),
          { headers: requestHeaders }
        );
        expect(foreignById.status).toBe(200);
        const foreignByIdBody = await foreignById.text();
        expect(JSON.parse(foreignByIdBody)).toEqual([]);
        expect(foreignByIdBody.includes(foreignBody)).toBe(false);

        const unknownById = await app.request(
          listUrl({ recipient: 'grokbot', message_id: 'missing-message-id' }),
          { headers: requestHeaders }
        );
        expect(unknownById.status).toBe(200);
        expect(await unknownById.json()).toEqual([]);

        const byCorrelation = await app.request(
          listUrl({ recipient: 'grokbot', correlation_id: 'principal-corr' }),
          { headers: requestHeaders }
        );
        expect(byCorrelation.status).toBe(200);
        const correlationRows = (await byCorrelation.json()) as Array<{ id: string }>;
        expect(Array.isArray(correlationRows)).toBe(true);
        expect(correlationRows.map(row => row.id)).toEqual(
          expect.arrayContaining([own.id, secondMessage.id])
        );

        const correlationLimited = await app.request(
          listUrl({ recipient: 'grokbot', correlation_id: 'principal-corr', limit: '1' }),
          { headers: requestHeaders }
        );
        expect(correlationLimited.status).toBe(200);
        expect((await correlationLimited.json()) as unknown[]).toHaveLength(1);

        const foreignCorrelation = await app.request(
          listUrl({ recipient: 'grokbot', correlation_id: 'foreign-corr' }),
          { headers: requestHeaders }
        );
        expect(foreignCorrelation.status).toBe(200);
        const foreignCorrelationText = await foreignCorrelation.text();
        expect(JSON.parse(foreignCorrelationText)).toEqual([]);
        expect(foreignCorrelationText.includes(foreignBody)).toBe(false);

        const cursor = await app.request(
          listUrl({ recipient: 'grokbot', after_seq: '0', limit: '1' }),
          { headers: requestHeaders }
        );
        expect(cursor.status).toBe(200);
        const cursorBody = (await cursor.json()) as {
          messages: Array<{ id: string }>;
          next_after_seq: number;
          page_full: boolean;
        };
        expect(Array.isArray(cursorBody.messages)).toBe(true);
        expect(cursorBody.messages).toHaveLength(1);
        expect(typeof cursorBody.next_after_seq).toBe('number');
        expect(cursorBody.page_full).toBe(true);
        expect(cursorBody.messages[0]?.id).not.toBe(foreignId);

        const aliasList = await app.request(listUrl({ recipient: 'grokbot', status: 'queued' }), {
          headers: workerHeaders,
        });
        expect(aliasList.status).toBe(200);
        const aliasText = await aliasList.text();
        expect(aliasText.includes('board-alias-foreign')).toBe(false);
        expect(aliasText.includes(boardAliasBody)).toBe(false);

        const refusals: Array<{ url: string; token?: string }> = [
          { url: '/api/dispatch/messages' },
          { url: listUrl({ recipient: '' }) },
          { url: listUrl({ recipient: '   ' }) },
          { url: listUrl({ recipient: ['grokbot', 'codex'] }) },
          { url: listUrl({ recipient: ['grokbot', 'grokbot'], message_id: own.id }) },
          { url: listUrl({ recipient: 'codex', message_id: own.id }) },
          { url: listUrl({ recipient: 'board', status: 'queued' }) },
          { url: listUrl({ recipient: 'grokbot2' }) },
          { url: listUrl({ recipient: 'grokbot', message_id: own.id }), token: sendOnlyToken },
        ];
        for (const refusal of refusals) {
          const refusalHeaders =
            refusal.token === undefined
              ? requestHeaders
              : principalHeaders(
                  'grokbot',
                  refusal.token,
                  withAccess ? matchingAccessHeaders() : {}
                );
          if (refusal.token === sendOnlyToken) {
            useRegistry([
              record({
                credential_id: 'grokbot-send-only',
                principal_id: 'grokbot',
                token: sendOnlyToken,
                send_as: ['grokbot'],
                receive_as: ['grokbot'],
                roles: ['send'],
              }),
            ]);
          }
          const response = await app.request(refusal.url, { headers: refusalHeaders });
          const body = await readError(response);
          expect(response.status).toBe(403);
          expect(body.error).toBe('dispatch_principal_forbidden');
          expect(body.text.includes(foreignBody)).toBe(false);
          expect(body.text.includes(ownBody)).toBe(false);
          expectNoSecret(body.text, grokbotToken);
          if (refusal.token === sendOnlyToken) useRegistry([fullGrokbot()]);
        }

        const conflict = await app.request(
          listUrl({
            recipient: 'grokbot',
            message_id: own.id,
            correlation_id: 'principal-corr',
          }),
          { headers: requestHeaders }
        );
        const conflictBody = await readError(conflict);
        expect(conflict.status).toBe(400);
        expect(conflictBody.error).toBe('dispatch_list_selector_invalid');
        expect(conflictBody.text.includes(foreignBody)).toBe(false);

        const badCursor = await app.request(
          listUrl({ recipient: 'grokbot', after_seq: '0', limit: '501' }),
          { headers: requestHeaders }
        );
        expect(badCursor.status).toBe(400);
        expect((await readError(badCursor)).error).toBe('dispatch_list_selector_invalid');

        const shapes: Array<{
          name: 'legacy' | 'message_id' | 'correlation_id' | 'after_seq';
          selector: Record<string, string>;
        }> = [
          { name: 'legacy', selector: {} },
          { name: 'message_id', selector: { message_id: own.id } },
          { name: 'correlation_id', selector: { correlation_id: 'principal-corr' } },
          { name: 'after_seq', selector: { after_seq: '0' } },
        ];
        const workerHeaderFields = {
          'x-dispatch-worker-credential-id': 'board-worker-1',
          'x-dispatch-worker-token': 'worker-secret',
          'x-dispatch-worker-id': 'worker-a',
        };
        for (const withWorker of [false, true]) {
          const matrixHeaders = withWorker
            ? { ...requestHeaders, ...workerHeaderFields }
            : requestHeaders;
          for (const shape of shapes) {
            useRegistry([fullGrokbot()]);
            const shapeList = await app.request(
              listUrl({ recipient: 'grokbot', ...shape.selector }),
              {
                headers: matrixHeaders,
              }
            );
            expect(shapeList.status).toBe(200);
            const shapeText = await shapeList.text();
            expect(shapeText.includes(foreignBody)).toBe(false);
            expect(shapeText.includes(boardAliasBody)).toBe(false);
            if (shape.name === 'after_seq') {
              const cursor = JSON.parse(shapeText) as {
                messages: Array<{ id: string }>;
                next_after_seq: number;
                page_full: boolean;
              };
              expect(Array.isArray(cursor.messages)).toBe(true);
              expect(typeof cursor.next_after_seq).toBe('number');
              expect(typeof cursor.page_full).toBe('boolean');
              expect(cursor.messages.map(row => row.id)).toContain(own.id);
              expect(cursor.messages.map(row => row.id)).not.toContain(foreignId);
              expect(cursor.messages.map(row => row.id)).not.toContain('board-alias-foreign');
            } else {
              const rows = JSON.parse(shapeText) as Array<{ id: string }>;
              expect(Array.isArray(rows)).toBe(true);
              expect(rows.map(row => row.id)).toContain(own.id);
              expect(rows.map(row => row.id)).not.toContain(foreignId);
              expect(rows.map(row => row.id)).not.toContain('board-alias-foreign');
            }

            const denials: Array<Record<string, string | string[]>> = [
              { ...shape.selector },
              { recipient: '', ...shape.selector },
              { recipient: '   ', ...shape.selector },
              { recipient: 'codex', ...shape.selector },
              { recipient: ['grokbot', 'codex'], ...shape.selector },
              { recipient: 'board', ...shape.selector },
            ];
            for (const query of denials) {
              const denied = await app.request(listUrl(query), { headers: matrixHeaders });
              const deniedBody = await readError(denied);
              expect(denied.status).toBe(403);
              expect(deniedBody.error).toBe('dispatch_principal_forbidden');
              expect(deniedBody.text.includes(foreignBody)).toBe(false);
              expect(deniedBody.text.includes(boardAliasBody)).toBe(false);
              expect(deniedBody.text.includes(ownBody)).toBe(false);
              expectNoSecret(deniedBody.text, grokbotToken);
            }

            useRegistry([
              record({
                credential_id: 'grokbot-send-only',
                principal_id: 'grokbot',
                token: sendOnlyToken,
                send_as: ['grokbot'],
                receive_as: ['grokbot'],
                roles: ['send'],
              }),
            ]);
            const sendOnlyHeaders = principalHeaders('grokbot', sendOnlyToken, {
              ...(withAccess ? matchingAccessHeaders() : {}),
              ...(withWorker ? workerHeaderFields : {}),
            });
            const sendOnlyDenied = await app.request(
              listUrl({ recipient: 'grokbot', ...shape.selector }),
              { headers: sendOnlyHeaders }
            );
            const sendOnlyBody = await readError(sendOnlyDenied);
            expect(sendOnlyDenied.status).toBe(403);
            expect(sendOnlyBody.error).toBe('dispatch_principal_forbidden');
            expect(sendOnlyBody.text.includes(foreignBody)).toBe(false);
            expect(sendOnlyBody.text.includes(boardAliasBody)).toBe(false);
            expect(sendOnlyBody.text.includes(ownBody)).toBe(false);
            expectNoSecret(sendOnlyBody.text, grokbotToken);
            expectNoSecret(sendOnlyBody.text, sendOnlyToken);
            useRegistry([fullGrokbot()]);

            if (shape.name === 'message_id' && withWorker) {
              for (const hiddenId of [foreignId, 'board-alias-foreign']) {
                const hidden = await app.request(
                  listUrl({ recipient: 'grokbot', message_id: hiddenId }),
                  { headers: matrixHeaders }
                );
                expect(hidden.status).toBe(200);
                const hiddenText = await hidden.text();
                expect(JSON.parse(hiddenText)).toEqual([]);
                expect(hiddenText.includes(foreignBody)).toBe(false);
                expect(hiddenText.includes(boardAliasBody)).toBe(false);
                expect(hiddenText.includes(ownBody)).toBe(false);
              }
            }
          }
        }
      }
    });

    test('mailbox_actor_ownership', async () => {
      useRegistry([
        record({
          credential_id: 'grokbot-alias',
          principal_id: 'grokbot',
          token: aliasToken,
          send_as: ['grokbot'],
          receive_as: ['grokbot', 'aliasbox'],
          roles: ['send', 'receive'],
        }),
      ]);
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
      const app = makeApp('secret-token');

      for (const withAccess of [false, true]) {
        if (withAccess) enableMatchingAccess();
        else clearMatchingAccess();
        const headers = principalHeaders(
          'grokbot',
          aliasToken,
          withAccess ? matchingAccessHeaders() : {}
        );
        const suffix = withAccess ? 'access' : 'plain';
        const created = await postMessage(app, headers, {
          idempotency_key: `ack-own-${suffix}`,
        });
        expect(created.status).toBe(200);
        const own = (await created.json()) as { id: string };
        const ack = await app.request(`/api/dispatch/messages/${own.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(ack.status).toBe(200);
        const receipt = (await ack.json()) as { acknowledged_by: string; acknowledged_at: string };
        expect(receipt.acknowledged_by).toBe('grokbot');
        const repeat = await app.request(`/api/dispatch/messages/${own.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(repeat.status).toBe(200);
        expect(((await repeat.json()) as { acknowledged_at: string }).acknowledged_at).toBe(
          receipt.acknowledged_at
        );
        expect((await storedReceipt(own.id)).acknowledged_at).toBe(receipt.acknowledged_at);

        const foreign = await createMessage({
          ...VALID_BODY,
          sender: 'xo',
          recipient: 'codex',
          body: foreignBody,
          idempotency_key: `ack-foreign-${suffix}`,
        });
        const foreignAck = await app.request(`/api/dispatch/messages/${foreign.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        const foreignAckBody = await readError(foreignAck);
        expect(foreignAck.status).toBe(403);
        expect(foreignAckBody.error).toBe('dispatch_principal_forbidden');
        expect(foreignAckBody.text.includes(foreignBody)).toBe(false);
        expect((await storedReceipt(foreign.id)).acknowledged_at).toBeNull();

        const mismatchTarget = await postMessage(app, headers, {
          idempotency_key: `ack-mismatch-${suffix}`,
        });
        expect(mismatchTarget.status).toBe(200);
        const mismatchMessage = (await mismatchTarget.json()) as { id: string };
        const mismatch = await app.request(`/api/dispatch/messages/${mismatchMessage.id}/ack`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ principal_id: 'codex' }),
        });
        expect(mismatch.status).toBe(409);
        expect((await readError(mismatch)).error).toBe('actor_mismatch');
        expect((await storedReceipt(mismatchMessage.id)).acknowledged_at).toBeNull();

        const aliasId = `alias-row-${suffix}`;
        await insertSyntheticDispatch({
          id: aliasId,
          recipient: 'aliasbox',
          correlationId: `alias-corr-${suffix}`,
          seq: withAccess ? 91 : 90,
          body: aliasBody,
          acknowledged: false,
        });
        const aliasAck = await app.request(`/api/dispatch/messages/${aliasId}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(aliasAck.status).toBe(409);
        expect((await readError(aliasAck)).error).toBe('wrong_recipient');
        expect((await storedReceipt(aliasId)).acknowledged_at).toBeNull();
        expect((await storedReceipt(aliasId)).addressed_at).toBeNull();

        const missing = await app.request('/api/dispatch/messages/missing-message-id/ack', {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(missing.status).toBe(404);
        expect((await readError(missing)).error).toBe('not_found');

        useRegistry([
          record({
            credential_id: 'grokbot-send-only-ack',
            principal_id: 'grokbot',
            token: sendOnlyToken,
            send_as: ['grokbot'],
            receive_as: ['grokbot'],
            roles: ['send'],
          }),
        ]);
        const sendOnlyAck = await app.request(`/api/dispatch/messages/${mismatchMessage.id}/ack`, {
          method: 'POST',
          headers: principalHeaders(
            'grokbot',
            sendOnlyToken,
            withAccess ? matchingAccessHeaders() : {}
          ),
          body: '{}',
        });
        expect(sendOnlyAck.status).toBe(403);
        expect((await readError(sendOnlyAck)).error).toBe('dispatch_principal_forbidden');
        expect((await storedReceipt(mismatchMessage.id)).acknowledged_at).toBeNull();
        useRegistry([
          record({
            credential_id: 'grokbot-alias',
            principal_id: 'grokbot',
            token: aliasToken,
            send_as: ['grokbot'],
            receive_as: ['grokbot', 'aliasbox'],
            roles: ['send', 'receive'],
          }),
        ]);
      }
    });

    test('privileged_task_denial', async () => {
      useRegistry([fullGrokbot()]);
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
      const app = makeApp('secret-token');
      const beforeMessages = await messageCount();
      const beforeLeases = (await db.query('SELECT lease_id FROM board_xo_leases')).rowCount;
      const beforeWorkers = (await db.query('SELECT worker_id FROM agent_dispatch_workers'))
        .rowCount;

      for (const withAccess of [false, true]) {
        if (withAccess) enableMatchingAccess();
        else clearMatchingAccess();
        const headers = principalHeaders(
          'grokbot',
          grokbotToken,
          withAccess ? matchingAccessHeaders() : {}
        );
        for (const taskType of [
          'run_review',
          'draft_spec',
          'run_report',
          'board_motion',
        ] as const) {
          const denied = await postMessage(app, headers, {
            task_type: taskType,
            idempotency_key: `deny-${taskType}-${String(withAccess)}`,
          });
          expect(denied.status).toBe(403);
          expect((await readError(denied)).error).toBe('dispatch_principal_forbidden');
        }
        const petition = await postMessage(app, headers, {
          recipient: 'board',
          idempotency_key: `deny-petition-${String(withAccess)}`,
        });
        expect(petition.status).toBe(403);

        const blocked: Array<{ method: string; path: string; body?: string }> = [
          { method: 'POST', path: '/api/dispatch/messages/priv-1/claim', body: '{}' },
          { method: 'POST', path: '/api/dispatch/messages/priv-1/result', body: '{}' },
          { method: 'POST', path: '/api/dispatch/messages/priv-1/address', body: '{}' },
          { method: 'POST', path: '/api/dispatch/messages/priv-1/cancel', body: '{}' },
          { method: 'POST', path: '/api/dispatch/messages/priv-1/renew-lease', body: '{}' },
          { method: 'POST', path: '/api/dispatch/workers/register', body: '{}' },
          { method: 'POST', path: '/api/board/xo-lease/acquire', body: '{}' },
          { method: 'POST', path: '/api/dispatch/execution-handoffs', body: '{}' },
          { method: 'GET', path: '/api/dispatch/status' },
          { method: 'GET', path: '/api/dispatch/principals' },
          { method: 'GET', path: '/api/codebases' },
        ];
        for (const call of blocked) {
          const response = await app.request(call.path, {
            method: call.method,
            headers,
            body: call.body,
          });
          const body = await readError(response);
          expect(response.status).toBe(403);
          expect(body.error).toBe('dispatch_principal_forbidden');
          expectNoSecret(body.text, grokbotToken);
        }
      }

      expect(await messageCount()).toBe(beforeMessages);
      expect((await db.query('SELECT lease_id FROM board_xo_leases')).rowCount).toBe(beforeLeases);
      expect((await db.query('SELECT worker_id FROM agent_dispatch_workers')).rowCount).toBe(
        beforeWorkers
      );

      const headers = principalHeaders('grokbot', grokbotToken);
      const allowed = await postMessage(app, headers, { idempotency_key: 'deny-then-allow' });
      expect(allowed.status).toBe(200);
      const allowedMessage = (await allowed.json()) as { id: string; task_type: string };
      expect(allowedMessage.task_type).toBe('agent_message');
      const address = await app.request(`/api/dispatch/messages/${allowedMessage.id}/address`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(address.status).toBe(403);
      const cancel = await app.request(`/api/dispatch/messages/${allowedMessage.id}/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sender: 'grokbot' }),
      });
      expect(cancel.status).toBe(403);
      const stored = await db.query<{
        status: string;
        claimed_at: string | null;
        acknowledged_at: string | null;
        addressed_at: string | null;
        result_body: string | null;
      }>(
        `SELECT status, claimed_at, acknowledged_at, addressed_at, result_body
         FROM agent_dispatch_messages WHERE id = $1`,
        [allowedMessage.id]
      );
      expect(stored.rows[0]).toEqual({
        status: 'queued',
        claimed_at: null,
        acknowledged_at: null,
        addressed_at: null,
        result_body: null,
      });
    });

    test('retained_operator_worker_and_xo_contracts', async () => {
      useRegistry([fullGrokbot()]);
      process.env.DISPATCH_SENDER_AUTH_MODE = 'off';
      enableMatchingAccess();
      const app = makeApp('secret-token');

      const mixedOrdinary = await postMessage(
        app,
        principalHeaders('grokbot', grokbotToken, {
          'x-archon-operator-token': 'secret-token',
          ...matchingAccessHeaders(),
        }),
        { idempotency_key: 'mixed-ordinary' }
      );
      expect(mixedOrdinary.status).toBe(200);
      expect(
        (await mixedOrdinary.json()) as { sender: string; sender_principal_id: string }
      ).toEqual(expect.objectContaining({ sender: 'grokbot', sender_principal_id: 'grokbot' }));

      const mixedPrivileged = await postMessage(
        app,
        principalHeaders('grokbot', grokbotToken, {
          'x-archon-operator-token': 'secret-token',
        }),
        { task_type: 'run_report', idempotency_key: 'mixed-privileged', body: 'Operator report.' }
      );
      expect(mixedPrivileged.status).toBe(200);
      expect(
        ((await mixedPrivileged.json()) as { task_type: string; sender_principal_id: string })
          .task_type
      ).toBe('run_report');

      const principalPrivileged = await postMessage(
        app,
        principalHeaders('grokbot', grokbotToken, matchingAccessHeaders()),
        {
          task_type: 'run_report',
          idempotency_key: 'access-plus-principal-report',
          body: 'Should stay denied.',
        }
      );
      expect(principalPrivileged.status).toBe(403);
      expect((await readError(principalPrivileged)).error).toBe('dispatch_principal_forbidden');
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'access-plus-principal-report',
          ])
        ).rowCount
      ).toBe(0);

      const headerless = await app.request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...matchingAccessHeaders(),
        },
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'claude',
          recipient: 'codex',
          idempotency_key: 'headerless-access',
        }),
      });
      expect(headerless.status).toBe(200);
      expect(
        ((await headerless.json()) as { sender_principal_id: string | null }).sender_principal_id
      ).toBeNull();

      const headerlessList = await app.request(listUrl({ recipient: 'codex' }), {
        headers: matchingAccessHeaders(),
      });
      expect(headerlessList.status).toBe(200);
      expect(Array.isArray(await headerlessList.json())).toBe(true);
    });

    test('principal headers are classified before operator-auth bypasses', async () => {
      const priorAuthDisabled = process.env.ARCHON_OPERATOR_AUTH_DISABLED;
      const priorNodeEnv = process.env.NODE_ENV;
      const restoreEnv = (name: string, prior: string | undefined): void => {
        if (prior === undefined) delete process.env[name];
        else process.env[name] = prior;
      };
      try {
        process.env.NODE_ENV = 'test';
        delete process.env.DISPATCH_SENDER_AUTH_MODE;
        clearMatchingAccess();
        useRegistry([fullGrokbot()]);
        await createMessage({
          ...VALID_BODY,
          sender: 'xo',
          recipient: 'codex',
          body: foreignBody,
          idempotency_key: 'bypass-foreign-seed',
        });

        const bypasses: Array<{ name: string; app: OpenAPIHono }> = [
          {
            name: 'auth-disabled',
            app: (() => {
              process.env.ARCHON_OPERATOR_AUTH_DISABLED = 'true';
              return makeApp('secret-token');
            })(),
          },
          {
            name: 'no-operator-token',
            app: (() => {
              delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
              return makeApp();
            })(),
          },
        ];

        for (const bypass of bypasses) {
          const { app, name } = bypass;
          // makeApp() mutates process.env while the apps are constructed, and
          // the middleware reads that env per request. Re-apply the bypass
          // under test immediately before its requests.
          if (name === 'auth-disabled') {
            process.env.ARCHON_OPERATOR_AUTH_DISABLED = 'true';
            process.env.ARCHON_OPERATOR_TOKEN = 'secret-token';
          } else {
            delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
            delete process.env.ARCHON_OPERATOR_TOKEN;
          }
          const emptyHeaders = new Headers({ 'Content-Type': 'application/json' });
          emptyHeaders.set('x-dispatch-principal-id', '');
          emptyHeaders.set('x-dispatch-principal-token', '');
          const empty = await app.request('/api/dispatch/messages', {
            method: 'POST',
            headers: emptyHeaders,
            body: JSON.stringify({
              ...VALID_BODY,
              sender: 'grokbot',
              recipient: 'grokbot',
              body: ownBody,
              idempotency_key: `bypass-empty-${name}`,
            }),
          });
          const emptyBody = await readError(empty);
          expect(empty.status).toBe(401);
          expect(emptyBody.error).toBe('dispatch_principal_missing');
          expectNoSecret(emptyBody.text, grokbotToken);
          expect(
            (
              await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
                `bypass-empty-${name}`,
              ])
            ).rowCount
          ).toBe(0);

          const partial = await postMessage(app, principalHeaders('grokbot', undefined), {
            idempotency_key: `bypass-partial-${name}`,
          });
          const partialBody = await readError(partial);
          expect(partial.status).toBe(401);
          expect(partialBody.error).toBe('dispatch_principal_partial');
          expectNoSecret(partialBody.text, grokbotToken);

          const partialList = await app.request(listUrl({ recipient: 'codex' }), {
            headers: principalHeaders('grokbot', undefined),
          });
          const partialListBody = await readError(partialList);
          expect(partialList.status).toBe(401);
          expect(partialListBody.error).toBe('dispatch_principal_partial');
          expect(partialListBody.text.includes(foreignBody)).toBe(false);

          const statusRoute = await app.request('/api/dispatch/status', {
            headers: principalHeaders('grokbot', grokbotToken),
          });
          const statusBody = await readError(statusRoute);
          expect(statusRoute.status).toBe(403);
          expect(statusBody.error).toBe('dispatch_principal_forbidden');
          expect(statusBody.text.includes(foreignBody)).toBe(false);

          const report = await postMessage(app, principalHeaders('grokbot', grokbotToken), {
            task_type: 'run_report',
            idempotency_key: `bypass-report-${name}`,
            body: 'Report on the latest CI failure.',
          });
          const reportBody = await readError(report);
          expect(report.status).toBe(403);
          expect(reportBody.error).toBe('dispatch_principal_forbidden');
          expect(
            (
              await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
                `bypass-report-${name}`,
              ])
            ).rowCount
          ).toBe(0);

          const allowed = await postMessage(app, principalHeaders('grokbot', grokbotToken), {
            idempotency_key: `bypass-allowed-${name}`,
          });
          expect(allowed.status).toBe(200);
          expect(
            ((await allowed.json()) as { sender_principal_id: string | null }).sender_principal_id
          ).toBe('grokbot');

          const headerless = await postMessage(
            app,
            { 'Content-Type': 'application/json' },
            {
              sender: 'claude',
              recipient: 'codex',
              idempotency_key: `bypass-headerless-${name}`,
            }
          );
          expect(headerless.status).toBe(200);
          expect(
            ((await headerless.json()) as { sender_principal_id: string | null })
              .sender_principal_id
          ).toBeNull();

          enableMatchingAccess();
          const accessExtra = matchingAccessHeaders();
          const emptyAccessHeaders = new Headers({
            'Content-Type': 'application/json',
            ...accessExtra,
          });
          emptyAccessHeaders.set('x-dispatch-principal-id', '');
          emptyAccessHeaders.set('x-dispatch-principal-token', '');
          const emptyAccess = await app.request('/api/dispatch/messages', {
            method: 'POST',
            headers: emptyAccessHeaders,
            body: JSON.stringify({
              ...VALID_BODY,
              sender: 'grokbot',
              recipient: 'grokbot',
              body: ownBody,
              idempotency_key: `bypass-empty-access-${name}`,
            }),
          });
          const emptyAccessBody = await readError(emptyAccess);
          expect(emptyAccess.status).toBe(401);
          expect(emptyAccessBody.error).toBe('dispatch_principal_missing');
          expectNoSecret(emptyAccessBody.text, grokbotToken);
          expect(emptyAccessBody.text.includes(foreignBody)).toBe(false);
          expect(
            (
              await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
                `bypass-empty-access-${name}`,
              ])
            ).rowCount
          ).toBe(0);

          const partialAccess = await postMessage(
            app,
            principalHeaders('grokbot', undefined, accessExtra),
            { idempotency_key: `bypass-partial-access-${name}` }
          );
          const partialAccessBody = await readError(partialAccess);
          expect(partialAccess.status).toBe(401);
          expect(partialAccessBody.error).toBe('dispatch_principal_partial');
          expectNoSecret(partialAccessBody.text, grokbotToken);
          expect(partialAccessBody.text.includes(foreignBody)).toBe(false);

          const partialAccessList = await app.request(listUrl({ recipient: 'codex' }), {
            headers: principalHeaders('grokbot', undefined, accessExtra),
          });
          const partialAccessListBody = await readError(partialAccessList);
          expect(partialAccessList.status).toBe(401);
          expect(partialAccessListBody.error).toBe('dispatch_principal_partial');
          expect(partialAccessListBody.text.includes(foreignBody)).toBe(false);

          const foreignAccessList = await app.request(listUrl({ recipient: 'codex' }), {
            headers: principalHeaders('grokbot', grokbotToken, accessExtra),
          });
          const foreignAccessListBody = await readError(foreignAccessList);
          expect(foreignAccessList.status).toBe(403);
          expect(foreignAccessListBody.error).toBe('dispatch_principal_forbidden');
          expect(foreignAccessListBody.text.includes(foreignBody)).toBe(false);
          expectNoSecret(foreignAccessListBody.text, grokbotToken);

          const accessReport = await postMessage(
            app,
            principalHeaders('grokbot', grokbotToken, accessExtra),
            {
              task_type: 'run_report',
              idempotency_key: `bypass-report-access-${name}`,
              body: 'Report on the latest CI failure.',
            }
          );
          const accessReportBody = await readError(accessReport);
          expect(accessReport.status).toBe(403);
          expect(accessReportBody.error).toBe('dispatch_principal_forbidden');
          expectNoSecret(accessReportBody.text, grokbotToken);
          expect(
            (
              await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
                `bypass-report-access-${name}`,
              ])
            ).rowCount
          ).toBe(0);

          const headerlessAccess = await postMessage(
            app,
            { 'Content-Type': 'application/json', ...accessExtra },
            {
              sender: 'claude',
              recipient: 'codex',
              idempotency_key: `bypass-headerless-access-${name}`,
            }
          );
          expect(headerlessAccess.status).toBe(200);
          expect(
            ((await headerlessAccess.json()) as { sender_principal_id: string | null })
              .sender_principal_id
          ).toBeNull();

          if (name === 'no-operator-token') {
            const presentedUnconfigured = await app.request('/api/dispatch/status', {
              headers: principalHeaders('grokbot', grokbotToken, {
                'x-archon-operator-token': 'secret-token',
              }),
            });
            const presentedBody = await readError(presentedUnconfigured);
            expect(presentedUnconfigured.status).toBe(403);
            expect(presentedBody.error).toBe('dispatch_principal_forbidden');
            expect(presentedBody.text.includes(foreignBody)).toBe(false);
          }
        }

        process.env.ARCHON_OPERATOR_AUTH_DISABLED = 'true';
        const disabledWithToken = makeApp('secret-token');
        const operatorHeaders = principalHeaders('grokbot', grokbotToken, {
          'x-archon-operator-token': 'secret-token',
        });
        const operatorReport = await postMessage(disabledWithToken, operatorHeaders, {
          task_type: 'run_report',
          idempotency_key: 'bypass-disabled-operator-report',
          body: 'Operator report.',
        });
        expect(operatorReport.status).toBe(200);
        expect(((await operatorReport.json()) as { task_type: string }).task_type).toBe(
          'run_report'
        );

        const operatorStatus = await disabledWithToken.request('/api/dispatch/status', {
          headers: operatorHeaders,
        });
        expect(operatorStatus.status).toBe(200);

        enableMatchingAccess();
        const operatorAccessHeaders = principalHeaders('grokbot', grokbotToken, {
          'x-archon-operator-token': 'secret-token',
          ...matchingAccessHeaders(),
        });
        const operatorAccessReport = await postMessage(disabledWithToken, operatorAccessHeaders, {
          task_type: 'run_report',
          idempotency_key: 'bypass-disabled-operator-report-access',
          body: 'Operator report.',
        });
        expect(operatorAccessReport.status).toBe(200);
        expect(((await operatorAccessReport.json()) as { task_type: string }).task_type).toBe(
          'run_report'
        );
        const operatorAccessStatus = await disabledWithToken.request('/api/dispatch/status', {
          headers: operatorAccessHeaders,
        });
        expect(operatorAccessStatus.status).toBe(200);

        const mixedPartial = await postMessage(
          disabledWithToken,
          principalHeaders('grokbot', undefined, { 'x-archon-operator-token': 'secret-token' }),
          { idempotency_key: 'bypass-disabled-mixed-partial' }
        );
        const mixedPartialBody = await readError(mixedPartial);
        expect(mixedPartial.status).toBe(401);
        expect(mixedPartialBody.error).toBe('dispatch_principal_partial');
        expect(
          (
            await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
              'bypass-disabled-mixed-partial',
            ])
          ).rowCount
        ).toBe(0);

        const partialStatus = await disabledWithToken.request('/api/dispatch/status', {
          headers: principalHeaders('grokbot', undefined, {
            'x-archon-operator-token': 'secret-token',
          }),
        });
        expect(partialStatus.status).toBe(200);
      } finally {
        clearMatchingAccess();
        restoreEnv('ARCHON_OPERATOR_AUTH_DISABLED', priorAuthDisabled);
        restoreEnv('NODE_ENV', priorNodeEnv);
      }
    });
  });
});
