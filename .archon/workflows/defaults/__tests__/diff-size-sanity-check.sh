#!/usr/bin/env bash
# diff-size-sanity-check.sh -- unit tests for near-empty final diff gating.
#
# Run: bash .archon/workflows/defaults/__tests__/diff-size-sanity-check.sh

set -uo pipefail

FAIL=0
PASS=0

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle: $needle"
    echo "  output: $haystack"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fable.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
)

echo "--- Parity: all live lanes carry near-empty-diff gate ---"
for f in "${LANES[@]}"; do
  path="$DEFAULTS_DIR/$f"
  if grep -Fq "near_empty_without_justification" "$path" && grep -Fq "NO_OP_JUSTIFICATION" "$path"; then
    PASS=$((PASS + 1))
    echo "PASS: $f"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $f missing near-empty diff gate"
  fi
done

block_classify() {
  local DIFF_FINAL="$1" DIFF_META="$2" BUILD="$3"
  local final_ok=false final_verdict diff_final_bytes no_op_justification
  local has_no_op_justification=false near_empty_without_justification=false
  final_verdict=$(printf '%s\n' "$DIFF_FINAL" | grep -oE 'DIFF_REVIEW_FINAL=(satisfied|needs_revision)' | tail -n 1)
  if [ "$final_verdict" = "DIFF_REVIEW_FINAL=satisfied" ]; then final_ok=true; fi
  diff_final_bytes=$(printf '%s\n' "$DIFF_META" | sed -n 's/^DIFF_FINAL_BYTES=//p' | tail -n 1)
  case "${diff_final_bytes:-}" in
    ''|*[!0-9]*) diff_final_bytes=0 ;;
  esac
  no_op_justification=$(printf '%s\n' "$DIFF_FINAL" | sed -n 's/^NO_OP_JUSTIFICATION=//p' | tail -n 1)
  if [ -n "$no_op_justification" ] && ! printf '%s\n' "$no_op_justification" | grep -Eiq '^\(?none\)?$'; then
    has_no_op_justification=true
  fi
  if [ "$final_ok" = "true" ] && [ "$diff_final_bytes" -lt 200 ] && [ "$has_no_op_justification" != "true" ]; then
    near_empty_without_justification=true
    final_ok=false
  fi
  outcome=$(printf '%s\n' "$BUILD" | sed -n 's/^BUILD_OUTCOME=//p' | head -1)
  if [ "$outcome" = "ALREADY_SATISFIED" ]; then
    STATUS=ALREADY_SATISFIED
  elif [ "$outcome" = "REAL_BUILD" ] && [ "$final_ok" = "true" ]; then
    STATUS=PROCEED
  else
    STATUS=BLOCKED
  fi
  printf '{"status":"%s","final_satisfied":%s,"build_outcome":"%s","diff_final_bytes":%s,"near_empty_without_justification":%s}\n' "$STATUS" "$final_ok" "${outcome:-unknown}" "$diff_final_bytes" "$near_empty_without_justification"
}

echo "--- Behavior ---"
OUT=$(block_classify $'DIFF_REVIEW_FINAL=satisfied\nNO_OP_JUSTIFICATION=(none)' "DIFF_FINAL_BYTES=117" "BUILD_OUTCOME=REAL_BUILD")
assert_contains "near-empty satisfied without justification blocks" '"status":"BLOCKED"' "$OUT"
assert_contains "near-empty flag set" '"near_empty_without_justification":true' "$OUT"

OUT=$(block_classify $'DIFF_REVIEW_FINAL=satisfied\nNO_OP_JUSTIFICATION=Spec already implemented; grep evidence in diff review.' "DIFF_FINAL_BYTES=117" "BUILD_OUTCOME=REAL_BUILD")
assert_contains "near-empty justified satisfied can proceed" '"status":"PROCEED"' "$OUT"

OUT=$(block_classify $'DIFF_REVIEW_FINAL=satisfied\nNO_OP_JUSTIFICATION=(none)' "DIFF_FINAL_BYTES=500" "BUILD_OUTCOME=REAL_BUILD")
assert_contains "large satisfied diff unaffected" '"status":"PROCEED"' "$OUT"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
