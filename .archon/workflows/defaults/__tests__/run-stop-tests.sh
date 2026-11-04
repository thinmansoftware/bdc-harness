#!/usr/bin/env bash
# run-stop-tests.sh -- unit tests for the run-stop-tests node core (rst_*) and the
# dependency-prep core (dprep_ensure_js_deps) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 12 bdc-feature-development lanes.
#
# bdc-xo #1940 (harness defect 2026-09-05): the manifest "Tests:" line was stamped
# "N/A (required gates are reported separately)" on CODE WOs and the validator's test
# claim was never tied to an executed command. run-stop-tests executes the spec's
# declared test command in the run worktree and emits OBSERVED pass/total.
#
# Rather than re-typing that logic (which would drift), these tests EXTRACT the real
# core functions from the canonical YAML (awk range-match on the BEGIN/END markers)
# and exercise them against fixtures. A parity test asserts the core is byte-identical
# across all 13 lanes (this repo has no shared-include mechanism for workflow YAMLs).
# dprep_ensure_js_deps is called by prep-dependencies and by run-stop-tests. Both
# copies are extracted from the canonical YAML and parity-checked at each call site.
# The stbase stub (scripts/lane/stop-tests-base.sh: rst_base_compare, stb_stamp_base_red)
# is parity-checked the same way and exercised as Tests 1-9 of
# WO-HARNESS-STOP-TESTS-BASE-RED-AWARE-01 against real temporary git repos.
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

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle present: $needle"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
LANES="
bdc-feature-development-astra.yaml
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-cursor.yaml
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

extract_core_nth() {
  # extract_core_nth <yaml> <marker> <n>  -> the nth core body (1-based).
  # extract_core concatenates every match, so the two dprep copies are split here.
  tr -d '\r' < "$1" | awk -v m="$2" -v n="$3" '
    index($0, "# ---- BEGIN " m " core") { seen++; if (seen == n + 0) c = 1; next }
    index($0, "# ---- END " m " core") { if (c) { c = 0; exit } next }
    c
  ' | sed 's/^      //'
}

RST_CORE="$(extract_core "$CANONICAL_YAML" rst)"
if [ -z "$RST_CORE" ]; then
  echo "FATAL: could not extract rst core from $CANONICAL_YAML"; exit 1
fi
eval "$RST_CORE"
for fn in rst_class rst_extract_commands rst_command_looks_runnable rst_rescue_subdir rst_tests_in_diff rst_repo_test_script rst_parse_counts rst_scrub_env rst_run_commands rst_report; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

# The YAML dprep core now only sources the shared scripts/lane/dprep.sh (the image path
# is /app/scripts/lane/dprep.sh); point it at this checkout's copy.
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
DPREP_SHARED="$REPO_ROOT/scripts/lane/dprep.sh"
if [ ! -f "$DPREP_SHARED" ]; then
  echo "FATAL: shared dprep script missing at $DPREP_SHARED"; exit 1
fi
export BDC_DPREP_SCRIPT="$DPREP_SHARED"
DPREP_CORE="$(extract_core_nth "$CANONICAL_YAML" dprep 1)"
if [ -z "$DPREP_CORE" ]; then
  echo "FATAL: could not extract dprep core from $CANONICAL_YAML"; exit 1
fi
if [ -n "$(extract_core_nth "$CANONICAL_YAML" dprep 3)" ]; then
  echo "FATAL: canonical yaml has more than 2 dprep cores"; exit 1
fi
eval "$DPREP_CORE"
if ! declare -F dprep_ensure_js_deps >/dev/null; then
  echo "FATAL: dprep_ensure_js_deps not defined after eval"; exit 1
fi

echo "--- Parity: rst core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$RST_CORE" "$(extract_core "$DEFAULTS/$lane" rst)"
done

echo "--- Parity: dprep core byte-identical across all 13 lanes (2 occurrences each) ---"
for lane in $LANES; do
  assert_eq "dprep count $lane" "2" "$(grep -c 'BEGIN dprep core' "$DEFAULTS/$lane")"
  assert_eq "dprep occ1 $lane" "$DPREP_CORE" "$(extract_core_nth "$DEFAULTS/$lane" dprep 1)"
  assert_eq "dprep occ2 $lane" "$DPREP_CORE" "$(extract_core_nth "$DEFAULTS/$lane" dprep 2)"
  impl_dep="$(awk '
    $0 ~ /^  - id: implement$/ { hit = 1; next }
    hit && $0 ~ /^    depends_on:/ { print; exit }
    hit && $0 ~ /^  - id: / { exit }
  ' "$DEFAULTS/$lane")"
  assert_eq "implement depends_on $lane" "    depends_on: [prep-dependencies, repair-gate]" "$impl_dep"
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
  "$(printf '%s\n' "$SPEC_M157" | rst_extract_commands | head -1)"
assert_eq "grep stop with 'tests' in its label is not a test block" \
  "bun test packages/x" \
  "$(printf 'Stop 1 (grep assertion, no secret in tests/fixtures):\n  grep -c x y\n  Expected: 0\n\nStop 2 (tests):\n  bun test packages/x\n  Expected: 3 passing\n' | rst_extract_commands | head -1)"
assert_eq "backslash continuation joins" \
  "cd apps/x && npm.cmd test -- --run a.test.ts b.test.ts" \
  "$(printf 'Stop 6 (unit tests):\n  cd apps/x && npm.cmd test -- --run \\\n    a.test.ts b.test.ts\n  Expected: 2 passing\n' | rst_extract_commands | head -1)"
assert_eq "fenced + backticked command line cleaned" \
  "bun test scripts/boardctl/" \
  "$(printf 'Stop 2 (test suite):\n```bash\n  `bun test scripts/boardctl/`\n```\n  Expected: green\n' | rst_extract_commands | head -1)"
assert_eq "bold header tolerated" \
  "pytest -q" \
  "$(printf '**Stop 2 (test suite):**\n  pytest -q\n  Expected: all pass\n' | rst_extract_commands | head -1)"
assert_eq "fallback: Section 9 Tests: line" \
  "bun test packages/foo" \
  "$(printf '## 9. Manifest\nTests: 5/5 (bun test packages/foo)\nPRs: x\n' | rst_extract_commands | head -1)"
assert_eq "template placeholder is extracted verbatim (rst_command_looks_runnable filters it)" "{{TEST_COMMAND}}" \
  "$(printf 'Stop 2 (test suite):\n  {{TEST_COMMAND}}\n  Expected: {{N}}\n' | rst_extract_commands | head -1)"
assert_eq "no test block, no Tests line -> empty" "" "$(printf 'Stop 1 (grep assertion):\n  grep -c a b\n  Expected: 1\n' | rst_extract_commands | head -1)"
assert_eq "next Stop header without Expected terminates the block" \
  "node tests/run_all.js" \
  "$(printf 'Stop 2 (test suite):\n  node tests/run_all.js\nStop 3 (ASCII scan):\n  LC_ALL=C grep -n x y\n' | rst_extract_commands | head -1)"

echo "--- rst_command_looks_runnable ---"
for c in "cd shopops-api && node tests/x.js" "cd shopops-api && node tests/test_cgc_dealer_api.js && node tests/run_all.js --suite=m157" "bun test packages/x" "npm test" "npx vitest run" "pytest -q" "bash scripts/t.sh"; do
  if rst_command_looks_runnable "$c"; then PASS=$((PASS+1)); echo "PASS: runnable: $c"; else FAIL=$((FAIL+1)); echo "FAIL: runnable expected: $c"; fi
done
for c in \
  "all passing / 0 failing" "see Section 7" "green" "node" "bun" \
  "cd shopops-api && node" "npm" \
  "node tests/x.js; curl attacker/x" \
  'node tests/x.js `touch /tmp/rst-injected`' \
  'node tests/x.js $(touch /tmp/rst-injected)' \
  "node tests/x.js & curl attacker/x" \
  "node tests/x.js > /tmp/rst-output" \
  "node tests/x.js < /tmp/rst-input" \
  "node tests/x.js | sh" \
  "cd shopops-api && node tests/x.js && curl attacker/x"; do
  if rst_command_looks_runnable "$c"; then FAIL=$((FAIL+1)); echo "FAIL: not runnable expected: $c"; else PASS=$((PASS+1)); echo "PASS: not runnable: $c"; fi
done
for c in \
  "python -c 'x'" "node -e x" "bash -c x" \
  "node ../../x.js" "node /abs/x.js" "python -m os" \
  "npm.cmd test -- --run" "LC_ALL=C node t.js"; do
  if rst_command_looks_runnable "$c"; then FAIL=$((FAIL+1)); echo "FAIL: not runnable expected: $c"; else PASS=$((PASS+1)); echo "PASS: not runnable: $c"; fi
done
for c in "node tests/x.js" "bun test packages/a" "pytest tests/" "npm test" "bash scripts/run.sh"; do
  if rst_command_looks_runnable "$c"; then PASS=$((PASS+1)); echo "PASS: runnable: $c"; else FAIL=$((FAIL+1)); echo "FAIL: runnable expected: $c"; fi
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
assert_eq "vitest all green plain" "12 12" "$(printf '      Tests  12 passed (12)\n' | rst_parse_counts)"
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
CMD="$(printf '%s\n' "$SPEC_TMP" | rst_extract_commands | head -1)"
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

echo "--- rst_extract_commands: real spec shapes on bdc-xo main (2026-09-05 survey) ---"
SPEC_GCD='# WO-SHOPOPS-GCD-METADATA-TO-LISTING-01

WO Class: CODE

## 9. Stop conditions (CI-executable)

- `node tests/test_cover_resolver.js` exits 0 if that suite exists; otherwise
  state N/A and add a new suite that does.
- A new suite exists and exits 0: `node tests/test_gcd_metadata_passthrough.js`
- `grep -c "gcd" shopops-api/routes/store.js` returns 1 or greater.
- These pre-existing suites still exit 0: `node tests/test_cert_lookup.js`,
  `node tests/test_scan_to_list_cgc.js`.
- ASCII check on every touched file: `grep -nP "[^\x00-\x7F]"` returns nothing.

## 10. Manifest requirements

Manifest v2 in the PR body per global Rule 2.
'
OUT="$(printf '%s\n' "$SPEC_GCD" | rst_extract_commands)"
assert_eq "bullet-style stop section: four runner commands in document order" \
  "$(printf 'node tests/test_cover_resolver.js\nnode tests/test_gcd_metadata_passthrough.js\nnode tests/test_cert_lookup.js\nnode tests/test_scan_to_list_cgc.js')" "$OUT"

SPEC_GWT='# WO-SHOPOPS-CE-AUTH-CONTEXT-01

WO Class: CODE

## 7. Test scenarios

Test: /admin audit line
Given: alpha token, header bravo
When: GET /admin/ce-session -> 403
Then: one console line

## 12. Stop Point

Test: focused suite green
Given: fresh checkout of the PR head, `cd shopops-api && npm ci`
When: `node tests/test_auth_tenant_context.js`
Then: exit 0, summary line `Passed: N  Failed: 0` with N >= 60

Test: runner wiring
When: `node tests/run_all.js --suite=test_auth_tenant_context`
Then: exit 0 and the suite is listed (1 suite)

Test: legacy structural suite still green
When: `node tests/test_auth0_direct.js`
Then: exit 0

Test: consumers no longer read the raw header first
When: `grep -c "req.headers" shopops-api/routes/admin.js`
Then: 0
'
OUT="$(printf '%s\n' "$SPEC_GWT" | rst_extract_commands)"
assert_eq "Given/When/Then Stop Point: the three runner commands, npm ci and grep excluded" \
  "$(printf 'cd shopops-api && npm ci\nnode tests/test_auth_tenant_context.js\nnode tests/run_all.js --suite=test_auth_tenant_context\nnode tests/test_auth0_direct.js')" "$OUT"
if rst_command_looks_runnable "cd shopops-api && npm ci"; then FAIL=$((FAIL+1)); echo "FAIL: npm ci must not be runnable"; else PASS=$((PASS+1)); echo "PASS: npm ci is filtered as an install step"; fi
if rst_command_looks_runnable "bun install --frozen-lockfile"; then FAIL=$((FAIL+1)); echo "FAIL: bun install must not be runnable"; else PASS=$((PASS+1)); echo "PASS: bun install is filtered as an install step"; fi
if rst_command_looks_runnable "{{TEST_COMMAND}}"; then FAIL=$((FAIL+1)); echo "FAIL: placeholder must not be runnable"; else PASS=$((PASS+1)); echo "PASS: template placeholder is filtered"; fi

SPEC_PROSE='# WO-HARNESS-AUTO-REREVIEW-REPEAT-REASON-01

WO Class: CODE

## Stop conditions
Baseline on untouched tree: scenario 1 FAILS.
1. Given PR head, greps show the reason builder and its call site.
2. Test command exits 0 with scenarios 1-8 asserting values.
3. Runtime (Rule 19, after container rebuild under M-09).

