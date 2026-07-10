import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildFireMessage, fireTier } from '../fire.js';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

let originalFetch: typeof globalThis.fetch;
let originalToken: string | undefined;
let fetchCalls: FetchCall[];

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalToken = process.env.ARCHON_OPERATOR_TOKEN;
  delete process.env.ARCHON_OPERATOR_TOKEN;
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  } else {
    process.env.ARCHON_OPERATOR_TOKEN = originalToken;
  }
});

describe('fireTier auth headers', () => {
  test('sends x-archon-operator-token on fire POST and discovery GET from option', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });

      if (url.includes('/api/workflows/runs/by-worker/')) {
        return Response.json({ run: { id: 'run-123' } });
      }

      return Response.json({ accepted: true, status: 'queued' });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-001',
      message: buildFireMessage('WO-TEST-001', 'shopops'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
    });

    expect(result.ok).toBe(true);
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[0]?.url).toContain('/api/workflows/bdc-feature-development/run');
    expect(fetchCalls[1]?.url).toContain('/api/workflows/runs/by-worker/');
    expect(headerValue(fetchCalls[0]?.init, 'x-archon-operator-token')).toBe('option-token');
    expect(headerValue(fetchCalls[1]?.init, 'x-archon-operator-token')).toBe('option-token');
  });

  test('uses ARCHON_OPERATOR_TOKEN env fallback for fire and discovery headers', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'env-token';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });

      if (url.includes('/api/workflows/runs/by-worker/')) {
        return Response.json({ run: { id: 'run-env' } });
      }

      return Response.json({ accepted: true, status: 'queued' });
    }) as typeof globalThis.fetch;

    await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-002',
      message: buildFireMessage('WO-TEST-002', 'harness'),
      apiBaseUrl: 'http://archon.test',
    });

    expect(headerValue(fetchCalls[0]?.init, 'x-archon-operator-token')).toBe('env-token');
    expect(headerValue(fetchCalls[1]?.init, 'x-archon-operator-token')).toBe('env-token');
  });
});

describe('buildFireMessage project binding', () => {
  test('starts with WO id and explicit project flag', () => {
    expect(buildFireMessage('WO-TEST-003', 'shopops')).toStartWith('WO-TEST-003 --project shopops');
  });

  test('preserves project flag when prior-attempt context is appended', () => {
    const message = buildFireMessage('WO-TEST-004', 'shopops', 'Prior tier failed validation.');

    expect(message).toStartWith('WO-TEST-004 --project shopops');
    expect(message).toContain('## Prior attempt context');
    expect(message).toContain('Prior tier failed validation.');
  });
});
