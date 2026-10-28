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
for fn in rst_class rst_extract_commands rst_command_looks_runnable rst_rescue_subdir rst_tests_in_diff rst_repo_test_script rst_parse_counts rst_scrub_env rst_run_commands rst_report rst_failing_names rst_base_pass rst_apply_verdict; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

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
  rst_dep="$(awk '
    $0 ~ /^  - id: run-stop-tests$/ { hit = 1; next }
    hit && $0 ~ /^    depends_on:/ { print; exit }
    hit && $0 ~ /^  - id: / { exit }
  ' "$DEFAULTS/$lane")"
  expected_dep="    depends_on: [format-autofix, resolve-test-command, resolve-review-base]"
  assert_eq "run-stop-tests depends_on $lane" "$expected_dep" "$rst_dep"
  rst_timeout="$(awk '
    $0 ~ /^  - id: run-stop-tests$/ { hit = 1; next }
    hit && $0 ~ /^    timeout:/ { print; exit }
    hit && $0 ~ /^  - id: / { exit }
  ' "$DEFAULTS/$lane")"
  assert_eq "run-stop-tests timeout $lane" "    timeout: 3600000" "$rst_timeout"
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
assert_contains "test2 no lock" "dprep: no package.json with a bun lockfile, skipping" "$out"
TMP3="$(mktemp -d)"
out="$(cd "$TMP3" && dprep_ensure_js_deps)"
rc=$?
assert_eq "test2 empty rc" "0" "$rc"
assert_contains "test2 empty dir" "dprep: no package.json with a bun lockfile, skipping" "$out"
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
assert_contains "t6 dprep skip path" "dprep: no package.json with a bun lockfile, skipping" "$(printf '%s\n' "$T6" | sed -n '5p')"

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
assert_contains "pnpm b skip" "dprep: no package.json with a bun lockfile, skipping" "$poutb"
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

unset RST_NPX_BIN RST_NPM_BIN GH_TOKEN
unset TELEGRAM_BOT_TOKEN TELEGRAM_STREAMING_MODE TELEGRAM_APPROVAL_CHAT_ID TELEGRAM_ALLOWED_USER_IDS TELEGRAM_TEST_FIXTURE
export PATH="$ORIG_PATH"
rm -rf "$BIN" "$TMP" "$TMP2" "$TMP3" "$TMP4" "$TMP5" "$TMP6" "$TMP7" "$RST_TG" "$T5" "$T6_EMPTY" "$PBIN" "$PTMP" "$PTMPB" "$PTMPC" "$PTMPD"

# --- baseline vs head (WO-HARNESS-EVIDENCE-BASE-VS-HEAD-TEST-DIFF-01) ---
eval "$(extract_core "$CANONICAL_YAML" sme)"
eval "$(extract_core "$CANONICAL_YAML" mec)"

rst_out_field() {
  printf '%s\n' "$2" | grep -E "^${1}=" | head -1 | sed "s/^${1}=//"
}

rst_git_init() {
  git init -q "$1"
  git -C "$1" config user.email t@t
  git -C "$1" config user.name t
}

rst_commit() {
  git -C "$1" add -A
  git -C "$1" commit -qm "$2"
}

# Run the head command, then rst_apply_verdict. ARTIFACTS_DIR is empty so
# run-start-sha.txt is absent unless seed_sha (optional 4th arg) is set.
rst_verdict_for() {
  local repo="$1" cmd="$2" review="$3" seed_sha="${4:-}"
  local art log cmds result exit_code counts report status line out
  art="$(mktemp -d)"
  if [ -n "$seed_sha" ]; then
    printf '%s\n' "$seed_sha" > "$art/run-start-sha.txt"
  fi
  log="$repo/stop-tests.log"
  cmds="$repo/stop-tests.commands"
  printf '%s\n' "$cmd" > "$cmds"
  result="$(cd "$repo" && rst_run_commands "$cmds" "$log")"
  exit_code="${result%% *}"
  counts="${result#* }"
  counts="$(printf '%s' "$counts" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  SOURCE=spec_declared
  report="$(SOURCE=spec_declared rst_report CODE "$cmd" "$exit_code" "$counts")"
  report="$(printf '%s\n' "$report" | sed 's/^TESTS_LINE=.*/& [source: wo-spec]/')"
  status="$(printf '%s\n' "$report" | sed -n 's/^TESTS_STATUS=//p' | head -n 1)"
  line="$(printf '%s\n' "$report" | sed -n 's/^TESTS_LINE=//p' | head -n 1)"
  out="$(cd "$repo" && ARTIFACTS_DIR="$art" rst_apply_verdict CODE "$cmd" "$exit_code" "$counts" "$log" "$status" "$line" "$review" "$cmds")"
  rm -rf "$art"
  printf '%s\n' "$out"
}

RST_MANIFEST='WO: WO-X
Tests: N/A
Grep assertions: N/A
VALIDATION: PASS'

echo "--- rst_failing_names and reporter flags ---"
jf="$(mktemp)"
assert_eq "vitest reporter flags" "npx vitest run --reporter=default --reporter=json --outputFile=$jf" "$(rst_append_reporter 'npx vitest run' "$jf")"
assert_eq "jest reporter flags" "npx jest --json --outputFile=$jf" "$(rst_append_reporter 'npx jest' "$jf")"
assert_eq "bun x vitest reporter flags" "bun x vitest --reporter=default --reporter=json --outputFile=$jf" "$(rst_append_reporter 'bun x vitest' "$jf")"
assert_eq "plain command unchanged" "bash ./t.sh" "$(rst_append_reporter 'bash ./t.sh' "$jf")"
rm -f "$jf"
NAME_SAMPLE="$(printf '%s\n' \
  '(fail) bun name' \
  'not ok 2 - tap name' \
  'not ok 3 tap bare' \
  'FAILED tests/test_a.py::test_b extra' \
  '  1) mocha name' \
  'FAIL file.ts > suite > vitest name' \
  'FAIL X' \
  '  x under fail' \
  '  - also under' \
  | rst_failing_names)"
