/**
 * WO-HARNESS-NODE-USAGE-REFUSAL-FAILOVER-01: a node whose seat is at or over
 * the Fuelglass cutoff is rerouted to the next admissible provider instead of
 * failing the whole run with seat_usage_refused. Fuelglass headroom is the only
 * cap; the refusal stays only when no provider has room.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearRegistry,
  getProviderCapabilities,
  registerBuiltinProviders,
  registerCommunityProviders,
  registerProvider,
} from '@archon/providers';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '@archon/providers/types';
import { rootLogger } from '@archon/paths';
import { executeWorkflow } from '../executor';
import { parseWorkflow } from '../loader';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '../deps';
import type { IWorkflowStore } from '../store';
import type { DagNode, WorkflowDefinition, WorkflowRun } from '../schemas';
import {
  resetSeatUsageCacheForTests,
  setSeatAlertSendForTests,
  setSeatCutoffOverride,
  setSeatUsageReaderForTests,
  unknownSeatReading,
  type SeatReading,
} from './seat-usage';
import {
  DEFAULT_CLAUDE_FAILOVER_MODEL,
  REVIEW_FAILOVER_CLAUDE_REFUSED_D0,
  selectSeatNodeFailover,
} from './seat-node-failover';
import type { ModelOverride } from '../model-override';

const LANE = 'stub-reroute-lane';
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const dispatched: string[] = [];
interface Invocation {
  provider: string;
  prompt: string;
  model: string | undefined;
  systemPrompt: string | undefined;
  disallowedTools: string[] | undefined;
}
const invocations: Invocation[] = [];
const streamSym = Object.getOwnPropertySymbols(rootLogger).find(
  sym => sym.description === 'pino.stream'
);
if (!streamSym) throw new Error('pino stream symbol not found on rootLogger');
const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
  streamSym
];
const origWrite = stream.write.bind(stream);

function reading(seat: SeatReading['seat'], windowName: string, used: number): SeatReading {
  return {
    seat,
    limit_source: 'measured',
    windows: [
      {
        name: windowName,
        used_percent: used,
        remaining_percent: 100 - used,
        resets_at: '2026-11-02T00:00:00Z',
      },
    ],
    seven_day:
      seat === 'cursor'
        ? 'NOT_APPLICABLE'
        : { used_percent: used, remaining_percent: 100 - used, resets_at: '2026-11-02T00:00:00Z' },
    gate_windows:
      seat === 'claude'
        ? ['five_hour', 'seven_day']
        : seat === 'cursor'
          ? ['monthly']
          : ['primary', 'secondary'],
    note: '',
    probed_at: '2026-11-01T00:00:00Z',
    endpoint: 'https://example.invalid',
    limit_reached: false,
  };
}

function makeRun(): WorkflowRun {
  return {
    id: 'run-node-failover',
    workflow_name: LANE,
    conversation_id: 'conv-1',
    status: 'pending',
    started_at: new Date().toISOString(),
    metadata: {},
  };
}

function makeStore(): IWorkflowStore & {
  createWorkflowEvent: ReturnType<typeof mock>;
  failWorkflowRun: ReturnType<typeof mock>;
} {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => makeRun()),
    getWorkflowRunStatus: mock(async () => 'running' as const),
    createWorkflowEvent: mock(async () => {}),
    listProviderAttempts: mock(async () => []),
    createProviderAttempt: mock(async () => true),
    completeProviderAttempt: mock(async () => true),
    listWorkflowEvents: mock(async () => []),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    createRunAuthority: mock(async () => 'created' as const),
    getRunAuthority: mock(async () => null),
  } as unknown as IWorkflowStore & {
    createWorkflowEvent: ReturnType<typeof mock>;
    failWorkflowRun: ReturnType<typeof mock>;
  };
}

function provider(id = 'claude'): IAgentProvider {
  return {
    getType: () => id,
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    sendQuery: async function* (
      prompt: string,
      _cwd: string,
      _resume?: string,
      options?: SendQueryOptions
    ): AsyncGenerator<MessageChunk> {
      if (prompt.startsWith('review-')) dispatched.push(id);
      if (prompt.startsWith('review-')) {
        invocations.push({
          provider: id,
          prompt,
          model: options?.model,
          systemPrompt: options?.systemPrompt,
          disallowedTools: options?.disallowedTools,
        });
      }
      yield { type: 'assistant', content: 'OK' };
    },
  };
}

/**
 * Registry with exactly the seat providers claude, codex, cursor (registry
 * order) plus a text-only unmapped lane provider that cannot run repository
 * nodes, so it is never an admissible reroute target.
 */
