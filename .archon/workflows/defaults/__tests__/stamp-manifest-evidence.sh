#!/usr/bin/env bash
# stamp-manifest-evidence.sh -- unit tests for the stamp-manifest-evidence node core
# (sme_*) in .archon/workflows/defaults/bdc-feature-development-codex.yaml and its
# byte-identical mirrors in the other 10 bdc-feature-development lanes.
#
# bdc-xo #1940: the engine-side build-manifest renders placeholder "Tests: N/A
# (required gates are reported separately)" and "Grep assertions: N/A (no declared
# mechanical assertions)" lines. stamp-manifest-evidence overwrites both with the
# observed values from run-stop-tests / run-stop-greps and flips VALIDATION to FAIL
# when a declared stop condition did not hold.
#
# Run: bash .archon/workflows/defaults/__tests__/stamp-manifest-evidence.sh
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
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected: $needle"
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
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

SME_CORE="$(extract_core "$CANONICAL_YAML" sme)"
if [ -z "$SME_CORE" ]; then
  echo "FATAL: could not extract sme core from $CANONICAL_YAML"; exit 1
fi
eval "$SME_CORE"

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
for fn in sme_field sme_process; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: sme core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$SME_CORE" "$(extract_core "$DEFAULTS/$lane" sme)"
done

# The REAL engine manifest from run 69f9d306 (shopops #674), event store, 2026-09-05.
ENGINE_MANIFEST='WO: WO-SHOPOPS-M157-CGC-DEALER-API-01
Builder: Smart Cauldron (bdc-feature-development-codex)
Files created: shopops-api/services/connect/providers/cgc-dealer-api.js, shopops-api/tests/test_cgc_dealer_api.js
Files modified: shopops-api/services/cert-lookup.js, shopops-api/routes/vault.js
Tests: N/A (required gates are reported separately)
PRs: N/A (committed)
Merge ancestors: 1c6e47a227fdc7b808a13734adf79ee43fd92d3f...c4f931587965b487d4caa6516ce9a99876daa1d8 (behind_by=0)
Grep assertions: N/A (no declared mechanical assertions)
Runtime verification: plan-review=PLAN_REVIEW_PASS=true; block-reclassify={"status":"PROCEED"}
VALIDATION: PASS
OUTCOME: execution=running; deliverable=committed; validation=passed; recovery=not_needed; route=current; reason=run_running'

TESTS_OUT='TESTS_CLASS=CODE
TESTS_COMMAND=cd shopops-api && node tests/test_cgc_dealer_api.js
TESTS_EXIT=0
TESTS_PASSED=8
TESTS_TOTAL=8
TESTS_STATUS=passed
TESTS_LINE=8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)
TESTS_LOG=/tmp/x/evidence/stop-tests.log'
GREPS_OUT='GREP_DECLARED=9
GREP_EXECUTED=8
GREP_DROPPED=1
GREP_MISMATCH=0
GREP_STATUS=passed
GREP_LINE=grep -c "cgc-dealer-api" shopops-api/services/cert-lookup.js => 1; grep -c "/comics/certifications" shopops-api/services/connect/providers/cgc-dealer-api.js => 2'

echo "--- sme_field ---"
assert_eq "TESTS_LINE" "8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)" "$(sme_field TESTS_LINE "$TESTS_OUT")"
assert_eq "GREP_STATUS" "passed" "$(sme_field GREP_STATUS "$GREPS_OUT")"
assert_eq "missing key -> empty" "" "$(sme_field NOPE "$TESTS_OUT")"
assert_eq "empty node output -> empty" "" "$(sme_field TESTS_LINE "")"

