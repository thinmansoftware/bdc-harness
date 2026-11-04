/**
 * WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01: the run-start seat gate
 * evaluates the lane's OWN seat; a seat bound only by reviewer nodes refuses
 * only when those nodes have no failover target with headroom.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearRegistry,
  getRegisteredProviders,
  registerBuiltinProviders,
  registerProvider,
} from '@archon/providers';
import { registerGrokAgentProvider } from '@archon/providers/community/grok';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { rootLogger } from '@archon/paths';
import { executeWorkflow } from '../executor';
import { parseWorkflow } from '../loader';
import { validateWorkflowResources } from '../validator';
import { selectQuotaExhaustionRoute } from '../node-failover';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '../deps';
import type { IWorkflowStore } from '../store';
import type { DagNode, WorkflowDefinition, WorkflowRun } from '../schemas';
import {
  decideSeatGate,
  parseCodexCredits,
  resetSeatUsageCacheForTests,
  setSeatAlertSendForTests,
  setSeatCutoffOverride,
  seatForProvider,
  setSeatUsageReaderForTests,
  unknownSeatReading,
  type SeatReading,
} from './seat-usage';

const LANE = 'stub-claude-lane';
const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
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
        resets_at: '2026-10-28T00:00:00Z',
      },
    ],
    seven_day:
      seat === 'cursor'
        ? 'NOT_APPLICABLE'
        : { used_percent: used, remaining_percent: 100 - used, resets_at: '2026-10-28T00:00:00Z' },
    gate_windows: seat === 'claude' ? ['five_hour', 'seven_day'] : ['primary', 'secondary'],
    note: '',
    probed_at: '2026-10-27T00:00:00Z',
    endpoint: 'https://example.invalid',
    limit_reached: false,
  };
}

function makeRun(): WorkflowRun {
  return {
    id: 'run-lane-tier',
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

function provider(): IAgentProvider {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    sendQuery: async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'OK' };
    },
  };
}

/** Lane provider claude; one reviewer node on codex-native-strict. */
function stubLane(withFailover: boolean): WorkflowDefinition {
  const reviewer = {
    id: 'diff-review',
    prompt: 'review',
    provider: 'codex-native-strict',
    model: 'gpt-5.6-terra',
    // The shipped lanes' review failover (D0: never Claude).
    ...(withFailover
      ? { failover_provider: 'openrouter', failover_model: 'moonshotai/kimi-k3.1-pro' }
      : {}),
  } as DagNode;
  return {
    name: LANE,
    description: 'stub claude lane',
    provider: 'claude',
    model: 'sonnet',
    mutates_checkout: false,
    nodes: [{ id: 'implement', prompt: 'build' } as DagNode, reviewer],
  };
}

async function run(wf: WorkflowDefinition): Promise<{
  result: Awaited<ReturnType<typeof executeWorkflow>>;
  store: ReturnType<typeof makeStore>;
}> {
  const store = makeStore();
  const cwd = await mkdtemp(join(tmpdir(), 'seat-lane-tier-'));
  const deps = {
    store,
    loadConfig: async (): Promise<WorkflowConfig> =>
      ({
        assistant: 'claude',
        assistants: { claude: { model: 'sonnet' }, 'codex-native-strict': {} },
        commands: { folder: '' },
        baseBranch: 'dev',
      }) as WorkflowConfig,
    getAgentProvider: () => provider(),
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
    makeRun()
  );
  return { result, store };
}

function failedEvents(
  store: ReturnType<typeof makeStore>
): Array<{ reason?: string; detail?: string; lane?: string; role?: string }> {
  return store.createWorkflowEvent.mock.calls
    .map(call => call[0] as { event_type: string; data: Record<string, string> })
    .filter(event => event.event_type === 'dag_workflow_failed')
    .map(event => event.data);
}

beforeEach(() => {
  warnings.length = 0;
  clearRegistry();
  registerBuiltinProviders();
  resetSeatUsageCacheForTests();
  setSeatAlertSendForTests(async () => null);
  setSeatCutoffOverride(90);
  // Capture at the shared pino stream, not via rootLogger.child: executor.ts
  // caches its child logger on first use, so a child wrapper installed here
  // would miss it when another test file in the same process created it first.
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
  clearRegistry();
});

