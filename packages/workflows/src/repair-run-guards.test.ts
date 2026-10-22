import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
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
function runScript(script: string, cwd: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bash', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function runGate(file: string, spec: string, checkout?: string, review?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-gate-'));
  const authority = join(dir, 'artifacts', 'authority');
  const out = join(dir, 'node-out');
  mkdirSync(authority, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(authority, 'work-order.md'), spec);
  if (checkout !== undefined) writeFileSync(join(out, 'checkout-repair-target.out'), checkout);
  if (review !== undefined) writeFileSync(join(out, 'plan-review.out'), review);
  try {
    return runScript(node(file, 'repair-gate').bash!, dir, {
      ARTIFACTS_DIR: join(dir, 'artifacts'),
      ARCHON_NODE_OUT: out,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const repairSpec = 'WO_ID=WO-X\nRepair target: PR #1213 (branch feat/wo-x-thread-8915d6c1)\n';
const decide = [
  'repair_target_pr: #1213',
  'repair_target_branch: feat/wo-x-thread-8915d6c1',
  'repair_target_authorized_by_spec: #1213',
  'repo: thinmansoftware/bdc-harness',
].join('\n');
const approvedPlan = [
  '=== APPROVED_PLAN_BEGIN ===',
  'repair_target_authorized_by_spec: #1213',
  '=== APPROVED_PLAN_END ===',
].join('\n');
function authorizationBlock(file: string): string {
  const bash = node(file, 'commit-and-push').bash!;
  const start = bash.indexOf('RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"');
  const end = bash.indexOf('REPO_FOR_CHECK=', start);
  if (start < 0 || end < 0) throw new Error(`${file}: authorization anchors missing`);
  return [
    'set -euo pipefail',
    'DECIDE_OUTPUT_CLEAN="$DECIDE_OUTPUT"',
    'PLAN_REVIEW_RAW="$PLAN_REVIEW_TEXT"',
    bash
      .slice(start, end)
      .replace('CHECKOUT_OUTPUT=$checkout-repair-target.output', 'CHECKOUT_OUTPUT='),
    'exit 0',
    'fi',
  ].join('\n');
}
function runAuthorization(file: string, spec: string, decideOutput: string, plan = approvedPlan) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-auth-'));
  const authority = join(dir, 'artifacts', 'authority');
  mkdirSync(authority, { recursive: true });
  writeFileSync(join(authority, 'work-order.md'), spec);
  try {
    return runScript(authorizationBlock(file), ROOT, {
      ARTIFACTS_DIR: join(dir, 'artifacts'),
      DECIDE_OUTPUT: decideOutput,
      PLAN_REVIEW_TEXT: plan,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('repair run guards', () => {
  it('single_quote_spec_authorizes_from_authority_file', () => {
    const large = `${repairSpec}${"don't use 'substituted' spec text\n".repeat(800)}`;
    expect(large.length).toBeGreaterThan(20_000);
    for (const file of LANES) {
      const result = runAuthorization(file, large, decide);
      expect(result.code, `${file}: ${result.stderr}`).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain('repair_target_unauthorized');
      expect(result.stdout).toContain('repair_target_plan_authorization: ok #1213');
    }
  });
  it('each_refusal_names_its_condition_on_stderr', () => {
    const large = `${repairSpec}${"don't use 'substituted' spec text\n".repeat(800)}`;
    const cases = [
      {
        condition: 'decide_authorized_missing',
        decide: decide.replace(/repair_target_authorized_by_spec: #1213\n/, ''),
      },
      {
        condition: 'decide_authorized_pr_mismatch',
        decide: decide.replace('authorized_by_spec: #1213', 'authorized_by_spec: #1214'),
      },
      { condition: 'spec_pr_mismatch', spec: large.replace('PR #1213', 'PR #1214') },
      {
        condition: 'spec_branch_mismatch',
        spec: large.replace('feat/wo-x-thread-8915d6c1', 'feat/different'),
      },
      { condition: 'plan_authorization', plan: 'approved prose without a fence' },
    ];
    for (const file of LANES) {
      for (const fixture of cases) {
        const result = runAuthorization(
          file,
          fixture.spec ?? large,
          fixture.decide ?? decide,
          fixture.plan ?? approvedPlan
        );
        expect(result.code, `${file}: ${fixture.condition}`).toBe(1);
        expect(result.stderr).toContain(
          `ERROR: repair_target_unauthorized: condition=${fixture.condition}`
        );
        if (fixture.condition === 'plan_authorization')
          expect(result.stderr).toContain('repair_target_plan_authorization_refused: fence_count');
      }
    }
  });
  it('implement_skipped_when_checkout_repair_target_fails', () => {
    for (const file of LANES) {
      const result = runGate(file, repairSpec, undefined, '');
      expect(JSON.parse(result.stdout)).toEqual({
        REPAIR_GATE: 'closed',
        REPAIR_GATE_REASON: 'checkout_failed',
      });
      for (const id of GUARDED) {
        const candidate = node(file, id);
        expect(candidate.depends_on).toContain('repair-gate');
        expect(candidate.when).toContain("$repair-gate.output.REPAIR_GATE != 'closed'");
        const output = new Map([['repair-gate', { output: result.stdout }]]) as Parameters<
          typeof evaluateCondition
        >[1];
        expect(evaluateCondition(candidate.when!, output).result, `${file}: ${id}`).toBe(false);
      }
      const fail = node(file, 'repair-gate-fail');
      const output = new Map([['repair-gate', { output: result.stdout }]]) as Parameters<
        typeof evaluateCondition
      >[1];
      expect(evaluateCondition(fail.when!, output).result, file).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), 'repair-gate-fail-'));
      try {
        writeFileSync(join(dir, 'repair-gate.out'), result.stdout);
        const failed = runScript(fail.bash!, dir, { ARCHON_NODE_OUT: dir });
        expect(failed.code, file).toBe(1);
        expect(failed.stderr).toContain('repair_gate_closed: checkout_failed');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it('plan_review_not_approved_closes_gate', () => {
    for (const file of LANES) {
      expect(
        JSON.parse(runGate(file, repairSpec, 'REPAIR_TARGET=#1213\n').stdout).REPAIR_GATE_REASON
      ).toBe('plan_review_skipped');
      const result = runGate(file, repairSpec, 'REPAIR_TARGET=#1213\n', 'PLAN_REVIEW_PASS=false\n');
      expect(JSON.parse(result.stdout).REPAIR_GATE_REASON).toBe('plan_review_not_approved');
      const output = new Map([['repair-gate', { output: result.stdout }]]) as Parameters<
        typeof evaluateCondition
      >[1];
      expect(evaluateCondition(node(file, 'implement').when!, output).result, file).toBe(false);
    }
  });
  it('non_repair_run_unaffected', () => {
    for (const file of LANES) {
      for (const result of [
        runGate(file, 'WO_ID=WO-X\n'),
        runGate(file, repairSpec, 'REPAIR_TARGET=#1213\n', 'PLAN_REVIEW_PASS=true\n'),
      ]) {
        expect(['n/a', 'open']).toContain(JSON.parse(result.stdout).REPAIR_GATE);
        const output = new Map([
          ['repair-gate', { output: result.stdout }],
          ['gate-already-satisfied', { output: 'ALREADY_SATISFIED=false' }],
        ]) as Parameters<typeof evaluateCondition>[1];
        expect(evaluateCondition(node(file, 'implement').when!, output).result, file).toBe(true);
      }
    }
  });
  it('repair_checkout_resets_stale_upstream', () => {
    for (const file of LANES) {
      const dir = mkdtempSync(join(tmpdir(), 'repair-checkout-'));
      const remote = join(dir, 'remote.git');
      const seed = join(dir, 'seed');
      const clone = join(dir, 'clone');
      const branch = 'feat/repair-test';
      const bin = join(dir, 'bin');
      const authority = join(dir, 'artifacts', 'authority');
      try {
        git(dir, 'init', '--bare', remote);
        git(dir, 'init', seed);
        git(seed, 'config', 'user.email', 'test@example.com');
        git(seed, 'config', 'user.name', 'Test');
        writeFileSync(join(seed, 'base.txt'), 'base\n');
        git(seed, 'add', 'base.txt');
        git(seed, 'commit', '-m', 'base');
        git(seed, 'branch', '-M', 'main');
        git(seed, 'remote', 'add', 'origin', remote);
        git(seed, 'push', 'origin', 'main');
        git(seed, 'checkout', '-b', branch);
        writeFileSync(join(seed, 'repair.txt'), 'repair\n');
        git(seed, 'add', 'repair.txt');
        git(seed, 'commit', '-m', 'repair');
        const repairOid = git(seed, 'rev-parse', 'HEAD');
        git(seed, 'push', 'origin', branch);
        git(seed, 'checkout', 'main');
        writeFileSync(join(seed, 'old.txt'), 'old\n');
        git(seed, 'add', 'old.txt');
        git(seed, 'commit', '-m', 'old upstream');
        git(seed, 'push', 'origin', 'HEAD:wip/old');
        git(dir, 'clone', remote, clone);
        git(clone, 'remote', 'set-url', 'origin', 'https://github.com/local/remote.git');
        git(
          clone,
          'config',
          'url.file://' + remote + '.insteadOf',
          'https://github.com/local/remote.git'
        );
        git(clone, 'config', 'user.email', 'test@example.com');
        git(clone, 'config', 'user.name', 'Test');
        git(clone, 'checkout', '-b', branch, `origin/${branch}`);
        git(clone, 'config', `branch.${branch}.remote`, 'origin');
        git(clone, 'config', `branch.${branch}.merge`, 'refs/heads/wip/old');
        git(clone, 'checkout', 'main');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'gh'),
          `#!/usr/bin/env bash\nprintf 'OPEN\\t${branch}\\tfalse\\tlocal\\tremote\\t${repairOid}\\n'\n`
        );
        chmodSync(join(bin, 'gh'), 0o755);
        mkdirSync(authority, { recursive: true });
        writeFileSync(
          join(authority, 'work-order.md'),
          `WO_ID=WO-X\nRepair target: PR #1213 (branch ${branch})\n`
        );
        const result = runScript(node(file, 'checkout-repair-target').bash!, clone, {
          ARTIFACTS_DIR: join(dir, 'artifacts'),
          PATH: `${bin}:${process.env.PATH}`,
        });
        expect(result.code, `${file}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toContain(`REPAIR_TARGET_UPSTREAM=origin/${branch}`);
        expect(git(clone, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), file).toBe(
          `origin/${branch}`
        );
        expect(node(file, 'checkpoint-push').bash).not.toContain('git push -u origin');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);
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
