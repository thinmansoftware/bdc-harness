/**
 * Tests for the blocked-manifest verdict check in dag-executor.ts.
 *
 * WO: WO-HARNESS-HONEST-STATUS-AND-ESCALATE-ON-BLOCKED-01
 *
 * The bug: a `build-manifest` (or `assert-implement-produced-work`) node whose
 * AI text output says `OUTCOME: BLOCKED` / `VALIDATION: BLOCKED` /
 * `BUILD_OUTCOME=FALSE_COMPLETE` still has `state === 'completed'` (the node
 * ran without throwing). Pre-fix, the DAG executor's completion block derived
 * success purely from node states, so it called `completeWorkflowRun` and the
 * run was reported green.
 *
 * The fix: re-inspect those two node outputs at completion time and, when a
 * blocked verdict is present, route through `failWorkflowRun` + the existing
 * `decide()` / `runEscalation()` path (the same one the silent-dead-end node
 * failures use) so escalation.json + the builder-monitor webhook fire.
 *
 * MUST live in its own `bun test` invocation: `mock.module('@archon/overseer',
 * ...)` is process-wide and would otherwise bleed into the existing
 * `dag-executor.test.ts` suite (Bun mock.module isolation rule -- see the
 * project CLAUDE.md "Test isolation" section).
 */

import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
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
  getArchonHome: () => '/tmp/archon-home-blocked-verdict-test',
}));

// --- Mock @archon/overseer so runEscalation does not perform real side effects ---
// runEscalation in the real module writes to disk, calls the builder-monitor
// webhook, and posts a Notion comment. We need to intercept the call to assert
// the executor wired through to it on a blocked verdict; we re-export `decide`
// from the real module so the production code path remains exercised (decide()
// is pure -- no side effects -- and the test assertions depend on its real
// remediation extraction behavior).
import * as overseerActual from '@archon/overseer';

const mockRunEscalation: Mock<
  (
    runId: string,
    decision: overseerActual.DecisionResult,
    context: overseerActual.EscalationContext
  ) => Promise<void>
> = mock(() => Promise.resolve());

mock.module('@archon/overseer', () => ({
  classifyError: overseerActual.classifyError,
  decide: overseerActual.decide,
  runEscalation: mockRunEscalation,
}));

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Imports under test (after mocks) ---
import { detectBlockedManifestVerdict, executeDagWorkflow } from './dag-executor';
import type { NodeOutput, WorkflowRun, DagNode } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

// --- Test fixtures ---

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

const mockClaudeCapabilities = () => ({
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

function createMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.resolve(makeWorkflowRun())),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve(makeWorkflowRun())),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

const mockSendQueryDag = mock(function* () {
  yield { type: 'assistant', content: 'AI response' };
  yield { type: 'result', sessionId: 'session-id' };
});

const mockGetAgentProvider = mock(() => ({
  sendQuery: mockSendQueryDag,
  getType: () => 'claude',
  getCapabilities: mockClaudeCapabilities,
}));

function createMockDeps(storeOverride?: IWorkflowStore): WorkflowDeps {
  const store = storeOverride ?? createMockStore();
  return {
    store,
    getAgentProvider: mockGetAgentProvider,
    loadConfig: mock(() =>
      Promise.resolve({
        assistant: 'claude' as const,
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        assistants: { claude: {}, codex: {} },
      })
    ),
  };
}

function makeWorkflowRun(
  id = 'blocked-verdict-test-run',
  overrides?: Partial<WorkflowRun>
): WorkflowRun {
  return {
    id,
    workflow_name: 'blocked-verdict-test',
    conversation_id: 'conv-blocked',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'run WO-TEST-BLOCKED-VERDICT-01 against fixtures',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    ...overrides,
  } as WorkflowRun;
}

// --- detectBlockedManifestVerdict unit tests --------------------------------
//
// These cover the pure helper directly so a regression to the string matchers
// is caught without needing the integration-test fixture scaffolding.

