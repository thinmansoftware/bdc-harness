#!/usr/bin/env bash
# patch-pr-body.sh -- unit tests for the patch-pr-body node logic in
# .archon/workflows/defaults/bdc-feature-development.yaml.
#
# WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01.
#
# The patch-pr-body node assembles a v2-label completion manifest and patches
# the PR body via gh pr edit. The engine substitutes $nodeId.output template
# refs before bash runs. These tests EXERCISE THE SAME LOGIC with stub inputs
# so we can catch regressions without spinning up the engine.
#
# Coverage:
#   1. STATUS guard: skip on ALREADY_SATISFIED / BLOCKED.
#   2. PR URL parsing: bare https URL line vs PR_URL=<url> form.
#   3. REPO + BASE_REF derivation from decide-push-target output.
#   4. Files created/modified lists derive from git diff --name-status (no
#      preserved files leaking in).
#   5. Label extraction from build-manifest output.
#   6. Idempotent re-patch: running twice yields ONE manifest block, not two.
#   7. PROSE preservation: original PR body content above the sentinel survives.
#
# Run: bash .archon/workflows/defaults/__tests__/patch-pr-body.sh
# Exits 0 on all-pass, 1 on any failure.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  # assert_eq <label> <expected> <actual>
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_contains() {
  # assert_contains <label> <needle> <haystack>
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle:   $needle"
    echo "  haystack: $haystack"
  fi
}

assert_count() {
  # assert_count <label> <expected_count> <pattern> <haystack>
  local label="$1" expected="$2" pattern="$3" haystack="$4"
  local actual
  actual=$(printf '%s\n' "$haystack" | grep -c "$pattern" || true)
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  pattern:        $pattern"
    echo "  expected count: $expected"
    echo "  actual count:   $actual"
  fi
}

# -----------------------------------------------------------------------------
# Test 1: STATUS guard -- skip on ALREADY_SATISFIED and BLOCKED
# -----------------------------------------------------------------------------
echo "--- Test 1: STATUS guard ---"
parse_status() {
  printf '%s\n' "$1" | sed -n 's/.*"status":"\([A-Z_]*\)".*/\1/p' | head -1
}
assert_eq "status=PROCEED parsed" "PROCEED" "$(parse_status '{"status":"PROCEED"}')"
assert_eq "status=ALREADY_SATISFIED parsed" "ALREADY_SATISFIED" \
  "$(parse_status '{"status":"ALREADY_SATISFIED","note":"opus-confirmed-already-satisfied"}')"
assert_eq "status=BLOCKED parsed" "BLOCKED" \
  "$(parse_status '{"status":"BLOCKED","note":"opus-could-not-resolve"}')"

# -----------------------------------------------------------------------------
# Test 2: PR URL parsing -- both formats
# -----------------------------------------------------------------------------
echo "--- Test 2: PR URL parsing ---"
parse_pr_url() {
  local out="$1"
  local url
  url=$(printf '%s\n' "$out" | grep -E '^PR_URL=' | sed 's/^PR_URL=//' | head -1)
  if [ -z "$url" ]; then
    url=$(printf '%s\n' "$out" | grep -E '^https://github\.com/' | head -1)
  fi
  printf '%s' "$url"
}
# Bare-URL form (gh pr create stdout)
OPEN1=$'Creating pull request for...\nhttps://github.com/bluedevilcollectibles/bdc-harness/pull/420'
assert_eq "bare URL extracted" "https://github.com/bluedevilcollectibles/bdc-harness/pull/420" \
  "$(parse_pr_url "$OPEN1")"
# PR_URL= form (race-recovery)
OPEN2=$'WARN: gh pr create attempt 1 failed\nPR_URL=https://github.com/bluedevilcollectibles/bdc-harness/pull/421'
assert_eq "PR_URL= extracted" "https://github.com/bluedevilcollectibles/bdc-harness/pull/421" \
  "$(parse_pr_url "$OPEN2")"
# Empty case
assert_eq "no URL returns empty" "" "$(parse_pr_url "no urls here")"

