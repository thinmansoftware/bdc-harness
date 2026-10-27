import { describe, expect, test } from 'bun:test';
import type { MessageChunk, SendQueryOptions } from '../../types';
import { CursorCloudAgentClient } from './cloud-agent-client';
import {
  cursorCloudAgentId,
  CursorCloudAgentProvider,
  setCursorCloudRunMetadataRecorder,
  type CursorCloudAgentMetadata,
  type CursorCloudCommandResult,
  type CursorCloudCommandRunner,
} from './cloud-provider';
import { CursorAgentProvider, type CursorAgentChild, type CursorAgentSpawn } from './provider';

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const WO_ID = 'WO-TEST-01';
const API_KEY = 'cursor-test-key-SECRET';
const AGENT_URL = 'https://cursor.com/agents/bc-test';
const PRE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ONE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TWO = 'cccccccccccccccccccccccccccccccccccccccc';
const DIVERGED = 'dddddddddddddddddddddddddddddddddddddddd';
const CREATED_AT = '2026-10-27T09:00:00.000Z';

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

interface HarnessOptions {
  transport?: string;
  terminal?: 'FINISHED' | 'ERROR' | 'EXPIRED';
  stayRunning?: boolean;
  conflict?: boolean;
  gitMode?: 'ok' | 'diverged' | 'missing' | 'detached';
  markerAlready?: boolean;
  issueCount?: number;
  cli?: CursorAgentProvider;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  apiKey?: string;
}

