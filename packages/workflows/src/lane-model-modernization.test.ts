import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeclaredServedMatch } from './model-alias';
import { getModelRates, MODEL_RATES } from './model-rates';

const ROOT = join(import.meta.dir, '..', '..', '..');
const LANES = join(ROOT, '.archon/workflows/defaults');
const files = readdirSync(LANES)
  .filter(file => file.startsWith('bdc-feature-development') && file.endsWith('.yaml'))
  .sort();

type Node = {
  id: string;
  provider?: string;
  model?: string;
  failover_model?: string;
  persona?: string;
  prompt?: string;
  loop?: unknown;
  depends_on?: string[];
  trigger_rule?: string;
  when?: string;
  task_class?: string;
};
type Lane = {
  name: string;
  provider?: string;
  model?: string;
  nodes?: Node[];
  run_authority?: unknown;
};
const load = (file: string): Lane =>
  (Bun as unknown as { YAML: { parse(value: string): Lane } }).YAML.parse(
    readFileSync(join(LANES, file), 'utf8')
  );
const node = (lane: Lane, id: string) => lane.nodes?.find(candidate => candidate.id === id);

describe('feature-development lane model modernization', () => {
  it('Test 1: rejects stale GPT-5 models except exact Codex Terra reviewer seats', () => {
    const exceptionIds = new Set([
      'plan-review',
      'war-council-validator',
      'diff-review',
      'diff-review-final',
      'opus-rereview',
      'findings-consolidate',
      'apply-diff-review-final',
    ]);
    for (const file of files) {
      const lane = load(file);
      const models: Array<{ id: string; model?: string; failover_model?: string }> = [
        { id: '<root>', model: lane.model },
        ...(lane.nodes ?? []),
      ];
      for (const entry of models) {
        for (const model of [entry.model, entry.failover_model]) {
          if (!model?.startsWith('gpt-5.')) continue;
          expect(file, `${entry.id}:${model}`).toBe('bdc-feature-development-codex.yaml');
          expect(model, `${file}:${entry.id}`).toBe('gpt-5.6-terra');
          expect(exceptionIds.has(entry.id), `${file}:${entry.id}`).toBe(true);
        }
      }
    }
    const codex = load('bdc-feature-development-codex.yaml');
    const observedExceptionIds = (codex.nodes ?? [])
      .filter(entry => entry.model === 'gpt-5.6-terra')
      .map(entry => entry.id)
      .sort();
    expect(observedExceptionIds).toEqual([...exceptionIds].sort());
  });

  it('Test 2: rejects Claude aliases and confines approved Claude ids', () => {
    const approved = new Set([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
    ]);
    const fableLanes = new Set([
      'bdc-feature-development-fable.yaml',
      'bdc-feature-development-astra.yaml',
    ]);
    for (const file of files) {
      const lane = load(file);
      for (const entry of [{ id: '<root>', model: lane.model }, ...(lane.nodes ?? [])]) {
        if (
          !entry.model?.startsWith('claude') &&
          !['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]'].includes(entry.model ?? '')
        )
          continue;
        expect(approved.has(entry.model ?? ''), `${file}:${entry.id}`).toBe(true);
        if (entry.model === 'claude-fable-5')
          expect(fableLanes.has(file), `${file}:${entry.id}`).toBe(true);
      }
    }
    const astraManifest = node(load('bdc-feature-development-astra.yaml'), 'build-manifest');
    expect(approved.has(astraManifest?.model ?? ''), 'astra:build-manifest').toBe(true);
    expect(astraManifest?.model).toBe('claude-opus-5-5');
    expect(astraManifest?.model).not.toBe('opus[1m]');
  });

  it('Test 3: pins Grok check to medium and all other Cursor nodes to high', () => {
    for (const file of [
      'bdc-feature-development-cursor.yaml',
      'bdc-feature-development-grok.yaml',
    ]) {
      for (const entry of load(file).nodes ?? []) {
        if (entry.provider !== 'cursor') continue;
        expect(entry.model, `${file}:${entry.id}`).toBe(
          entry.id === 'check-already-satisfied' ? 'grok-4.7-medium' : 'grok-4.7-high'
        );
      }
    }
  });

  it('Test 4: recognizes new aliases and has explicit rates for modern model ids', () => {
    expect(isDeclaredServedMatch('haiku', 'claude-haiku-5-5')).toBe(true);
    expect(isDeclaredServedMatch('sonnet', 'claude-sonnet-5-5')).toBe(true);
    for (const model of ['claude-haiku-5-5', 'gpt-6-astra']) {
      expect(Object.hasOwn(MODEL_RATES, model)).toBe(true);
      const rates = getModelRates(model);
      expect(rates).toBeDefined();
      expect((rates?.input ?? 0) + (rates?.output ?? 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it('Test 5: assigns every Haiku lane role its required provider and model', () => {
    const lane = load('bdc-feature-development-haiku.yaml');
    const expected: Record<string, [string, string]> = {
      implement: ['claude', 'claude-haiku-5-5'],
      'diff-repair': ['claude', 'claude-haiku-5-5'],
      'opus-repair': ['claude', 'claude-haiku-5-5'],
      'apply-suggested-fix': ['claude', 'claude-haiku-5-5'],
      'check-already-satisfied': ['claude', 'claude-haiku-5-5'],
      plan: ['claude', 'claude-opus-5-5'],
      'build-manifest': ['claude', 'claude-sonnet-5-5'],
      'decide-push-target': ['claude', 'claude-sonnet-5-5'],
      'plan-review': ['codex-native-strict', 'gpt-6-astra'],
      'war-council-validator': ['codex-native-strict', 'gpt-6-astra'],
      'diff-review': ['codex-native-strict', 'gpt-6-astra'],
      'diff-review-final': ['codex-native-strict', 'gpt-6-astra'],
      'opus-rereview': ['codex-native-strict', 'gpt-6-astra'],
      'findings-consolidate': ['codex-native-strict', 'gpt-6-astra'],
      'apply-diff-review-final': ['codex-native-strict', 'gpt-6-astra'],
    };
    for (const [id, [provider, model]] of Object.entries(expected)) {
      expect(node(lane, id)?.provider, id).toBe(provider);
      expect(node(lane, id)?.model, id).toBe(model);
    }
  });

  it('Test 6: preserves Astra structure, obeys persona pins, and excludes Fable', () => {
    const haiku = load('bdc-feature-development-haiku.yaml');
    const astra = load('bdc-feature-development-astra.yaml');
    expect(haiku.run_authority).toEqual(astra.run_authority);
    expect(haiku.nodes?.map(entry => entry.id)).toEqual(astra.nodes?.map(entry => entry.id));
    for (const [index, entry] of (haiku.nodes ?? []).entries()) {
      const astraEntry = astra.nodes?.[index];
      expect(
        {
          depends_on: entry.depends_on,
          trigger_rule: entry.trigger_rule,
          when: entry.when,
          task_class: entry.task_class,
          hasPrompt: Boolean(entry.prompt),
          hasLoop: Boolean(entry.loop),
        },
        entry.id
      ).toEqual({
        depends_on: astraEntry?.depends_on,
        trigger_rule: astraEntry?.trigger_rule,
        when: astraEntry?.when,
        task_class: astraEntry?.task_class,
        hasPrompt: Boolean(astraEntry?.prompt),
        hasLoop: Boolean(astraEntry?.loop),
      });
      if (entry.persona && (entry.prompt || entry.loop)) {
        expect(entry.provider, `${entry.id}:provider`).toBeTruthy();
        expect(entry.model, `${entry.id}:model`).toBeTruthy();
      }
    }
    expect(readFileSync(join(LANES, 'bdc-feature-development-haiku.yaml'), 'utf8')).not.toContain(
      'claude-fable-5'
    );
  });

  it('Test 7: registers and bundles the Haiku lane', () => {
    expect(files).toContain('bdc-feature-development-haiku.yaml');
    const registrationTest = readFileSync(
      join(import.meta.dir, 'lane-registration.test.ts'),
      'utf8'
    );
    const roster = registrationTest.match(/expect\(LANE_FILES\)\.toEqual\(\[([\s\S]*?)\]\);/)?.[1];
    expect(roster).toContain("'bdc-feature-development-haiku.yaml'");
    const bundled = readFileSync(
      join(import.meta.dir, 'defaults/bundled-defaults.generated.ts'),
      'utf8'
    );
    expect(bundled).toContain('bdc-feature-development-haiku');
  });

  it('Test 8: documents every actual lane with a model and cost class', () => {
    const runbook = readFileSync(join(ROOT, 'docs/runbooks/feature-development-lanes.md'), 'utf8');
    for (const file of files) {
      const row = runbook.split('\n').find(line => line.includes(`| ${file} |`));
      expect(row, file).toBeDefined();
      expect(row).toMatch(/\| (cheap|standard|premium|open-model) \|/);
      expect(row).toMatch(/(gpt|claude|grok|qwen|kimi|deepseek)/i);
    }
  });
});