echo "--- Test 1: real engine manifest, all green ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "$(sme_field TESTS_LINE "$TESTS_OUT")" "$(sme_field TESTS_STATUS "$TESTS_OUT")" "$(sme_field GREP_LINE "$GREPS_OUT")" "$(sme_field GREP_STATUS "$GREPS_OUT")")"
assert_eq "Tests: line stamped with observed numbers" "Tests: 8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)" "$(printf '%s\n' "$OUT" | grep -E '^Tests:')"
assert_eq "Grep assertions: line stamped with observed counts" 'Grep assertions: grep -c "cgc-dealer-api" shopops-api/services/cert-lookup.js => 1; grep -c "/comics/certifications" shopops-api/services/connect/providers/cgc-dealer-api.js => 2' "$(printf '%s\n' "$OUT" | grep -E '^Grep assertions:')"
assert_not_contains "placeholder Tests text gone" "required gates are reported separately" "$OUT"
assert_not_contains "placeholder Grep text gone" "no declared mechanical assertions" "$OUT"
assert_contains "VALIDATION stays PASS" "VALIDATION: PASS" "$OUT"
assert_eq "Stop conditions audit line follows VALIDATION" "Stop conditions: tests=passed; greps=passed (observed by run-stop-tests / run-stop-greps in the run worktree)" "$(printf '%s\n' "$OUT" | grep -A1 '^VALIDATION:' | tail -1)"
assert_eq "line count = engine + 1 audit line" "12" "$(printf '%s\n' "$OUT" | grep -c .)"
assert_contains "OUTCOME line preserved" "OUTCOME: execution=running" "$OUT"
assert_contains "Merge ancestors preserved verbatim" "Merge ancestors: 1c6e47a227fdc7b808a13734adf79ee43fd92d3f...c4f931587965b487d4caa6516ce9a99876daa1d8 (behind_by=0)" "$OUT"

echo "--- Test 2: failing tests flip VALIDATION to FAIL ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "6/8 (cd shopops-api && node tests/test_cgc_dealer_api.js) -- FAILED, exit 1" failed "$(sme_field GREP_LINE "$GREPS_OUT")" passed)"
assert_contains "Tests line carries the red numbers" "Tests: 6/8 (cd shopops-api && node tests/test_cgc_dealer_api.js) -- FAILED, exit 1" "$OUT"
assert_contains "VALIDATION: FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "VALIDATION: PASS gone" "VALIDATION: PASS" "$OUT"
assert_contains "audit line says tests=failed" "Stop conditions: tests=failed; greps=passed" "$OUT"

echo "--- Test 3: grep mismatch flips VALIDATION to FAIL ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed 'grep -c "a" b => 0' mismatch)"
assert_contains "VALIDATION: FAIL on grep mismatch" "VALIDATION: FAIL" "$OUT"
assert_contains "audit line says greps=mismatch" "greps=mismatch" "$OUT"

# PR #876 / bdc-xo #2221 deliberately admits partial grep evidence when
# at least one assertion executes without mismatch; mec_check enforces counts.
echo "--- Test 3b: incomplete evidence with a dropped assertion fails validation ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed 'grep -c "a" b => 1; UNVERIFIED (unparsed): missing-rule' incomplete 1)"
assert_contains "VALIDATION: FAIL when dropped=1" "VALIDATION: FAIL" "$OUT"
assert_not_contains "dropped incomplete is not a pass" "VALIDATION: PASS" "$OUT"
assert_contains "omissions remain visible" "greps=incomplete; unparsed=missing-rule; dropped=1" "$OUT"
assert_contains "audit line says greps=incomplete" "greps=incomplete" "$OUT"

echo "--- Test 3c: all dropped greps remain failed ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed 'UNVERIFIED (unparsed): missing-rule' all_dropped 2)"
assert_contains "VALIDATION fails when no grep executed" "VALIDATION: FAIL" "$OUT"
assert_not_contains "all-dropped never preserves PASS" "VALIDATION: PASS" "$OUT"

echo "--- Test 4: short ALREADY_SATISFIED manifest passes through untouched ---"
SHORT='WO: WO-X
OUTCOME=ALREADY_SATISFIED
Files created: none
VALIDATION: PASS (verified no-op)'
OUT="$(printf '%s\n' "$SHORT" | sme_process "8/8 (x)" passed "N/A (spec declares no grep stop conditions)" none_declared)"
assert_eq "short manifest unchanged" "$SHORT" "$OUT"

echo "--- Test 5: missing evidence (skipped run-stop-* nodes) is stamped honestly ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "" "" "" "")"
assert_contains "Tests: N/A names the missing node" "Tests: N/A (evidence node run-stop-tests did not run)" "$OUT"
assert_contains "Grep: MISSING names the missing node" "Grep assertions: MISSING (run-stop-greps produced no output)" "$OUT"
assert_contains "audit line says missing" "Stop conditions: tests=missing; greps=missing" "$OUT"
assert_contains "VALIDATION flips on missing grep evidence" "VALIDATION: FAIL" "$OUT"