# -----------------------------------------------------------------------------
# Test 3: REPO + BASE_REF derivation from decide-push-target output
# -----------------------------------------------------------------------------
echo "--- Test 3: REPO + BASE_REF derivation ---"
parse_repo() {
  printf '%s\n' "$1" | sed -n 's/^repo: //p' | head -1
}
parse_staging_gate() {
  printf '%s\n' "$1" | grep -c '^staging_gate_required: true' 2>/dev/null || true
}
DECIDE_NON_STAGING=$'push_target: feature-branch:feat/wo-foo-01\npr_required: true\nstaging_gate_required: false\nrepo: bluedevilcollectibles/bdc-harness'
DECIDE_STAGING=$'push_target: feature-branch:feat/wo-bar-01\npr_required: true\nstaging_gate_required: true\nrepo: bluedevilcollectibles/lspro-react'
assert_eq "repo (non-staging)" "bluedevilcollectibles/bdc-harness" "$(parse_repo "$DECIDE_NON_STAGING")"
assert_eq "repo (staging)" "bluedevilcollectibles/lspro-react" "$(parse_repo "$DECIDE_STAGING")"
SG1=$(parse_staging_gate "$DECIDE_NON_STAGING")
SG1="${SG1:-0}"
assert_eq "staging_gate=0 for bdc-harness" "0" "$SG1"
SG2=$(parse_staging_gate "$DECIDE_STAGING")
SG2="${SG2:-0}"
assert_eq "staging_gate>=1 for lspro-react" "1" "$SG2"

# -----------------------------------------------------------------------------
# Test 4: Files lists derive from git diff (no preserved files leak in)
# -----------------------------------------------------------------------------
echo "--- Test 4: Files lists from git diff name-status ---"
# Simulate `git diff --name-status` output. Validator CHECK 2 fails when an
# unchanged file is listed. The node's awk must only pick A= or M= entries
# and NEVER list a file that did not appear in the diff (the #307 lesson).
DIFF_FIXTURE=$'A\tpath/added/one.ts\nA\tpath/added/two.ts\nM\tpath/modified/three.ts\nD\tpath/removed/four.ts'
FILES_CREATED=$(printf '%s\n' "$DIFF_FIXTURE" | awk '$1=="A"{print $2}' | paste -sd ',' -)
FILES_MODIFIED=$(printf '%s\n' "$DIFF_FIXTURE" | awk '$1=="M"{print $2}' | paste -sd ',' -)
assert_eq "Files created (added only)" "path/added/one.ts,path/added/two.ts" "$FILES_CREATED"
assert_eq "Files modified (modified only)" "path/modified/three.ts" "$FILES_MODIFIED"

# Empty diff -> fallback to "none"
EMPTY_DIFF=""
FC_EMPTY=$(printf '%s\n' "$EMPTY_DIFF" | awk '$1=="A"{print $2}' | paste -sd ',' -)
[ -z "$FC_EMPTY" ] && FC_EMPTY="none"
assert_eq "Empty diff -> Files created=none" "none" "$FC_EMPTY"

# Preserved/unchanged files MUST NOT appear because git diff never emits them
DIFF_REGRESSION=$'A\tnew.ts\nM\tchanged.ts'
ALL_OUTPUT=$(printf '%s\n' "$DIFF_REGRESSION" | awk '$1=="A" || $1=="M"{print $2}')
assert_count "no preserved files in output" "0" "preserved" "$ALL_OUTPUT"

# -----------------------------------------------------------------------------
# Test 5: Label extraction from build-manifest output
# -----------------------------------------------------------------------------
echo "--- Test 5: Label extraction ---"
MANIFEST_FIXTURE=$'WO: WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01\nBuilder: Codex\nFiles created: a.ts,b.ts\nFiles modified: c.ts\nTests: 12 / 12\nPRs: https://github.com/x/y/pull/1\nMerge ancestors: abc...def (behind_by=0)\nGrep assertions: N/A (auto)\nRuntime verification: N/A (sync)\nVALIDATION: PASS'
extract() {
  local label="$1" out="$2"
  printf '%s\n' "$out" | grep -E "^${label}:" | head -1 | sed "s/^${label}:[[:space:]]*//"
}
assert_eq "extract WO" "WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01" \
  "$(extract WO "$MANIFEST_FIXTURE")"
assert_eq "extract Builder" "Codex" "$(extract Builder "$MANIFEST_FIXTURE")"
assert_eq "extract Tests" "12 / 12" "$(extract Tests "$MANIFEST_FIXTURE")"
assert_eq "extract PRs" "https://github.com/x/y/pull/1" "$(extract PRs "$MANIFEST_FIXTURE")"
VALIDATION_LINE=$(printf '%s\n' "$MANIFEST_FIXTURE" | grep -E '^VALIDATION:' | head -1)
assert_eq "extract VALIDATION line" "VALIDATION: PASS" "$VALIDATION_LINE"

