import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { registerCursorAgentProvider } from '../../providers/src/community/cursor/registration';
import { parseWorkflow } from './loader';
import { resolveModelForNode } from './model-override';
import { loadAgentFile } from './agents/registry';
import { resolveWorkflowProbeBindings } from './reliability/resolve-binding';
import type { WorkflowConfig } from './deps';
import type { WorkflowDefinition } from './schemas';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';

const root = join(import.meta.dir, '../../..');
const defaultsDir = join(root, '.archon/workflows/defaults');
const agentsDir = join(root, '.archon/agents');

const SEVEN_SEATS = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
] as const;

const FOUR_SEATS = [
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'apply-diff-review-final',
] as const;

const TERRA_LANES: ReadonlyArray<{ file: string; seats: readonly string[] }> = [
  { file: 'bdc-feature-development-codex.yaml', seats: SEVEN_SEATS },
  { file: 'bdc-feature-development-codex-only.yaml', seats: SEVEN_SEATS },
  { file: 'bdc-feature-development.yaml', seats: FOUR_SEATS },
  { file: 'bdc-feature-development-fable.yaml', seats: FOUR_SEATS },
];

const UNPINNED_MODELS = new Set(['', 'default', 'provider-default']);

const probeConfig: WorkflowConfig = {
  assistant: 'codex',
  commands: {},
  // No strict assistant model: only the YAML can supply the binding.
  assistants: { 'codex-native-strict': {} },
};

type WorkflowNode = WorkflowDefinition['nodes'][number];

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  clearRegistry();
  registerBuiltinProviders();
  registerCursorAgentProvider();
  registerCommunityProviders();
});
afterEach(clearRegistry);

function loadWorkflow(content: string, filename: string): WorkflowDefinition {
  const parsed = parseWorkflow(content, filename);
  if (!parsed.workflow) {
    throw new Error(`${filename} failed to load: ${parsed.error?.error}`);
  }
  return parsed.workflow;
}

function diskWorkflows(): WorkflowDefinition[] {
  return readdirSync(defaultsDir)
    .filter(filename => filename.endsWith('.yaml'))
    .sort()
    .map(filename => loadWorkflow(readFileSync(join(defaultsDir, filename), 'utf8'), filename));
}

function bundledWorkflows(): WorkflowDefinition[] {
  const workflows: WorkflowDefinition[] = [];
  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const parsed = parseWorkflow(content, `${name}.yaml`);
    if (parsed.workflow) workflows.push(parsed.workflow);
  }
  return workflows;
}

function effectiveProvider(workflow: WorkflowDefinition, node: WorkflowNode): string | undefined {
  return node.provider ?? workflow.provider;
}

async function resolveStrictBinding(
  workflow: WorkflowDefinition,
  node: WorkflowNode
): Promise<{ provider: string; model: string | undefined }> {
  const personaName = node.agent ?? node.persona;
  let personaModel: string | undefined;
  if (personaName) {
    const persona = await loadAgentFile(join(agentsDir, `${personaName}.md`));
    personaModel = persona.model;
  }
  return resolveModelForNode({
    nodeId: node.id,
    nodeProvider: node.provider,
    nodeModel: node.model,
    personaModel,
    workflowProvider: workflow.provider ?? '',
    workflowModel: workflow.model,
    assistantModels: { 'codex-native-strict': undefined },
  });
}

/** Shared by Tests 1 and 3. Returns node ids whose strict binding is missing or default. */
async function unpinnedStrictNodeIds(workflow: WorkflowDefinition): Promise<string[]> {
  const unpinned: string[] = [];
  for (const node of workflow.nodes) {
    if (effectiveProvider(workflow, node) !== 'codex-native-strict') continue;
    const binding = await resolveStrictBinding(workflow, node);
    if (binding.model === undefined || UNPINNED_MODELS.has(binding.model)) {
      unpinned.push(node.id);
    }
  }
  return unpinned;
}

function strictNodeCount(workflow: WorkflowDefinition): number {
  return workflow.nodes.filter(node => effectiveProvider(workflow, node) === 'codex-native-strict')
    .length;
}