## 12. Stop Point
Stops 1-3 evidenced; status:review; Captain CI closes.
'
assert_eq "prose-only stop section declares no command" "" "$(printf '%s\n' "$SPEC_PROSE" | rst_extract_commands)"
assert_eq "template block first, Section 9 duplicate deduped" \
  "$(printf 'bun test packages/foo\nbun test packages/bar')" \
  "$(printf 'Stop 2 (test suite):\n  bun test packages/foo\n  Expected: 3 passing\n\n## Stop conditions\n- `bun test packages/bar` exits 0\n\nTests: 3/3 (bun test packages/foo)\n' | rst_extract_commands)"
assert_eq "cap at 8 commands" "8" "$(for i in 1 2 3 4 5 6 7 8 9 10; do printf -- '## Stop conditions\n- `node tests/t%s.js` exits 0\n' "$i"; done | rst_extract_commands | grep -c .)"

echo "--- rst_rescue_subdir ---"
TMP="$(mktemp -d)"
mkdir -p "$TMP/shopops-api/tests" "$TMP/docs" "$TMP/node_modules/x/tests"
printf 'x' > "$TMP/shopops-api/tests/test_x.js"
printf 'x' > "$TMP/node_modules/x/tests/test_x.js"
assert_eq "node tests/x.js rescued into the only depth-1 dir that has it" "cd shopops-api && node tests/test_x.js" "$(cd "$TMP" && rst_rescue_subdir 'node tests/test_x.js')"
assert_eq "already cd-prefixed command untouched" "cd shopops-api && node tests/test_x.js" "$(cd "$TMP" && rst_rescue_subdir 'cd shopops-api && node tests/test_x.js')"
assert_eq "path that exists at root untouched" "bun test shopops-api/tests/test_x.js" "$(cd "$TMP" && rst_rescue_subdir 'bun test shopops-api/tests/test_x.js')"
assert_eq "path found nowhere untouched" "node tests/nope.js" "$(cd "$TMP" && rst_rescue_subdir 'node tests/nope.js')"
mkdir -p "$TMP/other/tests" && printf 'x' > "$TMP/other/tests/test_x.js"
assert_eq "ambiguous (two candidate dirs) untouched" "node tests/test_x.js" "$(cd "$TMP" && rst_rescue_subdir 'node tests/test_x.js')"
rm -rf "$TMP"

echo "--- rst_tests_in_diff (temp git repo) ---"
TMP="$(mktemp -d)"
(
  cd "$TMP" && git init -q . && git config user.email t@t && git config user.name t
  mkdir -p src shopops-api/tests/fixtures shopops-api/tests/helpers packages/x/src tests/helpers
  printf 'base\n' > src/a.ts && printf '{}\n' > bun.lock && printf '{"name":"x"}\n' > package.json
  git add -A && git commit -qm base
  BASE="$(git rev-parse HEAD)"
  printf 'changed\n' > src/a.ts
  printf 't\n' > packages/x/src/a.test.ts
  printf 't\n' > shopops-api/tests/test_b.js
  printf '{}\n' > shopops-api/tests/fixtures/f.json
  printf 'h\n' > shopops-api/tests/helpers/h.js
  printf 'h\n' > tests/helpers/h.js
  printf 'r\n' > shopops-api/tests/run_all.js
  printf 'u\n' > shopops-api/tests/_harness.js
  printf 's\n' > tests/test_validate_prior_art_evidence.sh
  git add -A && git commit -qm change
  mkdir -p packages/y && printf 'u\n' > packages/y/z.spec.ts
  rst_tests_in_diff "$BASE" > "$TMP/out1"
  printf '{"name":"x","devDependencies":{"vitest":"^2"}}\n' > package.json
  rst_tests_in_diff "$BASE" > "$TMP/out2"
  git checkout -q -- . 2>/dev/null; rm -f packages/y/z.spec.ts
  rst_tests_in_diff HEAD > "$TMP/out3"
)
assert_eq "bun runner groups committed + untracked test files; bash test at root; fixtures/helpers/run_all/_harness/src excluded" \
  "$(printf 'cd shopops-api && node tests/test_b.js\nbash tests/test_validate_prior_art_evidence.sh\nbun test packages/x/src/a.test.ts packages/y/z.spec.ts')" "$(cat "$TMP/out1")"
assert_contains "vitest declared in package.json -> npx vitest run" "npx vitest run packages/x/src/a.test.ts packages/y/z.spec.ts" "$(cat "$TMP/out2")"
assert_eq "no test files in diff -> empty" "" "$(cat "$TMP/out3")"
rm -rf "$TMP"

echo "--- rst_repo_test_script (last rung) ---"
TMP="$(mktemp -d)"
assert_eq "no package.json -> empty" "" "$(cd "$TMP" && rst_repo_test_script)"
printf '{"name":"x","scripts":{"build":"tsc"}}\n' > "$TMP/package.json"
assert_eq "package.json without a test script -> empty" "" "$(cd "$TMP" && rst_repo_test_script)"
printf '{"name":"x","scripts":{"test":"vitest run"}}\n' > "$TMP/package.json"
assert_eq "test script, no bun lockfile -> npm test" "npm test" "$(cd "$TMP" && rst_repo_test_script)"
printf '{}\n' > "$TMP/bun.lock"
assert_eq "test script + bun.lock -> bun run test" "bun run test" "$(cd "$TMP" && rst_repo_test_script)"
rm -rf "$TMP"

echo "--- rst_run_commands: two commands, counts summed, first nonzero exit kept ---"
export OVERSEER_FOO=production-shaped-test-value
export MERGE_MANAGER_GH_TOKEN=production-shaped-test-value
export BOARD_PRINCIPALS_JSON=production-shaped-test-value
export GH_TOKEN=production-shaped-test-value
export DISPATCH_POSTGRES_PHASE15_TEST_URL=postgresql://localhost/phase15
rst_scrub_env
assert_eq "scrub removes OVERSEER_ prefix" "unset" "${OVERSEER_FOO:-unset}"
assert_eq "scrub removes MERGE_MANAGER_ prefix" "unset" "${MERGE_MANAGER_GH_TOKEN:-unset}"
assert_eq "scrub removes BOARD_ prefix" "unset" "${BOARD_PRINCIPALS_JSON:-unset}"
assert_eq "scrub removes exact GH_TOKEN" "unset" "${GH_TOKEN:-unset}"
assert_eq "scrub preserves disposable test fixtures" "postgresql://localhost/phase15" "${DISPATCH_POSTGRES_PHASE15_TEST_URL:-unset}"
echo "--- telegram operational names are scrubbed; fixtures and runtime basics remain ---"
T2_SNAP="$(
  export TELEGRAM_BOT_TOKEN=production-shaped-test-value
  export TELEGRAM_STREAMING_MODE=production-shaped-test-value
  export TELEGRAM_APPROVAL_CHAT_ID=production-shaped-test-value
  export TELEGRAM_ALLOWED_USER_IDS=production-shaped-test-value
  export TELEGRAM_TEST_FIXTURE=fixture-value
  export DISPATCH_POSTGRES_PHASE15_TEST_URL=postgresql://localhost/phase15
  path_before="$PATH"
  home_before="$HOME"
  rst_scrub_env
  printf 'BOT=%s\n' "${TELEGRAM_BOT_TOKEN-unset}"
  printf 'MODE=%s\n' "${TELEGRAM_STREAMING_MODE-unset}"
  printf 'CHAT=%s\n' "${TELEGRAM_APPROVAL_CHAT_ID-unset}"
  printf 'USERS=%s\n' "${TELEGRAM_ALLOWED_USER_IDS-unset}"
  printf 'FIX=%s\n' "${TELEGRAM_TEST_FIXTURE-unset}"
  printf 'URL=%s\n' "${DISPATCH_POSTGRES_PHASE15_TEST_URL-unset}"
  if [ "$PATH" = "$path_before" ]; then printf 'PATH=same\n'; else printf 'PATH=changed\n'; fi
  if [ "$HOME" = "$home_before" ]; then printf 'HOME=same\n'; else printf 'HOME=changed\n'; fi
)"
assert_eq "t2 TELEGRAM_BOT_TOKEN removed" "BOT=unset" "$(printf '%s\n' "$T2_SNAP" | sed -n '1p')"
assert_eq "t2 TELEGRAM_STREAMING_MODE removed" "MODE=unset" "$(printf '%s\n' "$T2_SNAP" | sed -n '2p')"
assert_eq "t2 TELEGRAM_APPROVAL_CHAT_ID removed" "CHAT=unset" "$(printf '%s\n' "$T2_SNAP" | sed -n '3p')"
assert_eq "t2 TELEGRAM_ALLOWED_USER_IDS removed" "USERS=unset" "$(printf '%s\n' "$T2_SNAP" | sed -n '4p')"
assert_eq "t2 TELEGRAM_TEST_FIXTURE kept" "FIX=fixture-value" "$(printf '%s\n' "$T2_SNAP" | sed -n '5p')"
assert_eq "t2 DISPATCH test url kept" "URL=postgresql://localhost/phase15" "$(printf '%s\n' "$T2_SNAP" | sed -n '6p')"
assert_eq "t2 PATH kept" "PATH=same" "$(printf '%s\n' "$T2_SNAP" | sed -n '7p')"
assert_eq "t2 HOME kept" "HOME=same" "$(printf '%s\n' "$T2_SNAP" | sed -n '8p')"
TMP="$(mktemp -d)"
cat > "$TMP/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo "Tests: 3/3"
EOF
cat > "$TMP/red.sh" <<'EOF'
#!/usr/bin/env bash
echo " 4 pass"
echo " 1 fail"
exit 1
EOF
printf 'bash ./ok.sh\nbash ./red.sh\n' > "$TMP/cmds"
assert_eq "exit 1, 7 passed of 8" "1 7 8" "$(cd "$TMP" && rst_run_commands ./cmds ./log)"
assert_contains "log carries per-command headers" "### run-stop-tests: bash ./red.sh" "$(cat "$TMP/log")"
assert_contains "log carries per-command exit" "### exit 1" "$(cat "$TMP/log")"
printf 'bash ./ok.sh\n' > "$TMP/cmds"
assert_eq "single green command" "0 3 3" "$(cd "$TMP" && rst_run_commands ./cmds ./log2)"
printf 'exit 0\n' > "$TMP/silent.sh"
printf 'bash ./silent.sh\n' > "$TMP/cmds"
assert_eq "no counts parsed -> exit only" "0  " "$(cd "$TMP" && rst_run_commands ./cmds ./log3)"
rm -rf "$TMP"

echo "--- dprep_ensure_js_deps and npx/npm translation ---"
ORIG_PATH="$PATH"
BIN="$(mktemp -d)"
REC="$BIN/argv.txt"
ENVREC="$BIN/env.txt"

echo "--- test 1: bun worktree without node_modules installs ---"
cat > "$BIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC"
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-unset}" >> "$ENVREC"
printf 'TEST_URL=%s\\n' "\${DISPATCH_POSTGRES_PHASE15_TEST_URL-unset}" >> "$ENVREC"
printf 'BOT=%s\\n' "\${TELEGRAM_BOT_TOKEN-unset}" >> "$ENVREC"
printf 'MODE=%s\\n' "\${TELEGRAM_STREAMING_MODE-unset}" >> "$ENVREC"
printf 'CHAT=%s\\n' "\${TELEGRAM_APPROVAL_CHAT_ID-unset}" >> "$ENVREC"
printf 'USERS=%s\\n' "\${TELEGRAM_ALLOWED_USER_IDS-unset}" >> "$ENVREC"
printf 'FIX=%s\\n' "\${TELEGRAM_TEST_FIXTURE-unset}" >> "$ENVREC"
mkdir -p node_modules
EOF
chmod +x "$BIN/bun"
export PATH="$BIN:/usr/bin:/bin"
export GH_TOKEN=production-shaped-test-value
export DISPATCH_POSTGRES_PHASE15_TEST_URL=postgresql://localhost/phase15
export TELEGRAM_BOT_TOKEN=production-shaped-test-value
export TELEGRAM_STREAMING_MODE=production-shaped-test-value
export TELEGRAM_APPROVAL_CHAT_ID=production-shaped-test-value
export TELEGRAM_ALLOWED_USER_IDS=production-shaped-test-value
export TELEGRAM_TEST_FIXTURE=fixture-value
TMP="$(mktemp -d)"
printf '{}\n' > "$TMP/package.json"
: > "$TMP/bun.lock"
out="$(cd "$TMP" && dprep_ensure_js_deps)"
rc=$?
assert_eq "test1 rc" "0" "$rc"
assert_contains "test1 installing line" "dprep: installing JS dependencies (bun install --frozen-lockfile)" "$out"
assert_contains "test1 install ok" "dprep: install ok (" "$out"
assert_eq "test1 argv" "install --frozen-lockfile" "$(cat "$REC")"
assert_eq "test1 scrubbed GH_TOKEN" "GH_TOKEN=unset" "$(head -1 "$ENVREC")"
assert_eq "test1 kept TEST_URL" "TEST_URL=postgresql://localhost/phase15" "$(sed -n '2p' "$ENVREC")"
assert_eq "test1 scrubbed TELEGRAM_BOT_TOKEN" "BOT=unset" "$(sed -n '3p' "$ENVREC")"
assert_eq "test1 scrubbed TELEGRAM_STREAMING_MODE" "MODE=unset" "$(sed -n '4p' "$ENVREC")"
assert_eq "test1 scrubbed TELEGRAM_APPROVAL_CHAT_ID" "CHAT=unset" "$(sed -n '5p' "$ENVREC")"
assert_eq "test1 scrubbed TELEGRAM_ALLOWED_USER_IDS" "USERS=unset" "$(sed -n '6p' "$ENVREC")"
assert_eq "test1 kept TELEGRAM_TEST_FIXTURE" "FIX=fixture-value" "$(sed -n '7p' "$ENVREC")"
assert_not_contains "test1 stdout has no sentinel" "production-shaped-test-value" "$out"
assert_eq "test1 parent TELEGRAM_BOT_TOKEN remains" "production-shaped-test-value" "${TELEGRAM_BOT_TOKEN-unset}"
if [ -d "$TMP/node_modules" ]; then PASS=$((PASS + 1)); echo "PASS: test1 node_modules exists"; else FAIL=$((FAIL + 1)); echo "FAIL: test1 node_modules exists"; fi

