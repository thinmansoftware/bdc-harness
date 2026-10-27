/**
 * A fire-time probe block happens before the run is promoted to running.
 * failWorkflowRun must record that pending row as failed.
 */
import { expect, mock, test } from 'bun:test';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
}));

mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

mock.module('./dag-executor', () => ({
  executeDagWorkflow: mock(async () => {}),
  endRunProcessTree: async () => ({
    confirmedAt: new Date().toISOString(),
    survivors: [],
  }),
  recordTeardownBeforeStatus: async () => {},
}));

mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

mock.module('./reliability/fire-time-probe', () => ({
  runFireTimeProbe: async () => ({ blocked: true, warnings: [], bindings: [] }),
  formatProbeBlock: () => 'canary_probe_blocked',
}));

import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

import { executeWorkflow } from './executor';

interface FailCall {
  id: string;
  error: string;
  statusAtCall: string;
}

interface StoredEvent {
  event_type: string;
  data?: Record<string, unknown>;
}

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    createWorkflowEvent: mock(async () => {}),
    listWorkflowEvents: mock(async () => []),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map<string, string>()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store: IWorkflowStore): WorkflowDeps {
  return {
    store,
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'test', command: 'test' }],
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    status: 'pending',
    started_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

test('probe_blocked_run_ends_failed_not_pending', async () => {
  const failCalls: FailCall[] = [];
  const events: StoredEvent[] = [];
  let liveStatus = 'pending';
  const created = makeRun({ id: 'run-pending-1', status: 'pending' });

  const store = makeStore({
    createWorkflowRun: mock(async () => created),
    getActiveWorkflowRunByPath: mock(async () => null),
    getWorkflowRunStatus: mock(async () => liveStatus),
    failWorkflowRun: mock(async (id: string, error: string) => {
      failCalls.push({ id, error, statusAtCall: liveStatus });
      if (liveStatus === 'pending' || liveStatus === 'running') {
        liveStatus = 'failed';
        return;
      }
      throw new Error(`Workflow run not found or not in pending/running state (id: ${id})`);
    }),
    createWorkflowEvent: mock(async (event: StoredEvent) => {
      events.push({ event_type: event.event_type, data: event.data });
    }),
  });

  const result = await executeWorkflow(
    makeDeps(store),
    makePlatform(),
    'conv-123',
    '/tmp',
    makeWorkflow(),
    'User message',
    'db-conv-id'
  );

  expect(result.success).toBe(false);
  expect(failCalls).toHaveLength(1);
  expect(failCalls[0]?.id).toBe(created.id);
  expect(failCalls[0]?.statusAtCall).toBe('pending');
  expect(liveStatus).toBe('failed');

  const blocked = events.filter(event => event.event_type === 'dag_workflow_failed');
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.data?.reason).toBe('canary_probe_blocked');

  const workflowFailed = events.filter(event => event.event_type === 'workflow_failed');
  for (const event of workflowFailed) {
    expect(JSON.stringify(event.data ?? {})).not.toContain('not in running state');
  }
});
