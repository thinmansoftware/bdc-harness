import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';

const isWindows = process.platform === 'win32';

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

// --- Bootstrap provider registry (after path mocks, before dag-executor import) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Imports (after mocks) ---
import {
  buildTopologicalLayers,
  checkTriggerRule,
  substituteNodeOutputRefs,
  executeDagWorkflow,
  clearAgentRegistryCache,
} from './dag-executor';
import { loadMcpConfig } from '@archon/providers/claude/provider';
import type { DagNode, BashNode, ScriptNode, NodeOutput, WorkflowRun } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { parseWorkflow } from './loader';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

// --- Mock helpers ---

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
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

/** All-true capabilities for Claude mock */
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
/** Limited capabilities for Codex mock */
const mockCodexCapabilities = () => ({
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

/** Mock AI sendQuery generator */
const mockSendQueryDag = mock(function* () {
  yield { type: 'assistant', content: 'DAG AI response' };
  yield { type: 'result', sessionId: 'dag-session-id' };
});

const mockGetAgentProviderDag = mock(() => ({
  sendQuery: mockSendQueryDag,
  getType: () => 'claude',
  getCapabilities: mockClaudeCapabilities,
}));

function createMockDeps(storeOverride?: IWorkflowStore): WorkflowDeps {
  const store = storeOverride ?? createMockStore();
  return {
    store,
    getAgentProvider: mockGetAgentProviderDag,
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

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

// --- Helpers ---

function node(id: string, depends_on?: string[], opts?: Partial<DagNode>): DagNode {
  return { id, command: id, ...(depends_on?.length ? { depends_on } : {}), ...opts };
}

function makeOutput(state: NodeOutput['state'], output = ''): NodeOutput {
  if (state === 'failed') return { state, output, error: 'error' };
  return { state, output } as NodeOutput;
}

function makeWorkflowRun(id = 'dag-test-run-id', overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    id,
    workflow_name: 'dag-test',
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
    ...overrides,
  };
}

// --- Tests ---

describe('buildTopologicalLayers', () => {
  it('single node with no dependencies -> one layer', () => {
    const layers = buildTopologicalLayers([node('a')]);
    expect(layers).toHaveLength(1);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
  });

  it('linear chain -> one node per layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id)).toEqual(['b']);
    expect(layers[2].map(n => n.id)).toEqual(['c']);
  });

  it('fan-out: classify -> [investigate, plan] in same layer', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    const layer1Ids = layers[1].map(n => n.id).sort();
    expect(layer1Ids).toEqual(['investigate', 'plan']);
  });

  it('fan-in: [a, b] -> implement in its own layer', () => {
    const layers = buildTopologicalLayers([node('a'), node('b'), node('implement', ['a', 'b'])]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'b']);
    expect(layers[1].map(n => n.id)).toEqual(['implement']);
  });

  it('diamond: classify -> [investigate, plan] -> implement', () => {
    const layers = buildTopologicalLayers([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
      node('implement', ['investigate', 'plan']),
    ]);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['investigate', 'plan']);
    expect(layers[2].map(n => n.id)).toEqual(['implement']);
  });

  it('throws on cyclic graph (runtime safety check)', () => {
    const cyclic = [node('a', ['b']), node('b', ['a'])];
    expect(() => buildTopologicalLayers(cyclic)).toThrow('Cycle detected');
  });

  it('self-referential node throws', () => {
    const selfRef = [node('a', ['a'])];
    expect(() => buildTopologicalLayers(selfRef)).toThrow('Cycle detected');
  });

  it('two independent chains share layers correctly', () => {
    const layers = buildTopologicalLayers([
      node('a'),
      node('b', ['a']),
      node('c'),
      node('d', ['c']),
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'c']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['b', 'd']);
  });
});

describe('checkTriggerRule', () => {
  it('all_success: runs when all deps completed', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when one dep failed', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: skips when one dep skipped (skipped != success)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('one_success: runs when at least one dep completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('one_success: skips when no deps completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('none_failed_min_one_success: runs with skipped branch and completed branch', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('skipped')],
      ['plan', makeOutput('completed')],
    ]);
    // skipped is not failed, plan succeeded -> run
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('none_failed_min_one_success: skips when one failed', () => {
    const n = node('implement', ['investigate', 'plan'], {
      trigger_rule: 'none_failed_min_one_success',
    });
    const outputs = new Map([
      ['investigate', makeOutput('failed')],
      ['plan', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when all deps are in a terminal state', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_done: skips when a dep is still running', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('running')],
      ['b', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('no deps: always runs', () => {
    const n = node('a');
    const outputs = new Map<string, NodeOutput>();
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });

  it('all_success: skips when upstream absent from outputs (synthesised as failed)', () => {
    const n = node('c', ['a', 'b']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    // 'b' is absent -> synthesised as failed -> all_success skips
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_done: runs when absent upstream is synthesised as failed (failed is terminal)', () => {
    const n = node('c', ['a'], { trigger_rule: 'all_done' });
    const outputs = new Map<string, NodeOutput>(); // 'a' absent -> synthesised as failed -> terminal
    expect(checkTriggerRule(n, outputs)).toBe('run');
  });
});

describe('DAG Loader -- cycle detection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects cyclic DAG at load time', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'cyclic.yaml'),
      `
name: cyclic-dag
description: A cyclic dag
nodes:
  - id: a
    command: plan
    depends_on: [b]
  - id: b
    command: implement
    depends_on: [a]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/cycle/i);
  });

  it('rejects unknown depends_on reference', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-ref.yaml'),
      `
name: bad-ref
description: Bad dep ref
nodes:
  - id: a
    command: plan
    depends_on: [nonexistent]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/nonexistent/);
  });

  it('rejects duplicate node IDs', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'dup-ids.yaml'),
      `
name: dup-ids
description: Duplicate node IDs
nodes:
  - id: a
    command: plan
  - id: a
    command: implement
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/duplicate/i);
  });

  it('rejects node with both command and prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'both.yaml'),
      `
name: both-cmd-prompt
description: Both command and prompt
nodes:
  - id: a
    command: plan
    prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/mutually exclusive/i);
  });

  it('rejects node with neither command nor prompt', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'neither.yaml'),
      `
name: no-cmd-or-prompt
description: No command or prompt
nodes:
  - id: a
    depends_on: []
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/must have either/i);
  });

  it('accepts valid DAG with fan-out, when: conditions, and trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'valid.yaml'),
      `
name: classify-and-fix
description: Classify then fix or plan
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]
  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"
  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toHaveLength(4);
    expect(wf.nodes[0].id).toBe('classify');
    expect(wf.nodes[0].output_format).toBeDefined();
    expect(wf.nodes[1].when).toBe("$classify.output.type == 'BUG'");
    expect(wf.nodes[3].trigger_rule).toBe('none_failed_min_one_success');
  });

  it('accepts inline prompt nodes', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'inline-prompt.yaml'),
      `
name: inline-prompts
description: DAG with inline prompts
nodes:
  - id: step-a
    prompt: "Output exactly: hello from A"
  - id: step-b
    prompt: "Output exactly: hello from B"
    depends_on: [step-a]
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);

    const wf = result.workflows[0].workflow;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].prompt).toBe('Output exactly: hello from A');
    expect(wf.nodes[1].depends_on).toEqual(['step-a']);
  });

  it('ignores unknown top-level fields when valid nodes: is present', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'nodes-extra.yaml'),
      `
name: extra-fields
description: Has extra top-level fields that are ignored
nodes:
  - id: a
    command: plan
loop:
  until: COMPLETE
  max_iterations: 5
prompt: "do something"
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].workflow.name).toBe('extra-fields');
  });

  it('rejects node with invalid trigger_rule', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'bad-rule.yaml'),
      `
name: bad-trigger-rule
description: Invalid trigger rule
nodes:
  - id: a
    command: plan
  - id: b
    command: implement
    depends_on: [a]
    trigger_rule: all-success
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/trigger_rule/i);
  });

  it('parses allowed_tools and denied_tools on DAG nodes', async () => {
    const wfDir = join(testDir, '.archon', 'workflows');
    await mkdir(wfDir, { recursive: true });

    await writeFile(
      join(wfDir, 'tool-restrictions.yaml'),
      `
name: tool-restriction-test
description: Test tool restrictions
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]
  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch]
  - id: mcp-only
    command: mcp-command
    allowed_tools: []
`
    );

    const result = await discoverWorkflows(testDir, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    const wf = result.workflows
      .map(ws => ws.workflow)
      .find(w => w.name === 'tool-restriction-test');
    expect(wf).toBeDefined();
    if (!wf) return;

    expect(wf.nodes[0].allowed_tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(wf.nodes[0].denied_tools).toBeUndefined();

    expect(wf.nodes[1].denied_tools).toEqual(['WebSearch', 'WebFetch']);
    expect(wf.nodes[1].allowed_tools).toBeUndefined();

    // Empty array must be preserved (distinct from absent)
    expect(wf.nodes[2].allowed_tools).toEqual([]);
  });
});

describe('substituteNodeOutputRefs', () => {
  it('replaces $nodeId.output with node output text', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello');
  });

  it('unknown node ref resolves to empty string and logs a warning', () => {
    mockLogFn.mockClear();
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('Result: $missing.output', outputs)).toBe('Result: ');
    const warnCalls = mockLogFn.mock.calls.filter(
      (call: unknown[]) => call[1] === 'dag_node_output_ref_unknown_node'
    );
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0][0]).toEqual(expect.objectContaining({ nodeId: 'missing' }));
  });

  it('dot notation extracts JSON field', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ type: 'BUG' }))]]);
    expect(substituteNodeOutputRefs('Fix $a.output.type issue', outputs)).toBe('Fix BUG issue');
  });

  it('dot notation on invalid JSON returns empty string', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(substituteNodeOutputRefs('$a.output.field', outputs)).toBe('');
  });
});

describe('substituteNodeOutputRefs -- shell escaping', () => {
  it('does not escape by default (AI prompt substitution)', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('Result: $a.output', outputs)).toBe('Result: hello; rm -rf /');
  });

  it('shell-quotes output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello world')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello world'");
  });

  it('escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello; rm -rf /')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe(
      "echo 'hello; rm -rf /'"
    );
  });

  it('escapes single quotes inside output when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', "it's alive")]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'it'\\''s alive'");
  });

  it('missing ref becomes empty string when escapedForBash=true', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(substituteNodeOutputRefs('echo $missing.output', outputs, true)).toBe("echo ''");
  });

  it('JSON field escapes shell metacharacters when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ cmd: 'foo; bar' }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.cmd', outputs, true)).toBe("echo 'foo; bar'");
  });

  it('numeric JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ count: 42 }))]]);
    expect(substituteNodeOutputRefs('exit $a.output.count', outputs, true)).toBe('exit 42');
  });

  it('boolean JSON field is not quoted (safe as-is)', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ ok: true }))]]);
    expect(substituteNodeOutputRefs('[ $a.output.ok ]', outputs, true)).toBe('[ true ]');
  });

  it('empty string output becomes quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', '')]]);
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo ''");
  });

  it('embedded newline in output is safe when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'hello\nworld')]]);
    // Single-quoted bash strings can contain literal newlines safely
    expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello\nworld'");
  });

  it('object JSON field becomes JSON stringified when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ nested: { x: 1 } }))]]);
    expect(substituteNodeOutputRefs('echo $a.output.nested', outputs, true)).toBe(
      'echo \'{"x":1}\''
    );
  });

  // WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01 (bdc-xo#153): when a node output
  // reference is wrapped in double quotes inside a bash block, the outer double
  // quotes are swallowed during substitution because shellQuote already produces
  // safe single-quote wrapping. Without this, multi-line output mis-tokenized
  // bash (line 2+ of output became bare commands).
  describe('double-quote context handling (escapedForBash=true)', () => {
    it('swallows outer double quotes for exact "$node.output" pattern with multi-line output', () => {
      const outputs = new Map([['a', makeOutput('completed', 'line1\nline2\nline3')]]);
      // Author wrote: echo "$a.output"
      // Without the fix: produces echo "'line1\nline2\nline3'" -- bash mis-tokenizes line2/line3.
      // With the fix:  produces echo 'line1\nline2\nline3' (single-quoted, bash-safe).
      expect(substituteNodeOutputRefs('echo "$a.output"', outputs, true)).toBe(
        "echo 'line1\nline2\nline3'"
      );
    });

    it('swallows outer double quotes for single-line output', () => {
      const outputs = new Map([['a', makeOutput('completed', 'just one line')]]);
      expect(substituteNodeOutputRefs('echo "$a.output"', outputs, true)).toBe(
        "echo 'just one line'"
      );
    });

    it('handles output containing both single quotes AND double quotes', () => {
      const outputs = new Map([['a', makeOutput('completed', 'it\'s a "trap"')]]);
      // shellQuote escapes ' as '\''; " stays literal inside single quotes
      expect(substituteNodeOutputRefs('echo "$a.output"', outputs, true)).toBe(
        "echo 'it'\\''s a \"trap\"'"
      );
    });

    it('handles hyphenated node ids in double-quote context', () => {
      const outputs = new Map([
        ['decide-push-target', makeOutput('completed', 'push_target: feature-branch:foo')],
      ]);
      expect(
        substituteNodeOutputRefs('printf "%s\\n" "$decide-push-target.output"', outputs, true)
      ).toBe('printf "%s\\n" \'push_target: feature-branch:foo\'');
    });

    it('handles JSON field access inside double quotes', () => {
      const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ cmd: 'foo bar' }))]]);
      // "$a.output.cmd" -> 'foo bar' (outer double quotes swallowed)
      expect(substituteNodeOutputRefs('run "$a.output.cmd"', outputs, true)).toBe("run 'foo bar'");
    });

    it('leaves bare $node.output (no surrounding quotes) producing shellQuote-wrapped value', () => {
      const outputs = new Map([['a', makeOutput('completed', 'hello world')]]);
      // No surrounding double quotes -- current behavior preserved.
      expect(substituteNodeOutputRefs('echo $a.output', outputs, true)).toBe("echo 'hello world'");
    });

    it('asymmetric quotes (leading only) are NOT swallowed', () => {
      const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
      // `"$a.output and rest` (leading " but no trailing "): only one quote captured;
      // we put it back, falling through to standard shellQuote behavior. Author's
      // outer string remains intact.
      expect(substituteNodeOutputRefs('echo "$a.output and rest"', outputs, true)).toBe(
        'echo "\'hello\' and rest"'
      );
    });

    it('asymmetric quotes (trailing only) are NOT swallowed', () => {
      const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
      // `$a.output"`: trailing " captured but leading " was a different char (here, none).
      expect(substituteNodeOutputRefs('echo $a.output" extra', outputs, true)).toBe(
        "echo 'hello'\" extra"
      );
    });

    it('two adjacent quoted refs each swallow their own quotes', () => {
      const outputs = new Map([
        ['a', makeOutput('completed', 'A1')],
        ['b', makeOutput('completed', 'B2')],
      ]);
      expect(substituteNodeOutputRefs('"$a.output" then "$b.output"', outputs, true)).toBe(
        "'A1' then 'B2'"
      );
    });

    it('non-shell mode (escapedForBash=false) keeps current behavior even with surrounding quotes', () => {
      const outputs = new Map([['a', makeOutput('completed', 'hello')]]);
      // No escaping at all, no quote swallowing.
      expect(substituteNodeOutputRefs('echo "$a.output"', outputs)).toBe('echo "hello"');
    });

    it('unknown node in double-quote context swallows the outer quotes too', () => {
      mockLogFn.mockClear();
      const outputs = new Map<string, NodeOutput>();
      // "$missing.output" -> '' (outer " swallowed; empty single-quoted string)
      expect(substituteNodeOutputRefs('echo "$missing.output"', outputs, true)).toBe("echo ''");
    });
  });

  it('array JSON field becomes JSON stringified', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('["todo","fix"]');
  });

  it('array JSON field is shell-quoted when escapedForBash=true', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: ['todo', 'fix'] }))],
    ]);
    expect(substituteNodeOutputRefs('echo $a.output.items', outputs, true)).toBe(
      'echo \'["todo","fix"]\''
    );
  });

  it('nested object in array field becomes JSON stringified', () => {
    const outputs = new Map([
      [
        'a',
        makeOutput('completed', JSON.stringify({ files: [{ name: 'a.ts', status: 'modified' }] })),
      ],
    ]);
    expect(substituteNodeOutputRefs('$a.output.files', outputs)).toBe(
      '[{"name":"a.ts","status":"modified"}]'
    );
  });

  it('null values in arrays stringify to "null"', () => {
    const outputs = new Map([
      ['a', makeOutput('completed', JSON.stringify({ items: [null, 'ok'] }))],
    ]);
    expect(substituteNodeOutputRefs('$a.output.items', outputs)).toBe('[null,"ok"]');
  });

  it('null object field becomes JSON stringified "null"', () => {
    const outputs = new Map([['a', makeOutput('completed', JSON.stringify({ config: null }))]]);
    expect(substituteNodeOutputRefs('$a.output.config', outputs)).toBe('null');
  });

  it('dot notation on invalid JSON returns quoted empty string when escapedForBash=true', () => {
    const outputs = new Map([['a', makeOutput('completed', 'not-json')]]);
    expect(substituteNodeOutputRefs('$a.output.field', outputs, true)).toBe("''");
  });
});