echo "--- dprep copy 2: second extracted core scrubs telegram the same way ---"
C2BIN="$(mktemp -d)"
C2REC="$C2BIN/argv.txt"
C2ENV="$C2BIN/env.txt"
cat > "$C2BIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$C2REC"
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-unset}" >> "$C2ENV"
printf 'TEST_URL=%s\\n' "\${DISPATCH_POSTGRES_PHASE15_TEST_URL-unset}" >> "$C2ENV"
printf 'BOT=%s\\n' "\${TELEGRAM_BOT_TOKEN-unset}" >> "$C2ENV"
printf 'MODE=%s\\n' "\${TELEGRAM_STREAMING_MODE-unset}" >> "$C2ENV"
printf 'CHAT=%s\\n' "\${TELEGRAM_APPROVAL_CHAT_ID-unset}" >> "$C2ENV"
printf 'USERS=%s\\n' "\${TELEGRAM_ALLOWED_USER_IDS-unset}" >> "$C2ENV"
printf 'FIX=%s\\n' "\${TELEGRAM_TEST_FIXTURE-unset}" >> "$C2ENV"
mkdir -p node_modules
EOF
chmod +x "$C2BIN/bun"
C2TMP="$(mktemp -d)"
printf '{}\n' > "$C2TMP/package.json"
: > "$C2TMP/bun.lock"
c2_out="$(
  eval "$(extract_core_nth "$CANONICAL_YAML" dprep 2)"
  cd "$C2TMP" || exit 1
  export PATH="$C2BIN:/usr/bin:/bin"
  export GH_TOKEN=production-shaped-test-value
  export DISPATCH_POSTGRES_PHASE15_TEST_URL=postgresql://localhost/phase15
  export TELEGRAM_BOT_TOKEN=production-shaped-test-value
  export TELEGRAM_STREAMING_MODE=production-shaped-test-value
  export TELEGRAM_APPROVAL_CHAT_ID=production-shaped-test-value
  export TELEGRAM_ALLOWED_USER_IDS=production-shaped-test-value
  export TELEGRAM_TEST_FIXTURE=fixture-value
  dprep_ensure_js_deps
)"
c2_rc=$?
assert_eq "copy2 rc" "0" "$c2_rc"
assert_eq "copy2 argv" "install --frozen-lockfile" "$(cat "$C2REC")"
assert_eq "copy2 scrubbed TELEGRAM_BOT_TOKEN" "BOT=unset" "$(sed -n '3p' "$C2ENV")"
assert_eq "copy2 scrubbed TELEGRAM_STREAMING_MODE" "MODE=unset" "$(sed -n '4p' "$C2ENV")"
assert_eq "copy2 scrubbed TELEGRAM_APPROVAL_CHAT_ID" "CHAT=unset" "$(sed -n '5p' "$C2ENV")"
assert_eq "copy2 scrubbed TELEGRAM_ALLOWED_USER_IDS" "USERS=unset" "$(sed -n '6p' "$C2ENV")"
assert_eq "copy2 kept TELEGRAM_TEST_FIXTURE" "FIX=fixture-value" "$(sed -n '7p' "$C2ENV")"
assert_not_contains "copy2 stdout has no sentinel" "production-shaped-test-value" "$c2_out"
assert_eq "copy2 parent TELEGRAM_BOT_TOKEN remains" "production-shaped-test-value" "${TELEGRAM_BOT_TOKEN-unset}"
rm -rf "$C2BIN" "$C2TMP"

echo "--- test 2: prep is idempotent and skips when not applicable ---"
out="$(cd "$TMP" && dprep_ensure_js_deps)"
rc=$?
assert_eq "test2 present rc" "0" "$rc"
assert_contains "test2 node_modules present" "dprep: node_modules present, skipping" "$out"
TMP2="$(mktemp -d)"
printf '{}\n' > "$TMP2/package.json"
out="$(cd "$TMP2" && dprep_ensure_js_deps)"
rc=$?
assert_eq "test2 no lock rc" "0" "$rc"
assert_contains "test2 no lock" "dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping" "$out"
TMP3="$(mktemp -d)"
out="$(cd "$TMP3" && dprep_ensure_js_deps)"
rc=$?
assert_eq "test2 empty rc" "0" "$rc"
assert_contains "test2 empty dir" "dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping" "$out"
assert_eq "test2 bun call count stays 1" "1" "$(wc -l < "$REC" | tr -d ' ')"

echo "--- test 3: missing bun skips cleanly ---"
TMP4="$(mktemp -d)"
printf '{}\n' > "$TMP4/package.json"
: > "$TMP4/bun.lock"
out="$(cd "$TMP4" && PATH="/usr/bin:/bin" dprep_ensure_js_deps)"
rc=$?
assert_eq "test3 rc" "0" "$rc"
assert_contains "test3 bun missing" "dprep: bun not found, skipping" "$out"

echo "--- test 4: a failed install never fails the run ---"
cat > "$BIN/bun" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$BIN/bun"
TMP5="$(mktemp -d)"
(
  cd "$TMP5" || exit 1
  git init -q .
  git config user.email t@t
  git config user.name t
  printf '{}\n' > package.json
  printf '{}\n' > bun.lock
  git add package.json bun.lock
  git commit -qm base
  dprep_ensure_js_deps > "$TMP5/out"
  printf '%s\n' "$?" > "$TMP5/rc"
  git status --porcelain --untracked-files=no > "$TMP5/porcelain"
)
assert_eq "test4 rc" "0" "$(tr -d '[:space:]' < "$TMP5/rc")"
assert_contains "test4 failed install continues" "dprep: install failed rc=1 (continuing" "$(cat "$TMP5/out")"
assert_eq "test4 tracked files untouched" "" "$(cat "$TMP5/porcelain")"

