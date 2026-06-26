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
# Test 3: REPO derivation from decide-push-target + BASE_REF derived from the
#         actual PR's baseRefName (Finding 3 fix: never assume origin/dev for
#         non-staging-gate repos -- gh defaults to each repo's actual default
#         branch, which may be 'main' or 'dev' or something else).
# -----------------------------------------------------------------------------
echo "--- Test 3: REPO + PR baseRefName derivation ---"
parse_repo() {
  printf '%s\n' "$1" | sed -n 's/^repo: //p' | head -1
}
DECIDE_NON_STAGING=$'push_target: feature-branch:feat/wo-foo-01\npr_required: true\nstaging_gate_required: false\nrepo: bluedevilcollectibles/bdc-harness'
DECIDE_STAGING=$'push_target: feature-branch:feat/wo-bar-01\npr_required: true\nstaging_gate_required: true\nrepo: bluedevilcollectibles/lspro-react'
assert_eq "repo (non-staging)" "bluedevilcollectibles/bdc-harness" "$(parse_repo "$DECIDE_NON_STAGING")"
assert_eq "repo (staging)" "bluedevilcollectibles/lspro-react" "$(parse_repo "$DECIDE_STAGING")"

# BASE_REF now derives from the PR's baseRefName, NOT from a guessed branch.
# Simulate the post-pr-view step: PR_BASE is the JSON baseRefName from
# `gh pr view --json baseRefName --jq '.baseRefName'`; BASE_REF is origin/<that>.
derive_base_ref() {
  local pr_base="$1"
  if [ -z "$pr_base" ]; then
    echo ""
    return
  fi
  echo "origin/${pr_base}"
}
assert_eq "BASE_REF for default-dev repo" "origin/dev"  "$(derive_base_ref "dev")"
assert_eq "BASE_REF for default-main repo" "origin/main" "$(derive_base_ref "main")"
assert_eq "BASE_REF for staging-gate repo" "origin/staging" "$(derive_base_ref "staging")"
# Empty baseRefName must NOT silently fall back to a guess -- the node fails.
assert_eq "BASE_REF empty when gh pr view fails" "" "$(derive_base_ref "")"

# -----------------------------------------------------------------------------
# Test 4: Files lists derive from git diff -- ALL name-status codes
# -----------------------------------------------------------------------------
echo "--- Test 4: Files lists from git diff name-status ---"
# Simulate `git diff --name-status` output. Validator CHECK 2 fails when an
# unchanged file is listed. The node's awk must:
#   * pick the right paths for each status (A, M, D, R*, C*)
#   * never list a file that did not appear in the diff (the #307 lesson)
#   * annotate D and the rename-source as "(deleted)" so the validator's
#     deleted-file path can confirm them via git history.
# These derive() helpers mirror the awk programs in the node 1:1.
derive_created() {
  printf '%s\n' "$1" | awk -F'\t' '
    $1=="A"           { print $2 }
    $1 ~ /^R[0-9]*$/  { print $3 }
    $1 ~ /^C[0-9]*$/  { print $3 }
  ' | awk 'NF' | paste -sd ',' -
}
derive_modified() {
  printf '%s\n' "$1" | awk -F'\t' '
    $1=="M"           { print $2 }
    $1=="D"           { printf "%s (deleted)\n", $2 }
    $1 ~ /^R[0-9]*$/  { printf "%s (deleted)\n", $2 }
  ' | awk 'NF' | paste -sd ',' -
}

# 4a. Mixed A + M (the original happy-path case)
DIFF_FIXTURE=$'A\tpath/added/one.ts\nA\tpath/added/two.ts\nM\tpath/modified/three.ts'
assert_eq "Files created (A only)" "path/added/one.ts,path/added/two.ts" \
  "$(derive_created "$DIFF_FIXTURE")"
assert_eq "Files modified (M only)" "path/modified/three.ts" \
  "$(derive_modified "$DIFF_FIXTURE")"

