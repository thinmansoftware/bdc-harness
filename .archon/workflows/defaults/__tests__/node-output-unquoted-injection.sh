#!/usr/bin/env bash
# node-output-unquoted-injection.sh -- regression for quoted node-output heredocs.
# WO-HARNESS-NODE-OUTPUT-UNQUOTED-INJECTION-FIX-01
#
# Run: bash .archon/workflows/defaults/__tests__/node-output-unquoted-injection.sh

set -uo pipefail

FAIL=0
PASS=0

assert_zero() {
  local label="$1" code="$2" out="${3:-}"
  if [ "$code" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (exit=$code)"
    if [ -n "$out" ]; then printf '%s\n' "$out"; fi
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  output:  $haystack"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
YAML="$DEFAULTS_DIR/bdc-feature-development-codex.yaml"

PAYLOAD=$(cat <<'PAYLOAD_EOF'
- leading flag-like line
bareword would_have_been_a_command
unmatched single quote: '
/opt/bdc/ci/n8n-health.js
PAYLOAD_EOF
)

extract_assignment_block() {
  local var="$1" node="$2"
  awk -v var="$var" -v node="$node" '
    BEGIN {
      start = "^      " var "=\\$\\(cat <<\047BDC_FEATURE_DEV_"
      placeholder = "^      \\$" node "\\.output$"
    }
    $0 ~ start { in_block = 1 }
    in_block {
      sub(/^      /, "")
      print
      if ($0 == ")") exit
    }
  ' "$YAML"
}

render_script() {
  local var="$1" node="$2" block script
  block="$(extract_assignment_block "$var" "$node")"
  if [ -z "$block" ]; then
    echo "FATAL: could not extract $var assignment for $node" >&2
    return 1
  fi
  if ! printf '%s\n' "$block" | grep -Fxq -- "\$$node.output"; then
    echo "FATAL: assignment block for $var/$node does not contain expected placeholder" >&2
    return 1
  fi
  script=$(mktemp)
  {
    echo 'set -euo pipefail'
    printf '%s\n' "$block" | awk -v node="$node" -v payload="$PAYLOAD" '
      $0 == "$" node ".output" { print payload; next }
      { print }
    '
    printf 'printf "%%s\\n" "$%s"\\n' "$var"
  } > "$script"
  printf '%s\n' "$script"
}

run_case() {
  local label="$1" var="$2" node="$3" script out code
  script="$(render_script "$var" "$node")" || {
    FAIL=$((FAIL + 1))
    echo "FAIL: $label render"
    return
  }

  set +e
  out=$(bash -n "$script" 2>&1)
  code=$?
  set -e
  assert_zero "$label bash -n" "$code" "$out"

  set +e
  out=$(bash "$script" 2>&1)
  code=$?
  set -e
  assert_zero "$label executes" "$code" "$out"
  assert_contains "$label preserves leading hyphen" "$out" "- leading flag-like line"
  assert_contains "$label preserves unmatched quote" "$out" "unmatched single quote: '"
  assert_contains "$label preserves path" "$out" "/opt/bdc/ci/n8n-health.js"
  rm -f "$script"
}

run_case "IMPL implement output" "IMPL" "implement"
run_case "RECLASS block-reclassify output" "RECLASS" "block-reclassify"

echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