echo "--- Test 6: not_required / none_declared keep PASS and stamp N/A wording ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "N/A (INFRA class, no test command declared)" not_required "N/A (spec declares no grep stop conditions)" none_declared)"
assert_contains "INFRA N/A wording" "Tests: N/A (INFRA class, no test command declared)" "$OUT"
assert_contains "VALIDATION stays PASS" "VALIDATION: PASS" "$OUT"

echo "--- Test 7: manifest with Tests: but no Grep/VALIDATION lines gets both appended ---"
OUT="$(printf 'WO: WO-X\nTests: N/A\nPRs: x\n' | sme_process "3/3 (bun test)" passed "grep -c a b => 1" passed)"
assert_contains "Tests stamped" "Tests: 3/3 (bun test)" "$OUT"
assert_eq "Grep line appended at end, then audit line" "$(printf 'WO: WO-X\nTests: 3/3 (bun test)\nPRs: x\nGrep assertions: grep -c a b => 1\nStop conditions: tests=passed; greps=passed (observed by run-stop-tests / run-stop-greps in the run worktree)')" "$OUT"

echo "--- unresolved selected-stage greps fail closed in every stamp core ---"
for lane in $LANES; do
  if (
    unset SER_REQUIRE_ATTEMPT
    eval "$(extract_core "$DEFAULTS/$lane" sme)"
    out="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed "N/A (required grep stops are not uniquely inside the selected stage)" incomplete 0)"
    printf '%s\n' "$out" | grep -q 'VALIDATION: FAIL' || exit 1
    printf '%s\n' "$out" | grep -q 'VALIDATION: PASS' && exit 1
    exit 0
  ); then
    PASS=$((PASS + 1)); echo "PASS: unresolved stamp $lane"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: unresolved stamp $lane"
  fi
done

OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed "N/A (spec declares no grep stop conditions)" none_declared 0)"
assert_contains "none_declared zero declarations stay PASS" "VALIDATION: PASS" "$OUT"
FP4="$(mktemp -d)"
FP4_ART="$(mktemp -d)"
git -C "$FP4" init -q
git -C "$FP4" config user.email t@example.com
git -C "$FP4" config user.name Test
printf 'base\n' > "$FP4/README"
git -C "$FP4" add README
git -C "$FP4" commit -qm base
cat > "$FP4/ok.sh" <<'EOF'
#!/bin/sh
echo "Tests: 1/1"
exit 0
EOF
chmod +x "$FP4/ok.sh"
printf 'bash ./ok.sh\n' > "$FP4/cmds"
OUT="$(
  cd "$FP4" || exit 1
  export ARTIFACTS_DIR="$FP4_ART" SER_RUN_ID=run-fp4 SER_REPO=thinmansoftware/bdc-harness
  ser_runner run-tests --commands ./cmds --log "$FP4_ART/stop-tests.log" >/dev/null
  printf 'grep -c base README\teq\t1\nUNPARSED\t1\tprose\nDECLARED\t2\n' | ser_runner run-greps >/dev/null
  export SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests,greps
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh)" passed 'grep -c base README => 1; UNVERIFIED (unparsed): prose' incomplete 0
)"
assert_eq "FP-4 test attempt recorded" "yes" "$(
  id="$(tr -d '[:space:]' < "$FP4_ART/evidence/attempts/current-tests")"
  [ -n "$id" ] && [ -s "$FP4_ART/evidence/attempts/${id}.json" ] && echo yes || echo no
)"
assert_eq "FP-4 grep attempt recorded" "yes" "$(
  id="$(tr -d '[:space:]' < "$FP4_ART/evidence/attempts/current-greps")"
  [ -n "$id" ] && [ -s "$FP4_ART/evidence/attempts/${id}.json" ] && echo yes || echo no
)"
assert_contains "FP-4 real incomplete line stays PASS" "VALIDATION: PASS" "$OUT"
assert_not_contains "FP-4 real incomplete line is not FAIL" "VALIDATION: FAIL" "$OUT"
rm -rf "$FP4" "$FP4_ART"

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
    export ARTIFACTS_DIR="$art" SER_RUN_ID="$run_id" SER_REPO="thinmansoftware/bdc-harness"
    ser_runner run-tests --commands ./cmds --log "$art/stop-tests.log" >/dev/null
    printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
  )
}