function useSeatRegistry(): void {
  registerBuiltinProviders();
  const full = getProviderCapabilities('codex');
  const textOnly: ProviderCapabilities = {
    ...full,
    execution: { text: true, repositoryRead: false, repositoryWrite: false, shell: false },
  };
  clearRegistry();
  for (const id of ['claude', 'codex', 'cursor']) {
    registerProvider({
      id,
      displayName: id,
      factory: provider,
      capabilities: full,
      builtIn: true,
    });
  }
  registerProvider({
    id: 'lane-stub',
    displayName: 'lane-stub',
    factory: provider,
    capabilities: textOnly,
    builtIn: false,
  });
}

const PERSONA = [
  '---',
  'name: reroute-claude-persona',
  'model: sonnet',
  'tools: [Read, Grep]',
  'description: reroute test persona',
  '---',
  '',
  'REROUTE-PERSONA-INSTRUCTIONS: keep this system prompt on the rerouted node.',
  '',
].join(LF);

function claudeNodes(extra: Record<string, unknown> = {}): DagNode[] {
  return ['review-a', 'review-b'].map(
    id => ({ id, prompt: id, provider: 'claude', model: 'sonnet', ...extra }) as DagNode
  );
}

function stubLane(laneProvider: string, nodes: DagNode[]): WorkflowDefinition {
  return {
    name: LANE,
    description: 'stub reroute lane',
    provider: laneProvider,
    mutates_checkout: false,
    nodes,
  };
}

async function run(
  wf: WorkflowDefinition,
  options: {
    modelOverride?: ModelOverride;
    personaFiles?: Record<string, string>;
    assistants?: Record<string, { model?: string }>;
    /** Make cwd a git repo with this origin remote (OpenRouter review fence identity). */
    gitRemote?: string;
  } = {}
): Promise<{
  result: Awaited<ReturnType<typeof executeWorkflow>>;
  store: ReturnType<typeof makeStore>;
}> {
  const store = makeStore();
  const cwd = await mkdtemp(join(tmpdir(), 'seat-node-failover-'));
  if (options.gitRemote !== undefined) {
    execFileSync('git', ['-C', cwd, 'init', '-q']);
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', options.gitRemote]);
  }
  for (const [name, body] of Object.entries(options.personaFiles ?? {})) {
    await mkdir(join(cwd, '.archon', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'agents', name), body);
  }
  const deps = {
    store,
    loadConfig: async (): Promise<WorkflowConfig> =>
      ({
        assistant: 'codex',
        assistants: options.assistants ?? {
          claude: { model: 'sonnet' },
          codex: {},
          cursor: {},
          'lane-stub': {},
        },
        commands: { folder: '' },
        baseBranch: 'dev',
      }) as WorkflowConfig,
    getAgentProvider: (id: string) => provider(id),
  } as unknown as WorkflowDeps;
  const platform = {
    sendMessage: async () => {},
    getPlatformType: () => 'test',
    getStreamingMode: () => 'batch',
  } as unknown as IWorkflowPlatform;
  const result = await executeWorkflow(
    deps,
    platform,
    'conv-1',
    cwd,
    wf,
    'hello',
    'db-conv-1',
    undefined, // codebaseId
    undefined, // issueContext
    undefined, // isolationContext
    undefined, // parentConversationId
    makeRun(), // preCreatedRun
    undefined, // authoritySource
    options.modelOverride
  );
  return { result, store };
}

