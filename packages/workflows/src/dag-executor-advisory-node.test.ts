// WO-HARNESS-ADVISORY-NODE-FAILURE-NOT-RUN-FAILURE-01 (bdc-xo#5651).
// Run e1baeeb2 (2026-11-12): the advisory pre-check node `check-already-satisfied` failed
// ("cursor-agent exited 0 with empty output"), every other node completed and
// `blocked-terminal-gate` printed PROCEED, yet the run ended failed and started a redundant rung.
// A run whose ONLY failed nodes are advisory, with a passed terminal gate, now ends completed
// (terminal_cause advisory_degraded). Any other failure, or a gate that did not pass, still fails.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as git from '@archon/git';
import { executeDagWorkflow } from './dag-executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

type Node = Record<string, unknown>;
type Calls = Array<[string, Record<string, unknown>, { eventData: Record<string, unknown> }]>;

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

describe('executeDagWorkflow -- advisory node failures', () => {
  let dir: string;
  let exec: ReturnType<typeof spyOn>;
  // node id -> behavior of its bash script: 'ok' | 'fail' | any other string = stdout
  let behavior: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.advisory-node-test-'));
    behavior = {};
    exec = spyOn(git, 'execFileAsync').mockImplementation(
      async (command: string, args?: readonly string[]) => {
        if (command !== 'bash') return { stdout: '', stderr: '' };
        const scriptFile = String(args?.[0] ?? '');
        // The script file name carries the node id: node-<id>-<runId>.sh
        const id = Object.keys(behavior).find(k => scriptFile.includes(`node-${k}-`));
        const what = id ? behavior[id] : 'ok';
        // Reading the script proves the node really ran through the bash path.
        readFileSync(scriptFile, 'utf8');
        if (what === 'fail') {
          throw Object.assign(new Error('Command failed: exit 1'), {
            code: 1,
            stdout: '',
            stderr: 'simulated node failure',
          });
        }
        return { stdout: what === 'ok' ? 'ok' : what, stderr: '' };
      }
    );
  });

  afterEach(async () => {
    exec.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(nodes: Node[]): Promise<{
    complete: Calls;
    fail: Array<[string, string, { metadata: { terminal_cause: string } }]>;
  }> {
    const completeWorkflowRun = mock(async () => {});
    const failWorkflowRun = mock(async () => {});
    const store = new Proxy(
      { completeWorkflowRun, failWorkflowRun },
      {
        get(target, key) {
          if (key === 'completeWorkflowRun') return target.completeWorkflowRun;
          if (key === 'failWorkflowRun') return target.failWorkflowRun;
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
    };
    const platform: IWorkflowPlatform = {
      sendMessage: async () => {},
      getStreamingMode: () => 'batch',
      getPlatformType: () => 'test',
    };
    const workflowRun: WorkflowRun = {
      id: `advisory-${Math.random().toString(36).slice(2, 8)}`,
      workflow_name: 'advisory-test',
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
      { name: 'advisory-test', nodes } as never,
      workflowRun,
      'claude',
      undefined,
      join(dir, 'artifacts'),
      join(dir, 'logs'),
      'dev',
      'docs',
      config
    );
    return {
      complete: completeWorkflowRun.mock.calls as unknown as Calls,
      fail: failWorkflowRun.mock.calls as unknown as Array<
        [string, string, { metadata: { terminal_cause: string } }]
      >,
    };
  }

  const advisory: Node = { id: 'check-already-satisfied', bash: 'echo advisory' };
  const implement: Node = { id: 'implement', bash: 'echo implement' };
  const gate: Node = {
    id: 'blocked-terminal-gate',
    bash: 'echo gate',
    depends_on: ['implement'],
  };

  test('Test 1: advisory-only failure with a passed terminal gate ends completed (advisory_degraded)', async () => {
    behavior = {
      'check-already-satisfied': 'fail',
      implement: 'ok',
      'blocked-terminal-gate': 'blocked-terminal-gate: status=PROCEED -- run may complete.',
    };
    const { complete, fail } = await run([advisory, implement, gate]);
    expect(fail).toHaveLength(0);
    expect(complete).toHaveLength(1);
    const meta = complete[0][1];
    expect(meta.terminal_cause).toBe('advisory_degraded');
    expect(meta.advisory_degraded).toBe(true);
    expect(meta.failed_advisory_nodes).toEqual(['check-already-satisfied']);
    expect(meta.paperwork_degraded).toBeUndefined();
    const eventData = complete[0][2].eventData;
    expect(eventData.terminal_cause).toBe('advisory_degraded');
    expect(eventData.failed_advisory_nodes).toEqual(['check-already-satisfied']);
  });

  test('Test 2: a failed required node still fails the run, and lists the advisory node too', async () => {
    // 'setup' completes, so the run reaches the node-failure block (not "no successful nodes").
    behavior = { 'check-already-satisfied': 'fail', implement: 'fail' };
    const setup: Node = { id: 'setup', bash: 'echo setup' };
    const { complete, fail } = await run([setup, advisory, implement, gate]);
    expect(complete).toHaveLength(0);
    expect(fail).toHaveLength(1);
    expect(fail[0][1]).toContain("'implement'");
    expect(fail[0][1]).toContain("'check-already-satisfied'");
    expect(fail[0][2].metadata.terminal_cause).toBe('node_failures');
  });

  test('Test 3: a failed terminal gate still fails the run', async () => {
    behavior = {
      'check-already-satisfied': 'fail',
      implement: 'ok',
      'blocked-terminal-gate': 'fail',
    };
    const { complete, fail } = await run([advisory, implement, gate]);
    expect(complete).toHaveLength(0);
    expect(fail).toHaveLength(1);
    expect(fail[0][2].metadata.terminal_cause).toBe('node_failures');
  });

  test('Test 3b: a skipped terminal gate is not a passed gate', async () => {
    // The gate depends on the failed advisory node, so it is skipped (default trigger rule).
    behavior = { 'check-already-satisfied': 'fail', implement: 'ok' };
    const skippedGate: Node = {
      id: 'blocked-terminal-gate',
      bash: 'echo gate',
      depends_on: ['check-already-satisfied'],
    };
    const { complete, fail } = await run([advisory, implement, skippedGate]);
    expect(complete).toHaveLength(0);
    expect(fail).toHaveLength(1);
  });

  test('Test 3c: an evidence node that did not complete keeps the run failed', async () => {
    behavior = {
      'check-already-satisfied': 'fail',
      implement: 'ok',
      'blocked-terminal-gate': 'ok',
    };
    const evidence: Node = {
      id: 'build-manifest',
      evidence: { kind: 'manifest_v2', required_gates: [] },
      depends_on: ['check-already-satisfied'], // skipped: the advisory node failed
    };
    const { complete, fail } = await run([advisory, implement, gate, evidence]);
    expect(complete).toHaveLength(0);
    expect(fail).toHaveLength(1);
  });

  test('Test 3d: without a terminal gate node a pushed artifact is required', async () => {
    behavior = { 'check-already-satisfied': 'fail', implement: 'no artifact here' };
    const noArtifact = await run([advisory, implement]);
    expect(noArtifact.complete).toHaveLength(0);
    expect(noArtifact.fail).toHaveLength(1);

    behavior = {
      'check-already-satisfied': 'fail',
      implement: 'PR_URL=https://github.com/fixture/repo/pull/7',
    };
    const withArtifact = await run([advisory, implement]);
    expect(withArtifact.fail).toHaveLength(0);
    expect(withArtifact.complete).toHaveLength(1);
    expect(withArtifact.complete[0][1].terminal_cause).toBe('advisory_degraded');
  });

  test('Test 4: the paperwork rule is unchanged (no advisory keys, same cause and fields)', async () => {
    behavior = {
      implement: 'PR_URL=https://github.com/fixture/repo/pull/9',
      'flip-notion': 'fail',
    };
    const flip: Node = { id: 'flip-notion', bash: 'echo flip', depends_on: ['implement'] };
    const { complete, fail } = await run([implement, flip]);
    expect(fail).toHaveLength(0);
    expect(complete).toHaveLength(1);
    const meta = complete[0][1];
    expect(meta.terminal_cause).toBe('paperwork_degraded');
    expect(meta.paperwork_degraded).toBe(true);
    expect(meta.degraded_paperwork_nodes).toEqual(['flip-notion']);
    expect(meta.advisory_degraded).toBeUndefined();
    expect(meta.failed_advisory_nodes).toBeUndefined();
    expect(complete[0][2].eventData.paperwork_degraded).toBe(true);
  });
});
