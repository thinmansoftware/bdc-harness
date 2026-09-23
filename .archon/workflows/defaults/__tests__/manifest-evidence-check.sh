#!/usr/bin/env bash
# manifest-evidence-check.sh -- unit tests for the manifest-evidence-check node core
# (mec_*) AND the stamp-manifest-evidence node core (sme_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and their
# byte-identical mirrors in the other 11 bdc-feature-development lanes (12 total).
#
# bdc-xo #1940 made manifest-evidence-check fail CLOSED on "Tests: N/A ...".
# WO-HARNESS-MANIFEST-EVIDENCE-FALSE-POSITIVES-01 refines the admission policy:
#   - a test command that ran and exited 0 but printed no parseable counts
#     (tests_status=counts_unparsed, tests_exit=0) is ADMITTED (was a false positive);
#   - grep_status=incomplete (some executed, none mismatched) is ADMITTED, with the
#     unparsed names + dropped count surfaced on the "Stop conditions:" line;
#   - grep_status=all_dropped is still refused, but ATTRIBUTED by cause -- "SPEC_DEFECT:"
#     when the declared conditions were prose (grep_unparsed>0), "HARNESS_REFUSED:" when
#     the read-only allowlist dropped every one (grep_dropped>0);
#   - failed tests, nonzero exit, and grep mismatch still fail closed.
# stamp-manifest-evidence's VALIDATION verdict AGREES with manifest-evidence-check.
#
# Run: bash .archon/workflows/defaults/__tests__/manifest-evidence-check.sh
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
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unwanted: $needle"; echo "  haystack: $haystack"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}

assert_prefix() {
  local label="$1" prefix="$2" text="$3"
  case "$text" in
    "$prefix"*) PASS=$((PASS + 1)); echo "PASS: $label" ;;
    *) FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected prefix: $prefix"; echo "  actual:          $text" ;;
  esac
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
# All 12 lanes that carry the mec/sme cores (verified via
# `grep -l 'BEGIN mec core' *.yaml`). Includes -cursor.yaml. The canonical lane
# self-compares harmlessly.
LANES="
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
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

MEC_CORE="$(extract_core "$CANONICAL_YAML" mec)"
if [ -z "$MEC_CORE" ]; then
  echo "FATAL: could not extract mec core from $CANONICAL_YAML"; exit 1
fi
eval "$MEC_CORE"
for fn in mec_field mec_check; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

SME_CORE="$(extract_core "$CANONICAL_YAML" sme)"
if [ -z "$SME_CORE" ]; then
  echo "FATAL: could not extract sme core from $CANONICAL_YAML"; exit 1
fi
eval "$SME_CORE"
for fn in sme_field sme_process; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Test 7 (lane parity): mec + sme cores byte-identical across all 12 lanes ---"
LANE_COUNT=0
for lane in $LANES; do
  LANE_COUNT=$((LANE_COUNT + 1))
  assert_eq "mec parity $lane" "$MEC_CORE" "$(extract_core "$DEFAULTS/$lane" mec)"
  assert_eq "sme parity $lane" "$SME_CORE" "$(extract_core "$DEFAULTS/$lane" sme)"
done
assert_eq "Test 7: 12 lanes carry the cores" "12" "$LANE_COUNT"

# run_check <manifest> <status> <class> <tests_status> <tests_exit> \
#           <grep_declared> <grep_status> <grep_executed> <grep_dropped> \
#           <grep_unparsed> <grep_mismatch> <grep_detail>  -> "<rc>|<stdout>|<stderr>"
run_check() {
  local out err rc
  err="$(mktemp)"
  out="$(printf '%s\n' "$1" | mec_check "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" 2>"$err")"; rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
}

# Verbatim event-store fixtures (WO Section, run 06b3c82c and run f83034d9).
TESTS_UNPARSED_EXIT0='N/A (test command exited 0 but pass/total could not be parsed from its output: node docs/design/build-a-box-three-styles/build.cjs; node docs/design/build-a-box-three-styles/verify.cjs)'
TESTS_FAILED_EXIT1='N/A (spec-declared test command exited 1 with no parseable counts: cd shopops-api && node tests/test_receiving_session.js) -- FAILED'

