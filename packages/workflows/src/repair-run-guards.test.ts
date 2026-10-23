import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { evaluateCondition } from './condition-evaluator';
import { parseWorkflow } from './loader';
import type { NodeOutput } from './schemas';

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

const NO_RESOLVE = new Set([
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero-claude.yaml',
]);

const EXAMPLE_BRANCH = 'feat/example-thread-0000000';
const EXAMPLE_PR = '9999';

const GUARDED_WHEN: Record<string, string> = {
  implement:
    "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $gate-already-satisfied.output.ALREADY_SATISFIED != 'true'",
  'checkpoint-push': "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes'",
  'diff-repair':
    "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $classify-diff-review.output.verdict == 'needs_revision'",
  'checkpoint-diff-repair': "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes'",
  'opus-repair':
    "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $block-classify.output.status == 'BLOCKED'",
  'apply-suggested-fix':
    "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $pause-gate.output.decision_verb == 'approve_with_fix'",
  'commit-and-push':
    "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $block-reclassify.output.status == 'PROCEED' || $repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $classify-apply-review.output.verdict == 'satisfied' || $repair-gate.output.REPAIR_GATE_ALLOW == 'yes' && $classify-opus-rereview.output.verdict == 'satisfied'",
  'open-pr-if-needed': "$repair-gate.output.REPAIR_GATE_ALLOW == 'yes'",
};

const LINE_START_RULE = 'first non-whitespace text on its line';

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly bash?: string;
  readonly prompt?: string;
  readonly when?: string;
  readonly trigger_rule?: string;
  readonly loop?: { readonly prompt?: string };
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function repairDeclaration(pr: string, branch: string): string {
  return 'Repair ' + `target: PR #${pr} (branch ${branch})`;
}

function readLane(file: string): string {
  return readFileSync(join(LANES_DIR, file), 'utf8');
}

function nodesOf(file: string): readonly LaneNode[] {
  const result = parseWorkflow(readLane(file), file);
  if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  return result.workflow.nodes as unknown as readonly LaneNode[];
}

function nodeOf(nodes: readonly LaneNode[], id: string, file: string): LaneNode {
  const found = nodes.find(node => node.id === id);
  if (!found) throw new Error(`${file}: missing ${id}`);
  return found;
}