describe('detectBlockedManifestVerdict (unit)', () => {
  it('Scenario 1a: OUTCOME: BLOCKED in build-manifest output -> blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      [
        'build-manifest',
        {
          state: 'completed',
          output:
            'OUTCOME: BLOCKED\n' +
            '- Fix missing tests in packages/foo\n' +
            '- Add type annotations to bar.ts\n' +
            'VALIDATION: BLOCKED',
        },
      ],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(true);
    expect(result.verdict).toContain('build-manifest');
    expect(result.verdict).toContain('BLOCKED');
  });

  it('Scenario 1b: OUTCOME=BLOCKED (equals form) in build-manifest output -> blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      [
        'build-manifest',
        { state: 'completed', output: 'Summary line.\nOUTCOME=BLOCKED\nDetails follow.' },
      ],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(true);
    expect(result.verdict).toContain('BLOCKED');
  });

  it('Scenario 1c: VALIDATION: BLOCKED only (no OUTCOME line) -> blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      ['build-manifest', { state: 'completed', output: 'VALIDATION: BLOCKED' }],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(true);
    expect(result.verdict).toContain('VALIDATION: BLOCKED');
  });

  it('Scenario 2: happy-path manifest (VALIDATION: PASS) -> not blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      [
        'build-manifest',
        {
          state: 'completed',
          output:
            'Files created: foo.ts\nFiles modified: bar.ts\nTests: 12/12 passing\nVALIDATION: PASS',
        },
      ],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(false);
    expect(result.verdict).toBe('');
  });

  it('Scenario 3: BUILD_OUTCOME=FALSE_COMPLETE in assert-implement-produced-work -> blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      [
        'assert-implement-produced-work',
        { state: 'completed', output: 'BUILD_OUTCOME=FALSE_COMPLETE\nNo files written.' },
      ],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(true);
    expect(result.verdict).toContain('assert-implement-produced-work');
    expect(result.verdict).toContain('FALSE_COMPLETE');
  });

  it('Scenario 3b: BUILD_OUTCOME=FALSE_COMPLETE in build-manifest output -> blocked', () => {
    // Some YAMLs route the assert output through build-manifest. Confirm the
    // belt-and-suspenders coverage works when the marker lives in either node.
    const outputs = new Map<string, NodeOutput>([
      [
        'build-manifest',
        { state: 'completed', output: 'Manifest summary.\nBUILD_OUTCOME=FALSE_COMPLETE' },
      ],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(true);
    expect(result.verdict).toContain('build-manifest');
    expect(result.verdict).toContain('FALSE_COMPLETE');
  });

  it('build-manifest in failed state does NOT match (defensive)', () => {
    // The check is only meaningful when the node ran cleanly. A failed
    // build-manifest is already handled by the anyFailed branch.
    const outputs = new Map<string, NodeOutput>([
      ['build-manifest', { state: 'failed', output: 'OUTCOME: BLOCKED', error: 'node crashed' }],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(false);
  });

  it('no relevant node outputs -> not blocked', () => {
    const outputs = new Map<string, NodeOutput>([
      ['plan', { state: 'completed', output: 'plan output' }],
      ['implement', { state: 'completed', output: 'implement output' }],
    ]);
    const result = detectBlockedManifestVerdict(outputs);
    expect(result.blocked).toBe(false);
  });
});

// --- Integration tests through executeDagWorkflow ---------------------------
//
// Use priorCompletedNodes to pre-seed the build-manifest node output so the
// executor enters the completion block with the seeded state without needing
// a working AI provider for that node.

describe('executeDagWorkflow -- blocked verdict integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `blocked-verdict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    // The DAG executor loads a command prompt before reaching the completion
    // block; seeding a placeholder file is cheaper than mocking the loader.
    await writeFile(join(commandsDir, 'build-manifest.md'), 'Emit manifest.');
    await writeFile(join(commandsDir, 'assert-implement-produced-work.md'), 'Assert prior work.');

    mockRunEscalation.mockClear();
    mockSendQueryDag.mockClear();
    mockGetAgentProvider.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function singleNodeWorkflow(nodeId: string): { name: string; nodes: DagNode[] } {
    // A single command node. priorCompletedNodes pre-seeds its output so the
    // executor skips re-running it and proceeds straight to the completion
    // block with the seeded NodeOutput.
    return { name: 'blocked-verdict-single', nodes: [{ id: nodeId, command: nodeId }] };
  }

  it('Scenario 1: OUTCOME: BLOCKED -> failWorkflowRun + runEscalation(validator_rejected)', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('run-scenario-1');

    const priorCompletedNodes = new Map([
      [
        'build-manifest',
        'OUTCOME: BLOCKED\n- Fix missing tests in packages/foo\n- Add type annotations to bar.ts\nVALIDATION: BLOCKED',
      ],
    ]);

    await executeDagWorkflow(
      deps,
      platform,
      'conv-scenario-1',
      testDir,
      singleNodeWorkflow('build-manifest'),
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    const failCalls = (store.failWorkflowRun as Mock<typeof store.failWorkflowRun>).mock.calls;
    const completeCalls = (store.completeWorkflowRun as Mock<typeof store.completeWorkflowRun>).mock
      .calls;

    // Run reported failed, NOT completed.
    expect(failCalls.length).toBe(1);
    expect(failCalls[0][0]).toBe('run-scenario-1');
    expect(String(failCalls[0][1])).toMatch(/BLOCKED/);
    expect(completeCalls.length).toBe(0);

    // Escalation fired exactly once with validator_rejected context.
    expect(mockRunEscalation.mock.calls.length).toBe(1);
    const [escalRunId, escalDecision, escalContext] = mockRunEscalation.mock.calls[0];
    expect(escalRunId).toBe('run-scenario-1');
    expect(escalDecision.decision).toBe('escalate');
    expect(escalContext.errorClass).toBe('validator_rejected');
    // decide()'s extractRemediation must have pulled the two bullet lines from
    // the seeded manifest text.
    expect(escalContext.remediation).toBeDefined();
    expect(escalContext.remediation!.length).toBeGreaterThan(0);
    expect(escalContext.remediation!.join(' ')).toContain('Fix missing tests');
    expect(escalContext.remediation!.join(' ')).toContain('Add type annotations');
    // woId extracted from workflowRun.user_message.
    expect(escalContext.woId).toBe('WO-TEST-BLOCKED-VERDICT-01');
  });

  it('Scenario 2: VALIDATION: PASS happy path -> completeWorkflowRun, no escalation', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('run-scenario-2');

    const priorCompletedNodes = new Map([
      [
        'build-manifest',
        'Files created: foo.ts\nFiles modified: bar.ts\nTests: 12/12 passing\nVALIDATION: PASS',
      ],
    ]);

    await executeDagWorkflow(
      deps,
      platform,
      'conv-scenario-2',
      testDir,
      singleNodeWorkflow('build-manifest'),
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    const failCalls = (store.failWorkflowRun as Mock<typeof store.failWorkflowRun>).mock.calls;
    const completeCalls = (store.completeWorkflowRun as Mock<typeof store.completeWorkflowRun>).mock
      .calls;

    // Happy path: run completed, not failed.
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][0]).toBe('run-scenario-2');
    expect(failCalls.length).toBe(0);

    // No escalation -- this is a regression guard against the helper
    // accidentally matching legitimate manifests.
    expect(mockRunEscalation.mock.calls.length).toBe(0);
  });

  it('Scenario 3: BUILD_OUTCOME=FALSE_COMPLETE -> failWorkflowRun + escalation', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('run-scenario-3');

    // Pre-seed via the assert-implement-produced-work node id (this is where
    // BUILD_OUTCOME=FALSE_COMPLETE originates -- the bash assert node).
    const priorCompletedNodes = new Map([
      [
        'assert-implement-produced-work',
        'BUILD_OUTCOME=FALSE_COMPLETE\nNo files written by implement loop.',
      ],
    ]);

    await executeDagWorkflow(
      deps,
      platform,
      'conv-scenario-3',
      testDir,
      singleNodeWorkflow('assert-implement-produced-work'),
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined,
      undefined,
      priorCompletedNodes
    );

    const failCalls = (store.failWorkflowRun as Mock<typeof store.failWorkflowRun>).mock.calls;
    const completeCalls = (store.completeWorkflowRun as Mock<typeof store.completeWorkflowRun>).mock
      .calls;

    // Same shape as Scenario 1: run failed, escalation fired with
    // validator_rejected. The marker source differs (bash assert vs. AI
    // manifest) but the executor treats both as blocked verdicts.
    expect(failCalls.length).toBe(1);
    expect(String(failCalls[0][1])).toMatch(/FALSE_COMPLETE/);
    expect(completeCalls.length).toBe(0);

    expect(mockRunEscalation.mock.calls.length).toBe(1);
    const [, escalDecision, escalContext] = mockRunEscalation.mock.calls[0];
    expect(escalDecision.decision).toBe('escalate');
    expect(escalContext.errorClass).toBe('validator_rejected');
  });
});
