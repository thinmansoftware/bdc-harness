// WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01 (bdc-xo#6687), engine piece.
//
// Two opt-in workflow-level keys:
//   unattended_questions: report -- a non-interactive loop node that escalates or
//     terminal-blocks writes its question to $ARTIFACTS_DIR/questions/<node>.md and
//     records the node COMPLETED with output `UNATTENDED_QUESTION=true` instead of
//     node_failed. (Tests 5 and 6.)
//   idle_handoff: overseer -- an AI step or loop step whose idle timer fires records the
//     workflow event `idle_handoff_overseer`, writes no node_failed for the timeout, and
//     completes with output `IDLE_HANDOFF=true` so a later `when:` can see it. (Test 18.)
// Without the keys every path behaves exactly as before.
//
// "Fake clock": like the existing idle tests in dag-executor.test.ts, the provider stub
// goes silent forever and the node declares a short `idle_timeout` (ms), so the engine's
// own idle timer fires quickly. No engine default is changed.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as git from '@archon/git';
import {
  clearRegistry,
  getAgentProvider,
  getProviderCapabilities,
  registerBuiltinProviders,
  registerProvider,
} from '@archon/providers';
clearRegistry();
registerBuiltinProviders();
registerProvider({
  id: 'openrouter',
  displayName: 'OpenRouter fixture',
  factory: () => getAgentProvider('codex'),
  capabilities: getProviderCapabilities('codex'),
  builtIn: false,
});
import { executeDagWorkflow, substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput } from './schemas/workflow-run';
import { isEvidenceNode } from './schemas';
import { parseWorkflow } from './loader';
import { evaluateCondition } from './condition-evaluator';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

type Ev = { event_type: string; step_name?: string; data?: Record<string, unknown> };
type Chunk = { type: string; content?: string; sessionId?: string; structuredOutput?: unknown };

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

