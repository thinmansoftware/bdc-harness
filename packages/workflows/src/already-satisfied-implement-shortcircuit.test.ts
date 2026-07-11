import { describe, it, expect, mock, beforeEach, afterEach, type Mock } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
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

function createMockStore(): IWorkflowStore {
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
    createWorkflowEvent: mock(() => Promise.resolve()),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function makeWorkflowRun(id = 'already-satisfied-test-run'): WorkflowRun {
  return {
    id,
    workflow_name: 'already-satisfied-shortcircuit',
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

describe('already-satisfied implement short-circuit', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `already-satisfied-shortcircuit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    mock.restore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('feeds the gate verdict into implement and completes the loop on iteration 1', async () => {
    const prompts: string[] = [];
    const mockSendQuery = mock(function* (prompt: string) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield {
          type: 'assistant',
          content:
            'PRECHECK_VERDICT=already-satisfied\nSATISFIED_EVIDENCE=branch already contains required harness change\n',
        };
      } else if (prompts.length === 2) {
        yield {
          type: 'assistant',
          content: 'ALREADY_SATISFIED: verified evidence in this worktree HEAD\nCOMPLETE\n',
        };
      } else {
        yield { type: 'assistant', content: 'decide-push-target reached' };
      }
      yield { type: 'result', sessionId: `sid-${String(prompts.length)}` };
    });

    const store = createMockStore();
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: mock(() => ({
        sendQuery: mockSendQuery,
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      })),
      loadConfig: mock(() => Promise.resolve(minimalConfig)),
    };
    const platform: IWorkflowPlatform = {
      sendMessage: mock(() => Promise.resolve()),
      getStreamingMode: mock(() => 'batch' as const),
      getPlatformType: mock(() => 'test'),
      sendStructuredEvent: mock(() => Promise.resolve()),
    };

    await executeDagWorkflow(
      deps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'already-satisfied-shortcircuit',
        nodes: [
          {
            id: 'gate-already-satisfied',
            prompt: 'Emit the precheck verdict.',
          },
          {
            id: 'implement',
            depends_on: ['gate-already-satisfied'],
            loop: {
              prompt: [
                'Implement the approved plan.',
                'Pre-check verdict from gate-already-satisfied:',
                '$gate-already-satisfied.output',
                'If the line above contains PRECHECK_VERDICT=already-satisfied, emit case 2.',
              ].join('\n'),
              until: 'COMPLETE',
              max_iterations: 5,
            },
          },
          {
            id: 'decide-push-target',
            depends_on: ['implement'],
            prompt: 'Tail node reached after implement.',
          },
        ],
      },
      makeWorkflowRun(),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('PRECHECK_VERDICT=already-satisfied');
    expect(prompts[1]).toContain(
      'SATISFIED_EVIDENCE=branch already contains required harness change'
    );
    expect(prompts[1]).toContain('If the line above contains PRECHECK_VERDICT=already-satisfied');
    expect(mockSendQuery.mock.calls[1][0]).toBe(prompts[1]);
    expect(prompts[2]).toContain('Tail node reached after implement.');
    expect(
      (
        store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls[0][1]
    ).toEqual({
      node_counts: { completed: 3, failed: 0, skipped: 0, total: 3 },
    });
    expect(
      (store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock.calls
    ).toHaveLength(0);
  });

  it('feeds the gate verdict through plan into plan-review before rendering the loop prompt', async () => {
    const prompts: string[] = [];
    const mockSendQuery = mock(function* (prompt: string) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        yield {
          type: 'assistant',
          content:
            'PRECHECK_VERDICT=already-satisfied\nSATISFIED_EVIDENCE=branch already contains required plan-review change\n',
        };
      } else if (prompts.length === 2) {
        yield {
          type: 'assistant',
          content: 'Plan: verify the already-satisfied evidence without making code changes.',
        };
      } else if (prompts.length === 3) {
        yield {
          type: 'assistant',
          content:
            'PLAN_REVIEW_PASS=true\nAPPROVED_PLAN=Verify the already-satisfied evidence in this worktree.\n',
        };
      } else {
        yield { type: 'assistant', content: 'implement reached' };
      }
      yield { type: 'result', sessionId: `sid-${String(prompts.length)}` };
    });

    const store = createMockStore();
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: mock(() => ({
        sendQuery: mockSendQuery,
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      })),
      loadConfig: mock(() => Promise.resolve(minimalConfig)),
    };
    const platform: IWorkflowPlatform = {
      sendMessage: mock(() => Promise.resolve()),
      getStreamingMode: mock(() => 'batch' as const),
      getPlatformType: mock(() => 'test'),
      sendStructuredEvent: mock(() => Promise.resolve()),
    };

    await executeDagWorkflow(
      deps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'already-satisfied-plan-review',
        nodes: [
          {
            id: 'gate-already-satisfied',
            prompt: 'Emit the precheck verdict.',
          },
          {
            id: 'plan',
            depends_on: ['gate-already-satisfied'],
            prompt: [
              'Draft a minimal plan that VERIFIES the already-satisfied work.',
              'Pre-check verdict from gate-already-satisfied:',
              '$gate-already-satisfied.output',
            ].join('\n'),
          },
          {
            id: 'plan-review',
            depends_on: ['plan'],
            loop: {
              prompt: [
                'Review the plan.',
                'Plan:',
                '$plan.output',
                'Pre-check verdict from gate-already-satisfied:',
                '$gate-already-satisfied.output',
                'If the line above contains PRECHECK_VERDICT=already-satisfied, approve a minimal verification plan.',
              ].join('\n'),
              until: 'PLAN_REVIEW_PASS=true',
              max_iterations: 3,
            },
          },
          {
            id: 'implement',
            depends_on: ['plan-review'],
            prompt: 'Implement reached after approved plan-review.',
          },
        ],
      },
      makeWorkflowRun('already-satisfied-plan-review-run'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(prompts).toHaveLength(4);
    expect(prompts[2]).toContain('PRECHECK_VERDICT=already-satisfied');
    expect(prompts[2]).toContain(
      'SATISFIED_EVIDENCE=branch already contains required plan-review change'
    );
    expect(prompts[2]).toContain(
      'Plan: verify the already-satisfied evidence without making code changes.'
    );
    expect(prompts[2]).not.toContain('$gate-already-satisfied.output');
    expect(mockSendQuery.mock.calls[2][0]).toBe(prompts[2]);
    expect(prompts[3]).toContain('Implement reached after approved plan-review.');
    expect(
      (
        store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls[0][1]
    ).toEqual({
      node_counts: { completed: 4, failed: 0, skipped: 0, total: 4 },
    });
    expect(
      (store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock.calls
    ).toHaveLength(0);
  });
});
