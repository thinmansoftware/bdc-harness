#!/usr/bin/env bash
# block-reclassify-rereview.sh -- unit tests for the autonomous opus re-review
# chain added by WO-HARNESS-OPUS-REPAIR-AUTONOMOUS-REREVIEW-01 to
# .archon/workflows/defaults/bdc-feature-development.yaml.
#
# Background (Defect A, 2026-06-25 post-mortem): opus-repair would fix a BLOCKED
# build but block-reclassify emitted a TERMINAL
# {"status":"BLOCKED","note":"opus-made-changes-need-re-review"} that nothing
# downstream re-reviewed. On non-interactive runs the repaired work stranded.
#
# Fix: classify-opus-repair -> opus-rereview -> classify-opus-rereview chain;
# block-reclassify now reads $classify-opus-rereview.output.verdict and emits
# PROCEED on satisfied, BLOCKED (rereview-failed) on anything else.
#
# These tests exercise the bash decision logic of classify-opus-rereview and
# block-reclassify with stubbed string inputs (no live git calls).
#
# Coverage:
#   T1 OPUS_REPAIR=fixed + changes + rereview satisfied      -> PROCEED
#   T2 OPUS_REPAIR=fixed + changes + rereview needs_revision -> BLOCKED rereview-failed
#   T3 OPUS_REPAIR=already-satisfied                         -> ALREADY_SATISFIED (unchanged)
#   T4 OPUS_REPAIR=needs-human                               -> BLOCKED opus-could-not-resolve
#   T5 prior block-classify status PROCEED                   -> PROCEED (early-return)
#   T6 classify-opus-rereview with no sentinel               -> needs_revision (fail-closed)
#
# Run: bash .archon/workflows/defaults/__tests__/block-reclassify-rereview.sh
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

# -----------------------------------------------------------------------------
# Helper 1: classify-opus-rereview decision logic (mirrors the YAML node 1:1).
# Input: opus-rereview multi-line prose. Output: one JSON line.
# -----------------------------------------------------------------------------
classify_opus_rereview() {
  local REVIEW="$1"
  local verdict
  verdict=$(printf '%s\n' "$REVIEW" \
    | grep -oE 'OPUS_REREVIEW=(satisfied|needs_revision)' \
    | tail -n 1 \
    | sed 's/OPUS_REREVIEW=//')
  if [ -z "$verdict" ]; then
    verdict=needs_revision
  fi
  printf '{"verdict":"%s"}\n' "$verdict"
}

# -----------------------------------------------------------------------------
# Helper 2: block-reclassify decision logic (mirrors the YAML node 1:1).
# Inputs are passed as stubs so the bash logic can be exercised without git:
#   $1 PRIOR        block-classify.output JSON
#   $2 OPUS         opus-repair.output (multi-line prose w/ OPUS_REPAIR= sentinel)
#   $3 REREVIEW     classify-opus-rereview.output JSON
#   $4 CHANGED_STUB simulated "git status --porcelain | grep -c ."
#   $5 AHEAD_STUB   simulated "git rev-list --count @{upstream}..HEAD"
# Output: one JSON line.
# -----------------------------------------------------------------------------
block_reclassify() {
  local PRIOR="$1" OPUS="$2" REREVIEW="$3" CHANGED="$4" AHEAD="$5"
  local prior_status
  prior_status=$(printf '%s\n' "$PRIOR" | sed -n 's/.*"status":"\([A-Z_]*\)".*/\1/p' | head -1)

  if [ "$prior_status" != "BLOCKED" ]; then
    printf '{"status":"%s"}\n' "${prior_status:-BLOCKED}"
    return 0
  fi

  if printf '%s\n' "$OPUS" | grep -q '^OPUS_REPAIR=fixed' && { [ "${CHANGED:-0}" -gt 0 ] || [ "${AHEAD:-0}" -gt 0 ]; }; then
    local rereview_verdict
    rereview_verdict=$(printf '%s\n' "$REREVIEW" | sed -n 's/.*"verdict":"\([a-z_]*\)".*/\1/p' | head -1)
    if [ "$rereview_verdict" = "satisfied" ]; then
      printf '{"status":"PROCEED","note":"opus-repaired-and-rereviewed-satisfied"}\n'
    else
      printf '{"status":"BLOCKED","note":"opus-made-changes-rereview-failed"}\n'
    fi
  elif printf '%s\n' "$OPUS" | grep -q '^OPUS_REPAIR=already-satisfied'; then
    printf '{"status":"ALREADY_SATISFIED","note":"opus-confirmed-already-satisfied"}\n'
  else
    printf '{"status":"BLOCKED","note":"opus-could-not-resolve"}\n'
  fi
}

# Common stubs reused across tests.
PRIOR_BLOCKED='{"status":"BLOCKED","final_satisfied":false,"build_outcome":"REAL_BUILD"}'
PRIOR_PROCEED='{"status":"PROCEED","final_satisfied":true,"build_outcome":"REAL_BUILD"}'

# -----------------------------------------------------------------------------
# T1: OPUS_REPAIR=fixed + worktree-has-changes + rereview satisfied -> PROCEED
# -----------------------------------------------------------------------------
echo "--- T1: fixed + changes + rereview satisfied -> PROCEED ---"
OPUS_FIXED=$'OPUS_REPAIR=fixed\nREASON=fixed missing column'
REREVIEW_OK='{"verdict":"satisfied"}'
T1_OUT=$(block_reclassify "$PRIOR_BLOCKED" "$OPUS_FIXED" "$REREVIEW_OK" "3" "1")
assert_contains "T1 status=PROCEED" '"status":"PROCEED"' "$T1_OUT"
assert_contains "T1 note=opus-repaired-and-rereviewed-satisfied" \
  "opus-repaired-and-rereviewed-satisfied" "$T1_OUT"