# A PROCEED CODE manifest whose Tests line is the exit-0 unparsed line, no greps.
FALSEPOS_MANIFEST="WO: WO-X
Files modified: build.cjs
Tests: ${TESTS_UNPARSED_EXIT0}
Grep assertions: N/A (no declared mechanical assertions)
VALIDATION: PASS
Stop conditions: tests=counts_unparsed; greps=none_declared"

FAILED_MANIFEST="WO: WO-X
Tests: ${TESTS_FAILED_EXIT1}
Grep assertions: N/A (no declared mechanical assertions)
VALIDATION: FAIL"

GOOD_MANIFEST='WO: WO-X
Tests: 27/27 (cd shopops-api && node tests/run_all.js)
Grep assertions: grep -c "a" b.js => 1; grep -c "c" a.js => 2
VALIDATION: PASS'

echo "--- Test 1: exit-0 unparsed counts is admitted (the false positive) ---"
R="$(run_check "$FALSEPOS_MANIFEST" PROCEED CODE counts_unparsed 0 0 none_declared 0 0 0 0 "")"
assert_eq "Test 1: rc 0 / OK" "0|OK|" "$R"

echo "--- Test 2: failed command is still refused (the correct refusal) ---"
R="$(run_check "$FAILED_MANIFEST" PROCEED CODE failed 1 0 none_declared 0 0 0 0 "")"
assert_eq "Test 2: rc 1" "1" "${R%%|*}"
assert_contains "Test 2: EVIDENCE_ERROR names the Tests line" "EVIDENCE_ERROR: Tests:" "$R"

echo "--- Test 3: counts_unparsed with nonzero exit is refused ---"
R="$(run_check "$FALSEPOS_MANIFEST" PROCEED CODE counts_unparsed 1 0 none_declared 0 0 0 0 "")"
assert_eq "Test 3: rc 1" "1" "${R%%|*}"
assert_contains "Test 3: EVIDENCE_ERROR present" "EVIDENCE_ERROR" "$R"

echo "--- Test 4: partial greps admitted, unparsed names published, VALIDATION: PASS ---"
INCOMPLETE_MANIFEST='WO: WO-X
Tests: 3/3 (node t.js)
Grep assertions: grep -c "a" b.js => 2; grep -c "c" a.js => 4; UNVERIFIED (unparsed): Stop 3 prose condition
VALIDATION: PASS'
R="$(run_check "$INCOMPLETE_MANIFEST" PROCEED CODE passed 0 3 incomplete 2 0 1 0 "")"
assert_eq "Test 4: mec rc 0 / OK" "0|OK|" "$R"
# stamp-manifest-evidence composes the Stop conditions line and the VALIDATION verdict.
STAMPED="$(printf '%s\n' "$INCOMPLETE_MANIFEST" | sme_process "3/3 (node t.js)" "passed" \
  'grep -c "a" b.js => 2; grep -c "c" a.js => 4; UNVERIFIED (unparsed): Stop 3 prose condition' "incomplete" "1" "0")"
assert_contains "Test 4: Stop conditions line carries unparsed=" "unparsed=" "$STAMPED"
assert_contains "Test 4: unparsed names published" "Stop 3 prose condition" "$STAMPED"
assert_contains "Test 4: dropped count published" "dropped=0" "$STAMPED"
assert_contains "Test 4: VALIDATION: PASS on an admitted incomplete run" "VALIDATION: PASS" "$STAMPED"
assert_not_contains "Test 4: not stamped FAIL" "VALIDATION: FAIL" "$STAMPED"

echo "--- Test 5: zero executed greps attributed by cause (SPEC_DEFECT vs HARNESS_REFUSED) ---"
SPECDEFECT_MANIFEST='WO: WO-X
Tests: 3/3 (node t.js)
Grep assertions: N/A (3 declared grep stop condition(s) but none executable under the read-only allowlist)
VALIDATION: PASS'
R="$(run_check "$SPECDEFECT_MANIFEST" PROCEED CODE passed 0 3 all_dropped 0 0 3 0 "")"
assert_eq "Test 5a: rc 1" "1" "${R%%|*}"
assert_prefix "Test 5a: stderr starts with SPEC_DEFECT:" "SPEC_DEFECT:" "${R#*|*|}"
assert_contains "Test 5a: names the unparsed conditions (count)" "grep_unparsed=3" "$R"
assert_not_contains "Test 5a: not EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_not_contains "Test 5a: not HARNESS_REFUSED" "HARNESS_REFUSED" "$R"

