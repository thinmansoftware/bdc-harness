/**
 * OpenRouter review-fence executor-gate tests
 * (WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01).
 *
 * Tests 1, 2, 5, 6, 8, 10, 11 -- the dag-executor gate decision: when a
 * customer-repo OpenRouter route is scanned, when it is pinned vs rerouted,
 * that the openrouter_diff_scan event is recorded (locations only, never the
 * matched value), that the repository-diff scan is cached by run id + HEAD sha
 * while the prompt is scanned every request, and that every OpenRouter code
 * path (opr, openrouter tool-loop, codex-opr, loop) is gated and never reaches
 * an OpenRouter client on a hit.
 */
import { describe, expect, mock, test, beforeEach } from 'bun:test';

import {
  applyOpenRouterReviewFence,
  emitNoPrivateEndpointReroute,
  clearOpenRouterDiffScanCache,
  type OpenRouterFenceParams,
} from './dag-executor';
import {
  scanDiffForOpenRouter,
  isNoPrivateEndpointError,
  type GitleaksResult,
} from '@archon/providers';
import type { WorkflowDeps } from './deps';
import type { WorkflowRun } from './schemas';

const SLUGS = ['mutant-market'];
const cleanGitleaks = (): Promise<GitleaksResult> =>
  Promise.resolve({ available: true, findings: [] });

interface FakeClient {
  sendQuery: ReturnType<typeof mock>;
  getType: () => string;
}

interface Harness {
  deps: WorkflowDeps;
  events: Array<{ event_type: string; step_name?: string; data: Record<string, unknown> }>;
  clients: Map<string, FakeClient>;
  getProviderCalls: string[];
}

function makeHarness(): Harness {
  const events: Harness['events'] = [];
  const clients = new Map<string, FakeClient>();
  const getProviderCalls: string[] = [];
  const makeClient = (type: string): FakeClient => ({
    sendQuery: mock(async function* () {
      yield { type: 'assistant', content: 'ok' };
    }),
    getType: () => type,
  });
  for (const id of [
    'opr',
    'openrouter',
    'glm',
    'codex-opr',
    'codex-native-strict',
    'codex-native',
  ]) {
    clients.set(id, makeClient(id));
  }
  const deps = {
    store: {
      createWorkflowEvent: mock(
        async (e: { event_type: string; step_name?: string; data: Record<string, unknown> }) => {
          events.push(e);
          return undefined;
        }
      ),
    },
    getAgentProvider: (id: string) => {
      getProviderCalls.push(id);
      const c = clients.get(id);
      if (!c) throw new Error(`no fake client for ${id}`);
      return c;
    },
  } as unknown as WorkflowDeps;
  return { deps, events, clients, getProviderCalls };
}

const RUN = { id: 'run-1' } as unknown as WorkflowRun;

function baseParams(h: Harness, over: Partial<OpenRouterFenceParams>): OpenRouterFenceParams {
  let diffCalls = 0;
  let promptCalls = 0;
  const scanText = async (text: string, mode: 'diff' | 'prompt') => {
    if (mode === 'diff') diffCalls++;
    else promptCalls++;
    return scanDiffForOpenRouter(text, { mode, tenantSlugs: SLUGS, gitleaksRunner: cleanGitleaks });
  };
  // Expose counters on the returned object for assertions.
  const params: OpenRouterFenceParams & {
    _counts?: () => { diffCalls: number; promptCalls: number };
  } = {
    deps: h.deps,
    workflowRun: RUN,
    nodeId: 'diff-review',
    cwd: '/tmp/wt',
    baseBranch: 'dev',
    provider: 'opr',
    model: 'deepseek/deepseek-v4-pro',
    failoverTarget: { provider: 'codex-native-strict', model: undefined, agent: undefined },
    finalPrompt: 'Please review the diff.',
    tenantSlugs: SLUGS,
    gitProbes: {
      resolveRemote: async () => 'git@github.com:thinmansoftware/lspro-react.git',
      resolveHeadSha: async () => 'headsha1',
      resolveDiff: async () => '+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
    },
    scanText,
    ...over,
  };
  params._counts = () => ({ diffCalls, promptCalls });
  return params;
}