function bash(script: string, cwd?: string, env: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rrg-'));
  const scriptPath = join(dir, 'run.sh');
  const childEnv = { ...process.env, ...env };
  if (process.platform === 'win32' && env.PATH !== undefined) {
    // Windows treats these keys as aliases; keep the explicit fixture PATH.
    for (const key of Object.keys(childEnv)) {
      if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete childEnv[key];
    }
  }
  try {
    writeFileSync(scriptPath, script);
    const result = Bun.spawnSync(['bash', scriptPath], {
      cwd,
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function writeAuthority(dir: string, spec: string): string {
  const authority = join(dir, 'authority');
  mkdirSync(authority, { recursive: true });
  const specPath = join(authority, 'work-order.md');
  writeFileSync(specPath, spec);
  return dir;
}

function heavySpec(declaration: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 25; i++) {
    lines.push(`note ${i} don't break 'quoted' values ` + 'x'.repeat(800));
  }
  lines.push(declaration);
  const text = lines.join('\n') + '\n';
  if (Buffer.byteLength(text) < 20 * 1024) throw new Error('spec shorter than 20KB');
  const quoteLines = text.split('\n').filter(line => line.includes("'")).length;
  if (quoteLines < 19) throw new Error(`only ${quoteLines} single-quote lines`);
  return text;
}

function decideOutput(pr: string, branch: string, authorized: string | undefined): string {
  const lines = [
    `push_target: feature-branch: ${branch}`,
    `repair_target_pr: #${pr}`,
    `repair_target_branch: ${branch}`,
    'repo: thinmansoftware/bdc-harness',
  ];
  if (authorized !== undefined) lines.push(`repair_target_authorized_by_spec: #${authorized}`);
  return lines.join('\n');
}

function approvedPlan(pr: string): string {
  return [
    'Reviewer critique before the fence.',
    '=== APPROVED_PLAN_BEGIN ===',
    'Commit message: fix: example',
    `repair_target_authorized_by_spec: #${pr}`,
    '=== APPROVED_PLAN_END ===',
    'Reviewer critique after the fence.',
  ].join('\n');
}

function extractAuthBlock(commitBash: string): string {
  const start = commitBash.indexOf('RUN_AUTHORITY_SPEC=');
  const end = commitBash.indexOf('REPO_FOR_CHECK=', start);
  if (start < 0 || end < 0) throw new Error('authorization block markers missing');
  let block = commitBash.slice(start, end);
  if (!block.includes('if [ "$REPAIR_TARGET_PR_PRESENT"')) {
    throw new Error('repair arm missing from authorization block');
  }
  block = block.replace(
    'CHECKOUT_OUTPUT=$checkout-repair-target.output',
    'CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"'
  );
  return [
    'set -euo pipefail',
    'DECIDE_OUTPUT_CLEAN="$DECIDE_OUTPUT"',
    'PLAN_REVIEW_RAW="$PLAN_REVIEW_RAW"',
    block.trimEnd(),
    'exit 0',
    'fi',
    '',
  ].join('\n');
}

function runAuth(commitBash: string, spec: string, decide: string, plan: string): RunResult {
  const artifacts = mkdtempSync(join(tmpdir(), 'rrg-auth-'));
  const bin = mkdtempSync(join(tmpdir(), 'rrg-gh-'));
  try {
    writeAuthority(artifacts, spec);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'gh'), 0o755);
    return bash(extractAuthBlock(commitBash), undefined, {
      ARTIFACTS_DIR: artifacts,
      DECIDE_OUTPUT: decide,
      PLAN_REVIEW_RAW: plan,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    });
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

function runRepairGate(
  gateBash: string,
  spec: string | undefined,
  outs: Record<string, string>
): RunResult {
  const artifacts = mkdtempSync(join(tmpdir(), 'rrg-gate-'));
  const nodeOut = mkdtempSync(join(tmpdir(), 'rrg-out-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rrg-cwd-'));
  try {
    if (spec !== undefined) writeAuthority(artifacts, spec);
    for (const [name, body] of Object.entries(outs)) {
      writeFileSync(join(nodeOut, name), body);
    }
    return bash(gateBash, cwd, {
      ARTIFACTS_DIR: artifacts,
      ARCHON_NODE_OUT: nodeOut,
    });
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(nodeOut, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

function gateJson(stdout: string): {
  REPAIR_GATE: string;
  REPAIR_GATE_ALLOW: string;
  REPAIR_GATE_REASON?: string;
} {
  const line = stdout.trim();
  return JSON.parse(line) as {
    REPAIR_GATE: string;
    REPAIR_GATE_ALLOW: string;
    REPAIR_GATE_REASON?: string;
  };
}

function outputMap(entries: Record<string, string>): Map<string, NodeOutput> {
  const map = new Map<string, NodeOutput>();
  for (const [id, output] of Object.entries(entries)) {
    map.set(id, { state: 'completed', output });
  }
  return map;
}

function runningAtoms(gate: string | undefined): Map<string, NodeOutput> {
  const entries: Record<string, string> = {
    'gate-already-satisfied': '{"ALREADY_SATISFIED":false,"PRECHECK_VERDICT":"needs-build"}',
    'classify-diff-review': '{"verdict":"needs_revision"}',
    'block-classify': '{"status":"BLOCKED"}',
    'pause-gate': '{"decision_verb":"approve_with_fix"}',
    'block-reclassify': '{"status":"PROCEED"}',
    'classify-apply-review': '{"verdict":"satisfied"}',
    'classify-opus-rereview': '{"verdict":"satisfied"}',
  };
  if (gate !== undefined) entries['repair-gate'] = gate;
  return outputMap(entries);
}

function assertGuarded(
  file: string,
  nodes: readonly LaneNode[],
  gate: string | undefined,
  allow: boolean
): void {
  const outputs = runningAtoms(gate);
  for (const [id, expectedWhen] of Object.entries(GUARDED_WHEN)) {
    const node = nodeOf(nodes, id, file);
    expect(node.when, `${file} ${id}`).toBe(expectedWhen);
    expect(node.depends_on ?? [], `${file} ${id}`).toContain('repair-gate');
    expect((node.depends_on ?? [])[(node.depends_on ?? []).length - 1], `${file} ${id}`).toBe(
      'repair-gate'
    );
    const evaluated = evaluateCondition(node.when ?? '', outputs);
    expect(evaluated.parsed, `${file} ${id}`).toBe(true);
    expect(evaluated.result, `${file} ${id}`).toBe(allow);
  }
  if (file === 'bdc-feature-development-fusion-cx-kimi.yaml') {
    expect(nodeOf(nodes, 'diff-repair', file).depends_on ?? []).not.toContain(
      'resolve-review-base'
    );
  }
}

describe('repair run guards', () => {
  it('single_quote_spec_authorizes_from_authority_file', () => {
    const spec = heavySpec(repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH));
    const decide = decideOutput(EXAMPLE_PR, EXAMPLE_BRANCH, EXAMPLE_PR);
    const plan = approvedPlan(EXAMPLE_PR);
    for (const file of EXPECTED_LANES) {
      const commit = nodeOf(nodesOf(file), 'commit-and-push', file);
      expect(commit.bash ?? '', file).not.toContain('SPEC_TEXT=$read-spec.output');
      const result = runAuth(commit.bash ?? '', spec, decide, plan);
      expect(result.exitCode, `${file}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout, file).not.toContain('repair_target_unauthorized');
      expect(result.stderr, file).not.toContain('repair_target_unauthorized');
      expect(result.stdout, file).toContain(`repair_target_plan_authorization: ok #${EXAMPLE_PR}`);
    }
  });

  describe('each_refusal_names_its_condition_on_stderr', () => {
    const branch = EXAMPLE_BRANCH;
    const matching = heavySpec(repairDeclaration(EXAMPLE_PR, branch));
    const cases: Array<{
      name: string;
      spec: string;
      decide: string;
      plan: string;
      token: string;
    }> = [
      {
        name: 'decide_authorized_missing',
        spec: matching,
        decide: decideOutput(EXAMPLE_PR, branch, undefined),
        plan: approvedPlan(EXAMPLE_PR),
        token: 'condition=decide_authorized_missing',
      },
      {
        name: 'decide_authorized_pr_mismatch',
        spec: matching,
        decide: decideOutput(EXAMPLE_PR, branch, '1214'),
        plan: approvedPlan(EXAMPLE_PR),
        token: 'condition=decide_authorized_pr_mismatch',
      },
      {
        name: 'spec_pr_mismatch',
        spec: heavySpec(repairDeclaration('1214', branch)),
        decide: decideOutput(EXAMPLE_PR, branch, EXAMPLE_PR),
        plan: approvedPlan(EXAMPLE_PR),
        token: 'condition=spec_pr_mismatch',
      },
      {
        name: 'spec_branch_mismatch',
        spec: heavySpec(repairDeclaration(EXAMPLE_PR, 'feat/other-branch')),
        decide: decideOutput(EXAMPLE_PR, branch, EXAMPLE_PR),
        plan: approvedPlan(EXAMPLE_PR),
        token: 'condition=spec_branch_mismatch',
      },
      {
        name: 'plan_authorization',
        spec: matching,
        decide: decideOutput(EXAMPLE_PR, branch, EXAMPLE_PR),
        plan: 'The approved-plan fence is absent from this review.',
        token: 'condition=plan_authorization',
      },
    ];
    // Each refusal still runs against every lane, with its own timeout budget.
    for (const item of cases) {
      it(item.name, () => {
        for (const file of EXPECTED_LANES) {
          const commit = nodeOf(nodesOf(file), 'commit-and-push', file);
          const result = runAuth(commit.bash ?? '', item.spec, item.decide, item.plan);
          const label = `${file} ${item.name}\n${result.stdout}\n${result.stderr}`;
          expect(result.exitCode, label).toBe(1);
          expect(result.stdout, label).toContain('repair_target_unauthorized');
          expect(result.stderr, label).toContain(`repair_target_unauthorized: ${item.token}`);
          if (item.name === 'plan_authorization')
            expect(result.stderr, label).toContain('fence_count');
          if (item.name === 'decide_authorized_pr_mismatch') {
            expect(result.stderr, label).toContain('#1214');
            expect(result.stderr, label).toContain(`#${EXAMPLE_PR}`);
          }
          if (item.name === 'spec_pr_mismatch') {
            expect(result.stderr, label).toContain('1214');
            expect(result.stderr, label).toContain(EXAMPLE_PR);
          }
          if (item.name === 'spec_branch_mismatch') {
            expect(result.stderr, label).toContain('feat/other-branch');
            expect(result.stderr, label).toContain(branch);
          }
        }
      });
    }
  });

  it('implement_skipped_when_checkout_repair_target_fails', () => {
    const spec = heavySpec(repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH));
    const closed =
      '{"REPAIR_GATE":"closed","REPAIR_GATE_ALLOW":"no","REPAIR_GATE_REASON":"checkout_failed"}';
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const fail = nodeOf(nodes, 'repair-gate-fail', file);
      const result = runRepairGate(gate.bash ?? '', spec, { 'plan-review.out': '' });
      const label = `${file}\n${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, label).toBe(0);
      const parsed = gateJson(result.stdout);
      expect(parsed.REPAIR_GATE, label).toBe('closed');
      expect(parsed.REPAIR_GATE_REASON, label).toBe('checkout_failed');
      expect(result.stderr, label).toContain('checkout_failed');
      assertGuarded(file, nodes, result.stdout.trim(), false);
      const failWhen = evaluateCondition(
        fail.when ?? '',
        outputMap({ 'repair-gate': result.stdout.trim() })
      );
      expect(failWhen.result, file).toBe(true);
      const failRun = runRepairGate(fail.bash ?? '', undefined, { 'repair-gate.out': closed });
      expect(failRun.exitCode, file).toBe(1);
      expect(failRun.stderr, file).toContain('repair_gate_closed: checkout_failed');
    }
  });

  it('plan_review_not_approved_closes_gate', () => {
    const spec = heavySpec(repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH));
    const checkout = `REPAIR_TARGET=#${EXAMPLE_PR}\nREPAIR_TARGET_BRANCH=${EXAMPLE_BRANCH}\n`;
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const skipped = runRepairGate(gate.bash ?? '', spec, {
        'checkout-repair-target.out': checkout,
      });
      expect(gateJson(skipped.stdout).REPAIR_GATE_REASON, file).toBe('plan_review_skipped');
      const rejected = runRepairGate(gate.bash ?? '', spec, {
        'checkout-repair-target.out': checkout,
        'plan-review.out': 'PLAN_REVIEW_PASS=false\n',
      });
      expect(gateJson(rejected.stdout).REPAIR_GATE_REASON, file).toBe('plan_review_not_approved');
      const implement = nodeOf(nodes, 'implement', file);
      const evaluated = evaluateCondition(
        implement.when ?? '',
        runningAtoms(rejected.stdout.trim())
      );
      expect(evaluated.result, file).toBe(false);
    }
  });

  it('non_repair_run_unaffected', () => {
    const plain = 'WO: EXAMPLE\nObjective: ordinary build with no declaration line.\n';
    const declared = `WO: EXAMPLE\n${repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH)}\n`;
    const checkout = `REPAIR_TARGET=#${EXAMPLE_PR}\n`;
    const approved = 'PLAN_REVIEW_PASS=true\n';
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const na = runRepairGate(gate.bash ?? '', plain, {});
      expect(gateJson(na.stdout), file).toEqual({ REPAIR_GATE: 'n/a', REPAIR_GATE_ALLOW: 'yes' });
      const implement = nodeOf(nodes, 'implement', file);
      const normal = evaluateCondition(implement.when ?? '', runningAtoms(na.stdout.trim()));
      expect(normal.result, file).toBe(true);
      const opened = runRepairGate(gate.bash ?? '', declared, {
        'checkout-repair-target.out': checkout,
        'plan-review.out': approved,
      });
      expect(gateJson(opened.stdout).REPAIR_GATE, file).toBe('open');
      const openEval = evaluateCondition(implement.when ?? '', runningAtoms(opened.stdout.trim()));
      expect(openEval.result, file).toBe(true);
    }
  });

  it('repair_checkout_resets_stale_upstream', () => {
    const origin = mkdtempSync(join(tmpdir(), 'rrg-origin-'));
    const work = mkdtempSync(join(tmpdir(), 'rrg-wt-'));
    const bin = mkdtempSync(join(tmpdir(), 'rrg-gh-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'rrg-art-'));
    try {
      git(['init', '--bare', '--initial-branch=main', origin], tmpdir());
      git(['clone', origin, work], tmpdir());
      git(['config', 'user.email', 'test@test.com'], work);
      git(['config', 'user.name', 'Test'], work);
      writeFileSync(join(work, 'README.md'), 'init\n');
      git(['add', 'README.md'], work);
      git(['commit', '-m', 'init'], work);
      git(['push', 'origin', 'main'], work);
      writeFileSync(join(work, 'old.txt'), 'old\n');
      git(['add', 'old.txt'], work);
      git(['commit', '-m', 'old'], work);
      git(['push', 'origin', 'HEAD:wip/old'], work);
      writeFileSync(join(work, 'new.txt'), 'new\n');
      git(['add', 'new.txt'], work);
      git(['commit', '-m', 'tip'], work);
      git(['push', 'origin', `HEAD:${EXAMPLE_BRANCH}`], work);
      const tip = git(['rev-parse', 'HEAD'], work).trim();
      const githubOrigin = 'https://github.com/thinmansoftware/bdc-harness.git';
      git(['remote', 'set-url', 'origin', githubOrigin], work);
      git(['config', '--local', `url.${origin}.insteadOf`, githubOrigin], work);
      git(['config', `branch.${EXAMPLE_BRANCH}.remote`, 'origin'], work);
      git(['config', `branch.${EXAMPLE_BRANCH}.merge`, 'refs/heads/wip/old'], work);
      writeFileSync(
        join(bin, 'gh'),
        [
          '#!/bin/sh',
          'printf "%s\\t%s\\tfalse\\tthinmansoftware\\tbdc-harness\\t%s\\n" "$FAKE_GH_STATE" "$FAKE_GH_BRANCH" "$FAKE_GH_HEAD_OID"',
          '',
        ].join('\n')
      );
      chmodSync(join(bin, 'gh'), 0o755);
      writeAuthority(artifacts, `WO: EXAMPLE\n${repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH)}\n`);
      const inheritedBin = join(artifacts, 'inherited-bin');
      mkdirSync(inheritedBin);
      writeFileSync(join(inheritedBin, 'gh'), '#!/bin/sh\nexit 97\n');
      chmodSync(join(inheritedBin, 'gh'), 0o755);
      for (const file of EXPECTED_LANES) {
        const nodes = nodesOf(file);
        git(['config', `branch.${EXAMPLE_BRANCH}.remote`, 'origin'], work);
        git(['config', `branch.${EXAMPLE_BRANCH}.merge`, 'refs/heads/wip/old'], work);
        const checkout = nodeOf(nodes, 'checkout-repair-target', file);
        const result = bash(checkout.bash ?? '', work, {
          ARTIFACTS_DIR: artifacts,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          // A competing Windows spelling must not hide the fixture's gh.
          pAtH: `${inheritedBin}${delimiter}${process.env.PATH ?? ''}`,
          FAKE_GH_STATE: 'OPEN',
          FAKE_GH_BRANCH: EXAMPLE_BRANCH,
          FAKE_GH_HEAD_OID: tip,
        });
        const label = `${file}\n${result.stdout}\n${result.stderr}`;
        expect(result.exitCode, label).toBe(0);
        expect(result.stdout, label).toContain(`REPAIR_TARGET_UPSTREAM=origin/${EXAMPLE_BRANCH}`);
        const upstream = git(
          ['rev-parse', '--abbrev-ref', `${EXAMPLE_BRANCH}@{upstream}`],
          work
        ).trim();
        expect(upstream, label).toBe(`origin/${EXAMPLE_BRANCH}`);
        expect(nodeOf(nodes, 'checkpoint-push', file).bash ?? '', file).not.toContain('push -u');
      }
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    }
  });

  it('no_lane_substitutes_spec_text', () => {
    const codexGate = nodeOf(
      nodesOf('bdc-feature-development-codex.yaml'),
      'repair-gate',
      'codex'
    ).bash;
    const codexFail = nodeOf(
      nodesOf('bdc-feature-development-codex.yaml'),
      'repair-gate-fail',
      'codex'
    ).bash;
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      const nodes = nodesOf(file);
      expect(yaml, file).not.toContain('SPEC_TEXT=$read-spec.output');
      expect(yaml, file).toContain('_RS_OUT=$read-spec.output');
      for (const id of ['checkout-repair-target', 'commit-and-push', 'repair-gate']) {
        expect(nodeOf(nodes, id, file).bash ?? '', `${file} ${id}`).toContain(
          'RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"'
        );
      }
      if (NO_RESOLVE.has(file)) {
        expect(
          nodes.some(node => node.id === 'resolve-review-base'),
          file
        ).toBe(false);
      } else {
        expect(nodeOf(nodes, 'resolve-review-base', file).bash ?? '', file).toContain(
          'RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"'
        );
      }
      expect(nodeOf(nodes, 'repair-gate', file).bash, file).toBe(codexGate);
      expect(nodeOf(nodes, 'repair-gate-fail', file).bash, file).toBe(codexFail);
      expect(nodeOf(nodes, 'repair-gate', file).depends_on, file).toEqual([
        'checkout-repair-target',
        'plan-review',
      ]);
      expect(nodeOf(nodes, 'repair-gate', file).trigger_rule, file).toBe('all_done');
      expect(nodeOf(nodes, 'repair-gate-fail', file).trigger_rule, file).toBe('all_done');
      expect(nodeOf(nodes, 'repair-gate-fail', file).when, file).toBe(
        "$repair-gate.output.REPAIR_GATE_ALLOW != 'yes'"
      );
    }
  });

  it('gate_fails_closed_when_gate_output_missing', () => {
    const spec = heavySpec(repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH));
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const missing = runRepairGate(gate.bash ?? '', undefined, {});
      expect(missing.exitCode, file).toBe(1);
      expect(missing.stderr, file).toContain('scope_authority_missing');
      expect(missing.stdout, file).not.toContain('REPAIR_GATE');
      const emptyArtifacts = mkdtempSync(join(tmpdir(), 'rrg-empty-'));
      try {
        mkdirSync(join(emptyArtifacts, 'authority'));
        writeFileSync(join(emptyArtifacts, 'authority', 'work-order.md'), '');
        const empty = bash(gate.bash ?? '', undefined, { ARTIFACTS_DIR: emptyArtifacts });
        expect(empty.exitCode, `${file} ${empty.stderr}`).toBe(1);
        expect(empty.stderr, file).toContain('scope_authority_missing');
        expect(empty.stdout, file).not.toContain('REPAIR_GATE');
      } finally {
        rmSync(emptyArtifacts, { recursive: true, force: true });
      }
      assertGuarded(file, nodes, undefined, false);
      const fail = nodeOf(nodes, 'repair-gate-fail', file);
      const failWhen = evaluateCondition(fail.when ?? '', runningAtoms(undefined));
      expect(failWhen.parsed, file).toBe(true);
      expect(failWhen.result, file).toBe(true);
      const failRun = runRepairGate(fail.bash ?? '', spec, {});
      expect(failRun.exitCode, file).toBe(1);
      expect(failRun.stderr, file).toContain('repair_gate_closed: gate_output_missing');
    }
  });

  it('repair_target_only_declared_at_line_start', () => {
    const inline = [
      'This prose mentions a ' + repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH) + ' inline.',
      'See `' + repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH) + '` in the notes.',
      '| cell | ' + repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH) + ' |',
    ].join('\n');
    const declared = `WO: EXAMPLE\n${repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH)}\n`;
    const parsedPr = (line: string, spec: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'rrg-spec-'));
      try {
        const specFile = join(dir, 'spec.md');
        writeFileSync(specFile, spec);
        const script = [
          'set -euo pipefail',
          'SPEC_TEXT=$(cat "$SPEC_FILE")',
          line,
          'printf "%s" "$SPEC_REPAIR_PR"',
          '',
        ].join('\n');
        const result = bash(script, undefined, { SPEC_FILE: specFile });
        if (result.exitCode !== 0) throw new Error(result.stderr);
        return result.stdout;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const checkout = nodeOf(nodes, 'checkout-repair-target', file);
      const commit = nodeOf(nodes, 'commit-and-push', file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      for (const bashBody of [checkout.bash ?? '', commit.bash ?? '', gate.bash ?? '']) {
        const line = bashBody.split('\n').find(item => item.includes('SPEC_REPAIR_PR=$(printf'));
        if (!line) throw new Error(`${file}: SPEC_REPAIR_PR parser missing`);
        expect(parsedPr(line.trim(), inline), file).toBe('');
        expect(parsedPr(line.trim(), declared), file).toBe(EXAMPLE_PR);
      }
      const none = runRepairGate(checkout.bash ?? '', inline, {});
      expect(none.stdout, `${file}\n${none.stderr}`).toContain('REPAIR_TARGET=none');
      const na = runRepairGate(gate.bash ?? '', inline, {});
      expect(gateJson(na.stdout).REPAIR_GATE, file).toBe('n/a');
      const opened = runRepairGate(gate.bash ?? '', declared, {
        'checkout-repair-target.out': `REPAIR_TARGET=#${EXAMPLE_PR}\n`,
        'plan-review.out': 'PLAN_REVIEW_PASS=true\n',
      });
      expect(gateJson(opened.stdout).REPAIR_GATE, file).toBe('open');
      expect(nodeOf(nodes, 'decide-push-target', file).prompt ?? '', file).toContain(
        LINE_START_RULE
      );
      expect(nodeOf(nodes, 'plan-review', file).loop?.prompt ?? '', file).toContain(
        LINE_START_RULE
      );
    }
  });

  it('standalone_false_before_large_plan_cannot_open_gate', () => {
    const spec = heavySpec(repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH));
    const plan = 'PLAN_REVIEW_PASS=false\n' + 'x'.repeat(100000) + '\nPLAN_REVIEW_PASS=true\n';
    for (const file of EXPECTED_LANES) {
      const gate = nodeOf(nodesOf(file), 'repair-gate', file);
      const result = runRepairGate(gate.bash ?? '', spec, {
        'checkout-repair-target.out': `REPAIR_TARGET=#${EXAMPLE_PR}\n`,
        'plan-review.out': plan,
      });
      const parsed = gateJson(result.stdout);
      expect(parsed.REPAIR_GATE, file).toBe('closed');
      expect(parsed.REPAIR_GATE_ALLOW, file).toBe('no');
      expect(parsed.REPAIR_GATE_REASON, file).toBe('plan_review_not_approved');
    }
  });

  it('plan_review_quoted_pass_does_not_open_gate', () => {
    const spec = `WO: EXAMPLE\n${repairDeclaration(EXAMPLE_PR, EXAMPLE_BRANCH)}\n`;
    const checkout = `REPAIR_TARGET=#${EXAMPLE_PR}\n`;
    const cases: Array<{ name: string; plan: string; open: boolean }> = [
      {
        name: 'prose-then-false',
        plan: 'Do not emit PLAN_REVIEW_PASS=true\nPLAN_REVIEW_PASS=false\n',
        open: false,
      },
      {
        name: 'backticked-only',
        plan: 'The critique quoted `PLAN_REVIEW_PASS=true` inside a sentence.\n',
        open: false,
      },
      {
        name: 'true-then-false',
        plan: 'PLAN_REVIEW_PASS=true\nA later verdict follows.\nPLAN_REVIEW_PASS=false\n',
        open: false,
      },
      {
        name: 'standalone-true',
        plan: 'PLAN_REVIEW_RISK=LOW\nPLAN_REVIEW_PASS=true\n',
        open: true,
      },
    ];
    for (const file of EXPECTED_LANES) {
      const gate = nodeOf(nodesOf(file), 'repair-gate', file);
      for (const item of cases) {
        const result = runRepairGate(gate.bash ?? '', spec, {
          'checkout-repair-target.out': checkout,
          'plan-review.out': item.plan,
        });
        const parsed = gateJson(result.stdout);
        const label = `${file} ${item.name} ${result.stdout}`;
        if (item.open) {
          expect(parsed.REPAIR_GATE, label).toBe('open');
          expect(parsed.REPAIR_GATE_ALLOW, label).toBe('yes');
        } else {
          expect(parsed.REPAIR_GATE, label).toBe('closed');
          expect(parsed.REPAIR_GATE_REASON, label).toBe('plan_review_not_approved');
        }
      }
    }
  });
});
