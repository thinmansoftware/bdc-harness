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
import {
  acknowledgeMessage,
  createAuthenticatedMessage,
  listMessages,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
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

interface StoredRun {
  id: string;
  workflow_name: string;
  status: string;
  user_message: string;
  conversation_id: string | null;
  parent_conversation_id: string | null;
  working_path: string | null;
  codebase_id: string | null;
  metadata: Record<string, unknown>;
}
interface StoredEvent {
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}
const store = {
  runs: new Map<string, StoredRun>(),
  events: [] as StoredEvent[],
  conversations: new Map<
    string,
    { id: string; platform_conversation_id: string; platform_type: string }
  >(),
};
const executorCalls: { workerConvId: string; parentConvId: string | undefined }[] = [];

/** The executor's resume: findResumableRun picks the approved run and continues. */
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(
    async (
      _deps: unknown,
      _adapter: unknown,
      _workerPlatformId: string,
      _cwd: string,
      _workflow: unknown,
      _message: string,
      workerConvId: string,
      _codebaseId?: string,
      _a?: unknown,
      _b?: unknown,
      parentConvId?: string
    ) => {
      executorCalls.push({ workerConvId, parentConvId });
      const run = [...store.runs.values()].find(
        candidate =>
          candidate.conversation_id === workerConvId &&
          candidate.status === 'failed' &&
          candidate.metadata.approval_response === 'approved'
      );
      if (!run) return { success: false };
      run.status = 'running';
      for (const event_type of ['node_started', 'node_completed']) {
        store.events.push({
          workflow_run_id: run.id,
          event_type,
          step_name: 'after-gate',
          data: {},
          created_at: new Date().toISOString(),
        });
      }
      run.status = 'completed';
      return { success: true, workflowRunId: run.id };
    }
  ),
}));
mock.module('@archon/core/workflows', () => ({ createWorkflowDeps: () => ({}) }));
mock.module('../adapters/web/workflow-bridge', () => ({
  resolveWebLane: mock(async () => undefined),
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
    getConversationById: mock(async (id: string) => store.conversations.get(id) ?? null),
    listCodebases: mock(async () => []),
    getCodebase: mock(async () => null),
    deleteCodebase: mock(async () => {}),
    listEnvVars: mock(async () => []),
    setEnvVar: mock(async () => null),
    deleteEnvVar: mock(async () => false),
    listByCodebase: mock(async () => []),
    updateStatus: mock(async () => {}),
    listWorkflowRuns: mock(async () => []),
    getWorkflowRun: mock(async (id: string) => {
      const run = store.runs.get(id);
      return run ? { ...run, metadata: { ...run.metadata } } : null;
    }),
    updateWorkflowRun: mock(
      async (id: string, patch: { status?: string; metadata?: Record<string, unknown> }) => {
        const run = store.runs.get(id);
        if (!run) return;
        if (patch.status) run.status = patch.status;
        if (patch.metadata) run.metadata = { ...run.metadata, ...patch.metadata };
      }
    ),
    // Store-backed twin of workflowsDb.approvePausedRunAtGate (one conditional update).
    approvePausedRunAtGate: mock(
      async (
        id: string,
        expected: string,
        update: Record<string, unknown>,
        events: { event_type: string; step_name?: string; data?: Record<string, unknown> }[] = []
      ) => {
        const run = store.runs.get(id);
        const gate = (run?.metadata.approval as { nodeId?: string } | undefined)?.nodeId;
        if (!run || run.status !== 'paused' || gate !== expected) return false;
        run.status = 'failed';
        run.metadata = { ...run.metadata, ...update };
        // Same transaction as the gate update: the approval events.
        for (const event of events) {
          store.events.push({
            workflow_run_id: id,
            event_type: event.event_type,
            step_name: event.step_name ?? null,
            data: event.data ?? {},
            created_at: new Date().toISOString(),
          });
        }
        return true;
      }
    ),
    createWorkflowEvent: mock(
      async (event: Omit<StoredEvent, 'created_at' | 'step_name'> & { step_name?: string }) => {
        store.events.push({
          ...event,
          step_name: event.step_name ?? null,
          created_at: new Date().toISOString(),
        });
      }
    ),
    cancelWorkflowRun: mock(async () => {}),
    listWorkflowEvents: mock(async (runId: string) =>
      store.events.filter(event => event.workflow_run_id === runId)
    ),
    addMessage: mock(async () => null),
    listMessages: mock(async () => []),
    findMarkdownFilesRecursive: mock(async () => []),
  }));
}

