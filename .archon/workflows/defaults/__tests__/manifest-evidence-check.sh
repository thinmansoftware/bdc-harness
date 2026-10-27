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
export NODE_ENV=test
export SER_TEST_TRUSTED_ROOT="$(cd "$HERE/../../../.." && pwd)"
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

echo "--- Test 7b: incomplete evidence with dropped=2 is refused ---"
R="$(run_check "$GOOD" PROCEED CODE passed 5 incomplete 0 2 2 1 0)"
assert_eq "dropped incomplete rc 1" "1" "${R%%|*}"
assert_contains "STOP_GREP_REJECTED names the drop" "STOP_GREP_REJECTED:" "$R"

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

echo "--- unresolved selected-stage greps fail closed in every mec core ---"
for lane in $LANES; do
  if (
    unset SER_REQUIRE_ATTEMPT
    eval "$(extract_core "$DEFAULTS/$lane" mec)"
    err="$(mktemp)"
    out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 incomplete 0 0 0 1 0 2>"$err")"
    rc=$?
    printf '%s' "$out" | grep -q OK && exit 1
    [ "$rc" -eq 1 ] || exit 1
    grep -q 'EVIDENCE_ERROR' "$err" || exit 1
    rm -f "$err"
  ); then
    PASS=$((PASS + 1)); echo "PASS: unresolved mec $lane"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: unresolved mec $lane"
  fi
done

R="$(run_check "$NA_GREPS" PROCEED CODE passed 0 none_declared)"
assert_eq "none_declared zero declarations stay OK" "0|OK|" "$R"

prepare_passing_attempt() {
  local repo="$1" art="$2" run_id="$3"
  git -C "$repo" init -q
  git -C "$repo" config user.email t@example.com
  git -C "$repo" config user.name Test
  printf 'base\n' > "$repo/README"
  printf 'v1\n' > "$repo/src.js"
  git -C "$repo" add README src.js
  git -C "$repo" commit -qm base
  cat > "$repo/ok.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
  chmod +x "$repo/ok.sh"
  printf 'bash ./ok.sh\n' > "$repo/cmds"
  (
    cd "$repo" || exit 1
    ARTIFACTS_DIR="$art" SER_RUN_ID="$run_id" SER_REPO="thinmansoftware/bdc-harness" \
      ser_runner run-tests --commands ./cmds --log "$art/stop-tests.log" >/dev/null
    ARTIFACTS_DIR="$art" SER_RUN_ID="$run_id" SER_REPO="thinmansoftware/bdc-harness" \
      printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
  )
}

mec_at() {
  local repo="$1" art="$2" run_id="$3" repo_name="$4"
  (
    cd "$repo" || exit 1
    export ARTIFACTS_DIR="$art" SER_REQUIRE_ATTEMPT=1 SER_RUN_ID="$run_id"
    if [ -n "$repo_name" ]; then export SER_REPO="$repo_name"; else unset SER_REPO; fi
    err="$(mktemp)"
    out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 none_declared 0 0 0 0 0 2>"$err")"
    rc=$?
    printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
    rm -f "$err"
  )
}