# 4b. Deletion-only PR -- previously emitted "none" for both lists (Finding 4)
DIFF_DELETE_ONLY=$'D\tpath/removed/four.ts\nD\tpath/removed/five.ts'
DEL_CREATED=$(derive_created "$DIFF_DELETE_ONLY")
DEL_MODIFIED=$(derive_modified "$DIFF_DELETE_ONLY")
[ -z "$DEL_CREATED" ] && DEL_CREATED="none"
assert_eq "Delete-only: Files created=none" "none" "$DEL_CREATED"
assert_eq "Delete-only: Files modified annotates (deleted)" \
  "path/removed/four.ts (deleted),path/removed/five.ts (deleted)" "$DEL_MODIFIED"

# 4c. Rename: old path -> Files modified "(deleted)"; new path -> Files created
DIFF_RENAME=$'R100\told/path.ts\tnew/path.ts\nR075\tlib/a.ts\tlib/b.ts'
assert_eq "Rename: new path -> Files created" "new/path.ts,lib/b.ts" \
  "$(derive_created "$DIFF_RENAME")"
assert_eq "Rename: old path -> Files modified (deleted)" \
  "old/path.ts (deleted),lib/a.ts (deleted)" "$(derive_modified "$DIFF_RENAME")"

# 4d. Copy: new path -> Files created; source NOT listed (it is unchanged)
DIFF_COPY=$'C100\tlib/source.ts\tlib/dest.ts'
assert_eq "Copy: new path -> Files created" "lib/dest.ts" \
  "$(derive_created "$DIFF_COPY")"
assert_eq "Copy: source untouched -> Files modified=empty" "" \
  "$(derive_modified "$DIFF_COPY")"

# 4e. Full coverage -- all five statuses in one diff
DIFF_MIXED=$'A\tnew.ts\nM\tchanged.ts\nD\tgone.ts\nR090\told.ts\tmoved.ts\nC080\tsrc.ts\tcopied.ts'
assert_eq "Mixed: Files created (A + R-new + C-new)" "new.ts,moved.ts,copied.ts" \
  "$(derive_created "$DIFF_MIXED")"
assert_eq "Mixed: Files modified (M + D + R-old)" \
  "changed.ts,gone.ts (deleted),old.ts (deleted)" \
  "$(derive_modified "$DIFF_MIXED")"

# 4f. Empty diff -> both fall back to "none"
EMPTY_DIFF=""
FC_EMPTY=$(derive_created "$EMPTY_DIFF")
FM_EMPTY=$(derive_modified "$EMPTY_DIFF")
[ -z "$FC_EMPTY" ] && FC_EMPTY="none"
[ -z "$FM_EMPTY" ] && FM_EMPTY="none"
assert_eq "Empty diff -> Files created=none" "none" "$FC_EMPTY"
assert_eq "Empty diff -> Files modified=none" "none" "$FM_EMPTY"

# 4g. Preserved/unchanged files never leak in (regression guard for #307)
DIFF_REGRESSION=$'A\tnew.ts\nM\tchanged.ts'
ALL_OUTPUT=$(derive_created "$DIFF_REGRESSION")$'\n'$(derive_modified "$DIFF_REGRESSION")
assert_count "no preserved files in output" "0" "preserved" "$ALL_OUTPUT"