describe('seat gate honors the fired lane tier', () => {
  test('claude_lane_dispatches_when_only_reviewer_node_seat_is_over_cutoff', async () => {
    // openrouter (the shipped review failover target) registers with the grok agent.
    registerGrokAgentProvider();
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 30),
      codex: reading('codex', 'primary', 96),
    }));
    const { result, store } = await run(stubLane(true));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(failedEvents(store).some(data => data.reason === 'seat_usage_refused')).toBe(false);
    const degraded = warnings.find(entry => entry.msg === 'workflow.seat_usage_node_degraded');
    expect(degraded?.obj.seat).toBe('codex');
    expect(degraded?.obj.nodeIds).toEqual(['diff-review']);
    expect(degraded?.obj.failoverProviders).toEqual(['openrouter']);
    expect(degraded?.obj.usedPercent).toBe(96);
    expect(degraded?.obj.lane).toBe(LANE);
  });

  test('lane_seat_over_cutoff_refuses_and_names_lane', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 96),
      codex: reading('codex', 'primary', 10),
    }));
    const { result, store } = await run(stubLane(true));
    const detail = 'seat_usage_refused:claude:seven_day:96:90:lane=stub-claude-lane:role=lane';
    expect(result.success).toBe(false);
    expect(result.error).toBe(detail);
    expect(store.failWorkflowRun).toHaveBeenCalledWith('run-lane-tier', detail);
    const event = failedEvents(store).find(data => data.reason === 'seat_usage_refused');
    expect(event).toEqual({ reason: 'seat_usage_refused', detail, lane: LANE, role: 'lane' });
    const log = warnings.find(entry => entry.msg === 'workflow.seat_usage_refused');
    expect(log?.obj.lane).toBe(LANE);
    expect(log?.obj.role).toBe('lane');
    expect(log?.obj.seat).toBe('claude');
  });

  test('node_seat_over_cutoff_without_failover_refuses_review_node_instead_of_claude', async () => {
    // WO-HARNESS-PERSONA-MODEL-DECLARED-01 (D0): claude (the lane seat) has room, but
    // diff-review is a review node, so it must NOT be rerouted to claude. With only
    // claude and codex-native-strict registered there is no other route, so the run
    // fails closed and names D0. (Before this WO the node was rerouted to claude.)
    const keep = getRegisteredProviders().filter(
      entry => entry.id === 'claude' || entry.id === 'codex-native-strict'
    );
    clearRegistry();
    for (const entry of keep) registerProvider(entry);
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 30),
      codex: reading('codex', 'primary', 96),
    }));
    const { result, store } = await run(stubLane(false));
    const detail =
      'seat_usage_refused:codex:primary:96:90:lane=stub-claude-lane:role=node' +
      ':reason=review_failover_claude_refused_d0:node=diff-review';
    expect(result.success).toBe(false);
    expect(result.error).toBe(detail);
    const rerouted = store.createWorkflowEvent.mock.calls
      .map(call => call[0] as { event_type: string })
      .filter(event => event.event_type === 'node_failover');
    expect(rerouted).toEqual([]);
    expect(failedEvents(store).find(data => data.reason === 'seat_usage_refused')).toEqual({
      reason: 'seat_usage_refused',
      detail,
      lane: LANE,
      role: 'node',
      reason_code: 'review_failover_claude_refused_d0',
      review_node_id: 'diff-review',
    });
  });

  test('node seat refuses when the failover target seat is itself over the cutoff', () => {
    const decision = decideSeatGate(
      [{ providerId: 'cursor' }, { providerId: 'codex-native-strict' }],
      {
        cursor: reading('cursor', 'monthly', 20),
        codex: reading('codex', 'primary', 96),
        claude: reading('claude', 'five_hour', 97),
      },
      90,
      {
        laneProvider: 'cursor',
        nodes: [
          { nodeId: 'implement', providerId: 'cursor' },
          { nodeId: 'diff-review', providerId: 'codex-native-strict', failoverProvider: 'claude' },
        ],
      }
    );
    // diff-review is a review node: its declared claude failover is never honored
    // (D0), so the refusal also names the D0 reason and the node.
    expect(decision).toEqual({
      refused: true,
      seat: 'codex',
      window: 'primary',
      usedPercent: 96,
      cutoffPercent: 90,
      unknownSeats: [],
      role: 'node',
      reason: 'review_failover_claude_refused_d0',
      reviewNodeId: 'diff-review',
    });
  });

  test('unknown_seat_never_refuses_and_decision_is_repeatable', () => {
    const bindings = [{ providerId: 'claude' }, { providerId: 'codex-native-strict' }];
    const readings = {
      claude: reading('claude', 'seven_day', 30),
      codex: unknownSeatReading('codex', 'probe failed'),
    };
    const scope = {
      laneProvider: 'claude',
      nodes: [
        { nodeId: 'implement', providerId: 'claude' },
        { nodeId: 'diff-review', providerId: 'codex-native-strict' },
      ],
    };
    const first = decideSeatGate(bindings, readings, 90, scope);
    const second = decideSeatGate(bindings, readings, 90, scope);
    expect(first).toEqual({ refused: false, unknownSeats: ['codex'], degradedSeats: [] });
    expect(second).toEqual(first);
  });
});

