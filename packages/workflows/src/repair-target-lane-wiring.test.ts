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
  readonly bash?: string;
  readonly prompt?: string;
  readonly loop?: { readonly prompt?: string };
}

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
