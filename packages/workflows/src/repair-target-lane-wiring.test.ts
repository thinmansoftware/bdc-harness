import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { parseWorkflow } from './loader';
import { substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput } from './schemas/workflow-run';

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
  readonly when?: string;
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

function runBash(script: string, cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bash', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const AUTH_PARSER = [
  "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')",
  "REPAIR_TARGET_AUTHORIZED=$(printf '%s\\n' \"$DECIDE_OUTPUT_CLEAN\" | sed -n 's/^[[:space:]]*repair_target_authorized_by_spec:[[:space:]]*\\(#[0-9][0-9]*\\)[[:space:]]*$/\\1/p' | head -n 1)",
  'printf \'AUTHORIZED=<%s>\\n\' "$REPAIR_TARGET_AUTHORIZED"',
  '',
].join('\n');

const REPLAY_DECIDE_TEXT = [
  'push_target: feature-branch: feat/should-not-mint',
  'repair_target_pr: #7',
  'repair_target_branch: feat/x',
  'repo: thinmansoftware/bdc-harness',
  'repair_target_authorized_by_spec: #7',
].join('\n');

describe('repair-target lane wiring', () => {
  it('Replay Test 1: the old quoted-heredoc capture yields an empty authorization', () => {
    const oldCapture = [
      'set -euo pipefail',
      "DECIDE_OUTPUT=$(cat <<'BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET_20260719_013'",
      '$decide-push-target.output',
      'BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET_20260719_013',
      ')',
      '',
    ].join('\n');
    const nodeOutputs = new Map<string, NodeOutput>([
      ['decide-push-target', { state: 'completed', output: REPLAY_DECIDE_TEXT }],
    ]);
    const substituted = substituteNodeOutputRefs(oldCapture, nodeOutputs, true);
    expect(substituted).toContain("repair_target_authorized_by_spec: #7'");
    const result = runBash(substituted + AUTH_PARSER, REPO_ROOT);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('AUTHORIZED=<>');
  });

  it('Replay Test 2: node-out capture authorizes #7 and reaches UNIQUE_BRANCH', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'repair-target-replay-'));
    const nodeOut = join(fixture, 'node-out');
    const fakeBin = join(fixture, 'bin');
    try {
      for (const dir of [nodeOut, fakeBin]) Bun.spawnSync(['mkdir', '-p', dir]);
      Bun.spawnSync(['git', 'init', '--initial-branch=main'], { cwd: fixture });
      Bun.spawnSync(['git', 'config', 'user.email', 'test@test.com'], { cwd: fixture });
      Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: fixture });
      writeFileSync(join(fixture, 'README.md'), 'init\n');
      Bun.spawnSync(['git', 'add', 'README.md'], { cwd: fixture });
      Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: fixture });
      const headOid = runBash('git rev-parse HEAD', fixture).stdout.trim();
      Bun.spawnSync(['git', 'init', '--bare', join(fixture, 'origin')]);
      Bun.spawnSync(['git', 'remote', 'add', 'origin', join(fixture, 'origin')], { cwd: fixture });
      Bun.spawnSync(['git', 'push', 'origin', 'HEAD:feat/x'], { cwd: fixture });
      writeFileSync(join(nodeOut, 'decide-push-target.out'), REPLAY_DECIDE_TEXT);
      writeFileSync(
        join(nodeOut, 'plan-review.out'),
        '=== APPROVED_PLAN_BEGIN ===\nCommit message: fix: x\nrepair_target_authorized_by_spec: #7\n=== APPROVED_PLAN_END ===\n'
      );
      writeFileSync(
        join(fakeBin, 'gh'),
        `#!/bin/sh
filter=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--jq" ]; then filter=$2; break; fi
  shift
done
[ -n "$filter" ] || exit 2
printf '%s\\n' '${JSON.stringify({ state: 'OPEN', headRefName: 'feat/x', isCrossRepository: false, headRepositoryOwner: { login: 'thinmansoftware' }, headRepository: { name: 'bdc-harness' }, headRefOid: headOid })}' | jq -r "$filter"
`
      );
      chmodSync(join(fakeBin, 'gh'), 0o755);

      const nodes = nodesOf('bdc-feature-development.yaml');
      const commitBash =
        nodeOf(nodes, 'commit-and-push', 'bdc-feature-development.yaml').bash ?? '';
      const captureEnd = 'PLAN_REVIEW_RAW=$(cat "$PLAN_REVIEW_OUT_FILE")';
      const capture = commitBash.slice(0, commitBash.indexOf(captureEnd) + captureEnd.length);
      const guardStart = "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')";
      const guardEnd = '\ngit status --short';
      let guard = commitBash.slice(commitBash.indexOf(guardStart), commitBash.indexOf(guardEnd));
      guard = guard
        .replace('SPEC_TEXT=$read-spec.output', 'SPEC_TEXT="${SPEC_TEXT-}"')
        .replace(
          'CHECKOUT_OUTPUT=$checkout-repair-target.output',
          'CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"'
        );
      const result = runBash(
        `${capture}\n${guard}\necho "UNIQUE_BRANCH=$UNIQUE_BRANCH"\n`,
        fixture,
        {
          ARCHON_NODE_OUT: nodeOut,
          SPEC_TEXT: 'WO: WO-TEST\nRepair target: PR #7 (branch feat/x)',
          CHECKOUT_OUTPUT: `REPAIR_TARGET_LEASE_SHA=${headOid}`,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        }
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('UNIQUE_BRANCH=feat/x');
      expect(result.stdout).not.toContain('repair_target_unauthorized');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

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

  it('Test 7: repair-path-hotfix wiring (node-out captures, when-guards, idle timeouts)', () => {
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      const nodes = nodesOf(file);

      // 1a: exactly two node-out reads of decide-push-target.out and no old decide heredoc.
      expect(yaml.split('ARCHON_NODE_OUT/decide-push-target.out').length - 1, file).toBe(2);
      expect(yaml, file).not.toContain('BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET');

      // 1a: commit-and-push reads both node-output files with explicit non-empty fail-closed checks.
      const commit = nodeOf(nodes, 'commit-and-push', file);
      const commitBash = commit.bash ?? '';
      expect(commitBash, file).toContain(
        'DECIDE_OUT_FILE="$ARCHON_NODE_OUT/decide-push-target.out"'
      );
      expect(commitBash, file).toContain('DECIDE_OUTPUT=$(cat "$DECIDE_OUT_FILE")');
      expect(commitBash, file).toContain('if [ ! -s "$DECIDE_OUT_FILE" ]; then');
      expect(commitBash, file).toContain('PLAN_REVIEW_OUT_FILE="$ARCHON_NODE_OUT/plan-review.out"');
      expect(commitBash, file).toContain('PLAN_REVIEW_RAW=$(cat "$PLAN_REVIEW_OUT_FILE")');
      expect(commitBash, file).toContain('if [ ! -s "$PLAN_REVIEW_OUT_FILE" ]; then');

      // 1f: head-moved guard adopts an ancestor live OID instead of refusing.
      expect(commitBash, file).toContain(
        'if git merge-base --is-ancestor "$REPAIR_TARGET_LIVE_OID" HEAD; then'
      );
      expect(commitBash, file).toContain('repair_target_head_moved');

      // 1b: plan-review when-guard fails a failed checkout at the real node.
      const planReview = nodeOf(nodes, 'plan-review', file);
      expect(planReview.when ?? '', file).toContain("$checkout-repair-target.output != ''");

      // 1d: patch-pr-body when-guard requires an open PR.
      const patch = nodeOf(nodes, 'patch-pr-body', file);
      expect(patch.when ?? '', file).toContain("$open-pr-if-needed.output != ''");

      // 1c: implement idle_timeout only on cursor and grok (diff-repair already carries one,
      // so those two lanes have exactly two occurrences of idle_timeout: 570000).
      if (
        file === 'bdc-feature-development-cursor.yaml' ||
        file === 'bdc-feature-development-grok.yaml'
      ) {
        expect(yaml.split('idle_timeout: 570000').length - 1, file).toBe(2);
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
