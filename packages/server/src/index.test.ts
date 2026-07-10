import { describe, test, expect, mock, spyOn } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from './adapters/web';
import { validationErrorHook } from './routes/openapi-defaults';

const mockLogger = {
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
};

const mockGetRunningWorkflows = mock(async () => []);

mock.module('@archon/paths/strip-cwd-env-boot', () => ({}));
mock.module('dotenv', () => ({ config: mock(() => ({})) }));
mock.module('@archon/paths/env-loader', () => ({ loadArchonEnv: mock(() => undefined) }));
mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test-version',
  getArchonEnvPath: mock(() => '/tmp/.archon/.env'),
  createLogger: mock(() => mockLogger),
  logArchonPaths: mock(() => undefined),
  validateAppDefaultsPaths: mock(async () => undefined),
  shutdownTelemetry: mock(async () => undefined),
  isDocker: mock(() => false),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test/workflows/defaults'),
  getArchonWorkspacesPath: mock(() => '/tmp/.archon/workspaces'),
  getHomeCommandsPath: mock(() => '/tmp/.archon/commands'),
  getRunArtifactsPath: mock(() => '/tmp/.archon/runs'),
  getArchonHome: mock(() => '/tmp/.archon'),
  checkForUpdate: mock(async () => null),
}));
mock.module('@archon/providers', () => ({
  registerBuiltinProviders: mock(() => undefined),
  registerCommunityProviders: mock(() => undefined),
  getProviderInfoList: mock(() => []),
  isRegisteredProvider: mock(() => true),
}));
mock.module('@archon/workflows/agents/registry', () => ({
  loadAgentRegistry: mock(async () => ({})),
}));
mock.module('@archon/adapters', () => ({
  TelegramAdapter: class {},
  GitHubAdapter: class {},
  DiscordAdapter: class {},
  SlackAdapter: class {},
}));
mock.module('@archon/adapters/community/forge/gitea', () => ({ GiteaAdapter: class {} }));
mock.module('@archon/adapters/community/forge/gitlab', () => ({ GitLabAdapter: class {} }));
mock.module('@archon/core/db/workflows', () => ({
  getRunningWorkflows: mockGetRunningWorkflows,
}));
mock.module('@archon/core', () => ({
  handleMessage: mock(async () => undefined),
  getDatabaseType: mock(() => 'sqlite'),
  pool: {
    query: mock(async () => ({ rowCount: 0 })),
    end: mock(async () => undefined),
  },
  getDialect: mock(() => ({
    now: () => 'CURRENT_TIMESTAMP',
    jsonMerge: () => 'metadata',
  })),
  ConversationLockManager: class {},
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  classifyAndFormatError: mock((error: Error) => error.message),
  toSafeConfig: mock((config: unknown) => config),
  updateGlobalConfig: mock(async () => undefined),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  generateAndSetTitle: mock(async () => undefined),
  startCleanupScheduler: mock(() => undefined),
  stopCleanupScheduler: mock(() => undefined),
  loadConfig: mock(async () => ({ botName: 'Archon' })),
  logConfig: mock(() => undefined),
  getPort: mock(async () => 0),
}));
mock.module('@archon/core/workflows', () => ({ createWorkflowDeps: mock(() => ({})) }));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));
mock.module('@archon/smart-cauldron/cascade', () => ({ runCascade: mock(async () => ({})) }));
mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => undefined),
  toRepoPath: mock((path: string) => path),
  toWorktreePath: mock((path: string) => path),
}));
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(async () => ({ workflows: [], errors: [] })),
}));
mock.module('@archon/workflows/router', () => ({
  resolveWorkflowName: mock(() => 'archon-assist'),
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(async () => undefined),
}));
mock.module('@archon/workflows/reliability/wait-scheduler', () => ({
  processDueProviderWaits: mock(async () => undefined),
}));
mock.module('@archon/workflows/loader', () => ({
  getLoaderErrors: mock(() => []),
  parseWorkflow: mock(() => ({ name: 'test', nodes: [] })),
}));
mock.module('@archon/workflows/command-validation', () => ({
  isValidCommandName: mock(() => true),
}));
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));
mock.module('@archon/providers/claude/throttle', () => ({
  claudeProviderThrottle: {
    getSnapshot: mock(() => ({ throttleActive: false })),
    setPaused: mock(() => undefined),
  },
}));
mock.module('./startup-reconciliation', () => ({
  observeStartupRecovery: mock(async () => ({ blocked: 0 })),
}));
mock.module('./adapters/web', () => ({ WebAdapter: class {} }));
mock.module('./adapters/web/persistence', () => ({ MessagePersistence: class {} }));
mock.module('./adapters/web/transport', () => ({ SSETransport: class {} }));
mock.module('./adapters/web/workflow-bridge', () => ({
  WorkflowEventBridge: class {},
  resolveWebLane: mock(() => ({ workflowName: 'archon-assist' })),
}));
mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({ id: 'conv-1' })),
  softDeleteConversation: mock(async () => undefined),
  updateConversationTitle: mock(async () => undefined),
  getConversationById: mock(async () => null),
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => undefined),
}));
mock.module('@archon/core/db/env-vars', () => ({
  listEnvVars: mock(async () => []),
  setEnvVar: mock(async () => undefined),
  deleteEnvVar: mock(async () => undefined),
}));
mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  listByCodebaseWithAge: mock(async () => []),
  updateStatus: mock(async () => undefined),
}));
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'msg-1' })),
  listMessages: mock(async () => []),
}));