assert_contains "bun fail identity" "$(printf 'T\tbun name')" "$NAME_SAMPLE"
assert_contains "tap dash identity" "$(printf 'T\ttap name')" "$NAME_SAMPLE"
assert_contains "tap bare identity" "$(printf 'T\ttap bare')" "$NAME_SAMPLE"
assert_contains "pytest identity" "$(printf 'T\ttests/test_a.py::test_b')" "$NAME_SAMPLE"
assert_contains "mocha identity" "$(printf 'T\tmocha name')" "$NAME_SAMPLE"
assert_contains "vitest summary identity" "$(printf 'T\tFAIL file.ts > suite > vitest name')" "$NAME_SAMPLE"
# round 5: a child under "FAIL <file>" is qualified with that file so the same name
# under a DIFFERENT file is a different identity.
assert_contains "x under FAIL" "$(printf 'T\tX::under fail')" "$NAME_SAMPLE"
assert_contains "dash under FAIL" "$(printf 'T\tX::also under')" "$NAME_SAMPLE"
assert_contains "file identity count" "$(printf 'F\tX\t1')" "$NAME_SAMPLE"
assert_not_contains "bare FAIL is not a test identity" "$(printf 'T\tFAIL X')" "$NAME_SAMPLE"
# exact-record check: "T<TAB>X" must not exist as a whole record (substring matching
# would now trip on the legitimate "T<TAB>X::under fail").
assert_eq "bare FAIL line is not a T record" "" \
  "$(printf '%s\n' "$NAME_SAMPLE" | awk -F '\t' '$1=="T" && $2=="X"')"
# no bun block header in this sample, so bun/tap/mocha identities stay bare
assert_contains "bun fail stays bare without a header" "$(printf 'T\tbun name')" "$NAME_SAMPLE"

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required for the vitest reporter scenario"
  exit 1
fi

echo "--- Test 1: baseline red is reported, not blocking ---"
T1="$(mktemp -d)"
rst_git_init "$T1"
cat > "$T1/t.sh" <<'EOF'
#!/bin/bash
echo "(fail) stale > base is red"
echo "2 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T1/note.txt"
rst_commit "$T1" base
git -C "$T1" update-ref refs/remotes/origin/dev "$(git -C "$T1" rev-parse HEAD)"
printf 'head\n' > "$T1/note.txt"
rst_commit "$T1" head
T1_OUT="$(rst_verdict_for "$T1" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t1 status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T1_OUT")"
assert_eq "t1 base status" "failed" "$(rst_out_field TESTS_BASE_STATUS "$T1_OUT")"
assert_eq "t1 newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T1_OUT")"
assert_eq "t1 mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T1_OUT")"
T1_LINE="$(rst_out_field TESTS_LINE "$T1_OUT")"
case "$T1_LINE" in
  2/3\ *) PASS=$((PASS + 1)); echo "PASS: t1 line begins 2/3" ;;
  *) FAIL=$((FAIL + 1)); echo "FAIL: t1 line begins 2/3"; echo "  actual: [$T1_LINE]" ;;
esac
assert_contains "t1 dual counts" "head 2/3; base 2/3 at " "$T1_LINE"
assert_contains "t1 shared name" "newly failing: 0 (stale > base is red)" "$T1_LINE"
T1_STAMP="$(printf '%s\n' "$RST_MANIFEST" | sme_process "$T1_LINE" baseline_red "N/A (spec declares no grep stop conditions)" none_declared)"
assert_contains "t1 validation pass" "VALIDATION: PASS" "$T1_STAMP"
assert_not_contains "t1 validation not fail" "VALIDATION: FAIL" "$T1_STAMP"
assert_contains "t1 stop line" "Stop conditions: tests=baseline_red" "$T1_STAMP"
T1_ERR="$(mktemp)"
T1_RC=0
T1_MEC="$(printf '%s\n' "$T1_STAMP" | mec_check PROCEED CODE baseline_red 0 none_declared 1 2>"$T1_ERR")" || T1_RC=$?
assert_eq "t1 mec rc" "0" "$T1_RC"
assert_eq "t1 mec ok" "OK" "$T1_MEC"
rm -rf "$T1" "$T1_ERR"

echo "--- Test 2: a newly failing test blocks ---"
T2="$(mktemp -d)"
rst_git_init "$T2"
cat > "$T2/t.sh" <<'EOF'
#!/bin/bash
echo "(fail) stale > base is red"
echo "2 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T2/note.txt"
rst_commit "$T2" base
git -C "$T2" update-ref refs/remotes/origin/dev "$(git -C "$T2" rev-parse HEAD)"
cat > "$T2/t.sh" <<'EOF'
#!/bin/bash
echo "(fail) stale > base is red"
echo "(fail) new > head only"
echo "1 pass"
echo "2 fail"
exit 1
EOF
printf 'head\n' > "$T2/note.txt"
rst_commit "$T2" head
T2_OUT="$(rst_verdict_for "$T2" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t2 status" "failed" "$(rst_out_field TESTS_STATUS "$T2_OUT")"
assert_eq "t2 newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T2_OUT")"
assert_eq "t2 mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T2_OUT")"
T2_LINE="$(rst_out_field TESTS_LINE "$T2_OUT")"
assert_contains "t2 new name" "newly failing: 1 (new > head only)" "$T2_LINE"
assert_contains "t2 failed exit" " -- FAILED, exit " "$T2_LINE"
T2_STAMP="$(printf '%s\n' "$RST_MANIFEST" | sme_process "$T2_LINE" failed "N/A (spec declares no grep stop conditions)" none_declared)"
assert_contains "t2 validation fail" "VALIDATION: FAIL" "$T2_STAMP"
T2_ERR="$(mktemp)"
T2_RC=0
T2_MEC="$(printf '%s\n' "$T2_STAMP" | mec_check PROCEED CODE failed 0 none_declared 1 2>"$T2_ERR")" || T2_RC=$?
assert_eq "t2 mec rc" "1" "$T2_RC"
assert_contains "t2 mec error" "EVIDENCE_ERROR" "$(cat "$T2_ERR")"
rm -rf "$T2" "$T2_ERR"

