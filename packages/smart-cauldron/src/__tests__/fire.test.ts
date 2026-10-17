import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildFireMessage, fireTier, preflightCodexOnly } from '../fire.js';
import { readFile } from 'fs/promises';
import { parse } from 'yaml';

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

describe('buildFireMessage project binding', () => {
  test('keeps the expected spec identity on the command header before untrusted prior context', () => {
    const identity = {
      specSource: 'github:org/repo:docs/WO-TEST-01.md',
      specRevision: 'a'.repeat(40),
      specHash: `sha256:${'b'.repeat(64)}`,
    };
    const message = buildFireMessage(
      'WO-TEST-01',
      'bdc-harness',
      '--expected-spec=forged',
      identity
    );
    const header = message.split('\n')[0];
    const encoded = header.split(' --expected-spec=')[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual(identity);
    expect(message).toEndWith('## Prior attempt context\n--expected-spec=forged');
  });
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
});

describe('Codex-only pre-admission provider proof', () => {
  function workflowResponse(provider = 'codex', failover?: string): Response {
    return Response.json({
      workflow: {
        name: 'bdc-feature-development-codex-only',
        description: 'Harmless test workflow',
        provider,
        nodes: [
          {
            id: 'implement',
            prompt: 'Implement the accepted work order',
            ...(failover ? { failover_provider: failover } : {}),
          },
        ],
      },
      filename: 'bdc-feature-development-codex-only.yaml',
      source: 'bundled',
    });
  }

  function stub(workflow: () => Response, codebases?: unknown): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/api/codebases'))
        return Response.json(
          codebases ?? [
            { id: 'other', name: 'shopops', default_cwd: '/wrong' },
            {
              id: 'target',
              name: 'thinmansoftware/bdc-harness',
              default_cwd: '/work/harness space',
            },
          ]
        );
      return workflow();
    }) as typeof globalThis.fetch;
  }

  test('binds the unique target cwd and authenticates both reads without dispatch', async () => {
    stub(() => workflowResponse());
    await preflightCodexOnly('BDC-HARNESS', 'http://archon.test', 'private-token');
    expect(fetchCalls.map(call => call.url)).toEqual([
      'http://archon.test/api/codebases',
      'http://archon.test/api/workflows/bdc-feature-development-codex-only?cwd=%2Fwork%2Fharness%20space',
    ]);
    expect(
      fetchCalls.every(
        call => headerValue(call.init, 'x-archon-operator-token') === 'private-token'
      )
    ).toBe(true);
    expect(fetchCalls.every(call => call.init?.signal === fetchCalls[0]?.init?.signal)).toBe(true);
  });

  for (const [name, codebases, error] of [
    ['missing', [], 'codex_only_project_unresolved'],
    [
      'ambiguous',
      [
        { id: '1', name: 'bdc-harness' },
        { id: '2', name: 'org/bdc-harness' },
      ],
      'codex_only_project_unresolved',
    ],
    [
      'relative cwd',
      [{ id: '1', name: 'bdc-harness', default_cwd: 'relative' }],
      'codex_only_invalid_cwd',
    ],
    ['missing cwd', [{ id: '1', name: 'bdc-harness' }], 'codex_only_invalid_cwd'],
  ] as const) {
    test(`refuses ${name} before workflow lookup`, async () => {
      stub(() => workflowResponse(), codebases);
      await expect(
        preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')
      ).rejects.toThrow(error);
      expect(fetchCalls).toHaveLength(1);
    });
  }

  for (const [provider, failover] of [
    ['claude', undefined],
    ['openai', undefined],
    ['codex', 'claude'],
  ]) {
    test(`rejects primary ${provider} / availability and quota failover ${failover}`, async () => {
      stub(() => workflowResponse(provider, failover));
      await expect(
        preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')
      ).rejects.toThrow('codex_only_provider_forbidden');
      expect(fetchCalls).toHaveLength(2);
    });
  }

  test('same-provider failover remains bounded', async () => {
    stub(() => workflowResponse('codex', 'codex'));
    await preflightCodexOnly('bdc-harness', 'http://archon.test', 'token');
  });

  test('actual current Codex-only definition passes engine payload validation', async () => {
    const workflow = parse(
      await readFile(
        new URL(
          '../../../../.archon/workflows/defaults/bdc-feature-development-codex-only.yaml',
          import.meta.url
        ),
        'utf8'
      )
    );
    stub(() =>
      Response.json({
        workflow,
        filename: 'bdc-feature-development-codex-only.yaml',
        source: 'bundled',
      })
    );
    await preflightCodexOnly('bdc-harness', 'http://archon.test', 'token');
    expect(fetchCalls).toHaveLength(2);
  });

  for (const node of [
    { id: 'build', loop: {} },
    { id: 'build', command: 42 },
    { id: 'build', bash: null },
    { id: 'build', evidence: {} },
    { id: 'build', script: 'code' },
  ]) {
    test('rejects malformed engine node payloads', async () => {
      stub(() =>
        Response.json({
          workflow: {
            name: 'bdc-feature-development-codex-only',
            description: 'Test',
            provider: 'codex',
            nodes: [node],
          },
          filename: 'bdc-feature-development-codex-only.yaml',
          source: 'bundled',
        })
      );
      await expect(
        preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')
      ).rejects.toThrow('codex_only_workflow_invalid');
    });
  }

  test('source must be a supported string without coercion', async () => {
    stub(() =>
      Response.json({
        workflow: {
          name: 'bdc-feature-development-codex-only',
          provider: 'codex',
          description: 'Test',
          nodes: [{ id: 'build', prompt: 'Build' }],
        },
        filename: 'bdc-feature-development-codex-only.yaml',
        source: ['bundled'],
      })
    );
    await expect(preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')).rejects.toThrow(
      'codex_only_workflow_invalid'
    );
  });

  test('network and invalid JSON errors retain only their classifications', async () => {
    globalThis.fetch = (async () => {
      throw new Error('secret-token upstream detail');
    }) as typeof fetch;
    await expect(preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')).rejects.toThrow(
      'codex_only_preflight_network'
    );
    globalThis.fetch = (async () => new Response('secret-token invalid-json')) as typeof fetch;
    await expect(preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')).rejects.toThrow(
      'codex_only_preflight_json'
    );
  });

  for (const response of [
    () => Response.json({}),
    () =>
      Response.json({
        workflow: { name: 'wrong', provider: 'codex', nodes: [] },
        filename: 'wrong.yaml',
        source: 'bundled',
      }),
  ]) {
    test('malformed workflow cannot silently fall back', async () => {
      stub(response);
      await expect(
        preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')
      ).rejects.toThrow('codex_only_workflow_invalid');
    });
  }

  test('HTTP error bodies never enter classified errors and are not retried', async () => {
    stub(() => new Response('private-token provider detail', { status: 403 }));
    await expect(preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')).rejects.toThrow(
      'codex_only_preflight_http'
    );
    expect(fetchCalls).toHaveLength(2);
  });

  for (const body of [
    { provider: 'codex', failover_provider: 'claude', nodes: [{ id: 'build', prompt: 'Build' }] },
    { provider: 'codex', nodes: [{ id: 'build', loop: {}, provider: 'claude' }] },
    { nodes: [{ id: 'build', prompt: 'Build', provider: 'codex' }] },
    { provider: 'codex', nodes: [{ id: 'build', prompt: 'Build', provider: null }] },
  ]) {
    test('rejects inherited, loop, workflow failover and malformed provider bindings', async () => {
      stub(() =>
        Response.json({
          workflow: {
            name: 'bdc-feature-development-codex-only',
            description: 'Harmless test workflow',
            ...body,
          },
          filename: 'bdc-feature-development-codex-only.yaml',
          source: 'project',
        })
      );
      await expect(
        preflightCodexOnly('bdc-harness', 'http://archon.test', 'token')
      ).rejects.toThrow('codex_only_provider_forbidden');
    });
  }

  for (const stage of ['headers', 'body', 'second-read'] as const) {
    test(`one shared 10000ms deadline aborts hanging ${stage} without retry`, async () => {
      const savedSet = globalThis.setTimeout;
      const savedClear = globalThis.clearTimeout;
      let expire: (() => void) | undefined;
      let timers = 0;
      let cleared = false;
      globalThis.setTimeout = ((callback: () => void, ms: number) => {
        if (ms !== 10_000) return savedSet(callback, ms);
        timers++;
        expire = callback;
        return savedSet(callback, 1);
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
        cleared = true;
        savedClear(id);
      }) as typeof clearTimeout;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        const hanging = new Promise<Response>(resolve => {
          // Abort-aware transport; deadline also protects body promises that ignore abort.
          init?.signal?.addEventListener('abort', () => resolve(new Response('', { status: 499 })));
        });
        if (stage === 'headers') return hanging;
        if (String(input).endsWith('/api/codebases') && stage === 'second-read')
          return Response.json([{ id: 'target', name: 'bdc-harness', default_cwd: '/target' }]);
        if (stage === 'second-read') return hanging;
        return { ok: true, json: () => new Promise(() => {}) } as Response;
      }) as typeof fetch;
      try {
        const pending = preflightCodexOnly('bdc-harness', 'http://archon.test', 'token');
        // Let the first response and project resolver settle before expiring the same timer.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        const assertion = expect(pending).rejects.toThrow('codex_only_preflight_timeout');
        // The bounded fake timer expires on the next real event-loop turn.
        await assertion;
        expect(timers).toBe(1);
        expect(fetchCalls).toHaveLength(stage === 'second-read' ? 2 : 1);
        expect(fetchCalls.every(call => call.init?.signal?.aborted)).toBe(true);
        expect(cleared).toBe(true);
      } finally {
        globalThis.setTimeout = savedSet;
        globalThis.clearTimeout = savedClear;
      }
    });
  }
});
