import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

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

import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import { executeDagWorkflow } from './dag-executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

clearRegistry();
registerBuiltinProviders();

type StoredEvent = {
  workflow_run_id: string;
  event_type: string;
  step_name?: string;
  data?: Record<string, unknown>;
};

function createMockStore(events: StoredEvent[]): IWorkflowStore {
  return {
    createWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() =>
      Promise.resolve({
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        user_message: 'mock message',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
      })
    ),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createRunAuthority: mock(() => Promise.resolve('created' as const)),
    getRunAuthority: mock(() => Promise.resolve(null)),
    claimRunLease: mock(() => Promise.resolve(null)),
    heartbeatRunLease: mock(() => Promise.resolve(false)),
    releaseRunLease: mock(() => Promise.resolve(false)),
    createProviderAttempt: mock(() => Promise.resolve(true)),
    completeProviderAttempt: mock(() => Promise.resolve(true)),
    listProviderAttempts: mock(() => Promise.resolve([])),
    upsertRunOutcome: mock(() => Promise.resolve(false)),
    getRunOutcome: mock(() => Promise.resolve(null)),
    scheduleProviderWait: mock(() => Promise.resolve(false)),
    listDueProviderWaits: mock(() => Promise.resolve([])),
    claimProviderWait: mock(() => Promise.resolve(false)),
    cancelProviderWaits: mock(() => Promise.resolve(0)),
    completeProviderWait: mock(() => Promise.resolve(false)),
    createWorkflowEvent: mock((event: StoredEvent) => {
      events.push(event);
      return Promise.resolve();
    }),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function makeWorkflowRun(id: string): WorkflowRun {
  return {
    id,
    workflow_name: 'already-satisfied-node-skip',
    conversation_id: 'conv-dag',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'dag test message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

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

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

function createPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function createWorkflow(alreadySatisfied: boolean) {
  const gateOutput = alreadySatisfied
    ? '{"ALREADY_SATISFIED":true,"PRECHECK_VERDICT":"already-satisfied"}'
    : '{"ALREADY_SATISFIED":false,"PRECHECK_VERDICT":"needs-build"}';

  return {
    name: 'already-satisfied-node-skip',
    nodes: [
      {
        id: 'gate-already-satisfied',
        bash: `printf '%s\\n' '${gateOutput}'`,
      },
      {
        id: 'plan',
        depends_on: ['gate-already-satisfied'],
        when: "$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'",
        prompt: 'plan prompt',
      },
      {
        id: 'plan-review',
        depends_on: ['plan'],
        trigger_rule: 'all_done' as const,
        when: "$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'",
        prompt: 'plan-review prompt',
      },
      {
        id: 'capture-run-scope',
        depends_on: ['plan-review'],
        trigger_rule: 'all_done' as const,
        bash: [
          'set -euo pipefail',
          'mkdir -p "$ARTIFACTS_DIR"',
          "printf '%s\\n' '0123456789abcdef0123456789abcdef01234567' > \"$ARTIFACTS_DIR/run-scope-sha.txt\"",
          'echo "RUN_SCOPE_SHA=0123456789abcdef0123456789abcdef01234567"',
        ].join('\n'),
      },
      {
        id: 'implement',
        depends_on: ['capture-run-scope'],
        trigger_rule: 'all_done' as const,
        when: "$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'",
        prompt: 'implement prompt',
      },
      {
        id: 'assert-implement-produced-work',
        depends_on: ['implement'],
        trigger_rule: 'all_done' as const,
        bash: [
          'set -euo pipefail',
          "GATE_JSON=$(cat <<'JSON'",
          '$gate-already-satisfied.output',
          'JSON',
          ')',
          'if printf \'%s\\n\' "$GATE_JSON" | grep -q \'"ALREADY_SATISFIED":true\'; then',
          '  echo "BUILD_OUTCOME=ALREADY_SATISFIED"',
          'else',
          '  echo "BUILD_OUTCOME=REAL_BUILD"',
          'fi',
        ].join('\n'),
      },
      {
        id: 'decide-push-target',
        depends_on: ['assert-implement-produced-work'],
        bash: 'echo "decide-push-target reached"',
      },
    ],
  };
}

describe('already-satisfied node skip', () => {
  let testDir: string;
  let artifactsDir: string;
  let logsDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `already-satisfied-node-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    artifactsDir = join(testDir, 'artifacts');
    logsDir = join(testDir, 'logs');
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('skips plan, plan-review, and implement while downstream tail still completes', async () => {
    const events: StoredEvent[] = [];
    const store = createMockStore(events);
    const mockSendQuery = mock(function* (prompt: string) {
      yield { type: 'assistant', content: `unexpected AI call: ${prompt}` };
      yield { type: 'result', sessionId: 'unexpected-session' };
    });
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: mock(() => ({
        sendQuery: mockSendQuery,
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      })),
      loadConfig: mock(() => Promise.resolve(minimalConfig)),
    };

    const output = await executeDagWorkflow(
      deps,
      createPlatform(),
      'conv-dag',
      testDir,
      createWorkflow(true),
      makeWorkflowRun('already-satisfied-skip-run'),
      'claude',
      undefined,
      artifactsDir,
      logsDir,
      'main',
      'docs/',
      minimalConfig
    );

    expect(output).toBe('decide-push-target reached');
    expect(mockSendQuery).not.toHaveBeenCalled();

    const skippedSteps = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    expect(skippedSteps).toEqual(['implement', 'plan', 'plan-review']);
    for (const step of skippedSteps) {
      const event = events.find(e => e.event_type === 'node_skipped' && e.step_name === step);
      expect(event?.data?.reason).toBe('when_condition');
    }

    expect(
      (
        store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls[0][1]
    ).toEqual({
      node_counts: { completed: 4, failed: 0, skipped: 3, total: 7 },
    });

    const scopeSha = await readFile(join(artifactsDir, 'run-scope-sha.txt'), 'utf-8');
    expect(scopeSha.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('runs plan, plan-review, and implement on the normal build path', async () => {
    const events: StoredEvent[] = [];
    const store = createMockStore(events);
    const prompts: string[] = [];
    const mockSendQuery = mock(function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'assistant', content: `completed ${prompt}` };
      yield { type: 'result', sessionId: `session-${prompts.length}` };
    });
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: mock(() => ({
        sendQuery: mockSendQuery,
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      })),
      loadConfig: mock(() => Promise.resolve(minimalConfig)),
    };

    const output = await executeDagWorkflow(
      deps,
      createPlatform(),
      'conv-dag',
      testDir,
      createWorkflow(false),
      makeWorkflowRun('already-satisfied-build-run'),
      'claude',
      undefined,
      artifactsDir,
      logsDir,
      'main',
      'docs/',
      minimalConfig
    );

    expect(output).toBe('decide-push-target reached');
    expect(prompts).toEqual(['plan prompt', 'plan-review prompt', 'implement prompt']);
    expect(events.filter(event => event.event_type === 'node_skipped')).toHaveLength(0);
    expect(
      (
        store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls[0][1]
    ).toEqual({
      node_counts: { completed: 7, failed: 0, skipped: 0, total: 7 },
    });
  });
});