describe('checkTriggerRule -- missing upstream treated as failed', () => {
  it('none_failed_min_one_success: skips when all deps skipped (no success)', () => {
    const n = node('implement', ['a', 'b'], { trigger_rule: 'none_failed_min_one_success' });
    const outputs = new Map([
      ['a', makeOutput('skipped')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });

  it('all_success: node with skipped dep is skipped, so anyCompleted stays false', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('skipped')]]);
    expect(checkTriggerRule(n, outputs)).toBe('skip');
  });
});

describe('executeDagWorkflow -- tool restrictions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    // Restore default claude client
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes allowed_tools to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-tool-restriction',
        nodes: [{ id: 'review', command: 'my-cmd', allowed_tools: ['Read', 'Grep'] }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('warns user when Codex DAG node has denied_tools only', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-denied',
        nodes: [
          { id: 'review', command: 'my-cmd', provider: 'codex', denied_tools: ['WebSearch'] },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(
      m => m.includes('allowed_tools/denied_tools') && m.includes('codex')
    );
    expect(warning).toBeDefined();
  });

  it('passes empty allowed_tools: [] (disable all tools) to sendQuery', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-empty-tools', nodes: [{ id: 'review', command: 'my-cmd', allowed_tools: [] }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.allowed_tools).toEqual([]);
  });

  it('passes hooks to sendQuery options for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-hooks',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            hooks: {
              PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.hooks).toBeDefined();
    const hooks = nodeConfig?.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it('warns user when Codex DAG node has hooks', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-hooks',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            provider: 'codex',
            hooks: {
              PreToolUse: [{ response: { decision: 'block' } }],
            },
          },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('hooks') && m.includes('codex'));
    expect(warning).toBeDefined();
  });
});

describe('executeDagWorkflow -- bash nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('bash node executes and captures stdout as output', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'stats',
      bash: 'echo "hello world"',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-exec-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Bash node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node stdout is available for downstream $nodeId.output substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Process: $stats.output');

    const nodes: DagNode[] = [
      { id: 'stats', bash: 'echo "42 files"' },
      { id: 'process', command: 'my-cmd', depends_on: ['stats'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-subst-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client should have been called for the downstream node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The prompt should contain the substituted bash output
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42 files');
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'fail',
      bash: 'exit 1',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-fail-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The workflow should complete (it handles failures) but the node failed
    // The mock platform should have received a failure message about no successful nodes
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
    expect(failMsg).toBeDefined();
  });

  it('failure message surfaces stderr and does not leak the "Command failed: bash -c <body>" prefix', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-1389-run-id', {
      workflow_name: 'bash-1389',
      conversation_id: 'conv-1389b',
      user_message: 'test',
    });

    // Marker is echoed to stdout only (so it lands in the command line embedded
    // in err.message but never in stderr). If it shows up in errorMsg the
    // prefix line was not stripped.
    const bashNode: BashNode = {
      id: 'fail-bash-1389',
      bash: 'echo UNIQUE_CMDLINE_MARKER_1389; echo "diagnostic from stderr" >&2; exit 1',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-1389b',
      testDir,
      { name: 'bash-1389', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'fail-bash-1389'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain("Bash node 'fail-bash-1389' failed");
    expect(errorMsg).toContain('[exit 1]');
    expect(errorMsg).not.toContain('Command failed:');
    expect(errorMsg).not.toContain('UNIQUE_CMDLINE_MARKER_1389');
    expect(errorMsg).toContain('diagnostic from stderr');
  });

  it('variable substitution works in bash scripts', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: BashNode = {
      id: 'vars',
      bash: 'echo "$ARGUMENTS"',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-vars-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Should complete without error (no AI calls)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node in parallel layer executes correctly', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something');

    const nodes: DagNode[] = [
      { id: 'bash-a', bash: 'echo "from bash"' },
      { id: 'ai-b', command: 'my-cmd' },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash',
      testDir,
      { name: 'bash-parallel-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client called only for the AI node, not the bash node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('passes config.envVars to bash subprocesses', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-env-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash-env',
      testDir,
      { name: 'bash-env-test', nodes: [{ id: 'stats', bash: 'echo ok' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(execSpy).toHaveBeenCalledWith(
      'bash',
      ['-c', 'echo ok'],
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
      })
    );
    execSpy.mockRestore();
  });

  it('bash node output with shell metacharacters does not inject into downstream bash script', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-injection-run-id', {
      workflow_name: 'bash-injection-test',
      conversation_id: 'conv-injection',
      user_message: 'test',
    });

    // upstream: outputs a value containing shell metacharacters
    // downstream: embeds $upstream.output literally in a bash script
    // If injection were present, the semicolon would split into two commands and INJECTED would print
    const nodes: DagNode[] = [
      { id: 'upstream', bash: 'printf "%s" "safe; echo INJECTED"' },
      {
        id: 'downstream',
        bash: 'result=$upstream.output; echo "got: $result"',
        depends_on: ['upstream'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-injection',
      testDir,
      { name: 'bash-injection-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // No AI calls
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // The downstream node ran without injection: stdout should contain the literal value, not a separate INJECTED line
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    // 'INJECTED' as a standalone result of injection must not appear
    const injectedMessage = messages.find((m: string) => m === 'INJECTED');
    expect(injectedMessage).toBeUndefined();
  });

  it('${input.X} tokens are substituted in bash script before exec', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'bar\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-input-subst-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-input-subst',
      testDir,
      {
        name: 'bash-input-subst-test',
        nodes: [{ id: 'greet', bash: 'echo ${input.foo}' }],
        inputs: { foo: { default: 'bar' } },
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The bash script passed to execFileAsync must have the token replaced with the value
    expect(execSpy).toHaveBeenCalledWith('bash', ['-c', 'echo bar'], expect.anything());
    execSpy.mockRestore();
  });

  it('WORKTREE_PATH and INPUT_* env vars are injected into bash subprocess', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-input-env-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-input-env',
      testDir,
      {
        name: 'bash-input-env-test',
        nodes: [{ id: 'step', bash: 'echo ok' }],
        inputs: { branch: { default: 'feat/test-branch' } },
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(execSpy).toHaveBeenCalledWith(
      'bash',
      ['-c', 'echo ok'],
      expect.objectContaining({
        env: expect.objectContaining({
          WORKTREE_PATH: testDir,
          INPUT_BRANCH: 'feat/test-branch',
        }),
      })
    );
    execSpy.mockRestore();
  });

  it('undefined ${input.X} token is left unchanged in bash script', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-input-undef-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-input-undef',
      testDir,
      {
        name: 'bash-input-undef-test',
        nodes: [{ id: 'step', bash: 'echo ${input.undefined_key}' }],
        inputs: { other: { default: 'irrelevant' } },
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Token for 'undefined_key' must remain verbatim (not replaced with empty string or crashed)
    expect(execSpy).toHaveBeenCalledWith(
      'bash',
      ['-c', 'echo ${input.undefined_key}'],
      expect.anything()
    );
    execSpy.mockRestore();
  });
});

describe('executeDagWorkflow -- output_format structured output', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-output-fmt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'classify.md'), 'Classify this: $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('uses structuredOutput from result when output_format is set', async () => {
    const structuredJson = { run_code_review: 'true', run_tests: 'false' };

    // Mock yields prose + JSON as assistant text, then result with structuredOutput
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Let me analyze the PR scope...\n' };
      yield { type: 'assistant', content: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-1', structuredOutput: structuredJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        command: 'classify',
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      {
        id: 'review',
        prompt: 'Review the code',
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        prompt: 'Run tests',
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-output-fmt',
      testDir,
      { name: 'output-fmt-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The review node's when condition should evaluate to true (run_code_review == 'true')
    // The test node's when condition should evaluate to false (run_tests == 'false', not 'true')
    // So sendQuery should be called for classify + review = 2 times (not 3)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  it('does NOT override nodeOutputText with structuredOutput when output_format is absent', async () => {
    // Even if the SDK returns structuredOutput, nodes without output_format use concatenated text
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'prose analysis text' };
      yield { type: 'result', sessionId: 'sid-no-fmt', structuredOutput: { type: 'BUG' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-output-fmt-run', {
      user_message: 'test guard',
    });

    const nodes: DagNode[] = [
      { id: 'a', command: 'classify' },
      {
        id: 'b',
        prompt: 'Got: $a.output',
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-no-fmt',
      testDir,
      { name: 'no-fmt-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated prose, not the JSON
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('prose analysis text');
    expect(secondCallPrompt).not.toContain('"type"');
  });

  it('falls back to concatenated text when structuredOutput is absent', async () => {
    // Mock without structuredOutput on result -- backward compatible
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'plain text response' };
      yield { type: 'result', sessionId: 'sid-2' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('no-structured-run', {
      user_message: 'test fallback',
    });

    const nodes: DagNode[] = [
      { id: 'a', command: 'classify' },
      {
        id: 'b',
        prompt: 'Use output: $a.output',
        depends_on: ['a'],
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-fallback',
      testDir,
      { name: 'fallback-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Both nodes should execute (no output_format, no when conditions)
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Second node's prompt should contain the concatenated text from node a
    const secondCallPrompt = mockSendQueryDag.mock.calls[1][0] as string;
    expect(secondCallPrompt).toContain('plain text response');
  });

  it('passes outputFormat to Codex nodes and uses inline JSON response', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    const classifyJson = { run_code_review: 'true', run_tests: 'false' };
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: JSON.stringify(classifyJson) };
      yield { type: 'result', sessionId: 'codex-sid-1', structuredOutput: classifyJson };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-output-fmt-run', {
      user_message: 'classify this PR',
    });

    const nodes: DagNode[] = [
      {
        id: 'classify',
        command: 'classify',
        output_format: {
          type: 'object',
          properties: {
            run_code_review: { type: 'string', enum: ['true', 'false'] },
            run_tests: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      {
        id: 'review',
        prompt: 'Review the code',
        depends_on: ['classify'],
        when: "$classify.output.run_code_review == 'true'",
      },
      {
        id: 'test',
        prompt: 'Run tests',
        depends_on: ['classify'],
        when: "$classify.output.run_tests == 'true'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-codex-fmt',
      testDir,
      { name: 'codex-output-fmt', nodes },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // classify + review = 2 calls (test node skipped because run_tests == 'false')
    expect(mockSendQueryDag.mock.calls.length).toBe(2);

    // Verify outputFormat was passed to the Codex client (4th arg = options)
    const classifyOptions = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(classifyOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema: nodes[0].output_format,
    });
  });

  it('does not warn about missing structuredOutput for Codex nodes', async () => {
    // Codex provider normalizes inline JSON into structuredOutput on the result chunk
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: '{"status":"ok"}' };
      yield { type: 'result', sessionId: 'codex-sid-2', structuredOutput: { status: 'ok' } };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('codex-no-warn-run', {
      user_message: 'check it',
    });

    const nodes: DagNode[] = [
      {
        id: 'check',
        command: 'classify',
        output_format: { type: 'object', properties: { status: { type: 'string' } } },
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-codex-no-warn',
      testDir,
      { name: 'codex-no-warn', nodes },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Verify no "structured output missing" warning was sent to the user
    const sendCalls = (platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>).mock
      .calls;
    const warningMessages = sendCalls
      .map(call => call[1] as string)
      .filter(msg => typeof msg === 'string' && msg.includes('did not return structured output'));
    expect(warningMessages).toHaveLength(0);
  });
});

describe('executeDagWorkflow -- when condition parse errors (fail-closed)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-parse-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'sess-parse-err' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('skips node (does not run it) when when: expression is unparseable', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-skip-run');

    const nodes: DagNode[] = [
      { id: 'unconditional', command: 'my-cmd' },
      // Single = is not valid syntax -- will fail to parse
      {
        id: 'guarded',
        command: 'my-cmd',
        depends_on: ['unconditional'],
        when: "$unconditional.output = 'yes'",
      },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-parse-err-skip',
      testDir,
      { name: 'parse-err-skip-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only the unconditional node should have triggered an AI call.
    // The guarded node must be skipped (fail-closed), not executed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('sends a platform warning message naming the node and stating it was skipped', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-warn-run');

    const nodes: DagNode[] = [{ id: 'gate', command: 'my-cmd', when: 'not a valid condition' }];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-parse-err-warn',
      testDir,
      { name: 'parse-warn-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('gate') && m.includes('skipped'));
    expect(warning).toBeDefined();
    // Must NOT indicate the node ran (the old fail-open behavior)
    expect(warning).not.toMatch(/node ran/i);
  });

  it('workflow completes without throwing when all nodes are skipped via parse error', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('parse-err-all-skip-run');

    const nodes: DagNode[] = [{ id: 'only', command: 'my-cmd', when: 'bad expression' }];

    await expect(
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-all-skipped',
        testDir,
        { name: 'all-skipped-test', nodes },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      )
    ).resolves.toBeUndefined();
  });
});

describe('executeDagWorkflow -- node-level retry for transient errors', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-retry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('node succeeds on retry after a transient error', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Claude Code crash: process exited with code 1');
      }
      yield { type: 'assistant', content: 'Recovered' };
      yield { type: 'result', sessionId: 'retry-sess' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-succeed-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-succeed',
      testDir,
      { name: 'dag-retry-succeed', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Node was called at least twice (first fails transiently, second succeeds)
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).not.toHaveBeenCalled();
  }, 5_000);

  it('workflow fails after exhausting all node retries', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      throw new Error('Claude Code crash: process exited with code 1');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-exhaust-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-exhaust',
      testDir,
      { name: 'dag-retry-exhaust', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // max_attempts: 2 = 2 retries -> 3 total attempts (delay_ms: 1 keeps test fast)
    expect(callCount).toBe(3);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  }, 5_000);

  it('node with FATAL error does not retry (call count = 1)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      throw new Error('Claude Code auth error: unauthorized');
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-fatal-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-fatal',
      testDir,
      { name: 'dag-retry-fatal', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // FATAL error must not be retried -- exactly 1 attempt
    expect(callCount).toBe(1);
    expect(mockDeps.store.failWorkflowRun as ReturnType<typeof mock>).toHaveBeenCalled();
  });

  it('sends retry notification to platform before each delay', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        throw new Error('Claude Code crash: process exited with code 1');
      }
      yield { type: 'assistant', content: 'OK' };
      yield { type: 'result', sessionId: 'ok-sess' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-retry-notify-run');

    const nodes: DagNode[] = [
      { id: 'my-node', command: 'my-cmd', retry: { max_attempts: 2, delay_ms: 1 } },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-retry-notify',
      testDir,
      { name: 'dag-retry-notify', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendCalls = (platform.sendMessage as ReturnType<typeof mock>).mock.calls;
    const retryMessages = sendCalls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).includes('transient error')
    );
    expect(retryMessages.length).toBeGreaterThan(0);
  }, 5_000);
});

describe('executeDagWorkflow -- tool_called event persistence', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should persist tool_called event during DAG node execution', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Reading file...' };
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/tmp/test.ts' } };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'tool-test-dag',
        nodes: [node('my-cmd')],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const toolCalledEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'tool_called'
    );
    expect(toolCalledEvents.length).toBe(1);
    const eventData = toolCalledEvents[0][0] as Record<string, unknown>;
    expect(eventData.step_name).toBe('my-cmd');
    expect((eventData.data as Record<string, unknown>).tool_name).toBe('read_file');
    expect((eventData.data as Record<string, unknown>).tool_input).toEqual({
      path: '/tmp/test.ts',
    });
  });

  it('calls sendStructuredEvent for tool messages in streaming mode during DAG', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    (platform.getStreamingMode as Mock).mockReturnValue('stream');
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'Write', toolInput: { path: '/bar', content: 'x' } };
      yield { type: 'result', sessionId: 'dag-session-tool' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-tool',
      testDir,
      { name: 'dag-tool-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-dag-tool', {
      type: 'tool',
      toolName: 'Write',
      toolInput: { path: '/bar', content: 'x' },
    });
  });
});

