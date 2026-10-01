/**
 * Behavioral tests for the push-correctness hardening in bdc-feature-development.yaml.
 *
 * WO-HARNESS-PUSH-CORRECTNESS-HARDENING-01 (anchored 2026-05-18).
 *
 * Covers three failure modes the YAML now defends against:
 *   F-6A: decide-push-target agent emits a malformed branch name with embedded
 *         thread suffix (e.g. archon/thread-9772643d-thread-9772643d).
 *   F-7C: COMMITS_AHEAD = 0 because the implement loop already pushed the work
 *         to a different remote branch -- recoverable via git ls-remote search.
 *   F-8C: open-pr-if-needed must add --base staging for Rule 20 repos
 *         (lspro-react, shopops-storefront, shopops) and omit it otherwise.
 *
 * Tests extract the relevant bash snippets from the YAML and exercise them in
 * isolated temp git repos via Bun.spawnSync. No mock.module() calls -- safe to
 * run in its own bun test invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// ---------------------------------------------------------------------------
// Snippet 1 (F-6A): BRANCH allowlist regex validator from commit-and-push.
// Mirrors lines 287-297 of bdc-feature-development.yaml.
// ---------------------------------------------------------------------------
const F6A_VALIDATOR = `
set -euo pipefail
BRANCH_PATTERN='^(feat/[A-Za-z0-9_-]+|fix/[A-Za-z0-9_-]+|wip/[A-Za-z0-9_-]+)$'
if ! printf '%s\\n' "$BRANCH" | grep -Eq "$BRANCH_PATTERN"; then
  echo "Malformed branch name: $BRANCH does not match required pattern feat/|fix/|wip/|archon/thread-" >&2
  exit 1
fi
echo "BRANCH_VALID=$BRANCH"
`;

// ---------------------------------------------------------------------------
// Snippet 2 (F-7C): COMMITS_AHEAD=0 fallback that searches git ls-remote.
// Mirrors lines 322-345 of bdc-feature-development.yaml. Set UNIQUE_BRANCH
// (the malformed target) in env; the snippet either reassigns it from the
// remote-search recovery or exits 1.
// ---------------------------------------------------------------------------
const F7C_FALLBACK = `
set -euo pipefail
# Pretend we are inside the COMMITS_AHEAD=0 branch.
LOCAL_HEAD=$(git rev-parse HEAD)
RECOVERED=$(git ls-remote origin 2>/dev/null \\
  | awk -v sha="$LOCAL_HEAD" '$1 == sha {sub(/^refs\\/heads\\//, "", $2); print $2}' \\
  | head -1)
if [ -n "$RECOVERED" ]; then
  echo "Recovered push target from remote: $RECOVERED"
  UNIQUE_BRANCH="$RECOVERED"
  echo "UNIQUE_BRANCH=$UNIQUE_BRANCH"
  exit 0
else
  echo "No changed files and no commits ahead of origin/\${UNIQUE_BRANCH} -- implement loop did not produce work" >&2
  exit 1
fi
`;

// ---------------------------------------------------------------------------
// Snippet 3 (F-8C): staging-gate extractor + gh pr create command construction.
// Mirrors lines 429-440 of bdc-feature-development.yaml. We do NOT invoke gh
// (no GitHub auth in CI) -- we capture the final command line as a string to
// assert on the --base flag inclusion.
// ---------------------------------------------------------------------------
const F8C_BASE_BRANCH_SELECTION = `
set -euo pipefail
STAGING_GATE=$(printf '%s\\n' "$DECIDE_OUTPUT" | grep -c '^staging_gate_required: true' 2>/dev/null || true)
STAGING_GATE="\${STAGING_GATE:-0}"
if [ "$STAGING_GATE" -ge 1 ] 2>/dev/null; then
  BASE_BRANCH="staging"
else
  BASE_BRANCH=""
fi
# Build the command line that gh would receive. We use eval-safe printing so
# the conditional --base flag is captured verbatim in the output.
CMD="gh pr create --title T --body-file BF --head $UNIQUE_BRANCH \${BASE_BRANCH:+--base \"\$BASE_BRANCH\"}"
echo "BASE_BRANCH=$BASE_BRANCH"
echo "CMD=$CMD"
`;

// ---------------------------------------------------------------------------
// Snippet 4: base_branch_override validation/precedence + PR body text from
// open-pr-if-needed. Mirrors the deterministic bash guard added around
// bdc-feature-development.yaml lines 2208-2236. REPO_REMOTE_URL is a test-only
// injection so the branch-existence check can run against a local bare remote.
// ---------------------------------------------------------------------------
const BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY = `
set -euo pipefail
REPO="\${REPO:-thinmansoftware/bdc-xo}"
REMOTE_URL="\${REPO_REMOTE_URL:-https://github.com/\${REPO}.git}"
STAGING_GATE=$(printf '%s\\n' "$DECIDE_OUTPUT" | grep -c '^staging_gate_required: true' 2>/dev/null || true)
BASE_BRANCH_OVERRIDE=$(printf '%s\\n' "$DECIDE_OUTPUT" | sed -n 's/^base_branch_override: //p' | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
BASE_BRANCH_OVERRIDE=$(printf '%s' "$BASE_BRANCH_OVERRIDE" | tr -d '\\r\\t' | sed "s/^'\\\\(.*\\\\)'$/\\\\1/;s/^\\"\\\\(.*\\\\)\\"$/\\\\1/;s/^[[:space:]]*//;s/[[:space:]]*$//")
STAGING_GATE="\${STAGING_GATE:-0}"
if [ -n "$BASE_BRANCH_OVERRIDE" ]; then
  case "$BASE_BRANCH_OVERRIDE" in
    unknown|UNKNOWN|"<"*">"*|*"e.g."*|*" "*|*$'\\t'*|*$'\\r'*|*$'\\n'*)
      echo "ERROR: decide-push-target emitted an invalid 'base_branch_override: <branch>' value: \${BASE_BRANCH_OVERRIDE}" >&2
      exit 1
      ;;
  esac
  if ! git check-ref-format --branch "$BASE_BRANCH_OVERRIDE" >/dev/null 2>&1; then
    echo "ERROR: decide-push-target emitted an invalid base branch override ref name: \${BASE_BRANCH_OVERRIDE}" >&2
    exit 1
  fi
  if ! git ls-remote --exit-code "$REMOTE_URL" "refs/heads/\${BASE_BRANCH_OVERRIDE}" >/dev/null 2>&1; then
    echo "ERROR: base branch override '\${BASE_BRANCH_OVERRIDE}' does not exist on \${REPO}; refusing to open PR against an unverified base." >&2
    exit 1
  fi
  BASE_BRANCH="$BASE_BRANCH_OVERRIDE"
elif [ "$STAGING_GATE" -ge 1 ] 2>/dev/null; then
  BASE_BRANCH="staging"
else
  BASE_BRANCH=""