echo "--- test 5: npx becomes bunx when npx is absent ---"
: > "$REC"
cat > "$BIN/bunx" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC"
printf '      Tests  3 passed (3)\\n'
EOF
chmod +x "$BIN/bunx"
rm -f "$BIN/bun"
export PATH="$BIN:/usr/bin:/bin"
export RST_NPX_BIN="rst-npx-missing"
TMP6="$(mktemp -d)"
printf 'npx vitest run x.test.ts\n' > "$TMP6/cmds"
result="$(cd "$TMP6" && rst_run_commands ./cmds ./log)"
assert_eq "test5 counts" "0 3 3" "$result"
assert_eq "test5 bunx argv" "vitest run x.test.ts" "$(cat "$REC")"
assert_contains "test5 translation" "rst_run_commands: npx not found, running as: bunx vitest run x.test.ts" "$(cat "$TMP6/log")"
SOURCE=spec_declared
report="$(rst_report CODE 'npx vitest run x.test.ts' "${result%% *}" "${result#* }")"
assert_contains "test5 status" "TESTS_STATUS=passed" "$report"
assert_contains "test5 line" "TESTS_LINE=3/3 (npx vitest run x.test.ts)" "$report"
rm -f "$BIN/bunx"
cat > "$BIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC"
printf '      Tests  3 passed (3)\\n'
EOF
chmod +x "$BIN/bun"
: > "$REC"
result="$(cd "$TMP6" && rst_run_commands ./cmds ./logb)"
assert_eq "test5 bun x argv" "x vitest run x.test.ts" "$(cat "$REC")"
assert_contains "test5 bun x translation" "rst_run_commands: npx not found, running as: bun x vitest run x.test.ts" "$(cat "$TMP6/logb")"

echo "--- test 6: npm test becomes bun run test; real npx is left alone ---"
unset RST_NPX_BIN
export RST_NPM_BIN="rst-npm-missing"
: > "$REC"
cat > "$BIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC"
printf '      Tests  2 passed (2)\\n'
EOF
chmod +x "$BIN/bun"
TMP7="$(mktemp -d)"
printf 'npm test\n' > "$TMP7/cmds"
result="$(cd "$TMP7" && rst_run_commands ./cmds ./log)"
assert_eq "test6 bun argv" "run test" "$(cat "$REC")"
assert_contains "test6 npm translation" "rst_run_commands: npm not found, running as: bun run test" "$(cat "$TMP7/log")"
printf 'npm run unit -- --run extra.test.ts\n' > "$TMP7/cmds"
: > "$REC"
result="$(cd "$TMP7" && rst_run_commands ./cmds ./logr)"
assert_eq "test6 npm run argv" "run unit -- --run extra.test.ts" "$(cat "$REC")"
assert_contains "test6 npm run translation" "rst_run_commands: npm not found, running as: bun run unit -- --run extra.test.ts" "$(cat "$TMP7/logr")"
REC2="$BIN/npx-argv.txt"
cat > "$BIN/npx" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC2"
printf '      Tests  1 passed (1)\\n'
EOF
chmod +x "$BIN/npx"
unset RST_NPX_BIN
printf 'npx vitest run y.test.ts\n' > "$TMP7/cmds"
result="$(cd "$TMP7" && rst_run_commands ./cmds ./logn)"
assert_eq "test6 npx argv" "vitest run y.test.ts" "$(cat "$REC2")"
assert_not_contains "test6 real npx not rewritten" "npx not found" "$(cat "$TMP7/logn")"
rm -f "$BIN/bun"
cat > "$BIN/npm" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$REC"
printf '      Tests  2 passed (2)\\n'
EOF
chmod +x "$BIN/npm"
unset RST_NPM_BIN
: > "$REC"
printf 'npm test\n' > "$TMP7/cmds"
result="$(cd "$TMP7" && rst_run_commands ./cmds ./logm)"
assert_eq "test6 real npm argv" "test" "$(cat "$REC")"
assert_not_contains "test6 real npm not rewritten" "npm not found" "$(cat "$TMP7/logm")"

echo "--- test 7: the allowlist is not widened ---"
for c in \
  "npx vitest run x.test.ts; rm -rf /" \
  'npx vitest run $(id)' \
  "npm install" \
  "bunx -e 'x'"; do
  if rst_command_looks_runnable "$c"; then
    FAIL=$((FAIL + 1)); echo "FAIL: test7 not runnable expected: $c"
  else
    PASS=$((PASS + 1)); echo "PASS: test7 not runnable: $c"
  fi
done
INVOKED="$BIN/invoked"
rm -f "$INVOKED"
cat > "$BIN/bunx" <<EOF
#!/usr/bin/env bash
printf 'invoked\\n' >> "$INVOKED"
EOF
chmod +x "$BIN/bunx"
cat > "$BIN/npx" <<EOF
#!/usr/bin/env bash
printf 'invoked\\n' >> "$INVOKED"
EOF
chmod +x "$BIN/npx"
printf 'npx vitest run x.test.ts; rm -rf /\n' > "$TMP7/cmds"
result="$(cd "$TMP7" && rst_run_commands ./cmds ./log7)"
assert_contains "test7 refused" "rst_run_commands: refusing non-runnable command" "$(cat "$TMP7/log7")"
if [ -f "$INVOKED" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: test7 stub was invoked"
else
  PASS=$((PASS + 1)); echo "PASS: test7 stub was not invoked"
fi

echo "--- repeated scrub is stable and a child export does not touch the parent ---"
telegram_scrub_snapshot() {
  export TELEGRAM_BOT_TOKEN=production-shaped-test-value
  export TELEGRAM_STREAMING_MODE=production-shaped-test-value
  export TELEGRAM_APPROVAL_CHAT_ID=production-shaped-test-value
  export TELEGRAM_ALLOWED_USER_IDS=production-shaped-test-value
  export TELEGRAM_TEST_FIXTURE=fixture-value
  export DISPATCH_POSTGRES_PHASE15_TEST_URL=postgresql://localhost/phase15
  rst_scrub_env
  if [ "${1:-}" = "twice" ]; then rst_scrub_env; fi
  printf 'BOT=%s\nMODE=%s\nCHAT=%s\nUSERS=%s\nFIX=%s\nURL=%s\n' \
    "${TELEGRAM_BOT_TOKEN-unset}" \
    "${TELEGRAM_STREAMING_MODE-unset}" \
    "${TELEGRAM_APPROVAL_CHAT_ID-unset}" \
    "${TELEGRAM_ALLOWED_USER_IDS-unset}" \
    "${TELEGRAM_TEST_FIXTURE-unset}" \
    "${DISPATCH_POSTGRES_PHASE15_TEST_URL-unset}"
}
parent_bot_before="${TELEGRAM_BOT_TOKEN-unset}"
ONCE_SNAP="$(telegram_scrub_snapshot)"
TWICE_SNAP="$(telegram_scrub_snapshot twice)"
assert_eq "t3 two scrubs match one" "$ONCE_SNAP" "$TWICE_SNAP"
assert_eq "t3 scrub subshell leaves parent token" "$parent_bot_before" "${TELEGRAM_BOT_TOKEN-unset}"
export TELEGRAM_BOT_TOKEN=production-shaped-test-value
bash -c 'export TELEGRAM_BOT_TOKEN=in-test-fake'
assert_eq "t3 child export leaves parent token" "production-shaped-test-value" "${TELEGRAM_BOT_TOKEN-unset}"

echo "--- rst_run_commands child boundary removes operational telegram names ---"
RST_TG="$(mktemp -d)"
cat > "$RST_TG/probe.sh" <<'EOF'
#!/usr/bin/env bash
printf 'BOT=%s\n' "${TELEGRAM_BOT_TOKEN-unset}"
printf 'MODE=%s\n' "${TELEGRAM_STREAMING_MODE-unset}"
printf 'CHAT=%s\n' "${TELEGRAM_APPROVAL_CHAT_ID-unset}"
printf 'USERS=%s\n' "${TELEGRAM_ALLOWED_USER_IDS-unset}"
printf 'FIX=%s\n' "${TELEGRAM_TEST_FIXTURE-unset}"
printf 'Tests: 1/1\n'
EOF
chmod +x "$RST_TG/probe.sh"
printf 'bash ./probe.sh\n' > "$RST_TG/cmds"
export TELEGRAM_BOT_TOKEN=production-shaped-test-value
export TELEGRAM_STREAMING_MODE=production-shaped-test-value
export TELEGRAM_APPROVAL_CHAT_ID=production-shaped-test-value
export TELEGRAM_ALLOWED_USER_IDS=production-shaped-test-value
export TELEGRAM_TEST_FIXTURE=fixture-value
rst_summary="$(cd "$RST_TG" && rst_run_commands ./cmds ./log)"
assert_eq "t4 rst child exit and counts" "0 1 1" "$rst_summary"
assert_eq "t4 child TELEGRAM_BOT_TOKEN unset" "BOT=unset" "$(grep -x 'BOT=unset' "$RST_TG/log" | head -1)"
assert_eq "t4 child TELEGRAM_STREAMING_MODE unset" "MODE=unset" "$(grep -x 'MODE=unset' "$RST_TG/log" | head -1)"
assert_eq "t4 child TELEGRAM_APPROVAL_CHAT_ID unset" "CHAT=unset" "$(grep -x 'CHAT=unset' "$RST_TG/log" | head -1)"
assert_eq "t4 child TELEGRAM_ALLOWED_USER_IDS unset" "USERS=unset" "$(grep -x 'USERS=unset' "$RST_TG/log" | head -1)"
assert_eq "t4 child TELEGRAM_TEST_FIXTURE kept" "FIX=fixture-value" "$(grep -x 'FIX=fixture-value' "$RST_TG/log" | head -1)"
assert_contains "t4 log keeps original command" "### run-stop-tests: bash ./probe.sh" "$(cat "$RST_TG/log")"
assert_not_contains "t4 log has no sentinel" "production-shaped-test-value" "$(cat "$RST_TG/log")"
assert_eq "t4 parent TELEGRAM_BOT_TOKEN unchanged" "production-shaped-test-value" "${TELEGRAM_BOT_TOKEN-unset}"

echo "--- genuine failing counts stay blocking ---"
T5="$(mktemp -d)"
cat > "$T5/fail.sh" <<'EOF'
#!/usr/bin/env bash
printf 'Tests: 0/1\n'
exit 1
EOF
chmod +x "$T5/fail.sh"
printf 'bash ./fail.sh\n' > "$T5/cmds"
t5_result="$(cd "$T5" && rst_run_commands ./cmds ./log)"
assert_eq "t5 rst_run_commands exit and counts" "1 0 1" "$t5_result"
t5_exit="${t5_result%% *}"
t5_counts="${t5_result#* }"
t5_report="$(rst_report CODE 'bash ./fail.sh' "$t5_exit" "$t5_counts")"
assert_contains "t5 TESTS_STATUS failed" "TESTS_STATUS=failed" "$t5_report"
assert_contains "t5 TESTS_LINE has 0/1" "0/1" "$t5_report"
assert_contains "t5 TESTS_LINE has FAILED" "FAILED" "$t5_report"

echo "--- absent telegram names stay a no-op ---"
T6_EMPTY="$(mktemp -d)"
T6="$(
  unset TELEGRAM_BOT_TOKEN TELEGRAM_STREAMING_MODE TELEGRAM_APPROVAL_CHAT_ID TELEGRAM_ALLOWED_USER_IDS
  rst_scrub_env
  printf 'rc1=%s\n' "$?"
  s1="$(printf '%s\n' "${TELEGRAM_BOT_TOKEN-absent}" "${TELEGRAM_STREAMING_MODE-absent}" "${TELEGRAM_APPROVAL_CHAT_ID-absent}" "${TELEGRAM_ALLOWED_USER_IDS-absent}" "${PATH}" "${HOME}")"
  rst_scrub_env
  printf 'rc2=%s\n' "$?"
  s2="$(printf '%s\n' "${TELEGRAM_BOT_TOKEN-absent}" "${TELEGRAM_STREAMING_MODE-absent}" "${TELEGRAM_APPROVAL_CHAT_ID-absent}" "${TELEGRAM_ALLOWED_USER_IDS-absent}" "${PATH}" "${HOME}")"
  if [ "$s1" = "$s2" ]; then printf 'same=yes\n'; else printf 'same=no\n'; fi
  dprep_out="$(cd "$T6_EMPTY" && dprep_ensure_js_deps)"
  printf 'dprep_rc=%s\n' "$?"
  printf 'dprep_out=%s\n' "$dprep_out"
)"
assert_eq "t6 first scrub rc" "rc1=0" "$(printf '%s\n' "$T6" | sed -n '1p')"
assert_eq "t6 second scrub rc" "rc2=0" "$(printf '%s\n' "$T6" | sed -n '2p')"
assert_eq "t6 repeated scrub identical" "same=yes" "$(printf '%s\n' "$T6" | sed -n '3p')"
assert_eq "t6 dprep skip rc" "dprep_rc=0" "$(printf '%s\n' "$T6" | sed -n '4p')"
assert_contains "t6 dprep skip path" "dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping" "$(printf '%s\n' "$T6" | sed -n '5p')"

echo "--- dprep pnpm lockfile branch ---"
PBIN="$(mktemp -d)"
PREC="$PBIN/pnpm-argv.txt"
PENV="$PBIN/pnpm-env.txt"
BREC="$PBIN/bun-argv.txt"
cat > "$PBIN/pnpm" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$PREC"
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-unset}" >> "$PENV"
EOF
cat > "$PBIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$BREC"
EOF
chmod +x "$PBIN/pnpm" "$PBIN/bun"
export GH_TOKEN=production-shaped-test-value

echo "--- pnpm a: pnpm-lock.yaml and no node_modules installs frozen ---"
: > "$PREC"
: > "$PENV"
: > "$BREC"
PTMP="$(mktemp -d)"
printf '{}\n' > "$PTMP/package.json"
: > "$PTMP/pnpm-lock.yaml"
pout="$(cd "$PTMP" && PATH="$PBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
prc=$?
assert_eq "pnpm a rc" "0" "$prc"
assert_eq "pnpm a argv" "install --frozen-lockfile" "$(cat "$PREC")"
assert_eq "pnpm a GH_TOKEN scrubbed" "GH_TOKEN=unset" "$(head -1 "$PENV")"
assert_eq "pnpm a parent GH_TOKEN remains" "production-shaped-test-value" "${GH_TOKEN-unset}"
assert_contains "pnpm a installing line" "dprep: installing JS dependencies (pnpm, frozen lockfile)" "$pout"
if [ -s "$BREC" ]; then FAIL=$((FAIL + 1)); echo "FAIL: pnpm a bun not called"; else PASS=$((PASS + 1)); echo "PASS: pnpm a bun not called"; fi

echo "--- pnpm b: empty directory does not call pnpm ---"
: > "$PREC"
PTMPB="$(mktemp -d)"
poutb="$(cd "$PTMPB" && PATH="$PBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
prcb=$?
assert_eq "pnpm b rc" "0" "$prcb"
assert_contains "pnpm b skip" "dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping" "$poutb"
if [ -s "$PREC" ]; then FAIL=$((FAIL + 1)); echo "FAIL: pnpm b stub not called"; else PASS=$((PASS + 1)); echo "PASS: pnpm b stub not called"; fi

echo "--- pnpm c: bun.lock only takes the bun path ---"
: > "$PREC"
: > "$BREC"
PTMPC="$(mktemp -d)"
printf '{}\n' > "$PTMPC/package.json"
: > "$PTMPC/bun.lock"
poutc="$(cd "$PTMPC" && PATH="$PBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
prcc=$?
assert_eq "pnpm c rc" "0" "$prcc"
assert_eq "pnpm c bun argv" "install --frozen-lockfile" "$(cat "$BREC")"
assert_contains "pnpm c bun installing line" "dprep: installing JS dependencies (bun install --frozen-lockfile)" "$poutc"
if [ -s "$PREC" ]; then FAIL=$((FAIL + 1)); echo "FAIL: pnpm c pnpm not called"; else PASS=$((PASS + 1)); echo "PASS: pnpm c pnpm not called"; fi

echo "--- pnpm d: node_modules present skips pnpm ---"
: > "$PREC"
PTMPD="$(mktemp -d)"
printf '{}\n' > "$PTMPD/package.json"
: > "$PTMPD/pnpm-lock.yaml"
mkdir -p "$PTMPD/node_modules"
poutd="$(cd "$PTMPD" && PATH="$PBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
prcd=$?
assert_eq "pnpm d rc" "0" "$prcd"
assert_contains "pnpm d skip" "dprep: node_modules present, skipping" "$poutd"
if [ -s "$PREC" ]; then FAIL=$((FAIL + 1)); echo "FAIL: pnpm d stub not called"; else PASS=$((PASS + 1)); echo "PASS: pnpm d stub not called"; fi

echo "--- dprep npm (package-lock.json) branch (Fix A3: comicstoreos-provisioner runs dcb97aeb, 860c61e2) ---"
NBIN="$(mktemp -d)"
NREC="$NBIN/npm-argv.txt"
NENV="$NBIN/npm-env.txt"
NBREC="$NBIN/bun-argv.txt"
NPREC="$NBIN/pnpm-argv.txt"
cat > "$NBIN/npm" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$NREC"
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-unset}" >> "$NENV"
mkdir -p node_modules
EOF
cat > "$NBIN/bun" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$NBREC"
EOF
cat > "$NBIN/pnpm" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$NPREC"
EOF
chmod +x "$NBIN/npm" "$NBIN/bun" "$NBIN/pnpm"
export GH_TOKEN=production-shaped-test-value
nreset() { : > "$NREC"; : > "$NENV"; : > "$NBREC"; : > "$NPREC"; }

