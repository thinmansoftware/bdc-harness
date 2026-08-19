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

function codebasesResponse(): Response {
  return Response.json([
    { id: 'cb-shopops', name: 'thinmansoftware/shopops' },
    { id: 'cb-harness', name: 'thinmansoftware/bdc-harness' },
  ]);
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

describe('fireTier atomic conversation dispatch', () => {
  test('resolves the project and posts one atomic conversation request', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });

      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-123',
          id: 'parent-db-123',
          dispatched: true,
        });
      }
      return Response.json({
        runs: [
          {
            id: 'run-123',
            workflow_name: 'bdc-feature-development',
            parent_conversation_id: 'parent-db-123',
            codebase_id: 'cb-harness',
          },
        ],
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-001',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-001', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
    });

    expect(result).toEqual({
      ok: true,
      runId: 'run-123',
      conversationId: 'web-parent-123',
      infraError: null,
    });
    expect(fetchCalls.map(call => call.url)).toEqual([
      'http://archon.test/api/codebases',
      'http://archon.test/api/conversations',
      'http://archon.test/api/workflows/runs?codebaseId=cb-harness&limit=50',
    ]);

    const atomicRequest = fetchCalls[1];
    expect(atomicRequest?.init?.method).toBe('POST');
    expect(JSON.parse(String(atomicRequest?.init?.body))).toEqual({
      codebaseId: 'cb-harness',
      message: '/workflow run bdc-feature-development WO_ID=WO-TEST-001 --project bdc-harness',
    });
    expect(headerValue(atomicRequest?.init, 'x-archon-operator-token')).toBe('option-token');
  });

  test('rejects a response that does not prove dispatched true', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      return Response.json({
        conversationId: 'web-parent-123',
        id: 'parent-db-123',
        dispatched: false,
        accepted: false,
        error: 'workflow unavailable',
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-002',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-002', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      discoverIntervalMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.runId).toBeNull();
    expect(result.infraError).toContain('dispatched:true');
    expect(fetchCalls).toHaveLength(2);
  });

  test('fails closed when the requested project has no unique codebase binding', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return codebasesResponse();
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-003',
      project: 'missing-project',
      message: buildFireMessage('WO-TEST-003', 'missing-project'),
      apiBaseUrl: 'http://archon.test',
    });

    expect(result.ok).toBe(false);
    expect(result.infraError).toContain('missing-project');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('http://archon.test/api/codebases');
  });

  test('discovers the run from the returned parent conversation id, not a fabricated worker id', async () => {
    let discoveryCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-456',
          id: 'parent-db-456',
          dispatched: true,
        });
      }
      discoveryCount += 1;
      return Response.json({
        runs:
          discoveryCount === 1
            ? []
            : [
                {
                  id: 'run-456',
                  workflow_name: 'bdc-feature-development-codex',
                  parent_conversation_id: 'parent-db-456',
                  codebase_id: 'cb-harness',
                },
              ],
      });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development-codex',
      woId: 'WO-TEST-004',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-004', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
      discoverTimeoutMs: 100,
      discoverIntervalMs: 0,
    });

    expect(result.runId).toBe('run-456');
    expect(fetchCalls.some(call => call.url.includes('/by-worker/'))).toBe(false);
    expect(
      fetchCalls
        .filter(call => call.url.includes('/api/workflows/runs?'))
        .every(call => headerValue(call.init, 'x-archon-operator-token') === 'option-token')
    ).toBe(true);
  });

  test('uses ARCHON_OPERATOR_TOKEN for every API request', async () => {
    process.env.ARCHON_OPERATOR_TOKEN = 'env-token';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent-env',
          id: 'parent-db-env',
          dispatched: true,
        });
      }
      return Response.json({
        runs: [
          {
            id: 'run-env',
            workflow_name: 'bdc-feature-development',
            parent_conversation_id: 'parent-db-env',
            codebase_id: 'cb-harness',
          },
        ],
      });
    }) as typeof globalThis.fetch;

    await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-TEST-005',
      project: 'bdc-harness',
      message: buildFireMessage('WO-TEST-005', 'bdc-harness'),
      apiBaseUrl: 'http://archon.test',
    });

    expect(
      fetchCalls.every(call => headerValue(call.init, 'x-archon-operator-token') === 'env-token')
    ).toBe(true);
  });
});