const { registerApiRoutes } = await import('./routes/api');
const { handleUnhandledRejection } = await import('./index');

type RunStatus = 'running' | 'completed' | 'failed';

interface TestRun {
  status: RunStatus;
  reason?: string;
}

interface TestProvider {
  sendQuery(): AsyncGenerator<{ type: string; content?: string }>;
}

async function dispatchRun(run: TestRun, provider: TestProvider): Promise<void> {
  try {
    for await (const _ of provider.sendQuery()) {
      // consume provider stream
    }
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.reason = error instanceof Error ? error.message : String(error);
  }
}

describe('WO-HARNESS-CODEX-PROVIDER-CRASH-ISOLATION-01 server liveness', () => {
  test('dead-auth codex failure leaves registered health route up and no unhandled rejection', async () => {
    const mockLockManager = {
      getStats: mock(() => ({
        active: 1,
        queuedTotal: 0,
        queuedByConversation: [],
        maxConcurrent: 10,
        activeConversationIds: ['codex-dead-auth'],
      })),
    } as unknown as ConversationLockManager;
    const mockWebAdapter = {} as WebAdapter;
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager, ['Web']);
    const codexRun: TestRun = { status: 'running' };
    const claudeRun: TestRun = { status: 'running' };
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const unhandledRejection = mock((reason: unknown) => handleUnhandledRejection(reason));
    process.on('unhandledRejection', unhandledRejection);

    const deadAuthCodex: TestProvider = {
      async *sendQuery() {
        throw new Error('Codex auth error: refresh token was revoked');
      },
    };
    const mockClaude: TestProvider = {
      async *sendQuery() {
        await new Promise(resolve => setTimeout(resolve, 1));
        yield { type: 'assistant', content: 'done' };
      },
    };

    try {
      const codexPromise = dispatchRun(codexRun, deadAuthCodex);
      const claudePromise = dispatchRun(claudeRun, mockClaude);

      const duringFailure = await app.request('/api/health');
      expect(duringFailure.status).toBe(200);
      expect((await duringFailure.json()).status).toBe('ok');

      await Promise.all([codexPromise, claudePromise]);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(codexRun.status).toBe('failed');
      expect(codexRun.reason).toMatch(/codex auth error/i);
      expect(claudeRun.status).toBe('completed');
      const afterFailure = await app.request('/api/health');
      expect(afterFailure.status).toBe(200);
      expect((await afterFailure.json()).status).toBe('ok');
      expect(exitSpy).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      exitSpy.mockRestore();
    }
  });
});