fi
BODY_FILE=$(mktemp)
{
  echo "## Summary"
  echo "$PLAN_OUTPUT"
  echo
  if [ -n "$BASE_BRANCH_OVERRIDE" ]; then
    echo "## Base branch override"
    echo "Base branch override applied: PR targets \\\`$BASE_BRANCH_OVERRIDE\\\` per spec-declared \\\`Base branch:\\\` field (not the default staging gate)."
    echo
  fi
  echo "## Implement output"
  echo "$IMPLEMENT_OUTPUT"
} > "$BODY_FILE"
echo "BASE_BRANCH=$BASE_BRANCH"
echo "CMD=gh pr create --repo $REPO --title T --body-file BF --head $UNIQUE_BRANCH \${BASE_BRANCH:+--base "$BASE_BRANCH"}"
cat "$BODY_FILE"
`;

// ---------------------------------------------------------------------------
// Snippet 5: review diff-base resolution used by resolve-review-base.
// Mirrors the bash node added to every bdc-feature-development*.yaml lane.
// SPEC_TEXT is injected by the test harness instead of read from read-spec.
// ---------------------------------------------------------------------------
const RESOLVE_REVIEW_BASE = `
set -uo pipefail
DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '^Base branch:[[:space:]]*[A-Za-z0-9_./-]+' | sed -E 's/^Base branch:[[:space:]]*//')
if [ -z "$DECLARED" ]; then
  DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '\\*\\*Base branch:\\*\\*[[:space:]]*\\\`[A-Za-z0-9_./-]+\\\`' | sed -E 's/.*\\\`([A-Za-z0-9_./-]+)\\\`.*/\\1/')
fi
if [ -z "$DECLARED" ]; then
  DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '^base_branch:[[:space:]]*[A-Za-z0-9_./-]+' | sed -E 's/^base_branch:[[:space:]]*//')
fi
if [ -n "$DECLARED" ] && git ls-remote --exit-code origin "refs/heads/\${DECLARED}" >/dev/null 2>&1; then
  echo "REVIEW_BASE=$DECLARED"
  echo "REVIEW_BASE_SOURCE=declared"
elif [ -n "\${BASE_BRANCH:-}" ]; then
  echo "REVIEW_BASE=$BASE_BRANCH"
  echo "REVIEW_BASE_SOURCE=env-default"
else
  echo "REVIEW_BASE=master"
  echo "REVIEW_BASE_SOURCE=fallback-master"
fi
`;

// Anchor on import.meta.dir, not CWD: turbo runs package tests with cwd at the
// package dir, so bare repo-root-relative paths ENOENT in CI.
const DEFAULTS_DIR = join(import.meta.dir, '..', '..', '..', '.archon', 'workflows', 'defaults');
const FEATURE_DEV_LANES = [
  join(DEFAULTS_DIR, 'bdc-feature-development.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-astra.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-codex-only.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-codex.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-fable.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-fusion-cx-qwen.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-grok.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-zero-open.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-zero.yaml'),
];

// All 13 feature-development lanes that carry checkout-repair-target.
// FEATURE_DEV_LANES above stays the existing 9-file subset.
const REPAIR_COVERAGE_LANES = [
  'bdc-feature-development.yaml',
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
].map(file => join(DEFAULTS_DIR, file));

const ORDINARY_BRANCH_PATTERN =
  "BRANCH_PATTERN='^(feat/[A-Za-z0-9_-]+|fix/[A-Za-z0-9_-]+|wip/[A-Za-z0-9_-]+)$'";

const ACCEPTED_REPAIR_BRANCHES = ['wo/X', 'archon/task-web-worker-1790865294847-n1qba8'] as const;

const REJECTED_REPAIR_BRANCHES = [
  'main',
  'master',
  'dev',
  'staging',
  'release/lspro',
  'promotion/X',
  'hotfix/X',
  'salvage/X',
  'archon/arbitrary',
  'archon/thread-anything',
  'archon/task-web-worker-abc-x',
  'archon/task-web-worker-123-ab_c',
  'archon/task-web-worker-123-ab-c',
  'archon/task-web-worker-123-abc/extra',
  'wo/foo/bar',
  'wo/foo;rm',
] as const;

function extractCommitSelection(yaml: string, laneLabel: string): string {
  const startMarker = "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')";
  const start = yaml.indexOf(startMarker);
  const end = start < 0 ? -1 : yaml.indexOf('\n      git status --short', start);
  if (start < 0 || end < 0) {
    throw new Error(`commit selection anchors missing in ${laneLabel}`);
  }
  let block = yaml.slice(start, end + 1).replace(/^      /gm, '');
  if (
    !block.includes('SPEC_TEXT=$read-spec.output') ||
    !block.includes('CHECKOUT_OUTPUT=$checkout-repair-target.output')
  ) {
    throw new Error(`commit engine substitutions missing in ${laneLabel}`);
  }
  block = block
    .replace('SPEC_TEXT=$read-spec.output', 'SPEC_TEXT="${SPEC_TEXT-}"')
    .replace(
      'CHECKOUT_OUTPUT=$checkout-repair-target.output',
      'CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"'
    );
  return `set -euo pipefail\n${block}echo "UNIQUE_BRANCH=$UNIQUE_BRANCH"\n`;
}

function extractCheckoutRepair(yaml: string, laneLabel: string): string {
  const nodeStart = yaml.indexOf('  - id: checkout-repair-target\n');
  if (nodeStart < 0) {
    throw new Error(`checkout-repair-target missing in ${laneLabel}`);
  }
  const startMarker = '      set -euo pipefail\n      SPEC_TEXT=$read-spec.output';
  const start = yaml.indexOf(startMarker, nodeStart);
  const endMarker = '      echo "REPAIR_TARGET_LEASE_SHA=${REPAIR_TARGET_LIVE_OID}"';
  const end = start < 0 ? -1 : yaml.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`checkout bash anchors missing in ${laneLabel}`);
  }
  const raw = yaml.slice(start, end + endMarker.length);
  if (!raw.includes('SPEC_TEXT=$read-spec.output')) {
    throw new Error(`checkout engine substitution missing in ${laneLabel}`);
  }
  return `${raw.replace(/^      /gm, '').replace('SPEC_TEXT=$read-spec.output', 'SPEC_TEXT="${SPEC_TEXT-}"')}\n`;
}

function extractRepairTargetSelection(): string {
  const lane = join(DEFAULTS_DIR, 'bdc-feature-development.yaml');
  return extractCommitSelection(readFileSync(lane, 'utf8'), lane);
}

const REPAIR_TARGET_SELECTION = extractRepairTargetSelection();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bash(
  script: string,
  cwd: string,
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
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

function fakeGhPath(
  state: string,
  branch: string,
  opts?: { cross?: boolean; owner?: string; repo?: string; headRefOid?: string }
): string {
  const binDir = mkdtempSync(join(tmpdir(), 'bdc-fake-gh-'));
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
printf '{"state":"%s","headRefName":"%s","isCrossRepository":%s,"headRepositoryOwner":{"login":"%s"},"headRepository":{"name":"%s"},"headRefOid":"%s"}\\n' \\
  "$FAKE_GH_STATE" "$FAKE_GH_BRANCH" "\${FAKE_GH_CROSS:-false}" "\${FAKE_GH_OWNER:-thinmansoftware}" "\${FAKE_GH_REPO:-bdc-harness}" "\${FAKE_GH_HEAD_OID:-}" | jq -r "$filter"
`
  );
  chmodSync(ghPath, 0o755);
  process.env.FAKE_GH_STATE = state;
  process.env.FAKE_GH_BRANCH = branch;
  process.env.FAKE_GH_CROSS = opts?.cross ? 'true' : 'false';
  process.env.FAKE_GH_OWNER = opts?.owner ?? 'thinmansoftware';
  process.env.FAKE_GH_REPO = opts?.repo ?? 'bdc-harness';
  process.env.FAKE_GH_HEAD_OID = opts?.headRefOid ?? '';
  return `${binDir}:${process.env.PATH ?? ''}`;
}

