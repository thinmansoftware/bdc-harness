#!/usr/bin/env bash
# manifest-evidence-check.sh -- unit tests for the manifest-evidence-check node core
# (mec_*) and the stamp-manifest-evidence node core (sme_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and their byte-identical
# mirrors in the other 11 bdc-feature-development lanes.
#
# bdc-xo #1940 made mec fail CLOSED on "Tests: N/A ..." (CODE/MIXED) and on declared-but-
# undocumented grep stop conditions. WO-HARNESS-MANIFEST-EVIDENCE-FALSE-POSITIVES-01 then
# narrows that gate so it no longer produces false positives:
#   - a declared test command that ran and exited 0 but printed no parseable counts
#     (tests_status=counts_unparsed, tests_exit=0) is ADMITTED (ran, no counts, not N/A);
#   - a partially executed grep set (grep_status=incomplete, no mismatch) is ADMITTED and
#     the unparsed names + dropped count are stamped onto the "Stop conditions:" line;
#   - a fully unexecutable grep set (grep_status=all_dropped, 0 executed) still fails but
#     with a SPEC_DEFECT: prefix attributing it to the spec, not the builder;
# while a failed command, a nonzero-exit unparsed command, a declared-but-unrun command,
# and an executed grep with the wrong count all STILL fail closed.
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
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected needle: $needle"; echo "  haystack: $haystack"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
# All 12 lanes that carry the mec/sme cores (grep -l 'BEGIN mec core' defaults/*.yaml).
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

# The rsg core (run-stop-greps) is eval'd here too so Test 5 can exercise the REAL
# all-unparsed output path end to end (rsg_run -> GREP_DETAIL extraction -> mec_check)
# instead of fabricating a detail line (WO-HARNESS-MANIFEST-EVIDENCE-FALSE-POSITIVES-01).
RSG_CORE="$(extract_core "$CANONICAL_YAML" rsg)"
if [ -z "$RSG_CORE" ]; then
  echo "FATAL: could not extract rsg core from $CANONICAL_YAML"; exit 1
fi
eval "$RSG_CORE"
for fn in rsg_extract rsg_run; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: mec core byte-identical across all 12 lanes ---"
for lane in $LANES; do
  assert_eq "mec parity $lane" "$MEC_CORE" "$(extract_core "$DEFAULTS/$lane" mec)"
done

echo "--- Parity: sme core byte-identical across all 12 lanes ---"
for lane in $LANES; do
  assert_eq "sme parity $lane" "$SME_CORE" "$(extract_core "$DEFAULTS/$lane" sme)"
done

# --- Manifest fixtures ------------------------------------------------------
GOOD='WO: WO-X
Builder: Smart Cauldron (bdc-feature-development-codex)
Files created: a.js
Files modified: b.js
Tests: 27/27 (cd shopops-api && node tests/run_all.js --suite=cgc_dealer)
PRs: https://github.com/thinmansoftware/shopops/pull/674
Merge ancestors: 1c6e...c4f9 (behind_by=0)
Grep assertions: grep -c "a" b.js => 1; grep -c "c" a.js => 2
Runtime verification: N/A
VALIDATION: PASS
Stop conditions: tests=passed; greps=passed'

# Verbatim event-store fixture, run 06b3c82c (bdc-xo, 2026-09-22): the false positive.
# A declared custom script ran and exited 0 but printed no parseable pass/total counts.
UNPARSED_TESTS_LINE='N/A (test command exited 0 but pass/total could not be parsed from its output: node docs/design/build-a-box-three-styles/build.cjs; node docs/design/build-a-box-three-styles/verify.cjs)'
UNPARSED_OK="$(printf '%s\n' "$GOOD" | sed "s|^Tests:.*|Tests: ${UNPARSED_TESTS_LINE}|")"

# Verbatim event-store fixture, run f83034d9 (shopops): the correct refusal. The
# spec-declared command exited 1 with no parseable counts -- must STILL fail.
FAILED_TESTS_LINE='N/A (spec-declared test command exited 1 with no parseable counts: cd shopops-api && node tests/test_receiving_session.js) -- FAILED'
FAILED_TESTS="$(printf '%s\n' "$GOOD" | sed "s|^Tests:.*|Tests: ${FAILED_TESTS_LINE}|; s|^VALIDATION:.*|VALIDATION: FAIL|")"

