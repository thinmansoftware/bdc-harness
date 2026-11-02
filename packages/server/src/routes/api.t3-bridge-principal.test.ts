/**
 * Test 9 (WO-HARNESS-T3-COMMAND-CONSUMER-01): principal issuance + blast radius.
 *
 * With the t3-bridge credential in DISPATCH_PRINCIPALS_JSON, a request carrying
 * t3-bridge principal headers:
 *   - is FORBIDDEN (403) on every non-transport route and on a transport list
 *     for a recipient outside its receive_as, and
 *   - may ONLY send an agent_message to cauldron-fire, which lands a row whose
 *     sender_principal_id is t3-bridge.
 * The registry parses the record, and a consumer reply sent as the cauldron-fire
 * system sender carries sender=cauldron-fire.
 *
 * Mirrors the app/mock harness proven by api.dispatch.test.ts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { createAuthenticatedMessage, type DispatchMessage } from '@archon/core/db/dispatch';
import { parseDispatchPrincipalsRegistry } from '@archon/core/db/dispatch-sender-authority';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let db: SqliteAdapter;
let currentDbPath = '';

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
    getWorkflowRun: mock(async () => null),
    cancelWorkflowRun: mock(async () => {}),
    listWorkflowEvents: mock(async () => []),
    addMessage: mock(async () => null),
    listMessages: mock(async () => []),
    findMarkdownFilesRecursive: mock(async () => []),
  }));
}

import { registerApiRoutes } from './api';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function makeApp(): OpenAPIHono {
  delete process.env.ARCHON_OPERATOR_TOKEN;
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

const T3_TOKEN = 't3-bridge-secret';
const T3_HEADERS = {
  'Content-Type': 'application/json',
  'x-dispatch-principal-id': 't3-bridge',
  'x-dispatch-principal-token': T3_TOKEN,
};

describe('Test 9: t3-bridge principal issuance and blast radius', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 't3-bridge-1',
        principal_id: 't3-bridge',
        token_sha256: sha(T3_TOKEN),
        status: 'active',
        send_as: ['t3-bridge'],
        receive_as: ['t3-desktop'],
        roles: ['send', 'receive'],
      },
    ]);
    currentDbPath = join(
      import.meta.dir,
      `.test-t3-principal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    delete process.env.ARCHON_OPERATOR_TOKEN;
    delete process.env.DISPATCH_PRINCIPALS_JSON;
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('principal headers are forbidden on every non-transport route', async () => {
    const app = makeApp();

    const deleteBulk = await app.request('/api/workflows/runs/bulk-failed', {
      method: 'DELETE',
      headers: T3_HEADERS,
    });
    expect(deleteBulk.status).toBe(403);

    const cancel = await app.request('/api/workflows/runs/R1/cancel', {
      method: 'POST',
      headers: T3_HEADERS,
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(403);

    const conversations = await app.request('/api/conversations', {
      method: 'POST',
      headers: T3_HEADERS,
      body: JSON.stringify({}),
    });
    expect(conversations.status).toBe(403);
  });

  test('listing a recipient outside receive_as is forbidden', async () => {
    const app = makeApp();
    const response = await app.request('/api/dispatch/messages?recipient=cauldron-fire', {
      method: 'GET',
      headers: {
        'x-dispatch-principal-id': 't3-bridge',
        'x-dispatch-principal-token': T3_TOKEN,
      },
    });
    expect(response.status).toBe(403);
  });

  test('sending an agent_message to cauldron-fire succeeds and binds sender_principal_id', async () => {
    const app = makeApp();
    const response = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: T3_HEADERS,
      body: JSON.stringify({
        correlation_id: 'req-9',
        idempotency_key: 'req-9',
        task_type: 'agent_message',
        sender: 't3-bridge',
        recipient: 'cauldron-fire',
        body: JSON.stringify({ schema: 't3-command/v1', request_id: 'req-9', verb: 'fire' }),
      }),
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as {
      sender: string;
      sender_principal_id: string;
      recipient: string;
    };
    expect(message.sender).toBe('t3-bridge');
    expect(message.sender_principal_id).toBe('t3-bridge');
    expect(message.recipient).toBe('cauldron-fire');

    const row = await db.query<{ sender_principal_id: string }>(
      'SELECT sender_principal_id FROM agent_dispatch_messages WHERE idempotency_key = $1',
      ['req-9']
    );
    expect(row.rows[0]?.sender_principal_id).toBe('t3-bridge');
  });

  test('the registry parses the t3-bridge record', () => {
    const registry = parseDispatchPrincipalsRegistry(process.env.DISPATCH_PRINCIPALS_JSON);
    const record = registry.find(entry => entry.principal_id === 't3-bridge');
    expect(record).toBeDefined();
    expect(record?.send_as).toEqual(['t3-bridge']);
    expect(record?.receive_as).toEqual(['t3-desktop']);
    expect(record?.roles).not.toContain('admin');
  });

  test('a consumer reply is sent as the cauldron-fire system sender', async () => {
    const reply: DispatchMessage = await createAuthenticatedMessage(
      { kind: 'system', sender: 'cauldron-fire' },
      {
        correlation_id: 'req-9',
        idempotency_key: 'reply:cmd-9',
        task_type: 'agent_message',
        recipient: 't3-desktop',
        body: JSON.stringify({ schema: 't3-command-reply/v1', request_id: 'req-9', status: 200 }),
      }
    );
    expect(reply.sender).toBe('cauldron-fire');
    expect(reply.sender_principal_id).toBe('system:cauldron-fire');
    expect(reply.recipient).toBe('t3-desktop');
  });
});