echo "--- attempt binding and mixed counts through manifest gate ---"
BIND="$(mktemp -d)"
BIND_ART="$(mktemp -d)"
prepare_passing_attempt "$BIND" "$BIND_ART" run-a
R="$(mec_at "$BIND" "$BIND_ART" run-a "")"
assert_eq "blank live repo stays OK" "0|OK|" "$R"
R="$(mec_at "$BIND" "$BIND_ART" run-a thinmansoftware/other)"
assert_eq "conflicting SER_REPO rc" "1" "${R%%|*}"
assert_not_contains "conflicting SER_REPO is not OK" "OK" "$R"
assert_contains "conflicting SER_REPO names authority" "authority-repo" "$R"
git -C "$BIND" commit --allow-empty -qm "identical tested bytes"
R="$(mec_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness)"
assert_eq "identical-tree descendant stays OK" "0|OK|" "$R"
R="$(mec_at "$BIND" "$BIND_ART" run-b thinmansoftware/bdc-harness)"
assert_eq "cross-run replay rc" "1" "${R%%|*}"
assert_not_contains "cross-run replay is not OK" "OK" "$R"
assert_contains "cross-run replay names run-id" "run-id" "$R"
TEST_ID="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-tests")"
GREP_ID="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-greps")"
R="$(
  cd "$BIND" || exit 1
  export ARTIFACTS_DIR="$BIND_ART" SER_REQUIRE_ATTEMPT=1 SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness
  export SER_TEST_ATTEMPT_ID="$GREP_ID" SER_GREP_ATTEMPT_ID="$TEST_ID"
  err="$(mktemp)"
  out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 none_declared 0 0 0 0 0 2>"$err")"
  rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
)"
assert_eq "wrong-kind ids rc" "1" "${R%%|*}"
assert_contains "wrong-kind ids name kind" "attempt-kind" "$R"
python3 - "$BIND_ART" <<'PY'
import json, pathlib, sys
art = pathlib.Path(sys.argv[1]) / "evidence" / "attempts"
tid = (art / "current-tests").read_text().strip()
path = art / f"{tid}.json"
data = json.loads(path.read_text())
data["members"][0]["status"] = "INCOMPLETE"
data["members"][0]["reason"] = "planned"
data["aggregate"] = "INCOMPLETE"
path.write_text(json.dumps(data))
PY
R="$(mec_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness)"
assert_eq "incomplete test member rc" "1" "${R%%|*}"
assert_not_contains "incomplete test member is not OK" "OK" "$R"
assert_contains "incomplete test member reason prefixed tests:" "tests:" "$R"
printf 'v2\n' > "$BIND/src.js"
(
  cd "$BIND" || exit 1
  ARTIFACTS_DIR="$BIND_ART" SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness \
    printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
)
R="$(mec_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness)"
assert_eq "stale tests plus later greps rc" "1" "${R%%|*}"
assert_not_contains "stale tests plus later greps are not OK" "OK" "$R"
assert_contains "stale tests reason prefixed tests:" "tests:" "$R"

MIX="$(mktemp -d)"
MIX_ART="$(mktemp -d)"
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
chmod +x "$MIX/ok.sh" "$MIX/nocount.sh" "$MIX/zero.sh"
printf 'bash ./ok.sh\nbash ./nocount.sh\n' > "$MIX/cmds"
( cd "$MIX" && ARTIFACTS_DIR="$MIX_ART" ser_runner run-tests --commands ./cmds --log "$MIX_ART/nc.log" >/dev/null )
R="$(
  cd "$MIX" || exit 1
  export ARTIFACTS_DIR="$MIX_ART" SER_REQUIRE_ATTEMPT=1
  err="$(mktemp)"
  out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE counts_unparsed 0 none_declared 0 0 0 0 0 2>"$err")"
  rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
)"
assert_eq "pass plus no-count rc" "1" "${R%%|*}"
assert_not_contains "pass plus no-count is not OK" "OK" "$R"
printf 'bash ./ok.sh\nbash ./zero.sh\n' > "$MIX/cmds"
( cd "$MIX" && ARTIFACTS_DIR="$MIX_ART" ser_runner run-tests --commands ./cmds --log "$MIX_ART/zero.log" >/dev/null )
R="$(
  cd "$MIX" || exit 1
  export ARTIFACTS_DIR="$MIX_ART" SER_REQUIRE_ATTEMPT=1
  err="$(mktemp)"
  out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 none_declared 0 0 0 0 0 2>"$err")"
  rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
)"
assert_eq "pass plus 0/0 rc" "1" "${R%%|*}"
assert_not_contains "pass plus 0/0 is not OK" "OK" "$R"
echo "--- round-9 byte identity and explicit Expected through manifest gate ---"
eval "$(extract_core "$CANONICAL_YAML" rst)"
NA="$(mktemp -d)"
NA_ART="$(mktemp -d)"
git -C "$NA" init -q
git -C "$NA" config user.email t@example.com
git -C "$NA" config user.name Test
printf 'base\n' > "$NA/README"
printf 'v1\n' > "$NA/src.js"
python3 - "$NA" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / "caf\u00e9.js").write_text("v1\n")
PY
git -C "$NA" add -A
git -C "$NA" commit -qm base
cat > "$NA/ok.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
chmod +x "$NA/ok.sh"
printf 'bash ./ok.sh\n' > "$NA/cmds"
(
  cd "$NA" || exit 1
  ARTIFACTS_DIR="$NA_ART" SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness \
    ser_runner run-tests --commands ./cmds --log "$NA_ART/stop-tests.log" >/dev/null
  ARTIFACTS_DIR="$NA_ART" SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness \
    printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
)
python3 - "$NA" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / "caf\u00e9.js").write_text("v2\n")
PY
R="$(mec_at "$NA" "$NA_ART" run-a thinmansoftware/bdc-harness)"
assert_eq "stale non-ASCII bytes rc" "1" "${R%%|*}"
assert_not_contains "stale non-ASCII bytes are not OK" "OK" "$R"