import { registerApiRoutes } from './api';
import {
  createInProcessApiFetch,
  IN_PROCESS_API_ORIGIN,
  isInProcessServiceRequest,
} from './in-process-authority';
import {
  completeCommandMessage,
  createRealCauldronFireConsumerDeps,
  isApprovalHandOff,
  listPendingCommands,
  tickCauldronFireConsumer,
  type CauldronFireConsumerDeps,
} from '../dispatch/cauldron-fire-consumer';
import * as admissions from '@archon/core/db/t3-command-admissions';
import { mockDiscoverWorkflowsWithConfig } from '../test/workflow-mock-factories';

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
      setupEventBridge: mock(() => () => undefined),
      sendMessage: mock(async () => {}),
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

  test('Test 25 (A5.5): a same-actor resend of a request_id returns the ORIGINAL command row', async () => {
    const app = makeApp();
    const send = async (woId: string): Promise<{ id: string; body: string }> => {
      const response = await app.request('/api/dispatch/messages', {
        method: 'POST',
        headers: T3_HEADERS,
        body: JSON.stringify({
          correlation_id: 'req-25',
          idempotency_key: 'req-25',
          task_type: 'agent_message',
          sender: 't3-bridge',
          recipient: 'cauldron-fire',
          body: JSON.stringify({
            schema: 't3-command/v1',
            request_id: 'req-25',
            verb: 'fire',
            wo_id: woId,
          }),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string; body: string };
    };
    const first = await send('WO-SAME-01');
    const same = await send('WO-SAME-01');
    const changed = await send('WO-CHANGED-01');
    expect(same.id).toBe(first.id);
    // A changed payload under a reused request_id is silently the original command.
    expect(changed.id).toBe(first.id);
    expect(changed.body).toContain('WO-SAME-01');
    const rows = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM agent_dispatch_messages WHERE idempotency_key = $1',
      ['req-25']
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});

describe('in-process service authority (cauldron-fire cascade path)', () => {
  const OPERATOR = 'operator-secret-for-test';

  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-t3-inproc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    delete process.env.ARCHON_OPERATOR_TOKEN;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('an in-process request is authenticated without the operator token; the same request over the app boundary is not', async () => {
    const app = makeApp();
    process.env.ARCHON_OPERATOR_TOKEN = OPERATOR;

    const network = await app.request('/api/codebases', { method: 'GET' });
    expect(network.status).toBe(401);

    const inProcessFetch = createInProcessApiFetch(app);
    const response = await inProcessFetch(`${IN_PROCESS_API_ORIGIN}/api/codebases`, {
      headers: { 'x-archon-operator-token': '' },
    });
    expect(response.status).toBe(200);
  });

  test('a forged request object built outside createInProcessApiFetch is not admitted', async () => {
    const app = makeApp();
    process.env.ARCHON_OPERATOR_TOKEN = OPERATOR;
    const forged = new Request(`${IN_PROCESS_API_ORIGIN}/api/codebases`);
    expect(isInProcessServiceRequest(forged)).toBe(false);
    const response = await app.fetch(forged);
    expect(response.status).toBe(401);
  });

  test('refuses any origin other than the in-process origin (no network self-call)', async () => {
    const app = makeApp();
    const inProcessFetch = createInProcessApiFetch(app);
    let threw = '';
    try {
      await inProcessFetch('http://localhost:3090/api/codebases');
    } catch (error) {
      threw = (error as Error).message;
    }
    expect(threw).toBe('in_process_api_fetch_origin_refused');
  });

  test('principal headers are stripped on the in-process path', async () => {
    const app = makeApp();
    process.env.ARCHON_OPERATOR_TOKEN = OPERATOR;
    const inProcessFetch = createInProcessApiFetch(app);
    // With principal headers honored this route would be 403
    // dispatch_principal_forbidden; stripped, it runs as the in-process caller.
    const response = await inProcessFetch(`${IN_PROCESS_API_ORIGIN}/api/codebases`, {
      headers: T3_HEADERS,
    });
    expect(response.status).toBe(200);
  });
});

describe('cauldron-fire mailbox: completed commands leave the polling page', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-t3-page-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('60 completed commands do not starve the 61st', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 61; i += 1) {
      const row = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        {
          correlation_id: `page-${i}`,
          idempotency_key: `page-${i}`,
          task_type: 'agent_message',
          recipient: 'cauldron-fire',
          body: JSON.stringify({ n: i }),
        }
      );
      ids.push(row.id);
    }
    for (const id of ids.slice(0, 60)) {
      await completeCommandMessage(id);
    }
    // The consumer's real page size is 50; the 61st must be the first pending row.
    const pending = await listPendingCommands('cauldron-fire', 50);
    expect(pending.map(row => row.id)).toEqual([ids[60]]);
    // Durable: the 60 completed rows are addressed, so the raw queued page
    // (what listMessages(status='queued') returns) no longer contains them.
    const raw = await listMessages({ recipient: 'cauldron-fire', status: 'queued', limit: 100 });
    expect(raw.map(row => row.id)).toEqual([ids[60]]);
  });

  test('a row acknowledged but never addressed is healed, not re-listed forever', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const row = await createAuthenticatedMessage(
        { kind: 'system', sender: 'taskmaster' },
        {
          correlation_id: `heal-${i}`,
          idempotency_key: `heal-${i}`,
          task_type: 'agent_message',
          recipient: 'cauldron-fire',
          body: '{}',
        }
      );
      ids.push(row.id);
    }
    // Simulate an address step that failed after a successful ack.
    await acknowledgeMessage({ id: ids[0] as string, principal_id: 'cauldron-fire' });
    const pending = await listPendingCommands('cauldron-fire', 50);
    expect(pending.map(row => row.id)).toEqual([ids[1], ids[2]]);
  });
});

