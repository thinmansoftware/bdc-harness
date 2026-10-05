/**
 * node-timeouts.test.ts -- The workflow-definition timeout resolver and its
 * production wiring into the cascade's poll call.
 *
 * The defect under test: poll.ts accepts `nodeTimeoutsMs`, but before this change
 * NO production caller supplied it. The option was inert, so a node configured
 * ABOVE the 60-minute open-node default was still cut at 60 minutes and a healthy
 * run was cancelled (WO-HARNESS-CONDUCTOR-STALL-DETECTOR-FIX-01 Scope IN item 2).
 *
 * Two things therefore have to be proven, not just the pure function:
 *   1. the resolver derives the right budgets from a workflow definition, and
 *   2. the CASCADE actually calls it and hands the result to poll.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractNodeTimeoutsMs, fetchNodeTimeoutsMs } from './node-timeouts.ts';
import { pollForTerminal, DEFAULT_OPEN_NODE_BUDGET_MS } from './poll.ts';
import { runCascade } from './cascade.ts';
import type { RunCascadeOptions } from './cascade.ts';
import type { PollResult, GateVerdict } from './types.ts';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  Date.now = originalDateNow;
});

// ---------------------------------------------------------------------------
// extractNodeTimeoutsMs -- pure derivation
// ---------------------------------------------------------------------------

describe('extractNodeTimeoutsMs', () => {
  test('a node configured ABOVE the floor is surfaced (the reported defect)', () => {
    // 90-minute bash timeout. Before this change nothing carried it to poll, so
    // the node was cut at the 60-minute default while still healthy.
    const workflow = {
      nodes: [{ id: 'long-suite', bash: 'echo hi', timeout: 5_400_000 }],
    };
    expect(extractNodeTimeoutsMs(workflow, DEFAULT_OPEN_NODE_BUDGET_MS)).toEqual({
      'long-suite': 5_400_000,
    });
  });

  test.each([600_000, 1_800_000, DEFAULT_OPEN_NODE_BUDGET_MS])(
    'a whole-node timeout of %d is preserved at or below the floor',
    timeout => {
      const workflow = {
        nodes: [{ id: 'run-stop-tests', bash: 'bun test', timeout }],
      };
      expect(extractNodeTimeoutsMs(workflow)).toEqual({ 'run-stop-tests': timeout });
    }
  );

  test.each(['idle_timeout', 'wall_timeout_ms'])(
    '%s only extends the budget above the floor',
    field => {
      for (const value of [600_000, 1_800_000, DEFAULT_OPEN_NODE_BUDGET_MS]) {
        expect(extractNodeTimeoutsMs({ nodes: [{ id: 'node', [field]: value }] })).toEqual({});
      }
      expect(extractNodeTimeoutsMs({ nodes: [{ id: 'node', [field]: 7_200_000 }] })).toEqual({
        node: 7_200_000,
      });
    }
  );

  test('a node with no timeout fields is omitted', () => {
    expect(extractNodeTimeoutsMs({ nodes: [{ id: 'node' }] })).toEqual({});
  });

  test.each(['timeout', 'idle_timeout', 'wall_timeout_ms'])(
    'invalid %s values are ignored',
    field => {
      for (const value of [-5, 0, NaN, Infinity, '600000', null, true, {}]) {
        expect(extractNodeTimeoutsMs({ nodes: [{ id: 'node', [field]: value }] })).toEqual({});
      }
    }
  );

  test.each(['idle_timeout', 'wall_timeout_ms'])(
    '%s can extend a whole-node timeout only above the floor',
    field => {
      for (const value of [1_800_000, DEFAULT_OPEN_NODE_BUDGET_MS, NaN]) {
        expect(
          extractNodeTimeoutsMs({
            nodes: [{ id: 'node', timeout: 600_000, [field]: value }],
          })
        ).toEqual({ node: 600_000 });
      }
      expect(
        extractNodeTimeoutsMs({
          nodes: [{ id: 'node', timeout: 600_000, [field]: 7_200_000 }],
        })
      ).toEqual({ node: 7_200_000 });
      expect(
        extractNodeTimeoutsMs({
          nodes: [{ id: 'node', timeout: 9_000_000, [field]: 7_200_000 }],
        })
      ).toEqual({ node: 9_000_000 });
      expect(
        extractNodeTimeoutsMs({
          nodes: [{ id: 'node', timeout: '600000', [field]: 7_200_000 }],
        })
      ).toEqual({ node: 7_200_000 });
    }
  );

  test("the real 'implement' loop is NOT tightened by its per-iteration caps", () => {
    // bdc-feature-development's implement node: idle_timeout 10m (enforced on SDK
    // chunks, most of which persist no event) and wall_timeout_ms 30m (PER
    // ITERATION -- the node stays open across many). Neither bounds event-feed
    // silence for the whole node, and this loop legitimately runs for hours.
    // Mapping either one in would cut it at 30 minutes.
    const workflow = {
      nodes: [
        { id: 'implement', idle_timeout: 600_000, wall_timeout_ms: 1_800_000, loop: {} },
        { id: 'plan-review', idle_timeout: 600_000, loop: {} },
      ],
    };
    expect(extractNodeTimeoutsMs(workflow, DEFAULT_OPEN_NODE_BUDGET_MS)).toEqual({});
  });

  test('the largest configured bound on a node wins', () => {
    const workflow = {
      nodes: [{ id: 'slow-loop', idle_timeout: 600_000, wall_timeout_ms: 7_200_000 }],
    };
    expect(extractNodeTimeoutsMs(workflow, DEFAULT_OPEN_NODE_BUDGET_MS)).toEqual({
      'slow-loop': 7_200_000,
    });
  });

  test('a lower floor lets more nodes through (floor is honored, not hardcoded)', () => {
    const workflow = { nodes: [{ id: 'a', idle_timeout: 1_800_000 }] };
    expect(extractNodeTimeoutsMs(workflow)).toEqual({});
    expect(extractNodeTimeoutsMs(workflow, 600_000)).toEqual({ a: 1_800_000 });
  });

  test('malformed or timeout-less definitions yield an empty map, never throw', () => {
    expect(extractNodeTimeoutsMs(undefined)).toEqual({});
    expect(extractNodeTimeoutsMs(null)).toEqual({});
    expect(extractNodeTimeoutsMs({})).toEqual({});
    expect(extractNodeTimeoutsMs({ nodes: 'not-an-array' })).toEqual({});
    expect(
      extractNodeTimeoutsMs({
        nodes: [
          null,
          'string-node',
          { timeout: 9_999_999 }, // no id -- unjoinable to step_name
          { id: '   ', timeout: 9_999_999 }, // blank id
          { id: 'bad-1', timeout: 'soon' }, // non-numeric
          { id: 'bad-2', timeout: -1 }, // non-positive
          { id: 'bad-3', timeout: Number.POSITIVE_INFINITY }, // non-finite
          { id: 'ok', timeout: 9_999_999 },
        ],
      })
    ).toEqual({ ok: 9_999_999 });
  });
});

// ---------------------------------------------------------------------------
// fetchNodeTimeoutsMs -- API read, fail-open
// ---------------------------------------------------------------------------

describe('fetchNodeTimeoutsMs', () => {
  test('reads the workflow definition and derives budgets', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          workflow: { nodes: [{ id: 'long-suite', timeout: 5_400_000 }] },
          filename: 'wf.yaml',
          source: 'project',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const map = await fetchNodeTimeoutsMs({
      workflowName: 'bdc-feature-development',
      apiBaseUrl: 'http://x',
      token: 't',
    });

    expect(requestedUrl).toBe('http://x/api/workflows/bdc-feature-development');
    expect(map).toEqual({ 'long-suite': 5_400_000 });
  });

  test('fails OPEN on network error -- poll keeps its generous default', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(
      await fetchNodeTimeoutsMs({ workflowName: 'w', apiBaseUrl: 'http://x', token: 't' })
    ).toEqual({});
  });

  test('fails OPEN on a non-2xx response (e.g. workflow not found)', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    expect(
      await fetchNodeTimeoutsMs({ workflowName: 'w', apiBaseUrl: 'http://x', token: 't' })
    ).toEqual({});
  });

  test('fails OPEN on an unparseable body', async () => {
    globalThis.fetch = (async () =>
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    expect(
      await fetchNodeTimeoutsMs({ workflowName: 'w', apiBaseUrl: 'http://x', token: 't' })
    ).toEqual({});
  });

  test('an empty workflow name short-circuits without a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    expect(
      await fetchNodeTimeoutsMs({ workflowName: '', apiBaseUrl: 'http://x', token: 't' })
    ).toEqual({});
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through poll: a >60m configured node survives past 60m of silence
// ---------------------------------------------------------------------------

describe('resolved budgets reach the watchdog', () => {
  test('a 90m-configured node is not cut at the 60m default', async () => {
    // Virtual clock: setTimeout advances "now" so the poll loop burns hours in ms.
    let offset = 0;
    const base = originalDateNow();
    Date.now = () => base + offset;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      offset += ms ?? 0;
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const startedAt = Date.now();
    const openEvent = {
      event_type: 'node_started',
      step_name: 'long-suite',
      data: {},
      created_at: new Date(startedAt).toISOString(),
    };

    globalThis.fetch = (async (url: string) => {
      // Order matters: the run-detail path is /api/workflows/runs/:id, which also
      // contains the workflow-definition prefix.
      if (!url.includes('/api/workflows/runs/')) {
        return new Response(
          JSON.stringify({ workflow: { nodes: [{ id: 'long-suite', timeout: 5_400_000 }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      // The node stays open and silent. Terminal only after 80 minutes -- past the
      // 60m default that used to cancel it, inside the 90m configured budget.
      const elapsed = Date.now() - startedAt;
      const status = elapsed > 4_800_000 ? 'completed' : 'running';
      return new Response(JSON.stringify({ run: { id: 'r1', status }, events: [openEvent] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const nodeTimeoutsMs = await fetchNodeTimeoutsMs({
      workflowName: 'wf',
      apiBaseUrl: 'http://x',
      token: 't',
    });
    expect(nodeTimeoutsMs).toEqual({ 'long-suite': 5_400_000 });

    const result = await pollForTerminal({
      runId: 'r1',
      apiBaseUrl: 'http://x',
      token: 't',
      stallTimeoutMs: 1_200_000,
      openNodeBudgetMs: DEFAULT_OPEN_NODE_BUDGET_MS,
      nodeTimeoutsMs,
      intervalMs: 30_000,
      prRetryAttempts: 0,
      checkPrMergeable: async () => null,
    });

    expect(result.terminalStatus).toBe('completed');
    expect(Date.now() - startedAt).toBeGreaterThan(DEFAULT_OPEN_NODE_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// Production wiring: the cascade supplies the map to poll
// ---------------------------------------------------------------------------

const testOutRoot = join(tmpdir(), `smart-cauldron-node-timeouts-${randomUUID()}`);

function passVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function pollResult(): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/1',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
  };
}

function baseOpts(partial: Partial<RunCascadeOptions> = {}): RunCascadeOptions {
  const { deps, ...options } = partial;
  return {
    woId: 'WO-TEST-NODE-TIMEOUTS',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: join(testOutRoot, randomUUID()),
    token: 'test-token',
    project: 'test-project',
    ...options,
    deps: {
      findWoClaim: async () => null,
      acquireWoLock: async (woId, project, cascadeId) => ({
        acquired: true,
        path: 'in-memory-test-lock',
        record: {
          woId,
          project,
          cascadeId,
          status: 'running',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      }),
      releaseWoLock: async () => {},
      writeRecord: async () => {},
      ...deps,
    },
  };
}

describe('cascade wiring', () => {
  afterEach(async () => {
    await rm(testOutRoot, { recursive: true, force: true });
  });

  test('the resolved map is handed to poll (without this, nodeTimeoutsMs is inert)', async () => {
    const resolved = { 'long-suite': 5_400_000 };
    let seen: Record<string, number> | undefined;
    let sawUndefined = false;

    await runCascade(
      baseOpts({
        deps: {
          fetchNodeTimeouts: async () => resolved,
          fire: async () => ({
            ok: true,
            runId: 'run-1',
            conversationId: 'conv-1',
            infraError: null,
          }),
          poll: async opts => {
            seen = opts.nodeTimeoutsMs;
            if (opts.nodeTimeoutsMs === undefined) sawUndefined = true;
            return pollResult();
          },
          judge: () => passVerdict(),
        },
      })
    );

    expect(sawUndefined).toBe(false);
    expect(seen).toEqual(resolved);
  });

  test('budgets are resolved for the workflow of the tier actually fired', async () => {
    // Each ladder tier binds its own workflow, so a single up-front lookup would
    // apply the wrong workflow's timeouts after a climb.
    const resolvedFor: string[] = [];
    const firedWorkflows: string[] = [];

    await runCascade(
      baseOpts({
        deps: {
          fetchNodeTimeouts: async ({ workflowName }) => {
            resolvedFor.push(workflowName);
            return {};
          },
          fire: async options => {
            firedWorkflows.push(options.workflowName);
            return { ok: true, runId: 'run-1', conversationId: 'conv-1', infraError: null };
          },
          poll: async () => pollResult(),
          judge: () => passVerdict(),
        },
      })
    );

    expect(firedWorkflows.length).toBeGreaterThan(0);
    expect(resolvedFor).toEqual(firedWorkflows);
  });

  test('a resolver failure does not break the cascade (fail-open)', async () => {
    let polled = false;
    const record = await runCascade(
      baseOpts({
        deps: {
          // The real resolver never throws; prove the cascade survives even if a
          // future one did, rather than losing a live run to a lookup problem.
          fetchNodeTimeouts: async () => {
            throw new Error('workflow lookup exploded');
          },
          fire: async () => ({
            ok: true,
            runId: 'run-1',
            conversationId: 'conv-1',
            infraError: null,
          }),
          poll: async () => {
            polled = true;
            return pollResult();
          },
          judge: () => passVerdict(),
        },
      })
    );

    expect(polled).toBe(true);
    expect(record.status).toBe('won');
  });
});
