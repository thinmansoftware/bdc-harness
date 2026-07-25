import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

// WO-HARNESS-PRECHECK-BASE-REF-VISIBILITY-01 (M-85, RATIFIED 2026-07-25)
// The check-already-satisfied precheck must consult origin/<base> when a
// deliverable is absent locally, so a WO merged by a concurrent sibling run
// is recognized as already-satisfied instead of being redundantly rebuilt.
// These assertions are string-level on the prompt wiring, matching how
// already-satisfied-lane-wiring.test.ts tests wiring rather than agent cognition.

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// The 12 lanes that carry the check-already-satisfied precheck node (spec Section 5).
const EXPECTED_PRECHECK_LANES = [
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development.yaml',
  'bdc-harness-ascii-autofix-01.yaml',
  'bdc-harness-commit-guard-pause-not-fail-01.yaml',
  'bdc-harness-mc-negan-diagnostic-graph.yaml',
].sort();

const PRECHECK_LANE_FILES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => {
    const content = readFileSync(join(LANES_DIR, file), 'utf-8');
    return content.includes('- id: check-already-satisfied');
  })
  .sort();

function precheckPrompt(file: string): string {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  const node = result.workflow.nodes.find(n => n.id === 'check-already-satisfied');
  if (!node) throw new Error(`${file}: no check-already-satisfied node`);
  const prompt = node.prompt;
  if (typeof prompt !== 'string') {
    throw new Error(`${file}: check-already-satisfied has no string prompt`);
  }
  return prompt;
}

describe('already-satisfied base-ref visibility (WO-HARNESS-PRECHECK-BASE-REF-VISIBILITY-01)', () => {
  it('discovers exactly the 12 expected precheck lanes', () => {
    expect(PRECHECK_LANE_FILES).toEqual(EXPECTED_PRECHECK_LANES);
  });

  // Stop condition 1 / M-85 binding condition 1: the forbidding instruction is
  // REPLACED, not merely contradicted. It must not survive anywhere under defaults.
  it('has zero occurrences of the forbidding "Do NOT consult origin/main" instruction', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(LANES_DIR).filter(f => f.endsWith('.yaml'))) {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      if (content.includes('Do NOT consult origin/main')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  for (const file of EXPECTED_PRECHECK_LANES) {
    describe(file, () => {
      // Stop condition 2: BASE_CHECK instruction present in the precheck prompt.
      it('instructs a BASE_CHECK against origin/<base>', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('BASE_CHECK');
        // Reuses the supported $BASE_BRANCH variable with the standard dev fallback.
        expect(prompt).toContain('git fetch origin ${BASE_BRANCH:-dev}');
        expect(prompt).toContain('origin/${BASE_BRANCH:-dev}');
      });

      // Decision matrix row: absent local + present base -> ALREADY_SATISFIED=true.
      it('directs ALREADY_SATISFIED=true when deliverables are present on origin/<base> only', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('origin/<base>');
        expect(prompt).toContain('ALREADY_SATISFIED=true');
      });

      // Decision matrix row + M-85 binding condition 2: fetch failure degrades to
      // today's local-only answer with BASE_CHECK=unavailable, never a hard fail.
      it('degrades to ALREADY_SATISFIED=false with BASE_CHECK=unavailable on fetch failure', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('BASE_CHECK=unavailable');
        expect(prompt).toContain('ALREADY_SATISFIED=false');
        expect(prompt.toLowerCase()).toContain('do not hard-fail');
      });

      // M-85 binding condition 3: base-present-only branch SKIPS the build; no rebase.
      it('forbids rebase/merge and relies on the existing skip logic', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('Do NOT rebase');
        expect(prompt).toContain('do NOT merge');
      });

      // Existing local fast path (decision matrix row 1) is unchanged: still judges
      // THIS worktree's HEAD first.
      it('preserves the local worktree-HEAD-first fast path', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain("worktree's HEAD");
        expect(prompt).toContain('READ-ONLY');
      });
    });
  }
});
