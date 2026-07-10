/**
 * node-failover.test.ts -- WO-HARNESS-NODE-PROVIDER-FAILOVER-01
 *
 * Node-level AVAILABILITY failover: when a prompt/loop node's primary provider
 * fails with an availability-class error (429 / timeout / 5xx / connection), the
 * DAG executor re-dispatches that ONE node exactly once on a declared
 * failover_provider (+ failover_model). Auth/other 4xx errors do NOT failover.
 *
 * Scenarios covered (spec Section 6):
 *   1. availability error on primary -> one failover dispatch -> success + node_failover event
 *   2. auth error on primary -> NO failover, normal failure
 *   3. failover also fails -> node fails normally, both attempts logged
 *   4e. node WITHOUT failover fields -> byte-identical to today (no failover, no event)
 *
 * Plus a focused unit test of isAvailabilityError (the classifier the executor asks).
 *
 * Runs in its own `bun test` invocation (see packages/workflows/package.json) so
 * the process-global mock.module() calls here do not pollute sibling test files.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock logger (MUST come before imports of modules under test) ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// Persona context loader is only consumed by dag-executor; stub it so no live fetch.
mock.module('@archon/persona-context-loader', () => ({
  loadContext: mock(() => Promise.resolve('')),
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import {
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from '@archon/providers';
clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// --- Imports (after mocks) ---
import { executeDagWorkflow } from './dag-executor';
import { assertProviderCanExecuteNode, isAvailabilityError } from './node-failover';
import type { DagNode, WorkflowRun } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

// --- Types for the streamed SDK messages the mock yields ---
type Chunk = Record<string, unknown>;
type ProviderBehavior = () => Generator<Chunk, void, unknown>;

// Availability failure the executor's isAvailabilityError treats as failover-eligible,
// but which executor-shared classifyError leaves UNKNOWN (no 5xx digit / 'rate limit'
// text) -- so the pre-existing transient-retry loop does NOT retry on the same provider
// and the test stays fast + deterministic (failover is the first re-dispatch).
function availabilityFailure(): Generator<Chunk, void, unknown> {
  return (function* () {
    yield { type: 'result', isError: true, errorSubtype: 'service_unavailable', errors: [] };
  })();
}
function authFailure(): Generator<Chunk, void, unknown> {
  return (function* () {
    yield {
      type: 'result',
      isError: true,
      errorSubtype: 'authentication_failed',
      errors: ['authentication_failed'],
    };
  })();
}
function success(content = 'ok'): Generator<Chunk, void, unknown> {
  return (function* () {
    yield { type: 'assistant', content };
    yield { type: 'result', sessionId: 'sess' };
  })();
}

const CAPS_CLAUDE = () => ({
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
});
const CAPS_CODEX = () => ({
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
});

describe('provider execution capability failover guard', () => {
  it('rejects chat-only failover for a builder node', () => {
    const node = {
      id: 'implement',
      persona: 'major-build',
      loop: { prompt: 'Implement.', until: 'COMPLETE', max_iterations: 2, fresh_context: true },
    } as DagNode;
    expect(() => assertProviderCanExecuteNode('opr-zero', node)).toThrow(
      'provider_execution_capability_mismatch'
    );
  });

  it('allows chat-only failover for a text-only plan node', () => {
    const node = { id: 'plan', prompt: 'Plan it.' } as DagNode;
    expect(() => assertProviderCanExecuteNode('opr-zero', node)).not.toThrow();
  });
});

/** Per-provider call counters + a provider factory driven by a behavior map. */
function makeProviderHarness(behaviors: Record<string, ProviderBehavior>): {
  getAgentProvider: (provider: string) => {
    sendQuery: (...a: unknown[]) => Generator<Chunk, void, unknown>;
    getType: () => string;
    getCapabilities: () => ReturnType<typeof CAPS_CLAUDE>;
  };
  calls: Record<string, number>;
  /** Last resolved model string passed to sendQuery, keyed by provider. */
  models: Record<string, string | undefined>;
} {
  const calls: Record<string, number> = {};
  const models: Record<string, string | undefined> = {};
  const getAgentProvider = (provider: string) => ({
    sendQuery: (..._a: unknown[]) => {
      calls[provider] = (calls[provider] ?? 0) + 1;
      // 4th positional arg is SendQueryOptions; capture the resolved model.
      const opts = _a[3] as { model?: string } | undefined;
      models[provider] = opts?.model;
      const behavior = behaviors[provider];
      if (!behavior) throw new Error(`test: no behavior configured for provider '${provider}'`);
      return behavior();
    },
    getType: () => provider,
    getCapabilities: provider === 'codex' ? CAPS_CODEX : CAPS_CLAUDE,
  });
  return { getAgentProvider, calls, models };
}

