import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  makeCommandValidationMock,
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
} from '../test/workflow-mock-factories';
import {
  resetSeatUsageCacheForTests,
  setSeatUsageReaderForTests,
  type SeatReading,
} from '@archon/workflows/reliability/seat-usage';

delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

const silentLogger = () => ({
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
});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mock(() => 'sqlite' as const),
  loadConfig: mock(async () => ({ assistants: { claude: { model: 'sonnet' } } })),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  toSafeConfig: (config: unknown) => config,
  generateAndSetTitle: mock(async () => {}),
  updateGlobalConfig: mock(async () => {}),
  createLogger: silentLogger,
}));

mock.module('@archon/paths', () => ({
  createLogger: silentLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  isDocker: mock(() => false),
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));
mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));
mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
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
mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  listByCodebaseWithAge: mock(async () => []),
  updateStatus: mock(async () => {}),
}));
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({ runs: [], total: 0, counts: {} })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
}));
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));
mock.module('@archon/core/db/env-vars', () => ({
  getEnvVars: mock(async () => []),
  getEnvVarKeys: mock(async () => []),
  setEnvVar: mock(async () => {}),
  deleteEnvVar: mock(async () => {}),
}));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

function seat(
  id: SeatReading['seat'],
  seven: SeatReading['seven_day'],
  source: SeatReading['limit_source']
): SeatReading {
  return {
    seat: id,
    limit_source: source,
    windows:
      source === 'measured' && typeof seven === 'object'
        ? [
            {
              name: id === 'codex' ? 'primary' : 'seven_day',
              used_percent: seven.used_percent,
              remaining_percent: seven.remaining_percent,
              resets_at: seven.resets_at,
            },
          ]
        : [],
    seven_day: seven,
    gate_windows: [],
    note: source === 'UNKNOWN' ? 'stub unknown' : '',
    probed_at: '2026-09-24T00:00:00.000Z',
    endpoint: 'https://example.invalid',
  };
}

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

describe('fuelglass seat routes', () => {
  let app: OpenAPIHono;

  beforeEach(() => {
    resetSeatUsageCacheForTests();
    delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
    setSeatUsageReaderForTests(async () => ({
      claude: seat(
        'claude',
        { used_percent: 41, remaining_percent: 59, resets_at: '2026-09-28T02:59:59Z' },
        'measured'
      ),
      codex: seat(
        'codex',
        { used_percent: 92, remaining_percent: 8, resets_at: '2026-09-27T13:13:32Z' },
        'measured'
      ),
      cursor: seat('cursor', 'NOT_APPLICABLE', 'UNKNOWN'),
    }));
    app = makeApp();
  });

  afterEach(() => {
    resetSeatUsageCacheForTests();
    delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  });

  test('api_seats_and_cutoff_routes', async () => {
    const first = await app.request('/api/fuelglass/seats');
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      seats: Record<string, { seven_day: { used_percent?: number } | string }>;
    };
    expect(Object.keys(body.seats).sort()).toEqual(['claude', 'codex', 'cursor']);
    expect(body.seats.claude?.seven_day).toMatchObject({ used_percent: 41 });
    expect(body.seats.codex?.seven_day).toMatchObject({ used_percent: 92 });
    expect(body.seats.cursor?.seven_day).toBe('NOT_APPLICABLE');

    const setCutoff = await app.request('/api/fuelglass/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 90 }),
    });
    expect(setCutoff.status).toBe(200);

    const second = await app.request('/api/fuelglass/seats');
    const after = (await second.json()) as { cutoff: { percent: number; source: string } };
    expect(after.cutoff).toEqual({ percent: 90, source: 'operator' });

    const tooHigh = await app.request('/api/fuelglass/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 150 }),
    });
    expect(tooHigh.status).toBe(400);

    const notNumber = await app.request('/api/fuelglass/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 'x' }),
    });
    expect(notNumber.status).toBe(400);

    const cleared = await app.request('/api/fuelglass/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as { cutoff: { source: string } };
    expect(clearedBody.cutoff.source === 'default' || clearedBody.cutoff.source === 'env').toBe(
      true
    );
  });
});
