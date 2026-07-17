#!/usr/bin/env bash
# manifest-validation-truthfulness.sh -- tests VALIDATION:PASS cannot contradict terminal status.
#
# Run: bash .archon/workflows/defaults/__tests__/manifest-validation-truthfulness.sh

set -uo pipefail

FAIL=0
PASS=0

assert_code() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" -eq "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label expected exit $expected got $actual"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
)

extract_truth_block() {
  awk '
    /# ---- BEGIN manifest-validation-truthfulness ----/ { c=1; next }
    /# ---- END manifest-validation-truthfulness ----/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

REF=""
for f in "${LANES[@]}"; do
  block="$(extract_truth_block "$DEFAULTS_DIR/$f")"
  if [ -z "$block" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: missing truthfulness block in $f"
  elif [ -z "$REF" ]; then
    REF="$block"
    PASS=$((PASS + 1))
    echo "PASS: reference $f"
  elif [ "$block" = "$REF" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $f matches"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $f differs"
  fi
done

run_truth_check() {
  local status="$1" manifest="$2" script code
  script=$(mktemp)
  {
    echo 'set -euo pipefail'
    echo "STATUS=$(printf '%q' "$status")"
    echo "MANIFEST_OUT=$(printf '%q' "$manifest")"
    printf '%s\n' "$REF"
  } > "$script"
  bash "$script" >/dev/null 2>&1
  code=$?
  rm -f "$script"
  return "$code"
}

run_truth_check "BLOCKED" $'WO: WO-X\nVALIDATION: PASS'
assert_code "BLOCKED + PASS fails" 1 "$?"

run_truth_check "PROCEED" $'WO: WO-X\nVALIDATION: PASS'
assert_code "PROCEED + PASS passes" 0 "$?"

run_truth_check "ALREADY_SATISFIED" $'WO: WO-X\nVALIDATION: PASS'
assert_code "ALREADY_SATISFIED + PASS passes" 0 "$?"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