type Recorded = { event_type: string; step_name?: string; data: Record<string, unknown> };

function events(store: ReturnType<typeof makeStore>, type: string): Recorded[] {
  return store.createWorkflowEvent.mock.calls
    .map(call => call[0] as Recorded)
    .filter(event => event.event_type === type);
}

beforeEach(() => {
  warnings.length = 0;
  dispatched.length = 0;
  invocations.length = 0;
  clearRegistry();
  useSeatRegistry();
  resetSeatUsageCacheForTests();
  setSeatAlertSendForTests(async () => null);
  setSeatCutoffOverride(90);
  stream.write = (chunk: string): boolean => {
    for (const line of String(chunk).split(String.fromCharCode(10))) {
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.level === 40 && typeof obj.msg === 'string') warnings.push({ obj, msg: obj.msg });
      } catch {
        // not a log line
      }
    }
    return origWrite(chunk);
  };
});

afterEach(() => {
  stream.write = origWrite;
  resetSeatUsageCacheForTests();
  setSeatCutoffOverride(null);
  clearRegistry();
});

describe('node-level seat reroute', () => {
  test('codex_lane_has_no_claude_node', () => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
    const root = join(__dirname, '..', '..', '..', '..');
    const file = join(
      root,
      '.archon',
      'workflows',
      'defaults',
      'bdc-feature-development-codex.yaml'
    );
    const parsed = parseWorkflow(readFileSync(file, 'utf8'), 'bdc-feature-development-codex.yaml');
    if (parsed.error) throw new Error(JSON.stringify(parsed.error));
    const wf = parsed.workflow;
    const laneProvider = wf.provider ?? 'codex';
    const effective = wf.nodes.map(node => ({
      id: node.id,
      provider: (node as { provider?: string }).provider ?? laneProvider,
      persona: (node as { persona?: string }).persona ?? (node as { agent?: string }).agent,
    }));
    expect(effective.filter(node => node.provider === 'claude')).toEqual([]);
    // build-manifest parses as a legacy_prompt node without provider fields, so the
    // five node headers are checked on the YAML text itself.
    const text = readFileSync(file, 'utf8').split(CRLF).join(LF);
    // Explicit GPT-6.1 pins from origin/dev (GPT-6.1 family runs on Codex);
    // build-manifest is mechanical and carries no model pin.
    const expectedModels: Record<string, string | null> = {
      'check-already-satisfied': 'gpt-6.1-terra',
      plan: 'gpt-6.1-terra',
      'apply-suggested-fix': 'gpt-6.1-sol',
      'decide-push-target': 'gpt-6.1-sol',
      'build-manifest': null,
    };
    for (const [id, model] of Object.entries(expectedModels)) {
      const start = text.indexOf(`  - id: ${id}${LF}`);
      expect(start).toBeGreaterThan(-1);
      const header = text.slice(start, text.indexOf('depends_on:', start));
      expect(header).toContain('provider: codex');
      expect(header).toContain('-opr' + LF);
      expect(header).toContain('persona: ');
      if (model === null) expect(header).not.toContain('model:');
      else expect(header).toContain(`model: ${model}${LF}`);
      expect(text.slice(start, start + 2000)).toContain('depends_on: [');
    }
    const plan = wf.nodes.find(entry => entry.id === 'plan') as { when?: string };
    expect(plan.when).toBe("$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'");
    const apply = wf.nodes.find(entry => entry.id === 'apply-suggested-fix') as { when?: string };
    expect(apply.when).toContain('approve_with_fix');
  });

  test('claude_seat_at_cutoff_reroutes_instead_of_failing_the_run', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
    }));
    const { result, store } = await run(stubLane('codex', claudeNodes()));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const failovers = events(store, 'node_failover');
    expect(failovers.map(event => event.step_name).sort()).toEqual(['review-a', 'review-b']);
    for (const event of failovers) {
      expect(event.data.to_provider).toBe('codex');
      expect(event.data.from_provider).toBe('claude');
      expect(event.data.reason_code).toBe('seat_over_cutoff');
    }
    expect(events(store, 'dag_workflow_failed')).toEqual([]);
    expect(dispatched).not.toContain('claude');
  });

  test('next_admissible_candidate_is_chosen', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 10),
    }));
    const { result, store } = await run(stubLane('lane-stub', claudeNodes()));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const failovers = events(store, 'node_failover');
    expect(failovers).toHaveLength(2);
    for (const event of failovers) expect(event.data.to_provider).toBe('cursor');

    const hasHeadroom = (providerId: string): boolean => providerId === 'cursor';
    const chosen = selectSeatNodeFailover({
      node: claudeNodes()[0],
      currentProvider: 'claude',
      hasHeadroom,
    });
    expect(chosen).toBe('cursor');
  });

  test('refusal_remains_only_when_no_provider_has_room', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 96),
    }));
    const { result, store } = await run(stubLane('lane-stub', claudeNodes()));
    const detail = `seat_usage_refused:claude:seven_day:96:90:lane=${LANE}:role=node`;
    expect(result.success).toBe(false);
    expect(result.error).toBe(detail);
    expect(events(store, 'node_failover')).toEqual([]);
    const failed = events(store, 'dag_workflow_failed').find(
      event => event.data.reason === 'seat_usage_refused'
    );
    expect(failed?.data).toEqual({
      reason: 'seat_usage_refused',
      detail,
      lane: LANE,
      role: 'node',
    });
    expect(
      selectSeatNodeFailover({
        node: claudeNodes()[0],
        currentProvider: 'claude',
        hasHeadroom: () => false,
      })
    ).toBeNull();
  });

  test('unknown_reading_never_refuses_or_reroutes', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: unknownSeatReading('claude', 'probe failed'),
      codex: reading('codex', 'primary', 10),
    }));
    const { result, store } = await run(stubLane('codex', claudeNodes()));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(events(store, 'node_failover')).toEqual([]);
    expect(warnings.some(entry => entry.msg === 'workflow.seat_usage_unknown')).toBe(true);
  });

  test('declared_failover_still_wins', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
      cursor: reading('cursor', 'monthly', 10),
    }));
    // Registry order is claude, codex, cursor: codex would win a runtime pick,
    // so the declared cursor failover proves the declared route is honoured first.
    const nodes = claudeNodes({ failover_provider: 'cursor' });
    const { store } = await run(stubLane('lane-stub', nodes));
    const failovers = events(store, 'node_failover');
    expect(failovers).toHaveLength(2);
    for (const event of failovers) expect(event.data.to_provider).toBe('cursor');
    expect(
      selectSeatNodeFailover({
        node: nodes[0],
        currentProvider: 'claude',
        hasHeadroom: () => true,
      })
    ).toBe('cursor');
  });

  test('lane_seat_refusal_is_unchanged', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 96),
    }));
    const { result, store } = await run(stubLane('codex', claudeNodes()));
    const detail = `seat_usage_refused:codex:primary:96:90:lane=${LANE}:role=lane`;
    expect(result.success).toBe(false);
    expect(result.error).toBe(detail);
    expect(events(store, 'node_failover')).toEqual([]);
    const failed = events(store, 'dag_workflow_failed').find(
      event => event.data.reason === 'seat_usage_refused'
    );
    expect(failed?.data.role).toBe('lane');
  });
  test('rerouted_persona_node_dispatches_on_the_new_provider', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
    }));
    const { result, store } = await run(
      stubLane('codex', claudeNodes({ agent: 'reroute-claude-persona' })),
      {
        personaFiles: { 'reroute-claude-persona.md': PERSONA },
      }
    );
    expect(result.error ?? '').not.toContain('InfrastructureClassBlock');
    expect(result.error ?? '').not.toContain('must not declare');
    expect(result.error ?? '').not.toContain('must declare');
    expect(events(store, 'node_failover')).toHaveLength(2);
    const review = invocations.filter(call => call.prompt.startsWith('review-'));
    expect(review.map(call => call.provider).sort()).toEqual(['codex', 'codex']);
    for (const call of review) {
      // The persona's Anthropic model pin never reaches the codex provider.
      expect(call.model).toBeUndefined();
      // Instructions and tool restrictions survive the reroute.
      expect(call.systemPrompt ?? '').toContain('REROUTE-PERSONA-INSTRUCTIONS');
    }
  });

  test('rerouted_node_dispatches_declared_failover_model', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
    }));
    await run(
      stubLane(
        'codex',
        claudeNodes({ failover_provider: 'codex', failover_model: 'failover-target-model' })
      )
    );
    const review = invocations.filter(call => call.prompt.startsWith('review-'));
    expect(review.map(call => call.provider).sort()).toEqual(['codex', 'codex']);
    for (const call of review) expect(call.model).toBe('failover-target-model');
  });

  test('failover_agent_ignored_when_declared_provider_not_selected', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
      cursor: reading('cursor', 'monthly', 96),
    }));
    const other = PERSONA.replace(
      'name: reroute-claude-persona',
      'name: other-failover-persona'
    ).replace('REROUTE-PERSONA-INSTRUCTIONS', 'OTHER-FAILOVER-INSTRUCTIONS');
    const { store } = await run(
      stubLane(
        'codex',
        claudeNodes({
          agent: 'reroute-claude-persona',
          failover_provider: 'cursor',
          failover_agent: 'other-failover-persona',
        })
      ),
      {
        personaFiles: {
          'reroute-claude-persona.md': PERSONA,
          'other-failover-persona.md': other,
        },
      }
    );
    const failovers = events(store, 'node_failover');
    expect(failovers).toHaveLength(2);
    for (const event of failovers) expect(event.data.to_provider).toBe('codex');
    const review = invocations.filter(call => call.prompt.startsWith('review-'));
    expect(review.map(call => call.provider).sort()).toEqual(['codex', 'codex']);
    for (const call of review) {
      // The declared cursor route was exhausted, so its persona must not replace the original.
      expect(call.systemPrompt ?? '').toContain('REROUTE-PERSONA-INSTRUCTIONS');
      expect(call.systemPrompt ?? '').not.toContain('OTHER-FAILOVER-INSTRUCTIONS');
    }
  });

  test('rerouted_node_uses_reroute_target_not_user_model_override', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
    }));
    const modelOverride: ModelOverride = {
      nodes: { 'review-a': { provider: 'claude', model: 'override-model' } },
    };
    const { store } = await run(stubLane('codex', claudeNodes()), { modelOverride });
    expect(
      events(store, 'node_failover')
        .map(event => event.step_name)
        .sort()
    ).toEqual(['review-a', 'review-b']);
    const reviewA = invocations.filter(call => call.prompt === 'review-a');
    // The override pinned the exhausted claude provider; it must not win over the route.
    expect(reviewA.map(call => call.provider)).toEqual(['codex']);
    expect(reviewA[0]?.model).toBeUndefined();
    expect(invocations.filter(call => call.provider === 'claude')).toEqual([]);
  });
});

