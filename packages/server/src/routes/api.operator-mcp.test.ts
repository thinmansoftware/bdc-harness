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

  test('requires an allowlisted principal and non-empty reason', () => {
    process.env.ARCHON_OPERATOR_FIRE_APPROVERS = 'john, alice';
    expect(isValidFireApproval('John', 'Approved for WO-1')).toBe(true);
    expect(isValidFireApproval('mallory', 'Approved')).toBe(false);
    expect(isValidFireApproval('john', '  ')).toBe(false);
    expect(isValidFireApproval(undefined, undefined)).toBe(false);
  });
});
