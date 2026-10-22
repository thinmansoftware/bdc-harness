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
import { nodeOutputSchema, type NodeOutput } from './schemas/workflow-run';

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

const GUARDED = [
  'implement',
  'checkpoint-push',
  'diff-repair',
  'checkpoint-diff-repair',
  'opus-repair',
  'apply-suggested-fix',
  'commit-and-push',
  'open-pr-if-needed',
] as const;

const PR = '9999';
const BRANCH = 'feat/example-thread-0000000';
const SENTENCE =
  'A repair-target declaration is only a line whose first non-space text is Repair target followed by a colon. A mention inside backticks, a table cell, a prose sentence, or a test description is not a declaration.';

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly bash?: string;
  readonly prompt?: string;
  readonly when?: string;
  readonly trigger_rule?: string;
  readonly loop?: { readonly prompt?: string };
}

function readLane(file: string): string {
  return readFileSync(join(LANES_DIR, file), 'utf8');
}

function nodesOf(file: string): readonly LaneNode[] {
  const result = parseWorkflow(readLane(file), file);
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

function completed(output: string): NodeOutput {
  return nodeOutputSchema.parse({ state: 'completed', output });
}

function bash(
  script: string,
  env: Record<string, string>,
  cwd?: string
): { exitCode: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rrg-'));
  const scriptPath = join(dir, 'run.sh');
  try {
    writeFileSync(scriptPath, script);
    const result = Bun.spawnSync(['bash', scriptPath], {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(args: readonly string[], cwd: string): string {
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

function declaration(pr = PR, branch = BRANCH): string {
  return `Repair target: PR #${pr} (branch ${branch})`;
}

function authoritySpec(options?: { pr?: string; branch?: string; declare?: boolean }): string {
  const lines: string[] = [];
  for (let i = 1; i <= 19; i += 1) {
    lines.push(`quote-line ${i}: don't keep the 'quoted' example ${'x'.repeat(900)}`);
  }
  let text = lines.join('\n');
  while (Buffer.byteLength(text, 'utf8') < 20 * 1024) {
    text += `\nextra: don't keep the 'quoted' example ${'x'.repeat(900)}`;
  }
  if (options?.declare === false) return `${text}\n`;
  return `${text}\n${declaration(options?.pr ?? PR, options?.branch ?? BRANCH)}\n`;
}

function writeAuthority(root: string, spec: string): void {
  const dir = join(root, 'authority');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'work-order.md'), spec);
}

function decideOutput(options?: {
  includeAuthorized?: boolean;
  authorizedPr?: string;
  pr?: string;
  branch?: string;
}): string {
  const pr = options?.pr ?? PR;
  const branch = options?.branch ?? BRANCH;
  const lines = [`repair_target_pr: #${pr}`, `repair_target_branch: ${branch}`];
  if (options?.includeAuthorized !== false) {
    lines.push(`repair_target_authorized_by_spec: #${options?.authorizedPr ?? pr}`);
  }
  return `${lines.join('\n')}\n`;
}

function planRaw(pr = PR): string {
  return [
    'Reviewer critique before the fence.',
    '=== APPROVED_PLAN_BEGIN ===',
    `repair_target_authorized_by_spec: #${pr}`,
    '=== APPROVED_PLAN_END ===',
    'Reviewer critique after the fence.',
  ].join('\n');
}

function authorizationSlice(bashText: string): string {
  const start = bashText.indexOf('RUN_AUTHORITY_SPEC=');
  const repoAt = bashText.indexOf('REPO_FOR_CHECK=', start);
  if (start < 0 || repoAt < 0) throw new Error('authorization slice missing');
  const lineStart = bashText.lastIndexOf('\n', repoAt) + 1;
  let slice = bashText.slice(start, lineStart);
  const checkoutAssign = 'CHECKOUT_OUTPUT=$checkout-repair-target.output';
  if (!slice.includes(checkoutAssign)) throw new Error('checkout assignment missing from slice');
  slice = slice.replace(checkoutAssign, 'CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"');
  return `set -euo pipefail\n${slice}\nfi\nexit 0\n`;
}

function repairParse(bashText: string): string {
  const start = bashText.indexOf('RUN_AUTHORITY_SPEC=');
  const specTextAt = bashText.indexOf('SPEC_TEXT=$(cat "$RUN_AUTHORITY_SPEC")', start);
  const prAt = bashText.indexOf('SPEC_REPAIR_PR=', start);
  const branchAt = bashText.indexOf('SPEC_REPAIR_BRANCH=', start);
  if (start < 0 || specTextAt < 0 || prAt < 0) throw new Error('repair parse anchors missing');
  const authority = bashText.slice(start, bashText.indexOf('\n', specTextAt));
  const lines = [authority, bashText.slice(prAt, bashText.indexOf('\n', prAt))];
  if (branchAt > prAt) lines.push(bashText.slice(branchAt, bashText.indexOf('\n', branchAt)));
  const branchEcho =
    branchAt > prAt
      ? 'printf \'BRANCH=%s\\n\' "${SPEC_REPAIR_BRANCH-}"'
      : 'printf \'BRANCH=%s\\n\' ""';
  return `set -euo pipefail\n${lines.join('\n')}\nprintf 'PR=%s\\n' "\${SPEC_REPAIR_PR-}"\n${branchEcho}\n`;
}

function permissive(gateOutput?: string): Map<string, NodeOutput> {
  const outputs = new Map<string, NodeOutput>([
    [
      'gate-already-satisfied',
      completed('{"ALREADY_SATISFIED":false,"PRECHECK_VERDICT":"needs-build"}'),
    ],
    ['classify-diff-review', completed('{"verdict":"needs_revision"}')],
    ['block-classify', completed('{"status":"BLOCKED"}')],
    ['pause-gate', completed('{"decision_verb":"approve_with_fix"}')],
    ['block-reclassify', completed('{"status":"PROCEED"}')],
    ['classify-apply-review', completed('{"verdict":"satisfied"}')],
    ['classify-opus-rereview', completed('{"verdict":"satisfied"}')],
  ]);
  if (gateOutput !== undefined) outputs.set('repair-gate', completed(gateOutput));
  return outputs;
}

function show(result: { exitCode: number; stdout: string; stderr: string }, label: string): string {
  return `${label}\nexit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

function stubGh(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'rrg-gh-'));
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/bin/sh
filter=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--jq" ]; then filter=$2; break; fi
  shift
done
[ -n "$filter" ] || exit 2
printf '{"state":"%s","headRefName":"%s","isCrossRepository":false,"headRepositoryOwner":{"login":"thinmansoftware"},"headRepository":{"name":"bdc-harness"},"headRefOid":"%s"}\\n' \\
  "$FAKE_GH_STATE" "$FAKE_GH_BRANCH" "$FAKE_GH_OID" | jq -r "$filter"
`
  );
  chmodSync(ghPath, 0o755);
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}

function inlineSpec(): string {
  return [
    'WO: WO-HARNESS-REPAIR-RUN-GUARDS-01',
    'The incident notes `Repair target: PR #1214 (branch feat/not-a-declaration)` in backticks.',
    '| cell | Repair target: PR #1214 (branch feat/not-a-declaration) |',
    'A prose sentence mentions Repair target: PR #1214 (branch feat/not-a-declaration) without declaring one.',
    '',
  ].join('\n');
}

describe('repair run guards', () => {
  it('single_quote_spec_authorizes_from_authority_file', () => {
    const spec = authoritySpec();
    const quoteLines = spec.split('\n').filter(line => line.includes("'"));
    expect(quoteLines.length).toBeGreaterThanOrEqual(19);
    expect(Buffer.byteLength(spec, 'utf8')).toBeGreaterThanOrEqual(20 * 1024);
    expect(spec.split('\n').some(line => line === declaration())).toBe(true);
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const commit = nodeOf(nodes, 'commit-and-push', file);
      expect(commit.bash ?? '', file).not.toContain('SPEC_TEXT=$read-spec.output');
      const artifacts = mkdtempSync(join(tmpdir(), 'rrg-auth-'));
      try {
        writeAuthority(artifacts, spec);
        const result = bash(authorizationSlice(commit.bash ?? ''), {
          ARTIFACTS_DIR: artifacts,
          DECIDE_OUTPUT_CLEAN: decideOutput(),
          PLAN_REVIEW_RAW: planRaw(),
          PATH: stubGh(),
        });
        expect(result.exitCode, show(result, file)).toBe(0);
        expect(result.stdout, file).toContain(`repair_target_plan_authorization: ok #${PR}`);
        expect(result.stdout, file).not.toContain('repair_target_unauthorized');
        expect(result.stderr, file).not.toContain('repair_target_unauthorized');
      } finally {
        rmSync(artifacts, { recursive: true, force: true });
      }
    }
  });

  it('each_refusal_names_its_condition_on_stderr', () => {
    const cases: ReadonlyArray<{
      name: string;
      spec: string;
      decide: string;
      plan: string;
      extra: string;
    }> = [
      {
        name: 'decide_authorized_missing',
        spec: authoritySpec(),
        decide: decideOutput({ includeAuthorized: false }),
        plan: planRaw(),
        extra: '',
      },
      {
        name: 'decide_authorized_pr_mismatch',
        spec: authoritySpec(),
        decide: decideOutput({ authorizedPr: '1214' }),
        plan: planRaw(),
        extra: '',
      },
      {
        name: 'spec_pr_mismatch',
        spec: authoritySpec({ pr: '1214' }),
        decide: decideOutput(),
        plan: planRaw(),
        extra: '',
      },
      {
        name: 'spec_branch_mismatch',
        spec: authoritySpec({ branch: 'feat/other-thread-0000000' }),
        decide: decideOutput(),
        plan: planRaw(),
        extra: '',
      },
      {
        name: 'plan_authorization',
        spec: authoritySpec(),
        decide: decideOutput(),
        plan: 'no approved plan fence',
        extra: 'fence_count',
      },
    ];
    for (const file of EXPECTED_LANES) {
      const slice = authorizationSlice(nodeOf(nodesOf(file), 'commit-and-push', file).bash ?? '');
      for (const item of cases) {
        const artifacts = mkdtempSync(join(tmpdir(), 'rrg-refuse-'));
        try {
          writeAuthority(artifacts, item.spec);
          const result = bash(slice, {
            ARTIFACTS_DIR: artifacts,
            DECIDE_OUTPUT_CLEAN: item.decide,
            PLAN_REVIEW_RAW: item.plan,
            PATH: stubGh(),
          });
          const label = `${file} ${item.name}`;
          expect(result.exitCode, show(result, label)).toBe(1);
          const conditionLines = result.stderr
            .split('\n')
            .filter(line => line.includes('repair_target_unauthorized: condition='));
          expect(conditionLines, label).toHaveLength(1);
          expect(conditionLines[0], label).toContain(`condition=${item.name}`);
          for (const other of cases) {
            if (other.name !== item.name) {
              expect(result.stderr, label).not.toContain(`condition=${other.name}`);
            }
          }
          if (item.extra) expect(result.stderr, label).toContain(item.extra);
        } finally {
          rmSync(artifacts, { recursive: true, force: true });
        }
      }
    }
  });

  it('implement_skipped_when_checkout_repair_target_fails', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const artifacts = mkdtempSync(join(tmpdir(), 'rrg-gate-'));
      const nodeOut = mkdtempSync(join(tmpdir(), 'rrg-out-'));
      try {
        writeAuthority(artifacts, authoritySpec());
        writeFileSync(join(nodeOut, 'plan-review.out'), '');
        const gate = nodeOf(nodes, 'repair-gate', file);
        const result = bash(gate.bash ?? '', {
          ARTIFACTS_DIR: artifacts,
          ARCHON_NODE_OUT: nodeOut,
        });
        expect(result.exitCode, show(result, file)).toBe(0);
        expect(result.stdout, file).toContain('"REPAIR_GATE":"closed"');
        expect(result.stdout, file).toContain('"REPAIR_GATE_REASON":"checkout_failed"');
        expect(result.stderr, file).toContain('repair_gate_closed: checkout_failed');
        const outputs = permissive(result.stdout.trim());
        for (const id of GUARDED) {
          const node = nodeOf(nodes, id, file);
          expect(node.depends_on ?? [], `${file} ${id}`).toContain('repair-gate');
          expect(node.when, `${file} ${id}`).toBeDefined();
          expect(evaluateCondition(node.when ?? '', outputs).result, `${file} ${id}`).toBe(false);
        }
        const fail = nodeOf(nodes, 'repair-gate-fail', file);
        expect(fail.trigger_rule, file).toBe('all_done');
        expect(evaluateCondition(fail.when ?? '', outputs).result, file).toBe(true);
        writeFileSync(join(nodeOut, 'repair-gate.out'), result.stdout.trim());
        const failed = bash(fail.bash ?? '', { ARCHON_NODE_OUT: nodeOut });
        expect(failed.exitCode, show(failed, file)).toBe(1);
        expect(failed.stderr, file).toContain('repair_gate_closed: checkout_failed');
      } finally {
        rmSync(artifacts, { recursive: true, force: true });
        rmSync(nodeOut, { recursive: true, force: true });
      }
    }
  });

  it('plan_review_not_approved_closes_gate', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const implement = nodeOf(nodes, 'implement', file);
      for (const item of [
        { reason: 'plan_review_skipped', plan: undefined },
        { reason: 'plan_review_not_approved', plan: 'PLAN_REVIEW_PASS=false\n' },
      ] as const) {
        const artifacts = mkdtempSync(join(tmpdir(), 'rrg-plan-'));
        const nodeOut = mkdtempSync(join(tmpdir(), 'rrg-plan-out-'));
        try {
          writeAuthority(artifacts, authoritySpec());
          writeFileSync(
            join(nodeOut, 'checkout-repair-target.out'),
            `REPAIR_TARGET=#${PR}\nREPAIR_TARGET_BRANCH=${BRANCH}\n`
          );
          if (item.plan !== undefined) writeFileSync(join(nodeOut, 'plan-review.out'), item.plan);
          const result = bash(gate.bash ?? '', {
            ARTIFACTS_DIR: artifacts,
            ARCHON_NODE_OUT: nodeOut,
          });
          const label = `${file} ${item.reason}`;
          expect(result.exitCode, show(result, label)).toBe(0);
          expect(result.stdout, label).toContain('"REPAIR_GATE":"closed"');
          expect(result.stdout, label).toContain(`"REPAIR_GATE_REASON":"${item.reason}"`);
          expect(result.stderr, label).toContain(`repair_gate_closed: ${item.reason}`);
          const outputs = permissive(result.stdout.trim());
          expect(evaluateCondition(implement.when ?? '', outputs).result, label).toBe(false);
        } finally {
          rmSync(artifacts, { recursive: true, force: true });
          rmSync(nodeOut, { recursive: true, force: true });
        }
      }
    }
  });

  it('non_repair_run_unaffected', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const implement = nodeOf(nodes, 'implement', file);
      const plain = mkdtempSync(join(tmpdir(), 'rrg-plain-'));
      const open = mkdtempSync(join(tmpdir(), 'rrg-open-'));
      const openOut = mkdtempSync(join(tmpdir(), 'rrg-open-out-'));
      try {
        writeAuthority(plain, authoritySpec({ declare: false }));
        const na = bash(gate.bash ?? '', { ARTIFACTS_DIR: plain, ARCHON_NODE_OUT: openOut });
        expect(na.exitCode, show(na, file)).toBe(0);
        expect(na.stdout.trim(), file).toBe('{"REPAIR_GATE":"n/a","REPAIR_GATE_ALLOW":"yes"}');
        expect(
          evaluateCondition(implement.when ?? '', permissive(na.stdout.trim())).result,
          file
        ).toBe(true);

        writeAuthority(open, authoritySpec());
        writeFileSync(join(openOut, 'checkout-repair-target.out'), `REPAIR_TARGET=#${PR}\n`);
        writeFileSync(
          join(openOut, 'plan-review.out'),
          'PLAN_REVIEW_PASS=true\nPLAN_REVIEW_APPROVED\n'
        );
        const opened = bash(gate.bash ?? '', { ARTIFACTS_DIR: open, ARCHON_NODE_OUT: openOut });
        expect(opened.exitCode, show(opened, file)).toBe(0);
        expect(opened.stdout.trim(), file).toBe('{"REPAIR_GATE":"open","REPAIR_GATE_ALLOW":"yes"}');
        expect(
          evaluateCondition(implement.when ?? '', permissive(opened.stdout.trim())).result,
          file
        ).toBe(true);
      } finally {
        rmSync(plain, { recursive: true, force: true });
        rmSync(open, { recursive: true, force: true });
        rmSync(openOut, { recursive: true, force: true });
      }
    }
  });

  it('repair_checkout_resets_stale_upstream', () => {
    const origin = mkdtempSync(join(tmpdir(), 'rrg-origin-'));
    const clone = mkdtempSync(join(tmpdir(), 'rrg-clone-'));
    try {
      git(['init', '--bare', '--initial-branch=main', origin], tmpdir());
      git(['clone', origin, clone], tmpdir());
      git(['config', 'user.email', 'test@test.com'], clone);
      git(['config', 'user.name', 'Test'], clone);
      writeFileSync(join(clone, 'README.md'), 'init\n');
      git(['add', 'README.md'], clone);
      git(['commit', '-m', 'init'], clone);
      git(['branch', BRANCH], clone);
      git(['push', 'origin', 'main'], clone);
      git(['push', 'origin', BRANCH], clone);
      const live = git(['rev-parse', BRANCH], clone).trim();
      git(['checkout', '-b', 'wip/old'], clone);
      writeFileSync(join(clone, 'old.txt'), 'old\n');
      git(['add', 'old.txt'], clone);
      git(['commit', '-m', 'old wip'], clone);
      git(['push', 'origin', 'wip/old'], clone);
      const stale = git(['rev-parse', 'wip/old'], clone).trim();
      expect(stale).not.toBe(live);
      git(['checkout', 'main'], clone);
      const githubOrigin = 'https://github.com/thinmansoftware/bdc-harness.git';
      git(['remote', 'set-url', 'origin', githubOrigin], clone);
      git(['config', '--local', `url.${origin}.insteadOf`, githubOrigin], clone);
      const artifacts = mkdtempSync(join(tmpdir(), 'rrg-co-auth-'));
      writeAuthority(artifacts, authoritySpec());
      const pathEnv = stubGh();
      for (const file of EXPECTED_LANES) {
        git(['checkout', 'main'], clone);
        git(['config', `branch.${BRANCH}.remote`, 'origin'], clone);
        git(['config', `branch.${BRANCH}.merge`, 'refs/heads/wip/old'], clone);
        expect(git(['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`], clone).trim()).toBe(
          'origin/wip/old'
        );
        const checkout = nodeOf(nodesOf(file), 'checkout-repair-target', file);
        const result = bash(
          checkout.bash ?? '',
          {
            ARTIFACTS_DIR: artifacts,
            PATH: pathEnv,
            FAKE_GH_STATE: 'OPEN',
            FAKE_GH_BRANCH: BRANCH,
            FAKE_GH_OID: live,
          },
          clone
        );
        expect(result.exitCode, show(result, file)).toBe(0);
        expect(result.stdout, file).toContain(`REPAIR_TARGET_UPSTREAM=origin/${BRANCH}`);
        expect(git(['rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`], clone).trim(), file).toBe(
          `origin/${BRANCH}`
        );
        expect(git(['rev-parse', `${BRANCH}@{upstream}`], clone).trim(), file).toBe(live);
        const push = nodeOf(nodesOf(file), 'checkpoint-push', file);
        expect(push.bash ?? '', file).not.toContain('push -u');
      }
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('no_lane_substitutes_spec_text', () => {
    expect(EXPECTED_LANES).toHaveLength(13);
    for (const file of EXPECTED_LANES) {
      const yaml = readLane(file);
      expect(yaml, file).not.toContain('SPEC_TEXT=$read-spec.output');
      const nodes = nodesOf(file);
      const readers = ['checkout-repair-target', 'commit-and-push', 'repair-gate'];
      if (!NO_RESOLVE.has(file)) readers.push('resolve-review-base');
      for (const id of readers) {
        expect(nodeOf(nodes, id, file).bash ?? '', `${file} ${id}`).toContain(
          'RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"'
        );
      }
      const expected = NO_RESOLVE.has(file) ? 3 : 4;
      expect(
        yaml.split('RUN_AUTHORITY_SPEC="$ARTIFACTS_DIR/authority/work-order.md"').length - 1,
        file
      ).toBe(expected);
    }
  });

  it('gate_fails_closed_when_gate_output_missing', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const gate = nodeOf(nodes, 'repair-gate', file);
      const fail = nodeOf(nodes, 'repair-gate-fail', file);
      const missing = mkdtempSync(join(tmpdir(), 'rrg-missing-'));
      const emptyRoot = mkdtempSync(join(tmpdir(), 'rrg-empty-'));
      const nodeOut = mkdtempSync(join(tmpdir(), 'rrg-fail-out-'));
      try {
        const missingResult = bash(gate.bash ?? '', {
          ARTIFACTS_DIR: missing,
          ARCHON_NODE_OUT: nodeOut,
        });
        expect(missingResult.exitCode, show(missingResult, file)).toBe(1);
        expect(missingResult.stderr, file).toContain('scope_authority_missing');
        expect(missingResult.stdout, file).not.toContain('REPAIR_GATE');

        mkdirSync(join(emptyRoot, 'authority'), { recursive: true });
        writeFileSync(join(emptyRoot, 'authority', 'work-order.md'), '');
        const emptyResult = bash(gate.bash ?? '', {
          ARTIFACTS_DIR: emptyRoot,
          ARCHON_NODE_OUT: nodeOut,
        });
        expect(emptyResult.exitCode, show(emptyResult, file)).toBe(1);
        expect(emptyResult.stderr, file).toContain('ERROR: scope_authority_missing:');
        expect(emptyResult.stdout, file).not.toContain('REPAIR_GATE');

        const outputs = permissive();
        for (const id of GUARDED) {
          const node = nodeOf(nodes, id, file);
          expect(evaluateCondition(node.when ?? '', outputs).result, `${file} ${id}`).toBe(false);
        }
        expect(evaluateCondition(fail.when ?? '', outputs).result, file).toBe(true);
        const closed = bash(fail.bash ?? '', { ARCHON_NODE_OUT: nodeOut });
        expect(closed.exitCode, show(closed, file)).toBe(1);
        expect(closed.stderr, file).toContain('repair_gate_closed: gate_output_missing');

        writeFileSync(
          join(nodeOut, 'repair-gate.out'),
          'ERROR: scope_authority_missing: /tmp/authority/work-order.md\n'
        );
        const scoped = bash(fail.bash ?? '', { ARCHON_NODE_OUT: nodeOut });
        expect(scoped.exitCode, show(scoped, file)).toBe(1);
        expect(scoped.stderr, file).toContain('repair_gate_closed: scope_authority_missing');
      } finally {
        rmSync(missing, { recursive: true, force: true });
        rmSync(emptyRoot, { recursive: true, force: true });
        rmSync(nodeOut, { recursive: true, force: true });
      }
    }
  });

  it('repair_target_only_declared_at_line_start', () => {
    for (const file of EXPECTED_LANES) {
      const nodes = nodesOf(file);
      const planReview = nodeOf(nodes, 'plan-review', file);
      const decide = nodeOf(nodes, 'decide-push-target', file);
      expect(planReview.loop?.prompt ?? '', file).toContain(SENTENCE);
      expect(decide.prompt ?? '', file).toContain(SENTENCE);
      expect(planReview.loop?.prompt ?? '', file).toContain('a line by itself');
      expect(decide.prompt ?? '', file).toContain('a line by itself');

      const artifacts = mkdtempSync(join(tmpdir(), 'rrg-inline-'));
      const declared = mkdtempSync(join(tmpdir(), 'rrg-declared-'));
      const nodeOut = mkdtempSync(join(tmpdir(), 'rrg-inline-out-'));
      try {
        writeAuthority(artifacts, inlineSpec());
        for (const id of ['checkout-repair-target', 'commit-and-push'] as const) {
          const parsed = bash(repairParse(nodeOf(nodes, id, file).bash ?? ''), {
            ARTIFACTS_DIR: artifacts,
          });
          expect(parsed.exitCode, show(parsed, `${file} ${id}`)).toBe(0);
          expect(parsed.stdout, `${file} ${id}`).toContain('PR=');
          expect(parsed.stdout, `${file} ${id}`).toContain('BRANCH=');
          expect(parsed.stdout, `${file} ${id}`).not.toContain('PR=1214');
          expect(parsed.stdout, `${file} ${id}`).not.toContain(`PR=${PR}`);
          const prLine = parsed.stdout.split('\n').find(line => line.startsWith('PR='));
          const branchLine = parsed.stdout.split('\n').find(line => line.startsWith('BRANCH='));
          expect(prLine, `${file} ${id}`).toBe('PR=');
          expect(branchLine, `${file} ${id}`).toBe('BRANCH=');
        }
        const na = bash(nodeOf(nodes, 'repair-gate', file).bash ?? '', {
          ARTIFACTS_DIR: artifacts,
          ARCHON_NODE_OUT: nodeOut,
        });
        expect(na.exitCode, show(na, file)).toBe(0);
        expect(na.stdout.trim(), file).toBe('{"REPAIR_GATE":"n/a","REPAIR_GATE_ALLOW":"yes"}');

        writeAuthority(declared, `${inlineSpec()}${declaration()}\n`);
        const recognized = bash(
          repairParse(nodeOf(nodes, 'checkout-repair-target', file).bash ?? ''),
          {
            ARTIFACTS_DIR: declared,
          }
        );
        expect(recognized.exitCode, show(recognized, file)).toBe(0);
        expect(recognized.stdout, file).toContain(`PR=${PR}`);
        expect(recognized.stdout, file).toContain(`BRANCH=${BRANCH}`);
        const closed = bash(nodeOf(nodes, 'repair-gate', file).bash ?? '', {
          ARTIFACTS_DIR: declared,
          ARCHON_NODE_OUT: nodeOut,
        });
        expect(closed.exitCode, show(closed, file)).toBe(0);
        expect(closed.stdout, file).toContain('"REPAIR_GATE":"closed"');
        expect(closed.stdout, file).not.toContain('"REPAIR_GATE":"n/a"');
      } finally {
        rmSync(artifacts, { recursive: true, force: true });
        rmSync(declared, { recursive: true, force: true });
        rmSync(nodeOut, { recursive: true, force: true });
      }
    }
  });
});