function repairDecideOutput(branch: string): string {
  return [
    'push_target: feature-branch: feat/should-not-mint',
    'repair_target_pr: #826',
    `repair_target_branch: ${branch}`,
    'repo: thinmansoftware/bdc-harness',
  ].join('\n');
}

function authorizedRepairDecideOutput(branch: string): string {
  return [repairDecideOutput(branch), 'repair_target_authorized_by_spec: #826'].join('\n');
}

function matchingRepairSpec(branch: string): string {
  return ['WO: WO-TEST', `Repair target: PR #826 (branch ${branch})`].join('\n');
}

// ---------------------------------------------------------------------------
// Fixture state -- used by tests that need a real temp git repo (Tests 2 + 5).
// ---------------------------------------------------------------------------
let originDir: string;
let worktreeDir: string;

beforeEach(() => {
  originDir = mkdtempSync(join(tmpdir(), 'bdc-push-origin-'));
  git(['init', '--bare', '--initial-branch=main', originDir], tmpdir());

  worktreeDir = mkdtempSync(join(tmpdir(), 'bdc-push-wt-'));
  git(['clone', originDir, worktreeDir], tmpdir());
  git(['config', 'user.email', 'test@test.com'], worktreeDir);
  git(['config', 'user.name', 'Test'], worktreeDir);

  writeFileSync(join(worktreeDir, 'README.md'), 'init\n');
  git(['add', 'README.md'], worktreeDir);
  git(['commit', '-m', 'init'], worktreeDir);
  git(['push', 'origin', 'main'], worktreeDir);
});

afterEach(() => {
  try {
    rmSync(worktreeDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; tmp dirs are reaped by OS eventually
  }
  try {
    rmSync(originDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('F-6A: BRANCH allowlist regex validator', () => {
  it('Test 1: rejects malformed double-thread-suffix branch name', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'archon/thread-9772643d-thread-9772643d',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Malformed branch name: archon/thread-9772643d-thread-9772643d'
    );
    expect(result.stderr).toContain('feat/|fix/|wip/|archon/thread-');
  });

  it('rejects double-suffix feat/ branch like the WO-AUTH-RETIRE-GAS-PATH-02 anchor', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/WO-AUTH-RETIRE-GAS-PATH-02-thread-feat/WO-AUTH-RETIRE-GAS-PATH-02',
    });
    // The embedded slash + multiple -thread- segments take it out of the allowlist.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Malformed branch name');
  });

  it('accepts a clean feat/ branch name', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/wo-foo-bar-01',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BRANCH_VALID=feat/wo-foo-bar-01');
  });
});

describe('F-7C: remote-search fallback when origin ref is missing', () => {
  it('Test 2: recovers UNIQUE_BRANCH from origin when ls-remote HEAD matches local HEAD', () => {
    // Simulate the failure mode: the agent's work was committed and pushed to
    // origin under a different branch (archon/thread-abc123) than the target
    // UNIQUE_BRANCH (feat/wo-foo-01-thread-abc123).
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    // Push to a DIFFERENT name than what UNIQUE_BRANCH will be.
    git(['push', 'origin', 'HEAD:archon/thread-abc123'], worktreeDir);

    const result = bash(F7C_FALLBACK, worktreeDir, {
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc123', // the malformed target
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Recovered push target from remote: archon/thread-abc123');
    expect(result.stdout).toContain('UNIQUE_BRANCH=archon/thread-abc123');
  });

  it('exits 1 with the original error when no remote ref matches local HEAD', () => {
    // Local commit was never pushed anywhere. Fallback should find nothing
    // and fall through to the original error message.
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    // Do NOT push anywhere.

    const result = bash(F7C_FALLBACK, worktreeDir, {
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc123',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('implement loop did not produce work');
  });
});

describe('F-8C: staging-gate base-branch selection for gh pr create', () => {
  it('Test 3: sets --base staging when staging_gate_required is true', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
    ].join('\n');

    const result = bash(F8C_BASE_BRANCH_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=staging');
    // The bash conditional expansion ${BASE_BRANCH:+--base "$BASE_BRANCH"}
    // word-splits when assigned into CMD, so the captured command line shows
    // "--base staging" without quotes (gh receives them as separate args).
    expect(result.stdout).toContain('--base staging');
  });

  it('Test 4: omits --base when staging_gate_required is false', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
    ].join('\n');

    const result = bash(F8C_BASE_BRANCH_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^BASE_BRANCH=\s*$/m);
    expect(result.stdout).not.toContain('--base');
  });
});

describe('Base branch override: deterministic open-pr-if-needed handling', () => {
  it.each([
    ['single-quoted empty value', "''"],
    ['double-quoted empty value', '""'],
    ['space-only value', ' '],
    ['carriage-return-only value', '\r'],
    ['tab-only value', '\t'],
  ])('treats a %s as absent and falls through to the staging gate', (_label, override) => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
      `base_branch_override: ${override}`,
      'repo: thinmansoftware/shopops',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('ERROR:');
    expect(result.stdout).toContain('BASE_BRANCH=staging');
    expect(result.stdout).toContain('--base staging');
    expect(result.stdout).not.toContain('## Base branch override');
  });

  it('extracts exact base and unique branch values from node-output handoff files', () => {
    const nodeOutDir = worktreeDir;
    writeFileSync(
      join(nodeOutDir, 'decide-push-target.out'),
      'push_target: feature-branch:feat/wo-foo-01\nbase_branch_override: release/ce'
    );
    writeFileSync(
      join(nodeOutDir, 'commit-and-push.out'),
      'VERIFIED: origin branch is durable\nunique_branch=feat/wo-foo-01-thread-abc'
    );

    const result = bash(
      `
set -euo pipefail
DECIDE_OUTPUT=$(cat "$ARCHON_NODE_OUT/decide-push-target.out")
COMMIT_PUSH_OUTPUT=$(cat "$ARCHON_NODE_OUT/commit-and-push.out")
BASE_BRANCH_OVERRIDE=$(printf '%s\\n' "$DECIDE_OUTPUT" | sed -n 's/^base_branch_override: //p' | head -n 1)
UNIQUE_BRANCH=$(printf '%s\\n' "$COMMIT_PUSH_OUTPUT" | sed -n 's/^unique_branch=//p' | head -n 1)
printf 'BASE_BRANCH_OVERRIDE=<%s>\\nUNIQUE_BRANCH=<%s>\\n' "$BASE_BRANCH_OVERRIDE" "$UNIQUE_BRANCH"
`,
      worktreeDir,
      { ARCHON_NODE_OUT: nodeOutDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH_OVERRIDE=<release/ce>');
    expect(result.stdout).toContain('UNIQUE_BRANCH=<feat/wo-foo-01-thread-abc>');
    expect(result.stdout).not.toContain("release/ce'");
    expect(result.stdout).not.toContain("thread-abc'");
  });

  it('honors an existing override branch over staging-gate selection and documents it in the PR body', () => {
    git(['checkout', '-b', 'release/ce'], worktreeDir);
    git(['push', 'origin', 'release/ce'], worktreeDir);

    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
      'base_branch_override: release/ce',
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=release/ce');
    expect(result.stdout).toContain('--base release/ce');
    expect(result.stdout).toContain('## Base branch override');
    expect(result.stdout).toContain(
      'Base branch override applied: PR targets `release/ce` per spec-declared `Base branch:` field'
    );
    expect(result.stdout).not.toContain('BASE_BRANCH=staging');
  });

  it('fails closed when the override branch is missing on the resolved repo remote', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
      'base_branch_override: release/missing',
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: base branch override 'release/missing' does not exist on thinmansoftware/bdc-xo"
    );
    expect(result.stdout).not.toContain('CMD=gh pr create');
  });

  it('fails before remote lookup when the model emits the illustrative placeholder text', () => {
    const illustrativePlaceholder = `<the declared override branch, ${'e.g.'} release/ce>`;
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
      `base_branch_override: ${illustrativePlaceholder}`,
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: decide-push-target emitted an invalid 'base_branch_override: <branch>' value"
    );
    expect(result.stdout).not.toContain('CMD=gh pr create');
  });

  it('leaves the no-override staging-gate path unchanged and omits the override body section', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
      'repo: thinmansoftware/shopops',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=staging');
    expect(result.stdout).toContain('--base staging');
    expect(result.stdout).not.toContain('## Base branch override');
  });
});