describe('applyOpenRouterReviewFence', () => {
  beforeEach(() => clearOpenRouterDiffScanCache());

  // Test 1: clean customer diff stays on OpenRouter with the pin.
  test('Test 1: clean customer diff -> privacy pin, stays on opr, event verdict clean', async () => {
    const h = makeHarness();
    const decision = await applyOpenRouterReviewFence(baseParams(h, {}));
    expect(decision.applicable).toBe(true);
    expect(decision.rerouted).toBe(false);
    expect(decision.privacyPin).toBe(true);
    expect(decision.routedProvider).toBe('opr');
    expect(decision.verdict).toBe('clean');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.event_type).toBe('openrouter_diff_scan');
    expect(h.events[0]?.data.verdict).toBe('clean');
  });

  // Test 2: customer email in a fixture reroutes; value absent from the event.
  test('Test 2: customer email in a fixture reroutes off OpenRouter', async () => {
    const h = makeHarness();
    const diff = [
      '+++ b/tests/fixtures/orders.json',
      '@@ -0,0 +1,1 @@',
      '+  email: "jane.customer@gmail.com"',
    ].join('\n');
    const decision = await applyOpenRouterReviewFence(
      baseParams(h, {
        gitProbes: {
          resolveRemote: async () => 'thinmansoftware/lspro-react',
          resolveHeadSha: async () => 'headsha-email',
          resolveDiff: async () => diff,
        },
      })
    );
    expect(decision.rerouted).toBe(true);
    expect(decision.privacyPin).toBe(false);
    expect(decision.routedProvider).toBe('codex-native-strict');
    expect(decision.verdict).toBe('hit');
    expect(decision.hitKinds).toContain('email');
    const ev = h.events[0];
    expect(ev?.data.verdict).toBe('hit');
    expect(ev?.data.hit_kinds as string[]).toContain('email');
    expect(
      (ev?.data.hit_locations as string[]).some(l => l.includes('tests/fixtures/orders.json'))
    ).toBe(true);
    // The matched value must never land in the event.
    expect(JSON.stringify(ev?.data)).not.toContain('jane.customer');
    // The request must not reach an OpenRouter client.
    const client = h.deps.getAgentProvider(decision.routedProvider) as unknown as FakeClient;
    expect(client.getType()).not.toBe('opr');
    expect(client.getType()).not.toBe('openrouter');
  });

  // systemPrompt scan: customer data carried in the system / persona prompt is
  // scanned as part of the assembled outgoing content and reroutes, even when
  // the user prompt AND the repository diff are clean. Without this, a persona
  // holding a customer email/phone would reach OpenRouter unscanned.
  test('persona systemPrompt customer data reroutes off OpenRouter (clean prompt + diff)', async () => {
    const h = makeHarness();
    const decision = await applyOpenRouterReviewFence(
      baseParams(h, {
        finalPrompt: 'Review the diff, please.',
        systemPrompt: 'You are a reviewer. Escalate to jane.customer@gmail.com when unsure.',
        gitProbes: {
          resolveRemote: async () => 'thinmansoftware/lspro-react',
          resolveHeadSha: async () => 'headsha-persona',
          resolveDiff: async () => '+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
        },
      })
    );
    expect(decision.rerouted).toBe(true);
    expect(decision.verdict).toBe('hit');
    expect(decision.hitKinds).toContain('email');
    expect(decision.routedProvider).toBe('codex-native-strict');
    const ev = h.events[0];
    expect((ev?.data.hit_locations as string[]).some(l => l.startsWith('prompt:'))).toBe(true);
    // The matched value never lands in the event.
    expect(JSON.stringify(ev?.data)).not.toContain('jane.customer');
    // The request never reaches an OpenRouter client.
    expect(h.clients.get('opr')?.sendQuery).not.toHaveBeenCalled();
  });

  // A clean systemPrompt + clean prompt + clean diff still pins on OpenRouter --
  // the added system-prompt scan does not over-trigger.
  test('clean persona systemPrompt keeps the route on OpenRouter with the pin', async () => {
    const h = makeHarness();
    const decision = await applyOpenRouterReviewFence(
      baseParams(h, {
        finalPrompt: 'Review the diff, please.',
        systemPrompt: 'You are a careful, concise code reviewer.',
      })
    );
    expect(decision.rerouted).toBe(false);
    expect(decision.privacyPin).toBe(true);
    expect(decision.routedProvider).toBe('opr');
    expect(decision.verdict).toBe('clean');
  });

  // Test 5: non-customer repo is untouched.
  test('Test 5: non-customer repo -> no scan, no event, no pin, provider unchanged', async () => {
    const h = makeHarness();
    const decision = await applyOpenRouterReviewFence(
      baseParams(h, {
        gitProbes: {
          resolveRemote: async () => 'git@github.com:thinmansoftware/bdc-harness.git',
          resolveHeadSha: async () => 'headsha-nc',
          resolveDiff: async () => '+ whatever',
        },
      })
    );
    expect(decision.applicable).toBe(false);
    expect(decision.rerouted).toBe(false);
    expect(decision.privacyPin).toBe(false);
    expect(decision.routedProvider).toBe('opr');
    expect(h.events).toHaveLength(0);
  });

  // Test 6: every OpenRouter path is gated and rerouted on a hit.
  test('Test 6: opr / openrouter / codex-opr all reroute on a hit; none reach OpenRouter', async () => {
    const hitDiff = [
      '+++ b/tests/fixtures/orders.json',
      '@@ -0,0 +1,1 @@',
      '+  email: "jane.customer@gmail.com"',
    ].join('\n');
    for (const provider of ['opr', 'codex-opr']) {
      const h = makeHarness();
      const decision = await applyOpenRouterReviewFence(
        baseParams(h, {
          provider,
          gitProbes: {
            resolveRemote: async () => 'thinmansoftware/shopops',
            resolveHeadSha: async () => `headsha-${provider}`,
            resolveDiff: async () => hitDiff,
          },
        })
      );
      expect(decision.applicable).toBe(true);
      expect(decision.rerouted).toBe(true);
      expect(decision.routedProvider).toBe('codex-native-strict');
      // Drive the (rerouted) client -- the OpenRouter client is never touched.
      const client = h.deps.getAgentProvider(decision.routedProvider) as unknown as FakeClient;
      for await (const _ of client.sendQuery()) {
        // drain
      }
      expect(h.clients.get('opr')?.sendQuery).not.toHaveBeenCalled();
      expect(h.clients.get('openrouter')?.sendQuery).not.toHaveBeenCalled();
    }
  });

  // Test 11(d): the tool-loop seat is always rerouted (repo_read_unscannable),
  // never scanned, never calling the OpenRouter (Grok) client.
  test('Test 11(d): provider openrouter -> repo_read_unscannable, never calls the tool-loop client', async () => {
    const h = makeHarness();
    const params = baseParams(h, {
      provider: 'openrouter',
      // A clean diff -- the reroute must happen regardless of scan result.
      gitProbes: {
        resolveRemote: async () => 'thinmansoftware/shopops-storefront',
        resolveHeadSha: async () => 'headsha-tl',
        resolveDiff: async () => '+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
      },
    });
    const decision = await applyOpenRouterReviewFence(params);
    expect(decision.rerouted).toBe(true);
    expect(decision.verdict).toBe('scan_unavailable');
    expect(decision.reason).toBe('repo_read_unscannable');
    expect(decision.routedProvider).toBe('codex-native-strict');
    // No scan ran for the tool loop.
    const counts = (
      params as unknown as { _counts: () => { diffCalls: number; promptCalls: number } }
    )._counts();
    expect(counts.diffCalls).toBe(0);
    expect(counts.promptCalls).toBe(0);
    expect(h.clients.get('openrouter')?.sendQuery).not.toHaveBeenCalled();
  });

  // Test 11(a,b,c): removed line, context line, and prompt-only text are scanned.
  test('Test 11(a,b,c): removed/context diff lines and prompt-only text are all caught', async () => {
    // (a) email only on a removed line.
    const hA = makeHarness();
    const dA = await applyOpenRouterReviewFence(
      baseParams(hA, {
        gitProbes: {
          resolveRemote: async () => 'thinmansoftware/lspro-react',
          resolveHeadSha: async () => 'h-a',
          resolveDiff: async () =>
            '+++ b/tests/fixtures/orders.json\n@@ -1,1 +1,0 @@\n-  email: "jane.customer@gmail.com"\n',
        },
      })
    );
    expect(dA.rerouted).toBe(true);
    expect(dA.hitKinds).toContain('email');

    // (b) stripe id only on an unchanged context line.
    const hB = makeHarness();
    const dB = await applyOpenRouterReviewFence(
      baseParams(hB, {
        gitProbes: {
          resolveRemote: async () => 'thinmansoftware/lspro-react',
          resolveHeadSha: async () => 'h-b',
          resolveDiff: async () =>
            '+++ b/tests/fixtures/orders.json\n@@ -1,2 +1,2 @@\n   id: cus_N1x2Y3z4W5v6\n+  note: ok\n',
        },
      })
    );
    expect(dB.rerouted).toBe(true);
    expect(dB.hitKinds).toContain('stripe_id');

    // (c) phone only in the prompt text (no diff hit).
    const hC = makeHarness();
    const dC = await applyOpenRouterReviewFence(
      baseParams(hC, {
        finalPrompt: 'Persona: reviewer. Contact the customer at 555-867-5309 if needed.',
        gitProbes: {
          resolveRemote: async () => 'thinmansoftware/lspro-react',
          resolveHeadSha: async () => 'h-c',
          resolveDiff: async () => '+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
        },
      })
    );
    expect(dC.rerouted).toBe(true);
    expect(dC.hitKinds).toContain('phone');
  });

  // Test 10: the repository diff is scanned once (cache hit); the prompt twice.
  test('Test 10: per-request prompt scan is not cached across nodes at a fixed HEAD', async () => {
    const h = makeHarness();
    let diffCalls = 0;
    let promptCalls = 0;
    const scanText = async (text: string, mode: 'diff' | 'prompt') => {
      if (mode === 'diff') diffCalls++;
      else promptCalls++;
      return scanDiffForOpenRouter(text, {
        mode,
        tenantSlugs: SLUGS,
        gitleaksRunner: cleanGitleaks,
      });
    };
    const gitProbes = {
      resolveRemote: async () => 'thinmansoftware/lspro-react',
      resolveHeadSha: async () => 'fixed-head',
      resolveDiff: async () => '+++ b/src/x.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n',
    };
    // Node A: clean prompt -> pinned on opr.
    const a = await applyOpenRouterReviewFence({
      ...baseParams(h, {}),
      nodeId: 'node-a',
      finalPrompt: 'Review the diff, please.',
      scanText,
      gitProbes,
    });
    expect(a.rerouted).toBe(false);
    expect(a.privacyPin).toBe(true);
    // Node B: prompt carries a stripe id -> rerouted, even though the cached
    // repository diff is clean.
    const b = await applyOpenRouterReviewFence({
      ...baseParams(h, {}),
      nodeId: 'node-b',
      finalPrompt: 'Review but note cus_N1x2Y3z4W5v6 appears here.',
      scanText,
      gitProbes,
    });
    expect(b.rerouted).toBe(true);
    expect(b.verdict).toBe('hit');
    expect(b.hitKinds).toContain('stripe_id');
    // Diff scanned once (cache hit for B); prompt scanned twice.
    expect(diffCalls).toBe(1);
    expect(promptCalls).toBe(2);
  });
});

