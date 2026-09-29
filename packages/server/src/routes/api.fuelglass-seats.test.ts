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
  clearOperatorSetting as realClearOperatorSetting,
  getOperatorSetting as realGetOperatorSetting,
  setOperatorSetting as realSetOperatorSetting,
} from '@archon/core/db/operator-settings';

const realOperatorSettings = {
  getOperatorSetting: realGetOperatorSetting,
  setOperatorSetting: realSetOperatorSetting,
  clearOperatorSetting: realClearOperatorSetting,
};

// This file's tests keep the cutoff in memory. Stop 1 also loads the real
// operator-settings tests in this process, so the mock delegates to the
// snapshotted module unless memory mode is on.
let operatorSettingsMemory = false;
let operatorSettingsWriteFails = false;
let operatorSettingsSetCalls = 0;
let operatorSettingStore: {
  setting_value: string;
  updated_at: string;
  updated_by: string;
  reason: string | null;
} | null = null;

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

mock.module('@archon/core/db/operator-settings', () => ({
  getOperatorSetting: async (key: string) => {
    if (!operatorSettingsMemory) return realOperatorSettings.getOperatorSetting(key);
    if (!operatorSettingStore) return null;
    return {
      setting_key: key,
      setting_value: operatorSettingStore.setting_value,
      updated_at: operatorSettingStore.updated_at,
      updated_by: operatorSettingStore.updated_by,
      reason: operatorSettingStore.reason,
    };
  },
  setOperatorSetting: async (
    key: string,
    value: string,
    updatedBy: string,
    reason: string | null
  ) => {
    if (!operatorSettingsMemory) {
      await realOperatorSettings.setOperatorSetting(key, value, updatedBy, reason);
      return;
    }
    if (operatorSettingsWriteFails) throw new Error('db write failed');
    operatorSettingsSetCalls += 1;
    operatorSettingStore = {
      setting_value: value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
      reason,
    };
  },
  clearOperatorSetting: async (key: string) => {
    if (!operatorSettingsMemory) {
      await realOperatorSettings.clearOperatorSetting(key);
      return;
    }
    if (operatorSettingsWriteFails) throw new Error('db write failed');
    operatorSettingStore = null;
  },
}));

import {
  getSeatCutoff,
  resetSeatUsageCacheForTests,
  setSeatUsageReaderForTests,
  type SeatReading,
} from '@archon/workflows/reliability/seat-usage';
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
    operatorSettingsMemory = true;
    operatorSettingsWriteFails = false;
    operatorSettingsSetCalls = 0;
    operatorSettingStore = null;
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
    operatorSettingsMemory = false;
    operatorSettingsWriteFails = false;
    operatorSettingStore = null;
    resetSeatUsageCacheForTests();
    delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  });

  function postCutoff(percent: unknown): Promise<Response> {
    return Promise.resolve(
      app.request('/api/fuelglass/cutoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent }),
      })
    );
  }

  test('default cutoff is 90 with no env and no override', async () => {
    const res = await app.request('/api/fuelglass/seats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gate_enabled: boolean;
      cutoff: { percent: number; source: string };
    };
    expect(body.cutoff).toEqual({ percent: 90, source: 'default' });
    expect(body.gate_enabled).toBe(true);
  });

  test('invalid env cutoff falls back to 90', async () => {
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '100';
    const res = await app.request('/api/fuelglass/seats');
    const body = (await res.json()) as { cutoff: { percent: number; source: string } };
    expect(body.cutoff).toEqual({ percent: 90, source: 'default' });
  });

  test('cutoff override above 95 or below 1 is a named 400', async () => {
    for (const bad of [96, 100, 150, 0]) {
      const res = await postCutoff(bad);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string };
      expect(err.error).toContain('seat_cutoff_out_of_range');
    }
    const after = (await (await app.request('/api/fuelglass/seats')).json()) as {
      cutoff: { percent: number; source: string; set_at?: string; set_by?: string };
    };
    expect(after.cutoff).toEqual({ percent: 90, source: 'default' });
    expect(after.cutoff).not.toHaveProperty('set_at');
    expect(after.cutoff).not.toHaveProperty('set_by');
    expect(operatorSettingsSetCalls).toBe(0);
    const notNumber = await postCutoff('x');
    expect(notNumber.status).toBe(400);
    expect(operatorSettingsSetCalls).toBe(0);
    const ok = await postCutoff(95);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { cutoff: { percent: number; source: string } };
    expect(okBody.cutoff).toEqual({ percent: 95, source: 'operator' });
  });

  test('api_seats_and_cutoff_routes', async () => {
    const first = await app.request('/api/fuelglass/seats');
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      gate_enabled: boolean;
      seats: Record<string, { seven_day: { used_percent?: number } | string }>;
    };
    expect(body.gate_enabled).toBe(true);
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
    const after = (await second.json()) as {
      gate_enabled: boolean;
      cutoff: { percent: number; source: string; set_at?: string; set_by?: string };
    };
    expect(after.cutoff.percent).toBe(90);
    expect(after.cutoff.source).toBe('operator');
    expect(after.cutoff.set_by).toBe('operator-token');
    expect(after.cutoff.set_at).toBeString();
    expect(new Date(after.cutoff.set_at ?? '').toISOString()).toBe(after.cutoff.set_at);
    expect(after.gate_enabled).toBe(true);

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
    const clearedBody = (await cleared.json()) as { cutoff: { percent: number; source: string } };
    expect(clearedBody.cutoff).toEqual({ percent: 90, source: 'default' });
  });

  test('failed write does not arm the override', async () => {
    const before = getSeatCutoff();
    operatorSettingsWriteFails = true;
    const res = await postCutoff(95);
    expect(res.status).toBe(500);
    expect(getSeatCutoff()).toEqual(before);
    expect(operatorSettingStore).toBeNull();
  });

  test('seats response shows provenance for an operator cutoff', async () => {
    const bare = await app.request('/api/fuelglass/seats');
    const bareBody = (await bare.json()) as {
      cutoff: { set_at?: string; set_by?: string };
    };
    expect(bareBody.cutoff).not.toHaveProperty('set_at');
    expect(bareBody.cutoff).not.toHaveProperty('set_by');

    const setCutoff = await app.request('/api/fuelglass/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent: 95, reason: 'quota fix' }),
    });
    expect(setCutoff.status).toBe(200);
    const posted = (await setCutoff.json()) as { cutoff: { percent: number; source: string } };
    expect(posted.cutoff).toEqual({ percent: 95, source: 'operator' });

    const seats = await app.request('/api/fuelglass/seats');
    const body = (await seats.json()) as {
      cutoff: { percent: number; source: string; set_at?: string; set_by?: string };
    };
    expect(body.cutoff.source).toBe('operator');
    expect(body.cutoff.percent).toBe(95);
    expect(body.cutoff.set_by).toBe('operator-token');
    expect(body.cutoff.set_at).toBeString();
    expect(new Date(body.cutoff.set_at ?? '').toISOString()).toBe(body.cutoff.set_at);
  });
});