describe('fireTier deterministic dispatch-token discovery', () => {
  // Decode the token segment from a by-dispatch-token URL.
  function tokenFromUrl(url: string): string {
    const marker = '/api/workflows/runs/by-dispatch-token/';
    const idx = url.indexOf(marker);
    if (idx < 0) return '';
    return decodeURIComponent(url.slice(idx + marker.length));
  }

  // Test 1: co-fire resolves both runs deterministically.
  test('two cascades fired in the same tick resolve their own distinct runs via tokens', async () => {
    // A fake run-creation backend that records each dispatch_token -> run id.
    // The by-dispatch-token lookup returns strictly the run for the queried
    // token, so a co-fire can never cross-link.
    const runsByToken: Record<string, string> = {
      'cascadeA:attempt:1': 'run-A',
      'cascadeB:attempt:1': 'run-B',
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({
          conversationId: 'web-parent',
          id: 'parent-db',
          dispatched: true,
        });
      }
      if (url.includes('/api/workflows/runs/by-dispatch-token/')) {
        const token = tokenFromUrl(url);
        const runId = runsByToken[token];
        if (!runId) return new Response(null, { status: 404 });
        return Response.json({ run: { id: runId } });
      }
      throw new Error(`unexpected scan fallback for url ${url}`);
    }) as typeof globalThis.fetch;

    const [resultA, resultB] = await Promise.all([
      fireTier({
        workflowName: 'bdc-feature-development',
        woId: 'WO-COFIRE-A',
        project: 'bdc-harness',
        message: buildFireMessage('WO-COFIRE-A', 'bdc-harness', undefined, 'cascadeA:attempt:1'),
        apiBaseUrl: 'http://archon.test',
        token: 'option-token',
        dispatchToken: 'cascadeA:attempt:1',
        discoverBackoffBaseMs: 0,
      }),
      fireTier({
        workflowName: 'bdc-feature-development',
        woId: 'WO-COFIRE-B',
        project: 'bdc-harness',
        message: buildFireMessage('WO-COFIRE-B', 'bdc-harness', undefined, 'cascadeB:attempt:1'),
        apiBaseUrl: 'http://archon.test',
        token: 'option-token',
        dispatchToken: 'cascadeB:attempt:1',
        discoverBackoffBaseMs: 0,
      }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultA.runId).toBe('run-A');
    expect(resultB.ok).toBe(true);
    expect(resultB.runId).toBe('run-B');
    // No cross-linkage, no null.
    expect(resultA.runId).not.toBe(resultB.runId);
    // The token flag rode through the fire message to the server.
    const firePosts = fetchCalls.filter(call => call.url.endsWith('/api/conversations'));
    expect(firePosts).toHaveLength(2);
    const messages = firePosts.map(call => JSON.parse(String(call.init?.body)).message as string);
    expect(messages.some(m => m.includes('--dispatch-token cascadeA:attempt:1'))).toBe(true);
    expect(messages.some(m => m.includes('--dispatch-token cascadeB:attempt:1'))).toBe(true);
    // Discovery used the direct token endpoint, never the legacy scan.
    expect(fetchCalls.some(call => call.url.includes('/api/workflows/runs?'))).toBe(false);
  });

  // Test 2 (variant a): the run appears on a later retry.
  test('token lookup retries with backoff and resolves once the run appears', async () => {
    let tokenLookups = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({ conversationId: 'web-p', id: 'parent-db', dispatched: true });
      }
      if (url.includes('/api/workflows/runs/by-dispatch-token/')) {
        tokenLookups += 1;
        // Run row not persisted until the third lookup (simulated delay).
        if (tokenLookups < 3) return new Response(null, { status: 404 });
        return Response.json({ run: { id: 'run-delayed' } });
      }
      throw new Error(`unexpected scan fallback for url ${url}`);
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-RETRY-01',
      project: 'bdc-harness',
      message: buildFireMessage('WO-RETRY-01', 'bdc-harness', undefined, 'tok:retry:1'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
      dispatchToken: 'tok:retry:1',
      discoverMaxAttempts: 5,
      discoverBackoffBaseMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.runId).toBe('run-delayed');
    expect(tokenLookups).toBe(3);
  });

  // Test 2 (variant b): the run never appears -> enriched, honest failure.
  test('exhausted token lookup fails with token, attempts, and last query -- not a bare timeout', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json({ conversationId: 'web-p', id: 'parent-db', dispatched: true });
      }
      if (url.includes('/api/workflows/runs/by-dispatch-token/')) {
        return new Response(null, { status: 404 });
      }
      // Deprecated one-shot scan fallback also finds nothing.
      return Response.json({ runs: [] });
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'bdc-feature-development',
      woId: 'WO-EXHAUST-01',
      project: 'bdc-harness',
      message: buildFireMessage('WO-EXHAUST-01', 'bdc-harness', undefined, 'tok:exhaust:1'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
      dispatchToken: 'tok:exhaust:1',
      discoverMaxAttempts: 5,
      discoverBackoffBaseMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.runId).toBeNull();
    const infra = result.infraError ?? '';
    expect(infra).toContain('tok:exhaust:1'); // token
    expect(infra).toContain('attempts=5'); // attempt count
    expect(infra).toContain('/api/workflows/runs/by-dispatch-token/'); // last query
    // The bare timeout string must never be the terminal message again.
    expect(infra).not.toContain('run discovery timeout after 30000ms');
    // Token lookup was tried 5 times, then exactly one legacy scan fallback pass.
    const tokenCalls = fetchCalls.filter(call =>
      call.url.includes('/api/workflows/runs/by-dispatch-token/')
    );
    const scanCalls = fetchCalls.filter(call => call.url.includes('/api/workflows/runs?'));
    expect(tokenCalls).toHaveLength(5);
    expect(scanCalls).toHaveLength(1);
  });

  // Test 3 (fire-side half): given the server's unknown-workflow response
  // (accepted:false, dispatched:false, 400), fireTier surfaces a loud infra
  // failure and never fabricates success or attempts discovery. The SERVER half
  // of this contract -- that POST /api/conversations actually returns that error
  // for a nonexistent lane (never dispatched:true) -- is proven against the real
  // route in packages/server/src/routes/api.conversations.test.ts
  // ('unknown workflow carrying a --dispatch-token still fails loudly'). Together
  // they close task_ac4d1148 end to end without either half mocking the other's job.
  test('unknown workflow dispatch fails loudly (no dispatched:true, runId null)', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases')) return codebasesResponse();
      if (url.endsWith('/api/conversations')) {
        return Response.json(
          { accepted: false, dispatched: false, error: "Unknown workflow 'does-not-exist'" },
          { status: 400 }
        );
      }
      throw new Error(`no discovery should occur for url ${url}`);
    }) as typeof globalThis.fetch;

    const result = await fireTier({
      workflowName: 'does-not-exist',
      woId: 'WO-UNKNOWN-01',
      project: 'bdc-harness',
      message: buildFireMessage('WO-UNKNOWN-01', 'bdc-harness', undefined, 'tok:unknown:1'),
      apiBaseUrl: 'http://archon.test',
      token: 'option-token',
      dispatchToken: 'tok:unknown:1',
    });

    expect(result.ok).toBe(false);
    expect(result.runId).toBeNull();
    expect(result.infraError).toContain('400');
    // No discovery attempt was made -- dispatch never proved success.
    expect(fetchCalls.some(call => call.url.includes('by-dispatch-token'))).toBe(false);
  });
});