REFUSED_DETAIL='--- per-assertion detail ---
DROPPED (not on read-only allowlist; not executed): grep -c '\''Class:'\'' manifest.md => expected eq 1'
HARNESS_MANIFEST='WO: WO-X
Tests: 3/3 (node t.js)
Grep assertions: N/A (1 declared grep stop condition(s) but none executable under the read-only allowlist)
VALIDATION: PASS'
R="$(run_check "$HARNESS_MANIFEST" PROCEED CODE passed 0 1 all_dropped 0 1 0 0 "$REFUSED_DETAIL")"
assert_eq "Test 5b: rc 1" "1" "${R%%|*}"
assert_prefix "Test 5b: stderr starts with HARNESS_REFUSED:" "HARNESS_REFUSED:" "${R#*|*|}"
assert_contains "Test 5b: carries the DROPPED reason" "DROPPED (not on read-only allowlist; not executed)" "$R"
assert_not_contains "Test 5b: not EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_not_contains "Test 5b: not SPEC_DEFECT" "SPEC_DEFECT" "$R"

echo "--- Test 6: executed grep with a failing count is still refused ---"
R="$(run_check "$GOOD_MANIFEST" PROCEED CODE passed 0 2 mismatch 2 0 0 1 "")"
assert_eq "Test 6: rc 1" "1" "${R%%|*}"
assert_contains "Test 6: EVIDENCE_ERROR present" "EVIDENCE_ERROR" "$R"
assert_not_contains "Test 6: not SPEC_DEFECT" "SPEC_DEFECT" "$R"
assert_not_contains "Test 6: not HARNESS_REFUSED" "HARNESS_REFUSED" "$R"

echo "--- Test 7 (idempotency): mec_check is deterministic across repeated runs ---"
R1="$(run_check "$SPECDEFECT_MANIFEST" PROCEED CODE passed 0 3 all_dropped 0 0 3 0 "")"
R2="$(run_check "$SPECDEFECT_MANIFEST" PROCEED CODE passed 0 3 all_dropped 0 0 3 0 "")"
assert_eq "Test 7: repeated run yields identical output" "$R1" "$R2"

echo "--- Regression: PROCEED CODE with real numbers and executed greps -> OK ---"
R="$(run_check "$GOOD_MANIFEST" PROCEED CODE passed 0 2 passed 2 0 0 0 "")"
assert_eq "good manifest rc 0 / OK" "0|OK|" "$R"

echo "--- Regression: PROCEED CODE with Tests: N/A (not counts_unparsed) -> EVIDENCE_ERROR ---"
NA_TESTS_MANIFEST='WO: WO-X
Tests: N/A (required gates are reported separately)
Grep assertions: N/A (no declared mechanical assertions)
VALIDATION: PASS'
R="$(run_check "$NA_TESTS_MANIFEST" PROCEED CODE no_command_declared 0 0 none_declared 0 0 0 0 "")"
assert_eq "N/A tests rc 1" "1" "${R%%|*}"
assert_contains "cites Rule 10" "Rule 10" "$R"

echo "--- Regression: INFRA / DOCUMENTATION with Tests: N/A and no greps -> OK ---"
R="$(run_check "$NA_TESTS_MANIFEST" PROCEED INFRA not_required 0 0 none_declared 0 0 0 0 "")"
assert_eq "INFRA OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS_MANIFEST" PROCEED DOCUMENTATION not_required 0 0 none_declared 0 0 0 0 "")"
assert_eq "DOCUMENTATION OK" "0|OK|" "$R"

echo "--- Regression: missing run-stop-greps output fails closed ---"
MISSING_GREPS_MANIFEST='WO: WO-X
Tests: N/A (required gates are reported separately)
Grep assertions: MISSING (run-stop-greps produced no output)
VALIDATION: PASS'
R="$(run_check "$MISSING_GREPS_MANIFEST" PROCEED INFRA not_required 0 "" "" "" "" "" "" "")"
assert_eq "missing grep output rc 1" "1" "${R%%|*}"
assert_contains "names missing grep evidence" "run-stop-greps produced no output (grep_status=missing)" "$R"