/**
 * WO-HARNESS-CODEX-CREDITS-HEADROOM-WHEN-WINDOW-EXHAUSTED-01: run 8849e767 on
 * 2026-11-04 (cursor lane) failed six codex-native-strict nodes over to claude
 * with seat_over_cutoff while codex had purchased credits. With the live
 * reading (primary 100, limit_reached true, allowed false, credits) the nodes
 * stay on codex.
 */
describe('codex reviewer nodes at limit with credits', () => {
  test('Test 2: cursor lane codex-native-strict nodes are not failed over', async () => {
    registerProvider({
      id: 'codex-native-strict',
      displayName: 'codex-native-strict',
      factory: () => provider('codex-native-strict'),
      capabilities: getProviderCapabilities('codex'),
      builtIn: true,
    });
    setSeatCutoffOverride(95);
    setSeatUsageReaderForTests(async () => ({
      cursor: reading('cursor', 'monthly', 20),
      claude: reading('claude', 'seven_day', 10),
      codex: {
        ...reading('codex', 'primary', 100),
        limit_reached: true,
        allowed: false,
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false },
      },
    }));
    const nodes = ['review-diff', 'review-security'].map(
      id => ({ id, prompt: id, provider: 'codex-native-strict' }) as DagNode
    );
    const { result, store } = await run(stubLane('cursor', nodes));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(
      events(store, 'node_failover').filter(event => event.data.reason_code === 'seat_over_cutoff')
    ).toEqual([]);
    expect(dispatched).toContain('codex-native-strict');
    expect(dispatched).not.toContain('claude');
  });
});