describe('strict seat model pins', () => {
  test('every_strict_node_in_every_lane_has_explicit_model', async () => {
    const corpora: ReadonlyArray<readonly [string, WorkflowDefinition[]]> = [
      ['disk', diskWorkflows()],
      ['bundled', bundledWorkflows()],
    ];
    for (const [label, workflows] of corpora) {
      const unpinned: string[] = [];
      let strictCount = 0;
      for (const workflow of workflows) {
        strictCount += strictNodeCount(workflow);
        const ids = await unpinnedStrictNodeIds(workflow);
        for (const id of ids) unpinned.push(`${workflow.name}:${id}`);
      }
      expect(unpinned, label).toEqual([]);
      expect(strictCount, label).toBeGreaterThanOrEqual(29);
    }
  });

  test('codex_codex_only_default_fable_strict_seats_resolve_terra', async () => {
    for (const { file, seats } of TERRA_LANES) {
      const workflow = loadWorkflow(readFileSync(join(defaultsDir, file), 'utf8'), file);
      for (const id of seats) {
        const node = workflow.nodes.find(candidate => candidate.id === id);
        expect(node, `${file}:${id}`).toBeDefined();
        expect(effectiveProvider(workflow, node!), `${file}:${id}:provider`).toBe(
          'codex-native-strict'
        );
        const binding = await resolveStrictBinding(workflow, node!);
        expect(binding.provider, `${file}:${id}:provider`).toBe('codex-native-strict');
        expect(binding.model, `${file}:${id}:model`).toBe('gpt-5.6-terra');
      }
    }
  });

  test('guard_rejects_strict_node_without_model', async () => {
    const workflow = loadWorkflow(
      [
        'name: bare-strict-guard',
        'description: in-test fixture with one unpinned strict node',
        'provider: codex',
        'model: gpt-5.6-sol',
        'nodes:',
        '  - id: bare-strict',
        '    provider: codex-native-strict',
        '    prompt: bare',
        '',
      ].join('\n'),
      'bare-strict-guard.yaml'
    );
    expect(await unpinnedStrictNodeIds(workflow)).toEqual(['bare-strict']);
  });

  test('probe_bindings_for_codex_lanes_carry_no_default_model', () => {
    for (const file of [
      'bdc-feature-development-codex.yaml',
      'bdc-feature-development-codex-only.yaml',
    ]) {
      const workflow = loadWorkflow(readFileSync(join(defaultsDir, file), 'utf8'), file);
      const bindings = resolveWorkflowProbeBindings({
        workflow,
        workflowProvider: workflow.provider!,
        workflowModel: workflow.model,
        config: probeConfig,
      });
      const strict = bindings.filter(binding => binding.providerId === 'codex-native-strict');
      for (const binding of strict) {
        expect(binding.modelId, file).not.toBe('default');
        expect(binding.modelId, file).not.toBe('provider-default');
        expect(binding.modelId, file).not.toBe('');
        expect(binding.modelId, file).toBeDefined();
      }
      expect(
        strict.some(binding => binding.modelId === 'gpt-5.6-terra'),
        file
      ).toBe(true);
    }
  });

  test('builder_bindings_unchanged', () => {
    const lanes: ReadonlyArray<{
      file: string;
      provider: string;
      model: string;
      plan: { provider?: string; model?: string };
      implement: { provider?: string; model?: string };
    }> = [
      {
        file: 'bdc-feature-development-codex.yaml',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        plan: { provider: 'claude', model: 'sonnet' },
        implement: { provider: 'codex', model: 'gpt-5.6-sol' },
      },
      {
        file: 'bdc-feature-development-codex-only.yaml',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        plan: { provider: 'codex' },
        implement: { provider: 'codex', model: 'gpt-5.6-sol' },
      },
      {
        file: 'bdc-feature-development.yaml',
        provider: 'claude',
        model: 'sonnet',
        plan: {},
        implement: {},
      },
      {
        file: 'bdc-feature-development-fable.yaml',
        provider: 'claude',
        model: 'claude-fable-5',
        plan: {},
        implement: {},
      },
    ];

    for (const lane of lanes) {
      const workflow = loadWorkflow(readFileSync(join(defaultsDir, lane.file), 'utf8'), lane.file);
      expect([workflow.provider, workflow.model], lane.file).toEqual([lane.provider, lane.model]);
      for (const id of ['plan', 'implement'] as const) {
        const node = workflow.nodes.find(candidate => candidate.id === id);
        const expected = lane[id];
        expect(node, `${lane.file}:${id}`).toBeDefined();
        expect(node?.provider, `${lane.file}:${id}:provider`).toBe(expected.provider);
        expect(node?.model, `${lane.file}:${id}:model`).toBe(expected.model);
      }
    }
  });
});