echo "--- Test 3: unavailable is never a pass ---"
T3A="$(mktemp -d)"
rst_git_init "$T3A"
printf 'base\n' > "$T3A/note.txt"
rst_commit "$T3A" base
git -C "$T3A" update-ref refs/remotes/origin/dev "$(git -C "$T3A" rev-parse HEAD)"
T3A_BEFORE="$(git -C "$T3A" worktree list | grep -c . || true)"
T3A_OUT="$(rst_verdict_for "$T3A" "bash ./missing.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t3a status" "failed" "$(rst_out_field TESTS_STATUS "$T3A_OUT")"
assert_eq "t3a base status" "not_run" "$(rst_out_field TESTS_BASE_STATUS "$T3A_OUT")"
T3A_LINE="$(rst_out_field TESTS_LINE "$T3A_OUT")"
case "$T3A_LINE" in
  "N/A ("*) PASS=$((PASS + 1)); echo "PASS: t3a line starts N/A" ;;
  *) FAIL=$((FAIL + 1)); echo "FAIL: t3a line starts N/A"; echo "  actual: [$T3A_LINE]" ;;
esac
assert_eq "t3a no extra worktree" "$T3A_BEFORE" "$(git -C "$T3A" worktree list | grep -c . || true)"
if [ -f "$T3A/stop-tests.log.base" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: t3a created a base log"
else
  PASS=$((PASS + 1)); echo "PASS: t3a no base log"
fi
assert_not_contains "t3a not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T3A_OUT")"
assert_not_contains "t3a not passed" "passed" "$(rst_out_field TESTS_STATUS "$T3A_OUT")"
rm -rf "$T3A"

T3B="$(mktemp -d)"
rst_git_init "$T3B"
cat > "$T3B/t.sh" <<'EOF'
#!/bin/bash
echo "1 pass"
echo "1 fail"
exit 1
EOF
rst_commit "$T3B" head
T3B_OUT="$(rst_verdict_for "$T3B" "bash ./t.sh" "$(printf 'REVIEW_BASE=does-not-exist\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t3b status" "failed" "$(rst_out_field TESTS_STATUS "$T3B_OUT")"
assert_eq "t3b base status" "unavailable" "$(rst_out_field TESTS_BASE_STATUS "$T3B_OUT")"
assert_eq "t3b mode" "n/a" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T3B_OUT")"
assert_not_contains "t3b not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T3B_OUT")"
assert_not_contains "t3b not passed" "passed" "$(rst_out_field TESTS_STATUS "$T3B_OUT")"
rm -rf "$T3B"

echo "--- Test 3c: missing origin/<REVIEW_BASE> falls back to run-start-sha.txt ---"
T3C="$(mktemp -d)"
rst_git_init "$T3C"
cat > "$T3C/t.sh" <<'EOF'
#!/bin/bash
echo "(fail) stale > base is red"
echo "2 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T3C/note.txt"
rst_commit "$T3C" base
T3C_BASE="$(git -C "$T3C" rev-parse HEAD)"
printf 'head\n' > "$T3C/note.txt"
rst_commit "$T3C" head
if git -C "$T3C" rev-parse --verify -q 'refs/remotes/origin/dev^{commit}' >/dev/null; then
  FAIL=$((FAIL + 1)); echo "FAIL: t3c origin/dev should be absent"
else
  PASS=$((PASS + 1)); echo "PASS: t3c origin/dev absent"
fi
T3C_OUT="$(rst_verdict_for "$T3C" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')" "$T3C_BASE")"
assert_eq "t3c status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T3C_OUT")"
assert_eq "t3c base status" "failed" "$(rst_out_field TESTS_BASE_STATUS "$T3C_OUT")"
assert_eq "t3c base sha" "$T3C_BASE" "$(rst_out_field TESTS_BASE_SHA "$T3C_OUT")"
assert_eq "t3c newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T3C_OUT")"
assert_eq "t3c mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T3C_OUT")"
T3C_LINE="$(rst_out_field TESTS_LINE "$T3C_OUT")"
T3C_SHA8="$(printf '%s' "$T3C_BASE" | cut -c1-8)"
assert_contains "t3c dual counts" "head 2/3; base 2/3 at ${T3C_SHA8}" "$T3C_LINE"
assert_contains "t3c shared name" "newly failing: 0 (stale > base is red)" "$T3C_LINE"
assert_not_contains "t3c not unavailable" "unavailable" "$(rst_out_field TESTS_BASE_STATUS "$T3C_OUT")"
if [ -f "$T3C/stop-tests.log.base" ] && grep -Fq "(fail) stale > base is red" "$T3C/stop-tests.log.base"; then
  PASS=$((PASS + 1)); echo "PASS: t3c base pass wrote the base failure"
else
  FAIL=$((FAIL + 1)); echo "FAIL: t3c base pass did not run"
fi
assert_eq "t3c worktree cleaned" "1" "$(git -C "$T3C" worktree list | grep -c . || true)"
rm -rf "$T3C"

