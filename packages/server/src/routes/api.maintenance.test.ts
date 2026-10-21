import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';

import { registerApiRoutes } from './api';

const report = { removed: ['old'], skipped: [], errors: [], sessionsDeleted: 2 };
const originalEnv = {
  token: process.env.ARCHON_OPERATOR_TOKEN,
  disabled: process.env.ARCHON_OPERATOR_AUTH_DISABLED,
  nodeEnv: process.env.NODE_ENV,
};

function makeApp(runner: Parameters<typeof registerApiRoutes>[6]): OpenAPIHono {
  const app = new OpenAPIHono();
  registerApiRoutes(
    app,
    {} as WebAdapter,
    {} as ConversationLockManager,
    undefined,
    undefined,
    undefined,
    runner
  );
  return app;
}

describe('POST /api/maintenance/cleanup', () => {
  beforeEach(() => {
    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret';
    delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (originalEnv.token === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
    else process.env.ARCHON_OPERATOR_TOKEN = originalEnv.token;
    if (originalEnv.disabled === undefined) delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
    else process.env.ARCHON_OPERATOR_AUTH_DISABLED = originalEnv.disabled;
    if (originalEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv.nodeEnv;
  });

  test('rejects a request without the operator token before cleanup runs', async () => {
    const runner = mock(async () => ({ started: true as const, report }));
    const response = await makeApp(runner).request('/api/maintenance/cleanup', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Missing or invalid operator token' });
    expect(runner).not.toHaveBeenCalled();
  });

  test('runs manual cleanup and returns the report shape', async () => {
    const runner = mock(async () => ({ started: true as const, report }));
    const response = await makeApp(runner).request('/api/maintenance/cleanup', {
      method: 'POST',
      headers: { 'x-archon-operator-token': 'operator-secret' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(runner).toHaveBeenCalledWith({ source: 'manual' });
  });

  test('returns 409 when another cleanup owns the atomic cleanup lock', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const runner = mock(async () => {
      calls += 1;
      if (calls !== 1) return { started: false as const, reason: 'in_flight' as const };
      await firstMayFinish;
      return { started: true as const, report };
    });
    const app = makeApp(runner);
    const headers = { 'x-archon-operator-token': 'operator-secret' };
    const firstPending = app.request('/api/maintenance/cleanup', { method: 'POST', headers });
    while (runner.mock.calls.length === 0) await Promise.resolve();
    const second = await app.request('/api/maintenance/cleanup', { method: 'POST', headers });
    releaseFirst();
    const first = await firstPending;

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'Cleanup already in progress' });
  });
});
