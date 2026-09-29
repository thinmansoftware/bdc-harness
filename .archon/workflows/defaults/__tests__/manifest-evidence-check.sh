#!/usr/bin/env bash
# manifest-evidence-check.sh -- unit tests for the manifest-evidence-check node core
# (mec_*) in .archon/workflows/defaults/bdc-feature-development-codex.yaml and its
# byte-identical mirrors in the other 11 bdc-feature-development lanes.
#
# bdc-xo #1940: manifest-evidence-check fails CLOSED when a CODE or MIXED WO would
# publish "Tests: N/A ..." or when the spec declared grep stop conditions but the
# manifest's "Grep assertions:" line is N/A. patch-pr-body is gated on its "OK".
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
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected: $needle"; echo "  haystack:   $haystack"
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
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

extract_call() {
  tr -d '\r' < "$1" | awk -v fn="$2" '
    index($0, "| " fn " ") { c = 1 }
    c && NF == 0 { exit }
    c
  ' | sed 's/^      //'
}

MEC_CORE="$(extract_core "$CANONICAL_YAML" mec)"
SME_CORE="$(extract_core "$CANONICAL_YAML" sme)"
if [ -z "$MEC_CORE" ]; then
  echo "FATAL: could not extract mec core from $CANONICAL_YAML"; exit 1
fi
eval "$MEC_CORE"
eval "$SME_CORE"
for fn in mec_field mec_check sme_field sme_process; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: mec core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$MEC_CORE" "$(extract_core "$DEFAULTS/$lane" mec)"
done

echo "--- Parity: sme core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "sme parity $lane" "$SME_CORE" "$(extract_core "$DEFAULTS/$lane" sme)"
done

echo "--- Parity: evidence call sites byte-identical across all 13 lanes ---"
SME_CALL="$(extract_call "$CANONICAL_YAML" sme_process)"
MEC_CALL="$(extract_call "$CANONICAL_YAML" mec_check)"
for lane in $LANES; do
  assert_eq "sme call parity $lane" "$SME_CALL" "$(extract_call "$DEFAULTS/$lane" sme_process)"
  assert_eq "mec call parity $lane" "$MEC_CALL" "$(extract_call "$DEFAULTS/$lane" mec_check)"
done

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
NA_TESTS="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: N/A (required gates are reported separately)|')"
NA_GREPS="$(printf '%s\n' "$GOOD" | sed 's|^Grep assertions:.*|Grep assertions: N/A (no declared mechanical assertions)|')"
FAILED_TESTS="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: 6/8 (node t.js) -- FAILED, exit 1|; s|^VALIDATION:.*|VALIDATION: FAIL|')"

run_check() {
  # run_check <manifest> <status> <class> <tests_status> <grep_declared> <grep_status> [new mec args...]
  # -> "<rc>|<stdout>|<stderr>"
  local out err rc
  err="$(mktemp)"
  out="$(printf '%s\n' "$1" | mec_check "$2" "$3" "$4" "$5" "$6" "${7:-}" "${8:-0}" "${9:-0}" "${10:-0}" "${11:-0}" "${12:-}" 2>"$err")"; rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
}

echo "--- Test 1: PROCEED CODE with real numbers and executed greps -> OK ---"
R="$(run_check "$GOOD" PROCEED CODE passed 9 passed)"
assert_eq "rc 0 / OK" "0|OK|" "$R"

echo "--- Test 2: PROCEED CODE with Tests: N/A -> EVIDENCE_ERROR rc 1 ---"
R="$(run_check "$NA_TESTS" PROCEED CODE no_command_declared 9 passed)"
assert_eq "rc 1, no OK on stdout" "1" "${R%%|*}"
assert_contains "error names the placeholder and the class" 'EVIDENCE_ERROR: Tests: "N/A (required gates are reported separately)" on a CODE WO (tests_status=no_command_declared)' "$R"
assert_contains "error cites the rule" "Rule 10" "$R"

echo "--- Test 3: PROCEED MIXED with Tests: N/A -> error ---"
R="$(run_check "$NA_TESTS" PROCEED MIXED counts_unparsed 0 none_declared)"
assert_eq "rc 1" "1" "${R%%|*}"

echo "--- Test 4: empty class defaults to CODE (doctrine default) -> error on N/A ---"
R="$(run_check "$NA_TESTS" PROCEED "" "" 0 "")"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "reports missing tests_status" "tests_status=missing" "$R"

echo "--- Test 5: INFRA / DOCUMENTATION with Tests: N/A and no greps -> OK ---"
R="$(run_check "$NA_TESTS" PROCEED INFRA not_required 0 none_declared)"
assert_eq "INFRA OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" PROCEED DOCUMENTATION not_required 0 none_declared)"
assert_eq "DOCUMENTATION OK" "0|OK|" "$R"