describe('A2.3: the in-process early branch admits nothing from the network', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-t3-a23-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });
  afterEach(async () => {
    delete process.env.ARCHON_OPERATOR_TOKEN;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('a network request carrying the in-process host / origin values gets the same 401', async () => {
    const app = makeApp();
    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret-for-test';
    const viaHost = await app.request('/api/codebases', {
      headers: { host: 'archon.in-process', origin: IN_PROCESS_API_ORIGIN },
    });
    expect(viaHost.status).toBe(401);
    const viaUrl = await app.request(`${IN_PROCESS_API_ORIGIN}/api/codebases`, {
      headers: { 'x-archon-operator-token': '' },
    });
    expect(viaUrl.status).toBe(401);
  });
});

describe('Tests 11-12: consumer approve uses the real resume path', () => {
  const SHA = '2'.repeat(40);

  function seedPausedRun(id: string, withParent: boolean): void {
    store.conversations.set(`parent-${id}`, {
      id: `parent-${id}`,
      platform_conversation_id: `web-parent-${id}`,
      platform_type: 'web',
    });
    store.conversations.set(`worker-${id}`, {
      id: `worker-${id}`,
      platform_conversation_id: `web-worker-${id}`,
      platform_type: 'web',
    });
    if (!withParent) store.conversations.delete(`parent-${id}`);
    store.runs.set(id, {
      id,
      workflow_name: 't3-gate-wf',
      status: 'paused',
      user_message: `WO_ID=WO-${id} --project bdc-harness`,
      conversation_id: `worker-${id}`,
      parent_conversation_id: `parent-${id}`,
      working_path: '/tmp/t3-gate-wt',
      codebase_id: 'cb-harness',
      metadata: { approval: { nodeId: 'gate', type: 'approval', message: 'ok?' } },
    });
  }

  async function seedOwnership(runId: string): Promise<void> {
    await admissions.reserveAdmission(
      {
        request_id: `fire-${runId}`,
        actor_principal_id: 't3-bridge',
        verb: 'fire',
        payload_sha256: 'seed',
        wo_id: `WO-${runId}`,
        project: 'bdc-harness',
        source_message_id: `seed-${runId}`,
        now: new Date().toISOString(),
      },
      db
    );
    await admissions.markAdmitted(
      `fire-${runId}`,
      {
        status_code: 200,
        code: 'ok',
        cascade_id: `C-${runId}`,
        run_id: runId,
        now: new Date().toISOString(),
      },
      db
    );
  }

  function consumerDeps(command: DispatchMessage): {
    deps: CauldronFireConsumerDeps;
    replies: { key: string; body: Record<string, unknown> }[];
  } {
    const replies: { key: string; body: Record<string, unknown> }[] = [];
    const acked: string[] = [];
    const env = {
      T3_COMMAND_CONSUMER_ENABLED: '1',
      T3_COMMAND_ACTORS: 't3-bridge',
      T3_COMMAND_PROJECTS: 'bdc-harness',
      T3_COMMAND_APPROVE_BASES: 'thinmansoftware/bdc-harness:dev',
      DISPATCH_PRINCIPALS_JSON: process.env.DISPATCH_PRINCIPALS_JSON,
    };
    // Production dependencies, including the REAL approve
    // (approvePausedWorkflowRun + hoisted tryAutoResumeRun). Only transport and
    // the GitHub / codebase reads are replaced.
    const real = createRealCauldronFireConsumerDeps(
      env,
      (async () => new Response('unused', { status: 500 })) as unknown as typeof fetch
    );
    const deps: CauldronFireConsumerDeps = {
      ...real,
      db,
      listCommands: async () => (acked.includes(command.id) ? [] : [command]),
      sendReply: async input => {
        replies.push({ key: input.idempotencyKey, body: JSON.parse(input.body) });
        return { id: `rep-${replies.length}` } as DispatchMessage;
      },
      acknowledge: async id => {
        acked.push(id);
      },
      resolveActorMailbox: () => 't3-desktop',
      resolveProjectRepository: async () => 'thinmansoftware/bdc-harness',
      getRunRepository: async () => 'thinmansoftware/bdc-harness',
      getRunBranch: async () => 'feat/x',
      getPullRequest: async () => ({
        open: true,
        headRepo: 'thinmansoftware/bdc-harness',
        baseRepo: 'thinmansoftware/bdc-harness',
        headRef: 'feat/x',
        baseRef: 'dev',
        headSha: SHA,
      }),
    };
    return { deps, replies };
  }

  function approveCommand(runId: string, requestId: string): DispatchMessage {
    return {
      id: `cmd-${requestId}`,
      correlation_id: requestId,
      idempotency_key: requestId,
      task_type: 'agent_message',
      sender: 't3-bridge',
      sender_principal_id: 't3-bridge',
      recipient: 'cauldron-fire',
      status: 'queued',
      acknowledged_at: null,
      body: JSON.stringify({
        schema: 't3-command/v1',
        request_id: requestId,
        verb: 'approve',
        project: 'bdc-harness',
        run_id_for_approve: runId,
        pr: 'thinmansoftware/bdc-harness#5',
        head_sha: SHA,
        node_id: 'gate',
        thread_id: 'th',
      }),
    } as unknown as DispatchMessage;
  }

  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    process.env.DISPATCH_PRINCIPALS_JSON = '[]';
    currentDbPath = join(
      import.meta.dir,
      `.test-t3-approve-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    store.runs.clear();
    store.events.length = 0;
    store.conversations.clear();
    executorCalls.length = 0;
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [{ workflow: { name: 't3-gate-wf' } }] as never,
      errors: [],
    }));
  });
  afterEach(async () => {
    delete process.env.DISPATCH_PRINCIPALS_JSON;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('Test 11: a paused run approved through the consumer continues to its next node', async () => {
    makeApp(); // registers the web adapter the hoisted resume dispatches through
    seedPausedRun('P1', true);
    await seedOwnership('P1');
    const { deps, replies } = consumerDeps(approveCommand('P1', 'Q-A11'));

    await tickCauldronFireConsumer(deps);
    // Let the background execution settle.
    await new Promise(resolve => setTimeout(resolve, 20));

    const events = store.events.filter(event => event.workflow_run_id === 'P1');
    const approvalIndex = events.findIndex(event => event.event_type === 'approval_received');
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    // The hand-off snapshot right after the approval is transitional for the
    // background cascade's poller -- not a terminal failure, so no rung climbs.
    expect(
      isApprovalHandOff({ run: { status: 'failed' }, events: events.slice(0, approvalIndex + 1) })
    ).toBe(true);
    expect(
      events.some(event => event.step_name === 'after-gate' && event.event_type === 'node_started')
    ).toBe(true);
    expect(store.runs.get('P1')?.status).not.toBe('failed');
    expect(executorCalls).toEqual([{ workerConvId: 'worker-P1', parentConvId: 'parent-P1' }]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toMatchObject({ status: 200, code: 'approved', run_id: 'P1' });
    expect((await admissions.getByRequestId('Q-A11', db))?.code).toBe('approved');
  });

  test('major 1: a gate that advances between the check and the approve -> 409 gate_changed, no approval event', async () => {
    makeApp();
    seedPausedRun('P5', true);
    await seedOwnership('P5');
    const { deps, replies } = consumerDeps(approveCommand('P5', 'Q-GC'));
    // The consumer's gate check passes (P5 paused at 'gate'); the next read is
    // the PR -- by then the run has advanced to another gate.
    const readPr = deps.getPullRequest;
    deps.getPullRequest = async (repo, number) => {
      const run = store.runs.get('P5');
      if (run) run.metadata = { ...run.metadata, approval: { nodeId: 'gate-2', type: 'approval' } };
      return readPr(repo, number);
    };

    await tickCauldronFireConsumer(deps);

    expect(replies[0]?.body).toMatchObject({ status: 409, code: 'gate_changed' });
    expect(
      store.events.some(
        event =>
          event.workflow_run_id === 'P5' &&
          (event.event_type === 'approval_received' || event.event_type === 'node_completed')
      )
    ).toBe(false);
    expect(store.runs.get('P5')?.status).toBe('paused');
    expect(executorCalls).toHaveLength(0);
    expect((await admissions.getByRequestId('Q-GC', db))?.code).toBe('gate_changed');
  });

  test('Test 12: auto-resume refusal is reported as approved_not_resumed', async () => {
    makeApp();
    seedPausedRun('P4', false); // parent conversation row missing
    await seedOwnership('P4');
    const { deps, replies } = consumerDeps(approveCommand('P4', 'Q-A12'));

    await tickCauldronFireConsumer(deps);

    expect(executorCalls).toHaveLength(0);
    expect(store.events.some(event => event.event_type === 'approval_received')).toBe(true);
    expect(replies[0]?.body).toMatchObject({
      status: 200,
      code: 'approved_not_resumed',
      run_id: 'P4',
    });
    const row = await admissions.getByRequestId('Q-A12', db);
    expect(row).toMatchObject({ state: 'admitted', code: 'approved_not_resumed' });
  });
});