const claudeCaps = (): Record<string, boolean> => ({
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

const ESCALATION_OUTPUT = [
  'Reviewed the plan.',
  'ESCALATION_REQUIRED=true',
  'ESCALATION_REASON=ambiguous-spec',
  'SINGLE_DECISION_NEEDED=Which table owns the pull-box totals?',
  '',
].join('\n');

const BLOCKED_OUTPUT =
  'Checked environment.\nBLOCKED: the paired bdc-xo worktree was not supplied\n';

const HANG = (): Promise<void> => new Promise<void>(() => {});

describe('dag-executor unattended questions and idle hand-off', () => {
  let dir: string;
  let exec: ReturnType<typeof spyOn>;
  let ranBash: string[];
  let script: (prompt: string) => AsyncGenerator<Chunk>;
  let bashOutput: (path: string) => string;
  let sendCalls: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'unattended-esc-'));
    ranBash = [];
    bashOutput = () => 'ran';
    sendCalls = 0;
    script = async function* () {
      yield { type: 'assistant', content: 'COMPLETE' };
      yield { type: 'result', sessionId: 's' };
    };
    exec = spyOn(git, 'execFileAsync').mockImplementation(
      async (command: string, args?: readonly string[]) => {
        if (command === 'bash') {
          // The script file is node-<id>-<runId>.sh; ran() below matches on it.
          const file = String(args?.[0] ?? '').replace(/\\/g, '/');
          ranBash.push(file);
          return { stdout: bashOutput(file), stderr: '' };
        }
        // git and anything else: no repo here, behave like an empty success.
        return { stdout: '', stderr: '' };
      }
    );
  });

  afterEach(async () => {
    exec.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function run(
    workflow: Record<string, unknown>,
    runId: string
  ): Promise<{ events: Ev[]; artifactsDir: string; failRun: number; completeRun: number }> {
    const events: Ev[] = [];
    const failWorkflowRun = mock(async () => {});
    const completeWorkflowRun = mock(async () => {});
    const store = new Proxy(
      {},
      {
        get(_t, key) {
          if (key === 'createWorkflowEvent') {
            return async (ev: Ev) => {
              events.push(ev);
            };
          }
          if (key === 'failWorkflowRun') return failWorkflowRun;
          if (key === 'completeWorkflowRun') return completeWorkflowRun;
          if (key === 'getWorkflowRunStatus') return async () => 'running';
          if (key === 'getCodebaseEnvVars') return async () => ({});
          if (key === 'listWorkflowEvents') return async () => [];
          if (key === 'listProviderAttempts') return async () => [];
          if (key === 'createProviderAttempt') return async () => true;
          if (key === 'completeProviderAttempt') return async () => true;
          if (key === 'getCompletedDagNodeOutputs') return async () => new Map();
          return async () => null;
        },
      }
    ) as unknown as IWorkflowStore;
    const deps: WorkflowDeps = {
      store,
      getAgentProvider: (() => ({
        sendQuery: (prompt: string) => {
          sendCalls += 1;
          return script(prompt);
        },
        getType: () => 'claude',
        getCapabilities: claudeCaps,
      })) as unknown as WorkflowDeps['getAgentProvider'],
      loadConfig: async () => config,
    };
    const platform: IWorkflowPlatform = {
      sendMessage: async () => {},
      getStreamingMode: () => 'batch',
      getPlatformType: () => 'test',
    };
    const workflowRun: WorkflowRun = {
      id: runId,
      workflow_name: String(workflow.name),
      conversation_id: 'fixture',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      user_message: 'Run WO-FIXTURE-UNATTENDED-01',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: dir,
    };
    const artifactsDir = join(dir, 'artifacts-' + runId);
    await executeDagWorkflow(
      deps,
      platform,
      'fixture',
      dir,
      workflow as never,
      workflowRun,
      'claude',
      undefined,
      artifactsDir,
      join(dir, 'logs-' + runId),
      'main',
      'docs/',
      config
    );
    return {
      events,
      artifactsDir,
      failRun: failWorkflowRun.mock.calls.length,
      completeRun: completeWorkflowRun.mock.calls.length,
    };
  }

  const ran = (id: string): boolean => ranBash.some(f => f.includes(`/node-${id}-`));

  const of = (events: Ev[], type: string, step: string): Ev[] =>
    events.filter(e => e.event_type === type && e.step_name === step);

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  test('T16: the real round chain runs five independent reviews and records one hand-off', async () => {
    const file = join(
      import.meta.dir,
      '../../../.archon/workflows/defaults/bdc-feature-development.yaml'
    );
    const result = parseWorkflow(await readFile(file, 'utf8'), file);
    expect(result.error).toBeNull();
    const ids = new Set([
      'diff-review',
      'classify-diff-review',
      'assert-implement-produced-work',
      'repair-gate',
      'checkpoint-diff-repair',
      ...Array.from({ length: 5 }, (_, index) => 'review-round-' + (index + 1)),
      'repair-round-1',
      'repair-round-2',
      'repair-round-3',
      'overseer-repair-round-4',
      'overseer-repair-round-5',
    ]);
    const nodes = (result.workflow?.nodes ?? [])
      .filter(node => ids.has(node.id))
      .map(node => ({ ...node, depends_on: node.depends_on?.filter(id => ids.has(id)) }));
    const verdict = { verdict: 'needs_revision', findings: ['Fixture finding'] };
    const head = 'a'.repeat(40);
    bashOutput = file => {
      if (file.includes('/node-classify-diff-review-')) return JSON.stringify(verdict);
      if (file.includes('/node-repair-gate-')) return '{"REPAIR_GATE_ALLOW":"yes"}';
      if (file.includes('/node-checkpoint-diff-repair-')) {
        return (
          'BDC_RUN_EVENT ' +
          JSON.stringify({
            event_type: 'repair_handoff_overseer',
            round: 3,
            head_sha: head,
            findings: verdict.findings,
          })
        );
      }
      return 'BUILD_OUTCOME=REAL_BUILD';
    };
    script = async function* (prompt) {
      if (prompt.includes('You are the Codex adversarial diff reviewer')) {
        yield { type: 'assistant', content: 'DIFF_REVIEW=needs_revision' };
      } else if (prompt.includes('Independently inspect the current committed head')) {
        yield { type: 'assistant', content: JSON.stringify(verdict) };
      } else {
        yield { type: 'assistant', content: 'Committed fixture repair' };
      }
      yield { type: 'result', sessionId: 'fixture' };
    };
    const { events, failRun } = await run({ name: 'repair-round-fixture', nodes }, 'fixture-t16');
    expect(failRun).toBe(0);
    const reviewEvents = events.filter(
      event => event.event_type === 'node_completed' && /^review-round-/.test(event.step_name ?? '')
    );
    expect(reviewEvents.map(event => event.step_name)).toEqual(
      Array.from({ length: 5 }, (_, index) => 'review-round-' + (index + 1))
    );
    const handoff = events.filter(event => event.event_type === 'repair_handoff_overseer');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.data).toMatchObject({
      round: 3,
      head_sha: head,
      findings: verdict.findings,
    });
    const opening = of(events, 'node_completed', 'diff-review');
    expect(opening).toHaveLength(1);
    expect(events.indexOf(opening[0]!)).toBeLessThan(events.indexOf(reviewEvents[0]!));
    expect(events.indexOf(handoff[0]!)).toBeGreaterThan(events.indexOf(reviewEvents[2]!));
    expect(events.indexOf(handoff[0]!)).toBeLessThan(events.indexOf(reviewEvents[3]!));
  });

  for (const scenario of ['wall-salvage', 'clean', 'question', 'empty'] as const) {
    test('T15: loaded lane publication order for ' + scenario, async () => {
      const file = join(
        import.meta.dir,
        '../../../.archon/workflows/defaults/bdc-feature-development.yaml'
      );
      const result = parseWorkflow(await readFile(file, 'utf8'), file);
      expect(result.error).toBeNull();
      const keep = new Set([
        'plan-review',
        'repair-gate',
        'implement',
        'checkpoint-push',
        'assert-implement-produced-work',
        'block-reclassify',
        'noninteractive-salvage',
        'commit-and-push',
        'open-pr-if-needed',
        'blocked-issue',
        'hold-if-findings',
      ]);
      const nodes = (result.workflow?.nodes ?? [])
        .filter(node => keep.has(node.id))
        .map(node => {
          const depends_on = node.depends_on?.filter(dep => keep.has(dep)) ?? [];
          if (node.id === 'plan-review') return { id: node.id, bash: 'echo plan', depends_on };
          if (node.id === 'implement')
            return {
              ...node,
              depends_on,
              when: "$plan-review.output != 'UNATTENDED_QUESTION=true'",
              trigger_rule: 'all_done',
              wall_timeout_ms: 250,
              idle_timeout: 350,
              loop: { prompt: 'Implement fixture', until: 'COMPLETE', max_iterations: 1 },
            };
          if (node.id === 'block-reclassify') depends_on.push('assert-implement-produced-work');
          return { ...node, depends_on };
        });
      const stage = (file: string, id: string) => file.includes('/node-' + id + '-');
      const publications: string[] = [];
      const committed: string[] = [];
      bashOutput = file => {
        if (stage(file, 'plan-review'))
          return scenario === 'question' ? 'UNATTENDED_QUESTION=true' : 'APPROVED';
        if (stage(file, 'repair-gate')) return '{"REPAIR_GATE_ALLOW":"yes"}';
        if (stage(file, 'assert-implement-produced-work'))
          return scenario === 'question'
            ? 'BUILD_OUTCOME=RETURNED_TO_AUTHOR'
            : scenario === 'empty'
              ? 'BUILD_OUTCOME=FALSE_COMPLETE'
              : 'BUILD_OUTCOME=REAL_BUILD';
        if (stage(file, 'block-reclassify'))
          return scenario === 'clean' ? '{"status":"PROCEED"}' : '{"status":"BLOCKED"}';
        if (stage(file, 'noninteractive-salvage') && scenario === 'wall-salvage')
          committed.push('salvage');
        if (stage(file, 'commit-and-push')) {
          if (scenario === 'empty') throw new Error('nothing produced');
          publications.push('push');
        }
        if (stage(file, 'open-pr-if-needed')) publications.push('open');
        if (stage(file, 'hold-if-findings') && publications.includes('open')) {
          if (scenario === 'wall-salvage') publications.push('hold');
          publications.push('ready');
        }
        return 'fixture';
      };
      script = async function* () {
        if (scenario === 'wall-salvage') {
          yield { type: 'assistant', content: 'Started work before wall timeout' };
          await HANG();
        }
        yield { type: 'assistant', content: 'COMPLETE' };
        yield { type: 'result', sessionId: 'fixture' };
      };
      const { events } = await run(
        { name: 'publication-order-fixture', nodes },
        'fixture-t15-' + scenario
      );
      if (scenario === 'wall-salvage') {
        expect(of(events, 'node_failed', 'implement')).toHaveLength(1);
        expect(committed).toEqual(['salvage']);
        expect(publications).toEqual(['push', 'open', 'hold', 'ready']);
        const position = (id: string) => ranBash.findIndex(file => stage(file, id));
        expect(position('noninteractive-salvage')).toBeLessThan(position('commit-and-push'));
      } else if (scenario === 'clean') {
        expect(committed).toEqual([]);
        expect(publications).toEqual(['push', 'open', 'ready']);
      } else if (scenario === 'question') {
        expect(of(events, 'node_started', 'implement')).toHaveLength(0);
        expect(ran('blocked-issue')).toBe(true);
        expect(publications).toEqual([]);
      } else {
        expect(of(events, 'node_failed', 'commit-and-push')).toHaveLength(1);
        expect(publications).toEqual([]);
      }
    });
  }

  // Test 20 trigger disposition: bdc-xo#6687 comment 7211389114.
  test('T20: test repair idles after checkpoint publication and the look follows the draft', async () => {
    const file = join(
      import.meta.dir,
      '../../../.archon/workflows/defaults/bdc-feature-development.yaml'
    );
    const result = parseWorkflow(await readFile(file, 'utf8'), file);
    expect(result.error).toBeNull();
    const keep = new Set([
      'repair-gate',
      'checkpoint-push',
      'assert-implement-produced-work',
      'classify-test-result',
      'test-repair',
      'run-stop-tests-final',
      'commit-and-push',
      'open-pr-if-needed',
      'build-manifest',
      'overseer-idle-look',
      'hold-if-findings',
    ]);
    const dependencies = (id: string, existing: readonly string[] = []): string[] => {
      const filtered = existing.filter(dep => keep.has(dep));
      if (id === 'classify-test-result') return [...filtered, 'assert-implement-produced-work'];
      if (id === 'commit-and-push') return [...filtered, 'run-stop-tests-final'];
      return filtered;
    };
    const nodes = (result.workflow?.nodes ?? [])
      .filter(node => keep.has(node.id))
      .map(node => {
        const depends_on = dependencies(node.id, node.depends_on);
        if (node.id === 'repair-gate') return { id: node.id, depends_on, bash: 'echo gate' };
        if (node.id === 'build-manifest')
          return { id: node.id, depends_on, bash: 'echo mechanical evidence' };
        return { ...node, depends_on, ...(node.id === 'test-repair' ? { idle_timeout: 200 } : {}) };
      });
    bashOutput = file => {
      if (file.includes('/node-repair-gate-')) return '{"REPAIR_GATE_ALLOW":"yes"}';
      if (file.includes('/node-classify-test-result-')) return '{"repairable":"true"}';
      return 'fixture';
    };
    script = async function* (prompt) {
      if (prompt.includes('Repair the real test failure')) {
        yield { type: 'assistant', content: 'Fix started before provider stopped.' };
        await HANG();
      }
      yield {
        type: 'assistant',
        content: '{"class":"fixed","evidence":"Committed fixture repair"}',
      };
      yield { type: 'result', sessionId: 'fixture' };
    };
    const { events, artifactsDir } = await run(
      { name: 'idle-republication-fixture', idle_handoff: 'overseer', nodes },
      'fixture-t20'
    );
    const handoffs = of(events, 'idle_handoff_overseer', 'test-repair');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.data?.last_output).toContain('Fix started');
    expect(of(events, 'node_failed', 'test-repair')).toHaveLength(0);
    const proof = JSON.parse(
      await readFile(join(artifactsDir, 'idle-handoffs/test-repair.json'), 'utf8')
    );
    expect(proof.last_output).toContain('Fix started');
    const completed = (id: string) => of(events, 'node_completed', id);
    for (const id of [
      'checkpoint-push',
      'open-pr-if-needed',
      'overseer-idle-look',
      'hold-if-findings',
    ]) {
      expect(completed(id)).toHaveLength(1);
    }
    const position = (id: string) => events.indexOf(completed(id)[0]!);
    expect(position('checkpoint-push')).toBeLessThan(events.indexOf(handoffs[0]!));
    expect(position('open-pr-if-needed')).toBeLessThan(position('overseer-idle-look'));
    expect(position('overseer-idle-look')).toBeLessThan(position('hold-if-findings'));
  });

  // -------------------------------------------------------------------------
  // Test 5: unattended_questions: report
  // -------------------------------------------------------------------------

  for (const nodeId of ['plan-review', 'diff-repair']) {
    test(`T5: ${nodeId} escalation with the key completes, writes the question, no node_failed`, async () => {
      script = async function* () {
        yield { type: 'assistant', content: ESCALATION_OUTPUT };
        yield { type: 'result', sessionId: 's-esc' };
      };
      const { events, artifactsDir } = await run(
        {
          name: 'unattended-esc',
          unattended_questions: 'report',
          nodes: [
            {
              id: nodeId,
              loop: { prompt: 'review', until: 'PLAN_REVIEW_APPROVED', max_iterations: 3 },
            },
            {
              id: 'blocked-issue',
              bash: 'echo post question',
              depends_on: [nodeId],
              when: `$${nodeId}.output == 'UNATTENDED_QUESTION=true'`,
            },
          ],
        },
        `t5-esc-${nodeId}`
      );

      expect(sendCalls).toBe(1);
      expect(of(events, 'node_failed', nodeId)).toHaveLength(0);
      const completed = of(events, 'node_completed', nodeId);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.data?.node_output).toBe('UNATTENDED_QUESTION=true');
      expect(completed[0]?.data?.unattended_question).toBe(true);
      expect(completed[0]?.data?.escalation_reason).toBe('ambiguous-spec');

      const question = await readFile(join(artifactsDir, 'questions', `${nodeId}.md`), 'utf8');
      expect(question).toContain('Which table owns the pull-box totals?');
      expect(question).toContain('ambiguous-spec');

      // The escalation packet is still written exactly as today.
      const packet = JSON.parse(
        await readFile(
          join(artifactsDir, 'escalations', `WO-FIXTURE-UNATTENDED-01-${nodeId}-escalation.json`),
          'utf8'
        )
      ) as Record<string, unknown>;
      expect(packet.escalationRequired).toBe(true);
      expect(packet.escalationReason).toBe('ambiguous-spec');

      // when: can read the end state -- the downstream node ran.
      expect(ran('blocked-issue')).toBe(true);
      expect(of(events, 'node_completed', 'blocked-issue')).toHaveLength(1);
    });
  }

  test('T5: terminal-blocked with the key completes, writes the question, no node_failed', async () => {
    script = async function* () {
      yield { type: 'assistant', content: BLOCKED_OUTPUT };
      yield { type: 'result', sessionId: 's-blk' };
    };
    const { events, artifactsDir } = await run(
      {
        name: 'unattended-blocked',
        unattended_questions: 'report',
        nodes: [
          { id: 'implement', loop: { prompt: 'build', until: 'COMPLETE', max_iterations: 5 } },
          {
            id: 'blocked-issue',
            bash: 'echo post question',
            depends_on: ['implement'],
            when: "$implement.output == 'UNATTENDED_QUESTION=true'",
          },
        ],
      },
      't5-blocked'
    );

    expect(sendCalls).toBe(1);
    expect(of(events, 'node_failed', 'implement')).toHaveLength(0);
    const completed = of(events, 'node_completed', 'implement');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data?.node_output).toBe('UNATTENDED_QUESTION=true');
    expect(completed[0]?.data?.blocked_reason).toBe('the paired bdc-xo worktree was not supplied');
    const question = await readFile(join(artifactsDir, 'questions', 'implement.md'), 'utf8');
    expect(question).toContain('the paired bdc-xo worktree was not supplied');
    expect(ran('blocked-issue')).toBe(true);
  });

  test('T5: a prior escalation binding with the key completes instead of failing', async () => {
    script = async function* () {
      yield { type: 'assistant', content: 'should never be called' };
    };
    const runId = 't5-prior';
    const artifactsDir = join(dir, 'artifacts-' + runId);
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'diff-repair-escalation.txt'), ESCALATION_OUTPUT, 'utf8');
    const { events } = await run(
      {
        name: 'unattended-prior',
        unattended_questions: 'report',
        nodes: [
          { id: 'diff-repair', loop: { prompt: 'repair', until: 'COMPLETE', max_iterations: 3 } },
        ],
      },
      runId
    );
    expect(sendCalls).toBe(0);
    expect(of(events, 'node_failed', 'diff-repair')).toHaveLength(0);
    expect(of(events, 'node_completed', 'diff-repair')[0]?.data?.node_output).toBe(
      'UNATTENDED_QUESTION=true'
    );
    const question = await readFile(join(artifactsDir, 'questions', 'diff-repair.md'), 'utf8');
    expect(question).toContain('Which table owns the pull-box totals?');
  });

  // -------------------------------------------------------------------------
  // Test 6: without the key (or interactive) nothing changes
  // -------------------------------------------------------------------------

  test('T6: escalation without the key fails with the exact message of today', async () => {
    script = async function* () {
      yield { type: 'assistant', content: ESCALATION_OUTPUT };
      yield { type: 'result', sessionId: 's-esc' };
    };
    const { events, artifactsDir, failRun } = await run(
      {
        name: 'no-key-esc',
        nodes: [
          {
            id: 'plan-review',
            loop: { prompt: 'review', until: 'PLAN_REVIEW_APPROVED', max_iterations: 3 },
          },
        ],
      },
      't6-esc'
    );
    const failed = of(events, 'node_failed', 'plan-review');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.error).toBe(
      "Loop node 'plan-review' escalated at iteration 1: Which table owns the pull-box totals?"
    );
    expect(failed[0]?.data?.terminal_escalation).toBe(true);
    expect(of(events, 'node_completed', 'plan-review')).toHaveLength(0);
    expect(failRun).toBe(1);
    expect(await exists(join(artifactsDir, 'questions'))).toBe(false);
  });

  test('T6: terminal-blocked without the key fails with the exact message of today', async () => {
    script = async function* () {
      yield { type: 'assistant', content: BLOCKED_OUTPUT };
      yield { type: 'result', sessionId: 's-blk' };
    };
    const { events, artifactsDir, failRun } = await run(
      {
        name: 'no-key-blocked',
        nodes: [
          { id: 'implement', loop: { prompt: 'build', until: 'COMPLETE', max_iterations: 5 } },
        ],
      },
      't6-blocked'
    );
    const failed = of(events, 'node_failed', 'implement');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.error).toBe(
      "Loop node 'implement' terminal-blocked at iteration 1: the paired bdc-xo worktree was not supplied"
    );
    expect(failed[0]?.data?.terminal_blocked).toBe(true);
    expect(failRun).toBe(1);
    expect(await exists(join(artifactsDir, 'questions'))).toBe(false);
  });

  test('T6: a prior escalation binding without the key fails with the exact message of today', async () => {
    const runId = 't6-prior';
    const artifactsDir = join(dir, 'artifacts-' + runId);
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, 'diff-repair-escalation.txt'), ESCALATION_OUTPUT, 'utf8');
    const { events } = await run(
      {
        name: 'no-key-prior',
        nodes: [
          { id: 'diff-repair', loop: { prompt: 'repair', until: 'COMPLETE', max_iterations: 3 } },
        ],
      },
      runId
    );
    const failed = of(events, 'node_failed', 'diff-repair');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.error).toBe(
      "Loop node 'diff-repair' terminal-escalated at iteration 1: prior escalation binding honored (ambiguous-spec); SINGLE_DECISION_NEEDED=Which table owns the pull-box totals?"
    );
  });

  test('T6: an interactive loop node WITH the key keeps today behavior (escalation and blocked)', async () => {
    script = async function* () {
      yield { type: 'assistant', content: ESCALATION_OUTPUT };
      yield { type: 'result', sessionId: 's-esc' };
    };
    const esc = await run(
      {
        name: 'interactive-esc',
        unattended_questions: 'report',
        nodes: [
          {
            id: 'plan-review',
            loop: {
              prompt: 'review',
              until: 'PLAN_REVIEW_APPROVED',
              max_iterations: 3,
              interactive: true,
              gate_message: 'Approve the plan?',
            },
          },
        ],
      },
      't6-interactive-esc'
    );
    const escFailed = of(esc.events, 'node_failed', 'plan-review');
    expect(escFailed).toHaveLength(1);
    expect(escFailed[0]?.data?.error).toBe(
      "Loop node 'plan-review' escalated at iteration 1: Which table owns the pull-box totals?"
    );
    expect(of(esc.events, 'node_completed', 'plan-review')).toHaveLength(0);
    expect(await exists(join(esc.artifactsDir, 'questions'))).toBe(false);

    script = async function* () {
      yield { type: 'assistant', content: BLOCKED_OUTPUT };
      yield { type: 'result', sessionId: 's-blk' };
    };
    const blk = await run(
      {
        name: 'interactive-blocked',
        unattended_questions: 'report',
        nodes: [
          {
            id: 'implement',
            loop: {
              prompt: 'build',
              until: 'COMPLETE',
              max_iterations: 5,
              interactive: true,
              gate_message: 'Continue?',
            },
          },
        ],
      },
      't6-interactive-blocked'
    );
    const blkFailed = of(blk.events, 'node_failed', 'implement');
    expect(blkFailed).toHaveLength(1);
    expect(blkFailed[0]?.data?.error).toBe(
      "Loop node 'implement' terminal-blocked at iteration 1: the paired bdc-xo worktree was not supplied"
    );
    expect(await exists(join(blk.artifactsDir, 'questions'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 18: idle_handoff: overseer
  // -------------------------------------------------------------------------

  const idleStepWorkflow = (withKey: boolean): Record<string, unknown> => ({
    name: withKey ? 'idle-step-key' : 'idle-step-nokey',
    ...(withKey ? { idle_handoff: 'overseer' } : {}),
    nodes: [
      { id: 'build-manifest', prompt: 'write the manifest', idle_timeout: 200 },
      {
        id: 'overseer-idle-look',
        bash: 'echo look',
        depends_on: ['build-manifest'],
        trigger_rule: 'all_done',
        when: "$build-manifest.output == 'IDLE_HANDOFF=true'",
      },
    ],
  });

  const idleLoopWorkflow = (withKey: boolean): Record<string, unknown> => ({
    name: withKey ? 'idle-loop-key' : 'idle-loop-nokey',
    ...(withKey ? { idle_handoff: 'overseer' } : {}),
    nodes: [
      {
        id: 'implement',
        idle_timeout: 200,
        loop: { prompt: 'build', until: 'COMPLETE', max_iterations: 3 },
      },
      {
        id: 'overseer-idle-look',
        bash: 'echo look',
        depends_on: ['implement'],
        trigger_rule: 'all_done',
        when: "$implement.output == 'IDLE_HANDOFF=true'",
      },
    ],
  });

  test('T18: an idle ordinary step with the key hands off to the Overseer look', async () => {
    script = async function* () {
      yield { type: 'assistant', content: 'line one of the manifest\nlast words before the hang' };
      await HANG();
    };
    const { events } = await run(idleStepWorkflow(true), 't18-step-key');

    const handoff = events.filter(e => e.event_type === 'idle_handoff_overseer');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.step_name).toBe('build-manifest');
    expect(handoff[0]?.data?.step_id).toBe('build-manifest');
    expect(handoff[0]?.data?.idle_ms).toBe(200);
    expect(String(handoff[0]?.data?.last_output)).toContain('last words before the hang');
    expect(of(events, 'node_failed', 'build-manifest')).toHaveLength(0);
    expect(of(events, 'node_completed', 'build-manifest')[0]?.data?.node_output).toBe(
      'IDLE_HANDOFF=true'
    );
    expect(ran('overseer-idle-look')).toBe(true);
    expect(sendCalls).toBe(1);
  });

  test('T18: an idle loop step with the key hands off to the Overseer look', async () => {
    script = async function* () {
      yield { type: 'assistant', content: 'loop said something then hung' };
      await HANG();
    };
    const { events } = await run(idleLoopWorkflow(true), 't18-loop-key');

    const handoff = events.filter(e => e.event_type === 'idle_handoff_overseer');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.data?.step_id).toBe('implement');
    expect(handoff[0]?.data?.idle_ms).toBe(200);
    expect(String(handoff[0]?.data?.last_output)).toContain('loop said something then hung');
    expect(of(events, 'node_failed', 'implement')).toHaveLength(0);
    expect(of(events, 'node_completed', 'implement')[0]?.data?.node_output).toBe(
      'IDLE_HANDOFF=true'
    );
    expect(ran('overseer-idle-look')).toBe(true);
    // The engine re-runs nothing: one provider call, no second iteration.
    expect(sendCalls).toBe(1);
  });

  test('T18: the hand-off keeps only the last 200 lines of output', async () => {
    const lines = Array.from({ length: 250 }, (_v, n) => `out-line-${String(n + 1)}`);
    script = async function* () {
      yield { type: 'assistant', content: lines.join('\n') };
      await HANG();
    };
    const { events } = await run(idleStepWorkflow(true), 't18-step-trunc');
    const last = String(
      events.find(e => e.event_type === 'idle_handoff_overseer')?.data?.last_output
    );
    expect(last.split('\n')).toHaveLength(200);
    expect(last).toContain('out-line-250');
    expect(last).toContain('out-line-51');
    expect(last).not.toContain('out-line-50\n');
  });

  test('T18: without the key an idle ordinary step fails exactly as today', async () => {
    script = async function* () {
      yield { type: 'assistant', content: 'working' };
      await HANG();
    };
    const { events } = await run(idleStepWorkflow(false), 't18-step-nokey');
    expect(events.filter(e => e.event_type === 'idle_handoff_overseer')).toHaveLength(0);
    const failed = of(events, 'node_failed', 'build-manifest');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.reason_code).toBe('progress_timeout');
    expect(failed[0]?.data?.reason).toBe('provider_silent');
    expect(failed[0]?.data?.error).toBe(
      "Node 'build-manifest' provider_silent: no provider output for 200ms"
    );
    expect(of(events, 'node_completed', 'build-manifest')).toHaveLength(0);
    expect(ran('overseer-idle-look')).toBe(false);
  });

  test('T18: without the key an idle loop step fails exactly as today', async () => {
    script = async function* () {
      yield { type: 'assistant', content: 'working' };
      await HANG();
    };
    const { events } = await run(idleLoopWorkflow(false), 't18-loop-nokey');
    expect(events.filter(e => e.event_type === 'idle_handoff_overseer')).toHaveLength(0);
    const failed = of(events, 'node_failed', 'implement');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data?.error).toBe(
      "Loop 'implement' iteration 1 exceeded idle timeout (200ms)"
    );
    expect(of(events, 'node_completed', 'implement')).toHaveLength(0);
    expect(ran('overseer-idle-look')).toBe(false);
  });
});

