#!/usr/bin/env bash
# classify-diff-review.sh -- unit tests for the classify-diff-review bash node
# added by WO-HARNESS-DIFF-REPAIR-SKIP-WHEN-SATISFIED-01 to
# .archon/workflows/defaults/bdc-feature-development.yaml.
#
# Background: diff-repair loop ran max_iterations: 10 on EVERY build, including
# clean ones where diff-review returned DIFF_REVIEW=satisfied with no findings.
# classify-diff-review greps the verdict into one JSON line; diff-repair then
# carries a when: guard so it skips entirely on satisfied. Fail-OPEN classifier:
# an unparseable review verdict defaults to needs_revision (never silently skip
# a real finding).
#
# Coverage:
#   T1 DIFF_REVIEW=satisfied (no findings)   -> {"verdict":"satisfied"}
#      (documented: this verdict makes diff-repair skip via its when:)
#   T2 DIFF_REVIEW=needs_revision (findings)  -> {"verdict":"needs_revision"}
#   T3 no DIFF_REVIEW= sentinel              -> {"verdict":"needs_revision"}
#      (fail-OPEN: unknown must never skip repair)
#
# Run: bash .archon/workflows/defaults/__tests__/classify-diff-review.sh
# Exits 0 on all-pass, 1 on any failure.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
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

# ---------------------------------------------------------------------------
# Helper: classify-diff-review decision logic (mirrors YAML node 1:1).
# Input: diff-review multi-line prose. Output: one JSON line.
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# T1 (the bug): DIFF_REVIEW=satisfied with no findings -> satisfied
# This verdict causes diff-repair to skip via its when: guard.
# ---------------------------------------------------------------------------
echo "--- T1: DIFF_REVIEW=satisfied -> satisfied (diff-repair skips) ---"
INPUT_T1=$'DIFF_REVIEW=satisfied\nFINDINGS:\n- (none)\nSEMANTIC_RISK=LOW'
T1_OUT=$(classify_diff_review "$INPUT_T1")
assert_eq "T1 satisfied verdict" '{"verdict":"satisfied"}' "$T1_OUT"

# ---------------------------------------------------------------------------
# T2: DIFF_REVIEW=needs_revision with real findings -> needs_revision
# diff-repair loop runs normally.
# ---------------------------------------------------------------------------
echo "--- T2: DIFF_REVIEW=needs_revision -> needs_revision (diff-repair runs) ---"
INPUT_T2=$'DIFF_REVIEW=needs_revision\nFINDINGS:\n- src/foo.ts:12 missing test\nSEMANTIC_RISK=MEDIUM'
T2_OUT=$(classify_diff_review "$INPUT_T2")
assert_eq "T2 needs_revision verdict" '{"verdict":"needs_revision"}' "$T2_OUT"

# ---------------------------------------------------------------------------
# T3 (fail-OPEN): no DIFF_REVIEW= sentinel -> needs_revision
# Never skip repair on an unparseable review.
# ---------------------------------------------------------------------------
echo "--- T3: no sentinel -> needs_revision (fail-OPEN) ---"
INPUT_T3=$'reviewer prose with no verdict\nFINDINGS:\n- something suspicious'
T3_OUT=$(classify_diff_review "$INPUT_T3")
assert_eq "T3 no-sentinel -> needs_revision" '{"verdict":"needs_revision"}' "$T3_OUT"

T3B_OUT=$(classify_diff_review "")
assert_eq "T3b empty input -> needs_revision" '{"verdict":"needs_revision"}' "$T3B_OUT"

T3C_OUT=$(classify_diff_review "DIFF_REVIEW=maybe")
assert_eq "T3c garbage verdict -> needs_revision" '{"verdict":"needs_revision"}' "$T3C_OUT"

# Positive sanity: last-occurrence wins.
T3D_OUT=$(classify_diff_review $'context: DIFF_REVIEW=needs_revision earlier\nDIFF_REVIEW=satisfied')
assert_eq "T3d last sentinel wins" '{"verdict":"satisfied"}' "$T3D_OUT"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==== classify-diff-review.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
