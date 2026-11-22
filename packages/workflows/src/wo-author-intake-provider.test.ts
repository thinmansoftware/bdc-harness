/**
 * WO-HARNESS-WO-AUTHOR-INTAKE-REPAIR-01: the bdc-wo-author intake runs on a working
 * provider, writes no Notion pages, drafts from the per-class template and cannot commit
 * a spec without passing the stop-command gate.
 *
 * Tests 1, 2, 3 and 11 of the WO. The YAML is loaded with the real parseWorkflow (a load
 * failure is a test failure: it catches a silently dropped workflow), personas are
 * resolved with loadAgentFile + resolveAgentPersona, and when: expressions are evaluated
 * with evaluateCondition.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import { parseWorkflow } from './loader';
import { loadAgentFile } from './agents/registry';
import { resolveAgentPersona } from './executor-shared';
import { evaluateCondition } from './condition-evaluator';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
import type { NodeOutput, WorkflowDefinition } from './schemas';

const root = join(import.meta.dir, '../../..');
const filename = 'bdc-wo-author.yaml';

function source(): string {
  return readFileSync(join(root, '.archon/workflows/defaults', filename), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
}

function workflow(): WorkflowDefinition {
  const parsed = parseWorkflow(source(), filename);
  if (!parsed.workflow) throw new Error(`bdc-wo-author failed to load: ${parsed.error?.error}`);
  return parsed.workflow;
}

type AnyNode = Record<string, unknown> & { id: string };

function nodes(): AnyNode[] {
  return workflow().nodes as unknown as AnyNode[];
}

function node(id: string): AnyNode {
  const found = nodes().find(n => n.id === id);
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

function isModelNode(n: AnyNode): boolean {
  return typeof n.prompt === 'string' || (typeof n.loop === 'object' && n.loop !== null);
}

function promptText(n: AnyNode): string {
  if (typeof n.prompt === 'string') return n.prompt;
  const loop = n.loop as { prompt?: unknown } | undefined;
  return typeof loop?.prompt === 'string' ? loop.prompt : '';
}

// WO-HARNESS-WO-AUTHOR-DRAFT-ONLY-SAFETY-01: the gate chain runs only for a new spec, so
// every case below also carries the deterministic disposition of a new spec.
const NEW_DISPOSITION = '{"result":"new","wo_id":"WO-FIXTURE-01"}';
const UNCHANGED_DISPOSITION = '{"result":"existing_spec_unchanged","wo_id":"WO-FIXTURE-01"}';

function outputs(
  id: string,
  output: string,
  disposition: string = NEW_DISPOSITION
): Map<string, NodeOutput> {
  return new Map<string, NodeOutput>([
    [id, { state: 'completed', output }],
    ['spec-disposition', { state: 'completed', output: disposition }],
  ]);
}

const PASS_JSON =
  '{"GATE":"pass","GATE_ALLOW":"yes","GATE_REASONS":"","GATE_BASE_SHA":"' +
  'a'.repeat(40) +
  '","GATE_OVERRIDES":""}';
const FAIL_JSON =
  '{"GATE":"fail","GATE_ALLOW":"no","GATE_REASONS":"1:green_failed:bash tests/bad.sh","GATE_BASE_SHA":"","GATE_OVERRIDES":""}';
const VALIDATOR_FAIL_JSON =
  '{"GATE":"fail","GATE_ALLOW":"no","GATE_REASONS":"0:validator_failed:exit 1: FAIL 1: CHECK 7","GATE_BASE_SHA":"","GATE_OVERRIDES":""}';
const NO_SPEC_JSON =
  '{"GATE":"no_spec","GATE_ALLOW":"no","GATE_REASONS":"no spec drafted","GATE_BASE_SHA":"","GATE_OVERRIDES":""}';

beforeEach(() => {
  clearRegistry();
  registerBuiltinProviders();
});
afterEach(clearRegistry);

describe('WO-HARNESS-WO-AUTHOR-INTAKE-REPAIR-01', () => {
  test('Test 1: wo_author_model_nodes_use_a_working_provider', async () => {
    const w = workflow();
    expect(w.provider).toBe('codex');
    expect(w.model).toBe('gpt-6.1-sol');
    const modelNodes = nodes().filter(isModelNode);
    expect(modelNodes.map(n => n.id).sort()).toEqual(
      ['author-loop', 'build-manifest', 'normalize-intake', 'stop-command-revise'].sort()
    );
    for (const n of modelNodes) {
      const provider = String((n.provider as string | undefined) ?? w.provider);
      expect(['codex', 'codex-native-strict'], n.id).toContain(provider);
      expect(provider, n.id).not.toBe('claude');
      expect(n.model, n.id).toBe('gpt-6.1-sol');
      const personaName = String((n.agent as string | undefined) ?? n.persona);
      expect(n.agent ?? n.persona, n.id).toBeDefined();
      const persona = await loadAgentFile(join(root, '.archon/agents', `${personaName}.md`));
      expect(persona.model, n.id).toBeUndefined();
      // Throws InfrastructureClassBlock when a persona with a model sits on a codex node.
      const resolved = resolveAgentPersona(persona, n.model as string, provider);
      expect(resolved.agentName, n.id).toBe(personaName);
    }
    expect(node('normalize-intake').persona).toBe('xo-opr');
    expect(node('author-loop').persona).toBe('major-build-opr');
    expect(node('build-manifest').persona).toBe('major-build-opr');
    expect(node('stop-command-revise').persona).toBe('major-build-opr');
    expect(BUNDLED_WORKFLOWS['bdc-wo-author']).toBe(source());
    const manifestPrompt = promptText(node('build-manifest'));
    expect(manifestPrompt).not.toContain('^model[:][ ]sonnet$');
    expect(manifestPrompt).toContain('^model[:][ ]gpt-6.1-sol$');
  });

  test('Test 2: wo_author_writes_no_notion', () => {
    const ids = nodes().map(n => n.id);
    expect(ids).not.toContain('file-notion');
    expect(ids).not.toContain('flip-notion');
    for (const n of nodes()) {
      const deps = (n.depends_on as string[] | undefined) ?? [];
      expect(deps, n.id).not.toContain('file-notion');
      expect(deps, n.id).not.toContain('flip-notion');
    }
    const text = source();
    expect(text).not.toContain('$file-notion.output');
    expect(text).not.toContain('$flip-notion.output');
    expect(text).not.toContain('notion-create-pages');
    expect(text).not.toContain('NOTION_DB_ID');
    expect(text).not.toContain('Notion entry created');
    expect(text).toContain('Notion is read-only; no Notion entry is created');
  });

  test('Test 3: wo_author_gate_is_wired_and_its_conditions_parse', () => {
    const gate = node('stop-command-gate');
    const revise = node('stop-command-revise');
    const final = node('stop-command-gate-final');
    const commit = node('commit-spec');
    const fail = node('stop-command-gate-fail');

    expect(gate.depends_on).toEqual(['dry-run-preview']);
    expect(node('dry-run-preview').depends_on).toEqual(['spec-disposition']);
    expect(node('spec-disposition').depends_on).toEqual(['author-loop']);
    expect(typeof node('classify-intake').bash).toBe('string');
    expect(node('normalize-intake').depends_on).toEqual(['classify-intake']);
    expect(gate.timeout).toBe(1800000);
    expect(final.timeout).toBe(1800000);
    expect(typeof gate.bash).toBe('string');
    expect(typeof final.bash).toBe('string');

    expect(revise.depends_on).toEqual(['stop-command-gate']);
    expect(revise.provider).toBe('codex');
    const reviseWhen = revise.when as string;
    for (const [json, expected] of [
      [FAIL_JSON, true],
      [VALIDATOR_FAIL_JSON, true],
      [PASS_JSON, false],
      [NO_SPEC_JSON, false],
    ] as const) {
      const r = evaluateCondition(reviseWhen, outputs('stop-command-gate', json));
      expect(r.parsed).toBe(true);
      expect(r.result, json).toBe(expected);
    }

    expect(final.depends_on).toEqual(['stop-command-revise']);
    expect(final.trigger_rule).toBe('all_done');

    expect(commit.depends_on).toEqual(['stop-command-gate-final']);
    const commitWhen = commit.when as string;
    expect(fail.depends_on).toEqual(['stop-command-gate-final']);
    expect(fail.trigger_rule).toBe('all_done');
    const failWhen = fail.when as string;
    const cases: [string, boolean][] = [
      [PASS_JSON, true],
      [FAIL_JSON, false],
      [NO_SPEC_JSON, false],
      ['', false],
      ['not json at all', false],
    ];
    for (const [json, allowed] of cases) {
      const o = outputs('stop-command-gate-final', json);
      const c = evaluateCondition(commitWhen, o);
      const f = evaluateCondition(failWhen, o);
      expect(c.parsed).toBe(true);
      expect(f.parsed).toBe(true);
      // Exactly one of commit-spec and stop-command-gate-fail runs, for every output.
      expect(c.result, `commit for ${json}`).toBe(allowed);
      expect(f.result, `fail for ${json}`).toBe(!allowed);
      // The positively identified unchanged path: neither commit nor fail runs, whatever
      // the (stale) gate output says.
      const u = outputs('stop-command-gate-final', json, UNCHANGED_DISPOSITION);
      expect(evaluateCondition(commitWhen, u).result, `unchanged commit for ${json}`).toBe(false);
      expect(evaluateCondition(failWhen, u).result, `unchanged fail for ${json}`).toBe(false);
    }
    for (const json of [FAIL_JSON, VALIDATOR_FAIL_JSON]) {
      const u = outputs('stop-command-gate', json, UNCHANGED_DISPOSITION);
      expect(evaluateCondition(reviseWhen, u).result, `unchanged revise for ${json}`).toBe(false);
    }
    // gate-final skipped or never recorded: no output at all.
    expect(evaluateCondition(failWhen, new Map()).result).toBe(true);
    expect(evaluateCondition(commitWhen, new Map()).result).toBe(false);

    const manifest = node('build-manifest');
    expect(manifest.trigger_rule).toBe('all_done');
    const manifestPrompt = promptText(manifest);
    expect(manifestPrompt).toContain('$stop-command-gate.output');
    expect(manifestPrompt).toContain('$stop-command-gate-final.output');

    for (const n of nodes().filter(isModelNode)) {
      expect(n.provider, n.id).toBe('codex');
    }
  });

  test('Test 11: author_loop_drafts_from_the_class_template', () => {
    const author = promptText(node('author-loop'));
    expect(author).toContain('scripts/cauldron/new-wo.sh');
    expect(author).toContain('docs/work-orders/templates/TEMPLATE-');
    expect(author).toContain('scripts/cauldron/validate-wo-spec.sh');
    expect(author).not.toContain('## 11. Test Scenarios');
    expect(author).not.toContain('## 12. Stop Point');
    expect(author).not.toContain('Re-run all 12 checks');
    expect(author).not.toContain('Section 10 Deploy Target');
    expect(author).not.toContain('VALIDATE: PASS');
    expect(author).toMatch(/VALIDATE_PASS<\/promise>` ONLY when:[\s\S]*printed\s+RESULT: PASS/);
    expect(author).toContain("copied from the spec's own target_repo: line");
    expect(author).toContain('does NOT author MIXED specs');
    for (const key of ['wo_id=', 'spec_path=', 'target_repo=', 'mode=', 'auto_approve=']) {
      expect(author).toContain(key);
    }
    expect(promptText(node('normalize-intake'))).not.toContain('Section 10 Deploy Target');
    const commitBash = node('commit-spec').bash as string;
    expect(commitBash).not.toContain('12-section');
    expect(commitBash).not.toContain('promotes via Notion');
    expect(commitBash).not.toContain('Claude Sonnet 4.6');
    // Annex check 2 (General, bdc-xo PR 6394 comment 7011983264): the old verdict
    // string is gone from the whole workflow, not only from author-loop.
    expect(source()).not.toContain('VALIDATE: PASS');
  });
});