describe('executeDagWorkflow -- tool_completed event emission', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-toolcomplete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should emit tool_completed with duration_ms when next tool starts in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/a' } };
      yield { type: 'tool', toolName: 'write_file', toolInput: { path: '/b', content: 'x' } };
      yield { type: 'result', sessionId: 'dag-sess-1' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-complete',
      testDir,
      { name: 'dag-complete-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    const readFileComplete = completedEvents.find(([arg]) => arg.data?.tool_name === 'read_file');
    expect(readFileComplete).toBeDefined();
    expect(typeof readFileComplete?.[0].data?.duration_ms).toBe('number');
    expect((readFileComplete?.[0].data?.duration_ms as number) >= 0).toBe(true);
  });

  it('should emit tool_completed for last tool on result in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'tool', toolName: 'read_file', toolInput: { path: '/a' } };
      yield { type: 'result', sessionId: 'dag-sess-2' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-last',
      testDir,
      { name: 'dag-last-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0][0].data?.tool_name).toBe('read_file');
    expect(typeof completedEvents[0][0].data?.duration_ms).toBe('number');
  });

  it('should not emit tool_completed when no tools were called in DAG node', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-sess-3' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag-notools',
      testDir,
      { name: 'dag-notools-test', nodes: [node('my-cmd')] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const createEventCalls = (mockStore.createWorkflowEvent as ReturnType<typeof mock>).mock
      .calls as Array<[{ event_type: string; data?: Record<string, unknown> }]>;
    const completedEvents = createEventCalls.filter(([arg]) => arg.event_type === 'tool_completed');

    expect(completedEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadMcpConfig -- per-node MCP server config loading (#445)
// ---------------------------------------------------------------------------

describe('loadMcpConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads and parses a valid MCP config JSON', async () => {
    const config = { github: { command: 'npx', args: ['-y', '@mcp/server-github'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    expect(result.serverNames).toEqual(['github']);
    expect(result.servers).toEqual(config);
    expect(result.missingVars).toEqual([]);
  });

  it('loads multiple servers from one config', async () => {
    const config = {
      github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
      postgres: { command: 'npx', args: ['-y', '@mcp/server-postgres'] },
    };
    await writeFile(join(testDir, 'multi.json'), JSON.stringify(config));

    const result = await loadMcpConfig('multi.json', testDir);
    expect(result.serverNames).toEqual(['github', 'postgres']);
  });

  it('expands $VAR_NAME in env values from process.env', async () => {
    process.env.TEST_MCP_TOKEN_445 = 'secret123';
    const config = { github: { command: 'npx', env: { TOKEN: '$TEST_MCP_TOKEN_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.github as Record<string, unknown>;
    expect(server.env).toEqual({ TOKEN: 'secret123' });

    delete process.env.TEST_MCP_TOKEN_445;
  });

  it('expands $VAR_NAME in headers values', async () => {
    process.env.TEST_API_KEY_445 = 'key456';
    const config = {
      api: {
        type: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer $TEST_API_KEY_445' },
      },
    };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.api as Record<string, unknown>;
    expect(server.headers).toEqual({ Authorization: 'Bearer key456' });

    delete process.env.TEST_API_KEY_445;
  });

  it('replaces undefined env vars with empty string and reports them', async () => {
    delete process.env.NONEXISTENT_VAR_445;
    const config = { svc: { command: 'npx', env: { KEY: '$NONEXISTENT_VAR_445' } } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.env).toEqual({ KEY: '' });
    expect(result.missingVars).toContain('NONEXISTENT_VAR_445');
  });

  it('does not expand vars in command or args fields', async () => {
    process.env.TEST_CMD_445 = 'should-not-expand';
    const config = { svc: { command: '$TEST_CMD_445', args: ['$TEST_CMD_445'] } };
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify(config));

    const result = await loadMcpConfig('mcp.json', testDir);
    const server = result.servers.svc as Record<string, unknown>;
    expect(server.command).toBe('$TEST_CMD_445');
    expect(server.args).toEqual(['$TEST_CMD_445']);

    delete process.env.TEST_CMD_445;
  });

  it('resolves absolute paths as-is', async () => {
    const config = { svc: { command: 'npx' } };
    const absPath = join(testDir, 'abs.json');
    await writeFile(absPath, JSON.stringify(config));

    const result = await loadMcpConfig(absPath, '/some/other/dir');
    expect(result.serverNames).toEqual(['svc']);
  });

  it('throws on missing file', async () => {
    await expect(loadMcpConfig('nonexistent.json', testDir)).rejects.toThrow(
      'MCP config file not found'
    );
  });

  it('throws on invalid JSON', async () => {
    await writeFile(join(testDir, 'bad.json'), 'not json');
    await expect(loadMcpConfig('bad.json', testDir)).rejects.toThrow('not valid JSON');
  });

  it('throws on non-object JSON (array)', async () => {
    await writeFile(join(testDir, 'arr.json'), '[]');
    await expect(loadMcpConfig('arr.json', testDir)).rejects.toThrow('must be a JSON object');
  });

  it('throws on non-object JSON (string)', async () => {
    await writeFile(join(testDir, 'str.json'), '"hello"');
    await expect(loadMcpConfig('str.json', testDir)).rejects.toThrow('must be a JSON object');
  });
});

// ---------------------------------------------------------------------------
// Skills -- executor-level behavior (#446)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- skills options', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes agents/agent/allowedTools to sendQuery when node has skills', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-skills',
        nodes: [{ id: 'review', command: 'my-cmd', skills: ['codebase-search', 'test-runner'] }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    // skills are passed in nodeConfig -- provider translates to agents internally
    expect(nodeConfig?.skills).toEqual(['codebase-search', 'test-runner']);
  });

  it('appends Skill to existing allowed_tools list when node has both', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-skills-tools',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            skills: ['codebase-search'],
            allowed_tools: ['Read', 'Grep'],
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    // skills and allowed_tools are both in nodeConfig -- provider merges internally
    expect(nodeConfig?.skills).toEqual(['codebase-search']);
    expect(nodeConfig?.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('warns user when Codex DAG node has skills and does not pass agents', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-skills',
        nodes: [
          { id: 'review', command: 'my-cmd', provider: 'codex', skills: ['codebase-search'] },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    // Warning sent to user
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('skills') && m.includes('codex'));
    expect(warning).toBeDefined();
  });

  it('passes agents to sendQuery nodeConfig when node has inline agents', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const agentsMap = {
      'brief-gen': {
        description: 'Summarises an issue',
        prompt: 'You are concise.',
        model: 'haiku',
        tools: ['Bash', 'Read'],
      },
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-agents',
        nodes: [{ id: 'review', command: 'my-cmd', agents: agentsMap }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.agents).toEqual(agentsMap);
  });

  it('warns user when Codex DAG node has inline agents', async () => {
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-codex-agents',
        nodes: [
          {
            id: 'review',
            command: 'my-cmd',
            provider: 'codex',
            agents: {
              'brief-gen': { description: 'd', prompt: 'p' },
            },
          },
        ],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('agents') && m.includes('codex'));
    expect(warning).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skills -- loader validation via discoverWorkflows (#446)
// ---------------------------------------------------------------------------

describe('skills field validation via parseWorkflow', () => {
  it('parses valid skills array on a DAG node', () => {
    const yaml = `
name: test-skills
description: test
nodes:
  - id: review
    prompt: "Review the code"
    skills:
      - codebase-search
      - test-runner
`;
    const result = parseWorkflow(yaml, 'test.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].skills).toEqual(['codebase-search', 'test-runner']);
  });

  it('rejects non-string skills array entries', () => {
    const yaml = `
name: bad-skills
description: test
nodes:
  - id: review
    prompt: "Review"
    skills:
      - 123
`;
    const result = parseWorkflow(yaml, 'bad.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('skills');
  });

  it('rejects empty skills array', () => {
    const yaml = `
name: empty-skills
description: test
nodes:
  - id: review
    prompt: "Review"
    skills: []
`;
    const result = parseWorkflow(yaml, 'empty.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('skills');
  });

  it('ignores skills on bash nodes with warning', () => {
    const yaml = `
name: bash-skills
description: test
nodes:
  - id: lint
    bash: "echo lint"
    skills:
      - should-be-ignored
`;
    const result = parseWorkflow(yaml, 'bash-skills.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    // Bash nodes don't get the skills field
    expect(wf.nodes[0].skills).toBeUndefined();
  });

  it('node with no skills has undefined skills field', () => {
    const yaml = `
name: no-skills
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-skills.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes).toBeDefined();
    expect(wf.nodes[0].skills).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inline agents -- field validation via parseWorkflow
// ---------------------------------------------------------------------------

describe('agents field validation via parseWorkflow', () => {
  it('parses a valid agents map on a DAG node', () => {
    const yaml = `
name: test-agents
description: test
nodes:
  - id: triage
    prompt: "Spawn a brief-gen sub-agent"
    agents:
      brief-gen:
        description: Summarises an issue
        prompt: "You are concise. Return JSON { summary }."
        model: haiku
        tools: [Bash, Read]
`;
    const result = parseWorkflow(yaml, 'agents.yaml');
    expect(result.error).toBeNull();
    expect(result.workflow).not.toBeNull();
    const wf = result.workflow!;
    const node = wf.nodes[0];
    expect(node.agents).toBeDefined();
    expect(node.agents!['brief-gen'].description).toBe('Summarises an issue');
    expect(node.agents!['brief-gen'].model).toBe('haiku');
    expect(node.agents!['brief-gen'].tools).toEqual(['Bash', 'Read']);
  });

  it('rejects an agent missing description', () => {
    const yaml = `
name: missing-desc
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      brief-gen:
        prompt: "You are concise."
`;
    const result = parseWorkflow(yaml, 'missing-desc.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects an agent missing prompt', () => {
    const yaml = `
name: missing-prompt
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      brief-gen:
        description: "A brief generator"
`;
    const result = parseWorkflow(yaml, 'missing-prompt.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects empty agents map', () => {
    const yaml = `
name: empty-agents
description: test
nodes:
  - id: triage
    prompt: "p"
    agents: {}
`;
    const result = parseWorkflow(yaml, 'empty-agents.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('agents');
  });

  it('rejects agent ID that is not kebab-case', () => {
    const yaml = `
name: bad-id
description: test
nodes:
  - id: triage
    prompt: "p"
    agents:
      BriefGen:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'bad-id.yaml');
    expect(result.error).not.toBeNull();
    expect(result.error!.error).toContain('kebab-case');
  });

  it('ignores agents on bash nodes (field stripped, no error)', () => {
    const yaml = `
name: bash-agents
description: test
nodes:
  - id: lint
    bash: "echo lint"
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'bash-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('ignores agents on script nodes (field stripped, no error)', () => {
    const yaml = `
name: script-agents
description: test
nodes:
  - id: run
    script: 'console.log("hi")'
    runtime: bun
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'script-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('ignores agents on loop nodes (field stripped, no error)', () => {
    const yaml = `
name: loop-agents
description: test
nodes:
  - id: iterate
    loop:
      prompt: "Do the work"
      until: "DONE"
      max_iterations: 2
    agents:
      helper:
        description: "d"
        prompt: "p"
`;
    const result = parseWorkflow(yaml, 'loop-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });

  it('node with no agents field is undefined', () => {
    const yaml = `
name: no-agents
description: test
nodes:
  - id: basic
    prompt: "Do something"
`;
    const result = parseWorkflow(yaml, 'no-agents.yaml');
    expect(result.error).toBeNull();
    const wf = result.workflow!;
    expect(wf.nodes[0].agents).toBeUndefined();
  });
});

describe('executeDagWorkflow -- resume with priorCompletedNodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'step1.md'), 'Step 1 prompt');
    await writeFile(join(commandsDir, 'step2.md'), 'Step 2 prompt using $step1.output');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'AI response' };
      yield { type: 'result', sessionId: 'session-id' };
    });
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('skips nodes that appear in priorCompletedNodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map([['step1', 'prior step1 output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
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

    // Only step2 should have been executed (step1 was skipped)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('pre-populates nodeOutputs so downstream nodes can use $nodeId.output', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    let capturedPrompt = '';
    mockSendQueryDag.mockImplementation(function* (prompt: string) {
      capturedPrompt = prompt;
      yield { type: 'assistant', content: 'step2 result' };
      yield { type: 'result', sessionId: 'session-id' };
    });

    const priorCompletedNodes = new Map([['step1', 'hello from prior run']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', prompt: 'Use this: $step1.output', depends_on: ['step1'] },
        ],
      },
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

    // The prompt sent to AI should contain the prior run's output
    expect(capturedPrompt).toContain('hello from prior run');
  });

  it('emits node_skipped_prior_success event for resumed nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('resume-run-id');

    const priorCompletedNodes = new Map([['step1', 'prior output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
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

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const skippedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_skipped_prior_success' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(skippedEvent).toBeDefined();
  });

  it('runs all nodes when priorCompletedNodes is empty', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-resume',
      testDir,
      {
        name: 'two-step',
        nodes: [
          { id: 'step1', command: 'step1' },
          { id: 'step2', command: 'step2', depends_on: ['step1'] },
        ],
      },
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
      new Map()
    );

    // Both nodes should execute
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
  });

  it('stores node_output in node_completed event data for bash nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-output-persist-run');

    const bashNode: BashNode = { id: 'stats', bash: 'echo "bash output"' };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-bash-output',
      testDir,
      { name: 'bash-output-test', nodes: [bashNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'stats'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toContain(
      'bash output'
    );
  });

  it('stores node_output in node_completed event data for AI nodes', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('output-persist-run');

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'the node output text' };
      yield { type: 'result', sessionId: 'sid' };
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-output',
      testDir,
      { name: 'single-node', nodes: [{ id: 'step1', command: 'step1' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'step1'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'the node output text'
    );
  });

  // --- Loop Node Tests -----------------------------------------------------

  describe('loop node execution', () => {
    it('completes on <promise>COMPLETE</promise> signal in first iteration', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Did the task. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-test',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly once (completed on iteration 1)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Workflow should be marked completed with node counts metadata
      const completeCalls = (
        mockDeps.store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][1]).toEqual({
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      });
    });

    it('passes loop node systemPrompt to the agent provider', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Did the task. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-system-prompt',
          nodes: [
            {
              id: 'my-loop',
              systemPrompt: 'TEST POLICY CONTENT',
              loop: {
                prompt: 'Do a task. When done, output <promise>COMPLETE</promise>.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const options = mockSendQueryDag.mock.calls[0][3] as { systemPrompt?: string };
      expect(options.systemPrompt).toBe('TEST POLICY CONTENT');
    });

    it('completes after multiple iterations', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount < 3) {
          yield { type: 'assistant', content: `Iteration ${String(callCount)} progress` };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        } else {
          yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-multi',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do next task.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(3);
    });

    it('substitutes $LOOP_PREV_OUTPUT with previous iteration output (empty on iter 1)', async () => {
      // Iteration 1 emits a distinctive output, iteration 2 emits the completion signal.
      // We then assert the prompt sent to the AI: iteration 1 strips $LOOP_PREV_OUTPUT
      // to empty, iteration 2 receives iteration 1's cleaned output.
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: 'assistant', content: 'Iter1 output: 2 type errors in users.ts' };
          yield { type: 'result', sessionId: 'loop-session-1' };
        } else {
          yield { type: 'assistant', content: 'All fixed. <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-session-2' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-prev-output',
          nodes: [
            {
              id: 'fix-loop',
              loop: {
                prompt: 'Previous output: <<$LOOP_PREV_OUTPUT>>. Fix and emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
      const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
      // Iteration 1: $LOOP_PREV_OUTPUT substitutes to empty string.
      expect(promptIter1).toContain('Previous output: <<>>.');
      // Iteration 2: receives iteration 1's cleaned output.
      expect(promptIter2).toContain(
        'Previous output: <<Iter1 output: 2 type errors in users.ts>>.'
      );
    });

    it('strips <promise> tags from $LOOP_PREV_OUTPUT (uses cleaned output)', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          // Iteration 1 includes a non-completion XML tag in its output. The cleaned
          // output (after stripCompletionTags) drops <promise>...</promise> blocks.
          // We use a non-matching signal here so iteration 1 does NOT complete.
          yield {
            type: 'assistant',
            content: 'Real work output. <promise>NOT_DONE_YET</promise>',
          };
          yield { type: 'result', sessionId: 'loop-session-1' };
        } else {
          yield { type: 'assistant', content: 'Done. <promise>COMPLETE</promise>' };
          yield { type: 'result', sessionId: 'loop-session-2' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-prev-clean',
          nodes: [
            {
              id: 'fix-loop',
              loop: {
                prompt: 'PREV=[$LOOP_PREV_OUTPUT]',
                until: 'COMPLETE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptIter2 = mockSendQueryDag.mock.calls[1][0] as string;
      // The previous-output payload must be the *cleaned* output -- no <promise> tags.
      expect(promptIter2).toContain('PREV=[Real work output.');
      expect(promptIter2).not.toContain('<promise>');
    });

    it('$LOOP_PREV_OUTPUT is empty on the first iteration after interactive resume', async () => {
      // Regression guard for the resume-from-approval path: when an interactive
      // loop pauses at the approval gate, the prior `lastIterationOutput` lives
      // in a separate process and is not persisted. On resume, the executor must
      // substitute $LOOP_PREV_OUTPUT to '' on the first resumed iteration --
      // never to whatever the paused run produced.
      //
      // Wirasm-suggested shape (PR #1367 review): two executeDagWorkflow calls.
      // The first call pauses at the gate after iteration 1; the second call
      // resumes with metadata.approval populated and runs iteration 2.

      // ---- Call 1: fresh run, iteration 1 emits no completion -> pauses at gate
      mockSendQueryDag.mockImplementationOnce(function* () {
        yield { type: 'assistant', content: 'Iter1 output: 2 type errors in users.ts' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });
      const mockDeps1 = createMockDeps();
      const platform1 = createMockPlatform();
      const freshRun = makeWorkflowRun('resume-prev-fresh-run');

      await executeDagWorkflow(
        mockDeps1,
        platform1,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        freshRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // First iteration of a fresh interactive loop: $LOOP_PREV_OUTPUT empty;
      // $LOOP_USER_INPUT empty (no user has spoken yet).
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const promptIter1 = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptIter1).toContain('PREV=<<>>.');
      expect(promptIter1).toContain('User: .');
      // Fresh interactive loop must pause at the gate, not return early.
      const pauseCalls1 = (
        mockDeps1.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls1.length).toBe(1);
      expect(pauseCalls1[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
      });

      // ---- Call 2: resumed run -- metadata carries iter 1 + user input.
      // iter 2 emits the completion signal so the loop exits cleanly.
      mockSendQueryDag.mockImplementationOnce(function* () {
        yield { type: 'assistant', content: 'All clear. <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-session-2' };
      });
      const mockDeps2 = createMockDeps();
      const platform2 = createMockPlatform();
      const resumedRun = makeWorkflowRun('resume-prev-resume-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-1',
            message: 'Review and provide feedback.',
          },
          loop_user_input: 'looks good, ship it',
        },
      });

      await executeDagWorkflow(
        mockDeps2,
        platform2,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-prev-output',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt:
                  'User: $LOOP_USER_INPUT. PREV=<<$LOOP_PREV_OUTPUT>>. Continue or emit COMPLETE.',
                until: 'COMPLETE',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        resumedRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Second executeDagWorkflow call started a fresh sendQuery generator (mock
      // call index 1 across the two runs). The resumed iteration must NOT carry
      // the prior process's iter-1 output through $LOOP_PREV_OUTPUT -- it must
      // substitute to ''.
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      const promptResumeIter = mockSendQueryDag.mock.calls[1][0] as string;
      expect(promptResumeIter).toContain('PREV=<<>>.');
      expect(promptResumeIter).not.toContain('Iter1 output: 2 type errors');
      // The resume's user input flows through on the first resumed iteration.
      expect(promptResumeIter).toContain('User: looks good, ship it.');
      // Resume call exits via completion, not via a second pause at the gate.
      const pauseCalls2 = (
        mockDeps2.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls2.length).toBe(0);
    });

    it('fails when max_iterations exceeded', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'loop-session' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-max',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly 2 times (max_iterations)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Workflow should be marked failed (no completion signal)
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    it('completes on final iteration with XML-wrapped signal (<COMPLETE>SIGNAL</COMPLETE>)', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount < 3) {
          yield { type: 'assistant', content: `Iteration ${String(callCount)} progress` };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        } else {
          // Final iteration uses <COMPLETE> tag instead of <promise>
          yield { type: 'assistant', content: 'All clean! <COMPLETE>ALL_CLEAN</COMPLETE>' };
          yield { type: 'result', sessionId: `loop-session-${String(callCount)}` };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-xml-tag',
          nodes: [
            {
              id: 'fix-and-review',
              loop: {
                prompt: 'Fix and review. When done, output <COMPLETE>ALL_CLEAN</COMPLETE>.',
                until: 'ALL_CLEAN',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // 3 iterations run, signal found on iteration 3 -> completed, NOT failed
      expect(mockSendQueryDag.mock.calls.length).toBe(3);
      expect(
        (
          mockDeps.store.completeWorkflowRun as Mock<
            (id: string, metadata?: Record<string, unknown>) => Promise<void>
          >
        ).mock.calls.length
      ).toBe(1);
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(0);
      // Verify stripping: raw XML completion tags must not appear in user-visible output
      const allSentMessages = (
        platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
      ).mock.calls
        .map((call: unknown[]) => call[1] as string)
        .join('');
      expect(allSentMessages).not.toContain('<COMPLETE>');
      expect(allSentMessages).not.toContain('</COMPLETE>');
    });

    it('loop node output available to downstream nodes via $nodeId.output', async () => {
      let loopCallCount = 0;
      mockSendQueryDag.mockImplementation(function* (prompt: string) {
        if (prompt.includes('Do task')) {
          loopCallCount++;
          if (loopCallCount >= 2) {
            yield {
              type: 'assistant',
              content: 'Loop result: all tasks done <promise>COMPLETE</promise>',
            };
          } else {
            yield { type: 'assistant', content: 'Working on task 1' };
          }
          yield { type: 'result', sessionId: 'loop-sid' };
        } else {
          // downstream node
          yield { type: 'assistant', content: 'Got upstream: ' + prompt.slice(0, 50) };
          yield { type: 'result', sessionId: 'downstream-sid' };
        }
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-output',
          nodes: [
            {
              id: 'impl',
              loop: {
                prompt: 'Do task. Output <promise>COMPLETE</promise> when done.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
            {
              id: 'report',
              prompt: 'Summarize: $impl.output',
              depends_on: ['impl'],
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Loop ran 2 iterations + downstream ran once = 3 calls
      expect(mockSendQueryDag.mock.calls.length).toBe(3);
    });

    it('fresh_context: true gives each iteration fresh session', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount >= 2) {
          yield { type: 'assistant', content: '<promise>DONE</promise>' };
        } else {
          yield { type: 'assistant', content: 'Progress' };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-fresh',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: true,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Both calls should have undefined resumeSessionId (fresh context)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // First call: fresh (iteration 1 always fresh)
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      // Second call: also fresh (fresh_context: true)
      expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    });

    it('fresh_context: false threads session between iterations', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount >= 2) {
          yield { type: 'assistant', content: '<promise>DONE</promise>' };
        } else {
          yield { type: 'assistant', content: 'Progress' };
        }
        yield { type: 'result', sessionId: `session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-stateful',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do stuff.',
                until: 'DONE',
                max_iterations: 5,
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // First call: fresh (iteration 1 always fresh)
      expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
      // Second call: should have session-1 from first iteration
      expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
    });

    it('strips <promise> tags from platform output', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-strip',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Task.',
                until: 'COMPLETE',
                max_iterations: 3,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // In batch mode, accumulated clean output is sent
      const sendCalls = (platform.sendMessage as Mock<() => Promise<void>>).mock.calls;
      const contentMessages = sendCalls
        .map((call: unknown[]) => call[1] as string)
        .filter((msg: string) => msg.includes('Done'));
      // Should have stripped <promise> tags
      for (const msg of contentMessages) {
        expect(msg).not.toContain('<promise>');
      }
    });

    it('cancellation between iterations stops the loop', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        yield { type: 'assistant', content: `Iteration ${String(callCount)}` };
        yield { type: 'result', sessionId: `sid-${String(callCount)}` };
      });

      const store = createMockStore();
      let statusCallCount = 0;
      (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockImplementation(() => {
        statusCallCount++;
        // Return 'cancelled' on second status check (before iteration 2)
        if (statusCallCount >= 2) return Promise.resolve('cancelled');
        return Promise.resolve('running');
      });
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-cancel',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do tasks.',
                until: 'COMPLETE',
                max_iterations: 10,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have only done 1 iteration (cancelled before iteration 2)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
    });

    it('AI error mid-iteration returns failed NodeOutput', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        throw new Error('Claude Code auth error: unauthorized');
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-ai-error',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have run exactly 1 iteration (failed on first)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Workflow should be marked failed
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    it('detects plain completion signal (non-<promise> format)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'All tasks done!\nCOMPLETE' };
        yield { type: 'result', sessionId: 'plain-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-plain-signal',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should complete on first iteration (plain signal on own line)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      const completeCalls = (
        mockDeps.store.completeWorkflowRun as Mock<
          (id: string, metadata?: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][1]).toEqual({
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      });
    });

    it('does NOT detect false positive plain signal in middle of text', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'The task is not COMPLETE yet, more work needed.' };
        yield { type: 'result', sessionId: 'false-pos-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-false-positive',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Work.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have run max_iterations times (NOT detected as complete)
      expect(mockSendQueryDag.mock.calls.length).toBe(2);
      // Should have FAILED (not completed)
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(1);
    });

    // --- Interactive Loop Tests --------------------------------------------

    it('interactive loop with gate_message pauses after first iteration', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Here is the plan. Please review.' };
        yield { type: 'result', sessionId: 'loop-session-1' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-test',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine the plan.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the plan and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery exactly once (paused after iteration 1)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Should have called pauseWorkflowRun with interactive_loop type
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(1);
      expect(pauseCalls[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
        message: 'Review the plan and provide feedback.',
      });
    });

    it('interactive loop first iteration always gates even if AI emits signal', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'assistant',
          content: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
        };
        yield { type: 'result', sessionId: 'loop-session-2' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-signal',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // On first iteration (fresh start, no user input), the loop MUST pause
      // at the gate even if the AI emits the completion signal. The user hasn't
      // seen anything yet -- they must review before the loop can exit.
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(1);
      expect(pauseCalls[0][1]).toMatchObject({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 1,
      });
    });

    it('interactive loop exits on resume when AI emits completion signal (user approved)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'assistant',
          content: 'Plan approved. Proceeding. <promise>APPROVED</promise>',
        };
        yield { type: 'result', sessionId: 'loop-session-3' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      // Simulate a resumed run where the user said "approved"
      const workflowRun = makeWorkflowRun('resume-signal-run', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-2',
            message: 'Review and provide feedback.',
          },
          loop_user_input: 'approved',
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume-signal',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review and provide feedback.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // On resume with user input, the AI processes the approval and emits the
      // completion signal. The loop exits immediately without pausing at the gate.
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(0);
    });

    it('interactive loop resumes from stored iteration with user input', async () => {
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        yield { type: 'assistant', content: 'Updated plan. <promise>APPROVED</promise>' };
        yield { type: 'result', sessionId: `resumed-session-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      // Simulate a resumed run: metadata has loop gate state and user input
      const workflowRun = makeWorkflowRun('resumed-run-id', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'loop-session-1',
            message: 'Review the plan.',
          },
          loop_user_input: 'Add error handling',
        },
      });

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'interactive-loop-resume',
          nodes: [
            {
              id: 'refine',
              loop: {
                prompt: 'User said: $LOOP_USER_INPUT. Refine the plan.',
                until: 'APPROVED',
                max_iterations: 10,
                interactive: true,
                gate_message: 'Review the plan.',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should have called sendQuery once (starting from iteration 2, completed immediately)
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // Verify the prompt contains the user input
      const promptArg = mockSendQueryDag.mock.calls[0][0] as string;
      expect(promptArg).toContain('Add error handling');
      // Should have resumed with stored session ID
      const sessionArg = mockSendQueryDag.mock.calls[0][2] as string | undefined;
      expect(sessionArg).toBe('loop-session-1');
    });

    it('loop iteration fails loudly when SDK returns error_during_execution', async () => {
      // Regression test for #1208: previously the loop silently broke on isError
      // results and kept iterating with empty output, producing "5-second crashes"
      // that masqueraded as successful iterations.
      mockSendQueryDag.mockImplementation(function* () {
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_during_execution',
          errors: ['Subprocess crashed mid-turn'],
          sessionId: 'bad-session',
        };
      });

      const store = createMockStore();
      const mockDeps = createMockDeps(store);
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'loop-iteration-err',
          nodes: [
            {
              id: 'work',
              loop: {
                prompt: 'Do the work. Say DONE.',
                until: 'DONE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Should fail after one iteration rather than burning through max_iterations
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      // The loop_iteration_failed event should carry the subtype and SDK errors detail
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const iterFailedEvents = eventCalls.filter(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).event_type === 'loop_iteration_failed'
      );
      expect(iterFailedEvents.length).toBeGreaterThan(0);
      const failedData = (iterFailedEvents[0][0] as Record<string, unknown>).data as Record<
        string,
        unknown
      >;
      expect(failedData.error).toContain('error_during_execution');
      expect(failedData.error).toContain('Subprocess crashed mid-turn');
    });

    it('non-interactive loop is unaffected (no pause)', async () => {
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: 'loop-session' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'non-interactive-loop',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Do task.',
                until: 'COMPLETE',
                max_iterations: 2,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // pauseWorkflowRun should never be called for non-interactive loops
      const pauseCalls = (
        mockDeps.store.pauseWorkflowRun as Mock<
          (id: string, ctx: Record<string, unknown>) => Promise<void>
        >
      ).mock.calls;
      expect(pauseCalls.length).toBe(0);
    });

    // --- Sticky signal detection -------------------------------------------

    it('sticky detection: signal in iteration 1 exits loop before max_iterations', async () => {
      // stickySignalDetected is set true in iteration 1. The mock yields no signal in
      // iteration 2+ to prove the loop doesn't need re-emission -- but with correct
      // detection, the loop exits after iteration 1 (stickySignalDetected || bashComplete).
      let callCount = 0;
      mockSendQueryDag.mockImplementation(function* () {
        callCount++;
        if (callCount === 1) {
          // Iteration 1: signal on its own line -> signalDetected=true -> stickySignalDetected=true
          yield { type: 'assistant', content: 'All checks passed.\nCOMPLETE' };
        } else {
          // Iteration 2+: deliberately no signal (validates sticky prevents max_iter failure)
          yield { type: 'assistant', content: 'No signal in this iteration.' };
        }
        yield { type: 'result', sessionId: `sticky-sid-${String(callCount)}` };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-sticky',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Work. Emit COMPLETE on its own line when done.',
                until: 'COMPLETE',
                max_iterations: 5,
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Loop exits after iteration 1 -- stickySignalDetected becomes true and
      // completionDetected = stickySignalDetected || bashComplete = true.
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(
        (
          mockDeps.store.completeWorkflowRun as Mock<
            (id: string, metadata?: Record<string, unknown>) => Promise<void>
          >
        ).mock.calls.length
      ).toBe(1);
      expect(
        (mockDeps.store.failWorkflowRun as Mock<(id: string, error: string) => Promise<void>>).mock
          .calls.length
      ).toBe(0);
    });

    it('until_file: workflow with until_file field is accepted by the schema', async () => {
      // Structural test: verify a workflow definition containing until_file parses without error
      // and completes when the AI emits the completion signal.
      // Execution-level bash expansion (test -f .archon/<path>) is covered in loader.test.ts.
      mockSendQueryDag.mockImplementation(function* () {
        yield { type: 'assistant', content: '<promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'file-sentinel-sid' };
      });

      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun();

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'dag-loop-until-file',
          nodes: [
            {
              id: 'my-loop',
              loop: {
                prompt: 'Work. Write .archon/done.txt when finished.',
                until: 'COMPLETE',
                max_iterations: 3,
                until_file: 'done.txt',
              },
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      // Signal detected (XML wrapped) -> stickySignalDetected=true -> exits after 1 iteration.
      // The until_bash expansion (test -f .archon/done.txt) is a secondary check; on
      // environments without bash it gracefully degrades to bashComplete=false.
      expect(mockSendQueryDag.mock.calls.length).toBe(1);
      expect(
        (
          mockDeps.store.completeWorkflowRun as Mock<
            (id: string, metadata?: Record<string, unknown>) => Promise<void>
          >
        ).mock.calls.length
      ).toBe(1);
    });
  });
});

describe('executeDagWorkflow -- break after result (no hang on subprocess exit)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-break-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    // Restore default sync generator so later tests aren't affected
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('command/prompt node completes immediately after result -- does not block on post-result messages', async () => {
    // Generator yields result then hangs forever (simulates subprocess that won't exit)
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'response' };
      yield { type: 'result', sessionId: 'sess-break' };
      // Subprocess hangs -- without break, this blocks until idle timeout
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    // Should complete promptly (not hang for 30 min)
    const result = await Promise.race([
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        { name: 'break-test', nodes: [{ id: 'n1', command: 'my-cmd' }] },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      ).then(() => 'completed'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out -- break after result not working')), 5000)
      ),
    ]);

    expect(result).toBe('completed');
  });

  it('loop node completes immediately after result -- does not block on post-result messages', async () => {
    // Generator yields result then hangs forever
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'All done. COMPLETE' };
      yield { type: 'result', sessionId: 'sess-loop-break' };
      await new Promise<void>(() => {});
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await Promise.race([
      executeDagWorkflow(
        mockDeps,
        platform,
        'conv-dag',
        testDir,
        {
          name: 'loop-break-test',
          nodes: [
            {
              id: 'loop1',
              loop: { until: 'COMPLETE', max_iterations: 3 },
              prompt: 'Do the thing. Say COMPLETE when done.',
            },
          ],
        },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      ).then(() => 'completed'),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out -- break after result not working')), 5000)
      ),
    ]);

    expect(result).toBe('completed');
  });
});

describe('executeDagWorkflow -- terminal node output selection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-terminal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Command prompt $ARGUMENTS');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns output of the single terminal node in a linear DAG', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'assistant', content: 'Final summary text' };
      yield { type: 'result', sessionId: 'sess-linear' };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'linear-dag',
        nodes: [
          { id: 'step1', command: 'my-cmd' },
          { id: 'step2', command: 'my-cmd', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(result).toBe('Final summary text');
  });

  it('fails node when the AI stream closes with no assistant output', async () => {
    // Empty assistant output on AI nodes (`command:`/`prompt:`) typically
    // indicates a silent provider rejection or stream interruption that
    // didn't yield a result.isError chunk. Treat it as a node failure
    // rather than a successful empty completion.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'result', sessionId: 'sess-empty' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'empty-dag', nodes: [{ id: 'only', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('produced no assistant output');
    // Workflow-level failure must propagate, not just the node event.
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });

  it('does NOT fail node when stream yields no assistant text but a structuredOutput is present', async () => {
    // Output-format nodes legitimately produce zero free-form text -- the
    // useful payload is the structuredOutput field. The empty-output guard
    // must spare them.
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        sessionId: 'sess-structured',
        structuredOutput: { category: 'math' },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'structured-only-dag',
        nodes: [
          {
            id: 'classify',
            prompt: 'Classify this',
            output_format: { type: 'object', properties: {} },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBe(0);
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedEvents.length).toBeGreaterThan(0);
  });

  it('fails the run when a node specifies an unknown provider (defense-in-depth at execution time)', async () => {
    // Loader-time validation also catches this (loader.ts iterates dagNodes
    // after parsing), but the dag-executor's resolveNodeProviderAndModel
    // throws as defense-in-depth in case a code path bypasses the loader.
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'unknown-provider-dag',
        nodes: [
          {
            id: 'bad',
            command: 'my-cmd',
            provider: 'claud', // typo
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(store.failWorkflowRun).toHaveBeenCalled();
    // The "unknown provider" detail surfaces on the node_failed event; the
    // workflow-level fail message is a generic "no successful nodes" summary.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const nodeFailedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(nodeFailedData.error).toContain("unknown provider 'claud'");
  });

  it('excludes intermediate nodes with dependents from terminal set (fan-in DAG)', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      callCount++;
      if (callCount === 3) {
        // Third call is for node 'c' (terminal)
        yield { type: 'assistant', content: 'C final output' };
      } else {
        yield { type: 'assistant', content: `Intermediate output ${callCount}` };
      }
      yield { type: 'result', sessionId: `sess-fanin-${callCount}` };
    });

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const result = await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'fanin-dag',
        nodes: [
          { id: 'a', command: 'my-cmd' },
          { id: 'b', command: 'my-cmd' },
          { id: 'c', command: 'my-cmd', depends_on: ['a', 'b'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Only 'c' is terminal (no node depends on it); 'a' and 'b' are not terminal
    expect(result).toBe('C final output');
  });
});

// ---------------------------------------------------------------------------
// Cancel node dispatch
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- cancel node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('cancel node transitions run to cancelled and sends message', async () => {
    const store = createMockStore();
    (store.cancelWorkflowRun as Mock<() => Promise<void>>).mockResolvedValue(undefined);
    // Track whether cancelWorkflowRun has been called to simulate status transition
    let cancelled = false;
    (store.cancelWorkflowRun as Mock<() => Promise<void>>).mockImplementation(async () => {
      cancelled = true;
    });
    (store.getWorkflowRunStatus as Mock<() => Promise<string>>).mockImplementation(async () =>
      cancelled ? 'cancelled' : 'running'
    );
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'cancel-test',
        nodes: [
          { id: 'check', bash: 'echo blocked' },
          { id: 'stop', depends_on: ['check'], cancel: 'Precondition failed' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // cancelWorkflowRun should have been called
    expect((store.cancelWorkflowRun as Mock<() => Promise<void>>).mock.calls.length).toBe(1);

    // A message with the cancel reason should have been sent
    const sendCalls = (platform.sendMessage as Mock<() => Promise<void>>).mock.calls;
    const cancelMsg = sendCalls.find(
      (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Workflow cancelled')
    );
    expect(cancelMsg).toBeDefined();
  });

  it('cancel node with when: false is skipped', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'cancel-skip-test',
        nodes: [
          { id: 'check', bash: 'echo ok' },
          { id: 'stop', depends_on: ['check'], cancel: 'Should not fire', when: '1 == 0' },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // cancelWorkflowRun should NOT have been called (when: condition is false)
    if (store.cancelWorkflowRun && typeof store.cancelWorkflowRun === 'function') {
      expect((store.cancelWorkflowRun as Mock<() => Promise<void>>).mock.calls.length).toBe(0);
    }
  });
});

describe('executeDagWorkflow -- credit exhaustion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-credit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('marks node as failed when assistant output contains credit exhaustion text', async () => {
    const creditExhaustedQuery = mock(function* () {
      yield { type: 'assistant', content: "You're out of extra usage - resets in 2h" };
      yield { type: 'result', sessionId: 'dag-session-credit' };
    });
    mockGetAgentProviderDag.mockReturnValue({
      sendQuery: creditExhaustedQuery,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    });

    const store = createMockStore();
    const deps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('credit-exhaustion-run');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-credit',
      testDir,
      {
        name: 'credit-test',
        nodes: [{ id: 'investigate', prompt: 'Investigate the issue' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // node_failed (not node_completed) must have been stored
    const events = (store.createWorkflowEvent as Mock<() => Promise<void>>).mock.calls.map(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type
    );
    expect(events).toContain('node_failed');
    expect(events).not.toContain('node_completed');

    // Overall workflow should be marked failed
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });
});
describe('executeDagWorkflow -- approval node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-approval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('fresh approval node pauses with extended context (capture_response + on_reject)', async () => {
    // Set interactive mode so the gate pauses -- this test exercises the pause path.
    process.env.CAULDRON_INTERACTIVE = 'true';

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-test',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              capture_response: true,
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should NOT have been called (fresh approval just pauses)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // pauseWorkflowRun should have been called with extended context
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve this plan?',
      captureResponse: true,
      onRejectPrompt: 'Fix based on: $REJECTION_REASON',
      onRejectMaxAttempts: 3,
    });
  });

  it('approval node without capture_response stores empty node output', async () => {
    // Set interactive mode so the gate pauses -- this test exercises the pause path.
    process.env.CAULDRON_INTERACTIVE = 'true';

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-no-capture',
        nodes: [
          {
            id: 'review',
            approval: { message: 'Approve?' },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // pauseWorkflowRun context should NOT have captureResponse
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'review',
      message: 'Approve?',
    });
    // captureResponse should be undefined (not set)
    expect((pauseCalls[0][1] as Record<string, unknown>).captureResponse).toBeUndefined();
  });

  it('on_reject runs AI prompt and re-pauses on rejection resume', async () => {
    // Set interactive mode so the gate re-pauses after the on_reject AI run.
    process.env.CAULDRON_INTERACTIVE = 'true';

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Fixed based on feedback' };
      yield { type: 'result', sessionId: 'reject-fix-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    // Simulate a rejection resume -- metadata has rejection_reason set by reject handler
    const workflowRun = makeWorkflowRun('reject-resume-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-reject-resume',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              capture_response: true,
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should have been called once (on_reject prompt ran)
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The prompt should contain the rejection reason
    const aiPrompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(aiPrompt).toContain('Missing edge case handling');

    // pauseWorkflowRun should have been called (re-paused at approval gate)
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
  });

  it('on_reject does not write node_completed for the approval gate node ID', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Fixed based on feedback' };
      yield { type: 'result', sessionId: 'reject-no-poison-session' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-no-poison-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Missing edge case handling',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-no-poison',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              on_reject: { prompt: 'Fix based on: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The on_reject synthetic node must NOT produce a node_completed event with
    // step_name equal to the approval gate's own ID ('review'). If it did, a
    // subsequent resume would find the event via getCompletedDagNodeOutputs and
    // skip the approval gate entirely, bypassing the human gate.
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeCompletedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    const completedStepNames = nodeCompletedEvents.map(
      (call: unknown[]) => (call[0] as Record<string, unknown>).step_name
    );
    expect(completedStepNames).not.toContain('review');

    // The synthetic on_reject node MUST produce a node_completed event with the
    // distinct ID 'review:on_reject'. This ensures the synthetic node itself is
    // recorded as completed so it is not re-run on a subsequent resume.
    expect(completedStepNames.filter((n: unknown) => n === 'review:on_reject').length).toBe(1);
  });

  it('on_reject cancels when max_attempts exhausted', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    // rejection_count already at max_attempts
    const workflowRun = makeWorkflowRun('reject-exhausted-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve this plan?',
          onRejectPrompt: 'Fix based on: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_reason: 'Still not right',
        rejection_count: 3,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-exhausted',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve this plan?',
              on_reject: { prompt: 'Fix: $REJECTION_REASON', max_attempts: 3 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI should NOT have been called (max attempts reached, straight to cancel)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // cancelWorkflowRun should have been called
    const cancelCalls = (store.cancelWorkflowRun as Mock<(id: string) => Promise<void>>).mock.calls;
    expect(cancelCalls.length).toBe(1);

    // pauseWorkflowRun should NOT have been called
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(0);
  });

  it('on_reject with max_attempts: 1 cancels on first rejection', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    const workflowRun = makeWorkflowRun('reject-max1-run', {
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 1,
        },
        rejection_reason: 'Bad',
        rejection_count: 1,
      },
    });

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval',
      testDir,
      {
        name: 'approval-max1',
        nodes: [
          {
            id: 'review',
            approval: {
              message: 'Approve?',
              on_reject: { prompt: 'Fix: $REJECTION_REASON', max_attempts: 1 },
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Should cancel immediately, no AI call
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
    expect((store.cancelWorkflowRun as Mock<(id: string) => Promise<void>>).mock.calls.length).toBe(
      1
    );
  });

  it('approval message substitutes $nodeId.output.field references from upstream structured output', async () => {
    // Set interactive mode so the gate pauses -- this test exercises the message-substitution
    // path which only runs when the gate reaches the pause logic.
    process.env.CAULDRON_INTERACTIVE = 'true';

    // Repro for: approval gates were rendering literal "$gather-context.output.repo_name"
    // instead of resolved values, breaking interactive workflows like atlas-onboard.
    // Parity: prompt/bash/loop/cancel nodes already get substituteNodeOutputRefs;
    // approval.message must too so the human sees concrete values.
    const structuredJson = {
      repo_name: 'hcr-els',
      app_code: 'CCELS',
      frontend_port: 3012,
    };

    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'gather-context.md'), 'Gather context: $USER_MESSAGE');

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: JSON.stringify(structuredJson) };
      yield { type: 'result', sessionId: 'sid-approval-sub', structuredOutput: structuredJson };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('approval-sub-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-approval-sub',
      testDir,
      {
        name: 'approval-sub-test',
        nodes: [
          {
            id: 'gather-context',
            command: 'gather-context',
            output_format: {
              type: 'object',
              properties: {
                repo_name: { type: 'string' },
                app_code: { type: 'string' },
                frontend_port: { type: 'number' },
              },
            },
          },
          {
            id: 'confirm',
            depends_on: ['gather-context'],
            approval: {
              message:
                'Repo: $gather-context.output.repo_name | App: $gather-context.output.app_code | Port: $gather-context.output.frontend_port',
            },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // gather-context AI call ran once; approval node does NOT call AI
    expect(mockSendQueryDag.mock.calls.length).toBe(1);

    // pauseWorkflowRun should receive the SUBSTITUTED message, not the literal placeholders
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({
      type: 'approval',
      nodeId: 'confirm',
      message: 'Repo: hcr-els | App: CCELS | Port: 3012',
    });

    // The fix touches FOUR emission sites (safeSendMessage / createWorkflowEvent /
    // pauseWorkflowRun / event-emitter). Assert the other two reachable surfaces too --
    // a future regression at any one of them would otherwise pass this test silently.
    // (Per CodeRabbit review of PR coleam00/Archon#1426.)

    // (a) The chat-surface prompt emitted via platform.sendMessage must contain the
    //     substituted message and must NOT contain literal $gather-context.output refs.
    const sentMessages = (
      platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
    ).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentMessages.some(m => m.includes('Repo: hcr-els | App: CCELS | Port: 3012'))).toBe(
      true
    );
    expect(sentMessages.some(m => m.includes('$gather-context.output'))).toBe(false);

    // (b) The persisted approval_requested workflow event's data.message must be substituted.
    const approvalRequestedEvents = (
      store.createWorkflowEvent as Mock<() => Promise<void>>
    ).mock.calls.filter(
      (c: unknown[]) => (c[0] as { event_type: string }).event_type === 'approval_requested'
    );
    expect(approvalRequestedEvents.length).toBe(1);
    expect((approvalRequestedEvents[0][0] as { data: { message: string } }).data.message).toBe(
      'Repo: hcr-els | App: CCELS | Port: 3012'
    );
  });

  // ---------------------------------------------------------------------------
  // CAULDRON_INTERACTIVE gate bypass tests
  // T6 (regression/critical): non-interactive mode must NOT pause -- auto-proceed.
  // T1: interactive mode must pause and send the approval message.
  // ---------------------------------------------------------------------------

  afterEach(() => {
    // Restore env after each CAULDRON_INTERACTIVE test
    delete process.env.CAULDRON_INTERACTIVE;
  });

  it('T6: non-interactive (CAULDRON_INTERACTIVE unset) approval node does NOT pause -- auto-proceeds', async () => {
    // Ensure flag is absent (non-interactive default)
    delete process.env.CAULDRON_INTERACTIVE;

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t6-non-interactive-run');

    // executeDagWorkflow returns string|undefined (last node output), not NodeOutput.
    // For a single-node approval workflow that bypasses the gate, it returns undefined.
    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t6',
      testDir,
      {
        name: 't6-non-interactive',
        nodes: [
          {
            id: 'gate',
            approval: { message: 'Approve?' },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // pauseWorkflowRun must NOT have been called -- the gate was bypassed
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(0);

    // completeWorkflowRun should have been called (DAG completed normally)
    const completeCalls = (store.completeWorkflowRun as Mock<(id: string) => Promise<void>>).mock
      .calls;
    expect(completeCalls.length).toBe(1);
  });

  it('T1: interactive (CAULDRON_INTERACTIVE=true) approval node pauses and sends the message', async () => {
    // Set interactive mode -- gate should pause and send the approval message
    process.env.CAULDRON_INTERACTIVE = 'true';

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t1-interactive-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t1',
      testDir,
      {
        name: 't1-interactive',
        nodes: [
          {
            id: 'gate',
            approval: { message: 'Approve this plan?' },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // pauseWorkflowRun must have been called exactly once
    const pauseCalls = (
      store.pauseWorkflowRun as Mock<(id: string, ctx: Record<string, unknown>) => Promise<void>>
    ).mock.calls;
    expect(pauseCalls.length).toBe(1);
    expect(pauseCalls[0][1]).toMatchObject({ type: 'approval', nodeId: 'gate' });

    // safeSendMessage (via platform.sendMessage) must have sent the approval message
    const sentMessages = (
      platform.sendMessage as Mock<(...args: unknown[]) => Promise<void>>
    ).mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentMessages.some(m => m.includes('Approve this plan?'))).toBe(true);
  });
});
describe('executeDagWorkflow -- env var injection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-env-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test', {
      flag: 'w',
    }).catch(async () => {
      await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test');
    });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes config.envVars as env to sendQuery for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-env-test', nodes: [{ id: 'task', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg?.env).toEqual({ MY_SECRET: 'abc123' });
  });

  it('does not set env on claudeOptions when config.envVars is empty', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-env', nodes: [{ id: 'task', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: {} }
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(optionsArg?.env).toBeUndefined();
  });
});

describe('executeDagWorkflow -- Claude SDK advanced options', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-sdk-opts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('fails node when SDK returns error_max_budget_usd result', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_max_budget_usd',
        sessionId: 'sid',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'budget-test',
        nodes: [{ id: 'step1', command: 'my-cmd', maxBudgetUsd: 2.5 }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(
      (store.failWorkflowRun as Mock<(id: string, msg: string) => Promise<void>>).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it('error message includes cost cap when maxBudgetUsd is set', async () => {
    // 'ok' runs first (no deps), then 'capped' runs after (depends_on: ['ok'])
    // This ensures both nodes run -- 'ok' succeeds, 'capped' hits the budget cap
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        // First call: 'ok' node succeeds
        yield { type: 'assistant', content: 'done' };
        yield { type: 'result', sessionId: 'sid1' };
      } else {
        // Second call: 'capped' node hits budget cap
        yield {
          type: 'result',
          isError: true,
          errorSubtype: 'error_max_budget_usd',
          sessionId: 'sid2',
        };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'budget-msg-test',
        nodes: [
          { id: 'ok', prompt: 'do work first' },
          { id: 'capped', command: 'my-cmd', maxBudgetUsd: 2.5, depends_on: ['ok'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const capMessage = messages.find(m => m.includes('$2.50'));
    expect(capMessage).toBeDefined();
  });

  it('fails node when SDK returns error_during_execution result', async () => {
    // Regression test for #1208: previously we only failed on error_max_budget_usd
    // and silently broke on all other isError subtypes, letting failed nodes
    // masquerade as successes with empty output.
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Tool call failed: permission denied'],
        sessionId: 'sid-err',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'err-exec-test',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The node_failed event should carry the subtype and SDK errors detail
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const nodeFailedEvents = eventCalls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_failed'
    );
    expect(nodeFailedEvents.length).toBeGreaterThan(0);
    const failedData = (nodeFailedEvents[0][0] as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    expect(failedData.error).toContain('error_during_execution');
    expect(failedData.error).toContain('permission denied');
  });

  it('forwards workflow-level effort to node when no per-node override', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'workflow-effort-test',
        nodes: [{ id: 'step1', command: 'my-cmd' }],
        effort: 'high',
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('high');
  });

  it('per-node effort overrides workflow-level effort', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'node-effort-override-test',
        nodes: [{ id: 'step1', command: 'my-cmd', effort: 'max' }],
        effort: 'low',
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg?.nodeConfig as Record<string, unknown>;
    expect(nodeConfig?.effort).toBe('max');
  });

  it('warns user when Codex node has Claude-only options (effort)', async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'codex',
      getCapabilities: mockCodexCapabilities,
    }));

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'codex-claude-opts-test',
        nodes: [{ id: 'step1', command: 'my-cmd', provider: 'codex', effort: 'high' }],
      },
      workflowRun,
      'codex',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, assistant: 'codex' }
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const warning = messages.find(m => m.includes('effort') && m.toLowerCase().includes('codex'));
    expect(warning).toBeDefined();
  });
});

describe('executeDagWorkflow -- cost tracking', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('passes total_cost_usd to completeWorkflowRun when node yields cost', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield { type: 'result', sessionId: 'sid-cost', cost: 0.0042 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-cost', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toEqual({
      node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      total_cost_usd: 0.0042,
    });
  });

  it('sums total_cost_usd across multiple sequential nodes', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      yield { type: 'assistant', content: `Step ${String(callCount)} output` };
      yield { type: 'result', sessionId: `sid-${String(callCount)}`, cost: 0.001 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-cost-multi',
        nodes: [
          { id: 'step1', prompt: 'Step 1.' },
          { id: 'step2', prompt: 'Step 2.', depends_on: ['step1'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.002 });
  });

  it('omits total_cost_usd from completeWorkflowRun when no cost yielded', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Some output' };
      yield { type: 'result', sessionId: 'sid-no-cost' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-cost', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).not.toHaveProperty('total_cost_usd');
  });

  it('accumulates cost across loop iterations and includes in completeWorkflowRun', async () => {
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount < 3) {
        yield { type: 'assistant', content: 'Still working...' };
        yield { type: 'result', sessionId: `loop-sid-${String(callCount)}`, cost: 0.001 };
      } else {
        yield { type: 'assistant', content: 'All done! <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: `loop-sid-${String(callCount)}`, cost: 0.002 };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-loop-cost',
        nodes: [
          {
            id: 'my-loop',
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // 3 iterations: 0.001 + 0.001 + 0.002 = 0.004
    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.004 });
  });
});

describe('executeDagWorkflow -- token tracking', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockLogFn.mockClear();

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Locate the most recent `node_completed` event passed to
   * store.createWorkflowEvent. Used to assert per-node `data.tokens`
   * persistence (Scenario 1, 2, 7).
   */
  function findLastNodeCompletedEventData(
    store: IWorkflowStore
  ): Record<string, unknown> | undefined {
    const calls = (
      store.createWorkflowEvent as Mock<
        (arg: { event_type: string; data: Record<string, unknown> }) => Promise<void>
      >
    ).mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      const arg = calls[i][0];
      if (arg.event_type === 'node_completed') return arg.data;
    }
    return undefined;
  }

  it('Scenario 1 -- per-node token persistence: persists data.tokens on node_completed event', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield {
        type: 'result',
        sessionId: 'sid-tok',
        cost: 0.001,
        tokens: { input: 1000, output: 500, total: 1500 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-tok', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = findLastNodeCompletedEventData(store);
    expect(data).toBeDefined();
    expect(data?.tokens).toEqual({ input: 1000, output: 500, total: 1500 });
  });

  it('Scenario 2 -- omit when absent: data.tokens absent (not 0, not {}) when SDK returns no usage', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'Some output' };
      yield { type: 'result', sessionId: 'sid-no-tok' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-tok', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = findLastNodeCompletedEventData(store);
    expect(data).toBeDefined();
    expect(data).not.toHaveProperty('tokens');
  });

  it('Scenario 3 -- per-run aggregate: sums total_tokens across nodes; cost unchanged', async () => {
    // node1: tokens 1500 + cost 0.001
    // node2: tokens 800  + cost 0.002
    // node3: NO tokens, NO cost
    // expected: total_tokens=2300, total_cost_usd=0.003
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'assistant', content: 'step1' };
        yield {
          type: 'result',
          sessionId: 'sid-1',
          cost: 0.001,
          tokens: { input: 1000, output: 500, total: 1500 },
        };
      } else if (callCount === 2) {
        yield { type: 'assistant', content: 'step2' };
        yield {
          type: 'result',
          sessionId: 'sid-2',
          cost: 0.002,
          tokens: { input: 500, output: 300, total: 800 },
        };
      } else {
        yield { type: 'assistant', content: 'step3' };
        yield { type: 'result', sessionId: 'sid-3' };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-tok-aggregate',
        nodes: [
          { id: 'step1', prompt: 'Step 1.' },
          { id: 'step2', prompt: 'Step 2.', depends_on: ['step1'] },
          { id: 'step3', prompt: 'Step 3.', depends_on: ['step2'] },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({
      total_tokens: 2300,
      total_cost_usd: 0.003,
    });
  });

  it('Scenario 6 -- resume semantics: total_tokens reflects only resumed-portion nodes', async () => {
    // node1 is pre-completed (prior run) -- should NOT contribute tokens.
    // node2 runs fresh and yields tokens; only node2's tokens count.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'step2 fresh' };
      yield {
        type: 'result',
        sessionId: 'sid-resumed',
        tokens: { input: 200, output: 100, total: 300 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    const priorCompletedNodes = new Map<string, string>([['step1', 'prior output']]);

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-tok-resume',
        nodes: [
          { id: 'step1', prompt: 'Step 1.' },
          { id: 'step2', prompt: 'Step 2.', depends_on: ['step1'] },
        ],
      },
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

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    // Only step2's 300 counted; node1 was skipped as prior_success and reports no tokens.
    expect(completeCalls[0][1]).toMatchObject({ total_tokens: 300 });
  });

  it('Scenario 7 -- loop-node token persistence: data.tokens is summed loopTotalTokens', async () => {
    // 3 iterations: i1 {1000/400}, i2 {600/300}, i3 {400/200, completion signal}
    // expected loop totals: input=2000, output=900, total=2900
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'assistant', content: 'Working...' };
        yield {
          type: 'result',
          sessionId: 'loop-sid-1',
          tokens: { input: 1000, output: 400, total: 1400 },
        };
      } else if (callCount === 2) {
        yield { type: 'assistant', content: 'Still working...' };
        yield {
          type: 'result',
          sessionId: 'loop-sid-2',
          tokens: { input: 600, output: 300, total: 900 },
        };
      } else {
        yield { type: 'assistant', content: 'Done! <promise>COMPLETE</promise>' };
        yield {
          type: 'result',
          sessionId: 'loop-sid-3',
          tokens: { input: 400, output: 200, total: 600 },
        };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-loop-tok',
        nodes: [
          {
            id: 'my-loop',
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = findLastNodeCompletedEventData(store);
    expect(data).toBeDefined();
    expect(data?.tokens).toEqual({ input: 2000, output: 900, total: 2900 });

    // Run aggregate: total_tokens = sum of loop totals = 2900
    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).toMatchObject({ total_tokens: 2900 });
  });

  it('Scenario 8 -- no regression: omits total_tokens when no node yielded tokens; total_cost_usd unaffected', async () => {
    // No tokens at all, but cost present -- cost path must still work.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield { type: 'result', sessionId: 'sid-nocost-or-tok', cost: 0.005 };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-no-tok-regr', nodes: [{ id: 'step', prompt: 'Do thing.' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (
      store.completeWorkflowRun as Mock<
        (id: string, metadata?: Record<string, unknown>) => Promise<void>
      >
    ).mock.calls;
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0][1]).not.toHaveProperty('total_tokens');
    expect(completeCalls[0][1]).toMatchObject({ total_cost_usd: 0.005 });
  });

  // -------------------------------------------------------------------------
  // WO-HARNESS-TOKEN-ATTRIBUTION-01 -- Codex repair: failure-path token persist
  // -------------------------------------------------------------------------
  // The SDK can yield tokens BEFORE signalling msg.isError. The original patch
  // surfaced tokens on completed and on the result tuple, but the persisted
  // node_failed / loop_iteration_failed events still omitted data.tokens --
  // losing per-node token attribution exactly for the failure cases that the
  // diagnostic graph needs most. These tests pin the fix.

  it('Scenario 9 -- node_failed event persists data.tokens when SDK yielded tokens before erroring', async () => {
    // Mirrors the existing "fails node when SDK returns error_during_execution"
    // test but the result now also carries tokens -- the failed event MUST
    // surface them.
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Tool call failed: permission denied'],
        sessionId: 'sid-err-tok',
        tokens: { input: 700, output: 300, total: 1000 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-failed-tok', nodes: [{ id: 'step', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (
      store.createWorkflowEvent as Mock<
        (arg: { event_type: string; data: Record<string, unknown> }) => Promise<void>
      >
    ).mock.calls;
    const failedEvents = eventCalls.filter(c => c[0].event_type === 'node_failed');
    expect(failedEvents.length).toBeGreaterThan(0);
    const failedData = failedEvents[0][0].data;
    expect(failedData.tokens).toEqual({ input: 700, output: 300, total: 1000 });
    // Still carries the error string.
    expect(typeof failedData.error).toBe('string');
  });

  it('Scenario 10 -- node_failed event omits tokens when SDK never reported any (omit-when-absent)', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['no usage emitted'],
        sessionId: 'sid-err-no-tok',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      { name: 'dag-failed-no-tok', nodes: [{ id: 'step', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (
      store.createWorkflowEvent as Mock<
        (arg: { event_type: string; data: Record<string, unknown> }) => Promise<void>
      >
    ).mock.calls;
    const failedEvents = eventCalls.filter(c => c[0].event_type === 'node_failed');
    expect(failedEvents.length).toBeGreaterThan(0);
    // Per the omit-when-absent invariant: not 0, not {}, just absent.
    expect(failedEvents[0][0].data).not.toHaveProperty('tokens');
  });

  it('Scenario 11a -- loop_iteration_failed (SDK error) persists aggregated loop tokens', async () => {
    // SDK error path: result yields tokens AND isError; tokens are
    // accumulated into loopTotalTokens BEFORE the throw, and the persisted
    // loop_iteration_failed event MUST carry them.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'partial' };
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        errors: ['Tool call failed'],
        sessionId: 'loop-sdkerr-sid',
        tokens: { input: 1500, output: 600, total: 2100 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-loop-sdkerr',
        nodes: [
          {
            id: 'loopy',
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (
      store.createWorkflowEvent as Mock<
        (arg: { event_type: string; data: Record<string, unknown> }) => Promise<void>
      >
    ).mock.calls;
    const failedIters = eventCalls.filter(c => c[0].event_type === 'loop_iteration_failed');
    expect(failedIters.length).toBeGreaterThan(0);
    const lastFailed = failedIters[failedIters.length - 1][0].data;
    expect(lastFailed.tokens).toEqual({ input: 1500, output: 600, total: 2100 });
  });

  it('Scenario 11 -- loop_iteration_failed (empty output) persists aggregated loop tokens', async () => {
    // Iteration 1 yields tokens, iteration 2 yields empty assistant output
    // (no content) -- the loop fails. The persisted loop_iteration_failed
    // event MUST include the accumulated loopTotalTokens from iteration 1.
    let callCount = 0;
    mockSendQueryDag.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield { type: 'assistant', content: 'iteration 1 output' };
        yield {
          type: 'result',
          sessionId: 'loop-fail-sid-1',
          tokens: { input: 800, output: 400, total: 1200 },
        };
      } else {
        // Empty assistant output -- triggers the empty-output failure branch.
        yield { type: 'result', sessionId: 'loop-fail-sid-2' };
      }
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-dag',
      testDir,
      {
        name: 'dag-loop-empty-fail',
        nodes: [
          {
            id: 'loopy',
            loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 5 },
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const eventCalls = (
      store.createWorkflowEvent as Mock<
        (arg: { event_type: string; data: Record<string, unknown> }) => Promise<void>
      >
    ).mock.calls;
    const failedIters = eventCalls.filter(c => c[0].event_type === 'loop_iteration_failed');
    expect(failedIters.length).toBeGreaterThan(0);
    // The last loop_iteration_failed event must carry the aggregated tokens.
    const lastFailed = failedIters[failedIters.length - 1][0].data;
    expect(lastFailed.tokens).toEqual({ input: 800, output: 400, total: 1200 });
  });
});

describe('executeDagWorkflow -- script nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-script-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('inline bun script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    const scriptNode: ScriptNode = {
      id: 'inline-bun',
      script: 'console.log("hello from bun")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script',
      testDir,
      { name: 'script-inline-bun-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('inline bun script output available for downstream substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'use-result.md'), 'Use: $compute.output');

    const nodes: DagNode[] = [
      { id: 'compute', script: 'console.log("42")', runtime: 'bun' },
      { id: 'use', command: 'use-result', depends_on: ['compute'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script',
      testDir,
      { name: 'script-subst-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // AI client called for the downstream AI node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42');
  });

  it('inline uv script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-uv-run-id', {
      workflow_name: 'script-uv-test',
      conversation_id: 'conv-script-uv',
      user_message: 'uv test message',
    });

    const scriptNode: ScriptNode = {
      id: 'inline-uv',
      script: 'print("hello from python")',
      runtime: 'uv',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script-uv',
      testDir,
      { name: 'script-inline-uv-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('named bun script executes from .archon/scripts/', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-named-run-id', {
      workflow_name: 'script-named-test',
      conversation_id: 'conv-named',
      user_message: 'named test',
    });

    // Create a named script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'greet.ts'), 'console.log("named script output")');

    const scriptNode: ScriptNode = {
      id: 'run-greet',
      script: 'greet',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-named',
      testDir,
      { name: 'named-script-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-fail-run-id', {
      workflow_name: 'script-fail-test',
      conversation_id: 'conv-fail',
      user_message: 'fail test',
    });

    const scriptNode: ScriptNode = {
      id: 'fail-script',
      script: 'process.exit(1)',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-fail',
      testDir,
      { name: 'script-fail-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
    expect(failMsg).toBeDefined();
  });

  // Skipped on Windows (WO-HARNESS-DAG-EXECUTOR-TEST-LINE-6627-01, 2026-05-16):
  // npm-installed bun resolves to `bun.cmd` on Windows; Node's execFile invokes
  // the cmd shim which mangles or truncates multi-KB `-e <script>` arguments,
  // so Bun exits 0 with no stdout/stderr instead of failing on the deliberate
  // parse error. The production runtime is Linux containers where `bun` is a
  // single binary executed directly, so this test is correct for prod but
  // platform-fragile on Windows dev machines. Follow-up: rewrite using a named
  // script fixture (writeFile to .archon/scripts/) instead of inline `-e`, or
  // resolve bun.exe absolute path explicitly. See bdc-xo follow-up WO.
  it.skipIf(isWindows)(
    'failure message strips the "Command failed: bun -e <body>" prefix and stays small',
    async () => {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('script-1389-run-id', {
        workflow_name: 'script-1389',
        conversation_id: 'conv-1389s',
        user_message: 'test',
      });

      // 200 x 16 chars ~= 3.2 KB -- larger than SUBPROCESS_ERROR_MAX_CHARS (2 KB),
      // so any leak of the script body via err.message would violate the length
      // assertion below. Bun's stderr echoes only a few lines of context.
      const paddingAboveMax = '// padding line '.repeat(200);
      const scriptNode: ScriptNode = {
        id: 'fail-script-1389',
        script: `${paddingAboveMax}\nconst x = "marker"; this is not valid javascript`,
        runtime: 'bun',
      };

      await executeDagWorkflow(
        mockDeps,
        platform,
        'conv-1389s',
        testDir,
        { name: 'script-1389', nodes: [scriptNode] },
        workflowRun,
        'claude',
        undefined,
        join(testDir, 'artifacts'),
        join(testDir, 'logs'),
        'main',
        'docs/',
        minimalConfig
      );

      const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
      const failedEvent = eventCalls.find(
        (call: unknown[]) =>
          (call[0] as { event_type: string }).event_type === 'node_failed' &&
          (call[0] as { step_name: string }).step_name === 'fail-script-1389'
      );
      expect(failedEvent).toBeDefined();
      const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
      expect(errorMsg).toContain("Script node 'fail-script-1389' failed");
      expect(errorMsg).not.toContain('Command failed:');
      expect(errorMsg).not.toContain('padding line padding line padding line');
      // 2 KB diagnostic cap + label prefix + truncation marker should stay under
      // 2.1 KB. Bumping SUBPROCESS_ERROR_MAX_CHARS would trip this.
      expect(errorMsg.length).toBeLessThan(2100);
      // Bun emits `error: <description>\n    at [eval]:L:C` for parse failures --
      // the location marker is the strongest signal that the diagnostic survived.
      expect(errorMsg).toContain('[eval]');
    }
  );

  it('timeout kills subprocess', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-timeout-run-id', {
      workflow_name: 'script-timeout-test',
      conversation_id: 'conv-timeout',
      user_message: 'timeout test',
    });

    const scriptNode: ScriptNode = {
      id: 'slow-script',
      // Bun inline script that sleeps longer than the timeout
      script: 'await new Promise(r => setTimeout(r, 30000))',
      runtime: 'bun',
      timeout: 500,
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-timeout',
      testDir,
      { name: 'script-timeout-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    // Workflow fails because the only node failed (timeout)
    const failMsg = messages.find((m: string) => m.includes('no successful nodes'));
    expect(failMsg).toBeDefined();
  }, 10000);

  it('stderr output is sent to the user', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-stderr-run-id', {
      workflow_name: 'script-stderr-test',
      conversation_id: 'conv-stderr',
      user_message: 'stderr test',
    });

    const scriptNode: ScriptNode = {
      id: 'stderr-script',
      // Write to both stderr and stdout
      script: 'process.stderr.write("error detail\\n"); console.log("done")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-stderr',
      testDir,
      { name: 'script-stderr-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const stderrMsg = messages.find((m: string) => m.includes('error detail'));
    expect(stderrMsg).toBeDefined();
    expect(stderrMsg).toContain('stderr-script');
  });

  it('$WORKFLOW_ID and $ARTIFACTS_DIR are substituted into script text', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('wf-subst-run-id', {
      workflow_name: 'script-subst-test',
      conversation_id: 'conv-subst',
      user_message: 'subst test',
    });

    const artifactsDir = join(testDir, 'artifacts');

    // Write a downstream command so we can inspect the substituted prompt
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'check-output.md'), 'Got: $script-out.output');

    const nodes: DagNode[] = [
      {
        id: 'script-out',
        // Print the run ID and artifacts dir -- after substitution these are real values
        script: 'console.log("id=$WORKFLOW_ID artifacts=$ARTIFACTS_DIR")',
        runtime: 'bun',
      },
      { id: 'check', command: 'check-output', depends_on: ['script-out'] },
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-subst',
      testDir,
      { name: 'script-subst-vars', nodes },
      workflowRun,
      'claude',
      undefined,
      artifactsDir,
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The downstream AI node should have received the substituted output
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    // The script output should contain the actual run ID (not the literal variable name)
    expect(prompt).toContain('wf-subst-run-id');
    expect(prompt).not.toContain('$WORKFLOW_ID');
  });

  it('named script not found at runtime results in failed state and platform message', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-notfound-run-id', {
      workflow_name: 'script-notfound-test',
      conversation_id: 'conv-notfound',
      user_message: 'notfound test',
    });

    // Do NOT create .archon/scripts/missing.ts -- the script should fail to resolve
    const scriptNode: ScriptNode = {
      id: 'gone-script',
      script: 'missing',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-notfound',
      testDir,
      { name: 'script-notfound-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const notFoundMsg = messages.find((m: string) => m.includes('not found in .archon/scripts/'));
    expect(notFoundMsg).toBeDefined();
  });

  it('bun script node does not leak repo .env from execution cwd (#1135)', async () => {
    // Regression test: place a .env with a marker in the execution cwd.
    // The bun script must NOT see it because --no-env-file is passed.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('env-leak-run-id', {
      workflow_name: 'env-leak-test',
      conversation_id: 'conv-env-leak',
      user_message: 'env leak test',
    });

    // Write a .env with a marker in the script execution cwd
    await writeFile(join(testDir, '.env'), 'LEAKED_REPO_SECRET=should_not_appear\n');

    const scriptNode: ScriptNode = {
      id: 'env-check',
      script: 'console.log(process.env.LEAKED_REPO_SECRET ?? "CLEAN")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-env-leak',
      testDir,
      { name: 'env-leak-test', nodes: [scriptNode] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // The node output should be "CLEAN" -- the repo .env was not loaded
    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'env-check'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'CLEAN'
    );
  });

  it('passes config.envVars to script subprocesses', async () => {
    const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-env-run-id');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-script-env',
      testDir,
      {
        name: 'script-env-test',
        nodes: [{ id: 'inline-bun', script: 'console.log("ok")', runtime: 'bun' }],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } }
    );

    expect(execSpy).toHaveBeenCalledWith(
      'bun',
      ['--no-env-file', '-e', 'console.log("ok")'],
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
      })
    );
    execSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// MCP plugin-noise filtering helpers
// ---------------------------------------------------------------------------

describe('parseMcpFailureServerNames', () => {
  it('extracts entries (name + segment) from a well-formed message', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    const entries = parseMcpFailureServerNames(
      'MCP server connection failed: telegram (disconnected), github (timeout)'
    );
    expect(entries).toEqual([
      { name: 'telegram', segment: 'telegram (disconnected)' },
      { name: 'github', segment: 'github (timeout)' },
    ]);
  });

  it('returns empty array for unrelated messages', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('! Something else')).toEqual([]);
    expect(parseMcpFailureServerNames('')).toEqual([]);
  });

  it('deduplicates repeated entries (first segment wins)', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    const entries = parseMcpFailureServerNames(
      'MCP server connection failed: foo (a), foo (b), bar (c)'
    );
    expect(entries).toEqual([
      { name: 'foo', segment: 'foo (a)' },
      { name: 'bar', segment: 'bar (c)' },
    ]);
  });

  it('handles a single entry without status parens gracefully', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('MCP server connection failed: solo')).toEqual([
      { name: 'solo', segment: 'solo' },
    ]);
  });

  it('drops empty segments from trailing/leading commas', async () => {
    const { parseMcpFailureServerNames } = await import('./dag-executor');
    expect(parseMcpFailureServerNames('MCP server connection failed: a (x), , b (y)')).toEqual([
      { name: 'a', segment: 'a (x)' },
      { name: 'b', segment: 'b (y)' },
    ]);
  });
});

describe('loadConfiguredMcpServerNames', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcp-names-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns empty set when nodeMcpPath is undefined', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const names = await loadConfiguredMcpServerNames(undefined, testDir);
    expect(names.size).toBe(0);
  });

  it('returns server names for a valid JSON config (relative path)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(
      join(testDir, 'mcp.json'),
      JSON.stringify({ foo: { command: 'x' }, bar: { command: 'y' } })
    );
    const names = await loadConfiguredMcpServerNames('mcp.json', testDir);
    expect([...names].sort()).toEqual(['bar', 'foo']);
  });

  it('returns server names for an absolute path', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const absolutePath = join(testDir, 'abs.json');
    await writeFile(absolutePath, JSON.stringify({ baz: {} }));
    const names = await loadConfiguredMcpServerNames(absolutePath, '/nonexistent/cwd');
    expect([...names]).toEqual(['baz']);
  });

  it('returns empty set when file is missing (no crash)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    const names = await loadConfiguredMcpServerNames('missing.json', testDir);
    expect(names.size).toBe(0);
  });

  it('returns empty set for invalid JSON (provider surfaces its own error)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(join(testDir, 'broken.json'), '{ not-json');
    const names = await loadConfiguredMcpServerNames('broken.json', testDir);
    expect(names.size).toBe(0);
  });

  it('returns empty set when JSON is an array (not an object of servers)', async () => {
    const { loadConfiguredMcpServerNames } = await import('./dag-executor');
    await writeFile(join(testDir, 'arr.json'), '["foo","bar"]');
    const names = await loadConfiguredMcpServerNames('arr.json', testDir);
    expect(names.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// MCP plugin-noise filtering -- end-to-end through executeDagWorkflow
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- MCP failure filtering', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mcp-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'cmd prompt');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  async function runWithSystemChunk(
    systemContent: string,
    nodeMcpPath?: string
  ): Promise<IWorkflowPlatform> {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'system', content: systemContent };
      yield { type: 'assistant', content: 'ok' };
      yield { type: 'result', sessionId: 'sess' };
    });

    const platform = createMockPlatform();
    await executeDagWorkflow(
      createMockDeps(),
      platform,
      'conv-mcp-filter',
      testDir,
      {
        name: 'mcp-filter-test',
        nodes: [{ id: 'review', command: 'my-cmd', ...(nodeMcpPath ? { mcp: nodeMcpPath } : {}) }],
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
    return platform;
  }

  function mcpMessages(platform: IWorkflowPlatform): string[] {
    const calls = (platform.sendMessage as Mock<typeof platform.sendMessage>).mock.calls;
    return calls
      .map(c => c[1] as string)
      .filter(m => m.startsWith('MCP server connection failed:') || m.startsWith('!'));
  }

  it('forwards only workflow-configured failures and preserves status detail', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithSystemChunk(
      'MCP server connection failed: workflow-server (timeout), telegram (disconnected)',
      'mcp.json'
    );

    const sent = mcpMessages(platform);
    expect(sent).toEqual(['MCP server connection failed: workflow-server (timeout)']);
  });

  it('suppresses MCP message entirely when all failures are user plugins', async () => {
    await writeFile(join(testDir, 'mcp.json'), JSON.stringify({ 'workflow-server': {} }));
    const platform = await runWithSystemChunk(
      'MCP server connection failed: telegram (disconnected), notion (timeout)',
      'mcp.json'
    );

    expect(mcpMessages(platform)).toEqual([]);
  });

  it('suppresses everything when node has no mcp: config (all failures are plugin noise)', async () => {
    const platform = await runWithSystemChunk(
      'MCP server connection failed: telegram (disconnected)'
    );

    expect(mcpMessages(platform)).toEqual([]);
  });

  it('forwards ! provider warnings verbatim', async () => {
    const platform = await runWithSystemChunk('! Haiku does not support MCP');

    expect(mcpMessages(platform)).toEqual(['! Haiku does not support MCP']);
  });

  it('forwards [CODEX FAILBACK] system chunks and appends to node output text', async () => {
    const failbackContent =
      '[CODEX FAILBACK] Codex unavailable after retries. Review delegated to claude';
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'system', content: failbackContent };
      yield { type: 'assistant', content: 'claude-review-result' };
      yield { type: 'result', sessionId: 'failback-sess' };
    });
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();
    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-failback',
      testDir,
      { name: 'failback-test', nodes: [{ id: 'step1', command: 'my-cmd' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );
    // 1. Forwarded to platform stream
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    expect(sentMessages.some((m: string) => m === failbackContent)).toBe(true);
    // 2. Also in node output text (node_completed event data)
    const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completed = eventCalls.find(
      (c: unknown[]) => (c[0] as Record<string, string>).event_type === 'node_completed'
    );
    expect(completed).toBeDefined();
    const nodeOutput = (completed![0] as Record<string, Record<string, string>>).data.node_output;
    expect(nodeOutput).toContain(failbackContent);
  });

  it('forwards [WARNING] system chunks to platform but does not add to node output text', async () => {
    const warnContent = '[WARNING] Could not resume previous session. Starting fresh conversation.';
    const platform = await runWithSystemChunk(warnContent);
    // Forwarded to platform stream
    const sentMessages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
      (c: unknown[]) => c[1] as string
    );
    expect(sentMessages.some((m: string) => m === warnContent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Streaming cancel-check policy (during-streaming paused tolerance)
// ---------------------------------------------------------------------------

describe('shouldContinueStreamingForStatus', () => {
  it('continues when status is running', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('running')).toBe(true);
  });

  it('continues when status is paused (sibling approval node in same layer)', async () => {
    // The key invariant: a concurrent approval node can pause the run while a
    // streaming AI node is mid-response. The streaming node must finish its
    // own output -- workflow progression is gated by the approval node, not
    // by tearing down unrelated in-flight streams.
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('paused')).toBe(true);
  });

  it('aborts when status is null (run deleted)', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus(null)).toBe(false);
  });

  it('aborts when status is cancelled', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('cancelled')).toBe(false);
  });

  it('aborts when status is failed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('failed')).toBe(false);
  });

  it('aborts when status is completed', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('completed')).toBe(false);
  });

  it('aborts on any unrecognized state', async () => {
    const { shouldContinueStreamingForStatus } = await import('./dag-executor');
    expect(shouldContinueStreamingForStatus('pending')).toBe(false);
    expect(shouldContinueStreamingForStatus('invalid-status')).toBe(false);
  });
});

describe('executeDagWorkflow -- final status derivation', () => {
  // Invariant: if ANY non-skipped node has failed status, the run must be
  // marked 'failed' -- never 'completed' -- regardless of how many other nodes
  // succeeded. This covers the anyFailed branch in executeDagWorkflow
  // (dag-executor.ts ~line 2956), which had no direct test coverage.
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('one success + one independent failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-1');

    const nodes: DagNode[] = [
      { id: 'pass', bash: 'echo ok' } as BashNode,
      { id: 'fail', bash: 'exit 1' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail')
    );

    // Confirm the failure message names the failing node
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('completed with failures'));
    expect(failMsg).toBeDefined();
  });

  it('multiple successes + one failure -> failWorkflowRun, not completeWorkflowRun', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-2');

    const nodes: DagNode[] = [
      { id: 'a', bash: 'echo a' } as BashNode,
      { id: 'b', bash: 'echo b' } as BashNode,
      { id: 'c', bash: 'echo c' } as BashNode,
      { id: 'fail', bash: 'exit 1' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test-multi', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fail')
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const failMsg = messages.find((m: string) => m.includes('completed with failures'));
    expect(failMsg).toBeDefined();
  });

  it('trigger_rule: none_failed skips dependent node + anyFailed still marks run failed', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('dag-status-run-3');

    // Layer 1: A and B run in parallel. B fails.
    // Layer 2: C depends on B with trigger_rule: none_failed -- so C is skipped.
    // Expected: anyFailed=true (from B), so run must be marked failed even though C is only skipped.
    const nodes: DagNode[] = [
      { id: 'a', bash: 'echo a' } as BashNode,
      { id: 'b', bash: 'exit 1' } as BashNode,
      { id: 'c', bash: 'echo c', depends_on: ['b'], trigger_rule: 'none_failed' } as BashNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-status',
      testDir,
      { name: 'status-test-skip', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect((mockStore.failWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((mockStore.completeWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(mockStore.failWorkflowRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('b')
    );
  });
});

// ---------------------------------------------------------------------------
// Agent persona dispatch tests
// Verify that executeDagWorkflow resolves agent: fields to persona model +
// allowed_tools, and that nodes without agent: continue using current behavior.
// ---------------------------------------------------------------------------

describe('agent persona dispatch', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `agent-dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'agents'), { recursive: true });
    await mkdir(join(testDir, 'artifacts'), { recursive: true });
    await mkdir(join(testDir, 'logs'), { recursive: true });
    clearAgentRegistryCache();
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    clearAgentRegistryCache();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function writeAgentFile(name: string, model: string, tools?: string[]): Promise<void> {
    const toolsLine = tools ? `tools: [${tools.join(', ')}]` : '';
    const content = `---\nname: ${name}\nmodel: ${model}\n${toolsLine}\n---\n\nYou are the ${name} agent.\n`;
    await writeFile(join(testDir, '.archon', 'agents', `${name}.md`), content, 'utf-8');
  }

  it('prompt node with agent: applies persona allowed_tools to nodeConfig', async () => {
    await writeAgentFile('read-only-test-agent', 'sonnet', ['Read', 'Grep']);

    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('agent-persona-run-1');

    const nodes: DagNode[] = [
      { id: 'plan', agent: 'read-only-test-agent', prompt: 'Plan the work.' } as unknown as DagNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-agent',
      testDir,
      { name: 'agent-persona-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    expect(nodeConfig.allowed_tools).toEqual(['Read', 'Grep']);
  });

  it('prompt node with agent: and model: mismatch -- persona model wins', async () => {
    await writeAgentFile('sonnet-test-agent', 'sonnet');

    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('agent-persona-run-2');

    // Node declares model: opus but agent persona is sonnet -- persona should win
    const nodes: DagNode[] = [
      {
        id: 'plan',
        agent: 'sonnet-test-agent',
        model: 'opus',
        prompt: 'Plan.',
      } as unknown as DagNode,
    ];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-agent',
      testDir,
      { name: 'mismatch-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    // Persona model (sonnet) wins over node model (opus)
    expect(optionsArg.model).toBe('sonnet');
  });

  it('backward compat: node without agent: does not inject persona allowed_tools', async () => {
    const mockStore = createMockStore();
    const mockDeps = createMockDeps(mockStore);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('agent-persona-run-3');

    // No agent: field -- uses current behavior (no persona tool restriction)
    const nodes: DagNode[] = [{ id: 'step', prompt: 'Do the thing.' } as DagNode];

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-agent',
      testDir,
      { name: 'backward-compat-test', nodes },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    const nodeConfig = optionsArg.nodeConfig as Record<string, unknown>;
    // No agent = no persona-injected allowed_tools
    expect(nodeConfig.allowed_tools).toBeUndefined();
  });
});

// T3: approve_with_fix routing tests
// These tests verify the condition-evaluator correctly routes the APPROVE-WITH-FIX branch.
// They use the real evaluator (not mocked) so they prove the actual DAG routing logic.
import { evaluateCondition } from './condition-evaluator';

it('approve_with_fix routes into apply-suggested-fix; approve_as_is does not', () => {
  const withFix = new Map<string, NodeOutput>([
    [
      'pause-gate',
      {
        state: 'completed',
        output: JSON.stringify({
          decision_verb: 'approve_with_fix',
          authorized_fix_ids: ['locg-migration'],
        }),
      },
    ],
  ]);
  expect(
    evaluateCondition("$pause-gate.output.decision_verb == 'approve_with_fix'", withFix).result
  ).toBe(true);

  const asIs = new Map<string, NodeOutput>([
    [
      'pause-gate',
      { state: 'completed', output: JSON.stringify({ decision_verb: 'approve_as_is' }) },
    ],
  ]);
  expect(
    evaluateCondition("$pause-gate.output.decision_verb == 'approve_with_fix'", asIs).result
  ).toBe(false);
});

// T4: classify-apply-review routing tests
// Verify decide-push-target's compound when: works correctly for all cases.
// The condition is: $pause-gate.output.decision_verb != 'approve_with_fix'
//                  || $classify-apply-review.output.verdict == 'satisfied'
it('classify-apply-review routes decide-push-target correctly for all gate outcomes', () => {
  const decidePushCond =
    "$pause-gate.output.decision_verb != 'approve_with_fix' || $classify-apply-review.output.verdict == 'satisfied'";

  // Non-interactive auto-proceed: pause-gate output is '' (executor returns {output:''})
  // decision_verb resolves to '' (JSON.parse('') throws -> '') -> '' != 'approve_with_fix' = TRUE
  const nonInteractive = new Map<string, NodeOutput>([
    ['pause-gate', { state: 'completed', output: '' }],
    ['classify-apply-review', { state: 'skipped', output: '' }],
  ]);
  expect(evaluateCondition(decidePushCond, nonInteractive).result).toBe(true);

  // APPROVE-AS-IS: decision_verb == 'approve_as_is' != 'approve_with_fix' -> TRUE
  const approveAsIs = new Map<string, NodeOutput>([
    [
      'pause-gate',
      { state: 'completed', output: JSON.stringify({ decision_verb: 'approve_as_is' }) },
    ],
    ['classify-apply-review', { state: 'skipped', output: '' }],
  ]);
  expect(evaluateCondition(decidePushCond, approveAsIs).result).toBe(true);

  // APPROVE-WITH-FIX + satisfied: first clause FALSE, second TRUE -> TRUE (push)
  const approveWithFixSatisfied = new Map<string, NodeOutput>([
    [
      'pause-gate',
      {
        state: 'completed',
        output: JSON.stringify({
          decision_verb: 'approve_with_fix',
          authorized_fix_ids: ['locg-migration'],
        }),
      },
    ],
    ['classify-apply-review', { state: 'completed', output: '{"verdict":"satisfied"}' }],
  ]);
  expect(evaluateCondition(decidePushCond, approveWithFixSatisfied).result).toBe(true);

  // APPROVE-WITH-FIX + needs_revision: both clauses FALSE -> FALSE (no push)
  const approveWithFixFailed = new Map<string, NodeOutput>([
    [
      'pause-gate',
      {
        state: 'completed',
        output: JSON.stringify({
          decision_verb: 'approve_with_fix',
          authorized_fix_ids: ['locg-migration'],
        }),
      },
    ],
    ['classify-apply-review', { state: 'completed', output: '{"verdict":"needs_revision"}' }],
  ]);
  expect(evaluateCondition(decidePushCond, approveWithFixFailed).result).toBe(false);

  // APPROVE-WITH-FIX + classify-apply-review missing sentinel (empty -> 'needs_revision' default)
  // Classifier emits '{"verdict":"needs_revision"}' when sentinel absent -> no push
  const approveWithFixMissing = new Map<string, NodeOutput>([
    [
      'pause-gate',
      {
        state: 'completed',
        output: JSON.stringify({ decision_verb: 'approve_with_fix', authorized_fix_ids: [] }),
      },
    ],
    // Classifier output missing verdict field -> JSON.parse succeeds but verdict='' -> '' != 'satisfied' = FALSE
    ['classify-apply-review', { state: 'completed', output: '{"verdict":"needs_revision"}' }],
  ]);
  expect(evaluateCondition(decidePushCond, approveWithFixMissing).result).toBe(false);
});

// T5: commit-and-push when: condition tests
// Verifies the four paths through the widened when: clause:
//   "$block-reclassify.output.status == 'PROCEED' || $classify-apply-review.output.verdict == 'satisfied'"
it('commit-and-push when: evaluates correctly for all paths', () => {
  const commitCond =
    "$block-reclassify.output.status == 'PROCEED' || $classify-apply-review.output.verdict == 'satisfied'";

  // Path 1: PROCEED run (classify-apply-review skipped -> output '' -> verdict '' != 'satisfied' = FALSE)
  // First clause PROCEED == PROCEED = TRUE -> overall TRUE
  const proceedRun = new Map<string, NodeOutput>([
    ['block-reclassify', { state: 'completed', output: '{"status":"PROCEED"}' }],
    ['classify-apply-review', { state: 'skipped', output: '' }],
  ]);
  expect(evaluateCondition(commitCond, proceedRun).result).toBe(true);

  // Path 2: approve_with_fix + verdict satisfied
  // First clause BLOCKED != PROCEED = FALSE; second clause 'satisfied' == 'satisfied' = TRUE -> overall TRUE
  const approveWithFixSatisfied = new Map<string, NodeOutput>([
    ['block-reclassify', { state: 'completed', output: '{"status":"BLOCKED"}' }],
    ['classify-apply-review', { state: 'completed', output: '{"verdict":"satisfied"}' }],
  ]);
  expect(evaluateCondition(commitCond, approveWithFixSatisfied).result).toBe(true);

  // Path 3: approve_with_fix + verdict needs_revision -> BLOCKED commit must NOT happen
  // First clause FALSE, second clause FALSE -> overall FALSE
  const approveWithFixNeedsRevision = new Map<string, NodeOutput>([
    ['block-reclassify', { state: 'completed', output: '{"status":"BLOCKED"}' }],
    ['classify-apply-review', { state: 'completed', output: '{"verdict":"needs_revision"}' }],
  ]);
  expect(evaluateCondition(commitCond, approveWithFixNeedsRevision).result).toBe(false);

  // Path 4: plain BLOCKED with no approve-with-fix (classify skipped -> verdict '' -> FALSE)
  // First clause FALSE, second clause '' == 'satisfied' = FALSE -> overall FALSE
  const plainBlocked = new Map<string, NodeOutput>([
    ['block-reclassify', { state: 'completed', output: '{"status":"BLOCKED"}' }],
    ['classify-apply-review', { state: 'skipped', output: '' }],
  ]);
  expect(evaluateCondition(commitCond, plainBlocked).result).toBe(false);
});

// ---------------------------------------------------------------------------
// Layer 1 served-model capture on node_completed.data
// WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01
// ---------------------------------------------------------------------------
//
// T4 (mismatch): a node requests model X, the provider yields a result chunk
//   carrying a different servedModelId Y -> node_completed.data carries
//   requested_model_id=X, served_model_id=Y, served_model_mismatch=true.
//   This is the GLM-never-ran guard working: the integrity flag has real data.
//
// T5 (null provider, per spec): a provider that does NOT expose served model
//   (e.g. Codex) yields servedModelId=null + servedModelMissingReason.
//   node_completed.data carries served_model_id=null and the reason string,
//   served_model_mismatch is OMITTED (a null served has no meaningful
//   mismatch signal). No crash. No fabricated value.
describe('executeDagWorkflow -- served-model capture on node_completed.data', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-served-model-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    // Restore default claude client so other test files are unaffected.
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  /** Pull the (single) node_completed event payload from a mocked store. */
  function getNodeCompletedData(store: IWorkflowStore): Record<string, unknown> {
    const calls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; data?: Record<string, unknown> }]
    >;
    const completedCalls = calls.filter(([arg]) => arg.event_type === 'node_completed');
    expect(completedCalls.length).toBe(1);
    const data = completedCalls[0][0].data;
    expect(data).toBeDefined();
    return data as Record<string, unknown>;
  }

  it('T4: served != requested -> served_model_mismatch=true on node_completed.data', async () => {
    // Mock provider yields a result chunk that reports a DIFFERENT served
    // model than the node asked for. Mimics an OpenRouter routing decision
    // (requested z-ai/glm-5.2, served z-ai/glm-5.2-20260616) or an SDK
    // silent-fallback (requested sonnet, served haiku).
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'x' };
      yield {
        type: 'result',
        sessionId: 'mismatch-session',
        servedModelId: 'other-model-actually-served',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('served-mismatch-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-mismatch',
      testDir,
      {
        name: 'served-mismatch-test',
        // PromptNode (no command file needed). model set at the node level so
        // it flows into nodeOptions.model via effectiveModel.
        nodes: [
          {
            id: 'work',
            prompt: 'do work',
            model: 'my-requested-model',
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    expect(data.requested_model_id).toBe('my-requested-model');
    expect(data.served_model_id).toBe('other-model-actually-served');
    expect(data.served_model_mismatch).toBe(true);
    // missing_reason must be absent on the happy path -- only present when
    // the provider could not tell us.
    expect(data).not.toHaveProperty('served_model_missing_reason');
  });

  it('T4 (match path): served == requested -> served_model_mismatch=false', async () => {
    // Same shape as T4 but the provider honored the request. Locks in that
    // the boolean really is computed from the comparison, not a constant.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'x' };
      yield {
        type: 'result',
        sessionId: 'match-session',
        servedModelId: 'my-requested-model',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('served-match-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-match',
      testDir,
      {
        name: 'served-match-test',
        nodes: [
          {
            id: 'work',
            prompt: 'do work',
            model: 'my-requested-model',
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    expect(data.requested_model_id).toBe('my-requested-model');
    expect(data.served_model_id).toBe('my-requested-model');
    expect(data.served_model_mismatch).toBe(false);
  });

  it('T5: provider yields servedModelId=null with reason -> no crash, mismatch omitted', async () => {
    // Mimics the Codex provider's contract: the SDK does not expose a
    // served-model field, so the provider emits explicit null + a
    // machine-readable reason. The dag-executor must persist both verbatim
    // and OMIT served_model_mismatch (null has no meaningful comparison).
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'x' };
      yield {
        type: 'result',
        sessionId: 'null-session',
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('served-null-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-null',
      testDir,
      {
        name: 'served-null-test',
        nodes: [
          {
            id: 'work',
            prompt: 'do work',
            model: 'my-requested-model',
          },
        ],
      },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    expect(data.requested_model_id).toBe('my-requested-model');
    // null is preserved -- no fabricated value, no coercion to undefined.
    expect(data.served_model_id).toBeNull();
    expect(data.served_model_missing_reason).toBe('codex_sdk_does_not_expose_served_model');
    // served_model_mismatch is omitted when served is null (no signal).
    expect(data).not.toHaveProperty('served_model_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Layer 1 tier + counterfactual cost on node_completed.data + run metadata
// WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01
// ---------------------------------------------------------------------------
//
// T1: a node records an entry_rung label derived from provider:model.
// T2: a node records frontier_cost_usd = tokens.input * INPUT_RATE +
//     tokens.output * OUTPUT_RATE (exact arithmetic against published Opus-4 rates).
// T3: run metadata carries both total_cost_usd and total_frontier_cost_usd so the
//     UI can compute savings = total_frontier_cost_usd - total_cost_usd.
// T4: existing cost_usd and tokens fields are present and unchanged in shape
//     (backward compatibility on the data contract).
describe('executeDagWorkflow -- tier/entry_rung + frontier_cost_usd', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-tier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  // Redefined locally -- the same-named helper inside the served-model describe
  // block above is scoped to that block and not reachable from here.
  function getNodeCompletedData(store: IWorkflowStore): Record<string, unknown> {
    const calls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; data?: Record<string, unknown> }]
    >;
    const completedCalls = calls.filter(([arg]) => arg.event_type === 'node_completed');
    expect(completedCalls.length).toBe(1);
    const data = completedCalls[0][0].data;
    expect(data).toBeDefined();
    return data as Record<string, unknown>;
  }

  it('T1: node_completed carries entry_rung derived from provider:model', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield { type: 'result', sessionId: 's1' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t1-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t1',
      testDir,
      { name: 't1', nodes: [{ id: 'n', prompt: 'p', model: 'claude-opus-4-7' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    // Format: "<provider>:<effective-model>" -- the workflow provider is 'claude'
    // and the per-node model override flows through nodeOptions.model.
    expect(data.entry_rung).toBe('claude:claude-opus-4-7');
  });

  it('T2: frontier_cost_usd == tokens.input * INPUT_RATE + tokens.output * OUTPUT_RATE', async () => {
    // Known token counts; published frontier rates (claude-opus-4-7):
    //   INPUT_RATE  = 0.000015 USD/token
    //   OUTPUT_RATE = 0.000075 USD/token
    // 1000 * 0.000015 + 200 * 0.000075 = 0.015 + 0.015 = 0.030
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield {
        type: 'result',
        sessionId: 's2',
        tokens: { input: 1000, output: 200, total: 1200 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t2-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t2',
      testDir,
      { name: 't2', nodes: [{ id: 'n', prompt: 'p' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    expect(typeof data.frontier_cost_usd).toBe('number');
    expect(data.frontier_cost_usd as number).toBeCloseTo(0.03, 10);
  });

  it('T3: run metadata carries both total_cost_usd and total_frontier_cost_usd', async () => {
    // Provider yields BOTH cost and tokens so both run totals are populated
    // and the UI can compute savings = total_frontier_cost_usd - total_cost_usd.
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield {
        type: 'result',
        sessionId: 's3',
        cost: 0.001,
        tokens: { input: 500, output: 100, total: 600 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t3-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t3',
      testDir,
      { name: 't3', nodes: [{ id: 'n', prompt: 'p' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const completeCalls = (store.completeWorkflowRun as ReturnType<typeof mock>).mock
      .calls as Array<[string, Record<string, unknown>?]>;
    expect(completeCalls.length).toBeGreaterThan(0);
    const meta = completeCalls[completeCalls.length - 1][1] ?? {};
    // T3 asserts both fields are present so UI can compute savings.
    expect(meta).toHaveProperty('total_cost_usd');
    expect(meta).toHaveProperty('total_frontier_cost_usd');
    // And both are positive numbers (sanity, not exact math here -- T2 owns math).
    expect(typeof meta.total_cost_usd).toBe('number');
    expect(typeof meta.total_frontier_cost_usd).toBe('number');
    expect(meta.total_frontier_cost_usd as number).toBeGreaterThan(0);
  });

  it('T4: backward compat -- existing cost_usd and tokens fields unchanged in shape', async () => {
    mockSendQueryDag.mockImplementation(function* () {
      yield { type: 'assistant', content: 'done' };
      yield {
        type: 'result',
        sessionId: 's4',
        cost: 0.005,
        tokens: { input: 100, output: 50, total: 150 },
      };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('t4-run');

    await executeDagWorkflow(
      mockDeps,
      platform,
      'conv-t4',
      testDir,
      { name: 't4', nodes: [{ id: 'n', prompt: 'p' }] },
      workflowRun,
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const data = getNodeCompletedData(store);
    // Pre-existing cost_usd field MUST still be present (additive change only).
    expect(data).toHaveProperty('cost_usd');
    expect(data.cost_usd).toBe(0.005);
    // Pre-existing tokens field MUST still carry the same shape.
    expect(data.tokens).toBeDefined();
    const tokens = data.tokens as { input: number; output: number; total?: number };
    expect(tokens.input).toBe(100);
    expect(tokens.output).toBe(50);
    expect(tokens.total).toBe(150);
  });
});
