import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
const oldOperatorToken = process.env.ARCHON_OPERATOR_TOKEN;
const oldOperatorAuthDisabled = process.env.ARCHON_OPERATOR_AUTH_DISABLED;
const oldNodeEnv = process.env.NODE_ENV;

let currentDbPath = '';
let currentHome = '';

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
  getHomeCommandsPath: () => '/tmp/.archon-test-nonexistent/commands',
  getRunArtifactsPath: () => '/tmp/.archon-test-nonexistent/runs',
  getArchonHome: () => process.env.ARCHON_HOME ?? '/tmp/.archon-test-overseer-capabilities',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
}));

mock.module('@archon/workflows/router', () => ({
  resolveWorkflowName: mock(() => null),
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

mock.module('@archon/smart-cauldron/cascade', () => ({
  runCascade: mock(async () => ({ ok: true })),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/providers/auth-refresh/dispatch-gate', () => ({
  checkCodexDispatchGate: mock(async () => ({ allowed: true })),
}));

mock.module('@archon/workflows/reliability/wait-scheduler', () => ({
  processDueProviderWaits: mock(async () => undefined),
}));

mock.module('@archon/workflows/reliability/resolve-binding', () => ({
  resolveWorkflowProbeBindings: mock(() => []),
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
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  cancelStaleWorkflowRuns: mock(async () => ({ count: 0, ids: [] })),
  pauseWorkflowRunByOperator: mock(async () => {}),
  resumeWorkflowRunFromPause: mock(async () => {}),
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    drained: true,
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    updatedAt: null,
  })),
  setCauldronDrainMode: mock(async () => ({ changed: true })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
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

mock.module('@archon/providers/claude/throttle', () => ({
  claudeProviderThrottle: {
    isThrottled: mock(() => false),
    setThrottled: mock(() => undefined),
    waitForRelease: mock(async () => undefined),
    checkRateLimitAndMaybeThrottle: mock(() => undefined),
    getEngageContext: mock(() => undefined),
  },
  AUTO_THROTTLE_UTILIZATION: 0.85,
  AUTO_THROTTLE_LEAD_MS: 300_000,
}));

import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { getOverseerCapabilityState } from '@archon/core/db/overseer-capabilities';
import { registerApiRoutes } from './api';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);

function cleanupDb(path: string): void {
  if (!path) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // File may not exist.
    }
  }
}

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

describe('POST /api/admin/overseer/capabilities/reset', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-admin-overseer-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    currentDbPath = join(currentHome, 'archon.db');
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
    process.env.NODE_ENV = 'test';
    getDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    cleanupDb(currentDbPath);
    if (currentHome) rmSync(currentHome, { recursive: true, force: true });
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldOperatorToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
    else process.env.ARCHON_OPERATOR_TOKEN = oldOperatorToken;
    if (oldOperatorAuthDisabled === undefined) delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
    else process.env.ARCHON_OPERATOR_AUTH_DISABLED = oldOperatorAuthDisabled;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  });

  test('returns 401 without operator token when token auth is configured', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'secret-token';
    const app = makeApp();

    const response = await app.request('/api/admin/overseer/capabilities/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capability: 'branch',
        reason: 'john-activation',
        correlation_id: 'corr-branch-unauthorized',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: VERIFIER_DIGEST,
      }),
    });

    expect(response.status).toBe(401);
    expect((await getOverseerCapabilityState('branch'))?.action_enabled).toBe(false);
  });

  test('returns 200 and resets activation capabilities with a valid operator token', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'secret-token';
    const app = makeApp();

    for (const capability of ['branch', 'merge', 'lifecycle', 'repair']) {
      const response = await app.request('/api/admin/overseer/capabilities/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        },
        body: JSON.stringify({
          capability,
          reason: 'john-activation',
          correlation_id: `corr-${capability}-reset`,
          policy_digest: POLICY_DIGEST,
          verifier_registry_digest: VERIFIER_DIGEST,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        state: { action_enabled: boolean; circuit_state: string; updated_by: string };
        event: { event_type: string; actor: string };
      };
      expect(body.success).toBe(true);
      expect(body.state.action_enabled).toBe(true);
      expect(body.state.circuit_state).toBe('closed');
      expect(body.state.updated_by).toBe('operator');
      expect(body.event.event_type).toBe('circuit_reset');
      expect(body.event.actor).toBe('operator');

      const state = await getOverseerCapabilityState(capability);
      expect(state?.action_enabled).toBe(true);
      expect(state?.circuit_state).toBe('closed');
    }
  });
});