echo "--- Test 6: declared allowlist-dropped greps -> HARNESS_REFUSED (any class) ---"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 9 all_dropped 0 0 9 0 0 'DROPPED (not on read-only allowlist; not executed): grep -c x f')"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "error names the declared count" "9 grep stop condition(s) were declared but none executed" "$R"
assert_contains "all_dropped attributed to harness" "HARNESS_REFUSED:" "$R"
R="$(run_check "$NA_GREPS" PROCEED INFRA not_required 2 all_dropped 0 0 2)"
assert_eq "INFRA with declared greps and N/A also rc 1" "1" "${R%%|*}"

echo "--- Test 7: no greps declared, Grep assertions: N/A -> OK ---"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 0 none_declared)"
assert_eq "rc 0 / OK" "0|OK|" "$R"

# WO-HARNESS-STOP-GREP-QUOTED-FAIL-CLOSED-01 REVERSES this case. A declared stop
# grep the allowlist REJECTED is not evidence, so incomplete WITH grep_dropped > 0
# is refused and every rejected command is named. Incomplete caused ONLY by
# unparsed prose (dropped 0) is still admitted -- see Test FP-4 and Test 11.
echo "--- Test 7b: declared greps incomplete WITH dropped -> refused ---"
R="$(run_check "$GOOD" PROCEED CODE passed 5 incomplete 0 2 2 1 0 'DROPPED (not on read-only allowlist; not executed): grep -c '"'"'a b'"'"' f => expected eq 1')"
assert_eq "incomplete greps with dropped now refused" "1" "${R%%|*}"
assert_contains "refusal is HARNESS_REFUSED" "HARNESS_REFUSED" "$R"
assert_contains "refusal names the rejected command" "STOP_GREP_REJECTED: grep -c 'a b' f" "$R"

echo "--- Test 7c: declared greps with a mismatch -> error ---"
R="$(run_check "$GOOD" PROCEED CODE passed 5 mismatch 0 5 0 0 1)"
assert_eq "mismatched greps rc 1" "1" "${R%%|*}"
assert_contains "error names mismatch grep status" "grep_status=mismatch" "$R"

echo "--- Test 7d: missing run-stop-greps output fails closed independently of class ---"
MISSING_GREPS="$(printf '%s\n' "$NA_TESTS" | sed 's|^Grep assertions:.*|Grep assertions: MISSING (run-stop-greps produced no output)|')"
R="$(run_check "$MISSING_GREPS" PROCEED INFRA not_required "" "")"
assert_eq "missing grep output rc 1" "1" "${R%%|*}"
assert_contains "error names missing grep evidence" "run-stop-greps produced no output (grep_status=missing)" "$R"

echo "--- Test 8: failing tests remain fail-closed ---"
R="$(run_check "$FAILED_TESTS" PROCEED CODE failed 9 passed 1 9 0 0 0)"
assert_eq "failed tests rc 1" "1" "${R%%|*}"

echo "--- Test FP-1: exit-zero unparsed counts admitted ---"
FP_TESTS="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: N/A (test command exited 0 but pass/total could not be parsed from its output: node docs/design/build-a-box-three-styles/build.cjs; ...)|')"
R="$(run_check "$FP_TESTS" PROCEED CODE counts_unparsed 0 none_declared 0 0 0 0 0)"
assert_eq "FP-1 exit-zero counts_unparsed" "0|OK|" "$R"

echo "--- Test FP-2: failed no-count command refused ---"
FP_FAILED="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: N/A (spec-declared test command exited 1 with no parseable counts: cd shopops-api \&\& node tests/test_receiving_session.js) -- FAILED|')"
R="$(run_check "$FP_FAILED" PROCEED CODE failed 0 none_declared 1 0 0 0 0)"
assert_eq "FP-2 failed command rc" "1" "${R%%|*}"
assert_contains "FP-2 evidence error" "EVIDENCE_ERROR: Tests:" "$R"

echo "--- Test FP-3: counts_unparsed with nonzero exit refused ---"
R="$(run_check "$FP_TESTS" PROCEED CODE counts_unparsed 0 none_declared 1 0 0 0 0)"
assert_eq "FP-3 nonzero exit rc" "1" "${R%%|*}"

echo "--- Test FP-4: partial greps admitted and names stamped ---"
PARTIAL_LINE='grep -c x f => 1; UNVERIFIED (unparsed): prose condition one'
R="$(run_check "$GOOD" PROCEED CODE passed 3 incomplete 0 2 0 1 0)"
assert_eq "FP-4 partial greps admitted" "0|OK|" "$R"
STAMPED="$(printf '%s\n' "$GOOD" | sme_process '27/27 (cmd)' passed "$PARTIAL_LINE" incomplete 0)"
assert_contains "FP-4 unparsed names stamped" "unparsed=prose condition one; dropped=0" "$STAMPED"
assert_contains "FP-4 incomplete stamps validation pass" "VALIDATION: PASS" "$STAMPED"
assert_not_contains "FP-4 incomplete does not stamp validation fail" "VALIDATION: FAIL" "$STAMPED"

