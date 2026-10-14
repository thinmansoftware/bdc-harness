import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseWorkflow } from './loader';
import { registerBuiltinProviders } from '@archon/providers';

const root = join(import.meta.dir, '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
interface Node {
  id: string;
  provider?: string;
  model?: string;
  persona?: string;
  agent?: string;
  prompt?: string;
  loop?: unknown;
  [key: string]: unknown;
}
interface Lane {
  name: string;
  provider: string;
  model: string;
  nodes: Node[];
}
const astraText = read('.archon/workflows/defaults/bdc-feature-development-astra.yaml');
const astra = parseYaml(astraText) as Lane;
const baseline = parseYaml(
  read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')
) as Lane;
const reviewIds = [
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
];
const bindingKeys = new Set(['provider', 'model', 'persona', 'agent']);
const withoutBindings = (node: Node): Record<string, unknown> =>
  Object.fromEntries(Object.entries(node).filter(([key]) => !bindingKeys.has(key)));
// Only model attribution text may differ inside a prompt or shell body.
const attributionChanges = [
  [
    'Co-Authored-By: Claude (Cauldron major-build) <noreply@anthropic.com>',
    'Co-Authored-By: Astra (Cauldron major-build) <noreply@openai.com>',
  ],
  [
    'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
    'Co-Authored-By: Astra (Cauldron major-build) <noreply@openai.com>',
  ],
  ['You are the Claude adversarial', 'You are the Fable adversarial'],
  ['The Codex diff reviewer', 'The Fable diff reviewer'],
  ['BUILDER; Codex does not edit', 'BUILDER; Fable does not edit'],
  ['Codex review verdict', 'Fable review verdict'],
  ['exact Codex findings', 'exact Fable findings'],
  ['Original Codex findings', 'Original Fable findings'],
  ['Diff review (Codex,', 'Diff review (Fable,'],
  [
    'diff-review provider used (codex cross-model, OR claude-fallback with\n  CROSS_MODEL_REVIEW=false disclosed)',
    'diff-review provider/model used (claude/claude-fable-5, independent of Astra;\n  any substitution or unverified served identity must be disclosed)',
  ],
];

describe('Astra build / Fable review lane', () => {
  // WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01 adds a bounded
  // commit-hook repair+retry chain to the CODEX lane only (5 new nodes) and
  // adapts commit-and-push + open-pr-if-needed to it. That divergence is codex-only
  // by WO scope; a follow-up WO fans the same change to astra and the other 11
  // lanes. Until then astra mirrors codex for every SHARED, UNCHANGED node, and the
  // ONLY codex/astra DAG difference is exactly those WO-scoped nodes.
  const CODEX_ONLY_NODES = new Set([
    'classify-commit-hook',
    'commit-hook-repair',
    'classify-commit-hook-repair',
    'commit-hook-retry',
    'commit-hook-gate',
  ]);
  const WO_DIVERGED_NODES = new Set(['commit-and-push', 'open-pr-if-needed']);

  it('loads the real workflow without changing any DAG behavior or gates', () => {
    registerBuiltinProviders();
    const parsed = parseWorkflow(astraText, 'bdc-feature-development-astra.yaml');
    expect(parsed.error).toBeNull();
    expect(parsed.workflow).toBeDefined();
    const baselineShared = baseline.nodes.filter(
      node => !CODEX_ONLY_NODES.has(node.id) && !WO_DIVERGED_NODES.has(node.id)
    );
    const expected = JSON.parse(
      JSON.stringify(baselineShared.map(withoutBindings)),
      (_key, value: unknown) =>
        typeof value === 'string'
          ? attributionChanges.reduce(
              (text, [before, after]) => text.replaceAll(before, after),
              value
            )
          : value
    );
    const astraShared = astra.nodes.filter(node => !WO_DIVERGED_NODES.has(node.id));
    expect(astraShared.map(withoutBindings)).toEqual(expected);

    // The codex-only commit-hook nodes exist in codex but NOT in astra -- the
    // divergence is exactly the WO's scoped additions and nothing else.
    for (const id of CODEX_ONLY_NODES) {
      expect(baseline.nodes.some(node => node.id === id)).toBe(true);
      expect(astra.nodes.some(node => node.id === id)).toBe(false);
    }
    // Both lanes still carry the adapted nodes (shapes differ until the follow-up).
    for (const id of WO_DIVERGED_NODES) {
      expect(baseline.nodes.some(node => node.id === id)).toBe(true);
      expect(astra.nodes.some(node => node.id === id)).toBe(true);
    }
  });

  it('binds every prompt and loop seat, preserving different-family review', () => {
    const seats = astra.nodes.filter(node => node.prompt || node.loop);
    expect(seats).toHaveLength(14);
    expect(seats.filter(node => reviewIds.includes(node.id))).toHaveLength(7);
    for (const seat of seats) {
      const review = reviewIds.includes(seat.id);
      expect(seat.provider, seat.id).toBe(review ? 'claude' : 'codex-native-strict');
      expect(seat.model, seat.id).toBe(review ? 'claude-fable-5' : 'gpt-6-astra');
      expect(seat.fallbackModel).toBeUndefined();
      expect(seat.failover_provider).toBeUndefined();
      const personaName = seat.persona ?? seat.agent;
      if (personaName) {
        const header = parseYaml(read(`.archon/agents/${personaName}.md`).split(/^---\s*$/m)[1]);
        expect(header.model, personaName).toBe(review ? 'claude-fable-5' : undefined);
      }
    }
  });

  it('keeps role bodies and tools intact in the Fable persona variants', () => {
    for (const [oldName, newName] of [
      ['war-council-architect', 'astra-plan-reviewer'],
      ['captain-ci-validator-fable', 'astra-validator'],
      ['claude-adversarial-reviewer', 'astra-adversarial-reviewer'],
      ['xo', 'astra-findings-reviewer'],
    ]) {
      const original = read(`.archon/agents/${oldName}.md`)
        .replace(/\r\n/g, '\n')
        .split(/^---\s*$/m);
      const variant = read(`.archon/agents/${newName}.md`)
        .replace(/\r\n/g, '\n')
        .split(/^---\s*$/m);
      expect(parseYaml(variant[1]).tools).toEqual(parseYaml(original[1]).tools);
      expect(variant.slice(2)).toEqual(original.slice(2));
    }
  });
});
