import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import type { CanarySnapshotResponse } from './schemas/canary.schemas';
import {
  makeCommandValidationMock,
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
} from '../test/workflow-mock-factories';

const mockAddMessage = mock(async () => null);
const mockCreateWorkflowRun = mock(async () => null);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: (config: unknown) => config,
  updateGlobalConfig: mock(async () => {}),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
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
  getDefaultCommandsPath: mock(() => '/tmp/commands'),
  getDefaultWorkflowsPath: mock(() => '/tmp/workflows'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getHomeCommandsPath: () => '/tmp/.archon/commands',
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  getArchonHome: () => '/tmp/.archon',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: () => false,
}));
mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (value: string) => value,
  toWorktreePath: (value: string) => value,
}));
mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
}));
mock.module('@archon/core/db/env-vars', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    drained: false,
    updatedAt: null,
  })),
}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({ addMessage: mockAddMessage }));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

clearRegistry();
registerBuiltinProviders();

import { registerApiRoutes } from './api';

const snapshot: CanarySnapshotResponse = {
  observedAt: '2026-07-10T12:00:00.000Z',
  codebase: {
    id: 'codebase-1',
    canonicalRemote: 'bluedevilcollectibles/bdc-harness',
    defaultCwd: '/workspace/bdc-harness',
    baseBranch: 'dev',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
  revisions: {
    engineRevision: 'sha256:engine',
    bundleRevision: 'sha256:bundle',
    runtimeImageRevision: 'sha256:image',
  },
  drain: {
    mode: 'normal',
    drained: false,
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    updatedAt: null,
  },
  workflows: [],
  providers: [],
  loaderErrors: [],
  ladder: { tiers: [] },
  ruleset: { defaultEntry: 'codex', rules: [] },
};

function makeApp(builder: () => Promise<CanarySnapshotResponse>): OpenAPIHono {
  const app = new OpenAPIHono();
  registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager, undefined, builder);
  return app;
}

let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.ARCHON_OPERATOR_TOKEN;
  process.env.ARCHON_OPERATOR_TOKEN = 'test-operator-token';
  mockAddMessage.mockClear();
  mockCreateWorkflowRun.mockClear();
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
  else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
});

describe('GET /api/admin/canary/snapshot', () => {
  test('requires the existing operator token', async () => {
    const response = await makeApp(async () => snapshot).request(
      '/api/admin/canary/snapshot?codebaseId=codebase-1&baseBranch=dev'
    );
    expect(response.status).toBe(401);
  });

  test('returns the exact snapshot without message or workflow mutations', async () => {
    const builder = mock(async () => snapshot);
    const response = await makeApp(builder).request(
      '/api/admin/canary/snapshot?codebaseId=codebase-1&baseBranch=dev',
      { headers: { 'x-archon-operator-token': 'test-operator-token' } }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(builder).toHaveBeenCalledWith('codebase-1', 'dev');
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });
});