# 4h. T1 (WO-HARNESS-PATCH-PR-BODY-PIPEFAIL-FIX-01): empty diff must NOT abort
# under `set -euo pipefail`. The pre-fix node used `grep -v '^$'`, which exits 1
# on empty stdin; under pipefail+errexit that exit-1 aborted the FILES_CREATED
# command substitution BEFORE the `="none"` fallback could run, marking the
# entire patch-pr-body node as failed even on clean builds. The fix swaps in
# `awk 'NF'` (always exits 0). This test runs the full derivation in a child
# bash with strict mode and asserts (a) exit 0 and (b) both lists fall back to
# "none". We use a temp file rather than `bash -c` to keep the nested quoting
# from awk literals + pipefail readable.
echo "--- Test 4h: empty diff does not abort under set -euo pipefail (T1) ---"
T1_SCRIPT=$(mktemp)
cat > "$T1_SCRIPT" <<'T1_EOF'
set -euo pipefail
NAME_STATUS=""
FILES_CREATED=$(printf '%s\n' "$NAME_STATUS" | awk -F'\t' '
  $1=="A"           { print $2 }
  $1 ~ /^R[0-9]*$/  { print $3 }
  $1 ~ /^C[0-9]*$/  { print $3 }
' | awk 'NF' | paste -sd ',' -)
FILES_MODIFIED=$(printf '%s\n' "$NAME_STATUS" | awk -F'\t' '
  $1=="M"           { print $2 }
  $1=="D"           { printf "%s (deleted)\n", $2 }
  $1 ~ /^R[0-9]*$/  { printf "%s (deleted)\n", $2 }
' | awk 'NF' | paste -sd ',' -)
[ -z "$FILES_CREATED" ]  && FILES_CREATED="none"
[ -z "$FILES_MODIFIED" ] && FILES_MODIFIED="none"
printf '%s|%s' "$FILES_CREATED" "$FILES_MODIFIED"
T1_EOF
set +e
T1_OUT=$(bash "$T1_SCRIPT")
T1_EXIT=$?
set -e
rm -f "$T1_SCRIPT"
assert_eq "T1: empty diff does not abort (exit 0)" "0" "$T1_EXIT"
assert_eq "T1: FILES_CREATED + FILES_MODIFIED fall back to none" "none|none" "$T1_OUT"

# -----------------------------------------------------------------------------
# Test 4i: empty-tree fallback uses the two-arg diff form (T2)
# -----------------------------------------------------------------------------
# Regression guard for WO-HARNESS-PATCH-PR-BODY-PIPEFAIL-FIX-01 codex review:
# the last-resort fallback sets BASE_REF to git's empty-tree sha when neither
# origin/<base> nor FETCH_HEAD is present (fresh branch in a sparse worktree).
# The old code then ran `git diff --name-status "${BASE_REF}...HEAD"` -- but
# three-dot symmetric-diff requires BOTH endpoints to be commit-ish, and a
# tree object is rejected. The failure was masked by `|| true`, so the manifest
# silently emitted NAME_STATUS="" and Files created / modified = "none" even
# though every tracked file was supposed to be listed as added.
#
# The fix routes the empty-tree case through `git diff --name-status BASE HEAD`
# (two-arg form), which DOES accept a tree on the left and lists every tracked
# file as A. This test builds a throwaway repo, runs both forms, and asserts:
#   * three-dot form fails / returns empty (the bug we are guarding against)
#   * two-arg form returns one A line per tracked file (the fix)
echo "--- Test 4i: empty-tree fallback uses two-arg diff (T2) ---"
T2_TMPDIR=$(mktemp -d)
# IMPORTANT: keep the capture file OUTSIDE the git repo -- if it lived inside
# the temp dir, `git add .` would track it and inflate the diff line count.
T2_OUT=$(mktemp)
(
  cd "$T2_TMPDIR"
  git init --quiet
  git config user.email "test@example.com"
  git config user.name "Test"
  mkdir -p a b
  printf 'one\n'   > a/one.ts
  printf 'two\n'   > a/two.ts
  printf 'three\n' > b/three.ts
  git add .
  git commit --quiet -m "seed"
  EMPTY_TREE=$(git hash-object -t tree /dev/null)

  # Three-dot symmetric-diff against a tree must fail (or emit empty) -- this
  # is the bug the fix exists to avoid. We do NOT want to assert on the exact
  # exit code here because some git versions print to stderr and exit 128
  # while others exit 0 with empty stdout; in either case, the captured stdout
  # is empty, which is the symptom the manifest node would have observed.
  THREE_DOT_OUT=$(git diff --name-status "${EMPTY_TREE}...HEAD" 2>/dev/null || true)
  THREE_DOT_LINES=$(printf '%s\n' "$THREE_DOT_OUT" | awk 'NF' | wc -l | tr -d ' ')

  # Two-arg form (the fix) lists every tracked file as added.
  TWO_ARG_OUT=$(git diff --name-status "${EMPTY_TREE}" HEAD 2>/dev/null || true)
  TWO_ARG_LINES=$(printf '%s\n' "$TWO_ARG_OUT" | awk 'NF' | wc -l | tr -d ' ')
  TWO_ARG_A_LINES=$(printf '%s\n' "$TWO_ARG_OUT" | awk -F'\t' '$1=="A"{c++} END{print c+0}')

  printf 'THREE_DOT_LINES=%s\nTWO_ARG_LINES=%s\nTWO_ARG_A_LINES=%s\n' \
    "$THREE_DOT_LINES" "$TWO_ARG_LINES" "$TWO_ARG_A_LINES"
) > "$T2_OUT" 2>/dev/null
T2_THREE_DOT=$(grep -E '^THREE_DOT_LINES=' "$T2_OUT" | sed 's/^THREE_DOT_LINES=//')
T2_TWO_ARG=$(grep -E '^TWO_ARG_LINES=' "$T2_OUT" | sed 's/^TWO_ARG_LINES=//')
T2_TWO_ARG_A=$(grep -E '^TWO_ARG_A_LINES=' "$T2_OUT" | sed 's/^TWO_ARG_A_LINES=//')
rm -rf "$T2_TMPDIR" "$T2_OUT"
assert_eq "T2: three-dot vs tree returns empty (bug symptom)" "0" "$T2_THREE_DOT"
assert_eq "T2: two-arg vs tree lists 3 files"                 "3" "$T2_TWO_ARG"
assert_eq "T2: two-arg vs tree marks all 3 as Added"          "3" "$T2_TWO_ARG_A"

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
VALIDATION_LINE=$(printf '%s\n' "$MANIFEST_FIXTURE" | grep -E '^(INFRA )?VALIDATION:' | head -1)
assert_eq "extract VALIDATION line" "VALIDATION: PASS" "$VALIDATION_LINE"

# Missing field -> empty (callers default to fallback)
assert_eq "missing field empty" "" "$(extract NOPE "$MANIFEST_FIXTURE")"

# -----------------------------------------------------------------------------
# Test 5b: VALIDATION fail-closed -- missing line must NOT silently certify PASS
# -----------------------------------------------------------------------------
echo "--- Test 5b: VALIDATION fail-closed default ---"
# Helper mirrors the node's logic 1:1 (see bdc-feature-development.yaml
# patch-pr-body node). Per Rule 14 the manifest MUST emit a VALIDATION line;
# if missing, the node must NOT default to "VALIDATION: PASS" -- doing so
# would let an unvalidated build slip past Captain CI.
derive_validation_line() {
  local manifest="$1"
  local line
  line=$(printf '%s\n' "$manifest" | grep -E '^(INFRA )?VALIDATION:' | head -1)
  if [ -z "$line" ]; then
    line="VALIDATION: NOT_EMITTED -- build-manifest did not include a VALIDATION line; Captain CI must reject"
  fi
  printf '%s' "$line"
}

# 5b.1 -- explicit PASS is preserved
MF_PASS=$'WO: WO-X\nVALIDATION: PASS'
assert_eq "VALIDATION: PASS preserved" "VALIDATION: PASS" "$(derive_validation_line "$MF_PASS")"

# 5b.2 -- explicit INFRA VALIDATION: PASS is preserved
MF_INFRA=$'WO: WO-X\nINFRA VALIDATION: PASS'
assert_eq "INFRA VALIDATION: PASS preserved" "INFRA VALIDATION: PASS" \
  "$(derive_validation_line "$MF_INFRA")"

# 5b.3 -- missing line MUST fail closed (no silent PASS default)
MF_MISSING=$'WO: WO-X\nBuilder: Codex\nTests: 0 / 0'
MISSING_LINE=$(derive_validation_line "$MF_MISSING")
assert_contains "missing VALIDATION fails closed (NOT_EMITTED)" "NOT_EMITTED" "$MISSING_LINE"
assert_eq "missing VALIDATION never defaults to bare PASS" "0" \
  "$(printf '%s\n' "$MISSING_LINE" | grep -cxF "VALIDATION: PASS" || true)"

# 5b.4 -- explicit FAIL is preserved (not overridden)
MF_FAIL=$'WO: WO-X\nVALIDATION: FAIL -- tests red'
assert_contains "explicit FAIL preserved" "FAIL" "$(derive_validation_line "$MF_FAIL")"

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
