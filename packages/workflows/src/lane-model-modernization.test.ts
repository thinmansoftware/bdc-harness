/**
 * lane-model-modernization.test.ts
 *
 * WO-HARNESS-LANES-MODERNIZE-AND-HAIKU-01 -- Tests 1 to 8.
 *
 * Verifies the feature-development lanes were modernized to current model
 * generations (GPT-6 on Codex, Claude 5.5 on Claude, Grok 4.7 on Cursor) and
 * that the new bdc-feature-development-haiku canary lane binds Claude-haiku-5-5
 * build seats with a strong cross-family (gpt-6-astra) review/validation panel.
 *
 * All assertions run against the REAL YAML files via parseWorkflow() plus raw
 * text checks, mirroring the Stop conditions Captain CI runs.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { isDeclaredServedMatch, resetAliasCacheForTests } from './model-alias';
import { getModelRate } from './model-rates';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const RUNBOOK = join(REPO_ROOT, 'docs/runbooks/feature-development-lanes.md');

const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
  .sort();

const CODEX_LANE = 'bdc-feature-development-codex.yaml';
const HAIKU_LANE = 'bdc-feature-development-haiku.yaml';

// The single documented GPT-5 exception: gpt-5.6-terra reviewer seats in the
// codex lane (no cheaper verified GPT-6 id on the live runtime -- gpt-6-luna is
// unverified). Mirrors docs/runbooks/feature-development-lanes.md.
const CODEX_TERRA_REVIEW_SEATS = new Set([
  'plan-review',
  'war-council-validator',
  'diff-review',
  'diff-review-final',
  'opus-rereview',
  'findings-consolidate',
  'apply-diff-review-final',
]);

const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]']);
const ALLOWED_CLAUDE_IDS = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5',
]);
const FABLE_ALLOWED_LANES = new Set([
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-astra.yaml',
]);

interface ParsedNode {
  id: string;
  provider?: string;
  model?: string;
  persona?: string;
  agent?: string;
  prompt?: unknown;
  loop?: unknown;
}

function parse(file: string): { model?: string; provider?: string; nodes: ParsedNode[] } {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: parseWorkflow failed: ${result.error?.error ?? 'unknown'}`);
  }
  return result.workflow as unknown as {
    model?: string;
    provider?: string;
    nodes: ParsedNode[];
  };
}

describe('WO-HARNESS-LANES-MODERNIZE-AND-HAIKU-01', () => {
  it('Test 1: no stale GPT-5 ids on builder and judge seats', () => {
    for (const file of LANE_FILES) {
      const wf = parse(file);
      // Root model must never be a gpt-5.x id.
      if (wf.model) {
        expect(wf.model, `${file}:root-model`).not.toMatch(/gpt-5/);
      }
      for (const node of wf.nodes) {
        if (typeof node.model !== 'string' || !/gpt-5/.test(node.model)) continue;
        // The ONLY permitted gpt-5.x survivors are the codex-lane gpt-5.6-terra
        // reviewer seats listed in the runbook.
        expect(node.model, `${file}:${node.id}`).toBe('gpt-5.6-terra');
        expect(file, `${file}:${node.id} unexpected gpt-5 lane`).toBe(CODEX_LANE);
        expect(
          CODEX_TERRA_REVIEW_SEATS.has(node.id),
          `${file}:${node.id} gpt-5.6-terra outside the documented review-seat list`
        ).toBe(true);
      }
    }
  });

  it('Test 1b: the gpt-5.6-terra exception seats match the runbook review-seat list exactly', () => {
    const wf = parse(CODEX_LANE);
    const terraSeats = wf.nodes
      .filter(n => n.model === 'gpt-5.6-terra')
      .map(n => n.id)
      .sort();
    expect(new Set(terraSeats)).toEqual(CODEX_TERRA_REVIEW_SEATS);
  });

  it('Test 2: no Claude aliases remain; only modern Claude ids are used', () => {
    for (const file of LANE_FILES) {
      const wf = parse(file);
      const values: Array<{ id: string; model: string }> = [];
      if (wf.model) values.push({ id: '<root>', model: wf.model });
      for (const node of wf.nodes) {
        if (typeof node.model === 'string') values.push({ id: node.id, model: node.model });
      }
      for (const { id, model } of values) {
        expect(CLAUDE_ALIASES.has(model), `${file}:${id} uses alias '${model}'`).toBe(false);
        if (model.startsWith('claude-')) {
          expect(
            ALLOWED_CLAUDE_IDS.has(model),
            `${file}:${id} non-allowed Claude id '${model}'`
          ).toBe(true);
          if (model === 'claude-fable-5') {
            expect(
              FABLE_ALLOWED_LANES.has(file),
              `${file}: claude-fable-5 outside fable/astra`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('Test 3: Grok tiers -- every cursor-provider model-bearing node pins the right grok-4.7 tier', () => {
    for (const file of [
      'bdc-feature-development-cursor.yaml',
      'bdc-feature-development-grok.yaml',
    ]) {
      const wf = parse(file);
      // Enumerate EVERY model-bearing node whose effective provider is cursor
      // (explicit node.provider, else the lane root provider). We must NOT
      // prefilter on the grok-4.7 prefix: an obsolete or wrong Grok id on a
      // cursor seat (e.g. grok-4-high, grok-5-high, grok-4.6-high) must FAIL
      // the tier assertion, not be silently excluded from scope.
      const cursorNodes = wf.nodes.filter(
        n => (n.provider ?? wf.provider) === 'cursor' && typeof n.model === 'string'
      );
      expect(cursorNodes.length, `${file}:has-cursor-model-nodes`).toBeGreaterThan(0);
      for (const node of cursorNodes) {
        const expected =
          node.id === 'check-already-satisfied' ? 'grok-4.7-medium' : 'grok-4.7-high';
        expect(node.model, `${file}:${node.id}`).toBe(expected);
      }
      // check-already-satisfied must exist as a cursor seat on the medium tier.
      const cas = wf.nodes.find(n => n.id === 'check-already-satisfied');
      expect(cas?.model, `${file}:check-already-satisfied`).toBe('grok-4.7-medium');
      expect(
        cas ? (cas.provider ?? wf.provider) : undefined,
        `${file}:check-already-satisfied:provider`
      ).toBe('cursor');
    }
  });

  it('Test 4: alias + rate config know the new ids', () => {
    resetAliasCacheForTests();
    expect(isDeclaredServedMatch('haiku', 'claude-haiku-5-5')).toBe(true);
    expect(isDeclaredServedMatch('sonnet', 'claude-sonnet-5-5')).toBe(true);

    for (const id of ['claude-haiku-5-5', 'gpt-6-astra']) {
      // Must not throw (undefined rate) and must not silently price at zero.
      const rate = getModelRate(id);
      const positive = rate.inputPerToken > 0 || rate.outputPerToken > 0;
      expect(
        positive || rate.documentedZero === true,
        `${id} rate must be non-zero or an explicit documented zero`
      ).toBe(true);
    }
  });

  it('Test 5: haiku lane roles -- Claude-haiku build seats, gpt-6-astra review/validation seats', () => {
    const wf = parse(HAIKU_LANE);
    const byId = new Map(wf.nodes.map(n => [n.id, n]));
    const buildSeats = [
      'implement',
      'diff-repair',
      'opus-repair',
      'apply-suggested-fix',
      'check-already-satisfied',
    ];
    const reviewSeats = [
      'plan-review',
      'war-council-validator',
      'diff-review',
      'diff-review-final',
      'opus-rereview',
      'findings-consolidate',
      'apply-diff-review-final',
    ];
    for (const id of buildSeats) {
      expect(byId.get(id)?.model, `haiku:${id}`).toBe('claude-haiku-5-5');
      expect(byId.get(id)?.provider, `haiku:${id}`).toBe('claude');
    }
    for (const id of reviewSeats) {
      expect(byId.get(id)?.model, `haiku:${id}`).toBe('gpt-6-astra');
      expect(byId.get(id)?.provider, `haiku:${id}`).toBe('codex-native-strict');
      // A review/validation seat must never run the builder's model family.
      expect(byId.get(id)?.model, `haiku:${id}:not-haiku`).not.toBe('claude-haiku-5-5');
      expect(byId.get(id)?.provider, `haiku:${id}:not-claude`).not.toBe('claude');
    }
  });

  it('Test 6: haiku persona pin law holds and no Fable appears', () => {
    const content = readFileSync(join(LANES_DIR, HAIKU_LANE), 'utf-8');
    expect(content).not.toContain('claude-fable-5');

    const wf = parse(HAIKU_LANE);
    for (const node of wf.nodes) {
      const provider = node.provider ?? wf.provider;
      const personaBearing = Boolean(node.persona ?? node.agent);
      const aiNode = node.prompt !== undefined || node.loop !== undefined;
      if (!personaBearing && !aiNode) continue;
      if (provider === 'claude') continue; // pin law targets non-claude providers
      if (provider === undefined) continue;
      // Non-claude persona/prompt/loop node: both provider and model must be pinned.
      expect(node.provider, `haiku:${node.id}:provider-pin`).toBeDefined();
      expect(node.model, `haiku:${node.id}:model-pin`).toBeDefined();
    }
  });

  it('Test 7: haiku lane is registered in the roster and bundled defaults', () => {
    expect(LANE_FILES).toContain(HAIKU_LANE);
    const bundled = readFileSync(
      join(REPO_ROOT, 'packages/workflows/src/defaults/bundled-defaults.generated.ts'),
      'utf-8'
    );
    expect(bundled).toContain('bdc-feature-development-haiku');
    expect(bundled).toContain('claude-haiku-5-5');
  });

  it('Test 8: runbook gives each lane its own roster row with model info and a valid cost class', () => {
    const runbook = readFileSync(RUNBOOK, 'utf-8');
    const COST_CLASSES = new Set(['cheap', 'standard', 'premium', 'open-model']);
    // Markers that count as "model information" in a roster row.
    const MODEL_MARKER = /claude-|gpt-[0-9]|grok-[0-9]|deepseek|kimi|qwen/i;
    // Candidate roster rows are the markdown table rows (leading pipe).
    const rows = runbook.split('\n').filter(line => line.trimStart().startsWith('|'));

    for (const file of LANE_FILES) {
      const laneName = file.replace(/\.yaml$/, '');
      // Exact first-cell match so a prefix lane (bdc-feature-development) does
      // NOT borrow a longer lane's row (e.g. bdc-feature-development-astra).
      const row = rows.find(line => line.split('|')[1]?.trim() === laneName);
      expect(row, `runbook missing roster row for lane ${laneName}`).toBeDefined();
      // Columns: '' | Lane | Builder | Reviewer | Cost class | When to use | ''
      const cells = (row as string).split('|').map(c => c.trim());
      const costCell = cells[4] ?? '';
      expect(
        COST_CLASSES.has(costCell),
        `runbook row for ${laneName}: cost column '${costCell}' is not a valid cost class`
      ).toBe(true);
      expect(
        MODEL_MARKER.test(row as string),
        `runbook row for ${laneName}: no model id present in the row`
      ).toBe(true);
    }
  });
});