/**
 * WO-HARNESS-PERSONA-MODEL-DECLARED-01. Board decision D0 (M-20261021c): a
 * review node never reroutes to Claude. A NON-review node rerouted to Claude
 * always runs on an allowed Claude model.
 */
const MODEL_LESS_PERSONA = [
  '---',
  'name: model-less-persona',
  'tools: [Read, Grep]',
  'description: persona with no model pin, like captain-ci-validator-codex',
  '---',
  '',
  'MODEL-LESS-PERSONA-INSTRUCTIONS',
  '',
].join(LF);

const OPR_REVIEWER_PERSONA = [
  '---',
  'name: opr-adversarial-reviewer',
  'description: stub of the shipped openrouter review persona',
  '---',
  '',
  'OPR-REVIEWER-INSTRUCTIONS',
  '',
].join(LF);

const MODEL_DECLARE_ERROR = "Claude persona 'model-less-persona' must declare a 'model:'";

/** Assistants config with NO claude model, like the live config.yaml. */
const NO_CLAUDE_MODEL = { claude: {}, codex: {}, cursor: {}, 'lane-stub': {} };

function codexNode(id: string, extra: Record<string, unknown> = {}): DagNode {
  return { id, prompt: `review-${id}`, provider: 'codex', ...extra } as DagNode;
}

