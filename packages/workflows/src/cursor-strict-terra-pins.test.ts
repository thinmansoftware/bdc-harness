import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import { registerCursorAgentProvider } from '../../providers/src/community/cursor/registration';
import { parseWorkflow } from './loader';
import { resolveModelForNode } from './model-override';
import { resolveAgentPersona } from './executor-shared';
import { loadAgentFile } from './agents/registry';
import { resolveWorkflowProbeBindings } from './reliability/resolve-binding';
import type { WorkflowConfig } from './deps';
import type { WorkflowDefinition } from './schemas';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';

const root = join(import.meta.dir, '../../..');
const filename = 'bdc-feature-development-cursor.yaml';
const strictIds = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
];
const promptIds = strictIds.slice(1);
const cursorIds = [
  'check-already-satisfied',
  'plan',
  'implement',
  'diff-repair',
  'opus-repair',
  'apply-suggested-fix',
];
const config: WorkflowConfig = {
  assistant: 'cursor',
  commands: {},
  // No strict assistant model: the YAML itself must supply the binding.
  assistants: { cursor: { model: 'grok-4.7-high' }, 'codex-native-strict': {} },
};

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  clearRegistry();
  registerBuiltinProviders();
  registerCursorAgentProvider();
});
afterEach(clearRegistry);

function source(): string {
  return readFileSync(join(root, '.archon/workflows/defaults', filename), 'utf8');
}

function workflow(): WorkflowDefinition {
  const parsed = parseWorkflow(source(), filename);
  if (!parsed.workflow)
    throw new Error(`actual Cursor YAML failed to load: ${parsed.error?.error}`);
  return parsed.workflow;
}

describe('Cursor strict Terra model selection', () => {
  test('actual YAML names exactly seven strict Terra review nodes including the loop', () => {
    const w = workflow();
    const strict = w.nodes.filter(node => node.provider === 'codex-native-strict');
    expect(strict.map(node => node.id)).toEqual(strictIds);
    for (const node of strict) {
      expect(node.model, node.id).toBe('gpt-5.6-terra');
      expect(node.failover_provider, node.id).toBeUndefined();
    }
    expect('loop' in strict[0]!).toBe(true);
  });

  test('real fire-time discovery resolves all six prompt cases with strict assistant model unset', () => {
    const w = workflow();
    const prompts = w.nodes.filter(
      node => node.provider === 'codex-native-strict' && ('prompt' in node || 'command' in node)
    );
    expect(prompts.map(node => node.id)).toEqual(promptIds);
    for (const node of prompts) {
      const bindings = resolveWorkflowProbeBindings({
        workflow: { ...w, nodes: [node] },
        workflowProvider: w.provider!,
        workflowModel: w.model,
        config,
      });
      expect(
        bindings.map(binding => [binding.providerId, binding.modelId]),
        node.id
      ).toEqual([['codex-native-strict', 'gpt-5.6-terra']]);
    }
    // Existing discovery deduplicates equivalent keys; six node cases are not
    // six unique keys. Preserve that production behavior rather than replacing it.
    const all = resolveWorkflowProbeBindings({
      workflow: w,
      workflowProvider: w.provider!,
      workflowModel: w.model,
      config,
    });
    expect(
      all
        .filter(binding => binding.providerId === 'codex-native-strict')
        .map(binding => binding.modelId)
    ).toEqual(['gpt-5.6-terra']);
  });

  test('actual model resolver and actual unmodelled personas retain Terra for all seven nodes', async () => {
    const w = workflow();
    for (const node of w.nodes.filter(candidate => candidate.provider === 'codex-native-strict')) {
      const persona = await loadAgentFile(
        join(root, '.archon/agents', `${node.agent ?? node.persona}.md`)
      );
      expect(persona.model, node.id).toBeUndefined();
      const binding = resolveModelForNode({
        nodeId: node.id,
        nodeProvider: node.provider,
        nodeModel: node.model,
        workflowProvider: w.provider!,
        workflowModel: w.model,
        assistantModels: { cursor: 'grok-4.7-high', 'codex-native-strict': undefined },
      });
      const applied = resolveAgentPersona(persona, binding.model, binding.provider);
      expect(applied.model, node.id).toBe('gpt-5.6-terra');
      expect(applied.systemPrompt).toBe(persona.systemPrompt);
    }
  });

  test('actual Cursor root and all six Grok builder bindings are unchanged', () => {
    const w = workflow();
    expect([w.provider, w.model]).toEqual(['cursor', 'grok-4.7-high']);
    const builders = w.nodes.filter(node => node.provider === 'cursor');
    expect(builders.map(node => node.id)).toEqual(cursorIds);
    for (const node of builders) {
      expect(node.model, node.id).toBe('grok-4.7-high');
      const binding = resolveModelForNode({
        nodeId: node.id,
        nodeProvider: node.provider,
        nodeModel: node.model,
        workflowProvider: w.provider!,
        workflowModel: w.model,
      });
      expect(binding, node.id).toEqual({ provider: 'cursor', model: 'grok-4.7-high' });
    }
  });

  test('generated default matches canonical LF workflow content', () => {
    expect(BUNDLED_WORKFLOWS['bdc-feature-development-cursor']).toBe(
      source().replace(/\r\n/g, '\n')
    );
  });
});