echo "--- Test 4: a passing head never pays for a base pass ---"
T4="$(mktemp -d)"
rst_git_init "$T4"
cat > "$T4/t.sh" <<'EOF'
#!/bin/bash
echo "3 pass"
exit 0
EOF
printf 'base\n' > "$T4/note.txt"
rst_commit "$T4" base
git -C "$T4" update-ref refs/remotes/origin/dev "$(git -C "$T4" rev-parse HEAD)"
printf 'head\n' > "$T4/note.txt"
rst_commit "$T4" head
T4_OUT="$(rst_verdict_for "$T4" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t4 status" "passed" "$(rst_out_field TESTS_STATUS "$T4_OUT")"
assert_eq "t4 base status" "not_run" "$(rst_out_field TESTS_BASE_STATUS "$T4_OUT")"
assert_eq "t4 sha" "none" "$(rst_out_field TESTS_BASE_SHA "$T4_OUT")"
if [ -f "$T4/stop-tests.log.base" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: t4 created a base log"
else
  PASS=$((PASS + 1)); echo "PASS: t4 no base log"
fi
assert_eq "t4 one worktree" "1" "$(git -C "$T4" worktree list | grep -c . || true)"
rm -rf "$T4"

echo "--- Test 5: count mode when names cannot be extracted ---"
rst_count_case() {
  local base_line="$1" head_line="$2" repo verdict
  repo="$(mktemp -d)"
  rst_git_init "$repo"
  printf '#!/bin/bash\necho "%s"\nexit 1\n' "$base_line" > "$repo/t.sh"
  printf 'base\n' > "$repo/note.txt"
  rst_commit "$repo" base
  git -C "$repo" update-ref refs/remotes/origin/dev "$(git -C "$repo" rev-parse HEAD)"
  printf '#!/bin/bash\necho "%s"\nexit 1\n' "$head_line" > "$repo/t.sh"
  printf 'head\n' > "$repo/note.txt"
  rst_commit "$repo" head
  verdict="$(rst_verdict_for "$repo" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
  rm -rf "$repo"
  printf '%s\n' "$verdict"
}
T5A="$(rst_count_case "Tests: 3/4" "Tests: 2/4")"
assert_eq "t5a mode" "count" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T5A")"
assert_eq "t5a newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T5A")"
assert_eq "t5a status" "failed" "$(rst_out_field TESTS_STATUS "$T5A")"
# Round-3 finding #1: when failure identities are unavailable on both sides, an equal
# failure count does NOT prove the head failures existed at base (base fails A, head
# fixes A and fails B leaves the count unchanged). Count mode stays blocking; it was
# baseline_red before this fix.
T5B="$(rst_count_case "Tests: 2/4" "Tests: 2/4")"
assert_eq "t5b mode" "count" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T5B")"
assert_eq "t5b newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T5B")"
assert_eq "t5b status" "failed" "$(rst_out_field TESTS_STATUS "$T5B")"
assert_not_contains "t5b not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T5B")"
# Round-3 finding #1 (lower-count clause): fewer head failures than base still cannot
# prove zero newly failing when identities are unavailable; it stays blocking.
T5C="$(rst_count_case "Tests: 1/4" "Tests: 2/4")"
assert_eq "t5c mode" "count" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T5C")"
assert_eq "t5c newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T5C")"
assert_eq "t5c status" "failed" "$(rst_out_field TESTS_STATUS "$T5C")"
assert_not_contains "t5c not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T5C")"

echo "--- Test 7: baseline_red without a zero count is refused ---"
T7_MAN="$(printf '%s\n' "$RST_MANIFEST" | sed 's|^Tests:.*|Tests: 2/3 (cmd) -- head 2/3; base 2/3 at abcdef01; newly failing: 2|')"
T7_ERR="$(mktemp)"
T7_RC=0
T7_MEC="$(printf '%s\n' "$T7_MAN" | mec_check PROCEED CODE baseline_red 0 none_declared 1 2>"$T7_ERR")" || T7_RC=$?
assert_eq "t7 mec rc" "1" "$T7_RC"
assert_contains "t7 token" "baseline_red_without_zero_newly_failing" "$(cat "$T7_ERR")"
rm -f "$T7_ERR"

echo "--- Test 8: an unexplained head exit stays blocking ---"
rst_exit_case() {
  local base_body="$1" repo verdict
  repo="$(mktemp -d)"
  rst_git_init "$repo"
  printf '%s\n' "$base_body" > "$repo/t.sh"
  printf 'base\n' > "$repo/note.txt"
  rst_commit "$repo" base
  git -C "$repo" update-ref refs/remotes/origin/dev "$(git -C "$repo" rev-parse HEAD)"
  cat > "$repo/t.sh" <<'EOF'
#!/bin/bash
echo "3 pass"
echo "0 fail"
exit 1
EOF
  printf 'head\n' > "$repo/note.txt"
  rst_commit "$repo" head
  verdict="$(rst_verdict_for "$repo" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
  rm -rf "$repo"
  printf '%s\n' "$verdict"
}
T8A="$(rst_exit_case "$(printf '%s\n' '#!/bin/bash' 'echo "3 pass"' 'exit 0')")"
assert_eq "t8a status" "failed" "$(rst_out_field TESTS_STATUS "$T8A")"
assert_eq "t8a base status" "passed" "$(rst_out_field TESTS_BASE_STATUS "$T8A")"
assert_eq "t8a evidence" "no" "$(rst_out_field TESTS_BASE_EVIDENCE "$T8A")"
assert_eq "t8a mode" "n/a" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T8A")"
T8A_LINE="$(rst_out_field TESTS_LINE "$T8A")"
assert_contains "t8a failed exit" " -- FAILED, exit 1" "$T8A_LINE"
assert_contains "t8a unexplained" "unexplained head exit 1" "$T8A_LINE"
T8A_STAMP="$(printf '%s\n' "$RST_MANIFEST" | sme_process "$T8A_LINE" failed "N/A (spec declares no grep stop conditions)" none_declared)"
assert_contains "t8a validation fail" "VALIDATION: FAIL" "$T8A_STAMP"
T8A_ERR="$(mktemp)"
T8A_RC=0
T8A_MEC="$(printf '%s\n' "$T8A_STAMP" | mec_check PROCEED CODE failed 0 none_declared 1 2>"$T8A_ERR")" || T8A_RC=$?
assert_eq "t8a mec rc" "1" "$T8A_RC"
rm -f "$T8A_ERR"
T8B="$(rst_exit_case "$(printf '%s\n' '#!/bin/bash' 'echo "3 pass"' 'echo "0 fail"' 'exit 1')")"
assert_eq "t8b evidence" "yes" "$(rst_out_field TESTS_BASE_EVIDENCE "$T8B")"
assert_eq "t8b status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T8B")"

