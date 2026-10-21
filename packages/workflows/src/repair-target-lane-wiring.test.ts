import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { parseWorkflow } from './loader';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const EXPECTED_LANES = [
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development.yaml',
];

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly when?: string;
  readonly bash?: string;
  readonly prompt?: string;
  readonly idle_timeout?: number;
  readonly loop?: { readonly prompt?: string };
}

const CURSOR_GROK_LANES = [
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-grok.yaml',
];

function laneFiles(): string[] {
  return readdirSync(LANES_DIR)
    .filter(file => file.startsWith('bdc-feature-development') && file.endsWith('.yaml'))
    .sort();
}

function readLane(file: string): string {
  return readFileSync(join(LANES_DIR, file), 'utf8');
}

function nodesOf(file: string): readonly LaneNode[] {
  const content = readLane(file);
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  return result.workflow.nodes as unknown as readonly LaneNode[];
}

function nodeOf(nodes: readonly LaneNode[], id: string, file: string): LaneNode {
  const found = nodes.find(node => node.id === id);
  if (!found) throw new Error(`${file}: missing ${id}`);
  return found;
}

function rawCore(yaml: string, kind: 'rtw' | 'rta'): string {
  const begin = `# ---- BEGIN ${kind} core`;
  const end = `# ---- END ${kind} core ----`;
  const marker = yaml.indexOf(begin);
  const finish = yaml.indexOf(end, marker);
  if (marker < 0 || finish < 0) throw new Error(`missing ${kind} core`);
  const lineStart = yaml.lastIndexOf('\n', marker) + 1;
  const endLine = yaml.indexOf('\n', finish);
  return yaml.slice(lineStart, endLine === -1 ? yaml.length : endLine + 1);
}

function step4b(prompt: string): string {
  const start = prompt.indexOf('4b. Repair target');
  const end = prompt.indexOf('\n5. Out-of-scope', start);
  if (start < 0 || end < 0) throw new Error('step 4b boundaries missing');
  return prompt.slice(start, end);
}