test('round five is gated on an independent revision verdict and no protected prerequisite', async () => {
  const file = join(
    import.meta.dir,
    '../../../.archon/workflows/defaults/bdc-feature-development.yaml'
  );
  const result = parseWorkflow(await readFile(file, 'utf8'), file);
  expect(result.error).toBeNull();
  const nodes = result.workflow?.nodes ?? [];
  const roundFive = nodes.find(node => node.id === 'overseer-repair-round-5');
  expect(roundFive?.when).toBeDefined();
  const evaluate = (repair: string, review: string): boolean =>
    evaluateCondition(
      roundFive!.when!,
      new Map([
        ['overseer-repair-round-4', { state: 'completed', output: repair }],
        ['review-round-4', { state: 'completed', output: review }],
      ]) as Map<string, NodeOutput>
    ).result;
  const revision = '{"verdict":"needs_revision","findings":["Required fix"]}';
  expect(evaluate('CLOSED_LIST=production settings', revision)).toBe(false);
  expect(evaluate('CLOSED_LIST=secrets', revision)).toBe(false);
  expect(evaluate('CLOSED_LIST=another product contract', revision)).toBe(false);
  expect(evaluate('Committed a fix.', revision)).toBe(true);
  expect(evaluate('Committed a fix.', 'invalid JSON')).toBe(false);
  expect(evaluate('Committed a fix.', '{"verdict":"approve","findings":[]}')).toBe(false);
});