echo "--- Test 9: file identities are not test identities ---"
VBIN="$(mktemp -d)"
cat > "$VBIN/npx" <<'EOF'
#!/bin/bash
if [ "$1" = "vitest" ]; then
  shift
  exec "$(dirname "$0")/vitest" "$@"
fi
echo "npx stub unsupported: $*" >&2
exit 127
EOF
cat > "$VBIN/vitest" <<'EOF'
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  case "$prev" in
    --outputFile) out="$a" ;;
  esac
  case "$a" in
    --outputFile=*) out="${a#--outputFile=}" ;;
  esac
  prev="$a"
done
mode="$(jq -r '.mode' fixture.json)"
file="$(jq -r '.file' fixture.json)"
if [ "$mode" = "json" ] || [ "$mode" = "abs" ]; then
  echo "FAIL $file"
  if [ -n "$out" ]; then
    if [ "$mode" = "abs" ]; then
      name="$PWD/$file"
    else
      name="$file"
    fi
    jq -n --arg name "$name" --slurpfile f fixture.json '{testResults:[{name:$name, assertionResults:[($f[0].names[] | {fullName:., status:"failed"})]}]}' > "$out"
  fi
  n="$(jq -r '.names | length' fixture.json)"
  echo "Tests: $n failed, 0 passed, $n total"
  exit 1
fi
count="$(jq -r '.count' fixture.json)"
i=0
while [ "$i" -lt "$count" ]; do
  echo "FAIL $file"
  i=$((i + 1))
done
echo "Tests: $count failed, 0 passed, $count total"
exit 1
EOF
chmod +x "$VBIN/npx" "$VBIN/vitest"
export PATH="$VBIN:$ORIG_PATH"

rst_vitest_case() {
  local base_json="$1" head_json="$2" repo verdict
  repo="$(mktemp -d)"
  rst_git_init "$repo"
  printf '%s\n' "$base_json" > "$repo/fixture.json"
  printf 'base\n' > "$repo/note.txt"
  rst_commit "$repo" base
  git -C "$repo" update-ref refs/remotes/origin/dev "$(git -C "$repo" rev-parse HEAD)"
  printf '%s\n' "$head_json" > "$repo/fixture.json"
  printf 'head\n' > "$repo/note.txt"
  rst_commit "$repo" head
  verdict="$(rst_verdict_for "$repo" "npx vitest run" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
  rm -rf "$repo"
  printf '%s\n' "$verdict"
}
T9A="$(rst_vitest_case '{"mode":"json","file":"X","names":["old test"]}' '{"mode":"json","file":"X","names":["old test","new test"]}')"
assert_eq "t9a mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T9A")"
assert_eq "t9a newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T9A")"
assert_eq "t9a status" "failed" "$(rst_out_field TESTS_STATUS "$T9A")"
assert_contains "t9a names the new test" "X::new test" "$(rst_out_field TESTS_LINE "$T9A")"
assert_not_contains "t9a not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T9A")"
T9B="$(rst_vitest_case '{"mode":"lines","file":"X","count":1}' '{"mode":"lines","file":"X","count":2}')"
assert_eq "t9b mode" "file-count" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T9B")"
assert_eq "t9b newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T9B")"
assert_eq "t9b status" "failed" "$(rst_out_field TESTS_STATUS "$T9B")"
assert_not_contains "t9b not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T9B")"
echo "--- Test 9c: absolute JSON paths from different checkouts are the same failure ---"
T9C="$(rst_vitest_case '{"mode":"abs","file":"X","names":["same test"]}' '{"mode":"abs","file":"X","names":["same test"]}')"
assert_eq "t9c status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T9C")"
assert_eq "t9c newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T9C")"
assert_eq "t9c mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T9C")"
assert_not_contains "t9c not a new absolute path" "/X::same test" "$(rst_out_field TESTS_LINE "$T9C")"
export PATH="$ORIG_PATH"
rm -rf "$VBIN"

echo "--- Test 10: FAIL headers that do not cover the failure count stay blocking ---"
T10="$(mktemp -d)"
rst_git_init "$T10"
cat > "$T10/t.sh" <<'EOF'
#!/bin/bash
echo "FAIL X"
echo "Tests: 2/3"
exit 1
EOF
printf 'base\n' > "$T10/note.txt"
rst_commit "$T10" base
git -C "$T10" update-ref refs/remotes/origin/dev "$(git -C "$T10" rev-parse HEAD)"
cat > "$T10/t.sh" <<'EOF'
#!/bin/bash
echo "FAIL X"
echo "Tests: 1/3"
exit 1
EOF
printf 'head\n' > "$T10/note.txt"
rst_commit "$T10" head
T10_OUT="$(rst_verdict_for "$T10" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t10 status" "failed" "$(rst_out_field TESTS_STATUS "$T10_OUT")"
assert_not_contains "t10 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T10_OUT")"
assert_eq "t10 mode" "count" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T10_OUT")"
assert_eq "t10 newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T10_OUT")"
rm -rf "$T10"

echo "--- Test 11: an unparsed failure beside a known one stays blocking ---"
T11="$(mktemp -d)"
rst_git_init "$T11"
cat > "$T11/one.sh" <<'EOF'
#!/bin/bash
echo "(fail) stale > kept"
echo "0 pass"
echo "1 fail"
exit 1
EOF
cat > "$T11/two.sh" <<'EOF'
#!/bin/bash
echo "1 pass"
echo "0 fail"
exit 0
EOF
printf 'base\n' > "$T11/note.txt"
rst_commit "$T11" base
git -C "$T11" update-ref refs/remotes/origin/dev "$(git -C "$T11" rev-parse HEAD)"
cat > "$T11/two.sh" <<'EOF'
#!/bin/bash
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'head\n' > "$T11/note.txt"
rst_commit "$T11" head
T11_CMD="$(printf '%s\n' 'bash ./one.sh' 'bash ./two.sh')"
T11_OUT="$(rst_verdict_for "$T11" "$T11_CMD" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t11 status" "failed" "$(rst_out_field TESTS_STATUS "$T11_OUT")"
assert_not_contains "t11 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T11_OUT")"
rm -rf "$T11"

