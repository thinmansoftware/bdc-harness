import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

const mockCreateMessage = mock(async (data: Record<string, unknown>) => ({
  id: 'dispatch-1',
  correlation_id: data.correlation_id,
  idempotency_key: data.idempotency_key,
  task_type: data.task_type,
  sender: data.sender,
  recipient: data.recipient,
  body: data.body,
  status: 'queued',
  result_body: null,
  created_at: new Date().toISOString(),
  claimed_at: null,
  completed_at: null,
  not_before: null,
  lease_owner: null,
  lease_expires_at: null,
  fencing_token: 0,
}));
const mockListDispatchMessages = mock(async () => []);
const mockClaimMessage = mock(async () => null);
const mockPostResult = mock(async () => null);
const mockCancelMessage = mock(async () => null);
const mockRegisterWorker = mock(async (data: Record<string, unknown>) => ({
  worker_id: data.worker_id,
  host: data.host,
  capabilities: data.capabilities,
  max_concurrency: data.max_concurrency,
  status: 'available',
  registered_at: new Date().toISOString(),
  last_heartbeat_at: new Date().toISOString(),
}));
const mockHeartbeatWorker = mock(async () => null);

mock.module('@archon/core/db/dispatch', () => ({
  createMessage: mockCreateMessage,
  listMessages: mockListDispatchMessages,
  claimMessage: mockClaimMessage,
  postResult: mockPostResult,
  cancelMessage: mockCancelMessage,
  registerWorker: mockRegisterWorker,
  heartbeatWorker: mockHeartbeatWorker,
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
    mockCreateMessage.mockClear();
    mockCreateMessage.mockImplementation(async (data: Record<string, unknown>) => ({
      id: 'dispatch-1',
      correlation_id: data.correlation_id,
      idempotency_key: data.idempotency_key,
      task_type: data.task_type,
      sender: data.sender,
      recipient: data.recipient,
      body: data.body,
      status: 'queued',
      result_body: null,
      created_at: new Date().toISOString(),
      claimed_at: null,
      completed_at: null,
      not_before: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
    }));
  });

  test('rejects unsupported task_type with named validation error', async () => {
    const app = makeApp();
    const response = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, task_type: 'run_bash' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('task_type');
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  test('rejects repo-mutating agent_message body before insert', async () => {
    const app = makeApp();
    const response = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        body: 'Commit the patch, push the branch, merge it to dev, and deploy production.',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('repo_mutating_agent_message_rejected');
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });

  test('requires operator token when configured', async () => {
    const app = makeApp('secret-token');
    const response = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(response.status).toBe(401);
  });

  test('creates a dispatch message with operator token', async () => {
    const app = makeApp('secret-token');
    const response = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { idempotency_key: string };
    expect(body.idempotency_key).toBe('idem-1');
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
  });

  test('returns original row for duplicate idempotency key at HTTP layer', async () => {
    mockCreateMessage.mockResolvedValue({
      id: 'dispatch-original',
      correlation_id: 'corr-original',
      idempotency_key: 'idem-1',
      task_type: 'agent_message',
      sender: 'claude',
      recipient: 'codex',
      body: 'first body',
      status: 'queued',
      result_body: null,
      created_at: new Date().toISOString(),
      claimed_at: null,
      completed_at: null,
      not_before: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
    });
    const app = makeApp();

    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    const second = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, body: 'second body' }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: string; body: string };
    expect(secondBody.id).toBe('dispatch-original');
    expect(secondBody.body).toBe('first body');
    expect(mockCreateMessage).toHaveBeenCalledTimes(2);
  });
});