echo "--- npm a: package-lock.json only runs npm ci (both YAML call sites) ---"
for occ in 1 2; do
  nreset
  NTMP="$(mktemp -d)"
  printf '{}\n' > "$NTMP/package.json"
  printf '{}\n' > "$NTMP/package-lock.json"
  nout="$(
    eval "$(extract_core_nth "$CANONICAL_YAML" dprep "$occ")"
    cd "$NTMP" || exit 1
    PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps
  )"
  nrc=$?
  assert_eq "npm a occ$occ rc" "0" "$nrc"
  assert_eq "npm a occ$occ argv" "ci --no-audit --no-fund" "$(cat "$NREC")"
  assert_contains "npm a occ$occ log line" "dprep: npm ci (package-lock.json)" "$nout"
  assert_contains "npm a occ$occ install ok" "dprep: install ok (" "$nout"
  assert_eq "npm a occ$occ GH_TOKEN scrubbed" "GH_TOKEN=unset" "$(head -1 "$NENV")"
  assert_eq "npm a occ$occ bun not called" "" "$(cat "$NBREC")"
  assert_eq "npm a occ$occ pnpm not called" "" "$(cat "$NPREC")"
  if [ -d "$NTMP/node_modules" ]; then PASS=$((PASS + 1)); echo "PASS: npm a occ$occ node_modules exists"; else FAIL=$((FAIL + 1)); echo "FAIL: npm a occ$occ node_modules exists"; fi
  rm -rf "$NTMP"
done
assert_eq "npm a parent GH_TOKEN remains" "production-shaped-test-value" "${GH_TOKEN-unset}"

echo "--- npm b: bun.lock beside package-lock.json keeps the bun path ---"
nreset
NTMP="$(mktemp -d)"
printf '{}\n' > "$NTMP/package.json"
printf '{}\n' > "$NTMP/package-lock.json"
: > "$NTMP/bun.lock"
nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
assert_eq "npm b bun argv" "install --frozen-lockfile" "$(cat "$NBREC")"
assert_eq "npm b npm not called" "" "$(cat "$NREC")"
assert_contains "npm b bun line" "dprep: installing JS dependencies (bun install --frozen-lockfile)" "$nout"
rm -rf "$NTMP"

echo "--- npm c: pnpm-lock.yaml beside package-lock.json keeps the pnpm path ---"
nreset
NTMP="$(mktemp -d)"
printf '{}\n' > "$NTMP/package.json"
printf '{}\n' > "$NTMP/package-lock.json"
: > "$NTMP/pnpm-lock.yaml"
nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
assert_eq "npm c pnpm argv" "install --frozen-lockfile" "$(cat "$NPREC")"
assert_eq "npm c npm not called" "" "$(cat "$NREC")"
assert_contains "npm c pnpm line" "dprep: installing JS dependencies (pnpm, frozen lockfile)" "$nout"
rm -rf "$NTMP"

echo "--- npm d: node_modules present skips npm ---"
nreset
NTMP="$(mktemp -d)"
printf '{}\n' > "$NTMP/package.json"
printf '{}\n' > "$NTMP/package-lock.json"
mkdir -p "$NTMP/node_modules"
nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
assert_contains "npm d skip" "dprep: node_modules present, skipping" "$nout"
assert_eq "npm d npm not called" "" "$(cat "$NREC")"
rm -rf "$NTMP"

echo "--- npm e: no lockfile at all still skips; npm not called ---"
nreset
NTMP="$(mktemp -d)"
printf '{}\n' > "$NTMP/package.json"
nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
nrc=$?
assert_eq "npm e rc" "0" "$nrc"
assert_contains "npm e skip" "dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping" "$nout"
assert_eq "npm e npm not called" "" "$(cat "$NREC")"
rm -rf "$NTMP"

echo "--- npm f: a failed npm ci never fails the run ---"
nreset
cat > "$NBIN/npm" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$NREC"
exit 7
EOF
chmod +x "$NBIN/npm"
NTMP="$(mktemp -d)"
printf '{}\n' > "$NTMP/package.json"
printf '{}\n' > "$NTMP/package-lock.json"
nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
nrc=$?
assert_eq "npm f rc" "0" "$nrc"
assert_contains "npm f failed install continues" "dprep: install failed rc=7 (continuing" "$nout"
rm -rf "$NTMP"

echo "--- npm g: npm missing skips cleanly ---"
if [ -x /usr/bin/npm ] || [ -x /bin/npm ]; then
  echo "SKIP: npm g (npm is installed in /usr/bin or /bin on this host)"
else
  rm -f "$NBIN/npm"
  NTMP="$(mktemp -d)"
  printf '{}\n' > "$NTMP/package.json"
  printf '{}\n' > "$NTMP/package-lock.json"
  nout="$(cd "$NTMP" && PATH="$NBIN:/usr/bin:/bin" dprep_ensure_js_deps)"
  nrc=$?
  assert_eq "npm g rc" "0" "$nrc"
  assert_contains "npm g npm missing" "dprep: npm not found, skipping" "$nout"
  rm -rf "$NTMP"
fi

echo "--- dprep resolution: no /app, engine-materialized ARCHON_LANE_SCRIPTS_DIR copy installs (#1462 review) ---"
# Standalone CLI and source runs have no /app/scripts/lane/. The engine writes the
# bundled scripts/lane/*.sh into a per-node dir and exports ARCHON_LANE_SCRIPTS_DIR.
# Simulate that: copy dprep.sh into a fresh dir, unset BDC_DPREP_SCRIPT, run the
# real YAML stub at both call sites for bun, pnpm and npm lockfiles.
if [ -e /app/scripts/lane/dprep.sh ]; then
  echo "SKIP: dprep resolution (this host has /app/scripts/lane/dprep.sh)"
else
  RBINX="$(mktemp -d)"
  RLOG="$RBINX/calls.log"
  for pm in bun pnpm npm; do
    cat > "$RBINX/$pm" <<STUB
#!/usr/bin/env bash
printf '$pm %s\n' "\$*" >> "$RLOG"
mkdir -p node_modules
STUB
    chmod +x "$RBINX/$pm"
  done
  LANEDIR="$(mktemp -d)"
  cp "$DPREP_SHARED" "$LANEDIR/dprep.sh"
  for occ in 1 2; do
    for kind in bun:bun.lock pnpm:pnpm-lock.yaml npm:package-lock.json; do
      pm="${kind%%:*}"; lock="${kind#*:}"
      : > "$RLOG"
      RTMP="$(mktemp -d)"
      printf '{}\n' > "$RTMP/package.json"
      printf '{}\n' > "$RTMP/$lock"
      rout="$(
        unset -f dprep_ensure_js_deps dprep__install
        unset BDC_DPREP_SCRIPT
        export ARCHON_LANE_SCRIPTS_DIR="$LANEDIR"
        eval "$(extract_core_nth "$CANONICAL_YAML" dprep "$occ")"
        cd "$RTMP" || exit 1
        PATH="$RBINX:/usr/bin:/bin" dprep_ensure_js_deps
      )"
      rrc=$?
      assert_eq "resolve occ$occ $pm rc" "0" "$rrc"
      assert_eq "resolve occ$occ $pm called" "$pm" "$(cut -d' ' -f1 "$RLOG")"
      assert_contains "resolve occ$occ $pm install ok" "dprep: install ok (" "$rout"
      assert_not_contains "resolve occ$occ $pm no missing message" "dprep.sh missing" "$rout"
      if [ -d "$RTMP/node_modules" ]; then PASS=$((PASS + 1)); echo "PASS: resolve occ$occ $pm node_modules"; else FAIL=$((FAIL + 1)); echo "FAIL: resolve occ$occ $pm node_modules"; fi
      rm -rf "$RTMP"
    done
  done
  echo "--- dprep resolution: a stale BDC_DPREP_SCRIPT falls through to ARCHON_LANE_SCRIPTS_DIR ---"
  : > "$RLOG"
  RTMP="$(mktemp -d)"
  printf '{}\n' > "$RTMP/package.json"
  printf '{}\n' > "$RTMP/package-lock.json"
  rout="$(
    unset -f dprep_ensure_js_deps dprep__install
    export BDC_DPREP_SCRIPT="$RBINX/no-such-dir/dprep.sh"
    export ARCHON_LANE_SCRIPTS_DIR="$LANEDIR"
    eval "$(extract_core_nth "$CANONICAL_YAML" dprep 1)"
    cd "$RTMP" || exit 1
    PATH="$RBINX:/usr/bin:/bin" dprep_ensure_js_deps
  )"
  assert_eq "resolve fallthrough npm argv" "npm ci --no-audit --no-fund" "$(cat "$RLOG")"
  assert_not_contains "resolve fallthrough no missing message" "dprep.sh missing" "$rout"
  rm -rf "$RTMP" "$RBINX" "$LANEDIR"
fi

echo "--- dprep guard: missing message fires only when no resolution works ---"
if [ -e /app/scripts/lane/dprep.sh ]; then
  echo "SKIP: dprep guard (this host has /app/scripts/lane/dprep.sh)"
else
  for occ in 1 2; do
    gout="$(
      unset -f dprep_ensure_js_deps dprep__install
      export BDC_DPREP_SCRIPT="$NBIN/no-such-dir/dprep.sh"
      export ARCHON_LANE_SCRIPTS_DIR="$NBIN/no-such-lane-dir"
      eval "$(extract_core_nth "$CANONICAL_YAML" dprep "$occ")"
      dprep_ensure_js_deps
    )"
    grc=$?
    assert_eq "guard occ$occ rc" "0" "$grc"
    assert_contains "guard occ$occ message" "dprep: dprep.sh missing (tried BDC_DPREP_SCRIPT=$NBIN/no-such-dir/dprep.sh, ARCHON_LANE_SCRIPTS_DIR=$NBIN/no-such-lane-dir, /app/scripts/lane/dprep.sh)" "$gout"
  done
  gout="$(
    unset -f dprep_ensure_js_deps dprep__install
    unset BDC_DPREP_SCRIPT ARCHON_LANE_SCRIPTS_DIR
    eval "$(extract_core_nth "$CANONICAL_YAML" dprep 1)"
    dprep_ensure_js_deps
  )"
  assert_contains "guard all-unset message" "dprep: dprep.sh missing (tried BDC_DPREP_SCRIPT=unset, ARCHON_LANE_SCRIPTS_DIR=unset, /app/scripts/lane/dprep.sh)" "$gout"
fi
rm -rf "$NBIN"

echo "--- resolve-test-command: origin URL forms map to the right project entry ---"
# Fix A3 second defect: TESTS_MAP_FALLBACK=invalid-origin. Cauldron clones embed the
# token in origin (packages/core/src/handlers/clone.ts: https://<token>@github.com/...),
# which the old normalize() regex rejected. Extract the real node bash and run it with
# a stub gh serving a fixture project map.
RTC_BASH="$(tr -d '\r' < "$CANONICAL_YAML" | awk '
  $0 == "  - id: resolve-test-command" { n = 1; next }
  n && /^  - id: / { exit }
  n && $0 == "    bash: |" { b = 1; next }
  b
' | sed 's/^      //')"
if [ -z "$RTC_BASH" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: could not extract resolve-test-command bash"
fi
for lane in $LANES; do
  lane_rtc="$(tr -d '\r' < "$DEFAULTS/$lane" | awk '
    $0 == "  - id: resolve-test-command" { n = 1; next }
    n && /^  - id: / { exit }
    n && $0 == "    bash: |" { b = 1; next }
    b
  ' | sed 's/^      //')"
  assert_eq "resolve-test-command parity $lane" "$RTC_BASH" "$lane_rtc"
done
RBIN="$(mktemp -d)"
RMAP_JSON='{"comicstoreos-provisioner":{"repo":"thinmansoftware/comicstoreos-provisioner","test_command":"npm test"},"shopops-storefront":{"repo":"thinmansoftware/shopops-storefront","test_command":"bun test lib"},"fuelglass":{"repo":"https://github.com/thinmansoftware/fuelglass.git","test_command":"npm run fuel-test"}}'
printf '{"sha":"%s","content":"%s"}\n' "0123456789abcdef0123456789abcdef01234567" "$(printf '%s' "$RMAP_JSON" | base64 | tr -d '\n')" > "$RBIN/envelope.json"
cat > "$RBIN/gh" <<EOF
#!/usr/bin/env bash
cat "$RBIN/envelope.json"
EOF
chmod +x "$RBIN/gh"
rtc_run() {
  # rtc_run <origin url or empty>: run the node in a temp repo with that origin.
  local repo
  repo="$(mktemp -d)"
  (
    export PATH="$RBIN:$ORIG_PATH"
    cd "$repo" || exit 1
    git init -q .
    if [ -n "$1" ]; then git remote add origin "$1"; fi
    bash -c "$RTC_BASH"
  )
  rm -rf "$repo"
}
rtc_field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; }
rtc_expect() {
  # rtc_expect <label> <origin> <source> <fallback> <command>
  local out
  out="$(rtc_run "$2")"
  assert_eq "rtc $1 source" "$3" "$(rtc_field TEST_COMMAND_SOURCE "$out")"
  assert_eq "rtc $1 fallback" "$4" "$(rtc_field TEST_COMMAND_FALLBACK "$out")"
  assert_eq "rtc $1 command" "$5" "$(rtc_field TEST_COMMAND_B64 "$out" | base64 --decode 2>/dev/null)"
  assert_not_contains "rtc $1 no credential echoed" "fake-token-value" "$out"
}
P=thinmansoftware/comicstoreos-provisioner
rtc_expect "token userinfo .git" "https://fake-token-value@github.com/$P.git" project-map "" "npm test"
rtc_expect "x-access-token userinfo" "https://x-access-token:fake-token-value@github.com/$P.git" project-map "" "npm test"
rtc_expect "plain https .git" "https://github.com/$P.git" project-map "" "npm test"
rtc_expect "plain https no suffix" "https://github.com/$P" project-map "" "npm test"
rtc_expect "plain https trailing slash" "https://github.com/$P/" project-map "" "npm test"
rtc_expect "scp ssh form" "git@github.com:$P.git" project-map "" "npm test"
rtc_expect "ssh url form" "ssh://git@github.com/$P.git" project-map "" "npm test"
rtc_expect "mixed case" "https://github.com/ThinmanSoftware/ComicStoreOS-Provisioner.git" project-map "" "npm test"
rtc_expect "picks storefront not provisioner" "https://fake-token-value@github.com/thinmansoftware/shopops-storefront.git" project-map "" "bun test lib"
rtc_expect "map repo in url form" "https://x-access-token:fake-token-value@github.com/thinmansoftware/fuelglass" project-map "" "npm run fuel-test"
rtc_expect "unknown github repo" "https://github.com/thinmansoftware/not-in-map.git" wo-spec missing ""
rtc_expect "local path origin" "/opt/archon/workspaces/x/source" wo-spec invalid-origin ""
rtc_expect "non-github host" "https://fake-token-value@gitlab.com/$P.git" wo-spec invalid-origin ""
rtc_expect "no origin" "" wo-spec invalid-origin ""
rm -rf "$RBIN"

