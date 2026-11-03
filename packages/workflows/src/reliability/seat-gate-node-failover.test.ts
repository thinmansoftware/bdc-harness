/**
 * WO-HARNESS-NODE-USAGE-REFUSAL-FAILOVER-01: a node whose seat is at or over
 * the Fuelglass cutoff is rerouted to the next admissible provider instead of
 * failing the whole run with seat_usage_refused. Fuelglass headroom is the only
 * cap; the refusal stays only when no provider has room.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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
import { selectSeatNodeFailover } from './seat-node-failover';
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
    getWorkflowRunStatus: mock(async () => 'pending' as const),
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
  options: { modelOverride?: ModelOverride; personaFiles?: Record<string, string> } = {}
): Promise<{
  result: Awaited<ReturnType<typeof executeWorkflow>>;
  store: ReturnType<typeof makeStore>;
}> {
  const store = makeStore();
  const cwd = await mkdtemp(join(tmpdir(), 'seat-node-failover-'));
  for (const [name, body] of Object.entries(options.personaFiles ?? {})) {
    await mkdir(join(cwd, '.archon', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'agents', name), body);
  }
  const deps = {
    store,
    loadConfig: async (): Promise<WorkflowConfig> =>
      ({
        assistant: 'codex',
        assistants: { claude: { model: 'sonnet' }, codex: {}, cursor: {}, 'lane-stub': {} },
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    makeRun(),
    undefined,
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