echo "--- Test FP-5: zero executed greps are SPEC_DEFECT and named ---"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 3 all_dropped 0 0 0 3 0 'UNVERIFIED (unparsed): prose one; prose two; prose three')"
assert_eq "FP-5 unparsed all_dropped rc" "1" "${R%%|*}"
assert_contains "FP-5 SPEC_DEFECT prefix" "SPEC_DEFECT:" "$R"
assert_not_contains "FP-5 unparsed is not HARNESS_REFUSED" "HARNESS_REFUSED:" "$R"
assert_contains "FP-5 names unparsed conditions" "prose one" "$R"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 1 all_dropped 0 0 1 0 0 'DROPPED (not on read-only allowlist; not executed): rm unsafe')"
assert_eq "FP-5 allowlist all_dropped rc" "1" "${R%%|*}"
assert_contains "FP-5 allowlist HARNESS_REFUSED prefix" "HARNESS_REFUSED:" "$R"
assert_not_contains "FP-5 allowlist is not SPEC_DEFECT" "SPEC_DEFECT:" "$R"
assert_contains "FP-5 allowlist reason named" "not on read-only allowlist; not executed" "$R"
ALL_DROPPED_STAMPED="$(printf '%s\n' "$GOOD" | sme_process '27/27 (cmd)' passed 'N/A (1 declared grep stop condition(s) but none executable under the read-only allowlist)' all_dropped 1)"
assert_contains "FP-5 all_dropped stamps validation fail" "VALIDATION: FAIL" "$ALL_DROPPED_STAMPED"

echo "--- Test FP-6: mismatch remains EVIDENCE_ERROR ---"
R="$(run_check "$GOOD" PROCEED CODE passed 2 mismatch 0 2 0 0 1)"
assert_contains "FP-6 mismatch evidence error" "EVIDENCE_ERROR:" "$R"
if printf '%s\n' "$R" | grep -Fq 'SPEC_DEFECT'; then FAIL=$((FAIL + 1)); echo "FAIL: FP-6 must not be SPEC_DEFECT"; else PASS=$((PASS + 1)); echo "PASS: FP-6 must not be SPEC_DEFECT"; fi

echo "--- Test FP-7: lane parity is deterministic ---"
assert_eq "FP-7 lane count" "13" "$(printf '%s\n' $LANES | grep -c .)"

echo "--- Test 9: non-PROCEED paths are not gated ---"
R="$(run_check "$NA_TESTS" ALREADY_SATISFIED CODE "" 0 "")"
assert_eq "ALREADY_SATISFIED OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" BLOCKED CODE "" 0 "")"
assert_eq "BLOCKED OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" "" CODE "" 0 "")"
assert_eq "empty status OK" "0|OK|" "$R"

echo "--- Test 10: short manifest (no Tests: line) is not gated ---"
R="$(run_check "$(printf 'WO: WO-X\nOUTCOME=ALREADY_SATISFIED\nVALIDATION: PASS')" PROCEED CODE "" 0 "")"
assert_eq "short manifest OK" "0|OK|" "$R"

echo "--- mec_field ---"
assert_eq "TESTS_CLASS" "CODE" "$(mec_field TESTS_CLASS "$(printf 'TESTS_CLASS=CODE\nTESTS_STATUS=passed')")"
assert_eq "GREP_DECLARED" "9" "$(mec_field GREP_DECLARED "$(printf 'GREP_DECLARED=9\nGREP_STATUS=passed')")"
assert_eq "missing -> empty" "" "$(mec_field GREP_DECLARED "")"