test('rebuilt lane schedules the idle look after manifest and before issue return and ready', async () => {
  const filename = join(
    import.meta.dir,
    '../../../.archon/workflows/defaults/bdc-feature-development.yaml'
  );
  const result = parseWorkflow(await readFile(filename, 'utf8'), filename);
  expect(result.error).toBeNull();
  const nodes = result.workflow?.nodes ?? [];
  expect(nodes).toHaveLength(67);
  const node = (id: string) => nodes.find(candidate => candidate.id === id);
  const look = node('overseer-idle-look');
  expect(look?.depends_on).toContain('build-manifest');
  expect(look?.trigger_rule).toBe('all_done');
  expect(look?.when).toContain("$implement.output == 'IDLE_HANDOFF=true'");
  expect(look?.when).toContain("$test-repair.output == 'IDLE_HANDOFF=true'");
  expect(look?.when).not.toContain('$build-manifest.output');
  const manifest = node('build-manifest');
  expect(manifest && isEvidenceNode(manifest)).toBe(true);
  expect(manifest?.idle_timeout).toBeUndefined();
  expect(node('blocked-issue')?.depends_on).toContain('overseer-idle-look');
  expect(node('hold-if-findings')?.depends_on).toContain('blocked-issue');
});

describe('loader: the two opt-in keys', () => {
  const yaml = (extra: string): string =>
    [
      'name: keys-fixture',
      'description: loader fixture',
      extra,
      'nodes:',
      '  - id: step',
      '    bash: echo hi',
      '',
    ].join('\n');

  test('both keys load and reach the workflow object', () => {
    const r = parseWorkflow(
      yaml('unattended_questions: report\nidle_handoff: overseer'),
      'keys.yaml'
    );
    expect(r.error).toBeNull();
    expect(r.workflow?.unattended_questions).toBe('report');
    expect(r.workflow?.idle_handoff).toBe('overseer');
  });

  test('absent keys stay absent', () => {
    const r = parseWorkflow(yaml(''), 'keys.yaml');
    expect(r.error).toBeNull();
    expect(r.workflow && 'unattended_questions' in r.workflow).toBe(false);
    expect(r.workflow && 'idle_handoff' in r.workflow).toBe(false);
  });

  test('an unknown value fails the load instead of silently falling back', () => {
    const a = parseWorkflow(yaml('unattended_questions: ask'), 'keys.yaml');
    expect(a.workflow).toBeNull();
    expect(a.error?.error).toContain('unattended_questions');
    const b = parseWorkflow(yaml('idle_handoff: retry'), 'keys.yaml');
    expect(b.workflow).toBeNull();
    expect(b.error?.error).toContain('idle_handoff');
  });
});

