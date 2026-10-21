/**
 * WO-HARNESS-REPAIR-PATH-HOTFIX-01 -- replay proof for F1.
 *
 * F1: the executor renders every bash `$node.output` reference shellQuote-wrapped
 * (dag-executor substituteNodeOutputRefs with escapedForBash=true;
 * `wrap(shellQuote(nodeOutput.output))` at dag-executor.ts). commit-and-push used
 * to capture the decide-push-target output through a quoted heredoc, so the
 * single-quote shellQuote appends to the DECIDE output put a trailing `'` on the
 * last line. The `$`-anchored authorization parser then failed to match
 * `repair_target_authorized_by_spec: #N`, the guard refused with
 * repair_target_unauthorized, and NO repair run ever reached open-pr-if-needed.
 *
 * The fix reads the byte-identical node-output handoff file
 * (`$ARCHON_NODE_OUT/decide-push-target.out`) instead, which carries no quote
 * bytes. These tests prove:
 *   Test 1: the OLD heredoc capture, fed through the REAL executor substitution,
 *           yields an EMPTY authorization (reproduces the bug).
 *   Test 2: the NEW node-output capture yields `#7` and the real commit-and-push
 *           selection reaches the `UNIQUE_BRANCH=` assignment without
 *           repair_target_unauthorized.
 *   Test 3: a missing node-output file fails closed with a file-specific STDERR
 *           message and a nonzero exit.
 */

import { describe, it, expect } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput } from './dag-executor';

const DEFAULTS_DIR = join(import.meta.dir, '../../../.archon/workflows/defaults');
const DEFAULT_LANE = join(DEFAULTS_DIR, 'bdc-feature-development.yaml');

// The production authorization parser copied byte-for-byte from commit-and-push.
const AUTH_PARSER = [
  "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')",
  "REPAIR_TARGET_AUTHORIZED=$(printf '%s\\n' \"$DECIDE_OUTPUT_CLEAN\" | sed -n 's/^[[:space:]]*repair_target_authorized_by_spec:[[:space:]]*\\(#[0-9][0-9]*\\)[[:space:]]*$/\\1/p' | head -n 1)",
  'echo "REPAIR_TARGET_AUTHORIZED=[${REPAIR_TARGET_AUTHORIZED}]"',
].join('\n');

// Decide output whose FINAL line is the authorization field -- the exact shape
// that triggered F1 (the shellQuote trailing quote lands on this line).
const DECIDE_OUTPUT = [
  'push_target: feature-branch: feat/should-not-mint',
  'repair_target_pr: #7',
  'repair_target_branch: feat/wo-replay-01',
  'repo: thinmansoftware/bdc-harness',
  'repair_target_authorized_by_spec: #7',
].join('\n');

// The pre-fix heredoc capture, kept as a fixture so the replay demonstrates the
// real hole rather than a style preference.
const LEGACY_HEREDOC_CAPTURE = [
  "DECIDE_OUTPUT=$(cat <<'BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET_20260719_013'",
  '$decide-push-target.output',
  'BDC_FEATURE_DEV_DECIDE_OUTPUT_DECIDE_PUSH_TARGET_20260719_013',
  ')',
].join('\n');

function render(script: string): string {
  const outputs = new Map<string, NodeOutput>([
    ['decide-push-target', { state: 'completed', output: DECIDE_OUTPUT }],
  ]);
  return substituteNodeOutputRefs(script, outputs, true);
}