describe('buildFireMessage project binding', () => {
  test('starts with WO assignment and explicit project flag', () => {
    expect(buildFireMessage('WO-TEST-006', 'shopops')).toStartWith(
      'WO_ID=WO-TEST-006 --project shopops'
    );
  });

  test('preserves project flag when prior-attempt context is appended', () => {
    const message = buildFireMessage('WO-TEST-007', 'shopops', 'Prior tier failed validation.');

    expect(message).toStartWith('WO_ID=WO-TEST-007 --project shopops');
    expect(message).toContain('## Prior attempt context');
    expect(message).toContain('Prior tier failed validation.');
  });

  test('appends the dispatch token as a flag after the project, preserving the prefix', () => {
    const message = buildFireMessage('WO-TEST-008', 'shopops', undefined, 'cascade-x:attempt:2');

    expect(message).toStartWith('WO_ID=WO-TEST-008 --project shopops');
    expect(message).toContain('--dispatch-token cascade-x:attempt:2');
  });

  test('keeps both the dispatch token and prior-attempt context', () => {
    const message = buildFireMessage(
      'WO-TEST-009',
      'shopops',
      'Prior tier failed validation.',
      'cascade-y:attempt:3'
    );

    expect(message).toStartWith(
      'WO_ID=WO-TEST-009 --project shopops --dispatch-token cascade-y:attempt:3'
    );
    expect(message).toContain('## Prior attempt context');
    expect(message).toContain('Prior tier failed validation.');
  });
});
