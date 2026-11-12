// WO-HARNESS-RUN-LEASE-LOST-SAYS-SO-01 (bdc-xo#5695).
// Run cf52e179 (2026-11-12): its lease stopped being renewed 6 minutes in, the run kept building 12 minutes,
// then the executor stopped at the next check and wrote nothing, so the run ended with the backstop's generic
// "Workflow exited without finalizing". Now the stop writes one `run_lease_lost` event that says where it
// stopped and the measured numbers.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import * as git from '@archon/git';
import { executeDagWorkflow } from './dag-executor';
import { clearRunLeaseLossesForTests, getRunLeaseLoss } from './run-lease';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

type Node = Record<string, unknown>;
interface LeaseEvent {
  event_type: string;
  data: Record<string, unknown>;
}

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

const BASE = Date.parse('2026-11-12T17:50:41.372Z');

describe('executeDagWorkflow -- a lost run lease says so', () => {
  let dir: string;
  let exec: ReturnType<typeof spyOn>;
  let ran: string[];
  let current: number;

  beforeEach(async () => {
    clearRunLeaseLossesForTests();
    dir = await mkdtemp(join(process.cwd(), '.lease-lost-test-'));
    ran = [];
    current = BASE;
    exec = spyOn(git, 'execFileAsync').mockImplementation(
      async (command: string, args?: readonly string[]) => {
        if (command !== 'bash') return { stdout: '', stderr: '' };
        const scriptFile = String(args?.[0] ?? '');
        const id = ['setup', 'later', 'only'].find(k => scriptFile.includes(`node-${k}-`));
        if (id) ran.push(id);
        if (id === 'setup' || id === 'only') {
          // Long enough for the 5 ms heartbeat to be refused, then move the clock 150 s on.
          await new Promise(resolve => setTimeout(resolve, 60));
          current = BASE + 150_000;
        }
        return { stdout: 'ok', stderr: '' };
      }
    );
  });

  afterEach(async () => {
    exec.mockRestore();
    clearRunLeaseLossesForTests();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(nodes: Node[]): Promise<{
    events: LeaseEvent[];
    completed: number;
    runId: string;
  }> {
    const events: LeaseEvent[] = [];
    const completeWorkflowRun = mock(async () => {});
    const failWorkflowRun = mock(async () => {});
    const store = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'getRunAuthority') return async () => ({ runId: 'x' });
          if (key === 'claimRunLease') return async (lease: unknown) => lease;
          // The store refuses every renewal: the lease is lost at the first heartbeat.
          if (key === 'heartbeatRunLease') return async () => false;
          if (key === 'releaseRunLease') return async () => true;
          if (key === 'getWorkflowRun') {
            return async () => ({ id: 'x', status: 'running', metadata: {} });
          }
          if (key === 'createWorkflowEvent') {
            return async (event: LeaseEvent) => {
              events.push(event);
            };
          }
          if (key === 'completeWorkflowRun') return completeWorkflowRun;
          if (key === 'failWorkflowRun') return failWorkflowRun;
          if (key === 'getWorkflowRunStatus') return async () => 'running';
          if (key === 'getCodebaseEnvVars') return async () => ({});
          if (key === 'listWorkflowEvents') return async () => [];
          return async () => null;
        },
      }
    ) as unknown as IWorkflowStore;
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: () => {
        throw new Error('no AI expected');
      },
      loadConfig: async () => config,
      runLeaseTiming: { heartbeatIntervalMs: 5, now: () => new Date(current) },
    };
    const platform: IWorkflowPlatform = {
      sendMessage: async () => {},
      getStreamingMode: () => 'batch',
      getPlatformType: () => 'test',
    };
    const runId = `lease-${Math.random().toString(36).slice(2, 8)}`;
    const workflowRun: WorkflowRun = {
      id: runId,
      workflow_name: 'lease-test',
      conversation_id: 'fixture',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      user_message: '',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: dir,
    };
    await executeDagWorkflow(
      deps,
      platform,
      'fixture',
      dir,
      { name: 'lease-test', nodes } as never,
      workflowRun,
      'claude',
      undefined,
      join(dir, 'artifacts'),
      join(dir, 'logs'),
      'dev',
      'docs',
      config
    );
    return { events, completed: completeWorkflowRun.mock.calls.length, runId };
  }

  test('Test 3: the layer-boundary stop writes one run_lease_lost event and starts no later node', async () => {
    const { events, runId } = await run([
      { id: 'setup', bash: 'echo setup' },
      { id: 'later', bash: 'echo later', depends_on: ['setup'] },
    ]);

    expect(ran).toEqual(['setup']);
    const lost = events.filter(event => event.event_type === 'run_lease_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].data).toEqual({
      where: 'layer_boundary',
      reason: 'renewal_refused',
      last_renewed_at: new Date(BASE).toISOString(),
      expires_at: new Date(BASE + 60_000).toISOString(),
      detected_at: new Date(BASE).toISOString(),
      // 150 s on the clock at the check minus the expiry at 60 s = 90 s
      gap_seconds: 90,
    });
    // the executor remembers where it stopped, for the backstop's failure message
    expect(getRunLeaseLoss(runId)?.stoppedAt).toBe('layer_boundary');
  });

  test('Test 4: the pre-terminal stop writes the event and never marks the run completed', async () => {
    const { events, completed, runId } = await run([{ id: 'only', bash: 'echo only' }]);

    expect(ran).toEqual(['only']);
    const lost = events.filter(event => event.event_type === 'run_lease_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].data.where).toBe('before_terminal');
    expect(lost[0].data.gap_seconds).toBe(90);
    expect(completed).toBe(0);
    expect(getRunLeaseLoss(runId)?.stoppedAt).toBe('before_terminal');
  });
});
