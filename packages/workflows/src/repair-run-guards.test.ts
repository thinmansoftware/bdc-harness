import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { evaluateCondition } from './condition-evaluator';
import { parseWorkflow } from './loader';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();
const ROOT = join(import.meta.dir, '..', '..', '..');
const LANES = readdirSync(join(ROOT, '.archon/workflows/defaults'))
  .filter(file => /^bdc-feature-development(?:-[a-z0-9-]+)?\.yaml$/.test(file))
  .sort();
const GUARDED = [
  'implement',
  'checkpoint-push',
  'diff-repair',
  'checkpoint-diff-repair',
  'opus-repair',
  'apply-suggested-fix',
  'commit-and-push',
  'open-pr-if-needed',
];
interface Node {
  id: string;
  bash?: string;
  when?: string;
  depends_on?: string[];
}
function nodes(file: string): Node[] {
  const parsed = parseWorkflow(
    readFileSync(join(ROOT, '.archon/workflows/defaults', file), 'utf8'),
    file
  );
  if (!parsed.workflow) throw new Error(`${file}: ${parsed.error?.error}`);
  return parsed.workflow.nodes as Node[];
}
function node(file: string, id: string): Node {
  const found = nodes(file).find(candidate => candidate.id === id);
  if (!found) throw new Error(`${file}: missing ${id}`);
  return found;
}
function runGate(spec: string, checkout?: string, review?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-gate-'));
  const authority = join(dir, 'artifacts', 'authority');
  const out = join(dir, 'node-out');
  mkdirSync(authority, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(authority, 'work-order.md'), spec);
  if (checkout !== undefined) writeFileSync(join(out, 'checkout-repair-target.out'), checkout);
  if (review !== undefined) writeFileSync(join(out, 'plan-review.out'), review);
  try {
    const result = Bun.spawnSync(['bash', '-c', node(LANES[0], 'repair-gate').bash!], {
      cwd: dir,
      env: { ...process.env, ARTIFACTS_DIR: join(dir, 'artifacts'), ARCHON_NODE_OUT: out },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const repairSpec = 'WO_ID=WO-X\nRepair target: PR #1213 (branch feat/wo-x-thread-8915d6c1)\n';

describe('repair run guards', () => {
  it('single_quote_spec_authorizes_from_authority_file', () => {
    const large = `${repairSpec}${"don't use 'substituted' spec text\n".repeat(800)}`;
    expect(large.length).toBeGreaterThan(20_000);
    for (const file of LANES) {
      const bash = node(file, 'commit-and-push').bash!;
      expect(bash).toContain('SPEC_TEXT=$(cat "$RUN_AUTHORITY_SPEC")');
      expect(bash).toContain('repair_target_plan_authorization: ok #%s');
      expect(bash).not.toContain('SPEC_TEXT=$read-spec.output');
    }
  });
  it('each_refusal_names_its_condition_on_stderr', () => {
    const conditions = [
      'decide_authorized_missing',
      'decide_authorized_pr_mismatch',
      'spec_pr_mismatch',
      'spec_branch_mismatch',
      'plan_authorization',
    ];
    for (const file of LANES) {
      const bash = node(file, 'commit-and-push').bash!;
      for (const condition of conditions)
        expect(bash, `${file}: ${condition}`).toContain(
          `ERROR: repair_target_unauthorized: condition=${condition}`
        );
      expect(bash).toContain(
        "printf 'repair_target_plan_authorization_refused: fence_count\\n' >&2"
      );
    }
  });
  it('implement_skipped_when_checkout_repair_target_fails', () => {
    const result = runGate(repairSpec, undefined, '');
    expect(JSON.parse(result.stdout)).toEqual({
      REPAIR_GATE: 'closed',
      REPAIR_GATE_REASON: 'checkout_failed',
    });
    for (const file of LANES)
      for (const id of GUARDED) {
        const candidate = node(file, id);
        expect(candidate.depends_on).toContain('repair-gate');
        expect(candidate.when).toContain("$repair-gate.output.REPAIR_GATE != 'closed'");
        const output = new Map([['repair-gate', { output: result.stdout }]]) as Parameters<
          typeof evaluateCondition
        >[1];
        expect(evaluateCondition(candidate.when!, output).result, `${file}: ${id}`).toBe(false);
      }
    const fail = node(LANES[0], 'repair-gate-fail');
    const output = new Map([['repair-gate', { output: result.stdout }]]) as Parameters<
      typeof evaluateCondition
    >[1];
    expect(evaluateCondition(fail.when!, output).result).toBe(true);
  });
  it('plan_review_not_approved_closes_gate', () => {
    expect(JSON.parse(runGate(repairSpec, 'REPAIR_TARGET=#1213\n').stdout).REPAIR_GATE_REASON).toBe(
      'plan_review_skipped'
    );
    expect(
      JSON.parse(runGate(repairSpec, 'REPAIR_TARGET=#1213\n', 'PLAN_REVIEW_PASS=false\n').stdout)
        .REPAIR_GATE_REASON
    ).toBe('plan_review_not_approved');
  });
  it('non_repair_run_unaffected', () => {
    expect(JSON.parse(runGate('WO_ID=WO-X\n').stdout)).toEqual({ REPAIR_GATE: 'n/a' });
    expect(
      JSON.parse(runGate(repairSpec, 'REPAIR_TARGET=#1213\n', 'PLAN_REVIEW_PASS=true\n').stdout)
    ).toEqual({ REPAIR_GATE: 'open' });
  });
  it('repair_checkout_resets_stale_upstream', () => {
    for (const file of LANES) {
      const checkout = node(file, 'checkout-repair-target').bash!;
      expect(checkout).toContain(
        '+refs/heads/${SPEC_REPAIR_BRANCH}:refs/remotes/origin/${SPEC_REPAIR_BRANCH}'
      );
      expect(checkout).toContain('git branch --set-upstream-to="origin/${SPEC_REPAIR_BRANCH}"');
      expect(checkout).toContain('REPAIR_TARGET_UPSTREAM=origin/${SPEC_REPAIR_BRANCH}');
      expect(node(file, 'checkpoint-push').bash).not.toContain('git push -u origin');
    }
  });
  it('no_lane_substitutes_spec_text', () => {
    expect(LANES).toHaveLength(13);
    for (const file of LANES) {
      const yaml = readFileSync(join(ROOT, '.archon/workflows/defaults', file), 'utf8');
      expect(yaml).not.toContain('SPEC_TEXT=$read-spec.output');
      for (const id of ['checkout-repair-target', 'commit-and-push', 'repair-gate'])
        expect(node(file, id).bash, `${file}: ${id}`).toContain(
          'RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"'
        );
      const resolve = nodes(file).find(candidate => candidate.id === 'resolve-review-base');
      if (resolve)
        expect(resolve.bash).toContain(
          'RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"'
        );
    }
  });
});