function ok(stdout: string): CursorCloudCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string): CursorCloudCommandResult {
  return { code: 128, stdout: '', stderr };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function streamJson(events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

function fakeChild(stdout: string): CursorAgentChild {
  return {
    stdin: {
      write: (): number => 0,
      end: (): void => undefined,
    },
    stdout: new Response(stdout).body,
    stderr: new Response('').body,
    exited: Promise.resolve(0),
    kill: (): void => undefined,
  };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(chunk => (chunk.type === 'assistant' ? [chunk.content] : [])).join('\n');
}

function makeHarness(options: HarnessOptions = {}): {
  provider: CursorCloudAgentProvider;
  requests: RecordedRequest[];
  gitArgv: string[][];
  comments: string[];
  recorded: CursorCloudAgentMetadata[];
  head: () => string;
} {
  const requests: RecordedRequest[] = [];
  const gitArgv: string[][] = [];
  const comments: string[] = [];
  const recorded: CursorCloudAgentMetadata[] = [];
  const gets = new Map<string, number>();
  let cancelled = false;
  let head = PRE;
  let originStep = 0;
  const apiKey = options.apiKey === undefined ? API_KEY : options.apiKey;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ method, url, body });
    if (apiKey) {
      expect(url).not.toContain(apiKey);
      expect(body).not.toContain(apiKey);
    }
    expect(method).not.toBe('DELETE');
    const path = new URL(url).pathname;
    if (method === 'POST' && path === '/v1/agents') {
      if (options.conflict) return new Response('', { status: 409 });
      return jsonResponse(200, {
        id: 'bc-test',
        url: AGENT_URL,
        createdAt: CREATED_AT,
        latestRunId: 'run-1',
        status: 'ACTIVE',
      });
    }
    if (method === 'GET' && path.startsWith('/v1/agents/') && !path.includes('/runs')) {
      const id = decodeURIComponent(path.slice('/v1/agents/'.length));
      return jsonResponse(200, {
        id,
        url: `https://cursor.com/agents/${id}`,
        createdAt: CREATED_AT,
        latestRunId: 'run-existing',
        status: 'IDLE',
      });
    }
    if (method === 'POST' && path.endsWith('/runs')) {
      return jsonResponse(200, {
        id: 'run-2',
        agentId: 'bc-test',
        status: 'RUNNING',
        updatedAt: '2026-10-27T09:01:00.000Z',
      });
    }
    if (method === 'POST' && path.endsWith('/cancel')) {
      cancelled = true;
      return jsonResponse(200, {});
    }
    if (method === 'GET' && path.includes('/runs/')) {
      const runId = decodeURIComponent(path.split('/runs/')[1] ?? 'run');
      const agentId = decodeURIComponent(path.split('/')[3] ?? 'bc-test');
      if (cancelled) {
        return jsonResponse(200, {
          id: runId,
          agentId,
          status: 'CANCELLED',
          updatedAt: '2026-10-27T09:05:00.000Z',
        });
      }
      const seen = gets.get(runId) ?? 0;
      gets.set(runId, seen + 1);
      if (options.stayRunning) {
        return jsonResponse(200, {
          id: runId,
          agentId,
          status: 'RUNNING',
          updatedAt: '2026-10-27T09:01:00.000Z',
        });
      }
      const terminal = options.terminal ?? 'FINISHED';
      const status = seen === 0 && terminal === 'FINISHED' ? 'RUNNING' : terminal;
      return jsonResponse(200, {
        id: runId,
        agentId,
        status,
        updatedAt: seen === 0 ? '2026-10-27T09:01:00.000Z' : '2026-10-27T09:02:00.000Z',
        secret: apiKey,
      });
    }
    return jsonResponse(500, { message: apiKey });
  };

  const git: CursorCloudCommandRunner = async argv => {
    gitArgv.push(argv);
    const args = argv.slice(1);
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return ok('git@github.com:ThinmanSoftware/bdc-harness.git');
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return ok(options.gitMode === 'detached' ? 'HEAD' : 'feature/work');
    }
    if (args[0] === 'checkout' && args[1] === '-b') return ok('');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(head);
    if (args[0] === 'push') return ok('');
    if (args[0] === 'fetch') {
      if (options.gitMode === 'missing') return fail('remote branch missing');
      return ok('');
    }
    if (args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) {
      if (options.gitMode === 'missing') return fail('unknown revision');
      if (options.gitMode === 'diverged') return ok(DIVERGED);
      return ok(originStep === 0 ? ONE : TWO);
    }
    if (args[0] === 'merge-base') {
      return options.gitMode === 'diverged' ? { code: 1, stdout: '', stderr: '' } : ok('');
    }
    if (args[0] === 'merge' && args[1] === '--ff-only') {
      head = args[2] ?? head;
      originStep += 1;
      return ok('');
    }
    return fail(`unexpected git ${args.join(' ')}`);
  };

  const gh: CursorCloudCommandRunner = async argv => {
    if (argv[1] === 'issue' && argv[2] === 'list') {
      const count = options.issueCount ?? 1;
      const issues = Array.from({ length: count }, (_unused, index) => ({
        number: 42 + index,
        title: `${WO_ID} implement cloud`,
      }));
      return ok(JSON.stringify(issues));
    }
    if (argv[1] === 'api') {
      if (!options.markerAlready) return ok('[]');
      return ok(
        JSON.stringify([{ body: `existing\n<!-- cauldron-cursor-cloud-agent:${RUN_ID} -->` }])
      );
    }
    if (argv[1] === 'issue' && argv[2] === 'comment') {
      const bodyIndex = argv.indexOf('--body');
      comments.push(argv[bodyIndex + 1] ?? '');
      return ok('');
    }
    return fail(argv.join(' '));
  };

  const env: Record<string, string | undefined> = {};
  if (apiKey) env.CURSOR_API_KEY = apiKey;
  if (options.transport !== undefined) env.CURSOR_LANE_IMPLEMENT_TRANSPORT = options.transport;

  const provider = new CursorCloudAgentProvider({
    fetchImpl,
    git,
    gh,
    env,
    sleep: options.sleep ?? (async () => undefined),
    cli: options.cli,
    recorder: async (runId, metadata) => {
      expect(runId).toBe(RUN_ID);
      recorded.push(structuredClone(metadata));
    },
    now: () => new Date(CREATED_AT),
  });

  return { provider, requests, gitArgv, comments, recorded, head: () => head };
}