# -----------------------------------------------------------------------------
# T2: OPUS_REPAIR=fixed + changes + rereview needs_revision -> BLOCKED rereview-failed
# -----------------------------------------------------------------------------
echo "--- T2: fixed + changes + rereview needs_revision -> BLOCKED ---"
REREVIEW_BAD='{"verdict":"needs_revision"}'
T2_OUT=$(block_reclassify "$PRIOR_BLOCKED" "$OPUS_FIXED" "$REREVIEW_BAD" "2" "1")
assert_contains "T2 status=BLOCKED" '"status":"BLOCKED"' "$T2_OUT"
assert_contains "T2 note=opus-made-changes-rereview-failed" \
  "opus-made-changes-rereview-failed" "$T2_OUT"

# -----------------------------------------------------------------------------
# T3: OPUS_REPAIR=already-satisfied -> ALREADY_SATISFIED (unchanged behavior)
# -----------------------------------------------------------------------------
echo "--- T3: already-satisfied -> ALREADY_SATISFIED ---"
OPUS_ALREADY=$'OPUS_REPAIR=already-satisfied'
# rereview is irrelevant on this path (gated off by classify-opus-repair; stub
# whatever value: the branch never reads it).
REREVIEW_IRRELEVANT='{"verdict":"needs_revision"}'
T3_OUT=$(block_reclassify "$PRIOR_BLOCKED" "$OPUS_ALREADY" "$REREVIEW_IRRELEVANT" "0" "0")
assert_contains "T3 status=ALREADY_SATISFIED" '"status":"ALREADY_SATISFIED"' "$T3_OUT"
assert_contains "T3 note=opus-confirmed-already-satisfied" \
  "opus-confirmed-already-satisfied" "$T3_OUT"

# -----------------------------------------------------------------------------
# T4: OPUS_REPAIR=needs-human -> BLOCKED opus-could-not-resolve (unchanged)
# -----------------------------------------------------------------------------
echo "--- T4: needs-human -> BLOCKED opus-could-not-resolve ---"
OPUS_NEEDS_HUMAN=$'OPUS_REPAIR=needs-human\nREASON=cannot determine intent'
T4_OUT=$(block_reclassify "$PRIOR_BLOCKED" "$OPUS_NEEDS_HUMAN" "$REREVIEW_IRRELEVANT" "0" "0")
assert_contains "T4 status=BLOCKED" '"status":"BLOCKED"' "$T4_OUT"
assert_contains "T4 note=opus-could-not-resolve" \
  "opus-could-not-resolve" "$T4_OUT"

# -----------------------------------------------------------------------------
# T5: prior block-classify status PROCEED -> emit PROCEED unchanged (early return)
# -----------------------------------------------------------------------------
echo "--- T5: prior PROCEED -> PROCEED (early return; rereview path no-op) ---"
# Fast path: opus-repair was skipped, so OPUS is empty; classify-opus-rereview
# would have fail-closed to needs_revision -- but block-reclassify's early return
# means none of that matters.
T5_OUT=$(block_reclassify "$PRIOR_PROCEED" "" "$REREVIEW_BAD" "0" "0")
assert_contains "T5 status=PROCEED" '"status":"PROCEED"' "$T5_OUT"
assert_eq "T5 no rereview note leaks in" "0" \
  "$(printf '%s\n' "$T5_OUT" | grep -c 'opus-repaired-and-rereviewed' || true)"

# -----------------------------------------------------------------------------
# T6: classify-opus-rereview with no OPUS_REREVIEW= sentinel -> needs_revision
#     (fail-closed default; an unparseable re-review must NEVER silently pass).
# -----------------------------------------------------------------------------
echo "--- T6: classify-opus-rereview fail-closed default ---"
T6_EMPTY=$(classify_opus_rereview "")
assert_eq "T6 empty input -> needs_revision" '{"verdict":"needs_revision"}' "$T6_EMPTY"

T6_NO_SENTINEL=$(classify_opus_rereview $'reviewer prose with no sentinel\nUNRESOLVED:\n- something')
assert_eq "T6 no-sentinel input -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T6_NO_SENTINEL"

T6_GARBAGE=$(classify_opus_rereview "OPUS_REREVIEW=maybe")
assert_eq "T6 garbage verdict -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T6_GARBAGE"

# Positive sanity checks: real sentinels are parsed correctly.
T6_OK=$(classify_opus_rereview $'prose\nOPUS_REREVIEW=satisfied\nUNRESOLVED:\n- (none)')
assert_eq "T6 satisfied sentinel -> satisfied" \
  '{"verdict":"satisfied"}' "$T6_OK"

T6_BAD=$(classify_opus_rereview $'prose\nOPUS_REREVIEW=needs_revision\nUNRESOLVED:\n- still broken')
assert_eq "T6 needs_revision sentinel -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T6_BAD"

# Last-occurrence wins (if a stray earlier sentinel appears in context).
T6_DOUBLE=$(classify_opus_rereview $'context: OPUS_REREVIEW=needs_revision earlier\nfinal verdict\nOPUS_REREVIEW=satisfied')
assert_eq "T6 last sentinel wins" \
  '{"verdict":"satisfied"}' "$T6_DOUBLE"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "==== block-reclassify-rereview.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