unset RST_NPX_BIN RST_NPM_BIN GH_TOKEN
unset TELEGRAM_BOT_TOKEN TELEGRAM_STREAMING_MODE TELEGRAM_APPROVAL_CHAT_ID TELEGRAM_ALLOWED_USER_IDS TELEGRAM_TEST_FIXTURE
export PATH="$ORIG_PATH"
rm -rf "$BIN" "$TMP" "$TMP2" "$TMP3" "$TMP4" "$TMP5" "$TMP6" "$TMP7" "$RST_TG" "$T5" "$T6_EMPTY" "$PBIN" "$PTMP" "$PTMPB" "$PTMPC" "$PTMPD"

# ---------------------------------------------------------------------------
# WO-HARNESS-STOP-TESTS-BASE-RED-AWARE-01: base-red aware stop tests.
# rst_base_compare / stb_stamp_base_red live in scripts/lane/stop-tests-base.sh; every
# lane sources it through the stbase stub (run-stop-tests and stamp-manifest-evidence).
# Fixtures are real temporary git repos with a base commit and a head commit; the base
# run happens in a real detached worktree.
# ---------------------------------------------------------------------------
STBASE_SHARED="$REPO_ROOT/scripts/lane/stop-tests-base.sh"
if [ ! -f "$STBASE_SHARED" ]; then
  echo "FATAL: shared stop-tests-base script missing at $STBASE_SHARED"; exit 1
fi
export BDC_STBASE_SCRIPT="$STBASE_SHARED"
STBASE_CORE="$(extract_core_nth "$CANONICAL_YAML" stbase 1)"
if [ -z "$STBASE_CORE" ]; then
  echo "FATAL: could not extract stbase core from $CANONICAL_YAML"; exit 1
fi
eval "$STBASE_CORE"
for fn in rst_base_compare stb_stamp_base_red stb_failed_ids; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after sourcing stbase"; exit 1; fi
done

# stb_fixture <dir> <base-fails> <head-fails> [base-only-file]
#   Real git repo: tests.txt lines "<file>|<name>" (default s.test.ts|A..D, or
#   $STB_TESTS); a fail entry without "|" means s.test.ts. run.sh prints a bun-style
#   "<file>:" header per file and "(pass)/(fail) suite > <name>" lines (or, when
#   plain.txt exists, only a "Passed: Failed: Total:" summary with no per-test
#   markers) and exits 1 on any failure. crash.sh exits 2 with no counts when crash.txt
#   exists ($STB_HEAD_CRASH=1 adds it on head only), else prints "1 pass". The base
#   commit carries .base-marker (run.sh touches $STB_MARK when it runs at base) plus an
#   optional extra base-only file; the head commit removes both and changes fails.txt.
#   Prints the base sha.
stb_fixture() {
  local dir="$1" bfails="$2" hfails="$3" extra="${4:-}"
  (
    cd "$dir" || exit 1
    git init -q . && git config user.email t@t && git config user.name t && git config core.autocrlf false
    printf '%b' "${STB_TESTS:-s.test.ts|A\ns.test.ts|B\ns.test.ts|C\ns.test.ts|D\n}" > tests.txt
    cat > crash.sh <<'CRASH'
#!/usr/bin/env bash
if [ -f crash.txt ]; then echo "Segmentation fault (core dumped)"; exit 2; fi
echo " 1 pass"
echo " 0 fail"
CRASH
    cat > run.sh <<'RUNSH'
#!/usr/bin/env bash
if [ -f .base-marker ] && [ -n "${STB_MARK:-}" ]; then : > "$STB_MARK"; fi
if [ -f slow.txt ]; then sleep "$(cat slow.txt)"; fi
p=0; f=0; cur=""
while IFS='|' read -r file n; do
  [ -z "$n" ] && continue
  if [ "$file" != "$cur" ]; then [ -f plain.txt ] || echo "$file:"; cur="$file"; fi
  if grep -qxF "$file|$n" fails.txt 2>/dev/null; then
    [ -f plain.txt ] || echo "(fail) suite > $n [0.10ms]"
    f=$((f + 1))
  else
    [ -f plain.txt ] || echo "(pass) suite > $n [0.05ms]"
    p=$((p + 1))
  fi
done < tests.txt
if [ -f plain.txt ]; then
  echo "Passed: $p  Failed: $f  Total: $((p + f))"
else
  echo " $p pass"
  echo " $f fail"
fi
[ "$f" -eq 0 ]
RUNSH
    printf '%b' "$bfails" | sed '/^$/d; /|/!s/^/s.test.ts|/' > fails.txt
    : > .base-marker
    if [ -n "$extra" ]; then printf '%s\n' "$extra" > "${extra%%=*}.txt"; sed -i 's/^[^=]*=//' "${extra%%=*}.txt"; fi
    git add -A && git commit -q -m base
    git rev-parse HEAD > ../base.sha
    printf '%b' "$hfails" | sed '/^$/d; /|/!s/^/s.test.ts|/' > fails.txt
    if [ "${STB_HEAD_CRASH:-0}" = "1" ]; then : > crash.txt; fi
    git rm -q .base-marker
    case "$extra" in slow=*) git rm -q slow.txt ;; esac
    git add -A && git commit -q -m head
  ) || return 1
  cat "$dir/../base.sha"
}

# stb_head <repo> <art>   runs the head commands with the real rst core, writes
#   <art>/report and sets STB_COUNTS.
stb_head() {
  local repo="$1" art="$2" res ex cmdline
  printf '%b' "${STB_CMDS:-bash ./run.sh\n}" > "$art/cmds"
  cmdline="$(grep -v '^$' "$art/cmds" | paste -sd ';' - | sed 's/;/; /g')"
  : > "$art/head.log"
  res="$(cd "$repo" && rst_run_commands "$art/cmds" "$art/head.log")"
  ex="${res%% *}"
  STB_COUNTS="$(printf '%s' "${res#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  SOURCE=spec_declared rst_report CODE "$cmdline" "$ex" "$STB_COUNTS" | sed "s/^TESTS_LINE=.*/& [source: wo-spec]/" > "$art/report"
}

stb_field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; }
stb_wt_count() { git -C "$1" worktree list | grep -c .; }
stb_leftover() { find "$1" -maxdepth 1 -name 'stop-tests-base-wt.*' | grep -c . || true; }

STB_ROOT="$(mktemp -d)"

echo "--- Test 1: base_red_only_passes ---"
mkdir -p "$STB_ROOT/t1/repo" "$STB_ROOT/t1/art"
T1_SHA="$(stb_fixture "$STB_ROOT/t1/repo" 'A\nB\n' 'A\nB\n')"
echo "$T1_SHA" > "$STB_ROOT/t1/art/run-start-sha.txt"
stb_head "$STB_ROOT/t1/repo" "$STB_ROOT/t1/art"
assert_eq "Test 1 base_red_only_passes: head is failed before the compare" "failed" "$(stb_field TESTS_STATUS "$(cat "$STB_ROOT/t1/art/report")")"
T1_OUT="$(cd "$STB_ROOT/t1/repo" && STB_MARK="$STB_ROOT/t1/mark" ARTIFACTS_DIR="$STB_ROOT/t1/art" rst_base_compare "$STB_ROOT/t1/art/report" "$STB_ROOT/t1/art/cmds" "$STB_ROOT/t1/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 1 base_red_only_passes: TESTS_STATUS=base_red" "base_red" "$(stb_field TESTS_STATUS "$T1_OUT")"
assert_eq "Test 1 base_red_only_passes: TESTS_LINE starts <pass>/<total> with newly broken: 0" \
  "2/4 (base-red: 2 tests failing on base $(printf '%s' "$T1_SHA" | cut -c1-8); newly broken: 0) (bash ./run.sh) [source: wo-spec]" \
  "$(stb_field TESTS_LINE "$T1_OUT")"
assert_eq "Test 1 base_red_only_passes: outcome" "base_red" "$(stb_field TESTS_BASE_COMPARE "$T1_OUT")"
assert_eq "Test 1 base_red_only_passes: base-red-tests.txt lists A and B" "$(printf 's.test.ts :: suite > A\ns.test.ts :: suite > B')" "$(cat "$STB_ROOT/t1/art/base-red-tests.txt" 2>/dev/null)"
assert_eq "Test 1 base_red_only_passes: the base commit really ran" "yes" "$([ -f "$STB_ROOT/t1/mark" ] && echo yes || echo no)"
assert_eq "Test 1 base_red_only_passes: temporary worktree removed" "1 0" "$(stb_wt_count "$STB_ROOT/t1/repo") $(stb_leftover "$STB_ROOT/t1/art")"
assert_contains "Test 1 base_red_only_passes: base log kept as evidence" "(fail) suite > A" "$(cat "$STB_ROOT/t1/art/evidence/stop-tests-base.log" 2>/dev/null)"

echo "--- Test 1 (end to end): the rendered run-stop-tests node of the canonical lane ---"
# Render the real node bash: the engine substitutes $read-spec.output and
# $resolve-test-command.output; here the spec comes from a file and no map resolves.
stb_render_node() {
  tr -d '\r' < "$CANONICAL_YAML" | awk '
    $0 == "  - id: run-stop-tests" { n = 1; next }
    n && $0 == "    bash: |" { b = 1; next }
    b && $0 != "" && substr($0, 1, 6) != "      " { exit }
    b { print }
  ' | sed 's/^      //' \
    | sed 's/^SPEC=\$read-spec\.output$/SPEC="$(cat "$STB_SPEC_FILE")"/; s/^\$resolve-test-command\.output$//'
}
STB_NODE="$STB_ROOT/run-stop-tests-node.sh"
stb_render_node > "$STB_NODE"
assert_eq "rendered node calls rst_base_compare once" "1" "$(grep -c '^rst_base_compare ' "$STB_NODE")"
STB_SPEC_FILE="$STB_ROOT/spec.md"
printf 'WO Class: CODE\n\n## 8. Stop conditions\n\nStop 2 (test suite):\n  bash ./run.sh\n  Expected: all pass\n' > "$STB_SPEC_FILE"
export STB_SPEC_FILE
mkdir -p "$STB_ROOT/e1/repo" "$STB_ROOT/e1/art"
E1_SHA="$(stb_fixture "$STB_ROOT/e1/repo" 'A\nB\n' 'A\nB\n')"
echo "$E1_SHA" > "$STB_ROOT/e1/art/run-start-sha.txt"
E1_OUT="$(cd "$STB_ROOT/e1/repo" && STB_MARK="$STB_ROOT/e1/mark" ARTIFACTS_DIR="$STB_ROOT/e1/art" bash "$STB_NODE" 2>/dev/null)"
assert_eq "Test 1 base_red_only_passes (node): TESTS_STATUS=base_red" "base_red" "$(stb_field TESTS_STATUS "$E1_OUT")"
assert_contains "Test 1 base_red_only_passes (node): TESTS_LINE" "TESTS_LINE=2/4 (base-red: 2 tests failing on base $(printf '%s' "$E1_SHA" | cut -c1-8); newly broken: 0)" "$E1_OUT"
assert_eq "Test 1 base_red_only_passes (node): base-red-tests.txt" "$(printf 's.test.ts :: suite > A\ns.test.ts :: suite > B')" "$(cat "$STB_ROOT/e1/art/base-red-tests.txt" 2>/dev/null)"
assert_eq "Test 1 base_red_only_passes (node): worktree removed" "1 0" "$(stb_wt_count "$STB_ROOT/e1/repo") $(stb_leftover "$STB_ROOT/e1/art")"