/**
 * Codex-native-strict reviewer nodes in the shipped claude and fable lanes.
 * Each must declare an eligible failover target or sit on the exception list
 * with its reason. The exception list is empty: every reviewer fails over to
 * Kimi K3.1 Pro on the repository-capable OpenRouter tool loop, never to
 * Claude (John Ranson 2026-10-27, "use kimi k3.1 it scored high"; ruling D0
 * on M-20261021c stands -- review seats never fall back to Claude).
 */
const REVIEWER_FAILOVER_EXCEPTIONS: Record<string, Record<string, string>> = {
  'bdc-feature-development.yaml': {},
  'bdc-feature-development-fable.yaml': {},
};

describe('shipped lane reviewer failover declarations', () => {
  const root = join(import.meta.dir, '..', '..', '..', '..');
  for (const file of Object.keys(REVIEWER_FAILOVER_EXCEPTIONS)) {
    test(`shipped_claude_and_fable_lane_yamls_declare_reviewer_failover: ${file}`, async () => {
      registerGrokAgentProvider();
      const content = readFileSync(join(root, '.archon/workflows/defaults', file), 'utf8');
      const parsed = parseWorkflow(content, file);
      if (!parsed.workflow) throw new Error(`${file} failed to load: ${parsed.error?.error}`);
      const exceptions = REVIEWER_FAILOVER_EXCEPTIONS[file] ?? {};
      const strict = parsed.workflow.nodes.filter(node => node.provider === 'codex-native-strict');
      expect(strict.map(node => node.id)).toEqual([
        'diff-review',
        'diff-review-final',
        'opus-rereview',
        'apply-diff-review-final',
      ]);
      for (const node of strict) {
        if ((exceptions[node.id] ?? '').length > 0) continue;
        const declared = node as {
          failover_provider?: string;
          failover_model?: string;
          failover_agent?: string;
        };
        expect({ node: node.id, provider: declared.failover_provider }).toEqual({
          node: node.id,
          provider: 'openrouter',
        });
        expect(declared.failover_model).toBe('moonshotai/kimi-k3.1-pro');
        expect(declared.failover_agent).toBe('opr-adversarial-reviewer');
        // The route the executor and the seat gate use must really fail over
        // (capability-eligible), and the target is not a gated seat.
        const route = selectQuotaExhaustionRoute('codex-native-strict', node, {});
        expect(route).toEqual({
          kind: 'failover',
          provider: 'openrouter',
          model: 'moonshotai/kimi-k3.1-pro',
        });
        expect(seatForProvider('openrouter')).toBeNull();
      }
      for (const id of Object.keys(exceptions)) {
        expect(strict.map(node => node.id)).toContain(id);
      }
      const issues = await validateWorkflowResources(parsed.workflow, root);
      expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    });
  }
});