echo "--- Test 12: text and JSON forms of one failure cannot hide an unparsed one ---"
T12_DUAL="$(printf 'T\t%s\n' \
  'FAIL src/a.test.ts > suite > old test' \
  'src/a.test.ts::suite > old test' \
  | rst_identity_count)"
assert_eq "t12 arrow json counts once" "1" "$T12_DUAL"
T12_JEST="$(printf 'T\t%s\n' \
  'FAIL src/a.test.ts > suite > old test' \
  'src/a.test.ts::suite old test' \
  | rst_identity_count)"
assert_eq "t12 space json counts once" "1" "$T12_JEST"
T12_TWO="$(printf 'T\t%s\n' \
  'FAIL src/a.test.ts > suite > old test' \
  'src/a.test.ts::suite > another' \
  | rst_identity_count)"
assert_eq "t12 distinct names stay distinct" "2" "$T12_TWO"

V12="$(mktemp -d)"
cat > "$V12/npx" <<'EOF'
#!/bin/bash
if [ "$1" = "vitest" ]; then
  shift
  exec "$(dirname "$0")/vitest" "$@"
fi
echo "npx stub unsupported: $*" >&2
exit 127
EOF
cat > "$V12/vitest" <<'EOF'
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  case "$prev" in
    --outputFile) out="$a" ;;
  esac
  case "$a" in
    --outputFile=*) out="${a#--outputFile=}" ;;
  esac
  prev="$a"
done
file="$(jq -r '.file' fixture.json)"
full="$(jq -r '.fullName' fixture.json)"
failed="$(jq -r '.failed' fixture.json)"
passed="$(jq -r '.passed' fixture.json)"
total="$(jq -r '.total' fixture.json)"
printf 'FAIL %s > %s\n' "$file" "$full"
if [ -n "$out" ]; then
  jq -n --arg name "$file" --arg full "$full" \
    '{testResults:[{name:$name, assertionResults:[{fullName:$full, status:"failed"}]}]}' > "$out"
fi
printf 'Tests: %s failed, %s passed, %s total\n' "$failed" "$passed" "$total"
exit 1
EOF
chmod +x "$V12/npx" "$V12/vitest"
export PATH="$V12:$ORIG_PATH"

T12_BASE='{"file":"src/a.test.ts","fullName":"suite > old test","failed":1,"passed":0,"total":1}'
T12_SAME='{"file":"src/a.test.ts","fullName":"suite > old test","failed":1,"passed":0,"total":1}'
T12_EXTRA='{"file":"src/a.test.ts","fullName":"suite > old test","failed":2,"passed":0,"total":2}'
T12_OK="$(rst_vitest_case "$T12_BASE" "$T12_SAME")"
assert_eq "t12 matched dual status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T12_OK")"
assert_eq "t12 matched dual newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T12_OK")"
assert_eq "t12 matched dual mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T12_OK")"
T12_BAD="$(rst_vitest_case "$T12_BASE" "$T12_EXTRA")"
assert_eq "t12 unparsed extra status" "failed" "$(rst_out_field TESTS_STATUS "$T12_BAD")"
assert_not_contains "t12 unparsed extra not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T12_BAD")"
assert_eq "t12 unparsed extra newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T12_BAD")"
export PATH="$ORIG_PATH"
rm -rf "$V12"

echo "--- Test 13: a new per-command failure blocks even when identities elsewhere match (round 3 #2) ---"
# command 1 fails the same named test at base and head; command 2 passes at base and
# crashes without counts at head. The aggregate identities match (only the shared
# failure is named), so without the per-command gate this is baseline_red.
T13="$(mktemp -d)"
rst_git_init "$T13"
cat > "$T13/one.sh" <<'EOF'
#!/bin/bash
echo "(fail) shared > kept"
echo "0 pass"
echo "1 fail"
exit 1
EOF
cat > "$T13/two.sh" <<'EOF'
#!/bin/bash
echo "1 pass"
echo "0 fail"
exit 0
EOF
printf 'base\n' > "$T13/note.txt"
rst_commit "$T13" base
git -C "$T13" update-ref refs/remotes/origin/dev "$(git -C "$T13" rev-parse HEAD)"
cat > "$T13/two.sh" <<'EOF'
#!/bin/bash
echo "boom"
exit 1
EOF
printf 'head\n' > "$T13/note.txt"
rst_commit "$T13" head
T13_CMD="$(printf '%s\n' 'bash ./one.sh' 'bash ./two.sh')"
T13_OUT="$(rst_verdict_for "$T13" "$T13_CMD" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t13 status" "failed" "$(rst_out_field TESTS_STATUS "$T13_OUT")"
assert_not_contains "t13 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T13_OUT")"
# The helper passes the raw multi-line command list through to the Tests line; the
# real node semicolon-joins it. Assert against the whole output so the note (on a
# later physical line of the Tests line here) is still found.
assert_contains "t13 names the regression" "command regression at head" "$T13_OUT"
rm -rf "$T13"

echo "--- Test 14: reporter rerun identities are unioned, never replace the original run (round 3 #3) ---"
# The original head run (no --outputFile) fails test X; the reporter rerun (and the
# base) fail baseline test Y with the same count. Replacing the original identities
# with the rerun's would drop X and emit baseline_red; the union keeps X and blocks.
V14="$(mktemp -d)"
cat > "$V14/npx" <<'EOF'
#!/bin/bash
if [ "$1" = "vitest" ]; then
  shift
  exec "$(dirname "$0")/vitest" "$@"
fi
echo "npx stub unsupported: $*" >&2
exit 127
EOF
cat > "$V14/vitest" <<'EOF'
#!/bin/bash
out=""
prev=""
for a in "$@"; do
  case "$prev" in
    --outputFile) out="$a" ;;
  esac
  case "$a" in
    --outputFile=*) out="${a#--outputFile=}" ;;
  esac
  prev="$a"