// Rule 1b of the Correction E amendment (General, bdc-xo#6451 comment 7191042669):
// hold-if-findings readies a PR without run:blocked only when no node of the run
// recorded failed. The reserved token $_run.output.failed_nodes lists them.
describe('reserved token $_run.output.failed_nodes', () => {
  const outputs = (states: Record<string, NodeOutput['state']>): Map<string, NodeOutput> =>
    new Map(Object.entries(states).map(([id, state]) => [id, { state, output: '' } as NodeOutput]));

  test('lists failed node ids, sorted, comma-separated, in bash mode', () => {
    const m = outputs({
      implement: 'failed',
      'run-stop-greps': 'completed',
      'diff-review': 'failed',
      x: 'skipped',
    });
    expect(substituteNodeOutputRefs('F=$_run.output.failed_nodes', m, true)).toBe(
      "F='diff-review,implement'"
    );
  });

  test('is empty when no node failed', () => {
    const m = outputs({ implement: 'completed', x: 'skipped' });
    expect(substituteNodeOutputRefs('F=$_run.output.failed_nodes', m, true)).toBe("F=''");
    expect(substituteNodeOutputRefs('[$_run.output.failed_nodes]', m, false)).toBe('[]');
  });

  test('leaves ordinary node references unchanged', () => {
    const m = outputs({ implement: 'failed' });
    m.set('plan', { state: 'completed', output: 'ok' } as NodeOutput);
    expect(substituteNodeOutputRefs('$plan.output', m, false)).toBe('ok');
  });
});