NA_GREPS="$(printf '%s\n' "$GOOD" | sed 's|^Grep assertions:.*|Grep assertions: N/A (no declared mechanical assertions)|')"

run_check() {
  # run_check <manifest> <status> <class> <tests_status> <tests_exit> \
  #           <grep_declared> <grep_executed> <grep_dropped> <grep_unparsed> \
  #           <grep_mismatch> <grep_status> [grep_detail]
  # -> "<rc>|<stdout>|<stderr>"
  local manifest="$1"; shift
  local out err rc
  err="$(mktemp)"
  out="$(printf '%s\n' "$manifest" | mec_check "$@" 2>"$err")"; rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
}

echo "--- Test 1: exit-zero unparsed counts is admitted (the false positive) ---"
# PROCEED, CODE, counts_unparsed, tests_exit=0, no declared greps.
R="$(run_check "$UNPARSED_OK" PROCEED CODE counts_unparsed 0 0 0 0 0 0 none_declared "")"
assert_eq "rc 0 / OK" "0|OK|" "$R"

echo "--- Test 2: failed command is still refused (the correct refusal) ---"
R="$(run_check "$FAILED_TESTS" PROCEED CODE failed 1 0 0 0 0 0 none_declared "")"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "error is an EVIDENCE_ERROR on the Tests line" "EVIDENCE_ERROR: Tests:" "$R"

echo "--- Test 3: counts_unparsed with nonzero exit is refused ---"
R="$(run_check "$UNPARSED_OK" PROCEED CODE counts_unparsed 1 0 0 0 0 0 none_declared "")"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "error is EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"

echo "--- Test 3b: MIXED behaves like CODE for the exit-0 admission ---"
R="$(run_check "$UNPARSED_OK" PROCEED MIXED counts_unparsed 0 0 0 0 0 0 none_declared "")"
assert_eq "MIXED exit-0 unparsed admitted" "0|OK|" "$R"

echo "--- Test 4: partial greps admitted, unparsed names published on the Stop line ---"
# mec admits grep_status=incomplete when >=1 executed and no mismatch.
R="$(run_check "$GOOD" PROCEED CODE passed 0 3 2 0 1 0 incomplete "")"
assert_eq "incomplete admitted rc 0" "0|OK|" "$R"
# stamp-manifest-evidence composes the Stop conditions line with the unparsed names.
INCOMPLETE_GREP_LINE='grep -c "a" b.js => 1; grep -c "c" a.js => 2; UNVERIFIED (unparsed): grep the export exists'
STAMPED="$(printf '%s\n' "$GOOD" | sme_process "27/27 (node t.js)" passed "$INCOMPLETE_GREP_LINE" incomplete 1 0)"
assert_contains "Stop conditions line carries unparsed=" "unparsed=" "$STAMPED"
assert_contains "Stop conditions line names the unparsed condition" "unparsed=grep the export exists" "$STAMPED"
assert_contains "Stop conditions line carries dropped count" "dropped=0" "$STAMPED"
assert_contains "incomplete is not stamped as a validation failure" "VALIDATION: PASS" "$STAMPED"

echo "--- Test 4b: incomplete must carry consistent inputs or it fails closed ---"
# grep_status=incomplete is trusted ONLY when grep_executed>=1 and grep_mismatch=0.
# A missing/inconsistent upstream (executed=0 or mismatch>0 under an 'incomplete'
# label) fails closed rather than being admitted on the status string alone.
R="$(run_check "$GOOD" PROCEED CODE passed 0 3 0 0 3 0 incomplete "")"
assert_eq "incomplete + executed=0 rc 1" "1" "${R%%|*}"
assert_contains "incomplete + executed=0 is EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_contains "incomplete + executed=0 names grep_executed" "grep_executed=0" "$R"
R="$(run_check "$GOOD" PROCEED CODE passed 0 3 2 0 1 1 incomplete "")"
assert_eq "incomplete + mismatch>0 rc 1" "1" "${R%%|*}"
assert_contains "incomplete + mismatch>0 is EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_contains "incomplete + mismatch>0 names grep_mismatch" "grep_mismatch=1" "$R"
R="$(run_check "$GOOD" PROCEED CODE passed 0 3 "" 0 3 "" incomplete "")"
assert_eq "incomplete + missing executed/mismatch rc 1" "1" "${R%%|*}"
assert_contains "incomplete + missing inputs is EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"

