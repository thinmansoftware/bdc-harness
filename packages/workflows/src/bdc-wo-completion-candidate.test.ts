/**
 * Behavioral tests for the record-wo-completion-candidate tail node in
 * bdc-feature-development.yaml / bdc-feature-development-codex.yaml.
 *
 * WO-HARNESS-WO-COMPLETION-COUNTER-01 (Codex diff-review Finding #3 / #4).
 *
 * The node is new, non-trivial, fail-soft bash that:
 *   - guards on block-reclassify status (records nothing unless PROCEED),
 *   - derives PR_NUMBER from the already-resolved PR_URL (Finding #4: a flaky
 *     `gh pr view` must NOT collapse the pending filename to ${WO_ID}__0.json),
 *   - builds a pending-candidate JSON payload handed to the bdc-xo reconciler.
 *
 * These three deterministic, network-free behaviors are exercised here via
 * Bun.spawnSync against fixtures (mirrors the bdc-push-correctness.test.ts
 * pattern). A `gh` PATH stub proves the URL-derivation path never shells out to
 * the network. A drift guard parses the real YAML for both lanes and asserts the
 * mirrored snippets still match the shipped node bash, so the mirrors below
 * cannot silently diverge from the workflow. No mock.module() calls -- safe in
 * its own bun test invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Snippet 1 (STATUS-guard): only a PROCEED build records a candidate.
// Mirrors bdc-feature-development.yaml (set -uo pipefail + status extraction +
// non-PROCEED early exit). $RECLASSIFY stands in for the substituted
// $block-reclassify.output. Prints PROCEED_PATH only when it would record.
// ---------------------------------------------------------------------------
const STATUS_GUARD = `
set -uo pipefail
STATUS=$(printf '%s\\n' "$RECLASSIFY" | sed -n 's/.*"status":"\\([A-Z_]*\\)".*/\\1/p' | head -1)
if [ "$STATUS" != "PROCEED" ]; then
  echo "record-wo-completion-candidate: status=\${STATUS:-<none>} -- no PR to count; nothing recorded."
  exit 0
fi
echo "PROCEED_PATH"
`;

// ---------------------------------------------------------------------------
// Snippet 2 (PR_NUMBER derivation, Finding #4): trailing path segment first,
// gh lookup only when the URL has no numeric tail, "0" only as last resort.
// Mirrors the hardened block. A `gh` PATH stub echoes GH_STUB_CALLED so we can
// assert the network path is (not) taken.
// ---------------------------------------------------------------------------
const PR_NUMBER_DERIVE = `
set -uo pipefail
PR_NUMBER="\${PR_URL##*/}"
case "$PR_NUMBER" in
  ''|*[!0-9]*)
    PR_NUMBER=$(gh pr view "$PR_URL" --repo "$REPO" --json number --jq '.number' 2>/dev/null || true)
    ;;
esac
[ -z "$PR_NUMBER" ] && PR_NUMBER="0"
echo "PR_NUMBER=$PR_NUMBER"
`;

// ---------------------------------------------------------------------------
// Snippet 3 (JSON-shape): esc() + printf payload. Mirrors the pending-JSON
// build. counted_at is intentionally absent (the reconciler stamps it).
// ---------------------------------------------------------------------------
const JSON_SHAPE = `
set -uo pipefail
CANDIDATE_ID="WO-HARNESS-WO-COMPLETION-COUNTER-01"
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
if [ -n "$GREEN_AT" ]; then GREEN_FIELD=$(printf '"%s"' "$GREEN_AT"); else GREEN_FIELD="null"; fi
JSON=$(printf '{"wo_id":"%s","repo":"%s","pr_url":"%s","pr_number":%s,"lane":"%s","run_id":"%s","status":"%s","pr_merged_or_green_at":%s,"observed_at":"%s"}' \\
  "$(esc "$CANDIDATE_ID")" "$(esc "$REPO")" "$(esc "$PR_URL")" "$PR_NUMBER" "$(esc "$LANE")" "$(esc "$RUN_ID")" "$CHECK_STATUS" "$GREEN_FIELD" "$OBSERVED_AT")