describe('Review diff-base resolution from declared Base branch', () => {
  it('uses a declared staging base before the run/codebase default', () => {
    git(['checkout', '-b', 'staging'], worktreeDir);
    git(['push', 'origin', 'staging'], worktreeDir);

    const result = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: ['WO: WO-TEST', 'Base branch: staging'].join('\n'),
      BASE_BRANCH: 'master',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('REVIEW_BASE=staging');
    expect(result.stdout).toContain('REVIEW_BASE_SOURCE=declared');
    expect(result.stdout).not.toContain('REVIEW_BASE=master');
  });

  it('falls back to env default, then master, when no Base branch is declared', () => {
    const envDefault = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: 'WO: WO-TEST\nObjective: no declared base',
      BASE_BRANCH: 'release/ce',
    });
    expect(envDefault.exitCode).toBe(0);
    expect(envDefault.stdout).toContain('REVIEW_BASE=release/ce');
    expect(envDefault.stdout).toContain('REVIEW_BASE_SOURCE=env-default');

    const lastResort = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: 'WO: WO-TEST\nObjective: no declared base',
      BASE_BRANCH: '',
    });
    expect(lastResort.exitCode).toBe(0);
    expect(lastResort.stdout).toContain('REVIEW_BASE=master');
    expect(lastResort.stdout).toContain('REVIEW_BASE_SOURCE=fallback-master');
  });
});

describe('Lane consistency: all feature-development lanes share review-base wiring', () => {
  it('feeds open-pr-if-needed from the byte-identical decide-push-target handoff file', () => {
    for (const lane of FEATURE_DEV_LANES) {
      const yaml = readFileSync(lane, 'utf8').replace(/\r\n/g, '\n');
      const openPr = yaml.split('  - id: open-pr-if-needed\n')[1]?.split('\n  - id: ')[0] ?? '';
      expect(openPr).toContain('DECIDE_OUTPUT=$(cat "$ARCHON_NODE_OUT/decide-push-target.out")');
      expect(openPr).toContain('COMMIT_PUSH_OUTPUT=$(cat "$ARCHON_NODE_OUT/commit-and-push.out")');
      expect(openPr).not.toMatch(
        /DECIDE_OUTPUT=\$\(cat <<'[^']+'\n\s*\$decide-push-target\.output\n/
      );
      expect(openPr).not.toMatch(
        /COMMIT_PUSH_OUTPUT=\$\(cat <<'[^']+'\n\s*\$commit-and-push\.output\n/
      );
    }
  });

  it('has no env-only review BASE_REF one-liner and has base_branch_override in every lane', () => {
    for (const lane of FEATURE_DEV_LANES) {
      // Normalize CRLF so a Windows checkout does not break '\n'-suffixed assertions.
      const yaml = readFileSync(lane, 'utf8').replace(/\r\n/g, '\n');
      expect(yaml).toContain('  - id: resolve-review-base\n');
      expect(yaml).toContain('depends_on: [war-council-validator, resolve-review-base]');
      expect(yaml).toContain(
        'depends_on: [diff-review, classify-diff-review, resolve-review-base]'
      );
      expect(yaml).toContain('depends_on: [checkpoint-diff-repair, resolve-review-base]');
      expect(yaml).not.toContain('BASE_REF="origin/${BASE_BRANCH:-main}"');
      expect(yaml).toContain('base_branch_override');
    }
  });
});