BAD="$(mktemp -d)"
BAD_ART="$(mktemp -d)"
cat > "$BAD/ok.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
chmod +x "$BAD/ok.sh"
printf 'MALFORMED:expected-without-command\nbash ./ok.sh\n' > "$BAD/cmds"
( cd "$BAD" && ARTIFACTS_DIR="$BAD_ART" SER_RUN_ID=run-bad ser_runner run-tests --commands ./cmds --log "$BAD_ART/stop-tests.log" >/dev/null )
R="$(
  cd "$BAD" || exit 1
  export ARTIFACTS_DIR="$BAD_ART" SER_REQUIRE_ATTEMPT=1 SER_RUN_ID=run-bad
  unset SER_REPO
  err="$(mktemp)"
  out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 none_declared 0 0 0 0 0 2>"$err")"
  rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
)"
assert_eq "malformed explicit member rc" "1" "${R%%|*}"
assert_not_contains "malformed explicit member is not OK" "OK" "$R"

MAP="$(mktemp -d)"
MAP_ART="$(mktemp -d)"
git -C "$MAP" init -q
git -C "$MAP" config user.email t@example.com
git -C "$MAP" config user.name Test
printf 'base\n' > "$MAP/README"
git -C "$MAP" add README
git -C "$MAP" commit -qm base
cat > "$MAP/map-pass.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
chmod +x "$MAP/map-pass.sh"
MAP_SPEC="$(printf '%s\n' 'Stop 1 (grep assertion):' '  grep -c base README' '  Expected: 1')"
MAP_CMDS="$MAP/cmds"
MAP_DECL="$(
  cd "$MAP" || exit 1
  printf '%s\n' "$MAP_SPEC" | rst_load_explicit "$MAP_CMDS"
)"
assert_eq "manifest absence declaration flag" "0" "$MAP_DECL"
MAP_SRC="$(
  cd "$MAP" || exit 1
  rst_apply_fallback "$MAP_CMDS" "" project-map "bash ./map-pass.sh"
)"
assert_eq "manifest absence selects project-map" "project-map" "$MAP_SRC"
(
  cd "$MAP" || exit 1
  ARTIFACTS_DIR="$MAP_ART" SER_RUN_ID=run-map \
    ser_runner run-tests --commands "$MAP_CMDS" --log "$MAP_ART/stop-tests.log" >/dev/null
)
R="$(
  cd "$MAP" || exit 1
  export ARTIFACTS_DIR="$MAP_ART" SER_REQUIRE_ATTEMPT=1 SER_RUN_ID=run-map
  unset SER_REPO
  err="$(mktemp)"
  out="$(printf '%s\n' "$GOOD" | mec_check PROCEED CODE passed 0 none_declared 0 0 0 0 0 2>"$err")"
  rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
)"
assert_eq "true-absence project-map stays OK" "0|OK|" "$R"
rm -rf "$NA" "$NA_ART" "$BAD" "$BAD_ART" "$MAP" "$MAP_ART"

unset SER_REQUIRE_ATTEMPT ARTIFACTS_DIR SER_RUN_ID SER_REPO SER_TEST_ATTEMPT_ID SER_GREP_ATTEMPT_ID
rm -rf "$BIND" "$BIND_ART" "$MIX" "$MIX_ART"

echo
echo "manifest-evidence-check.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