function runBash(
  script: string,
  cwd: string,
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'replay-sh-'));
  const scriptPath = join(dir, 'fixture.sh');
  try {
    writeFileSync(scriptPath, script.replace(/\r\n/g, '\n'));
    const result = Bun.spawnSync(['bash', scriptPath.replace(/\\/g, '/')], {
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

describe('F1 replay: quoted heredoc capture loses the authorization', () => {
  it('Test 1: the OLD heredoc capture, via the real substitution, yields an empty authorization', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-old-'));
    try {
      const script = `set -euo pipefail\n${render(LEGACY_HEREDOC_CAPTURE)}\n${AUTH_PARSER}\n`;
      const result = runBash(script, dir);
      expect(result.exitCode, result.stderr).toBe(0);
      // The trailing shellQuote `'` on the final line defeats the $-anchored sed.
      expect(result.stdout).toContain('REPAIR_TARGET_AUTHORIZED=[]');
      expect(result.stdout).not.toContain('REPAIR_TARGET_AUTHORIZED=[#7]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Test 2a: the NEW node-output capture yields the authorization #7', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-new-'));
    const nodeOut = join(dir, 'node-out');
    mkdirSync(nodeOut);
    writeFileSync(join(nodeOut, 'decide-push-target.out'), DECIDE_OUTPUT);
    try {
      const capture = [
        'set -euo pipefail',
        'DECIDE_OUT_FILE="$ARCHON_NODE_OUT/decide-push-target.out"',
        'if [ ! -r "$DECIDE_OUT_FILE" ]; then echo "missing" >&2; exit 1; fi',
        'DECIDE_OUTPUT=$(cat "$DECIDE_OUT_FILE")',
        AUTH_PARSER,
        '',
      ].join('\n');
      const result = runBash(capture, dir, { ARCHON_NODE_OUT: nodeOut });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('REPAIR_TARGET_AUTHORIZED=[#7]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Test 3: a missing node-output handoff file fails closed on STDERR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-missing-'));
    const nodeOut = join(dir, 'node-out');
    mkdirSync(nodeOut);
    // decide-push-target.out intentionally absent.
    try {
      const capture = extractCommitCapture(readFileSync(DEFAULT_LANE, 'utf8'));
      const result = runBash(`set -euo pipefail\n${capture}\n`, dir, { ARCHON_NODE_OUT: nodeOut });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('decide-push-target.out');
      expect(result.stderr).toContain('failing closed (F1)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------
// Test 2: the real commit-and-push selection reaches UNIQUE_BRANCH= with the
// node-output capture. Full fixture: fake gh + a temp origin branch.
// --------------------------------------------------------------------------
function git(args: string[], cwd: string): void {
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
}

function fakeGhPath(branch: string, oid: string): string {
  const binDir = mkdtempSync(join(tmpdir(), 'replay-gh-'));
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
printf '{"state":"OPEN","headRefName":"%s","isCrossRepository":false,"headRepositoryOwner":{"login":"thinmansoftware"},"headRepository":{"name":"bdc-harness"},"headRefOid":"%s"}\\n' "${branch}" "${oid}" | jq -r "$filter"
`
  );
  chmodSync(ghPath, 0o755);
  return `${binDir}${delimiter}${process.env.PATH ?? ''}`;
}

// Extract just the two node-output capture stanzas (decide + plan-review) from
// the real commit-and-push bash. These are the production bytes under test.
function extractCommitCapture(yaml: string): string {
  const text = yaml.replace(/\r\n/g, '\n');
  const node = text.split('  - id: commit-and-push\n')[1]?.split('\n  - id: ')[0] ?? '';
  const sliceStanza = (startMarker: string, endMarker: string): string => {
    const start = node.indexOf(startMarker);
    const endIdx = node.indexOf(endMarker, start);
    if (start < 0 || endIdx < 0) {
      throw new Error('commit capture stanza markers missing');
    }
    return node
      .slice(start, endIdx + endMarker.length)
      .split('\n')
      .map(line => (line.startsWith('      ') ? line.slice(6) : line))
      .join('\n');
  };
  const decide = sliceStanza(
    'DECIDE_OUT_FILE="$ARCHON_NODE_OUT/decide-push-target.out"',
    'DECIDE_OUTPUT=$(cat "$DECIDE_OUT_FILE")'
  );
  const plan = sliceStanza(
    'PLAN_REVIEW_OUT_FILE="$ARCHON_NODE_OUT/plan-review.out"',
    'PLAN_REVIEW_RAW=$(cat "$PLAN_REVIEW_OUT_FILE")'
  );
  return `${decide}\n${plan}\n`;
}

// Extract the commit-and-push selection body (DECIDE_OUTPUT_CLEAN .. git status)
// with the SPEC_TEXT/CHECKOUT_OUTPUT substitutions swapped to env, mirroring
// bdc-push-correctness.test.ts.
function extractCommitSelection(yaml: string): string {
  const text = yaml.replace(/\r\n/g, '\n');
  const startMarker = "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')";
  const start = text.indexOf(startMarker);
  const end = start < 0 ? -1 : text.indexOf('\n      git status --short', start);
  if (start < 0 || end < 0) throw new Error('commit selection anchors missing');
  let block = text.slice(start, end + 1).replace(/^      /gm, '');
  block = block
    .replace('SPEC_TEXT=$read-spec.output', 'SPEC_TEXT="${SPEC_TEXT-}"')
    .replace(
      'CHECKOUT_OUTPUT=$checkout-repair-target.output',
      'CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"'
    );
  return block;
}

describe('F1 replay: node-output capture reaches UNIQUE_BRANCH=', () => {
  it('Test 2: the node-output capture authorizes #7 and the real selection reaches UNIQUE_BRANCH=', () => {
    const branch = 'feat/wo-replay-01';
    const root = mkdtempSync(join(tmpdir(), 'replay-repo-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const nodeOut = join(root, 'node-out');
    mkdirSync(nodeOut);
    try {
      git(['init', '--bare', '--initial-branch=main', origin], root);
      git(['clone', origin, work], root);
      git(['config', 'user.email', 'test@test.com'], work);
      git(['config', 'user.name', 'Test'], work);
      writeFileSync(join(work, 'README.md'), 'init\n');
      git(['add', 'README.md'], work);
      git(['commit', '-m', 'init'], work);
      git(['push', 'origin', 'main'], work);
      git(['push', 'origin', `HEAD:${branch}`], work);
      const oid = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: work })
        .stdout.toString()
        .trim();

      writeFileSync(join(nodeOut, 'decide-push-target.out'), DECIDE_OUTPUT);
      const planReview = [
        'Reviewer critique before the fence.',
        '=== APPROVED_PLAN_BEGIN ===',
        'Commit message: fix: x',
        'repair_target_authorized_by_spec: #7',
        '=== APPROVED_PLAN_END ===',
        'Reviewer critique after the fence.',
      ].join('\n');
      writeFileSync(join(nodeOut, 'plan-review.out'), planReview);

      const script = [
        'set -euo pipefail',
        extractCommitCapture(readFileSync(DEFAULT_LANE, 'utf8')),
        extractCommitSelection(readFileSync(DEFAULT_LANE, 'utf8')),
        'echo "UNIQUE_BRANCH=$UNIQUE_BRANCH"',
        '',
      ].join('\n');

      const result = runBash(script, work, {
        ARCHON_NODE_OUT: nodeOut,
        SPEC_TEXT: `WO: WO-TEST\nRepair target: PR #7 (branch ${branch})`,
        PATH: fakeGhPath(branch, oid),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `exit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
        );
      }
      expect(result.stdout).not.toContain('repair_target_unauthorized');
      expect(result.stdout).toContain(`UNIQUE_BRANCH=${branch}`);
      expect(result.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${oid}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