# mec_grep_detail <GREPS_OUT>  -- verbatim replica of the manifest-evidence-check
# node body's GREP_DETAIL extraction (the sed|grep that feeds mec_check's grep_detail
# arg). Kept in lockstep with the node body line in every lane.
mec_grep_detail() {
  printf '%s\n' "$1" | sed -n '/--- per-assertion detail ---/,$p' | grep -E '^(DROPPED|MISMATCH|UNPARSED)' || true
}

echo "--- Test 5: zero executed greps is a SPEC_DEFECT, not an EVIDENCE_ERROR ---"
# Fixture A: the REAL all-unparsed path. A spec whose only grep stop condition is a
# header with no parseable expectation is UNPARSED (not DROPPED): rsg_run must carry
# its name into the per-assertion detail so the node's GREP_DETAIL extraction preserves
# it and mec's SPEC_DEFECT can name it. Exercised end to end (no fabricated detail).
ALL_UNPARSED_SPEC='# WO-X

WO Class: CODE

## 8. Stop conditions (CI-executable)

Stop 1 (grep assertion, header without an Expected line):
  grep -c widgetFactory src/app.js
'
GREPS_OUT_A="$(printf '%s\n' "$ALL_UNPARSED_SPEC" | rsg_extract | rsg_run)"
assert_contains "fixture A rsg_run reports all_dropped" "GREP_STATUS=all_dropped" "$GREPS_OUT_A"
assert_contains "fixture A rsg_run declared exactly one condition" "GREP_DECLARED=1" "$GREPS_OUT_A"
assert_contains "fixture A rsg_run executed nothing" "GREP_EXECUTED=0" "$GREPS_OUT_A"
DETAIL_A="$(mec_grep_detail "$GREPS_OUT_A")"
assert_contains "fixture A per-assertion detail names the UNPARSED condition" "grep -c widgetFactory src/app.js" "$DETAIL_A"
DECLARED_A="$(mec_field GREP_DECLARED "$GREPS_OUT_A")"
EXECUTED_A="$(mec_field GREP_EXECUTED "$GREPS_OUT_A")"
UNPARSED_A="$(mec_field GREP_UNPARSED "$GREPS_OUT_A")"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 0 "$DECLARED_A" "$EXECUTED_A" 0 "$UNPARSED_A" 0 all_dropped "$DETAIL_A")"
assert_eq "fixture A rc 1" "1" "${R%%|*}"
assert_contains "fixture A prefix is SPEC_DEFECT" "SPEC_DEFECT:" "$R"
assert_not_contains "fixture A does not blame builder with EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_contains "fixture A names the real all-unparsed condition" "grep -c widgetFactory src/app.js" "$R"
# Fixture B: 1 declared, allowlist-refused (event-store 'all_dropped', dropped=1).
DETAIL_B='DROPPED (not on read-only allowlist; not executed): curl https://x => expected 200'
R="$(run_check "$NA_GREPS" PROCEED INFRA not_required 0 1 0 1 0 0 all_dropped "$DETAIL_B")"
assert_eq "fixture B rc 1" "1" "${R%%|*}"
assert_contains "fixture B prefix is SPEC_DEFECT" "SPEC_DEFECT:" "$R"
assert_contains "fixture B carries the DROPPED reason" "not on read-only allowlist" "$R"

echo "--- Test 6: executed grep with a failing count is still refused (mismatch) ---"
R="$(run_check "$GOOD" PROCEED CODE passed 0 2 2 0 0 1 mismatch "MISMATCH: grep -c x a.js => 0 (expected >= 1)")"
assert_eq "mismatch rc 1" "1" "${R%%|*}"
assert_contains "mismatch is EVIDENCE_ERROR" "EVIDENCE_ERROR" "$R"
assert_not_contains "mismatch is NOT a SPEC_DEFECT" "SPEC_DEFECT" "$R"

echo "--- Test 6b: passed greps + real numbers -> OK (unchanged happy path) ---"
R="$(run_check "$GOOD" PROCEED CODE passed 0 9 9 0 0 0 passed "")"
assert_eq "passed OK" "0|OK|" "$R"