describe('Plan-review repair targets and operator-recorded stops', () => {
  const judgeLanes = [
    join(DEFAULTS_DIR, 'bdc-feature-development-codex.yaml'),
    join(DEFAULTS_DIR, 'bdc-feature-development.yaml'),
  ];

  it('authorizes a spec-declared repair target in the Codex lane', () => {
    const yaml = readFileSync(judgeLanes[0], 'utf8');
    expect(yaml).toContain('repair_target_authorized_by_spec');
    expect(yaml).not.toContain('should it be closed');
  });

  it('authorizes a spec-declared repair target in the default lane', () => {
    const yaml = readFileSync(judgeLanes[1], 'utf8');
    expect(yaml).toContain('repair_target_authorized_by_spec');
    expect(yaml).not.toContain('should it be closed');
  });

  it('preserves operator-recorded stops as pending in the Codex lane', () => {
    expect(readFileSync(judgeLanes[0], 'utf8')).toContain('OPERATOR-RECORDED (pending)');
  });

  it('preserves operator-recorded stops as pending in the default lane', () => {
    expect(readFileSync(judgeLanes[1], 'utf8')).toContain('OPERATOR-RECORDED (pending)');
  });

  it('hands the verified repair-target branch to commit-and-push without a thread suffix', () => {
    for (const lane of judgeLanes) {
      const yaml = readFileSync(lane, 'utf8');
      expect(yaml).toContain('repair_target_branch: <verified-headRefName-from-gh>');
      expect(yaml).toContain('repair_target_pr: #N');
      expect(yaml).toContain('gh pr view "$REPAIR_TARGET_PR"');
      expect(yaml).toContain(
        '--json state,headRefName,headRepositoryOwner,headRepository,isCrossRepository,headRefOid'
      );
      expect(yaml).toContain('repair_target_rejected:fork');
      expect(yaml).toContain('repair_target_malformed');
      expect(yaml).toContain('repair_target_unauthorized');
      expect(yaml).toContain('s/^[[:space:]]*Repair target:[[:space:]]*PR #');
      expect(yaml).toContain('SPEC_TEXT=$read-spec.output');
      expect(yaml).not.toContain('BDC_FEATURE_DEV_SPEC_TEXT_READ_SPEC');
      expect(yaml).toContain('UNIQUE_BRANCH="$REPAIR_TARGET_BRANCH"');
    }
  });

  it('verifies repair-target head repository identity in every feature-development lane', () => {
    const lanes = [
      'bdc-feature-development.yaml',
      'bdc-feature-development-astra.yaml',
      'bdc-feature-development-codex.yaml',
      'bdc-feature-development-codex-only.yaml',
      'bdc-feature-development-fable.yaml',
      'bdc-feature-development-fusion-cx-kimi.yaml',
      'bdc-feature-development-fusion-cx-qwen.yaml',
      'bdc-feature-development-grok.yaml',
      'bdc-feature-development-kimi-k3.yaml',
      'bdc-feature-development-zero-claude.yaml',
      'bdc-feature-development-zero-open.yaml',
      'bdc-feature-development-zero.yaml',
    ].map(file => join(DEFAULTS_DIR, file));
    expect(lanes).toHaveLength(12);
    for (const lane of lanes) {
      const yaml = readFileSync(lane, 'utf8');
      expect(yaml).toContain(
        '--json state,headRefName,headRepositoryOwner,headRepository,isCrossRepository,headRefOid'
      );
      expect(yaml).toContain('repair_target_rejected:fork');
      expect(yaml).toContain('repair_target_malformed');
      expect(yaml).toContain('repair_target_unauthorized');
      expect(yaml).toContain('s/^[[:space:]]*Repair target:[[:space:]]*PR #');
      expect(yaml).toContain('SPEC_TEXT=$read-spec.output');
      expect(yaml).not.toContain('BDC_FEATURE_DEV_SPEC_TEXT_READ_SPEC');
      expect(yaml).toContain('UNIQUE_BRANCH="$REPAIR_TARGET_BRANCH"');
      expect(yaml).toContain('--force-with-lease=');
      expect(yaml).toContain('repair_target_base_not_incorporated');
      expect(yaml).toContain('repair_target_head_moved');
      expect(yaml).toContain("sed -n 's/^REPAIR_TARGET_LEASE_SHA=//p' | tail -n 1");
      expect(yaml).toContain('REPAIR_TARGET_LEASE_SHA=$(git rev-parse HEAD)');
      const result = parseWorkflow(yaml, basename(lane));
      if (!result.workflow) {
        throw new Error(`${basename(lane)}: ${result.error?.error ?? 'failed to parse'}`);
      }
      const decide = result.workflow.nodes.find(node => node.id === 'decide-push-target');
      const decidePrompt = decide && 'prompt' in decide ? decide.prompt : undefined;
      expect(decidePrompt).toContain('Repair target: PR #N (branch X)');
      expect(decidePrompt).toContain('repair_target_pr: #N');
      expect(decidePrompt).toContain('repair_target_branch:');
      expect(decidePrompt).toContain('repair_target_authorized_by_spec: #N');
      const planReview = result.workflow.nodes.find(node => node.id === 'plan-review');
      expect(planReview?.loop?.prompt).toContain('repair_target_authorized_by_spec: #N');
    }
  });

  it('checks out the repair-target head before capture-run-scope and never rebases at push', () => {
    const lanes = [
      'bdc-feature-development.yaml',
      'bdc-feature-development-astra.yaml',
      'bdc-feature-development-codex.yaml',
      'bdc-feature-development-codex-only.yaml',
      'bdc-feature-development-fable.yaml',
      'bdc-feature-development-fusion-cx-kimi.yaml',
      'bdc-feature-development-fusion-cx-qwen.yaml',
      'bdc-feature-development-grok.yaml',
      'bdc-feature-development-kimi-k3.yaml',
      'bdc-feature-development-zero-claude.yaml',
      'bdc-feature-development-zero-open.yaml',
      'bdc-feature-development-zero.yaml',
    ].map(file => join(DEFAULTS_DIR, file));
    expect(lanes).toHaveLength(12);
    for (const lane of lanes) {
      const yaml = readFileSync(lane, 'utf8');
      const result = parseWorkflow(yaml, basename(lane));
      if (!result.workflow) {
        throw new Error(`${basename(lane)}: ${result.error?.error ?? 'failed to parse'}`);
      }
      const checkout = result.workflow.nodes.find(node => node.id === 'checkout-repair-target');
      expect(checkout, basename(lane)).toBeDefined();
      expect(checkout?.depends_on ?? []).toContain('read-spec');
      expect(checkout?.bash).toContain('SPEC_TEXT=$read-spec.output');
      expect(checkout?.bash).toContain('git checkout -B');
      expect(checkout?.bash).toContain('repair_target_rejected:fork');
      expect(checkout?.bash).toContain('REPAIR_TARGET_LEASE_SHA=');
      const capture = result.workflow.nodes.find(node => node.id === 'capture-run-scope');
      expect(capture?.depends_on ?? []).toContain('checkout-repair-target');
      const commit = result.workflow.nodes.find(node => node.id === 'commit-and-push');
      expect(commit?.bash).toContain('repair_target_base_not_incorporated');
      expect(commit?.bash).not.toContain('git rebase');
    }
  });

  const decideOutput = repairDecideOutput;
  const authorizedDecideOutput = authorizedRepairDecideOutput;
  const matchingSpec = matchingRepairSpec;

  it('re-verifies an open matching PR before selecting its branch', () => {
    const branch = 'feat/wo-repair-target-01';
    git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
    const headOid = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', branch, { headRefOid: headOid }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`UNIQUE_BRANCH=${branch}`);
    expect(result.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${headOid}`);
  });

  it('fails closed with repair_target_base_not_incorporated when the lease sha is not an ancestor of HEAD', () => {
    const branch = 'feat/wo-repair-target-01';
    const initSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
    writeFileSync(join(worktreeDir, 'pr-only.txt'), 'on the PR\n');
    git(['add', 'pr-only.txt'], worktreeDir);
    git(['commit', '-m', 'pr-only commit'], worktreeDir);
    const leaseSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
    git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
    git(['reset', '--hard', initSha], worktreeDir);
    writeFileSync(join(worktreeDir, 'implement.txt'), 'run work\n');
    git(['add', 'implement.txt'], worktreeDir);
    git(['commit', '-m', 'implement work'], worktreeDir);
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', branch, { headRefOid: leaseSha }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('repair_target_base_not_incorporated');
    expect(result.stderr).toContain('repair_target_base_not_incorporated');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when live headRefOid differs from the fetched branch head', () => {
    const branch = 'feat/wo-repair-target-01';
    git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', branch, {
        headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('repair_target_head_mismatch');
    expect(result.stderr).toContain('repair_target_head_mismatch');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed on a conflicting repair-target rebase and leaves the worktree idle', () => {
    const branch = 'feat/wo-repair-target-01';
    const initSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
    writeFileSync(join(worktreeDir, 'README.md'), 'remote-change\n');
    git(['add', 'README.md'], worktreeDir);
    git(['commit', '-m', 'remote conflict'], worktreeDir);
    const leaseSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
    git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
    git(['reset', '--hard', initSha], worktreeDir);
    writeFileSync(join(worktreeDir, 'README.md'), 'local-change\n');
    git(['add', 'README.md'], worktreeDir);
    git(['commit', '-m', 'local conflict'], worktreeDir);
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', branch, { headRefOid: leaseSha }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('repair_target_base_not_incorporated');
    expect(result.stderr).toContain('repair_target_base_not_incorporated');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
    expect(bash('git status --porcelain', worktreeDir).stdout.trim()).toBe('');
    const rebaseState = bash(
      'if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then echo REBASE_IN_PROGRESS; else echo REBASE_IDLE; fi',
      worktreeDir
    );
    expect(rebaseState.stdout).toContain('REBASE_IDLE');
  });

  it('fails closed when the repair-target PR has closed', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('CLOSED', branch),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('declared repair target #826 is CLOSED');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when the live repair-target branch differs', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', 'feat/a-different-branch'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('declared repair target #826 head branch mismatch');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when the repair-target PR is cross-repository', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
      PATH: fakeGhPath('OPEN', branch, { cross: true, owner: 'someone-else', repo: 'bdc-harness' }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_rejected:fork');
    expect(result.stdout).toContain('repair_target_rejected:fork');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when repair_target_authorized_by_spec is missing', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: decideOutput(branch),
      SPEC_TEXT: matchingSpec(branch),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_unauthorized');
    expect(result.stdout).toContain('repair_target_unauthorized');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when repair_target_authorized_by_spec names a different PR', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: [decideOutput(branch), 'repair_target_authorized_by_spec: #999'].join('\n'),
      SPEC_TEXT: matchingSpec(branch),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_unauthorized');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when the spec declares a different PR', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: ['WO: WO-TEST', 'Repair target: PR #999 (branch feat/wo-repair-target-01)'].join(
        '\n'
      ),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_unauthorized');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when the spec declares a different branch', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: ['WO: WO-TEST', 'Repair target: PR #826 (branch feat/other-branch)'].join('\n'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_unauthorized');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when the spec declares no repair target', () => {
    const branch = 'feat/wo-repair-target-01';
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: authorizedDecideOutput(branch),
      SPEC_TEXT: 'WO: WO-TEST\nObjective: no repair target',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_unauthorized');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when repair_target_pr is present without repair_target_branch', () => {
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: [
        'push_target: feature-branch: feat/should-not-mint',
        'repair_target_pr: #826',
        'repo: thinmansoftware/bdc-harness',
      ].join('\n'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_malformed');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when repair_target_branch is present without repair_target_pr', () => {
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: [
        'push_target: feature-branch: feat/should-not-mint',
        'repair_target_branch: feat/wo-repair-target-01',
        'repo: thinmansoftware/bdc-harness',
      ].join('\n'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_malformed');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });

  it('fails closed when repair_target_authorized_by_spec is set without both fields', () => {
    const result = bash(REPAIR_TARGET_SELECTION, worktreeDir, {
      BRANCH: 'feat/should-not-mint',
      DECIDE_OUTPUT: [
        'push_target: feature-branch: feat/should-not-mint',
        'repair_target_authorized_by_spec: #826',
        'repo: thinmansoftware/bdc-harness',
      ].join('\n'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('repair_target_malformed');
    expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
  });
});

describe('Backward compatibility: clean valid path', () => {
  it('Test 5: validator accepts + fallback is not triggered for clean valid case', () => {
    // Agent emits BRANCH=feat/wo-bar-02; the regex passes.
    const validateResult = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/wo-bar-02',
    });
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.stdout).toContain('BRANCH_VALID=feat/wo-bar-02');
    expect(validateResult.stderr).not.toContain('Malformed');
    expect(validateResult.stderr).not.toContain('Recovered');

    // And: simulate the happy-path commit-and-push end state (work pushed to
    // the expected UNIQUE_BRANCH, COMMITS_AHEAD would have been >=1, so the
    // F-7C fallback branch is NEVER reached. We confirm this by checking that
    // the fallback's "Recovered" message does NOT appear in a normal push
    // pathway -- the fallback only runs inside the COMMITS_AHEAD=0 branch).
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    git(['push', 'origin', 'HEAD:feat/wo-bar-02-thread-abc'], worktreeDir);

    // Simulate the happy-path COMMITS_AHEAD calculation (origin ref exists
    // and HEAD matches origin/UNIQUE_BRANCH so commits_ahead = 0 BUT the
    // upstream code in YAML already short-circuits via the "Backstop no-op"
    // branch at line 309 -- F-7C fallback is only entered when origin ref
    // is MISSING and no commits ahead. With the ref existing, this is a
    // no-op path that does not touch our changes).
    const happyPath = `
set -euo pipefail
UNIQUE_BRANCH="feat/wo-bar-02-thread-abc"
if git rev-parse --quiet --verify "origin/\${UNIQUE_BRANCH}" >/dev/null 2>&1 && \\
   [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/\${UNIQUE_BRANCH}")" ]; then
  echo "Backstop no-op: already pushed"
  exit 0
fi
echo "Would push"
exit 0
    `;
    const happyResult = bash(happyPath, worktreeDir);
    expect(happyResult.exitCode).toBe(0);
    expect(happyResult.stdout).toContain('Backstop no-op: already pushed');
    expect(happyResult.stdout).not.toContain('Recovered');
    expect(happyResult.stderr).not.toContain('Malformed');
  });
});

function showResult(
  result: { exitCode: number; stdout: string; stderr: string },
  label: string
): string {
  return `${label}\nexit=${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
}

function configureOfflineCheckoutOrigin(): void {
  const githubOrigin = 'https://github.com/thinmansoftware/bdc-harness.git';
  git(['remote', 'set-url', 'origin', githubOrigin], worktreeDir);
  git(['config', '--local', `url.${originDir}.insteadOf`, githubOrigin], worktreeDir);
}

function publishHead(branch: string): string {
  git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
  const oid = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`expected oid for ${branch}, got ${oid}`);
  }
  return oid;
}

function rawCommitBlock(yaml: string, laneLabel: string): string {
  const startMarker = "DECIDE_OUTPUT_CLEAN=$(printf '%s\\n' \"$DECIDE_OUTPUT\" | tr -d '`')";
  const start = yaml.indexOf(startMarker);
  const end = start < 0 ? -1 : yaml.indexOf('\n      git status --short', start);
  if (start < 0 || end < 0) {
    throw new Error(`commit selection anchors missing in ${laneLabel}`);
  }
  return yaml.slice(start, end + 1).replace(/^      /gm, '');
}

describe('Spec-authorized repair onto wo and Cauldron task branches', () => {
  const repairPattern =
    "REPAIR_BRANCH_PATTERN='^(feat/[A-Za-z0-9_-]+|fix/[A-Za-z0-9_-]+|wip/[A-Za-z0-9_-]+|wo/[A-Za-z0-9_-]+|archon/task-web-worker-[0-9]+-[A-Za-z0-9]+)$'";

  function laneScripts(lane: string): { yaml: string; checkout: string; commit: string } {
    const yaml = readFileSync(lane, 'utf8');
    return {
      yaml,
      checkout: extractCheckoutRepair(yaml, lane),
      commit: extractCommitSelection(yaml, lane),
    };
  }

  it('keeps ordinary and repair guards in source order on all 13 lanes', () => {
    expect(REPAIR_COVERAGE_LANES).toHaveLength(13);
    expect(F6A_VALIDATOR).toContain(ORDINARY_BRANCH_PATTERN);
    expect(F6A_VALIDATOR).not.toContain('wo/');
    expect(F6A_VALIDATOR).not.toContain('archon/task-web-worker');
    for (const lane of REPAIR_COVERAGE_LANES) {
      const yaml = readFileSync(lane, 'utf8');
      const block = rawCommitBlock(yaml, lane);
      const label = basename(lane);
      expect(yaml.split(ORDINARY_BRANCH_PATTERN).length - 1, label).toBe(1);
      expect(yaml.split(repairPattern).length - 1, label).toBe(2);
      expect(yaml, label).toContain('SPEC_TEXT=$read-spec.output');
      expect(yaml, label).toContain('CHECKOUT_OUTPUT=$checkout-repair-target.output');
      const repairAssign = block.indexOf('UNIQUE_BRANCH="$REPAIR_TARGET_BRANCH"');
      const ordinaryAssign = block.indexOf(ORDINARY_BRANCH_PATTERN);
      const threadAssign = block.indexOf('UNIQUE_BRANCH="${BRANCH}-thread-${THREAD_ID}"');
      expect(repairAssign, label).toBeGreaterThanOrEqual(0);
      expect(ordinaryAssign, label).toBeGreaterThan(repairAssign);
      expect(threadAssign, label).toBeGreaterThan(ordinaryAssign);
      const early = block.slice(
        block.indexOf('DECIDE_OUTPUT_CLEAN='),
        block.indexOf('CURRENT_REF=')
      );
      expect(early, label).not.toContain('Malformed branch name');
      expect(block, label).toContain('grep -Eq "$REPAIR_BRANCH_PATTERN"');
      const repairArm = block.slice(
        block.indexOf('if [ "$REPAIR_TARGET_PR_PRESENT"'),
        block.indexOf('UNIQUE_BRANCH="$REPAIR_TARGET_BRANCH"')
      );
      expect(repairArm, label).toContain('"$REPAIR_BRANCH_PATTERN"');
      expect(repairArm, label).not.toContain('"$BRANCH_PATTERN"');
      const checkout = extractCheckoutRepair(yaml, lane);
      const commit = extractCommitSelection(yaml, lane);
      expect(checkout, label).toContain('SPEC_TEXT="${SPEC_TEXT-}"');
      expect(checkout, label).not.toContain('SPEC_TEXT=$read-spec.output');
      expect(commit, label).toContain('SPEC_TEXT="${SPEC_TEXT-}"');
      expect(commit, label).toContain('CHECKOUT_OUTPUT="${CHECKOUT_OUTPUT-}"');
      expect(commit, label).not.toContain('SPEC_TEXT=$read-spec.output');
      expect(commit, label).not.toContain('CHECKOUT_OUTPUT=$checkout-repair-target.output');
      expect(commit, label).not.toContain('gh pr create');
    }
  });

  it('Test 1: accepts wo and archon task branches on checkout and commit selection', () => {
    const published: Record<string, string> = {};
    for (const branch of ACCEPTED_REPAIR_BRANCHES) {
      published[branch] = publishHead(branch);
    }
    configureOfflineCheckoutOrigin();
    for (const lane of REPAIR_COVERAGE_LANES) {
      const { checkout, commit } = laneScripts(lane);
      for (const branch of ACCEPTED_REPAIR_BRANCHES) {
        const oid = published[branch];
        if (!oid) throw new Error(`missing oid for ${branch}`);
        const label = `${basename(lane)} ${branch}`;
        const pathEnv = fakeGhPath('OPEN', branch, { headRefOid: oid });
        const checkoutResult = bash(checkout, worktreeDir, {
          SPEC_TEXT: matchingRepairSpec(branch),
          PATH: pathEnv,
        });
        if (checkoutResult.exitCode !== 0) throw new Error(showResult(checkoutResult, label));
        expect(checkoutResult.stdout).toContain('REPAIR_TARGET=#826');
        expect(checkoutResult.stdout).toContain(`REPAIR_TARGET_BRANCH=${branch}`);
        expect(checkoutResult.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${oid}`);
        const commitResult = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
          CHECKOUT_OUTPUT: [
            'REPAIR_TARGET=#826',
            `REPAIR_TARGET_BRANCH=${branch}`,
            `REPAIR_TARGET_LEASE_SHA=${oid}`,
          ].join('\n'),
          PATH: pathEnv,
        });
        if (commitResult.exitCode !== 0) throw new Error(showResult(commitResult, label));
        expect(commitResult.stdout).toContain(`UNIQUE_BRANCH=${branch}`);
        expect(commitResult.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${oid}`);
        expect(commitResult.stdout).not.toContain('-thread-');
        expect(commitResult.stdout).not.toContain('UNIQUE_BRANCH=feat/should-not-mint');
      }
    }
  }, 120000);

  it('Test 2: rejects protected, promotion, and malformed repair branches', () => {
    for (const lane of REPAIR_COVERAGE_LANES) {
      const { checkout, commit } = laneScripts(lane);
      for (const branch of REJECTED_REPAIR_BRANCHES) {
        const label = `${basename(lane)} ${branch}`;
        const checkoutResult = bash(checkout, worktreeDir, {
          SPEC_TEXT: matchingRepairSpec(branch),
        });
        if (checkoutResult.exitCode === 0) throw new Error(showResult(checkoutResult, label));
        expect(checkoutResult.stderr).toContain(`invalid repair_target_branch '${branch}'`);
        expect(checkoutResult.stdout).not.toContain('REPAIR_TARGET=#826');
        expect(bash('git rev-parse --abbrev-ref HEAD', worktreeDir).stdout.trim()).toBe('main');
        const commitResult = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
        });
        if (commitResult.exitCode === 0)
          throw new Error(showResult(commitResult, `commit ${label}`));
        expect(commitResult.stderr).toContain(`invalid repair_target_branch '${branch}'`);
        expect(commitResult.stdout).not.toContain('UNIQUE_BRANCH=');
      }
    }
  }, 120000);

  it('Test 3: rejects closed, forked, mismatched, and empty-head repair targets', () => {
    configureOfflineCheckoutOrigin();
    const cases: Array<{
      name: string;
      state: string;
      liveBranch?: string;
      opts?: { cross?: boolean; owner?: string; repo?: string; headRefOid?: string };
      token: string;
    }> = [
      { name: 'closed', state: 'CLOSED', token: 'is CLOSED' },
      {
        name: 'fork',
        state: 'OPEN',
        opts: { cross: true, owner: 'someone-else', repo: 'bdc-harness' },
        token: 'repair_target_rejected:fork',
      },
      {
        name: 'branch-mismatch',
        state: 'OPEN',
        liveBranch: 'feat/a-different-branch',
        token: 'head branch mismatch',
      },
      {
        name: 'empty-sha',
        state: 'OPEN',
        opts: { headRefOid: '' },
        token: 'repair_target_fetch_failed',
      },
    ];
    for (const lane of REPAIR_COVERAGE_LANES) {
      const { checkout, commit } = laneScripts(lane);
      for (const branch of ACCEPTED_REPAIR_BRANCHES) {
        for (const specCase of cases) {
          const label = `${basename(lane)} ${branch} ${specCase.name}`;
          const liveBranch = specCase.liveBranch ?? branch;
          const pathEnv = fakeGhPath(specCase.state, liveBranch, specCase.opts);
          const env = {
            SPEC_TEXT: matchingRepairSpec(branch),
            PATH: pathEnv,
          };
          const checkoutResult = bash(checkout, worktreeDir, env);
          if (checkoutResult.exitCode === 0) throw new Error(showResult(checkoutResult, label));
          expect(`${checkoutResult.stdout}\n${checkoutResult.stderr}`).toContain(specCase.token);
          expect(checkoutResult.stdout).not.toContain('REPAIR_TARGET=#826');
          expect(bash('git rev-parse --abbrev-ref HEAD', worktreeDir).stdout.trim()).toBe('main');
          const commitResult = bash(commit, worktreeDir, {
            ...env,
            DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          });
          if (commitResult.exitCode === 0)
            throw new Error(showResult(commitResult, `commit ${label}`));
          expect(`${commitResult.stdout}\n${commitResult.stderr}`).toContain(specCase.token);
          expect(commitResult.stdout).not.toContain('UNIQUE_BRANCH=');
        }
      }
    }
  }, 120000);

  it('Test 3: rejects fetched-head mismatch before checkout or selection', () => {
    const published: Record<string, string> = {};
    for (const branch of ACCEPTED_REPAIR_BRANCHES) {
      published[branch] = publishHead(branch);
    }
    configureOfflineCheckoutOrigin();
    for (const lane of REPAIR_COVERAGE_LANES) {
      const { checkout, commit } = laneScripts(lane);
      for (const branch of ACCEPTED_REPAIR_BRANCHES) {
        const label = `${basename(lane)} ${branch} fetched-mismatch`;
        const pathEnv = fakeGhPath('OPEN', branch, {
          headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        });
        const checkoutResult = bash(checkout, worktreeDir, {
          SPEC_TEXT: matchingRepairSpec(branch),
          PATH: pathEnv,
        });
        if (checkoutResult.exitCode === 0) throw new Error(showResult(checkoutResult, label));
        expect(checkoutResult.stderr).toContain('repair_target_head_mismatch');
        expect(bash('git rev-parse --abbrev-ref HEAD', worktreeDir).stdout.trim()).toBe('main');
        const commitResult = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
          PATH: pathEnv,
        });
        if (commitResult.exitCode === 0)
          throw new Error(showResult(commitResult, `commit ${label}`));
        expect(commitResult.stderr).toContain('repair_target_head_mismatch');
        expect(commitResult.stdout).not.toContain('UNIQUE_BRANCH=');
        expect(published[branch]).toBeTruthy();
      }
    }
  }, 120000);

  it('Test 3: rejects a moved checkout lease and a lease that is not an ancestor', () => {
    const movedLease = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    for (const branch of ACCEPTED_REPAIR_BRANCHES) {
      const oid = publishHead(branch);
      for (const lane of REPAIR_COVERAGE_LANES) {
        const commit = extractCommitSelection(readFileSync(lane, 'utf8'), lane);
        const label = `${basename(lane)} ${branch} head-moved`;
        const moved = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
          CHECKOUT_OUTPUT: `REPAIR_TARGET_LEASE_SHA=${movedLease}`,
          PATH: fakeGhPath('OPEN', branch, { headRefOid: oid }),
        });
        if (moved.exitCode === 0) throw new Error(showResult(moved, label));
        expect(moved.stderr).toContain('repair_target_head_moved');
        expect(moved.stdout).not.toContain('UNIQUE_BRANCH=');
      }
    }

    for (const branch of ACCEPTED_REPAIR_BRANCHES) {
      const initSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
      const fileName = `pr-only-${branch.replace(/[^A-Za-z0-9]/g, '_')}.txt`;
      writeFileSync(join(worktreeDir, fileName), 'on the PR\n');
      git(['add', fileName], worktreeDir);
      git(['commit', '-m', `pr-only ${branch}`], worktreeDir);
      const leaseSha = bash('git rev-parse HEAD', worktreeDir).stdout.trim();
      git(['push', 'origin', `HEAD:${branch}`], worktreeDir);
      git(['reset', '--hard', initSha], worktreeDir);
      writeFileSync(join(worktreeDir, 'implement.txt'), `run ${branch}\n`);
      git(['add', 'implement.txt'], worktreeDir);
      git(['commit', '-m', `implement ${branch}`], worktreeDir);
      for (const lane of REPAIR_COVERAGE_LANES) {
        const commit = extractCommitSelection(readFileSync(lane, 'utf8'), lane);
        const label = `${basename(lane)} ${branch} not-ancestor`;
        const result = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
          CHECKOUT_OUTPUT: `REPAIR_TARGET_LEASE_SHA=${leaseSha}`,
          PATH: fakeGhPath('OPEN', branch, { headRefOid: leaseSha }),
        });
        if (result.exitCode === 0) throw new Error(showResult(result, label));
        expect(result.stderr).toContain('repair_target_base_not_incorporated');
        expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
      }
    }
  }, 120000);

  it('Test 4: ordinary push_target still rejects wo and archon task branches', () => {
    for (const lane of REPAIR_COVERAGE_LANES) {
      const yaml = readFileSync(lane, 'utf8');
      const commit = extractCommitSelection(yaml, lane);
      expect(yaml.split(ORDINARY_BRANCH_PATTERN).length - 1).toBe(1);
      expect(F6A_VALIDATOR).toContain(ORDINARY_BRANCH_PATTERN);
      for (const branch of ACCEPTED_REPAIR_BRANCHES) {
        const label = `${basename(lane)} ordinary ${branch}`;
        const result = bash(commit, worktreeDir, {
          DECIDE_OUTPUT: `push_target: feature-branch: ${branch}\nrepo: thinmansoftware/bdc-harness\n`,
          SPEC_TEXT: 'WO: WO-TEST\nObjective: no repair target',
        });
        if (result.exitCode === 0) throw new Error(showResult(result, label));
        expect(result.stderr).toContain('Malformed branch name');
        expect(result.stderr).toContain('feat/|fix/|wip/|archon/thread-');
        expect(result.stdout).not.toContain('UNIQUE_BRANCH=');
      }
    }
  }, 120000);

  it('Test 6: repeated selection stays on the original branch and does not dirty the tree', () => {
    const published: Record<string, string> = {};
    for (const branch of ACCEPTED_REPAIR_BRANCHES) {
      published[branch] = publishHead(branch);
    }
    configureOfflineCheckoutOrigin();
    for (const lane of REPAIR_COVERAGE_LANES) {
      const { checkout, commit } = laneScripts(lane);
      for (const branch of ACCEPTED_REPAIR_BRANCHES) {
        const oid = published[branch];
        if (!oid) throw new Error(`missing oid for ${branch}`);
        const label = `${basename(lane)} ${branch}`;
        const pathEnv = fakeGhPath('OPEN', branch, { headRefOid: oid });
        const checkoutEnv = {
          SPEC_TEXT: matchingRepairSpec(branch),
          PATH: pathEnv,
        };
        const firstCheckout = bash(checkout, worktreeDir, checkoutEnv);
        const secondCheckout = bash(checkout, worktreeDir, checkoutEnv);
        if (firstCheckout.exitCode !== 0 || secondCheckout.exitCode !== 0) {
          throw new Error(
            showResult(secondCheckout.exitCode === 0 ? firstCheckout : secondCheckout, label)
          );
        }
        expect(firstCheckout.stdout).toContain(`REPAIR_TARGET_BRANCH=${branch}`);
        expect(secondCheckout.stdout).toContain(`REPAIR_TARGET_BRANCH=${branch}`);
        expect(firstCheckout.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${oid}`);
        expect(secondCheckout.stdout).toContain(`REPAIR_TARGET_LEASE_SHA=${oid}`);
        const commitEnv = {
          DECIDE_OUTPUT: authorizedRepairDecideOutput(branch),
          SPEC_TEXT: matchingRepairSpec(branch),
          CHECKOUT_OUTPUT: `REPAIR_TARGET_LEASE_SHA=${oid}`,
          PATH: pathEnv,
        };
        const firstCommit = bash(commit, worktreeDir, commitEnv);
        const secondCommit = bash(commit, worktreeDir, commitEnv);
        if (firstCommit.exitCode !== 0 || secondCommit.exitCode !== 0) {
          throw new Error(
            showResult(secondCommit.exitCode === 0 ? firstCommit : secondCommit, label)
          );
        }
        expect(firstCommit.stdout).toContain(`UNIQUE_BRANCH=${branch}`);
        expect(secondCommit.stdout).toContain(`UNIQUE_BRANCH=${branch}`);
        expect(firstCommit.stdout).not.toContain('-thread-');
        expect(secondCommit.stdout).not.toContain('-thread-');
        expect(bash('git status --porcelain', worktreeDir).stdout.trim()).toBe('');
      }
    }
  }, 120000);
});
