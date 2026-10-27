import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  makeCommandValidationMock,
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
} from '../test/workflow-mock-factories';

const capturedLogs: unknown[][] = [];

function recordLog(args: unknown[]): void {
  capturedLogs.push(
    args.map(arg => {
      if (arg instanceof Error) return { name: arg.name, message: arg.message };
      try {
        return JSON.parse(JSON.stringify(arg)) as unknown;
      } catch {
        return String(arg);
      }
    })
  );
}

delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;
delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
delete process.env.DATABASE_URL;
delete process.env.FUELGLASS_PUSHED_READING_MAX_AGE_MINUTES;

const recordingLogger = () => ({
  fatal: (...args: unknown[]) => recordLog(args),
  error: (...args: unknown[]) => recordLog(args),
  warn: (...args: unknown[]) => recordLog(args),
  info: (...args: unknown[]) => recordLog(args),
  debug: (...args: unknown[]) => recordLog(args),
  trace: (...args: unknown[]) => recordLog(args),
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
  createLogger: recordingLogger,
}));

mock.module('@archon/paths', () => ({
  createLogger: recordingLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => {
    const home = process.env.ARCHON_HOME;
    if (!home || home === 'undefined') throw new Error('ARCHON_HOME is required');
    return home;
  },
  getHomeCommandsPath: () => '/tmp/.archon-test-nonexistent/commands',
  getRunArtifactsPath: () => '/tmp/.archon-test-nonexistent/artifacts',
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
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

import { closeDatabase, resetDatabase } from '@archon/core/db/connection';
import { getLatestSeatUsageReading } from '@archon/core/db/seat-usage-readings';
import { registerApiRoutes } from './api';

const OPERATOR_TOKEN = 'test-operator-token';
let currentHome = '';
let currentDbPath = '';
const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;

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

function jwtShaped(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bodyLength = length - 2;
  const first = Math.floor(bodyLength / 3);
  const second = Math.floor(bodyLength / 3);
  const third = bodyLength - first - second;
  const segment = (size: number, salt: number): string => {
    let out = '';
    for (let i = 0; i < size; i += 1) out += alphabet[(i * 7 + salt) % alphabet.length];
    return out;
  };
  return `${segment(first, 1)}.${segment(second, 2)}.${segment(third, 3)}`;
}

function sixFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seat: 'cursor',
    used_percent: 35.28,
    remaining_percent: 64.72,
    resets_at: '2026-11-13T16:33:08.000Z',
    observed_at: new Date(Date.now() - 1000).toISOString(),
    source: 'desktop-fuelglass',
    ...overrides,
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

describe('fuelglass pushed readings', () => {
  let app: OpenAPIHono;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    capturedLogs.length = 0;
    currentHome = join(
      import.meta.dir,
      `.test-fuelglass-readings-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    currentDbPath = join(currentHome, 'archon.db');
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    delete process.env.FUELGLASS_PUSHED_READING_MAX_AGE_MINUTES;
    process.env.ARCHON_OPERATOR_TOKEN = OPERATOR_TOKEN;
    app = makeApp();
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    cleanupDb(currentDbPath);
    if (currentHome) removeTempDirWithRetry(currentHome);
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    delete process.env.ARCHON_OPERATOR_TOKEN;
  });

  function postReading(body: Record<string, unknown>, token?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== undefined) headers['x-archon-operator-token'] = token;
    return Promise.resolve(
      app.request('/api/fuelglass/readings', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    );
  }

  function getReading(): Promise<Response> {
    return Promise.resolve(
      app.request('/api/fuelglass/readings/cursor', {
        headers: { 'x-archon-operator-token': OPERATOR_TOKEN },
      })
    );
  }

  test('credential rejection stores nothing and logs none of the rejected values', async () => {
    const jwt = jwtShaped(150);
    expect(jwt.length).toBe(150);
    const cases: Array<{ body: Record<string, unknown>; error: string; secret: string }> = [
      {
        body: { ...sixFields(), cookie: 'x' },
        error: 'credential_field_rejected',
        secret: 'cookie',
      },
      {
        body: { ...sixFields(), meta: { WorkosCursorSessionToken: 'x' } },
        error: 'credential_field_rejected',
        secret: 'WorkosCursorSessionToken',
      },
      {
        body: sixFields({ source: jwt }),
        error: 'credential_value_rejected',
        secret: jwt,
      },
    ];
    const responses: string[] = [];
    for (const item of cases) {
      const res = await postReading(item.body, OPERATOR_TOKEN);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      responses.push(JSON.stringify(payload));
      expect(payload.error).toBe(item.error);
    }
    const listed = await getReading();
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { reading: unknown };
    expect(listedBody.reading).toBeNull();
    expect(await getLatestSeatUsageReading('cursor')).toBeNull();
    const logs = JSON.stringify(capturedLogs);
    const combined = `${responses.join('\n')}\n${logs}`;
    expect(combined).not.toContain(jwt);
    expect(combined).not.toContain('WorkosCursorSessionToken');
    expect(logs).not.toContain('"cookie"');
  });

  test('operator token is required and an authenticated post persists', async () => {
    const denied = await postReading(sixFields());
    expect(denied.status).toBe(401);
    const deniedBody = (await denied.json()) as { error: string };
    expect(deniedBody.error).toBe('Missing or invalid operator token');
    expect(await getLatestSeatUsageReading('cursor')).toBeNull();

    const accepted = await postReading(sixFields(), OPERATOR_TOKEN);
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as {
      success: boolean;
      reading: { received_at: string; seat: string };
    };
    expect(acceptedBody.success).toBe(true);
    expect(acceptedBody.reading.seat).toBe('cursor');
    expect(acceptedBody.reading.received_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });

  test('strict shape and value checks reject without storing', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const cases: Array<{ body: Record<string, unknown>; error: string }> = [
      { body: { ...sixFields(), note: 'hi' }, error: 'unknown_field' },
      { body: sixFields({ seat: 'codex' }), error: 'seat_not_pushable' },
      {
        body: sixFields({ used_percent: 35, remaining_percent: 70 }),
        error: 'percent_mismatch',
      },
      { body: sixFields({ observed_at: future }), error: 'observed_at_in_future' },
      {
        body: sixFields({ used_percent: 101, remaining_percent: -1 }),
        error: 'percent_out_of_range',
      },
    ];
    for (const item of cases) {
      const res = await postReading(item.body, OPERATOR_TOKEN);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toBe(item.error);
    }
    const listed = await getReading();
    const listedBody = (await listed.json()) as { reading: unknown };
    expect(listedBody.reading).toBeNull();
  });

  test('unparseable timestamps are rejected and store nothing', async () => {
    const cases = [
      sixFields({ resets_at: 'not-a-time' }),
      sixFields({ observed_at: 'not-a-time' }),
    ];
    for (const body of cases) {
      const res = await postReading(body, OPERATOR_TOKEN);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toBe('timestamp_unparseable');
      expect(JSON.stringify(payload)).not.toContain('not-a-time');
    }
    const listed = await getReading();
    const listedBody = (await listed.json()) as { reading: unknown };
    expect(listedBody.reading).toBeNull();
    expect(await getLatestSeatUsageReading('cursor')).toBeNull();
  });

  test('GET freshness reports a just-pushed cursor reading', async () => {
    const posted = await postReading(sixFields(), OPERATOR_TOKEN);
    expect(posted.status).toBe(200);
    const listed = await getReading();
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      success: boolean;
      reading: { observed_at: string } | null;
      fresh: boolean;
      age_seconds: number | null;
      max_age_minutes: number;
    };
    expect(body.success).toBe(true);
    expect(body.reading).not.toBeNull();
    expect(body.fresh).toBe(true);
    expect(body.age_seconds).toBeGreaterThanOrEqual(0);
    expect(body.age_seconds).toBeLessThanOrEqual(60);
    expect(body.max_age_minutes).toBe(30);
  });
});
