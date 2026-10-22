import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'node:url';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import type { MessageChunk, ProviderCapabilities, SendQueryOptions } from '@archon/providers/types';
import { executeDagWorkflow } from './dag-executor';
import { sumRunSpendUsd } from './run-spend';
import type { WorkflowConfig, WorkflowDeps, IWorkflowPlatform } from './deps';
import type { IWorkflowStore, WorkflowEventRecord } from './store';
import type { ApprovalContext, WorkflowRun } from './schemas';

const caps: ProviderCapabilities = {
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: true,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

type ScriptStep = { kind: 'chunks'; chunks: MessageChunk[] } | { kind: 'abort' };

interface Harness {
  calls: SendQueryOptions[];
  events: WorkflowEventRecord[];
  messages: string[];
  pauses: ApprovalContext[];
  failures: string[];
  completions: Array<Record<string, unknown> | undefined>;
  status: { value: string };
  deps: WorkflowDeps;
  platform: IWorkflowPlatform;
}

function createHarness(script: ScriptStep[], options?: { rejectEventTypes?: string[] }): Harness {
  const calls: SendQueryOptions[] = [];
  const events: WorkflowEventRecord[] = [];
  const messages: string[] = [];
  const pauses: ApprovalContext[] = [];
  const failures: string[] = [];
  const completions: Array<Record<string, unknown> | undefined> = [];
  const status = { value: 'running' };
  const reject = new Set(options?.rejectEventTypes ?? []);
  let seq = 0;
  let step = 0;

  const store = {
    createWorkflowRun: async () => {
      throw new Error('not used');
    },
    getWorkflowRun: async () => null,
    getActiveWorkflowRunByPath: async () => null,
    failOrphanedRuns: async () => ({ count: 0 }),
    findResumableRun: async () => null,
    resumeWorkflowRun: async () => {
      throw new Error('not used');
    },
    updateWorkflowRun: async () => undefined,
    updateWorkflowActivity: async () => undefined,
    getWorkflowRunStatus: async () => status.value as 'running',
    completeWorkflowRun: async (_id: string, metadata?: Record<string, unknown>) => {
      completions.push(metadata);
      status.value = 'completed';
    },
    failWorkflowRun: async (_id: string, error: string) => {
      failures.push(error);
      status.value = 'failed';
    },
    pauseWorkflowRun: async (_id: string, approval: ApprovalContext) => {
      pauses.push(approval);
      status.value = 'paused';
    },
    cancelWorkflowRun: async () => undefined,
    createRunAuthority: async () => 'created' as const,
    getRunAuthority: async () => null,
    claimRunLease: async () => null,
    heartbeatRunLease: async () => false,
    releaseRunLease: async () => false,
    createProviderAttempt: async () => true,
    completeProviderAttempt: async () => true,
    listProviderAttempts: async () => [],
    upsertRunOutcome: async () => false,
    getRunOutcome: async () => null,
    scheduleProviderWait: async () => false,
    listDueProviderWaits: async () => [],
    claimProviderWait: async () => false,
    cancelProviderWaits: async () => 0,
    completeProviderWait: async () => false,
    createWorkflowEvent: async (event: {
      workflow_run_id: string;
      event_type: string;
      step_name?: string;
      data?: Record<string, unknown>;
    }) => {
      if (reject.has(event.event_type)) throw new Error('disk full');
      seq += 1;
      events.push({
        id: `evt-${String(seq)}`,
        workflow_run_id: event.workflow_run_id,
        event_type: event.event_type,
        step_index: null,
        step_name: event.step_name ?? null,
        data: event.data ?? {},
        created_at: new Date().toISOString(),
      });
    },
    listWorkflowEvents: async () => events,
    getCompletedDagNodeOutputs: async () => new Map<string, string>(),
    getCodebase: async () => null,
    getCodebaseEnvVars: async () => ({}),
  } as IWorkflowStore;

  const provider = {
    getType: () => 'claude',
    getCapabilities: () => caps,
    async *sendQuery(
      _prompt: string,
      _cwd: string,
      _resume?: string,
      queryOptions?: SendQueryOptions
    ): AsyncGenerator<MessageChunk> {
      calls.push(queryOptions ?? {});
      const action = script[Math.min(step, script.length - 1)];
      step += 1;
      if (!action || action.kind === 'abort') {
        await new Promise<void>(resolve => {
          const signal = queryOptions?.abortSignal;
          if (!signal || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      for (const chunk of action.chunks) yield chunk;
    },
  };

  const deps: WorkflowDeps = {
    store,
    getAgentProvider: () => provider,
    loadConfig: async () => config,
  };
  const platform: IWorkflowPlatform = {
    sendMessage: async (_id: string, text: string) => {
      messages.push(text);
    },
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'test',
    sendStructuredEvent: async () => undefined,
  };
  return { calls, events, messages, pauses, failures, completions, status, deps, platform };
}

function runRecord(id: string, metadata: Record<string, unknown> = {}): WorkflowRun {
  return {
    id,
    workflow_name: 'open-lane-cost',
    conversation_id: 'conv-cost',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'cost test',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

function result(
  cost: number,
  extra?: Partial<Extract<MessageChunk, { type: 'result' }>>
): MessageChunk {
  return { type: 'result', cost, ...extra };
}

function assistant(content: string): MessageChunk {
  return { type: 'assistant', content };
}

async function runWorkflow(
  harness: Harness,
  dir: string,
  workflow: { name: string; nodes: readonly object[] },
  workflowRun: WorkflowRun,
  provider = 'claude'
): Promise<void> {
  const artifactsDir = join(dir, 'artifacts');
  const logDir = join(dir, 'logs');
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await executeDagWorkflow(
    harness.deps,
    harness.platform,
    'conv-cost',
    dir,
    workflow as {
      name: string;
      nodes: [];
    },
    workflowRun,
    provider,
    undefined,
    artifactsDir,
    logDir,
    'main',
    'docs/',
    config
  );
}

function costOf(events: WorkflowEventRecord[], type: string, index: number): unknown {
  return events.filter(event => event.event_type === type)[index]?.data.cost_usd;
}

describe('open lane cost events', () => {
  let dir: string;

  beforeEach(async () => {
    clearRegistry();
    registerBuiltinProviders();
    registerCommunityProviders();
    dir = await mkdtemp(join(tmpdir(), 'open-lane-cost-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('records chunk cost on node_completed and the cost-cap failure', async () => {
    const ok = createHarness([{ kind: 'chunks', chunks: [assistant('done'), result(0.0123)] }]);
    await runWorkflow(
      ok,
      dir,
      {
        name: 'cost-ok',
        nodes: [{ id: 'price', prompt: 'price it', maxBudgetUsd: 1 }],
      },
      runRecord('cost-ok')
    );
    expect(costOf(ok.events, 'node_completed', 0)).toBe(0.0123);
    expect(ok.completions[0]?.total_cost_usd).toBe(0.0123);
    expect(ok.messages.some(message => message.includes('maxBudgetUsd'))).toBe(false);

    const capped = createHarness([
      {
        kind: 'chunks',
        chunks: [
          assistant('over'),
          result(0.004, { isError: true, errorSubtype: 'error_max_budget_usd', errors: ['cap'] }),
        ],
      },
    ]);
    await runWorkflow(
      capped,
      dir,
      {
        name: 'cost-cap',
        nodes: [{ id: 'capped', prompt: 'overspend', maxBudgetUsd: 0.002 }],
      },
      runRecord('cost-cap')
    );
    const failed = capped.events.find(event => event.event_type === 'node_failed');
    expect(failed?.data.cost_usd).toBe(0.004);
    expect(String(failed?.data.error)).toContain('exceeded cost cap');
  });

  test('adds cost_usd and cost_usd_estimate for a missing OpenRouter cost only', async () => {
    const partial = createHarness([
      {
        kind: 'chunks',
        chunks: [
          assistant('partial'),
          result(0.002, {
            isError: true,
            errorSubtype: 'openrouter_cost_missing',
            errors: ['openrouter_cost_missing'],
          }),
        ],
      },
    ]);
    await runWorkflow(
      partial,
      dir,
      {
        name: 'missing-part',
        nodes: [{ id: 'partial', prompt: 'partial', maxBudgetUsd: 0.01 }],
      },
      runRecord('missing-part')
    );
    const partialFailed = partial.events.find(event => event.event_type === 'node_failed');
    expect(partialFailed?.data.cost_usd).toBe(0.002);
    expect(partialFailed?.data.cost_usd_estimate).toBe(0.008);
    expect(sumRunSpendUsd(partial.events)).toBe(0.01);

    const unknown = createHarness([
      {
        kind: 'chunks',
        chunks: [
          {
            type: 'result',
            isError: true,
            errorSubtype: 'openrouter_cost_missing',
            errors: ['openrouter_cost_missing'],
          },
        ],
      },
    ]);
    await runWorkflow(
      unknown,
      dir,
      {
        name: 'missing-all',
        nodes: [{ id: 'unknown', prompt: 'unknown', provider: 'claude', maxBudgetUsd: 0.005 }],
      },
      runRecord('missing-all')
    );
    const unknownFailed = unknown.events.find(event => event.event_type === 'node_failed');
    expect(unknownFailed?.data.cost_usd).toBeUndefined();
    expect(unknownFailed?.data.cost_usd_estimate).toBe(0.005);
    expect(sumRunSpendUsd(unknown.events)).toBe(0.005);

    const ordinary = createHarness([
      {
        kind: 'chunks',
        chunks: [
          assistant('nope'),
          result(0.001, { isError: true, errorSubtype: 'boom', errors: ['boom'] }),
        ],
      },
    ]);
    await runWorkflow(
      ordinary,
      dir,
      {
        name: 'ordinary-fail',
        nodes: [{ id: 'plain', prompt: 'plain', maxBudgetUsd: 0.01 }],
      },
      runRecord('ordinary-fail')
    );
    const ordinaryFailed = ordinary.events.find(event => event.event_type === 'node_failed');
    expect(ordinaryFailed?.data.cost_usd).toBe(0.001);
    expect(ordinaryFailed?.data.cost_usd_estimate).toBeUndefined();
  });

  test('keeps every retry attempt cost and sums them once', async () => {
    const harness = createHarness([
      {
        kind: 'chunks',
        chunks: [
          assistant('no'),
          result(0.002, { isError: true, errorSubtype: 'timeout', errors: ['timeout'] }),
        ],
      },
      {
        kind: 'chunks',
        chunks: [
          assistant('no'),
          result(0.003, { isError: true, errorSubtype: 'timeout', errors: ['timeout'] }),
        ],
      },
      { kind: 'chunks', chunks: [assistant('yes'), result(0.005)] },
    ]);
    await runWorkflow(
      harness,
      dir,
      {
        name: 'retry-cost',
        nodes: [
          {
            id: 'retried',
            prompt: 'try again',
            maxBudgetUsd: 1,
            retry: { max_attempts: 2, delay_ms: 0, on_error: 'all' },
          },
        ],
      },
      runRecord('retry-cost')
    );
    const failed = harness.events.filter(event => event.event_type === 'node_failed');
    expect(failed.map(event => event.data.cost_usd)).toEqual([0.002, 0.003]);
    expect(costOf(harness.events, 'node_completed', 0)).toBe(0.005);
    expect(sumRunSpendUsd(harness.events)).toBe(0.01);
  });

  test('passes the remaining loop budget and stops before another paid iteration', async () => {
    const harness = createHarness([
      { kind: 'chunks', chunks: [assistant('working'), result(0.004)] },
      { kind: 'chunks', chunks: [assistant('working'), result(0.004)] },
      { kind: 'chunks', chunks: [assistant('working'), result(0.004)] },
      { kind: 'chunks', chunks: [assistant('should not run'), result(0.004)] },
    ]);
    await runWorkflow(
      harness,
      dir,
      {
        name: 'loop-cap',
        nodes: [
          {
            id: 'spend-loop',
            provider: 'openrouter',
            maxBudgetUsd: 0.01,
            allowed_tools: ['read_file', 'list_dir'],
            loop: { prompt: 'work', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      runRecord('loop-cap'),
      'openrouter'
    );
    expect(harness.calls.map(call => call.maxBudgetUsd)).toEqual([0.01, 0.006, 0.002]);
    expect(harness.calls.map(call => call.nodeConfig?.maxBudgetUsd)).toEqual([0.01, 0.006, 0.002]);
    expect(harness.calls[0]?.nodeConfig?.allowed_tools).toEqual(['read_file', 'list_dir']);
    const iterations = harness.events.filter(
      event => event.event_type === 'loop_iteration_completed'
    );
    expect(iterations.map(event => event.data.cost_usd)).toEqual([0.004, 0.004, 0.004]);
    expect(sumRunSpendUsd(harness.events)).toBe(0.012);
    const terminal = harness.events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'spend-loop'
    );
    expect(terminal?.data.cost_usd).toBe(0.012);
    expect(terminal?.data.cost_usd_estimate).toBeUndefined();
    expect(String(terminal?.data.error)).toContain('exceeded cost cap');
  });

  test('records a failed loop iteration cost without counting the terminal event twice', async () => {
    const harness = createHarness([
      { kind: 'chunks', chunks: [assistant('working'), result(0.004)] },
      {
        kind: 'chunks',
        chunks: [
          assistant('nope'),
          result(0.002, { isError: true, errorSubtype: 'timeout', errors: ['timeout'] }),
        ],
      },
    ]);
    await runWorkflow(
      harness,
      dir,
      {
        name: 'loop-fail',
        nodes: [
          {
            id: 'fail-loop',
            maxBudgetUsd: 0.01,
            loop: { prompt: 'work', until: 'COMPLETE', max_iterations: 4 },
          },
        ],
      },
      runRecord('loop-fail')
    );
    expect(costOf(harness.events, 'loop_iteration_completed', 0)).toBe(0.004);
    expect(costOf(harness.events, 'loop_iteration_failed', 0)).toBe(0.002);
    expect(sumRunSpendUsd(harness.events)).toBe(0.006);
  });

  test('restores spend after an interactive pause so the resume call gets the remainder', async () => {
    const harness = createHarness([
      { kind: 'chunks', chunks: [assistant('draft'), result(0.004)] },
      { kind: 'chunks', chunks: [assistant('COMPLETE'), result(0.001)] },
    ]);
    const workflow = {
      name: 'loop-pause',
      nodes: [
        {
          id: 'review',
          maxBudgetUsd: 0.01,
          loop: {
            prompt: 'review',
            until: 'COMPLETE',
            max_iterations: 4,
            interactive: true,
            gate_message: 'review this',
          },
        },
      ],
    };
    const workflowRun = runRecord('loop-pause');
    await runWorkflow(harness, dir, workflow, workflowRun);
    expect(harness.pauses).toHaveLength(1);
    expect(costOf(harness.events, 'loop_iteration_completed', 0)).toBe(0.004);
    expect(harness.calls[0]?.maxBudgetUsd).toBe(0.01);

    harness.status.value = 'running';
    workflowRun.metadata = {
      approval: {
        nodeId: 'review',
        message: 'review this',
        type: 'interactive_loop',
        iteration: 1,
      },
    };
    await runWorkflow(harness, dir, workflow, workflowRun);
    expect(harness.calls[1]?.maxBudgetUsd).toBe(0.006);
    expect(harness.calls[1]?.nodeConfig?.maxBudgetUsd).toBe(0.006);
    expect(sumRunSpendUsd(harness.events)).toBe(0.005);
    expect(
      harness.events.some(
        event => event.event_type === 'loop_iteration_completed' && event.data.cost_usd === 0.004
      )
    ).toBe(true);
  });

  test('charges an aborted wall attempt its allowed budget and refuses the retry call', async () => {
    const harness = createHarness([
      { kind: 'chunks', chunks: [assistant('working'), result(0.004)] },
      { kind: 'abort' },
      { kind: 'chunks', chunks: [assistant('should not run'), result(0.001)] },
    ]);
    await runWorkflow(
      harness,
      dir,
      {
        name: 'loop-wall',
        nodes: [
          {
            id: 'wall-loop',
            maxBudgetUsd: 0.01,
            wall_timeout_ms: 500,
            loop: { prompt: 'work', until: 'COMPLETE', max_iterations: 4 },
          },
        ],
      },
      runRecord('loop-wall')
    );
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.maxBudgetUsd).toBe(0.01);
    expect(harness.calls[1]?.maxBudgetUsd).toBe(0.006);
    const aborted = harness.events.find(event => event.event_type === 'loop_iteration_failed');
    expect(aborted?.data.cost_usd).toBeUndefined();
    expect(aborted?.data.cost_usd_estimate).toBe(0.006);
    const wallTerminal = harness.events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'wall-loop'
    );
    expect(String(wallTerminal?.data.error)).toContain('exceeded cost cap');
    expect(sumRunSpendUsd(harness.events)).toBe(0.01);
  });

  test('fails closed before pause or another paid call when iteration cost cannot be saved', async () => {
    const harness = createHarness(
      [
        { kind: 'chunks', chunks: [assistant('draft'), result(0.004)] },
        { kind: 'chunks', chunks: [assistant('should not run'), result(0.004)] },
      ],
      { rejectEventTypes: ['loop_iteration_completed', 'loop_iteration_failed'] }
    );
    await runWorkflow(
      harness,
      dir,
      {
        name: 'loop-persist',
        nodes: [
          { id: 'prep', bash: 'echo ready' },
          {
            id: 'pause-loop',
            depends_on: ['prep'],
            maxBudgetUsd: 0.01,
            loop: {
              prompt: 'work',
              until: 'COMPLETE',
              max_iterations: 3,
              interactive: true,
              gate_message: 'review this',
            },
          },
        ],
      },
      runRecord('loop-persist')
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.pauses).toHaveLength(0);
    expect(harness.failures.some(message => message.includes('loop_cost_persist_failed'))).toBe(
      true
    );
  });

  test('opr and openrouter do not warn that maxBudgetUsd is unsupported', async () => {
    const openrouter = createHarness([
      { kind: 'chunks', chunks: [assistant('ok'), result(0.001)] },
    ]);
    await runWorkflow(
      openrouter,
      dir,
      {
        name: 'warn-openrouter',
        nodes: [{ id: 'seat', prompt: 'go', provider: 'openrouter', maxBudgetUsd: 0.05 }],
      },
      runRecord('warn-openrouter'),
      'openrouter'
    );
    expect(openrouter.messages.some(message => message.includes('maxBudgetUsd'))).toBe(false);

    const opr = createHarness([{ kind: 'chunks', chunks: [assistant('ok'), result(0.001)] }]);
    await runWorkflow(
      opr,
      dir,
      {
        name: 'warn-opr',
        nodes: [
          {
            id: 'chat',
            prompt: 'go',
            provider: 'opr',
            allowed_tools: [],
            maxBudgetUsd: 0.05,
          },
        ],
      },
      runRecord('warn-opr'),
      'opr'
    );
    expect(opr.messages.some(message => message.includes('maxBudgetUsd'))).toBe(false);
  });

  test('sumRunSpendUsd counts estimate-only iteration events and ignores that step terminal', () => {
    const events: WorkflowEventRecord[] = [
      {
        id: '1',
        workflow_run_id: 'run',
        event_type: 'loop_iteration_failed',
        step_index: null,
        step_name: 'implement',
        data: { cost_usd_estimate: 0.006 },
        created_at: 't',
      },
      {
        id: '2',
        workflow_run_id: 'run',
        event_type: 'node_failed',
        step_index: null,
        step_name: 'implement',
        data: { cost_usd: 0.999 },
        created_at: 't',
      },
      {
        id: '3',
        workflow_run_id: 'run',
        event_type: 'node_failed',
        step_index: null,
        step_name: 'other',
        data: { cost_usd: 0.002, cost_usd_estimate: 0.003 },
        created_at: 't',
      },
    ];
    expect(sumRunSpendUsd(events)).toBe(0.011);
    expect(sumRunSpendUsd([])).toBe(0);
  });

  test('new source and test files are ASCII only', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      join(here, 'run-spend.ts'),
      join(here, 'open-lane-cost-events.test.ts'),
      join(here, 'dag-executor.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'grok', 'provider.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'grok', 'capabilities.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'grok', 'provider.test.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'glm', 'provider.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'glm', 'capabilities.ts'),
      join(here, '..', '..', 'providers', 'src', 'community', 'glm', 'provider.test.ts'),
    ];
    for (const file of files) {
      const bytes = readFileSync(file);
      for (let offset = 0; offset < bytes.length; offset += 1) {
        if (bytes[offset]! > 127) {
          throw new Error(`${file} has non-ASCII byte at offset ${String(offset)}`);
        }
      }
    }
  });
});