function createMockStore(
  events: Array<{ event_type: string; step_name: string | null }>
): IWorkflowStore {
  const run: WorkflowRun = {
    id: 'mock-run-id',
    workflow_name: 'mock',
    conversation_id: 'conv-mock',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'msg',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
  return {
    createWorkflowRun: mock(() => Promise.resolve(run)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve(run)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    getRunAuthority: mock(() => Promise.resolve(null)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock((e: { event_type: string; step_name?: string | null }) => {
      events.push({ event_type: e.event_type, step_name: e.step_name ?? null });
      return Promise.resolve();
    }),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  } as unknown as IWorkflowStore;
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

let testDir: string;
beforeEach(async () => {
  testDir = join(tmpdir(), `node-failover-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

async function runNode(
  node: DagNode,
  behaviors: Record<string, ProviderBehavior>,
  runConfig: WorkflowConfig = config,
  workflowProvider = 'claude'
): Promise<{
  calls: Record<string, number>;
  models: Record<string, string | undefined>;
  events: Array<{ event_type: string; step_name: string | null }>;
}> {
  const events: Array<{ event_type: string; step_name: string | null }> = [];
  const store = createMockStore(events);
  const { getAgentProvider, calls, models } = makeProviderHarness(behaviors);
  const deps: WorkflowDeps = {
    store,
    getAgentProvider: getAgentProvider as unknown as WorkflowDeps['getAgentProvider'],
    loadConfig: mock(() => Promise.resolve(runConfig)) as unknown as WorkflowDeps['loadConfig'],
  };
  const run = await store.createWorkflowRun({
    workflow_name: 'f',
    conversation_id: 'c',
    user_message: 'm',
  });
  await executeDagWorkflow(
    deps,
    createMockPlatform(),
    'conv',
    testDir,
    { name: 'failover-test', nodes: [node] },
    run,
    workflowProvider,
    undefined,
    join(testDir, 'artifacts'),
    join(testDir, 'logs'),
    'main',
    'docs/',
    runConfig
  );
  return { calls, models, events };
}

describe('isAvailabilityError -- classifier', () => {
  it('treats 429 / rate_limit / 5xx / connection as availability', () => {
    expect(isAvailabilityError('rate_limit_exceeded')).toBe(true);
    expect(isAvailabilityError('boom', 429)).toBe(true);
    expect(isAvailabilityError('service_unavailable')).toBe(true);
    expect(isAvailabilityError('upstream error', 503)).toBe(true);
    expect(isAvailabilityError('Network connection lost.')).toBe(true);
    expect(isAvailabilityError('read ETIMEDOUT')).toBe(true);
    expect(isAvailabilityError('socket hang up')).toBe(true);
  });

  it('treats a REALISTIC provider 429 (message-only, no statusCode) as availability', () => {
    // The exact production scenario this WO exists to fix: an OpenAI/OpenRouter
    // (`opr`) or GLM SDK `APIError` whose numeric `.status` is discarded when the
    // executor stores only `err.message`. The classifier never sees `429` as a
    // statusCode and the surviving text is NOT the literal `rate_limit_exceeded`
    // token, so classifyError alone returns `unknown`. These must still failover
    // via the message-level AVAILABILITY_CONNECTION_PATTERNS -- with NO statusCode.
    expect(isAvailabilityError('429 Rate limit reached for gpt-5 in org org-abc')).toBe(true);
    expect(isAvailabilityError('Request failed with status code 429')).toBe(true);
    expect(isAvailabilityError('Too Many Requests')).toBe(true);
    expect(isAvailabilityError('Error: 429 Too Many Requests')).toBe(true);
  });

  it('does NOT treat auth / billing / invalid-request / unknown as availability', () => {
    expect(isAvailabilityError('authentication_failed')).toBe(false);
    expect(isAvailabilityError('boom', 401)).toBe(false);
    expect(isAvailabilityError('credit balance is too low')).toBe(false);
    expect(isAvailabilityError('invalid_request')).toBe(false);
    expect(isAvailabilityError('some unrelated crash')).toBe(false);
    expect(isAvailabilityError(undefined)).toBe(false);
  });
});

describe('node-level availability failover (prompt node)', () => {
  it('blocks an implicit chat-only workflow provider before initial builder dispatch', async () => {
    const { calls, events } = await runNode(
      { id: 'implement', persona: 'major-build', prompt: 'implement the change' } as DagNode,
      { 'opr-zero': () => success('must not run') },
      config,
      'opr-zero'
    );

    expect(calls['opr-zero'] ?? 0).toBe(0);
    expect(events.some(e => e.event_type === 'node_failed' && e.step_name === 'implement')).toBe(
      true
    );
  });

  it('Scenario 1: availability error -> exactly one failover dispatch -> success + node_failover event', async () => {
    const { calls, events } = await runNode(
      {
        id: 'plan',
        prompt: 'do the work',
        provider: 'claude',
        failover_provider: 'codex',
        failover_model: 'gpt-5.5',
      } as DagNode,
      { claude: availabilityFailure, codex: () => success('failover worked') }
    );

    expect(calls.claude).toBe(1); // primary tried once (no same-provider retry for this class)
    expect(calls.codex).toBe(1); // exactly one sideways re-dispatch
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(1);
    // The node ultimately completes (failover succeeded).
    expect(events.some(e => e.event_type === 'node_completed' && e.step_name === 'plan')).toBe(
      true
    );
  });

  it('Scenario 2: auth error -> NO failover, normal failure', async () => {
    const { calls, events } = await runNode(
      {
        id: 'plan',
        prompt: 'do the work',
        provider: 'claude',
        failover_provider: 'codex',
        failover_model: 'gpt-5.5',
      } as DagNode,
      { claude: authFailure, codex: () => success() }
    );

    expect(calls.claude).toBe(1);
    expect(calls.codex ?? 0).toBe(0); // failover NEVER dispatched on an auth error
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(0);
    expect(events.some(e => e.event_type === 'node_failed' && e.step_name === 'plan')).toBe(true);
  });

  it('Scenario 3: failover also fails -> node fails normally, both attempts logged', async () => {
    const { calls, events } = await runNode(
      {
        id: 'plan',
        prompt: 'do the work',
        provider: 'claude',
        failover_provider: 'codex',
        failover_model: 'gpt-5.5',
      } as DagNode,
      { claude: availabilityFailure, codex: availabilityFailure }
    );

    expect(calls.claude).toBe(1);
    expect(calls.codex).toBe(1); // one failover attempt, then give up
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(1);
    // Both the primary and the failover attempt recorded a node_failed event.
    expect(
      events.filter(e => e.event_type === 'node_failed' && e.step_name === 'plan').length
    ).toBe(2);
  });

  it('blocks a chat-only failover before dispatching a builder node', async () => {
    const { calls, events } = await runNode(
      {
        id: 'implement',
        persona: 'major-build',
        prompt: 'implement the change',
        provider: 'claude',
        failover_provider: 'opr-zero',
      } as DagNode,
      { claude: availabilityFailure, 'opr-zero': () => success('must not run') }
    );

    expect(calls.claude).toBe(1);
    expect(calls['opr-zero'] ?? 0).toBe(0);
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(0);
  });

  it('Scenario 4e: no failover fields -> byte-identical (no failover, no event) on same error', async () => {
    const { calls, events } = await runNode(
      { id: 'plan', prompt: 'do the work', provider: 'claude' } as DagNode,
      { claude: availabilityFailure, codex: () => success() }
    );

    expect(calls.claude).toBe(1);
    expect(calls.codex ?? 0).toBe(0); // no failover declared -> codex never touched
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(0);
    expect(events.some(e => e.event_type === 'node_failed' && e.step_name === 'plan')).toBe(true);
  });

  it('Scenario 5: failover_provider WITHOUT failover_model -> does NOT leak the primary model; resolves the failover provider assistant-config model', async () => {
    // Regression guard: a bare `{ ...node }` spread on the failover clone would
    // carry the primary provider's `node.model` (an OpenRouter/`opr`-format
    // string) into the codex dispatch when `failover_model` is omitted. The
    // clone must clear `model` so resolveNodeProviderAndModel falls back to the
    // failover provider's own assistant-config model.
    const cfg: WorkflowConfig = {
      assistant: 'claude',
      assistants: { claude: {}, codex: { model: 'gpt-5.5-codex' } },
      commands: {},
      defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
    };
    const { calls, models, events } = await runNode(
      {
        id: 'plan',
        prompt: 'do the work',
        provider: 'claude',
        model: 'qwen/qwen3-coder', // primary (OpenRouter-format) model -- must NOT leak
        failover_provider: 'codex',
        // failover_model deliberately omitted
      } as DagNode,
      { claude: availabilityFailure, codex: () => success('failover worked') },
      cfg
    );

    expect(calls.claude).toBe(1);
    expect(calls.codex).toBe(1);
    expect(events.filter(e => e.event_type === 'node_failover')).toHaveLength(1);
    // The failover dispatch resolved codex's assistant-config model, NOT the
    // leaked primary OpenRouter-format string.
    expect(models.codex).toBe('gpt-5.5-codex');
    expect(models.codex).not.toBe('qwen/qwen3-coder');
  });
});