done
file="$(jq -r '.file' fixture.json)"
x="$(jq -r '.x' fixture.json)"
y="$(jq -r '.y' fixture.json)"
if [ -n "$out" ]; then
  echo "FAIL $file > $y"
  jq -n --arg f "$file" --arg n "$y" '{testResults:[{name:$f, assertionResults:[{fullName:$n, status:"failed"}]}]}' > "$out"
else
  echo "FAIL $file > $x"
fi
echo "Tests: 1 failed, 0 passed, 1 total"
exit 1
EOF
chmod +x "$V14/npx" "$V14/vitest"
export PATH="$V14:$ORIG_PATH"
T14_FIX='{"file":"a.test.ts","x":"new x","y":"old y"}'
T14_OUT="$(rst_vitest_case "$T14_FIX" "$T14_FIX")"
assert_eq "t14 status" "failed" "$(rst_out_field TESTS_STATUS "$T14_OUT")"
assert_not_contains "t14 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T14_OUT")"
export PATH="$ORIG_PATH"
rm -rf "$V14"

echo "--- Test 15: a bare name failing in a DIFFERENT command at head blocks (round 4 #1) ---"
# bdc-xo #1940 round 4 finding 1: text identities omit command context, so the same
# bare name failing in different commands at base vs head compares equal. Here two
# files swap which command fails them: each command's failing COUNT is unchanged, so
# the per-command count gate (rst_cmd_regression) does not fire, and the aggregate
# name set {foo,bar} matches -- old code emitted baseline_red, masking two regressions.
# rst_cmd_new_names qualifies by command and blocks.
T15="$(mktemp -d)"
rst_git_init "$T15"
cat > "$T15/one.sh" <<'EOF'
#!/bin/bash
echo "(fail) foo"
echo "0 pass"
echo "1 fail"
exit 1
EOF
cat > "$T15/two.sh" <<'EOF'
#!/bin/bash
echo "(fail) bar"
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T15/note.txt"
rst_commit "$T15" base
git -C "$T15" update-ref refs/remotes/origin/dev "$(git -C "$T15" rev-parse HEAD)"
cat > "$T15/one.sh" <<'EOF'
#!/bin/bash
echo "(fail) bar"
echo "0 pass"
echo "1 fail"
exit 1
EOF
cat > "$T15/two.sh" <<'EOF'
#!/bin/bash
echo "(fail) foo"
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'head\n' > "$T15/note.txt"
rst_commit "$T15" head
T15_CMD="$(printf '%s\n' 'bash ./one.sh' 'bash ./two.sh')"
T15_OUT="$(rst_verdict_for "$T15" "$T15_CMD" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t15 status" "failed" "$(rst_out_field TESTS_STATUS "$T15_OUT")"
assert_not_contains "t15 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T15_OUT")"
assert_contains "t15 names the regression" "command regression at head" "$T15_OUT"
rm -rf "$T15"

echo "--- Test 15b: rst_cmd_new_names direct (swap blocks, identical passes) ---"
T15B_H="$(mktemp)"; T15B_B="$(mktemp)"
cat > "$T15B_B" <<'EOF'
### run-stop-tests: bash ./one.sh
(fail) foo
### exit 1 one.sh
### run-stop-tests: bash ./two.sh
(fail) bar
### exit 1 two.sh
EOF
cat > "$T15B_H" <<'EOF'
### run-stop-tests: bash ./one.sh
(fail) bar
### exit 1 one.sh
### run-stop-tests: bash ./two.sh
(fail) foo
### exit 1 two.sh
EOF
assert_eq "t15b swap flags new names" "1" "$(rst_cmd_new_names "$T15B_H" "$T15B_B")"
assert_eq "t15b identical no new names" "0" "$(rst_cmd_new_names "$T15B_B" "$T15B_B")"
rm -f "$T15B_H" "$T15B_B"

echo "--- Test 16: a head-only FAIL <new-file> header is not masked by reporter names (round 4 #2) ---"
# bdc-xo #1940 round 4 finding 2: names mode drops F records, so a head-only
# "FAIL new.test.ts" (collection error, no per-test name) is masked when the identity
# count is filled by named failures for OTHER (baseline) files. head and base both
# name base.test.ts keeps+extra (count 2/2), but head additionally fails a NEW file at
# the file level. rst_uncovered_file_count forces a fall-through off names mode so the
# new file stays blocking.
T16_UNC_HIDDEN="$(printf 'F\t%s\t%s\nT\t%s\nT\t%s\n' \
  'new.test.ts' '1' 'base.test.ts::keeps' 'base.test.ts::extra' | rst_uncovered_file_count)"
assert_eq "t16 uncovered new file counted" "1" "$T16_UNC_HIDDEN"
T16_UNC_COVERED="$(printf 'F\t%s\t%s\nT\t%s\n' \
  'base.test.ts' '1' 'FAIL base.test.ts > keeps' | rst_uncovered_file_count)"
assert_eq "t16 covered file not counted" "0" "$T16_UNC_COVERED"
T16="$(mktemp -d)"
rst_git_init "$T16"
cat > "$T16/t.sh" <<'EOF'
#!/bin/bash
echo "FAIL base.test.ts > keeps"
echo "FAIL base.test.ts > extra"
echo "Tests: 2 failed, 0 passed, 2 total"
exit 1
EOF
printf 'base\n' > "$T16/note.txt"
rst_commit "$T16" base
git -C "$T16" update-ref refs/remotes/origin/dev "$(git -C "$T16" rev-parse HEAD)"
cat > "$T16/t.sh" <<'EOF'
#!/bin/bash
echo "FAIL new.test.ts"
echo "FAIL base.test.ts > keeps"
echo "FAIL base.test.ts > extra"
echo "Tests: 2 failed, 0 passed, 2 total"
exit 1
EOF
printf 'head\n' > "$T16/note.txt"
rst_commit "$T16" head
T16_OUT="$(rst_verdict_for "$T16" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t16 status" "failed" "$(rst_out_field TESTS_STATUS "$T16_OUT")"
assert_not_contains "t16 not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T16_OUT")"
assert_not_contains "t16 mode not names" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T16_OUT")"
rm -rf "$T16"