/** Codex purchased credits (John Ranson 2026-10-27): Codex keeps billing past the window. */
describe('codex purchased credits', () => {
  function codexOnCredits(used: number, hasCredits: boolean): SeatReading {
    return {
      ...reading('codex', 'primary', used),
      allowed: true,
      credits: {
        has_credits: hasCredits,
        unlimited: false,
        overage_limit_reached: false,
        balance: '62363.5396780000',
      },
    };
  }

  test('codex window at 96 with has_credits=true dispatches and logs codex:on_credits', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 30),
      codex: codexOnCredits(96, true),
    }));
    // No reviewer failover: only the credits can let this run through.
    const { result, store } = await run(stubLane(false));
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(failedEvents(store).some(data => data.reason === 'seat_usage_refused')).toBe(false);
    const log = warnings.find(entry => entry.msg === 'workflow.seat_usage_on_credits');
    expect(log?.obj.detail).toBe('codex:on_credits');
    expect(log?.obj.lane).toBe(LANE);
    expect(warnings.some(entry => entry.msg === 'workflow.seat_usage_node_degraded')).toBe(false);
  });

  test('codex window at 96 with has_credits=false is not treated as credits and reroutes', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 30),
      codex: codexOnCredits(96, false),
    }));
    const { result, store } = await run(stubLane(false));
    // Without credits the codex seat is over the cutoff; the reviewer node is
    // rerouted to the claude lane seat, which has headroom.
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(warnings.some(entry => entry.msg === 'workflow.seat_usage_on_credits')).toBe(false);
    expect(
      store.createWorkflowEvent.mock.calls.some(
        call => (call[0] as { event_type: string }).event_type === 'node_failover'
      )
    ).toBe(true);
  });

  test('codex lane on credits is not refused on its own seat; overage blocked still refuses', () => {
    const scope = {
      laneProvider: 'codex',
      nodes: [{ nodeId: 'implement', providerId: 'codex' }],
    };
    const onCredits = decideSeatGate(
      [{ providerId: 'codex' }],
      { codex: codexOnCredits(96, true) },
      90,
      scope
    );
    expect(onCredits).toEqual({
      refused: false,
      unknownSeats: [],
      degradedSeats: [],
      onCredits: ['codex:on_credits'],
    });
    const blocked = decideSeatGate(
      [{ providerId: 'codex' }],
      {
        codex: {
          ...codexOnCredits(96, true),
          credits: { has_credits: true, unlimited: false, overage_limit_reached: true },
        },
      },
      90,
      scope
    );
    expect(blocked.refused).toBe(true);
    if (blocked.refused) expect(blocked.role).toBe('lane');
  });

  test('parseCodexCredits reads the usage endpoint credits object', () => {
    expect(
      parseCodexCredits({
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: '62363.5396780000',
        approx_local_messages: [15591, 81073],
      })
    ).toEqual({
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
      balance: '62363.5396780000',
    });
    expect(parseCodexCredits(undefined)).toBeUndefined();
    expect(parseCodexCredits({ balance: '1' })).toBeUndefined();
  });
});

/**
 * WO-HARNESS-CODEX-CREDITS-HEADROOM-WHEN-WINDOW-EXHAUSTED-01: the live Fuelglass
 * codex reading on 2026-11-04 was primary 100, limit_reached true and allowed
 * false with credits available, and the codex CLI still served a request in
 * that state (bdc-xo issue 4669, live proof). Credits count as headroom
 * whatever allowed and limit_reached say; exhausted or blocked credits still
 * refuse.
 */