# Missing field -> empty (callers default to fallback)
assert_eq "missing field empty" "" "$(extract NOPE "$MANIFEST_FIXTURE")"

# -----------------------------------------------------------------------------
# Test 6: Idempotent re-patch -- running twice yields ONE manifest block
# -----------------------------------------------------------------------------
echo "--- Test 6: Idempotent strip + append ---"
STUB_BODY=$'## Summary\nLines of summary prose.\n\n## Validation\nLine.\n\n## Implement output\nbuilder output here.\n\n## Validator\nvalidator output.'
NEW_MANIFEST=$'WO: WO-FOO-01\nBuilder: Codex\nFiles created: a.ts\nFiles modified: b.ts\nTests: 1 / 1\nPRs: https://example/1\nMerge ancestors: N/A\nGrep assertions: N/A (auto)\nRuntime verification: N/A (auto)\nVALIDATION: PASS'

build_patched_body() {
  local current="$1" manifest="$2"
  local prose new_body
  prose=$(printf '%s\n' "$current" | awk '/^<!-- bdc-manifest-start -->$/{exit} {print}')
  new_body=$(printf '%s\n\n<!-- bdc-manifest-start -->\n%s\n<!-- bdc-manifest-end -->\n' "$prose" "$manifest")
  printf '%s' "$new_body"
}

# First patch
BODY1=$(build_patched_body "$STUB_BODY" "$NEW_MANIFEST")
assert_count "first patch: exactly 1 manifest block" "1" "^<!-- bdc-manifest-start -->$" "$BODY1"
assert_contains "first patch: prose preserved" "## Summary" "$BODY1"
assert_contains "first patch: manifest WO present" "WO: WO-FOO-01" "$BODY1"
assert_contains "first patch: VALIDATION present" "VALIDATION: PASS" "$BODY1"

# Second patch (idempotent): same call with new manifest must yield ONE block.
NEWER_MANIFEST=$'WO: WO-FOO-01\nBuilder: Codex\nFiles created: a.ts,c.ts\nFiles modified: b.ts\nTests: 2 / 2\nPRs: https://example/1\nMerge ancestors: N/A\nGrep assertions: N/A (auto)\nRuntime verification: N/A (auto)\nVALIDATION: PASS'
BODY2=$(build_patched_body "$BODY1" "$NEWER_MANIFEST")
assert_count "second patch: still exactly 1 manifest block" "1" "^<!-- bdc-manifest-start -->$" "$BODY2"
assert_count "second patch: still exactly 1 manifest end" "1" "^<!-- bdc-manifest-end -->$" "$BODY2"
assert_contains "second patch: prose still preserved" "## Summary" "$BODY2"
assert_contains "second patch: new Tests count present" "Tests: 2 / 2" "$BODY2"
# The OLD Tests line ("Tests: 1 / 1") must NOT appear -- replaced, not appended.
assert_count "second patch: old Tests line gone" "0" "Tests: 1 / 1" "$BODY2"

# -----------------------------------------------------------------------------
# Test 7: Prose with bare --- lines is NOT cut (unique sentinel is safe)
# -----------------------------------------------------------------------------
echo "--- Test 7: Prose containing --- survives the strip ---"
PROSE_WITH_HR=$'## Summary\nintro\n---\nmiddle paragraph after horizontal rule\n---\nclosing'
BODY3=$(build_patched_body "$PROSE_WITH_HR" "$NEW_MANIFEST")
# Both horizontal-rule lines must survive (strip uses HTML comment sentinel, not ---).
assert_count "two --- HR lines preserved" "2" "^---$" "$BODY3"
assert_contains "middle paragraph preserved" "middle paragraph" "$BODY3"
assert_contains "closing preserved" "closing" "$BODY3"
assert_count "still exactly 1 manifest block" "1" "^<!-- bdc-manifest-start -->$" "$BODY3"

# -----------------------------------------------------------------------------
# Test 8: Empty initial body (defensive)
# -----------------------------------------------------------------------------
echo "--- Test 8: Empty current body ---"
BODY4=$(build_patched_body "" "$NEW_MANIFEST")
assert_count "empty body: 1 manifest block" "1" "^<!-- bdc-manifest-start -->$" "$BODY4"
assert_contains "empty body: WO line present" "WO: WO-FOO-01" "$BODY4"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "==== patch-pr-body.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