sme_at() {
  local repo="$1" art="$2" run_id="$3" repo_name="$4" tests_status="$5" errf="$6"
  (
    cd "$repo" || exit 1
    export ARTIFACTS_DIR="$art" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests,greps SER_RUN_ID="$run_id"
    if [ -n "$repo_name" ]; then export SER_REPO="$repo_name"; else unset SER_REPO; fi
    printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh)" passed "grep -c base README => 1" "$tests_status" 0 2>"$errf"
  )
}

echo "--- attempt binding and mixed counts through stamp ---"
BIND="$(mktemp -d)"
BIND_ART="$(mktemp -d)"
prepare_passing_attempt "$BIND" "$BIND_ART" run-a
assert_eq "current-tests record exists" "yes" "$(
  id="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-tests")"
  [ -n "$id" ] && [ -s "$BIND_ART/evidence/attempts/${id}.json" ] && echo yes || echo no
)"
assert_eq "current-greps record exists" "yes" "$(
  id="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-greps")"
  [ -n "$id" ] && [ -s "$BIND_ART/evidence/attempts/${id}.json" ] && echo yes || echo no
)"
ERRF="$(mktemp)"
OUT="$(sme_at "$BIND" "$BIND_ART" run-a "" passed "$ERRF")"
assert_contains "blank live repo stays PASS" "VALIDATION: PASS" "$OUT"
OUT="$(sme_at "$BIND" "$BIND_ART" run-a thinmansoftware/other passed "$ERRF")"
assert_contains "conflicting SER_REPO stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "conflicting SER_REPO is not PASS" "VALIDATION: PASS" "$OUT"
assert_contains "conflicting SER_REPO names authority" "authority-repo" "$(cat "$ERRF")"
git -C "$BIND" add -- ok.sh cmds
git -C "$BIND" commit -qm "identical tested bytes"
OUT="$(sme_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness passed "$ERRF")"
assert_contains "identical-tree descendant stamps PASS" "VALIDATION: PASS" "$OUT"
OUT="$(sme_at "$BIND" "$BIND_ART" run-b thinmansoftware/bdc-harness passed "$ERRF")"
assert_contains "cross-run replay stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "cross-run replay is not PASS" "VALIDATION: PASS" "$OUT"
assert_contains "cross-run replay names run-id" "run-id" "$(cat "$ERRF")"
TEST_ID="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-tests")"
GREP_ID="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-greps")"
OUT="$(
  cd "$BIND" || exit 1
  export ARTIFACTS_DIR="$BIND_ART" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests,greps SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness
  export SER_TEST_ATTEMPT_ID="$GREP_ID" SER_GREP_ATTEMPT_ID="$TEST_ID"
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh)" passed "grep -c base README => 1" passed 0 2>"$ERRF"
)"
assert_contains "wrong-kind ids stamp FAIL" "VALIDATION: FAIL" "$OUT"
assert_contains "wrong-kind ids name kind" "attempt-kind" "$(cat "$ERRF")"
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
OUT="$(sme_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness passed "$ERRF")"
assert_contains "incomplete test member stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "incomplete test member is not PASS" "VALIDATION: PASS" "$OUT"
assert_contains "incomplete test member reason prefixed tests:" "tests:" "$(cat "$ERRF")"
PRIOR_GREP="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-greps")"
printf 'v2\n' > "$BIND/src.js"
(
  cd "$BIND" || exit 1
  export ARTIFACTS_DIR="$BIND_ART" SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness
  printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
)
NEW_GREP="$(tr -d '[:space:]' < "$BIND_ART/evidence/attempts/current-greps")"
assert_eq "later greps pointer changed" "yes" "$([ -n "$PRIOR_GREP" ] && [ "$PRIOR_GREP" != "$NEW_GREP" ] && echo yes || echo no)"
assert_eq "later greps json stays in artifact dir" "yes" "$([ -n "$NEW_GREP" ] && [ -s "$BIND_ART/evidence/attempts/${NEW_GREP}.json" ] && echo yes || echo no)"
OUT="$(sme_at "$BIND" "$BIND_ART" run-a thinmansoftware/bdc-harness passed "$ERRF")"
assert_contains "stale tests plus later greps stamp FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "stale tests plus later greps are not PASS" "VALIDATION: PASS" "$OUT"
assert_contains "stale tests reason prefixed tests:" "tests:" "$(cat "$ERRF")"

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
OUT="$(
  cd "$MIX" || exit 1
  export ARTIFACTS_DIR="$MIX_ART" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh; bash ./nocount.sh)" counts_unparsed "N/A (spec declares no grep stop conditions)" none_declared 0
)"
assert_contains "pass plus no-count stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "pass plus no-count is not PASS" "VALIDATION: PASS" "$OUT"
printf 'bash ./ok.sh\nbash ./zero.sh\n' > "$MIX/cmds"
( cd "$MIX" && ARTIFACTS_DIR="$MIX_ART" ser_runner run-tests --commands ./cmds --log "$MIX_ART/zero.log" >/dev/null )
OUT="$(
  cd "$MIX" || exit 1
  export ARTIFACTS_DIR="$MIX_ART" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh; bash ./zero.sh)" passed "N/A (spec declares no grep stop conditions)" none_declared 0
)"
assert_contains "pass plus 0/0 stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "pass plus 0/0 is not PASS" "VALIDATION: PASS" "$OUT"
echo "--- round-9 byte identity and explicit Expected through stamp ---"
eval "$(extract_core "$CANONICAL_YAML" rst)"
bind_worktree_runner
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
  export ARTIFACTS_DIR="$NA_ART" SER_RUN_ID=run-a SER_REPO=thinmansoftware/bdc-harness
  ser_runner run-tests --commands ./cmds --log "$NA_ART/stop-tests.log" >/dev/null
  printf 'grep -c base README\teq\t1\nDECLARED\t1\n' | ser_runner run-greps >/dev/null
)
python3 - "$NA" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / "caf\u00e9.js").write_text("v2\n")
PY
OUT="$(sme_at "$NA" "$NA_ART" run-a thinmansoftware/bdc-harness passed "$ERRF")"
assert_contains "stale non-ASCII bytes stamp FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "stale non-ASCII bytes are not PASS" "VALIDATION: PASS" "$OUT"

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
OUT="$(
  cd "$BAD" || exit 1
  export ARTIFACTS_DIR="$BAD_ART" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests SER_RUN_ID=run-bad
  unset SER_REPO
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./ok.sh)" passed "N/A (spec declares no grep stop conditions)" none_declared 0
)"
assert_contains "malformed explicit member stamps FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "malformed explicit member is not PASS" "VALIDATION: PASS" "$OUT"

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
assert_eq "stamp absence declaration flag" "0" "$MAP_DECL"
MAP_SRC="$(
  cd "$MAP" || exit 1
  rst_apply_fallback "$MAP_CMDS" "" project-map "bash ./map-pass.sh"
)"
assert_eq "stamp absence selects project-map" "project-map" "$MAP_SRC"
(
  cd "$MAP" || exit 1
  ARTIFACTS_DIR="$MAP_ART" SER_RUN_ID=run-map \
    ser_runner run-tests --commands "$MAP_CMDS" --log "$MAP_ART/stop-tests.log" >/dev/null
)
OUT="$(
  cd "$MAP" || exit 1
  export ARTIFACTS_DIR="$MAP_ART" SER_REQUIRE_ATTEMPT=1 SER_REQUIRE_KINDS=tests SER_RUN_ID=run-map
  unset SER_REPO
  printf '%s\n' "$ENGINE_MANIFEST" | sme_process "1/1 (bash ./map-pass.sh)" passed "N/A (spec declares no grep stop conditions)" none_declared 0
)"
assert_contains "true-absence project-map stamps PASS" "VALIDATION: PASS" "$OUT"
assert_not_contains "true-absence project-map is not FAIL" "VALIDATION: FAIL" "$OUT"
rm -rf "$NA" "$NA_ART" "$BAD" "$BAD_ART" "$MAP" "$MAP_ART"

unset SER_REQUIRE_ATTEMPT SER_REQUIRE_KINDS ARTIFACTS_DIR SER_RUN_ID SER_REPO SER_TEST_ATTEMPT_ID SER_GREP_ATTEMPT_ID
rm -rf "$BIND" "$BIND_ART" "$MIX" "$MIX_ART" "$ERRF"

echo
echo "stamp-manifest-evidence.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
