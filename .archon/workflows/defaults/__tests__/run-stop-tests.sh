#!/usr/bin/env bash
# run-stop-tests.sh -- unit tests for the run-stop-tests node core (rst_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 10 bdc-feature-development lanes.
#
# bdc-xo #1940 (harness defect 2026-09-05): the manifest "Tests:" line was stamped
# "N/A (required gates are reported separately)" on CODE WOs and the validator's test
# claim was never tied to an executed command. run-stop-tests executes the spec's
# declared test command in the run worktree and emits OBSERVED pass/total.
#
# Rather than re-typing that logic (which would drift), these tests EXTRACT the real
# core functions from the canonical YAML (awk range-match on the BEGIN/END markers)
# and exercise them against fixtures. A parity test asserts the core is byte-identical
# across all 11 lanes (this repo has no shared-include mechanism for workflow YAMLs).
#
# Run: bash .archon/workflows/defaults/__tests__/run-stop-tests.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected: [$expected]"; echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle:   $needle"; echo "  haystack: $haystack"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
LANES="
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-grok.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
bdc-feature-development.yaml
"

extract_core() {
  # extract_core <yaml> <marker>  -> the bash between "# ---- BEGIN <marker> core" and
  # "# ---- END <marker> core", de-indented by the 6-space block-scalar indent.
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

RST_CORE="$(extract_core "$CANONICAL_YAML" rst)"
if [ -z "$RST_CORE" ]; then
  echo "FATAL: could not extract rst core from $CANONICAL_YAML"; exit 1
fi
eval "$RST_CORE"
for fn in rst_class rst_extract_command rst_command_looks_runnable rst_parse_counts rst_report; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: rst core byte-identical across all 11 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$RST_CORE" "$(extract_core "$DEFAULTS/$lane" rst)"
done

echo "--- rst_class ---"
SPEC_M157='# WO-SHOPOPS-M157-CGC-DEALER-API-01

WO Class: CODE
target_repo: thinmansoftware/shopops

## 8. Stop conditions (CI-executable)

Stop 1a (grep assertion, new provider):
  grep -c "cgc-dealer-api" shopops-api/services/cert-lookup.js
  Expected: 1

Stop 2 (test suite):
  cd shopops-api && node tests/test_cgc_dealer_api.js && node tests/run_all.js --suite=m157
  Expected: all passing / 0 failing

Stop 2b (full suite):
  cd shopops-api && node tests/run_all.js

Stop 3 (ASCII scan):
  LC_ALL=C grep -n "[^ -~]" shopops-api/services/cert-lookup.js
  Expected: no output

## 9. Manifest requirements (CODE class)

Tests: <n>/<n> (cd shopops-api && node tests/test_cgc_dealer_api.js) and <n>/<n> (node tests/run_all.js)
'
assert_eq "CODE from 'WO Class: CODE'" "CODE" "$(printf '%s\n' "$SPEC_M157" | rst_class)"
assert_eq "MIXED from 'WO Class: MIXED'" "MIXED" "$(printf 'x\nWO Class: MIXED\n' | rst_class)"
assert_eq "DOCUMENTATION from fenced 'Class: DOCUMENTATION'" "DOCUMENTATION" "$(printf '```\nClass: DOCUMENTATION\n```\n' | rst_class)"
assert_eq "DOCS alias" "DOCUMENTATION" "$(printf 'WO Class: DOCS\n' | rst_class)"
assert_eq "default CODE when no class line" "CODE" "$(printf '# WO-X\n\nRung classification: feature\n' | rst_class)"
assert_eq "'Rung classification:' is not a class line" "CODE" "$(printf 'Rung classification: INFRA\n' | rst_class)"

echo "--- rst_extract_command ---"
assert_eq "Stop 2 (test suite) command wins" \
  "cd shopops-api && node tests/test_cgc_dealer_api.js && node tests/run_all.js --suite=m157" \
  "$(printf '%s\n' "$SPEC_M157" | rst_extract_command)"
assert_eq "grep stop with 'tests' in its label is not a test block" \
  "bun test packages/x" \
  "$(printf 'Stop 1 (grep assertion, no secret in tests/fixtures):\n  grep -c x y\n  Expected: 0\n\nStop 2 (tests):\n  bun test packages/x\n  Expected: 3 passing\n' | rst_extract_command)"
assert_eq "backslash continuation joins" \
  "cd apps/x && npm.cmd test -- --run a.test.ts b.test.ts" \
  "$(printf 'Stop 6 (unit tests):\n  cd apps/x && npm.cmd test -- --run \\\n    a.test.ts b.test.ts\n  Expected: 2 passing\n' | rst_extract_command)"
assert_eq "fenced + backticked command line cleaned" \
  "bun test scripts/boardctl/" \
  "$(printf 'Stop 2 (test suite):\n```bash\n  `bun test scripts/boardctl/`\n```\n  Expected: green\n' | rst_extract_command)"
assert_eq "bold header tolerated" \
  "pytest -q" \
  "$(printf '**Stop 2 (test suite):**\n  pytest -q\n  Expected: all pass\n' | rst_extract_command)"
assert_eq "fallback: Section 9 Tests: line" \
  "bun test packages/foo" \
  "$(printf '## 9. Manifest\nTests: 5/5 (bun test packages/foo)\nPRs: x\n' | rst_extract_command)"
assert_eq "template placeholder rejected" "" \
  "$(printf 'Stop 2 (test suite):\n  {{TEST_COMMAND}}\n  Expected: {{N}}\n' | rst_extract_command)"
assert_eq "no test block, no Tests line -> empty" "" "$(printf 'Stop 1 (grep assertion):\n  grep -c a b\n  Expected: 1\n' | rst_extract_command)"
assert_eq "next Stop header without Expected terminates the block" \
  "node tests/run_all.js" \
  "$(printf 'Stop 2 (test suite):\n  node tests/run_all.js\nStop 3 (ASCII scan):\n  LC_ALL=C grep -n x y\n' | rst_extract_command)"

echo "--- rst_command_looks_runnable ---"
for c in "cd shopops-api && node tests/x.js" "bun test packages/x" "npm.cmd test -- --run" "npx vitest run" "pytest -q" "bash scripts/t.sh" "LC_ALL=C node t.js"; do
  if rst_command_looks_runnable "$c"; then PASS=$((PASS+1)); echo "PASS: runnable: $c"; else FAIL=$((FAIL+1)); echo "FAIL: runnable expected: $c"; fi
done
for c in "all passing / 0 failing" "see Section 7" "green"; do
  if rst_command_looks_runnable "$c"; then FAIL=$((FAIL+1)); echo "FAIL: not runnable expected: $c"; else PASS=$((PASS+1)); echo "PASS: not runnable: $c"; fi
done

echo "--- rst_parse_counts ---"
assert_eq "shopops run_all summary" "8 11" "$(printf '=== Summary ===\nPassed: 8  Failed: 3  Total: 11\nFailed suites: a, b\n' | rst_parse_counts)"
assert_eq "shopops per-file Tests: P/T" "8 8" "$(printf 'PASS: a\nPASS: b\nTests: 8/8\n' | rst_parse_counts)"
assert_eq "chained per-file + run_all summaries sum" "16 19" "$(printf 'Tests: 8/8\n=== Summary ===\nPassed: 8  Failed: 3  Total: 11\n' | rst_parse_counts)"
assert_eq "jest" "190 195" "$(printf 'Test Suites: 1 failed, 25 passed, 26 total\nTests:       5 failed, 190 passed, 195 total\n' | rst_parse_counts)"
assert_eq "jest all green" "35 35" "$(printf 'Tests:       35 passed, 35 total\n' | rst_parse_counts)"
ESC="$(printf '\033')"
assert_eq "vitest with ANSI colour" "190 195" "$(printf ' %s[2mTest Files %s[22m 1 failed | 25 passed (26)\n %s[2m      Tests %s[22m %s[31m5 failed%s[39m | %s[32m190 passed%s[39m %s[90m(195)%s[39m\n' "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" "$ESC" | rst_parse_counts)"
assert_eq "vitest all green with skipped" "35 37" "$(printf '      Tests  35 passed | 2 skipped (37)\n' | rst_parse_counts)"
assert_eq "bun test" "4 5" "$(printf ' 4 pass\n 1 fail\n 9 expect() calls\nRan 5 tests across 1 file.\n' | rst_parse_counts)"
assert_eq "node:test (non-ASCII info glyph)" "4 4" "$(printf '\342\204\271 tests 4\n\342\204\271 pass 4\n\342\204\271 fail 0\n' | rst_parse_counts)"
assert_eq "TAP" "3 4" "$(printf 'ok 1 - a\nnot ok 2 - b\n# tests 4\n# pass 3\n# fail 1\n' | rst_parse_counts)"
assert_eq "mocha" "12 13" "$(printf '  12 passing (1s)\n  1 failing\n' | rst_parse_counts)"
assert_eq "pytest" "10 12" "$(printf '=================== 2 failed, 10 passed in 0.42s ===================\n' | rst_parse_counts)"
assert_eq "fallback PASS:/FAIL: lines" "6 8" "$(printf 'PASS: one\nPASS: two\nFAIL: three: boom\nPASS: four\nPASS: five\nFAIL: six\nPASS: seven\nPASS: eight\n' | rst_parse_counts)"
assert_eq "no recognisable output -> empty" "" "$(printf 'building...\ndone\n' | rst_parse_counts)"

echo "--- rst_report ---"
assert_eq "passed" "$(printf 'TESTS_STATUS=passed\nTESTS_LINE=27/27 (bun test x)')" "$(rst_report CODE 'bun test x' 0 '27 27')"
assert_eq "nonzero exit is failed even when counts agree" "$(printf 'TESTS_STATUS=failed\nTESTS_LINE=8/8 (node t.js) -- FAILED, exit 1')" "$(rst_report CODE 'node t.js' 1 '8 8')"
assert_eq "passed < total is failed" "$(printf 'TESTS_STATUS=failed\nTESTS_LINE=6/8 (node t.js) -- FAILED, exit 0')" "$(rst_report CODE 'node t.js' 0 '6 8')"
assert_eq "zero tests ran is failed" "$(printf 'TESTS_STATUS=failed\nTESTS_LINE=0/0 (node t.js) -- FAILED, exit 0')" "$(rst_report CODE 'node t.js' 0 '0 0')"
assert_eq "timeout exit 124 is failed" "$(printf 'TESTS_STATUS=failed\nTESTS_LINE=3/3 (node t.js) -- FAILED, exit 124')" "$(rst_report CODE 'node t.js' 124 '3 3')"
assert_contains "counts_unparsed" "TESTS_STATUS=counts_unparsed" "$(rst_report CODE 'node t.js' 0 '')"
assert_contains "counts_unparsed line is N/A with the command" "TESTS_LINE=N/A (test command exited 0 but pass/total could not be parsed from its output: node t.js)" "$(rst_report CODE 'node t.js' 0 '')"
assert_contains "CODE with no command is no_command_declared" "TESTS_STATUS=no_command_declared" "$(rst_report CODE '' 0 '')"
assert_contains "MIXED with no command is no_command_declared" "TESTS_STATUS=no_command_declared" "$(rst_report MIXED '' 0 '')"
assert_contains "INFRA with no command is not_required" "TESTS_STATUS=not_required" "$(rst_report INFRA '' 0 '')"
assert_contains "INFRA no-command line" "TESTS_LINE=N/A (INFRA class, no test command declared)" "$(rst_report INFRA '' 0 '')"

echo "--- integration: extract -> execute -> parse -> report in a temp worktree ---"
TMP="$(mktemp -d)"
cat > "$TMP/fake-tests.sh" <<'EOF'
#!/usr/bin/env bash
echo "PASS: alpha"
echo "PASS: beta"
echo "PASS: gamma"
echo "Tests: 3/3"
exit 0
EOF
SPEC_TMP="$(printf 'WO Class: CODE\n\nStop 2 (test suite):\n  bash ./fake-tests.sh\n  Expected: 3 passing / 3 total\n')"
CMD="$(printf '%s\n' "$SPEC_TMP" | rst_extract_command)"
assert_eq "integration: command extracted" "bash ./fake-tests.sh" "$CMD"
( cd "$TMP" && timeout 60 bash -o pipefail -c "$CMD" > "$TMP/log" 2>&1 ); RC=$?
COUNTS="$(rst_parse_counts < "$TMP/log")"
assert_eq "integration: counts parsed from real execution" "3 3" "$COUNTS"
assert_eq "integration: report" "$(printf 'TESTS_STATUS=passed\nTESTS_LINE=3/3 (bash ./fake-tests.sh)')" "$(rst_report "$(printf '%s\n' "$SPEC_TMP" | rst_class)" "$CMD" "$RC" "$COUNTS")"
cat > "$TMP/fake-tests.sh" <<'EOF'
#!/usr/bin/env bash
echo "PASS: alpha"
echo "FAIL: beta: expected 2 got 1"
echo "Tests: 1/2"
exit 1
EOF
( cd "$TMP" && timeout 60 bash -o pipefail -c "$CMD" > "$TMP/log" 2>&1 ); RC=$?
assert_eq "integration: red suite reports failed with real numbers" "$(printf 'TESTS_STATUS=failed\nTESTS_LINE=1/2 (bash ./fake-tests.sh) -- FAILED, exit 1')" "$(rst_report CODE "$CMD" "$RC" "$(rst_parse_counts < "$TMP/log")")"
rm -rf "$TMP"

echo
echo "run-stop-tests.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
