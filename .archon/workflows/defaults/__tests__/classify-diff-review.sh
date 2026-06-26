#!/usr/bin/env bash
# classify-diff-review.sh -- unit tests for the classify-diff-review bash node
# added by WO-HARNESS-DIFF-REPAIR-SKIP-WHEN-SATISFIED-01 to
# .archon/workflows/defaults/bdc-feature-development.yaml.
#
# Background: diff-repair was running its full max_iterations: 10 loop even when
# diff-review had already returned DIFF_REVIEW=satisfied with no findings,
# because the loop's until_bash only completes when the agent writes a done.flag
# (which on a clean diff it frequently fails to do). The result: ~83-85 tool
# calls + scary red "exceeded max iterations" failure on every clean build.
#
# Fix: classify-diff-review greps the DIFF_REVIEW sentinel out of diff-review's
# multi-line prose and emits one JSON line. diff-repair gains a when: guard
# ($classify-diff-review.output.verdict == 'needs_revision') so it SKIPS
# entirely when the review was satisfied. capture-diff-final and
# diff-review-final already carry trigger_rule: all_done and tolerate the skip.
#
# These tests exercise the bash decision logic of classify-diff-review with
# stubbed string inputs (no live git or codex calls). When the verdict is
# "satisfied", diff-repair skips via its when: condition (covered conceptually
# by T1's documentation; the YAML-level skip is verified by the workflow
# validator stop condition).
#
# Coverage:
#   T1 DIFF_REVIEW=satisfied with no findings  -> verdict=satisfied
#                                                 (and diff-repair skips)
#   T2 DIFF_REVIEW=needs_revision with real findings -> verdict=needs_revision
#                                                       (diff-repair runs)
#   T3 No DIFF_REVIEW= sentinel (fail-OPEN)    -> verdict=needs_revision
#                                                 (NEVER skip on unparseable)
#
# Run: bash .archon/workflows/defaults/__tests__/classify-diff-review.sh
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

# -----------------------------------------------------------------------------
# Helper: classify-diff-review decision logic (mirrors the YAML node 1:1).
# Input: diff-review multi-line prose. Output: one JSON line.
# Fail-OPEN: unknown/unparseable -> needs_revision (NEVER skip a real finding).
# -----------------------------------------------------------------------------
classify_diff_review() {
  local REVIEW="$1"
  local verdict
  verdict=$(printf '%s\n' "$REVIEW" \
    | grep -oE 'DIFF_REVIEW=(satisfied|needs_revision)' \
    | tail -n 1 \
    | sed 's/DIFF_REVIEW=//')
  [ -z "$verdict" ] && verdict=needs_revision
  printf '{"verdict":"%s"}\n' "$verdict"
}

# -----------------------------------------------------------------------------
# T1: DIFF_REVIEW=satisfied with no findings -> verdict=satisfied
# This is the bug fix. With verdict=satisfied, the diff-repair node's when:
# guard ($classify-diff-review.output.verdict == 'needs_revision') evaluates
# false, so the 10-iteration repair loop is SKIPPED entirely.
# -----------------------------------------------------------------------------
echo "--- T1: satisfied + no findings -> verdict=satisfied (diff-repair skips) ---"
REVIEW_SATISFIED=$'DIFF_REVIEW=satisfied\nFINDINGS:\n- (none)\nSEMANTIC_RISK=LOW'
T1_OUT=$(classify_diff_review "$REVIEW_SATISFIED")
assert_eq "T1 satisfied sentinel -> verdict=satisfied" \
  '{"verdict":"satisfied"}' "$T1_OUT"

# -----------------------------------------------------------------------------
# T2: DIFF_REVIEW=needs_revision with real findings -> verdict=needs_revision
# diff-repair runs normally (behavior unchanged from before this WO).
# -----------------------------------------------------------------------------
echo "--- T2: needs_revision + findings -> verdict=needs_revision (diff-repair runs) ---"
REVIEW_NEEDS_REVISION=$'DIFF_REVIEW=needs_revision\nFINDINGS:\n- packages/foo/bar.ts:42 missing test for column contract\n- packages/foo/baz.ts:17 unverified shape claim\nSEMANTIC_RISK=MEDIUM'
T2_OUT=$(classify_diff_review "$REVIEW_NEEDS_REVISION")
assert_eq "T2 needs_revision sentinel -> verdict=needs_revision" \
  '{"verdict":"needs_revision"}' "$T2_OUT"

# -----------------------------------------------------------------------------
# T3 (fail-OPEN): no DIFF_REVIEW= sentinel in the review prose ->
# verdict=needs_revision. This is the OPPOSITE of the fail-closed classifiers:
# an unparseable review MUST still trigger repair, never skip it. Anything else
# would risk silently passing a build whose review was malformed/truncated.
# -----------------------------------------------------------------------------
echo "--- T3: no sentinel (fail-OPEN) -> verdict=needs_revision ---"

T3_EMPTY=$(classify_diff_review "")
assert_eq "T3a empty input -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T3_EMPTY"

T3_NO_SENTINEL=$(classify_diff_review $'reviewer prose with no sentinel\nFINDINGS:\n- some-finding')
assert_eq "T3b no-sentinel input -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T3_NO_SENTINEL"

T3_GARBAGE=$(classify_diff_review "DIFF_REVIEW=maybe")
assert_eq "T3c garbage verdict value -> needs_revision" \
  '{"verdict":"needs_revision"}' "$T3_GARBAGE"

# Last-occurrence wins (if a stray earlier sentinel appears in quoted context).
T3_DOUBLE=$(classify_diff_review $'context: DIFF_REVIEW=needs_revision earlier\nfinal verdict\nDIFF_REVIEW=satisfied')
assert_eq "T3d last sentinel wins" \
  '{"verdict":"satisfied"}' "$T3_DOUBLE"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "==== classify-diff-review.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
