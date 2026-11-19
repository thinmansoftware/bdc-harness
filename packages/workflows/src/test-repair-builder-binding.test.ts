// Amended WO-HARNESS-TEST-LOOP-BEFORE-EVIDENCE-GATE-01, Test 15.
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadAgentRegistry, resolveAgent, type AgentRegistry } from './agents/registry';
import { resolveModelForNode } from './model-override';
import { resolveAgentPersona } from './executor-shared';
import type { WorkflowDefinition } from './schemas';

const root = join(import.meta.dir, '../../..');
const defaults = join(root, '.archon/workflows/defaults');
const lanes = readdirSync(defaults)
  .filter(file => /^bdc-feature-development.*\.yaml$/.test(file))
  .sort();
let registry: AgentRegistry;

beforeAll(async () => {
  registry = await loadAgentRegistry(join(root, '.archon/agents'));
});

// Match the normal dag-executor path: resolve the node binding, apply a persona
// if present, then resolve again with that persona model. No override/failover.
function resolveNode(workflow: WorkflowDefinition, id: string) {
  const node = workflow.nodes.find(entry => entry.id === id);
  if (!node) throw new Error(`Missing ${id} in ${workflow.name}`);
  const input = {
    nodeId: node.id,
    nodeProvider: node.provider,
    nodeModel: node.model,
    workflowProvider: workflow.provider ?? 'claude',
    workflowModel: workflow.model,
  };
  const binding = resolveModelForNode(input);
  const name = node.agent ?? node.persona;
  if (!name) return binding;
  const persona = resolveAgent(name, registry);
  if (!persona) throw new Error(`Missing persona ${name}`);
  const applied = resolveAgentPersona(persona, binding.model, binding.provider);
  return resolveModelForNode({ ...input, personaModel: applied.model });
}

describe('test-repair keeps the builder binding without a persona', () => {
  test('covers every shipped feature lane', () => {
    expect(lanes).toHaveLength(13);
  });

  for (const file of lanes) {
    const workflow = parseYaml(readFileSync(join(defaults, file), 'utf8')) as WorkflowDefinition;
    test(`${file}: test-repair has no persona or agent`, () => {
      const repair = workflow.nodes.find(node => node.id === 'test-repair');
      expect(repair).toBeDefined();
      expect(repair).not.toHaveProperty('persona');
      expect(repair).not.toHaveProperty('agent');
    });

    test(`${file}: the real repair resolver retains the builder model`, () => {
      const binding = resolveNode(workflow, 'test-repair');
      const builderNode = workflow.nodes.find(node => node.id === 'diff-repair');
      if (!builderNode) throw new Error(`Missing diff-repair in ${file}`);
      const builder = resolveModelForNode({
        nodeId: builderNode.id,
        nodeProvider: builderNode.provider,
        nodeModel: builderNode.model,
        workflowProvider: workflow.provider ?? 'claude',
        workflowModel: workflow.model,
      });
      expect(binding).toEqual(builder);
      if (binding.provider === 'codex' || binding.provider === 'codex-native-strict') {
        expect(binding.model).toBeDefined();
        expect(binding.model).not.toBe('claude-sonnet-5-5');
        expect(binding.model).not.toMatch(/claude-|sonnet|opus|haiku/i);
      }
    });
  }

  test('overseer keeps the dev sonnet declaration', () => {
    expect(resolveAgent('overseer', registry)?.model).toBe('sonnet');
  });
});