echo
echo "--- Test 17: a bare name in a DIFFERENT file at head blocks (round 5) ---"
# bdc-xo #1940 round 5: text identities were bare WITHIN a single command. A base
# failure "(fail) same name" in file A and a head failure with the same name in file B
# compared equal, satisfied names_complete, and emitted baseline_red -- masking a real
# regression. rst_cmd_new_names only separated command segments, not files. The parser
# now qualifies a bare name with the enclosing bun block header.
T17_SAMPLE="$(printf '%s\n' \
  'a.test.ts:' \
  '(fail) same name' \
  'b.test.ts:' \
  '(fail) same name' \
  | rst_failing_names)"
assert_contains "t17 file A qualified" "$(printf 'T\ta.test.ts::same name')" "$T17_SAMPLE"
assert_contains "t17 file B qualified" "$(printf 'T\tb.test.ts::same name')" "$T17_SAMPLE"
assert_eq "t17 two distinct identities" "2" "$(printf '%s\n' "$T17_SAMPLE" | rst_identity_count)"

echo "--- Test 17b: same command, same name, file moved -- not baseline_red (round 5) ---"
# The reviewer's exact scenario end-to-end: ONE command, identical failing COUNT on
# both sides, identical bare name -- only the file differs. rst_cmd_regression cannot
# see it (counts match) and rst_cmd_new_names cannot see it (one segment), so the file
# qualification is the only thing that keeps this blocking.
T17B="$(mktemp -d)"
rst_git_init "$T17B"
cat > "$T17B/t.sh" <<'EOF'
#!/bin/bash
echo "a.test.ts:"
echo "(fail) same name"
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T17B/note.txt"
rst_commit "$T17B" base
git -C "$T17B" update-ref refs/remotes/origin/dev "$(git -C "$T17B" rev-parse HEAD)"
cat > "$T17B/t.sh" <<'EOF'
#!/bin/bash
echo "b.test.ts:"
echo "(fail) same name"
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'head\n' > "$T17B/note.txt"
rst_commit "$T17B" head
T17B_OUT="$(rst_verdict_for "$T17B" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t17b status" "failed" "$(rst_out_field TESTS_STATUS "$T17B_OUT")"
assert_not_contains "t17b not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T17B_OUT")"
assert_eq "t17b newly" "1" "$(rst_out_field TESTS_NEWLY_FAILING "$T17B_OUT")"
assert_contains "t17b names the new file" "b.test.ts::same name" "$(rst_out_field TESTS_LINE "$T17B_OUT")"
rm -rf "$T17B"

echo "--- Test 17c: an unmoved qualified failure is still baseline_red (round 5) ---"
# Guard against over-blocking: qualification must not turn a genuinely red baseline
# into a block when the SAME test in the SAME file fails on both sides.
T17C="$(mktemp -d)"
rst_git_init "$T17C"
cat > "$T17C/t.sh" <<'EOF'
#!/bin/bash
echo "a.test.ts:"
echo "(fail) same name"
echo "0 pass"
echo "1 fail"
exit 1
EOF
printf 'base\n' > "$T17C/note.txt"
rst_commit "$T17C" base
git -C "$T17C" update-ref refs/remotes/origin/dev "$(git -C "$T17C" rev-parse HEAD)"
printf 'head\n' > "$T17C/note.txt"
rst_commit "$T17C" head
T17C_OUT="$(rst_verdict_for "$T17C" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_eq "t17c status" "baseline_red" "$(rst_out_field TESTS_STATUS "$T17C_OUT")"
assert_eq "t17c mode" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T17C_OUT")"
assert_eq "t17c newly" "0" "$(rst_out_field TESTS_NEWLY_FAILING "$T17C_OUT")"
rm -rf "$T17C"

echo "--- Test 17d: rst_identity_context_mixed fails closed on partial file context ---"
assert_eq "t17d all bare" "0" \
  "$(printf 'T\t%s\nT\t%s\n' 'plain one' 'plain two' | rst_identity_context_mixed)"
assert_eq "t17d all qualified" "0" \
  "$(printf 'T\t%s\nT\t%s\n' 'a.ts::one' 'FAIL b.ts > two' | rst_identity_context_mixed)"
assert_eq "t17d mixed" "1" \
  "$(printf 'T\t%s\nT\t%s\n' 'a.ts::one' 'plain two' | rst_identity_context_mixed)"
assert_eq "t17d no identities" "0" "$(printf 'F\t%s\t%s\n' 'a.ts' '1' | rst_identity_context_mixed)"

echo "--- Test 17e: mixed file context denies names mode end-to-end (round 5) ---"
# head proves the runner CAN report a file (one qualified identity) but still emits a
# bare name. That bare name may belong to a different file than the base's bare name
# and nothing in the log can resolve it, so names mode must fail closed rather than
# compare the bare names and emit baseline_red.
T17E="$(mktemp -d)"
rst_git_init "$T17E"
cat > "$T17E/t.sh" <<'EOF'
#!/bin/bash
echo "not ok 1 - bare name"
echo "FAILED tests/test_a.py::test_b"
echo "0 pass"
echo "2 fail"
exit 1
EOF
printf 'base\n' > "$T17E/note.txt"
rst_commit "$T17E" base
git -C "$T17E" update-ref refs/remotes/origin/dev "$(git -C "$T17E" rev-parse HEAD)"
printf 'head\n' > "$T17E/note.txt"
rst_commit "$T17E" head
T17E_OUT="$(rst_verdict_for "$T17E" "bash ./t.sh" "$(printf 'REVIEW_BASE=dev\nREVIEW_BASE_SOURCE=declared\n')")"
assert_not_contains "t17e mode not names" "names" "$(rst_out_field TESTS_NEWLY_FAILING_MODE "$T17E_OUT")"
assert_not_contains "t17e not baseline_red" "baseline_red" "$(rst_out_field TESTS_STATUS "$T17E_OUT")"
rm -rf "$T17E"

echo "run-stop-tests.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