# =============================================================================
# WO-HARNESS-STOP-GREP-QUOTED-FAIL-CLOSED-01 -- a rejected stop grep FAILS the
# manifest-evidence gate and is named, instead of passing the run green with the
# stop condition silently skipped (bdc-harness issue 1047).
# =============================================================================
echo "--- Test 10: dropped-stop-grep-fails-the-gate-naming-the-command ---"
# Modelled on live run ea46da63: 5 declared, 1 executed, 4 dropped by the allowlist.
EA_DETAIL="$(printf '%s\n' \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'INSERT INTO stripe_webhook_events' shopops-api/routes/webhooks.js => expected eq 2" \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'paid_at) VALUES' shopops-api/routes/webhooks.js => expected eq 0" \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'ON CONFLICT (tenant_id, stripe_payment_id)' shopops-api/routes/webhooks.js => expected eq 2" \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'CREATE TABLE IF NOT EXISTS stripe_webhook_events' shopops-api/migrations/20260928_stripe_webhook_events_ledger.sql => expected eq 1")"
R="$(run_check "$GOOD" PROCEED CODE passed 5 incomplete 0 1 4 0 0 "$EA_DETAIL")"
assert_eq "T10 rc 1 (the live run went green; it must not)" "1" "${R%%|*}"
assert_contains "T10 HARNESS_REFUSED" "HARNESS_REFUSED" "$R"
assert_contains "T10 counts the rejections" "4 of 5 declared grep stop condition(s) were REJECTED" "$R"
assert_contains "T10 names dropped 1 verbatim" "STOP_GREP_REJECTED: grep -c 'INSERT INTO stripe_webhook_events' shopops-api/routes/webhooks.js" "$R"
assert_contains "T10 names dropped 2 verbatim" "STOP_GREP_REJECTED: grep -c 'paid_at) VALUES' shopops-api/routes/webhooks.js" "$R"
assert_contains "T10 names dropped 3 verbatim" "STOP_GREP_REJECTED: grep -c 'ON CONFLICT (tenant_id, stripe_payment_id)' shopops-api/routes/webhooks.js" "$R"
assert_contains "T10 names dropped 4 verbatim" "STOP_GREP_REJECTED: grep -c 'CREATE TABLE IF NOT EXISTS stripe_webhook_events' shopops-api/migrations/20260928_stripe_webhook_events_ledger.sql" "$R"
assert_eq "T10 emits exactly four STOP_GREP_REJECTED lines" "4" "$(printf '%s\n' "$R" | grep -c 'STOP_GREP_REJECTED:')"
assert_not_contains "T10 the expected-count suffix is stripped" "=> expected eq 2" "$(printf '%s\n' "$R" | grep 'STOP_GREP_REJECTED:' || true)"

echo "--- Test 10b: all_dropped also names every rejected command ---"
# Modelled on live run 8ab3032a: 3 declared, 0 executed, 3 dropped.
AD_DETAIL="$(printf '%s\n' \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'SET LOCAL app.tenant_id' shopops-api/migrations/20260706c_orderlines_exempt_inventory_ratio.sql => expected eq 1" \
  "DROPPED (not on read-only allowlist; not executed): grep -c 'SET LOCAL app.tenant_id' shopops-api/migrations/20260619_clear_unresolved_cover_sources.sql => expected eq 1" \
  "DROPPED (not on read-only allowlist; not executed): grep -c '^<<<<<<<' shopops-api/tests/test_ci_staging_migrations.js => expected eq 0")"
R="$(run_check "$GOOD" PROCEED CODE passed 3 all_dropped 0 0 3 0 0 "$AD_DETAIL")"
assert_eq "T10b rc 1" "1" "${R%%|*}"
assert_contains "T10b HARNESS_REFUSED" "HARNESS_REFUSED" "$R"
assert_eq "T10b emits exactly three STOP_GREP_REJECTED lines" "3" "$(printf '%s\n' "$R" | grep -c 'STOP_GREP_REJECTED:')"
assert_contains "T10b names the conflict-marker grep" "STOP_GREP_REJECTED: grep -c '^<<<<<<<' shopops-api/tests/test_ci_staging_migrations.js" "$R"

echo "--- Test 11: unparsed-only-incomplete-still-admitted ---"
R="$(run_check "$GOOD" PROCEED CODE passed 3 incomplete 0 2 0 1 0)"
assert_eq "T11 unparsed-only incomplete still admitted (FP-4 preserved)" "0|OK|" "$R"
R="$(run_check "$GOOD" PROCEED CODE passed 5 mismatch 0 5 0 0 1)"
assert_eq "T11 a mismatch input still refuses" "1" "${R%%|*}"
R="$(run_check "$GOOD" PROCEED CODE passed 5 incomplete 0 0 0 5 0)"
assert_eq "T11 an executed-0 incomplete input still refuses" "1" "${R%%|*}"
R="$(run_check "$GOOD" PROCEED CODE passed 0 none_declared)"
assert_eq "T11 no declared greps is untouched" "0|OK|" "$R"

echo "--- Test 11b: mec_rejected_lines parses only DROPPED lines ---"
MIXED="$(printf '%s\n' \
  "OK: grep -c alpha f => 2 (expected eq 2)" \
  "DROPPED (command errored): grep -c x missing.txt => expected ge 1" \
  "MISMATCH: grep -c beta f => 1 (expected eq 2)")"
OUT="$(mec_rejected_lines "$MIXED")"
assert_eq "T11b only the DROPPED line is reported" "1" "$(printf '%s\n' "$OUT" | grep -c 'STOP_GREP_REJECTED:')"
assert_contains "T11b errored-command reason prefix is stripped too" "STOP_GREP_REJECTED: grep -c x missing.txt" "$OUT"
assert_eq "T11b empty detail yields nothing" "" "$(mec_rejected_lines '')"

echo
echo "manifest-evidence-check.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