echo "--- Test 2: newly_broken_fails ---"
mkdir -p "$STB_ROOT/t2/repo" "$STB_ROOT/t2/art"
T2_SHA="$(stb_fixture "$STB_ROOT/t2/repo" 'A\n' 'A\nC\n')"
echo "$T2_SHA" > "$STB_ROOT/t2/art/run-start-sha.txt"
stb_head "$STB_ROOT/t2/repo" "$STB_ROOT/t2/art"
T2_OUT="$(cd "$STB_ROOT/t2/repo" && STB_MARK="$STB_ROOT/t2/mark" ARTIFACTS_DIR="$STB_ROOT/t2/art" rst_base_compare "$STB_ROOT/t2/art/report" "$STB_ROOT/t2/art/cmds" "$STB_ROOT/t2/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 2 newly_broken_fails: TESTS_STATUS=failed" "failed" "$(stb_field TESTS_STATUS "$T2_OUT")"
assert_eq "Test 2 newly_broken_fails: TESTS_LINE names C as newly broken" "2/4 (bash ./run.sh) -- FAILED, exit 1; newly broken: s.test.ts :: suite > C [source: wo-spec]" "$(stb_field TESTS_LINE "$T2_OUT")"
assert_eq "Test 2 newly_broken_fails: outcome" "newly_broken" "$(stb_field TESTS_BASE_COMPARE "$T2_OUT")"
assert_eq "Test 2 newly_broken_fails: no base-red-tests.txt" "no" "$([ -e "$STB_ROOT/t2/art/base-red-tests.txt" ] && echo yes || echo no)"
assert_eq "Test 2 newly_broken_fails: the base commit really ran" "yes" "$([ -f "$STB_ROOT/t2/mark" ] && echo yes || echo no)"
assert_eq "Test 2 newly_broken_fails: worktree removed" "1 0" "$(stb_wt_count "$STB_ROOT/t2/repo") $(stb_leftover "$STB_ROOT/t2/art")"

echo "--- Test 2b: newly_broken_fails when base is fully green ---"
mkdir -p "$STB_ROOT/t2b/repo" "$STB_ROOT/t2b/art"
stb_fixture "$STB_ROOT/t2b/repo" '' 'A\n' > "$STB_ROOT/t2b/art/run-start-sha.txt"
stb_head "$STB_ROOT/t2b/repo" "$STB_ROOT/t2b/art"
T2B_OUT="$(cd "$STB_ROOT/t2b/repo" && ARTIFACTS_DIR="$STB_ROOT/t2b/art" rst_base_compare "$STB_ROOT/t2b/art/report" "$STB_ROOT/t2b/art/cmds" "$STB_ROOT/t2b/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 2b newly_broken_fails (green base): TESTS_STATUS=failed" "failed" "$(stb_field TESTS_STATUS "$T2B_OUT")"
assert_contains "Test 2b newly_broken_fails (green base): newly broken A" "newly broken: s.test.ts :: suite > A" "$(stb_field TESTS_LINE "$T2B_OUT")"
assert_eq "Test 2b newly_broken_fails (green base): outcome" "base_passed" "$(stb_field TESTS_BASE_COMPARE "$T2B_OUT")"

echo "--- Test 3: unparseable_fails_closed ---"
mkdir -p "$STB_ROOT/t3/repo" "$STB_ROOT/t3/art"
T3_SHA="$(stb_fixture "$STB_ROOT/t3/repo" 'A\nB\n' 'A\nB\n' 'plain=1')"
echo "$T3_SHA" > "$STB_ROOT/t3/art/run-start-sha.txt"
stb_head "$STB_ROOT/t3/repo" "$STB_ROOT/t3/art"
assert_eq "Test 3 unparseable_fails_closed: head counts parsed from the summary" "2 4" "$STB_COUNTS"
T3_OUT="$(cd "$STB_ROOT/t3/repo" && ARTIFACTS_DIR="$STB_ROOT/t3/art" rst_base_compare "$STB_ROOT/t3/art/report" "$STB_ROOT/t3/art/cmds" "$STB_ROOT/t3/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 3 unparseable_fails_closed: TESTS_STATUS=failed" "failed" "$(stb_field TESTS_STATUS "$T3_OUT")"
assert_eq "Test 3 unparseable_fails_closed: report unchanged" "$(cat "$STB_ROOT/t3/art/report")" "$(printf '%s\n' "$T3_OUT" | grep -v '^TESTS_BASE_COMPARE=')"
assert_eq "Test 3 unparseable_fails_closed: outcome" "unparsed" "$(stb_field TESTS_BASE_COMPARE "$T3_OUT")"
assert_eq "Test 3 unparseable_fails_closed: no base-red-tests.txt" "no" "$([ -e "$STB_ROOT/t3/art/base-red-tests.txt" ] && echo yes || echo no)"
assert_eq "Test 3 unparseable_fails_closed: no worktree left" "1 0" "$(stb_wt_count "$STB_ROOT/t3/repo") $(stb_leftover "$STB_ROOT/t3/art")"
assert_eq "Test 3 unparseable_fails_closed: no ids from marker-free output" "" "$(printf 'Passed: 2  Failed: 2  Total: 4\nerror: something\n' | stb_failed_ids)"

echo "--- Test 3b: failing-id parser (bun, node:test, jest, vitest) ---"
STB_BULLET="$(printf '\342\227\217')"
STB_TAB="$(printf '\t')"
assert_eq "Test 3b ids bun headers, timing, filter prefix, recap skipped" \
  "$(printf '@archon/workflows :: src/a.test.ts\tsuite > x\nsrc/b.test.ts\tsuite > y')" \
  "$(printf '@archon/workflows:test | src/a.test.ts:\n@archon/workflows:test | (fail) suite > x [12.50ms]\n::group::src/b.test.ts:\n(fail) suite > y\n(pass) suite > z [1ms]\n::endgroup::\n2 tests failed:\n(fail) suite > x\n(fail) suite > y\n' | stb_failed_ids)"
assert_eq "Test 3b ids bun without a file header are unattributed" "${STB_TAB}suite > y" "$(printf '(fail) suite > y\n' | stb_failed_ids)"
assert_eq "Test 3b ids node:test file subtest, TODO and the file line are not tests" \
  "$(printf 'tests/a.test.js\tadds\ntests/a.test.js\tnested sub')" \
  "$(printf '# Subtest: tests/a.test.js\n    not ok 1 - adds\n    not ok 2 - nested sub\n    not ok 3 - later # TODO not yet\nnot ok 1 - tests/a.test.js\n' | stb_failed_ids)"
assert_eq "Test 3b ids jest FAIL file then bullet; summary repeat skipped" "$(printf 'src/a.test.js\tSuite x')" \
  "$(printf 'FAIL src/a.test.js\n  %s Suite x\nSummary of all failing tests\nFAIL src/a.test.js\n  %s Suite x\n' "$STB_BULLET" "$STB_BULLET" | stb_failed_ids)"
assert_eq "Test 3b ids vitest FAIL line carries the file" "$(printf 'src/a.test.ts\tsuite > t')" "$(printf ' FAIL  src/a.test.ts > suite > t\n' | stb_failed_ids)"

echo "--- Test 4: base_timeout_or_missing_sha_fails_closed ---"
mkdir -p "$STB_ROOT/t4/repo" "$STB_ROOT/t4/art"
stb_fixture "$STB_ROOT/t4/repo" 'A\n' 'A\n' > /dev/null
stb_head "$STB_ROOT/t4/repo" "$STB_ROOT/t4/art"
T4_OUT="$(cd "$STB_ROOT/t4/repo" && STB_MARK="$STB_ROOT/t4/mark" ARTIFACTS_DIR="$STB_ROOT/t4/art" rst_base_compare "$STB_ROOT/t4/art/report" "$STB_ROOT/t4/art/cmds" "$STB_ROOT/t4/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: missing sha -> failed" "failed" "$(stb_field TESTS_STATUS "$T4_OUT")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: missing sha outcome" "no_base_sha" "$(stb_field TESTS_BASE_COMPARE "$T4_OUT")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: missing sha never ran base" "no" "$([ -f "$STB_ROOT/t4/mark" ] && echo yes || echo no)"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: missing sha leaves no worktree" "1 0" "$(stb_wt_count "$STB_ROOT/t4/repo") $(stb_leftover "$STB_ROOT/t4/art")"
echo "not-a-commit-0000" > "$STB_ROOT/t4/art/run-start-sha.txt"
T4C_OUT="$(cd "$STB_ROOT/t4/repo" && ARTIFACTS_DIR="$STB_ROOT/t4/art" rst_base_compare "$STB_ROOT/t4/art/report" "$STB_ROOT/t4/art/cmds" "$STB_ROOT/t4/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: bad sha -> failed" "failed no_base_sha" "$(stb_field TESTS_STATUS "$T4C_OUT") $(stb_field TESTS_BASE_COMPARE "$T4C_OUT")"

# Base run timeout: the real timeout binary, shortened to 3 s by a PATH wrapper; the
# base commit sleeps 20 s (slow.txt exists on base only), the head commit does not.
mkdir -p "$STB_ROOT/t4t/repo" "$STB_ROOT/t4t/art" "$STB_ROOT/t4t/bin"
stb_fixture "$STB_ROOT/t4t/repo" 'A\n' 'A\n' 'slow=20' > "$STB_ROOT/t4t/art/run-start-sha.txt"
STB_REAL_TIMEOUT="$(command -v timeout)"
printf '#!/usr/bin/env bash\nshift\nexec "%s" 3 "$@"\n' "$STB_REAL_TIMEOUT" > "$STB_ROOT/t4t/bin/timeout"
chmod +x "$STB_ROOT/t4t/bin/timeout"
stb_head "$STB_ROOT/t4t/repo" "$STB_ROOT/t4t/art"
T4T_START="$(date +%s)"
T4T_OUT="$(cd "$STB_ROOT/t4t/repo" && PATH="$STB_ROOT/t4t/bin:$PATH" STB_MARK="$STB_ROOT/t4t/mark" ARTIFACTS_DIR="$STB_ROOT/t4t/art" rst_base_compare "$STB_ROOT/t4t/art/report" "$STB_ROOT/t4t/art/cmds" "$STB_ROOT/t4t/art/head.log" "$STB_COUNTS" 2>/dev/null)"
T4T_ELAPSED=$(( $(date +%s) - T4T_START ))
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: timeout -> failed" "failed" "$(stb_field TESTS_STATUS "$T4T_OUT")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: timeout outcome" "base_timeout" "$(stb_field TESTS_BASE_COMPARE "$T4T_OUT")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: base did start" "yes" "$([ -f "$STB_ROOT/t4t/mark" ] && echo yes || echo no)"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: timed out well before the 20 s sleep" "yes" "$([ "$T4T_ELAPSED" -lt 18 ] && echo yes || echo "no ($T4T_ELAPSED s)")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: timeout worktree removed" "1 0" "$(stb_wt_count "$STB_ROOT/t4t/repo") $(stb_leftover "$STB_ROOT/t4t/art")"
assert_eq "Test 4 base_timeout_or_missing_sha_fails_closed: no base-red-tests.txt" "no" "$([ -e "$STB_ROOT/t4t/art/base-red-tests.txt" ] && echo yes || echo no)"