function queryOptions(extra: Record<string, string> = {}): SendQueryOptions {
  return {
    model: 'grok-4.7-high',
    env: {
      ARCHON_WORKFLOW_RUN_ID: RUN_ID,
      WO_ID,
      ...extra,
    },
  };
}

function posts(requests: RecordedRequest[], pathname: string): RecordedRequest[] {
  return requests.filter(
    request => request.method === 'POST' && new URL(request.url).pathname === pathname
  );
}

describe('CursorCloudAgentProvider', () => {
  test('agent id is the RFC 4122 UUID v5 of the run id', () => {
    expect(cursorCloudAgentId('python.org')).toBe('bc-886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(cursorCloudAgentId(RUN_ID)).toBe('bc-0832863c-f816-5406-8b32-c0090e2becab');
  });

  test('one agent per run records the API url and posts one tracker comment', async () => {
    const harness = makeHarness();
    const first = await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    const second = await collect(
      harness.provider.sendQuery('continue the work order', '/work/tree', undefined, queryOptions())
    );
    const text = `${assistantText(first)}\n${assistantText(second)}`;
    const creates = posts(harness.requests, '/v1/agents');
    expect(creates).toHaveLength(1);
    const created = JSON.parse(creates[0]?.body ?? '{}') as {
      agentId?: string;
      name?: string;
      repos?: Array<{ url?: string; startingRef?: string }>;
      workOnCurrentBranch?: boolean;
      autoCreatePR?: boolean;
      skipReviewerRequest?: boolean;
      mode?: string;
      model?: { id?: string };
      prompt?: { text?: string };
    };
    expect(created.agentId).toBe(cursorCloudAgentId(RUN_ID));
    expect(created.name).toBe(`Cauldron ${WO_ID} run ${RUN_ID.slice(0, 8)}`);
    expect(created.repos?.[0]?.url).toBe('https://github.com/thinmansoftware/bdc-harness');
    expect(created.repos?.[0]?.startingRef).toBe('feature/work');
    expect(created.workOnCurrentBranch).toBe(true);
    expect(created.autoCreatePR).toBe(false);
    expect(created.skipReviewerRequest).toBe(true);
    expect(created.mode).toBe('agent');
    expect(created.model?.id).toBe('grok-4.7-high');
    expect(created.prompt?.text).toContain('Never open a pull request.');
    expect(created.prompt?.text).toContain('branch feature/work');
    expect(posts(harness.requests, '/v1/agents/bc-test/runs')).toHaveLength(1);
    expect(harness.recorded[0]?.cursor_cloud_agent.url).toBe(AGENT_URL);
    expect(harness.recorded[0]?.cursor_cloud_agent.agent_id).toBe('bc-test');
    expect(harness.recorded[0]?.cursor_cloud_agent.created_at).toBe(CREATED_AT);
    expect(harness.recorded[0]?.cursor_cloud_agent.run_ids).toEqual(['run-1']);
    expect(harness.recorded.at(-1)?.cursor_cloud_agent.run_ids).toEqual(['run-1', 'run-2']);
    expect(harness.comments).toHaveLength(1);
    expect(harness.comments[0]).toContain(AGENT_URL);
    expect(harness.comments[0]).toContain(WO_ID);
    expect(harness.comments[0]).toContain(RUN_ID);
    expect(harness.comments[0]).toContain(`<!-- cauldron-cursor-cloud-agent:${RUN_ID} -->`);
    expect(text).toContain(`CURSOR_CLOUD_AGENT_URL=${AGENT_URL}`);
    expect(text).toContain(`CURSOR_CLOUD_HEAD_VERIFIED=${ONE}`);
    expect(text).toContain(`CURSOR_CLOUD_HEAD_VERIFIED=${TWO}`);
    expect(harness.head()).toBe(TWO);
    expect(harness.requests.some(request => request.method === 'DELETE')).toBe(false);
    expect(
      harness.requests.some(
        request => request.url.includes('DELETE') || request.body.includes('DELETE')
      )
    ).toBe(false);
  });

  test('an existing tracker marker is not posted again', async () => {
    const harness = makeHarness({ markerAlready: true });
    await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    await collect(
      harness.provider.sendQuery('continue the work order', '/work/tree', undefined, queryOptions())
    );
    expect(harness.comments).toHaveLength(0);
  });

  test('HTTP 409 reuses the deterministic agent and sends a follow-up run', async () => {
    const harness = makeHarness({ conflict: true });
    const agentId = cursorCloudAgentId(RUN_ID);
    const chunks = await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    expect(posts(harness.requests, '/v1/agents')).toHaveLength(1);
    expect(posts(harness.requests, `/v1/agents/${agentId}/runs`)).toHaveLength(1);
    expect(
      harness.requests.some(request => request.method === 'GET' && request.url.includes(agentId))
    ).toBe(true);
    expect(assistantText(chunks)).toContain(
      `CURSOR_CLOUD_AGENT_URL=https://cursor.com/agents/${agentId}`
    );
    expect(assistantText(chunks)).toContain('CURSOR_CLOUD_HEAD_VERIFIED=');
  });

  test('abort cancels the cloud run once and never deletes the agent', async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      stayRunning: true,
      sleep: async () => {
        controller.abort();
      },
    });
    const chunks = await collect(
      harness.provider.sendQuery('implement the work order', '/work/tree', undefined, {
        ...queryOptions(),
        abortSignal: controller.signal,
      })
    );
    const cancels = harness.requests.filter(
      request => request.method === 'POST' && request.url.endsWith('/cancel')
    );
    expect(cancels).toHaveLength(1);
    expect(assistantText(chunks)).toContain('CURSOR_CLOUD_CANCELLED=run-1');
    expect(harness.requests.some(request => request.method === 'DELETE')).toBe(false);
    expect(harness.gitArgv.some(argv => argv[1] === 'fetch')).toBe(false);
  });

  test('a descendant head is fast-forwarded and verified before return', async () => {
    const harness = makeHarness();
    const chunks = await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    expect(
      harness.gitArgv.some(
        argv => argv[1] === 'merge' && argv[2] === '--ff-only' && argv[3] === ONE
      )
    ).toBe(true);
    expect(harness.head()).toBe(ONE);
    expect(assistantText(chunks)).toContain(`CURSOR_CLOUD_HEAD_VERIFIED=${ONE}`);
  });

  test('a non-descendant head fails with CURSOR_CLOUD_HEAD_DIVERGED', async () => {
    const harness = makeHarness({ gitMode: 'diverged' });
    await expect(
      collect(
        harness.provider.sendQuery(
          'implement the work order',
          '/work/tree',
          undefined,
          queryOptions()
        )
      )
    ).rejects.toThrow('CURSOR_CLOUD_HEAD_DIVERGED');
    expect(harness.gitArgv.some(argv => argv[1] === 'merge')).toBe(false);
    expect(harness.head()).toBe(PRE);
  });

  test('a missing origin branch fails with CURSOR_CLOUD_HEAD_MISSING', async () => {
    const harness = makeHarness({ gitMode: 'missing' });
    await expect(
      collect(
        harness.provider.sendQuery(
          'implement the work order',
          '/work/tree',
          undefined,
          queryOptions()
        )
      )
    ).rejects.toThrow('CURSOR_CLOUD_HEAD_MISSING');
  });

  test('detached HEAD is published on cauldron/<WO>-<run8> before dispatch', async () => {
    const harness = makeHarness({ gitMode: 'detached' });
    await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    const branch = `cauldron/${WO_ID}-${RUN_ID.slice(0, 8)}`;
    expect(harness.gitArgv.some(argv => argv.join(' ') === `git checkout -b ${branch}`)).toBe(true);
    expect(harness.gitArgv.some(argv => argv.join(' ') === `git push -u origin ${branch}`)).toBe(
      true
    );
    const created = JSON.parse(posts(harness.requests, '/v1/agents')[0]?.body ?? '{}') as {
      repos?: Array<{ startingRef?: string }>;
    };
    expect(created.repos?.[0]?.startingRef).toBe(branch);
  });

  test('terminal ERROR and EXPIRED name the status and agent id and hide the key', async () => {
    for (const status of ['ERROR', 'EXPIRED'] as const) {
      const harness = makeHarness({ terminal: status });
      try {
        await collect(
          harness.provider.sendQuery(
            'implement the work order',
            '/work/tree',
            undefined,
            queryOptions()
          )
        );
        throw new Error(`expected ${status} to throw`);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        expect(message).toContain(status);
        expect(message).toContain('bc-test');
        expect(message).not.toContain(API_KEY);
      }
    }
  });

  test('cli transport delegates to cursor-agent and makes no API call', async () => {
    const spawned: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      spawned.push(argv);
      return fakeChild(
        streamJson([
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'cli done' }] },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'cli done' },
        ])
      );
    };
    const cli = new CursorAgentProvider({ spawn });
    const harness = makeHarness({ transport: 'cli', cli });
    const chunks = await collect(
      harness.provider.sendQuery(
        'implement the work order',
        '/work/tree',
        undefined,
        queryOptions()
      )
    );
    expect(spawned[0]?.[0]).toBe('cursor-agent');
    expect(spawned[0]).toContain('--workspace');
    expect(spawned[0]).toContain('/work/tree');
    expect(assistantText(chunks)).toContain('cli done');
    expect(harness.requests).toHaveLength(0);
  });

  test('an invalid transport fails closed before either path runs', async () => {
    const spawned: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      spawned.push(argv);
      return fakeChild('');
    };
    const harness = makeHarness({
      transport: 'bogus',
      cli: new CursorAgentProvider({ spawn }),
    });
    await expect(
      collect(
        harness.provider.sendQuery(
          'implement the work order',
          '/work/tree',
          undefined,
          queryOptions()
        )
      )
    ).rejects.toThrow('CURSOR_LANE_IMPLEMENT_TRANSPORT invalid');
    expect(spawned).toHaveLength(0);
    expect(harness.requests).toHaveLength(0);
  });

  test('missing workflow run id or WO id fails closed with no API call and no CLI', async () => {
    const spawned: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      spawned.push(argv);
      return fakeChild('');
    };
    const cli = new CursorAgentProvider({ spawn });
    const missingRun = makeHarness({ cli });
    await expect(
      collect(
        missingRun.provider.sendQuery('implement the work order', '/work/tree', undefined, {
          env: { WO_ID },
        })
      )
    ).rejects.toThrow('CURSOR_CLOUD_CONTEXT_MISSING');
    const missingWo = makeHarness({ cli });
    await expect(
      collect(
        missingWo.provider.sendQuery('implement the work order', '/work/tree', undefined, {
          env: { ARCHON_WORKFLOW_RUN_ID: RUN_ID },
        })
      )
    ).rejects.toThrow('CURSOR_CLOUD_CONTEXT_MISSING');
    expect(missingRun.requests).toHaveLength(0);
    expect(missingWo.requests).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  test('a missing API key fails before any request', async () => {
    const harness = makeHarness({ apiKey: '' });
    await expect(
      collect(
        harness.provider.sendQuery(
          'implement the work order',
          '/work/tree',
          undefined,
          queryOptions()
        )
      )
    ).rejects.toThrow('CURSOR_API_KEY required for cursor-cloud transport');
    expect(harness.requests).toHaveLength(0);
  });

  test('an unset env bag reads CURSOR_LANE_IMPLEMENT_TRANSPORT from process.env', async () => {
    const previous = process.env.CURSOR_LANE_IMPLEMENT_TRANSPORT;
    process.env.CURSOR_LANE_IMPLEMENT_TRANSPORT = 'bogus';
    try {
      const provider = new CursorCloudAgentProvider({
        fetchImpl: async () => jsonResponse(500, {}),
        git: async () => ok(''),
        gh: async () => ok(''),
        sleep: async () => undefined,
      });
      await expect(
        collect(
          provider.sendQuery('implement the work order', '/work/tree', undefined, queryOptions())
        )
      ).rejects.toThrow('CURSOR_LANE_IMPLEMENT_TRANSPORT invalid');
    } finally {
      if (previous === undefined) delete process.env.CURSOR_LANE_IMPLEMENT_TRANSPORT;
      else process.env.CURSOR_LANE_IMPLEMENT_TRANSPORT = previous;
    }
  });

  test('the module metadata recorder receives the cloud agent record', async () => {
    const seen: CursorCloudAgentMetadata[] = [];
    setCursorCloudRunMetadataRecorder(async (runId, metadata) => {
      expect(runId).toBe(RUN_ID);
      seen.push(metadata);
    });
    try {
      const harness = makeHarness();
      const injected = harness.recorded;
      expect(injected).toEqual([]);
      const provider = new CursorCloudAgentProvider({
        fetchImpl: async (input, init) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          const path = new URL(url).pathname;
          if (method === 'POST' && path === '/v1/agents') {
            return jsonResponse(200, {
              id: 'bc-test',
              url: AGENT_URL,
              createdAt: CREATED_AT,
              latestRunId: 'run-1',
            });
          }
          if (method === 'GET' && path.includes('/runs/')) {
            return jsonResponse(200, {
              id: 'run-1',
              agentId: 'bc-test',
              status: 'FINISHED',
              updatedAt: CREATED_AT,
            });
          }
          return jsonResponse(500, {});
        },
        git: async argv => {
          const args = argv.slice(1);
          if (args[0] === 'remote') return ok('https://github.com/thinmansoftware/bdc-harness.git');
          if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('feature/work');
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(PRE);
          if (args[0] === 'push' || args[0] === 'fetch') return ok('');
          if (args[0] === 'rev-parse' && args[1]?.startsWith('origin/')) return ok(PRE);
          if (args[0] === 'merge-base' || args[0] === 'merge') return ok('');
          return fail(args.join(' '));
        },
        gh: async () => ok('[]'),
        env: { CURSOR_API_KEY: API_KEY },
        sleep: async () => undefined,
      });
      await collect(
        provider.sendQuery('implement the work order', '/work/tree', undefined, queryOptions())
      );
      expect(seen[0]?.cursor_cloud_agent.url).toBe(AGENT_URL);
      expect(seen[0]?.cursor_cloud_agent.run_ids).toEqual(['run-1']);
    } finally {
      setCursorCloudRunMetadataRecorder(null);
    }
  });

  test('listAgents and getAgentUsage parse pages and cost', async () => {
    const client = new CursorCloudAgentClient({
      apiKey: API_KEY,
      fetchImpl: async (input, init) => {
        const url = String(input);
        expect(init?.headers).toBeDefined();
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization.startsWith('Basic ')).toBe(true);
        expect(url).not.toContain(API_KEY);
        if (url.endsWith('/v1/agents')) {
          return jsonResponse(200, {
            items: [{ id: 'bc-1', url: 'https://cursor.com/agents/bc-1', name: 'Cauldron WO' }],
            nextCursor: 'next',
          });
        }
        if (url.includes('/usage')) {
          return jsonResponse(200, { cost: { rawCostCents: 12.5, chargedCents: 0 } });
        }
        return jsonResponse(404, {});
      },
    });
    const page = await client.listAgents();
    expect(page.items[0]?.id).toBe('bc-1');
    expect(page.nextCursor).toBe('next');
    const usage = await client.getAgentUsage('bc-1');
    expect(usage.cost?.rawCostCents).toBe(12.5);
  });
});
