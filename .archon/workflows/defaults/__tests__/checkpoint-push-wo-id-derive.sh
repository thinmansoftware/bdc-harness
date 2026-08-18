#!/usr/bin/env bash
# checkpoint-push-wo-id-derive.sh -- fixture tests for checkpoint-push WO_ID re-derive
# WO-HARNESS-ZERO-OPEN-IMPLEMENT-MANIFEST-CHECKPOINT-TRUTH-01 (T3)
#
# Run: bash .archon/workflows/defaults/__tests__/checkpoint-push-wo-id-derive.sh

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
    echo "  expected: [$expected]"
    echo "  actual:   [$actual]"
  fi
}

assert_nonzero() {
  local label="$1" code="$2"
  if [ "$code" -ne 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label (exit=$code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (expected non-zero, got 0)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SISTER=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
  bdc-feature-development-fable.yaml
)

extract_block() {
  awk '
    /# ---- BEGIN checkpoint-wo-id-derive ----/ { c=1; next }
    /# ---- END checkpoint-wo-id-derive ----/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

echo "--- Parity: 7 checkpoint-wo-id-derive blocks byte-identical ---"
REF=""
REF_NAME=""
for f in "${SISTER[@]}"; do
  path="$DEFAULTS_DIR/$f"
  if [ ! -f "$path" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: missing $f"
    continue
  fi
  block="$(extract_block "$path")"
  if [ -z "$block" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: empty derive block in $f"
    continue
  fi
  if [ -z "$REF" ]; then
    REF="$block"
    REF_NAME="$f"
    PASS=$((PASS + 1))
    echo "PASS: captured reference from $f"
  else
    if [ "$block" = "$REF" ]; then
      PASS=$((PASS + 1))
      echo "PASS: $f matches $REF_NAME"
    else
      FAIL=$((FAIL + 1))
      echo "FAIL: $f differs from $REF_NAME"
    fi
  fi
done

if [ -z "$REF" ]; then
  echo "FATAL: no derive block extracted"
  exit 1
fi

# Replace live read-spec capture with fixture env READ_SPEC_FIXTURE
TESTABLE=$(printf '%s\n' "$REF" | awk '
  BEGIN { skip=0 }
  /_RS_OUT=\$\(python3/ {
    skip=1
    print "_RS_OUT=\"${READ_SPEC_FIXTURE:-}\""
    next
  }
  skip && /BDC_NODE_OUTPUT_READ_SPEC/ { next }
  skip && /\$read-spec\.output/ { next }
  skip && /^\)/ { skip=0; next }
  { print }
')

run_case() {
  local wo="$1" um="$2" rs="$3"
  local script out code
  script=$(mktemp)
  {
    echo 'set -uo pipefail'
    if [ -n "$wo" ]; then
      echo "WO_ID=$(printf '%q' "$wo")"
    else
      echo 'WO_ID=""'
      echo 'unset WO_ID 2>/dev/null || true'
      echo 'WO_ID=""'
    fi
    echo "export USER_MESSAGE=$(printf '%q' "$um")"
    echo "export READ_SPEC_FIXTURE=$(printf '%q' "$rs")"
    printf '%s\n' "$TESTABLE"
    echo 'printf "RESOLVED=%s\n" "$WO_ID"'
  } > "$script"
  set +e
  out=$(bash "$script" 2>&1)
  code=$?
  set -e
  rm -f "$script"
  printf '%s\n' "$out"
  return "$code"
}

echo "--- Test: env WO_ID set ---"
set +e
OUT=$(run_case "WO-FROM-ENV-01" "" "")
CODE=$?
set -e
assert_eq "env exit 0" "0" "$CODE"
assert_eq "env resolved" "RESOLVED=WO-FROM-ENV-01" "$(printf '%s\n' "$OUT" | grep '^RESOLVED=' | head -1)"

echo "--- Test: USER_MESSAGE only ---"
set +e
OUT=$(run_case "" "Please build WO-FROM-MSG-02 and ship it" "")
CODE=$?
set -e
assert_eq "msg exit 0" "0" "$CODE"
assert_eq "msg resolved" "RESOLVED=WO-FROM-MSG-02" "$(printf '%s\n' "$OUT" | grep '^RESOLVED=' | head -1)"

echo "--- Test: read-spec fixture only ---"
set +e
OUT=$(run_case "" "" $'WO_ID=WO-FROM-RS-03\nOTHER=x')
CODE=$?
set -e
assert_eq "rs exit 0" "0" "$CODE"
assert_eq "rs resolved" "RESOLVED=WO-FROM-RS-03" "$(printf '%s\n' "$OUT" | grep '^RESOLVED=' | head -1)"

echo "--- Test: all empty fails closed ---"
set +e
OUT=$(run_case "" "" "")
CODE=$?
set -e
assert_nonzero "all empty non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'cannot resolve WO_ID'; then
  PASS=$((PASS + 1))
  echo "PASS: error message present"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: missing cannot resolve WO_ID message"
  echo "  out=$OUT"
fi

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
