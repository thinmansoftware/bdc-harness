import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  isValidFireApproval,
  registerApiRoutes,
  requireScopeForPath,
  resolveScopeForToken,
} from './api';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('operator MCP authorization', () => {
  test('resolves separate tokens while retaining the legacy master', () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'master';
    process.env.ARCHON_OPERATOR_TOKEN_INSPECT = 'inspect';
    process.env.ARCHON_OPERATOR_TOKEN_MESSAGE = 'message';
    process.env.ARCHON_OPERATOR_TOKEN_FIRE = 'fire';
    expect(resolveScopeForToken('master')).toBe('master');
    expect(resolveScopeForToken('inspect')).toBe('inspect');
    expect(resolveScopeForToken('message')).toBe('message');
    expect(resolveScopeForToken('fire')).toBe('fire');
    expect(resolveScopeForToken('wrong')).toBeNull();
  });

  test('classifies mounted REST routes by authority', () => {
    expect(requireScopeForPath('/api/workflows/major-build/run', 'POST')).toBe('fire');
    expect(requireScopeForPath('/api/workflows/runs/r-1', 'GET')).toBe('inspect');
    expect(requireScopeForPath('/api/dispatch/messages/m-1/claim', 'POST')).toBe('message');
    expect(requireScopeForPath('/api/health', 'GET')).toBeNull();
    expect(requireScopeForPath('/api/config', 'POST')).toBeNull();
  });

  test('documents forbidden responses on every scoped OpenAPI route', () => {
    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as never, {} as never);
    const document = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
    });
    const scopedOperations = [
      ['post', '/api/workflows/{name}/run'],
      ['get', '/api/dashboard/runs'],
      ['get', '/api/workflows/runs/{runId}'],
      ['get', '/api/workflows/runs/{runId}/nodes/{nodeId}/events'],
      ['post', '/api/dispatch/messages'],
      ['get', '/api/dispatch/messages'],
      ['post', '/api/dispatch/messages/{id}/claim'],
      ['post', '/api/dispatch/messages/{id}/result'],
      ['post', '/api/dispatch/messages/{id}/ack'],
      ['post', '/api/dispatch/messages/{id}/address'],
      ['post', '/api/dispatch/messages/{id}/renew-lease'],
      ['post', '/api/dispatch/messages/{id}/cancel'],
      ['post', '/api/dispatch/messages/{id}/supersede'],
    ] as const;

    for (const [method, path] of scopedOperations) {
      expect(document.paths?.[path]?.[method]?.responses?.['403']).toBeDefined();
    }
  });

  test('middleware rejects an inspect token on the fire route before dispatch', async () => {
    process.env.ARCHON_OPERATOR_TOKEN_INSPECT = 'inspect-only';
    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as never, {} as never);
    const response = await app.request('/api/workflows/major-build/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-archon-operator-token': 'inspect-only',
      },
      body: JSON.stringify({ conversationId: 'c-1', message: 'must not dispatch' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Operator token requires fire scope' });
  });

  test('middleware rejects a fire token on a message route before claiming', async () => {
    process.env.ARCHON_OPERATOR_TOKEN_FIRE = 'fire-only';
    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as never, {} as never);
    const response = await app.request('/api/dispatch/messages/m-1/claim', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-archon-operator-token': 'fire-only',
      },
      body: JSON.stringify({ worker_id: 'w-1' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Operator token requires message scope' });
  });

  test('middleware rejects a message token on an inspect route before lookup', async () => {
    process.env.ARCHON_OPERATOR_TOKEN_MESSAGE = 'message-only';
    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as never, {} as never);
    const response = await app.request('/api/workflows/runs/r-1', {
      headers: { 'x-archon-operator-token': 'message-only' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Operator token requires inspect scope' });
  });

  test('requires an allowlisted principal and non-empty reason', () => {
    process.env.ARCHON_OPERATOR_FIRE_APPROVERS = 'john, alice';
    expect(isValidFireApproval('John', 'Approved for WO-1')).toBe(true);
    expect(isValidFireApproval('mallory', 'Approved')).toBe(false);
    expect(isValidFireApproval('john', '  ')).toBe(false);
    expect(isValidFireApproval(undefined, undefined)).toBe(false);
  });
});