describe('emitNoPrivateEndpointReroute (Test 8)', () => {
  test('Test 8: classifier + reroute to a non-OpenRouter seat, event recorded', async () => {
    expect(isNoPrivateEndpointError('No endpoints found matching your data policy')).toBe(true);
    const h = makeHarness();
    const reroute = await emitNoPrivateEndpointReroute({
      deps: h.deps,
      workflowRun: RUN,
      nodeId: 'diff-review',
      provider: 'opr',
      repo: 'thinmansoftware/lspro-react',
      failoverTarget: null,
    });
    expect(reroute.routedProvider).toBe('codex-native-strict');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.data.reason).toBe('openrouter_no_private_endpoint');
    expect(h.events[0]?.data.routed_provider).toBe('codex-native-strict');
  });

  test('Test 8: a declared non-OpenRouter failover is honored (no unpinned retry anywhere)', async () => {
    const h = makeHarness();
    const reroute = await emitNoPrivateEndpointReroute({
      deps: h.deps,
      workflowRun: RUN,
      nodeId: 'diff-review',
      provider: 'codex-opr',
      repo: 'thinmansoftware/shopops',
      failoverTarget: { provider: 'codex-native', model: 'gpt-5.3-codex', agent: undefined },
    });
    expect(reroute.routedProvider).toBe('codex-native');
    expect(reroute.routedModel).toBe('gpt-5.3-codex');
  });
});