function registerOpenRouterStub(): void {
  registerProvider({
    id: 'openrouter',
    displayName: 'openrouter',
    factory: provider,
    capabilities: getProviderCapabilities('codex'),
    builtIn: false,
  });
}

describe('review seats never fall back to claude (D0)', () => {
  test('review_to_claude_fails_closed', async () => {
    // Codex over the cutoff, claude with headroom, cursor over the cutoff: the only
    // admissible target is claude, which D0 bars for a review node.
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 96),
    }));
    const detail =
      `seat_usage_refused:codex:primary:96:90:lane=${LANE}:role=node` +
      `:reason=${REVIEW_FAILOVER_CLAUDE_REFUSED_D0}:node=diff-review`;
    const cases: Record<string, DagNode> = {
      'A no declared failover': codexNode('diff-review'),
      'B declared claude failover': codexNode('diff-review', {
        failover_provider: 'claude',
        failover_model: 'claude-sonnet-5-5',
      }),
    };
    for (const [label, node] of Object.entries(cases)) {
      invocations.length = 0;
      const { result, store } = await run(stubLane('lane-stub', [node]));
      expect({ label, success: result.success, error: result.error }).toEqual({
        label,
        success: false,
        error: detail,
      });
      expect(events(store, 'node_failover')).toEqual([]);
      const failed = events(store, 'dag_workflow_failed').find(
        event => event.data.reason === 'seat_usage_refused'
      );
      expect(failed?.data).toEqual({
        reason: 'seat_usage_refused',
        detail,
        lane: LANE,
        role: 'node',
        reason_code: REVIEW_FAILOVER_CLAUDE_REFUSED_D0,
        review_node_id: 'diff-review',
      });
      // Never dispatched on claude.
      expect(invocations.filter(call => call.provider === 'claude')).toEqual([]);
      // The selector itself never returns claude for a review node, even when
      // claude is the only provider with headroom, or is declared.
      expect(
        selectSeatNodeFailover({
          node,
          currentProvider: 'codex',
          hasHeadroom: id => id === 'claude',
        })
      ).toBeNull();
      expect(
        selectSeatNodeFailover({
          node,
          currentProvider: 'codex',
          workflowFailoverProvider: 'claude',
          hasHeadroom: () => true,
        })
      ).toBe('cursor');
    }
  });

  test('review_declared_non_claude_failover_still_routes', async () => {
    registerOpenRouterStub();
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 96),
    }));
    const node = codexNode('diff-review', {
      agent: 'model-less-persona',
      failover_provider: 'openrouter',
      failover_model: 'moonshotai/kimi-k3.1-pro',
      failover_agent: 'opr-adversarial-reviewer',
    });
    const { result, store } = await run(stubLane('lane-stub', [node]), {
      assistants: NO_CLAUDE_MODEL,
      personaFiles: {
        'model-less-persona.md': MODEL_LESS_PERSONA,
        'opr-adversarial-reviewer.md': OPR_REVIEWER_PERSONA,
      },
      // A non-customer repo: the OpenRouter review fence does not apply, so the
      // dispatch stays on the declared openrouter route.
      gitRemote: 'https://github.com/example/not-a-customer-repo.git',
    });
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const failovers = events(store, 'node_failover');
    expect(failovers.map(event => event.data)).toEqual([
      {
        node_id: 'diff-review',
        from_provider: 'codex',
        to_provider: 'openrouter',
        reason_code: 'seat_over_cutoff',
      },
    ]);
    const review = invocations.filter(call => call.prompt === 'review-diff-review');
    expect(review.map(call => [call.provider, call.model])).toEqual([
      ['openrouter', 'moonshotai/kimi-k3.1-pro'],
    ]);
    expect(review[0]?.systemPrompt ?? '').toContain('OPR-REVIEWER-INSTRUCTIONS');
    expect(invocations.filter(call => call.provider === 'claude')).toEqual([]);
  });

  test('non_review_claude_reroute_gets_default_model', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 96),
    }));
    const personaFiles = { 'model-less-persona.md': MODEL_LESS_PERSONA };
    const cases: Array<{
      label: string;
      node: DagNode;
      assistants: Record<string, { model?: string }>;
      model: string;
    }> = [
      {
        label: 'A no failover_model, no assistants.claude.model',
        node: codexNode('plan', { agent: 'model-less-persona' }),
        assistants: NO_CLAUDE_MODEL,
        model: DEFAULT_CLAUDE_FAILOVER_MODEL,
      },
      {
        label: 'B declared failover_model wins',
        node: codexNode('plan', {
          agent: 'model-less-persona',
          failover_provider: 'claude',
          failover_model: 'claude-haiku-5-5',
        }),
        assistants: NO_CLAUDE_MODEL,
        model: 'claude-haiku-5-5',
      },
      {
        label: 'C configured assistants.claude.model wins',
        node: codexNode('plan', { agent: 'model-less-persona' }),
        assistants: { ...NO_CLAUDE_MODEL, claude: { model: 'opus' } },
        model: 'opus',
      },
    ];
    // The default claude lane's model (bdc-feature-development.yaml line 21).
    expect(DEFAULT_CLAUDE_FAILOVER_MODEL).toBe('claude-sonnet-5-5');
    for (const entry of cases) {
      invocations.length = 0;
      const { result, store } = await run(stubLane('lane-stub', [entry.node]), {
        assistants: entry.assistants,
        personaFiles,
      });
      expect(result.error ?? '').not.toContain(MODEL_DECLARE_ERROR);
      expect(result.error ?? '').not.toContain('seat_usage_refused');
      expect(events(store, 'node_failover').map(event => event.data)).toEqual([
        {
          node_id: 'plan',
          from_provider: 'codex',
          to_provider: 'claude',
          reason_code: 'seat_over_cutoff',
        },
      ]);
      const plan = invocations.filter(call => call.prompt === 'review-plan');
      expect({ label: entry.label, calls: plan.map(call => [call.provider, call.model]) }).toEqual({
        label: entry.label,
        calls: [['claude', entry.model]],
      });
      expect(plan[0]?.systemPrompt ?? '').toContain('MODEL-LESS-PERSONA-INSTRUCTIONS');
    }

    // A reroute to a non-claude provider keeps today's model choice (no claude default).
    invocations.length = 0;
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 96),
      cursor: reading('cursor', 'monthly', 10),
    }));
    const { store } = await run(stubLane('lane-stub', [codexNode('plan')]), {
      assistants: NO_CLAUDE_MODEL,
    });
    expect(events(store, 'node_failover')[0]?.data.to_provider).toBe('cursor');
    const plan = invocations.filter(call => call.prompt === 'review-plan');
    expect(plan.map(call => [call.provider, call.model])).toEqual([['cursor', undefined]]);
  });

  test('rerouted_non_review_persona_resolves_a_model_in_both_dispatch_paths', async () => {
    // No seat is over the cutoff: the per-node override { provider: 'claude' } with
    // no model reaches the persona binding in dag-executor directly (DAG path and
    // loop path), with an assistants config that has no claude model.
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 10),
      cursor: reading('cursor', 'monthly', 10),
    }));
    const personaFiles = { 'model-less-persona.md': MODEL_LESS_PERSONA };
    const dagNode = codexNode('plan', { agent: 'model-less-persona' });
    const loopNode = {
      id: 'implement',
      provider: 'codex',
      agent: 'model-less-persona',
      loop: { prompt: 'review-loop-implement', until: 'LOOP_DONE', max_iterations: 1 },
    } as unknown as DagNode;
    const modelOverride: ModelOverride = {
      nodes: { plan: { provider: 'claude' }, implement: { provider: 'claude' } },
    };
    const { result } = await run(stubLane('lane-stub', [dagNode, loopNode]), {
      assistants: NO_CLAUDE_MODEL,
      personaFiles,
      modelOverride,
    });
    expect(result.error ?? '').not.toContain(MODEL_DECLARE_ERROR);
    const dag = invocations.filter(call => call.prompt === 'review-plan');
    expect(dag.map(call => [call.provider, call.model])).toEqual([
      ['claude', DEFAULT_CLAUDE_FAILOVER_MODEL],
    ]);
    const loop = invocations.filter(call => call.prompt.startsWith('review-loop-implement'));
    expect(loop.length).toBeGreaterThan(0);
    for (const call of loop) {
      expect([call.provider, call.model]).toEqual(['claude', DEFAULT_CLAUDE_FAILOVER_MODEL]);
    }

    // A REVIEW node with the same input gets no default: it still fails closed.
    invocations.length = 0;
    const review = await run(
      stubLane('lane-stub', [codexNode('diff-review', { agent: 'model-less-persona' })]),
      {
        assistants: NO_CLAUDE_MODEL,
        personaFiles,
        modelOverride: { nodes: { 'diff-review': { provider: 'claude' } } },
      }
    );
    expect(invocations.filter(call => call.provider === 'claude')).toEqual([]);
    const failed = review.store.createWorkflowEvent.mock.calls
      .map(call => JSON.stringify(call[0]))
      .join(' ');
    expect(`${review.result.error ?? ''} ${failed}`).toContain(MODEL_DECLARE_ERROR);
  });

  test('non_rerouted_claude_node_with_model_less_persona_still_fails_closed', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 10),
    }));
    const node = {
      id: 'plan',
      prompt: 'review-plan',
      provider: 'claude',
      agent: 'model-less-persona',
    } as DagNode;
    const { result, store } = await run(stubLane('lane-stub', [node]), {
      assistants: NO_CLAUDE_MODEL,
      personaFiles: { 'model-less-persona.md': MODEL_LESS_PERSONA },
    });
    expect(events(store, 'node_failover')).toEqual([]);
    expect(invocations.filter(call => call.provider === 'claude')).toEqual([]);
    const failed = store.createWorkflowEvent.mock.calls
      .map(call => JSON.stringify(call[0]))
      .join(' ');
    expect(`${result.error ?? ''} ${failed}`).toContain(MODEL_DECLARE_ERROR);
  });
});