describe('codex at limit with credits (allowed=false)', () => {
  function codexAtLimit(credits: Partial<NonNullable<SeatReading['credits']>>): SeatReading {
    return {
      ...reading('codex', 'primary', 100),
      limit_reached: true,
      allowed: false,
      credits: {
        has_credits: true,
        unlimited: false,
        overage_limit_reached: false,
        balance: '62106.88',
        ...credits,
      },
    };
  }

  /** Cursor lane whose reviewer nodes run on codex-native-strict. */
  const cursorLaneScope = (failoverProvider?: string): Parameters<typeof decideSeatGate>[3] => ({
    laneProvider: 'cursor',
    nodes: [
      { nodeId: 'implement', providerId: 'cursor' },
      {
        nodeId: 'diff-review',
        providerId: 'codex-native-strict',
        ...(failoverProvider ? { failoverProvider } : {}),
      },
      {
        nodeId: 'security-review',
        providerId: 'codex-native-strict',
        ...(failoverProvider ? { failoverProvider } : {}),
      },
    ],
  });

  test('Test 1: run-start gate admits codex at limit with credits', () => {
    const readings = { codex: codexAtLimit({}) };
    const unscoped = decideSeatGate([{ providerId: 'codex' }], readings, 95);
    expect(unscoped).toEqual({ refused: false, unknownSeats: [], onCredits: ['codex:on_credits'] });
    const scoped = decideSeatGate([{ providerId: 'codex' }], readings, 95, {
      laneProvider: 'codex',
      nodes: [{ nodeId: 'implement', providerId: 'codex' }],
    });
    expect(scoped.refused).toBe(false);
    expect(scoped.onCredits).toContain('codex:on_credits');
  });

  test('Test 2: node gate does not fail nodes over when codex is on credits', () => {
    const decision = decideSeatGate(
      [{ providerId: 'cursor' }, { providerId: 'codex-native-strict' }],
      {
        cursor: reading('cursor', 'monthly', 20),
        claude: reading('claude', 'seven_day', 10),
        codex: codexAtLimit({}),
      },
      95,
      cursorLaneScope('claude')
    );
    expect(decision).toEqual({
      refused: false,
      unknownSeats: [],
      degradedSeats: [],
      onCredits: ['codex:on_credits'],
    });
  });

  test('Test 3: codex on credits is a valid failover target', () => {
    const decision = decideSeatGate(
      [{ providerId: 'cursor' }, { providerId: 'claude' }],
      {
        cursor: reading('cursor', 'monthly', 20),
        claude: reading('claude', 'seven_day', 97),
        codex: codexAtLimit({}),
      },
      95,
      {
        laneProvider: 'cursor',
        nodes: [
          { nodeId: 'implement', providerId: 'cursor' },
          { nodeId: 'diff-review', providerId: 'claude', failoverProvider: 'codex-native-strict' },
        ],
      }
    );
    expect(decision.refused).toBe(false);
    if (decision.refused) return;
    expect(decision.degradedSeats?.[0]?.seat).toBe('claude');
    expect(decision.degradedSeats?.[0]?.routes).toEqual([
      { nodeId: 'diff-review', fromProvider: 'claude', toProvider: 'codex-native-strict' },
    ]);
  });

  for (const [name, credits] of [
    ['case A has_credits false', { has_credits: false }],
    ['case B overage_limit_reached true', { overage_limit_reached: true }],
  ] as const) {
    test(`Test 5: exhausted or blocked credits still refuse (${name})`, () => {
      const codex = codexAtLimit(credits);
      const runStart = decideSeatGate([{ providerId: 'codex' }], { codex }, 95);
      expect(runStart).toEqual({
        refused: true,
        seat: 'codex',
        window: 'primary',
        usedPercent: 100,
        cutoffPercent: 95,
        unknownSeats: [],
      });
      const lane = decideSeatGate([{ providerId: 'codex' }], { codex }, 95, {
        laneProvider: 'codex',
        nodes: [{ nodeId: 'implement', providerId: 'codex' }],
      });
      expect(lane.refused).toBe(true);
      if (lane.refused) expect(lane.role).toBe('lane');
      const readings = {
        cursor: reading('cursor', 'monthly', 20),
        claude: reading('claude', 'seven_day', 10),
        codex,
      };
      const bindings = [{ providerId: 'cursor' }, { providerId: 'codex-native-strict' }];
      // D0 (WO-HARNESS-PERSONA-MODEL-DECLARED-01): diff-review is a review node, so its
      // degrade route is the shipped openrouter (Kimi) failover, never claude.
      const degraded = decideSeatGate(bindings, readings, 95, cursorLaneScope('openrouter'));
      expect(degraded.refused).toBe(false);
      if (!degraded.refused) {
        expect(degraded.onCredits).toBeUndefined();
        expect(degraded.degradedSeats?.[0]?.seat).toBe('codex');
        expect(degraded.degradedSeats?.[0]?.nodeIds).toEqual(['diff-review', 'security-review']);
      }
      const refused = decideSeatGate(
        bindings,
        { ...readings, claude: reading('claude', 'seven_day', 97) },
        95,
        cursorLaneScope('claude')
      );
      expect(refused.refused).toBe(true);
      if (refused.refused) expect(refused.role).toBe('node');
    });
  }
});