describe('repair-target lane wiring', () => {
  it('Test 2: the EXPECTED_LANES list cannot drift', () => {
    expect(laneFiles()).toEqual(EXPECTED_LANES);
  });

  it('Test 1: every lane wires the approved plan and the lane-verified record', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const decide = nodeOf(nodes, 'decide-push-target', file);
      const planReview = nodeOf(nodes, 'plan-review', file);
      expect(decide.prompt ?? '', file).toContain('$plan-review.output');
      expect(planReview.loop?.prompt ?? '', file).toContain('$checkout-repair-target.output');
      expect(planReview.depends_on ?? [], file).toContain('checkout-repair-target');
    }
  });

  it('Test 5: no lane asks a model to WebFetch the PR', () => {
    for (const file of EXPECTED_LANES) {
      const planReview = nodeOf(nodesOf(file), 'plan-review', file);
      const prompt = planReview.loop?.prompt ?? '';
      expect(prompt, file).not.toContain('use WebFetch to verify that PR');
      expect(prompt, file).toContain('lane-verified repair-target record');
    }
  });

  it('Test 10: rtw and rta cores are byte-identical to the codex lane', () => {
    const codex = readLane('bdc-feature-development-codex.yaml');
    const rtwRef = rawCore(codex, 'rtw');
    const rtaRef = rawCore(codex, 'rta');
    expect(rtwRef).toContain('RTW_RUNS_DB');
    expect(rtwRef).toContain('RTW_MIN_AGE_SECONDS');
    expect(rtwRef).toContain('RTW_PROC_ROOT');
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      expect(yaml.split('# ---- BEGIN rtw core').length - 1, file).toBe(1);
      expect(yaml.split('# ---- BEGIN rta core').length - 1, file).toBe(1);
      expect(rawCore(yaml, 'rtw'), file).toBe(rtwRef);
      expect(rawCore(yaml, 'rta'), file).toBe(rtaRef);
      const commit = nodeOf(nodesOf(file), 'commit-and-push', file);
      expect(commit.bash ?? '', file).toContain('rta_plan_authorizes');
      expect(commit.bash ?? '', file).toContain('PLAN_REVIEW_RAW');
      expect(commit.bash ?? '', file).not.toContain('grep -Eq "repair_target_authorized_by_spec');
    }
  });

  it('Test 7 (repair-path-hotfix): node-output capture, gates, and idle timeouts', () => {
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      const nodes = nodesOf(file);

      // 1a: exactly two byte-identical reads of the decide handoff file, zero old heredocs.
      expect(yaml.split('ARCHON_NODE_OUT/decide-push-target.out').length - 1, file).toBe(2);
      expect(yaml, file).not.toContain('BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET');

      // 1a: commit-and-push reads both handoff files and fails closed on STDERR.
      const commit = nodeOf(nodes, 'commit-and-push', file).bash ?? '';
      expect(commit, file).toContain('DECIDE_OUT_FILE="$ARCHON_NODE_OUT/decide-push-target.out"');
      expect(commit, file).toContain('PLAN_REVIEW_OUT_FILE="$ARCHON_NODE_OUT/plan-review.out"');
      expect(commit, file).toContain('if [ ! -r "$DECIDE_OUT_FILE" ]; then');
      expect(commit, file).toContain('if [ ! -r "$PLAN_REVIEW_OUT_FILE" ]; then');
      expect(commit, file).toContain('failing closed (F1)." >&2');
      expect(commit, file).toContain('DECIDE_OUTPUT=$(cat "$DECIDE_OUT_FILE")');
      expect(commit, file).toContain('PLAN_REVIEW_RAW=$(cat "$PLAN_REVIEW_OUT_FILE")');

      // 1a: open-pr-if-needed reads the decide handoff file in every lane.
      const openPr = yaml.split('  - id: open-pr-if-needed\n')[1]?.split('\n  - id: ')[0] ?? '';
      expect(openPr, file).toContain('ARCHON_NODE_OUT/decide-push-target.out');

      // 1b: plan-review gates on a non-empty checkout record.
      const planReview = nodeOf(nodes, 'plan-review', file);
      expect(planReview.when ?? '', file).toContain(
        "$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'"
      );
      expect(planReview.when ?? '', file).toContain("$checkout-repair-target.output != ''");

      // 1d: patch-pr-body gates on a non-empty open-pr-if-needed output.
      const patch = nodeOf(nodes, 'patch-pr-body', file);
      expect(patch.when ?? '', file).toContain("$open-pr-if-needed.output != ''");

      // 1f: head-moved guard adopts an ancestor live head instead of always refusing.
      expect(commit, file).toContain('git merge-base --is-ancestor "$REPAIR_TARGET_LIVE_OID" HEAD');
      expect(commit, file).toContain('not an ancestor of HEAD');

      // 1c: idle_timeout: 570000 added to the cursor and grok implement nodes only.
      // Other lanes keep their pre-existing implement timeout (600000 or none) and must
      // carry exactly one idle_timeout: 570000 (the diff-repair setting from #1209).
      const implement = nodeOf(nodes, 'implement', file);
      if (CURSOR_GROK_LANES.includes(file)) {
        expect(implement.idle_timeout, file).toBe(570000);
        expect(yaml.split('idle_timeout: 570000').length - 1, file).toBe(2);
      } else {
        expect(implement.idle_timeout, file).not.toBe(570000);
        expect(yaml.split('idle_timeout: 570000').length - 1, file).toBe(1);
      }
    }
  });

  it('Test 21: prompts require the standalone form and no lane keeps the loose grep', () => {
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      const nodes = nodesOf(file);
      const planReview = nodeOf(nodes, 'plan-review', file);
      const decide = nodeOf(nodes, 'decide-push-target', file);
      const repairStep = step4b(planReview.loop?.prompt ?? '');
      expect(repairStep, file).toContain('a line by itself');
      expect(repairStep, file).toContain('repair_target_authorized_by_spec');
      expect(decide.prompt ?? '', file).toContain('a line by itself');
      expect(decide.prompt ?? '', file).toContain('repair_target_authorized_by_spec');
      expect(yaml, file).not.toContain('grep -Eq "repair_target_authorized_by_spec');
      expect(yaml, file).not.toContain('worktree prune');
    }
  });
});