echo "--- Test 5: manifest_records_base_red ---"
SME_CORE="$(extract_core "$CANONICAL_YAML" sme)"
MEC_CORE="$(extract_core "$CANONICAL_YAML" mec)"
mkdir -p "$STB_ROOT/t5"
printf 'suite > A\nsuite > B\n' > "$STB_ROOT/t5/base-red-tests.txt"
T5_MANIFEST="$(printf 'WO: WO-X\nBuilder: Major Build\nTests: <pass>/<total>\nGrep assertions: <x>\nVALIDATION: PASS\n')"
T5_LINE="8144/8146 (base-red: 2 tests failing on base abcd1234; newly broken: 0) (bun run test) [source: wo-spec]"
T5_STAMPED="$( eval "$SME_CORE"; printf '%s\n' "$T5_MANIFEST" | sme_process "$T5_LINE" base_red "grep -c x f => 1" passed 0 | ARTIFACTS_DIR="$STB_ROOT/t5" stb_stamp_base_red )"
assert_contains "Test 5 manifest_records_base_red: Base-red tests: line with both names" "Base-red tests: suite > A; suite > B" "$T5_STAMPED"
assert_eq "Test 5 manifest_records_base_red: Base-red line follows Tests:" "Base-red tests:" "$(printf '%s\n' "$T5_STAMPED" | awk '/^Tests:/ { getline; print substr($0, 1, 15); exit }')"
assert_contains "Test 5 manifest_records_base_red: VALIDATION stays PASS" "VALIDATION: PASS" "$T5_STAMPED"
assert_not_contains "Test 5 manifest_records_base_red: VALIDATION not FAIL" "VALIDATION: FAIL" "$T5_STAMPED"
T5_MEC="$( eval "$MEC_CORE"; printf '%s\n' "$T5_STAMPED" | mec_check PROCEED CODE base_red 1 passed 1 1 0 0 0 "" 2>&1; echo "rc=$?" )"
assert_eq "Test 5 manifest_records_base_red: manifest-evidence-check passes" "$(printf 'OK\nrc=0')" "$T5_MEC"
# Controls: the same manifest with a failed head is FAIL and blocked; no file -> no line.
T5_FAIL="$( eval "$SME_CORE"; printf '%s\n' "$T5_MANIFEST" | sme_process "6/8 (bun run test) -- FAILED, exit 1" failed "grep -c x f => 1" passed 0 | ARTIFACTS_DIR="$STB_ROOT/t5-none" stb_stamp_base_red )"
assert_contains "Test 5 control: failed tests still stamp VALIDATION: FAIL" "VALIDATION: FAIL" "$T5_FAIL"
assert_not_contains "Test 5 control: no base-red file, no Base-red line" "Base-red tests:" "$T5_FAIL"
T5_FMEC="$( eval "$MEC_CORE"; printf '%s\n' "$T5_FAIL" | mec_check PROCEED CODE failed 1 passed 1 1 0 0 0 "" >/dev/null 2>&1; echo "rc=$?" )"
assert_eq "Test 5 control: manifest-evidence-check blocks failed" "rc=1" "$T5_FMEC"
assert_eq "Test 5 control: short-form manifest passes through" "BLOCKED: x" "$(printf 'BLOCKED: x\n' | ARTIFACTS_DIR="$STB_ROOT/t5" stb_stamp_base_red)"

echo "--- Test 6: passing_head_never_runs_base ---"
mkdir -p "$STB_ROOT/t6/repo" "$STB_ROOT/t6/art"
stb_fixture "$STB_ROOT/t6/repo" 'A\n' '' > "$STB_ROOT/t6/art/run-start-sha.txt"
printf 'stale\n' > "$STB_ROOT/t6/art/base-red-tests.txt"
T6_OUT="$(cd "$STB_ROOT/t6/repo" && STB_MARK="$STB_ROOT/t6/mark" ARTIFACTS_DIR="$STB_ROOT/t6/art" bash "$STB_NODE" 2>/dev/null)"
assert_eq "Test 6 passing_head_never_runs_base: TESTS_STATUS=passed" "passed" "$(stb_field TESTS_STATUS "$T6_OUT")"
assert_eq "Test 6 passing_head_never_runs_base: TESTS_LINE unchanged" "4/4 (bash ./run.sh) [source: wo-spec]" "$(stb_field TESTS_LINE "$T6_OUT")"
assert_eq "Test 6 passing_head_never_runs_base: outcome" "not_failed" "$(stb_field TESTS_BASE_COMPARE "$T6_OUT")"
assert_eq "Test 6 passing_head_never_runs_base: base never ran" "no" "$([ -f "$STB_ROOT/t6/mark" ] && echo yes || echo no)"
assert_eq "Test 6 passing_head_never_runs_base: no base worktree created" "1 0" "$(stb_wt_count "$STB_ROOT/t6/repo") $(stb_leftover "$STB_ROOT/t6/art")"
assert_eq "Test 6 passing_head_never_runs_base: no base log" "no" "$([ -e "$STB_ROOT/t6/art/evidence/stop-tests-base.log" ] && echo yes || echo no)"
assert_eq "Test 6 passing_head_never_runs_base: stale base-red-tests.txt cleared" "no" "$([ -e "$STB_ROOT/t6/art/base-red-tests.txt" ] && echo yes || echo no)"

echo "--- Test 8: crash_without_counts_fails_closed ---"
# Two commands. run.sh reports one named failure that is also red on base; crash.sh
# passes on base and newly crashes on head with no counts. Aggregated counts (3/4, one
# failure, one name) used to look complete; per command, crash.sh has no evidence.
mkdir -p "$STB_ROOT/t8/repo" "$STB_ROOT/t8/art"
STB_HEAD_CRASH=1 stb_fixture "$STB_ROOT/t8/repo" 'A\n' 'A\n' > "$STB_ROOT/t8/art/run-start-sha.txt"
STB_CMDS='bash ./run.sh\nbash ./crash.sh\n' stb_head "$STB_ROOT/t8/repo" "$STB_ROOT/t8/art"
assert_eq "Test 8 crash_without_counts_fails_closed: aggregated head counts match the one name" "3 4" "$STB_COUNTS"
T8_OUT="$(cd "$STB_ROOT/t8/repo" && STB_MARK="$STB_ROOT/t8/mark" ARTIFACTS_DIR="$STB_ROOT/t8/art" rst_base_compare "$STB_ROOT/t8/art/report" "$STB_ROOT/t8/art/cmds" "$STB_ROOT/t8/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 8 crash_without_counts_fails_closed: TESTS_STATUS=failed" "failed" "$(stb_field TESTS_STATUS "$T8_OUT")"
assert_eq "Test 8 crash_without_counts_fails_closed: outcome" "unparsed" "$(stb_field TESTS_BASE_COMPARE "$T8_OUT")"
assert_eq "Test 8 crash_without_counts_fails_closed: no base-red-tests.txt" "no" "$([ -e "$STB_ROOT/t8/art/base-red-tests.txt" ] && echo yes || echo no)"
assert_eq "Test 8 crash_without_counts_fails_closed: no worktree left" "1 0" "$(stb_wt_count "$STB_ROOT/t8/repo") $(stb_leftover "$STB_ROOT/t8/art")"
# Control: the same two commands with no crash on head is base_red, named per command.
mkdir -p "$STB_ROOT/t8c/repo" "$STB_ROOT/t8c/art"
stb_fixture "$STB_ROOT/t8c/repo" 'A\n' 'A\n' > "$STB_ROOT/t8c/art/run-start-sha.txt"
STB_CMDS='bash ./run.sh\nbash ./crash.sh\n' stb_head "$STB_ROOT/t8c/repo" "$STB_ROOT/t8c/art"
T8C_OUT="$(cd "$STB_ROOT/t8c/repo" && ARTIFACTS_DIR="$STB_ROOT/t8c/art" rst_base_compare "$STB_ROOT/t8c/art/report" "$STB_ROOT/t8c/art/cmds" "$STB_ROOT/t8c/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 8 control: no crash -> base_red" "base_red" "$(stb_field TESTS_STATUS "$T8C_OUT")"
assert_eq "Test 8 control: base-red name carries the command index" "[cmd 1] s.test.ts :: suite > A" "$(cat "$STB_ROOT/t8c/art/base-red-tests.txt" 2>/dev/null)"

echo "--- Test 9: same_name_different_file_fails_closed ---"
# a.test.ts fails "adds correctly" on base; on head a.test.ts is fixed and b.test.ts
# newly fails a test with the same name. Identity is file + name, so it is new.
mkdir -p "$STB_ROOT/t9/repo" "$STB_ROOT/t9/art"
STB_TESTS='a.test.ts|adds correctly\na.test.ts|other\nb.test.ts|adds correctly\n' \
  stb_fixture "$STB_ROOT/t9/repo" 'a.test.ts|adds correctly\n' 'b.test.ts|adds correctly\n' > "$STB_ROOT/t9/art/run-start-sha.txt"
stb_head "$STB_ROOT/t9/repo" "$STB_ROOT/t9/art"
T9_OUT="$(cd "$STB_ROOT/t9/repo" && STB_MARK="$STB_ROOT/t9/mark" ARTIFACTS_DIR="$STB_ROOT/t9/art" rst_base_compare "$STB_ROOT/t9/art/report" "$STB_ROOT/t9/art/cmds" "$STB_ROOT/t9/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 9 same_name_different_file_fails_closed: TESTS_STATUS=failed" "failed" "$(stb_field TESTS_STATUS "$T9_OUT")"
assert_eq "Test 9 same_name_different_file_fails_closed: outcome" "newly_broken" "$(stb_field TESTS_BASE_COMPARE "$T9_OUT")"
assert_contains "Test 9 same_name_different_file_fails_closed: names b.test.ts" "newly broken: b.test.ts :: suite > adds correctly" "$(stb_field TESTS_LINE "$T9_OUT")"
assert_eq "Test 9 same_name_different_file_fails_closed: the base commit really ran" "yes" "$([ -f "$STB_ROOT/t9/mark" ] && echo yes || echo no)"
assert_eq "Test 9 same_name_different_file_fails_closed: no base-red-tests.txt" "no" "$([ -e "$STB_ROOT/t9/art/base-red-tests.txt" ] && echo yes || echo no)"
assert_eq "Test 9 same_name_different_file_fails_closed: worktree removed" "1 0" "$(stb_wt_count "$STB_ROOT/t9/repo") $(stb_leftover "$STB_ROOT/t9/art")"
# The same name failing twice inside one command is ambiguous: fail closed before base.
mkdir -p "$STB_ROOT/t9d/repo" "$STB_ROOT/t9d/art"
STB_TESTS='a.test.ts|adds correctly\nb.test.ts|adds correctly\n' \
  stb_fixture "$STB_ROOT/t9d/repo" 'a.test.ts|adds correctly\nb.test.ts|adds correctly\n' 'a.test.ts|adds correctly\nb.test.ts|adds correctly\n' > "$STB_ROOT/t9d/art/run-start-sha.txt"
stb_head "$STB_ROOT/t9d/repo" "$STB_ROOT/t9d/art"
T9D_OUT="$(cd "$STB_ROOT/t9d/repo" && STB_MARK="$STB_ROOT/t9d/mark" ARTIFACTS_DIR="$STB_ROOT/t9d/art" rst_base_compare "$STB_ROOT/t9d/art/report" "$STB_ROOT/t9d/art/cmds" "$STB_ROOT/t9d/art/head.log" "$STB_COUNTS" 2>/dev/null)"
assert_eq "Test 9 same_name_different_file_fails_closed: repeated name in one command -> failed unparsed" "failed unparsed" "$(stb_field TESTS_STATUS "$T9D_OUT") $(stb_field TESTS_BASE_COMPARE "$T9D_OUT")"
assert_eq "Test 9 same_name_different_file_fails_closed: repeated name never ran base" "no" "$([ -f "$STB_ROOT/t9d/mark" ] && echo yes || echo no)"

echo "--- Test 7: all_lanes_call_shared_script ---"
STB_CALL='rst_base_compare "$EVIDENCE_DIR/stop-tests.report" "$CMDS" "$LOG" "$COUNTS"'
STB_STAMP='"$(sme_field GREP_DROPPED "$GREPS_OUT")" | stb_stamp_base_red'
STB_N=0
for lane in $LANES; do
  STB_N=$((STB_N + 1))
  lf="$DEFAULTS/$lane"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane has 2 stbase stubs" "2" "$(grep -c 'BEGIN stbase core' "$lf")"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane stub 1 identical" "$STBASE_CORE" "$(extract_core_nth "$lf" stbase 1)"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane stub 2 identical" "$STBASE_CORE" "$(extract_core_nth "$lf" stbase 2)"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane one rst_base_compare call" "1" "$(tr -d '\r' < "$lf" | grep -cF "      $STB_CALL")"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane one stamp helper call" "1" "$(tr -d '\r' < "$lf" | grep -cF "$STB_STAMP")"
  assert_eq "Test 7 all_lanes_call_shared_script: $lane inlines no comparison logic" "0" "$(grep -cE 'stb_failed_ids|worktree add --detach|base-red-tests\.txt|comm -23' "$lf")"
done
assert_eq "Test 7 all_lanes_call_shared_script: 13 lanes checked" "13" "$STB_N"
STB_GEN="$REPO_ROOT/packages/workflows/src/defaults/bundled-defaults.generated.ts"
assert_eq "Test 7 all_lanes_call_shared_script: bundle carries stop-tests-base.sh" "1" "$(grep -c '"stop-tests-base.sh":' "$STB_GEN")"
if command -v bun >/dev/null 2>&1; then
  STB_CHECK="$(cd "$REPO_ROOT" && bun run scripts/generate-bundled-defaults.ts --check 2>&1)"; STB_CHECK_RC=$?
  assert_eq "Test 7 all_lanes_call_shared_script: bundle check passes" "0" "$STB_CHECK_RC"
else
  FAIL=$((FAIL + 1)); echo "FAIL: Test 7 all_lanes_call_shared_script: bun not on PATH, bundle check could not run"
fi

rm -rf "$STB_ROOT"
unset BDC_STBASE_SCRIPT STB_SPEC_FILE

echo
echo "run-stop-tests.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