echo "--- Regression: declared greps but Grep assertions: N/A on a passed status -> error ---"
NA_GREPS_MANIFEST='WO: WO-X
Tests: 5/5 (node t.js)
Grep assertions: N/A (no declared mechanical assertions)
VALIDATION: PASS'
R="$(run_check "$NA_GREPS_MANIFEST" PROCEED CODE passed 0 9 passed 9 0 0 0 "")"
assert_eq "declared greps + N/A line rc 1" "1" "${R%%|*}"

echo "--- Regression: failing tests are NOT blocked here (stamped honestly downstream) ---"
FAILNUM_MANIFEST='WO: WO-X
Tests: 6/8 (node t.js) -- FAILED, exit 1
Grep assertions: grep -c "a" b.js => 1
VALIDATION: FAIL'
R="$(run_check "$FAILNUM_MANIFEST" PROCEED CODE failed 1 1 passed 1 0 0 0 "")"
assert_eq "numeric FAIL manifest reaches PR body (rc 0)" "0|OK|" "$R"

echo "--- Regression: non-PROCEED and short manifests are not gated ---"
R="$(run_check "$NA_TESTS_MANIFEST" ALREADY_SATISFIED CODE "" 0 0 "" 0 0 0 0 "")"
assert_eq "ALREADY_SATISFIED OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS_MANIFEST" BLOCKED CODE "" 0 0 "" 0 0 0 0 "")"
assert_eq "BLOCKED OK" "0|OK|" "$R"
R="$(run_check "$(printf 'WO: WO-X\nOUTCOME=ALREADY_SATISFIED\nVALIDATION: PASS')" PROCEED CODE "" 0 0 "" 0 0 0 0 "")"
assert_eq "short manifest OK" "0|OK|" "$R"

echo "--- sme_process verdict AGREES with mec_check ---"
sme_verdict() {
  # sme_verdict <tests_line> <tests_status> <grep_line> <grep_status> <unparsed> <dropped>
  printf 'WO: X\nTests: p\nGrep assertions: g\nVALIDATION: PASS\n' \
    | sme_process "$1" "$2" "$3" "$4" "$5" "$6" | grep -E '^VALIDATION:' | head -1
}
assert_eq "sme: counts_unparsed -> PASS" "VALIDATION: PASS" "$(sme_verdict "N/A unparsed" counts_unparsed "gl" passed 0 0)"
assert_eq "sme: incomplete -> PASS"      "VALIDATION: PASS" "$(sme_verdict "3/3" passed "x => 1; UNVERIFIED (unparsed): c" incomplete 1 0)"
assert_eq "sme: failed -> FAIL"          "VALIDATION: FAIL" "$(sme_verdict "6/8 FAILED" failed "gl" passed 0 0)"
assert_eq "sme: mismatch -> FAIL"        "VALIDATION: FAIL" "$(sme_verdict "3/3" passed "x => 9" mismatch 0 0)"
assert_eq "sme: all_dropped -> FAIL"     "VALIDATION: FAIL" "$(sme_verdict "3/3" passed "N/A" all_dropped 3 0)"
assert_eq "sme: missing -> FAIL"         "VALIDATION: FAIL" "$(sme_verdict "3/3" passed "" missing 0 0)"

echo "--- mec_field / sme_field ---"
assert_eq "mec_field TESTS_CLASS" "CODE" "$(mec_field TESTS_CLASS "$(printf 'TESTS_CLASS=CODE\nTESTS_STATUS=passed')")"
assert_eq "mec_field TESTS_EXIT" "0" "$(mec_field TESTS_EXIT "$(printf 'TESTS_EXIT=0\nTESTS_STATUS=counts_unparsed')")"
assert_eq "mec_field GREP_MISMATCH" "1" "$(mec_field GREP_MISMATCH "$(printf 'GREP_MISMATCH=1\nGREP_STATUS=mismatch')")"
assert_eq "mec_field missing -> empty" "" "$(mec_field GREP_DECLARED "")"
assert_eq "sme_field GREP_UNPARSED" "2" "$(sme_field GREP_UNPARSED "$(printf 'GREP_UNPARSED=2\nGREP_DROPPED=0')")"

echo
echo "manifest-evidence-check.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