echo "--- Regression: missing run-stop-greps output fails closed independently of class ---"
MISSING_GREPS="$(printf '%s\n' "$GOOD" | sed 's|^Grep assertions:.*|Grep assertions: MISSING (run-stop-greps produced no output)|')"
R="$(run_check "$MISSING_GREPS" PROCEED INFRA not_required 0 "" "" "" "" "" "" "")"
assert_eq "missing grep output rc 1" "1" "${R%%|*}"
assert_contains "names missing grep evidence" "run-stop-greps produced no output (grep_status=missing)" "$R"

echo "--- Regression: numeric Tests line + passed greps -> OK ---"
R="$(run_check "$GOOD" PROCEED CODE passed 0 2 2 0 0 0 passed "")"
assert_eq "numeric OK" "0|OK|" "$R"

echo "--- Regression: empty class defaults to CODE; a failed Tests line still refused ---"
R="$(run_check "$FAILED_TESTS" PROCEED "" failed 1 0 0 0 0 0 none_declared "")"
assert_eq "empty class rc 1" "1" "${R%%|*}"

echo "--- Regression: INFRA / DOCUMENTATION with Tests: N/A-shaped line and no greps -> OK ---"
INFRA_NA="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: N/A (INFRA class, no test command declared)|')"
R="$(run_check "$INFRA_NA" PROCEED INFRA not_required "" 0 0 0 0 0 none_declared "")"
assert_eq "INFRA OK" "0|OK|" "$R"
R="$(run_check "$INFRA_NA" PROCEED DOCUMENTATION not_required "" 0 0 0 0 0 none_declared "")"
assert_eq "DOCUMENTATION OK" "0|OK|" "$R"

echo "--- Regression: failing tests are NOT blocked here (stamped honestly upstream) ---"
R="$(run_check "$FAILED_TESTS" PROCEED CODE failed 1 9 9 0 0 0 passed "")"
# CODE + failed tests -> mec refuses (Tests line is not numeric and not exit-0 unparsed).
assert_eq "CODE failed tests rc 1" "1" "${R%%|*}"

echo "--- Regression: non-PROCEED paths are not gated ---"
R="$(run_check "$UNPARSED_OK" ALREADY_SATISFIED CODE "" "" 0 0 0 0 0 "" "")"
assert_eq "ALREADY_SATISFIED OK" "0|OK|" "$R"
R="$(run_check "$UNPARSED_OK" BLOCKED CODE "" "" 0 0 0 0 0 "" "")"
assert_eq "BLOCKED OK" "0|OK|" "$R"
R="$(run_check "$UNPARSED_OK" "" CODE "" "" 0 0 0 0 0 "" "")"
assert_eq "empty status OK" "0|OK|" "$R"

echo "--- Regression: short manifest (no Tests: line) is not gated ---"
R="$(run_check "$(printf 'WO: WO-X\nOUTCOME=ALREADY_SATISFIED\nVALIDATION: PASS')" PROCEED CODE "" "" 0 0 0 0 0 "" "")"
assert_eq "short manifest OK" "0|OK|" "$R"

echo "--- mec_field / sme_field ---"
assert_eq "TESTS_CLASS" "CODE" "$(mec_field TESTS_CLASS "$(printf 'TESTS_CLASS=CODE\nTESTS_STATUS=passed')")"
assert_eq "GREP_DECLARED" "9" "$(mec_field GREP_DECLARED "$(printf 'GREP_DECLARED=9\nGREP_STATUS=passed')")"
assert_eq "GREP_MISMATCH" "1" "$(mec_field GREP_MISMATCH "$(printf 'GREP_MISMATCH=1\nGREP_STATUS=mismatch')")"
assert_eq "TESTS_EXIT" "0" "$(mec_field TESTS_EXIT "$(printf 'TESTS_EXIT=0\nTESTS_STATUS=counts_unparsed')")"
assert_eq "missing -> empty" "" "$(mec_field GREP_DECLARED "")"
assert_eq "sme_field GREP_DROPPED" "2" "$(sme_field GREP_DROPPED "$(printf 'GREP_DROPPED=2\nGREP_STATUS=incomplete')")"

echo "--- Test 7: idempotency -- running the parity extraction twice is stable ---"
assert_eq "mec core extraction idempotent" "$MEC_CORE" "$(extract_core "$CANONICAL_YAML" mec)"
assert_eq "sme core extraction idempotent" "$SME_CORE" "$(extract_core "$CANONICAL_YAML" sme)"

echo
echo "manifest-evidence-check.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