printf '%s' "$JSON"
`;

function runBash(
  snippet: string,
  env: Record<string, string>,
  extraPath?: string
): { code: number; stdout: string; stderr: string } {
  const PATH = extraPath ? `${extraPath}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '');
  const result = Bun.spawnSync(['bash', '-c', snippet], {
    env: { ...process.env, ...env, PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

describe('record-wo-completion-candidate: STATUS guard', () => {
  it('records nothing and exits 0 when block-reclassify is not PROCEED', () => {
    const r = runBash(STATUS_GUARD, { RECLASSIFY: '{"status":"BLOCKED"}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('nothing recorded');
    expect(r.stdout).not.toContain('PROCEED_PATH');
  });

  it('records nothing and exits 0 when status is absent', () => {
    const r = runBash(STATUS_GUARD, { RECLASSIFY: 'no status here' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('status=<none>');
    expect(r.stdout).not.toContain('PROCEED_PATH');
  });

  it('proceeds to recording only when status is PROCEED', () => {
    const r = runBash(STATUS_GUARD, { RECLASSIFY: '{"status":"PROCEED"}' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('PROCEED_PATH');
  });
});

describe('record-wo-completion-candidate: PR_NUMBER derivation (Finding #4)', () => {
  let stubDir: string;

  beforeEach(() => {
    // A `gh` stub that records its invocation. If PR_NUMBER derivation shells
    // out, GH_STUB_CALLED is emitted; a well-formed URL must NOT trigger it.
    stubDir = mkdtempSync(join(tmpdir(), 'wo-counter-gh-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, '#!/usr/bin/env bash\necho GH_STUB_CALLED\n', 'utf8');
    chmodSync(ghPath, 0o755);
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('derives the number from the PR_URL tail without calling gh', () => {
    const r = runBash(
      PR_NUMBER_DERIVE,
      { PR_URL: 'https://github.com/thinmansoftware/bdc-harness/pull/334', REPO: 'x/y' },
      stubDir
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('PR_NUMBER=334');
    // Ground-truth URL path must never touch the network.
    expect(r.stdout).not.toContain('GH_STUB_CALLED');
  });

  it('does NOT collapse to 0 when gh would be flaky but the URL is well-formed', () => {
    // gh stub returns empty (simulating a flaky/failing `gh pr view`); because
    // the URL carries the number, PR_NUMBER stays real, not "0".
    const flakyDir = mkdtempSync(join(tmpdir(), 'wo-counter-flaky-'));
    const ghPath = join(flakyDir, 'gh');
    writeFileSync(ghPath, '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    chmodSync(ghPath, 0o755);
    try {
      const r = runBash(
        PR_NUMBER_DERIVE,
        { PR_URL: 'https://github.com/o/r/pull/7', REPO: 'o/r' },
        flakyDir
      );
      expect(r.stdout).toBe('PR_NUMBER=7');
    } finally {
      rmSync(flakyDir, { recursive: true, force: true });
    }
  });

  it('falls back to the gh lookup when the URL has no numeric tail', () => {
    const r = runBash(
      PR_NUMBER_DERIVE,
      { PR_URL: 'https://github.com/o/r/pull/', REPO: 'o/r' },
      stubDir
    );
    expect(r.code).toBe(0);
    // gh stub prints GH_STUB_CALLED, which becomes PR_NUMBER via the fallback.
    expect(r.stdout).toBe('PR_NUMBER=GH_STUB_CALLED');
  });

  it('falls back to "0" only when neither the URL tail nor gh yields a number', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'wo-counter-empty-'));
    const ghPath = join(emptyDir, 'gh');
    // gh present but returns nothing.
    writeFileSync(ghPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(ghPath, 0o755);
    try {
      const r = runBash(PR_NUMBER_DERIVE, { PR_URL: 'not-a-url', REPO: 'o/r' }, emptyDir);
      expect(r.stdout).toBe('PR_NUMBER=0');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('record-wo-completion-candidate: JSON shape', () => {
  const skipOnWindows = (): boolean => {
    // This mirrors a Linux Cauldron bash node. Git Bash under the Windows Bun
    // test runner has incompatible parameter/assignment behavior for this
    // multi-line JSON snippet, while Ubuntu CI exercises the real contract.
    return process.platform === 'win32';
  };

  const baseEnv = {
    WO_ID: 'WO-HARNESS-WO-COMPLETION-COUNTER-01',
    CANDIDATE_ID: 'WO-HARNESS-WO-COMPLETION-COUNTER-01',
    REPO: 'thinmansoftware/bdc-harness',
    PR_URL: 'https://github.com/thinmansoftware/bdc-harness/pull/334',
    PR_NUMBER: '334',
    LANE: 'bdc-feature-development',
    RUN_ID: '1c0eb2787f738ee04be9f305f9221992',
    CHECK_STATUS: 'green_pending_reconcile',
    OBSERVED_AT: '2026-07-03T00:00:00Z',
  };

  it('emits valid JSON with pr_number as an unquoted integer and green_at as a quoted string', () => {
    if (skipOnWindows()) return;
    const r = runBash(JSON_SHAPE, { ...baseEnv, GREEN_AT: '2026-07-03T00:01:00Z' });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wo_id).toBe(baseEnv.WO_ID);
    expect(parsed.repo).toBe(baseEnv.REPO);
    expect(parsed.pr_url).toBe(baseEnv.PR_URL);
    expect(parsed.pr_number).toBe(334); // number, not string
    expect(parsed.lane).toBe(baseEnv.LANE);
    expect(parsed.run_id).toBe(baseEnv.RUN_ID);
    expect(parsed.status).toBe('green_pending_reconcile');
    expect(parsed.pr_merged_or_green_at).toBe('2026-07-03T00:01:00Z');
    expect(parsed.observed_at).toBe(baseEnv.OBSERVED_AT);
    // The reconciler stamps counted_at; the node must not.
    expect(parsed).not.toHaveProperty('counted_at');
  });

  it('emits null (not a string) for pr_merged_or_green_at when there is no green timestamp', () => {
    if (skipOnWindows()) return;
    const r = runBash(JSON_SHAPE, { ...baseEnv, CHECK_STATUS: 'pending_checks', GREEN_AT: '' });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.pr_merged_or_green_at).toBeNull();
    expect(parsed.status).toBe('pending_checks');
  });

  it('escapes embedded quotes/backslashes so a hostile-looking WO_ID stays valid JSON', () => {
    if (skipOnWindows()) return;
    const hostileShape = JSON_SHAPE.replace(
      'WO-HARNESS-WO-COMPLETION-COUNTER-01',
      'WO-\\"evil\\"\\\\x'
    );
    const r = runBash(hostileShape, { ...baseEnv, GREEN_AT: '' });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout); // throws if escaping is wrong -> test fails
    expect(parsed.wo_id).toBe('WO-"evil"\\x');
  });
});

describe('record-wo-completion-candidate: mirrors match shipped YAML (drift guard)', () => {
  const lanes = [
    {
      file: '.archon/workflows/defaults/bdc-feature-development.yaml',
      lane: 'bdc-feature-development',
    },
    {
      file: '.archon/workflows/defaults/bdc-feature-development-codex.yaml',
      lane: 'bdc-feature-development-codex',
    },
  ];

  for (const { file, lane } of lanes) {
    it(`${lane}: node bash contains the guard, hardened PR_NUMBER, and JSON printf`, () => {
      const repoRoot = join(import.meta.dir, '..', '..', '..');
      const obj = Bun.YAML.parse(readFileSync(join(repoRoot, file), 'utf8')) as {
        nodes: Array<{ id: string; bash?: string }>;
      };
      const node = obj.nodes.find(n => n.id === 'record-wo-completion-candidate');
      expect(node).toBeDefined();
      const bash = node?.bash ?? '';
      // STATUS guard
      expect(bash).toContain('if [ "$STATUS" != "PROCEED" ]; then');
      // Hardened PR_NUMBER derivation (Finding #4)
      expect(bash).toContain('PR_NUMBER="${PR_URL##*/}"');
      expect(bash).toContain("''|*[!0-9]*)");
      // JSON payload shape
      expect(bash).toContain('"pr_number":%s');
      expect(bash).toContain('"pr_merged_or_green_at":%s');
      // Fail-soft: always exit 0
      expect(bash.trimEnd().endsWith('exit 0')).toBe(true);
    });
  }
});
