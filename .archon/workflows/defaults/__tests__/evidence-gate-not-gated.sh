#!/usr/bin/env bash
# evidence-gate-not-gated.sh -- Tests 1-8 of WO-HARNESS-EVIDENCE-GATE-NOT-GATED-AND-BASE-
# UNRUNNABLE-01 (bdc-xo #4751): the lane evidence gate says plainly when it did not gate a
# run (NOT_GATED:<status>), the base-red comparison refuses to judge a base that never ran
# (base_unrunnable), dprep fails loud and retries without the frozen lockfile, and a PR
# opened from a non-PROCEED run gets the run:blocked label and banner.
#
# The cores are EXTRACTED from the canonical YAML (never re-typed). Tests 9 and 10 live in
# packages/overseer/src/__tests__/merge-candidate-discovery.test.ts and
# packages/workflows/src/manifest-evidence-lane-wiring.test.ts.
#
# Run: bash .archon/workflows/defaults/__tests__/evidence-gate-not-gated.sh
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
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle:   $needle"; echo "  haystack: $haystack"
  fi
}
assert_file_has() {
  local label="$1" needle="$2" file="$3"
  if grep -Fq -- "$needle" "$file"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle: $needle"; echo "  file:   $file"
  fi
}
assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected: $needle"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}
NAMED_FAIL_MARK=0
named_begin() { NAMED_FAIL_MARK=$FAIL; }
named_end() {
  if [ "$FAIL" -eq "$NAMED_FAIL_MARK" ]; then echo "PASS: $1"; else echo "FAIL: $1"; fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
LANES="$(cd "$DEFAULTS" && ls bdc-feature-development*.yaml)"

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}
extract_core_nth() {
  tr -d '\r' < "$1" | awk -v m="$2" -v n="$3" '
    index($0, "# ---- BEGIN " m " core") { seen++; if (seen == n + 0) c = 1; next }
    index($0, "# ---- END " m " core") { if (c) { c = 0; exit } next }
    c
  ' | sed 's/^      //'
}

export BDC_RSGARGV_SCRIPT="$REPO_ROOT/scripts/lane/rsg-argv.sh"
export BDC_STBASE_SCRIPT="$REPO_ROOT/scripts/lane/stop-tests-base.sh"
export BDC_DPREP_SCRIPT="$REPO_ROOT/scripts/lane/dprep.sh"

MEC_CORE="$(extract_core "$CANONICAL_YAML" mec)"
PBB_CORE="$(extract_core "$CANONICAL_YAML" pbb)"
RST_CORE="$(extract_core "$CANONICAL_YAML" rst)"
STBASE_CORE="$(extract_core_nth "$CANONICAL_YAML" stbase 1)"
DPREP_CORE="$(extract_core_nth "$CANONICAL_YAML" dprep 1)"
if [ -z "$PBB_CORE" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: pbb core present in $CANONICAL_YAML"
  PBB_CORE='pbb_mark_blocked() { echo "pbb core missing" >&2; return 127; }'
fi
for pair in "mec:$MEC_CORE" "pbb:$PBB_CORE" "rst:$RST_CORE" "stbase:$STBASE_CORE" "dprep:$DPREP_CORE"; do
  if [ -z "${pair#*:}" ]; then echo "FATAL: could not extract ${pair%%:*} core from $CANONICAL_YAML"; exit 1; fi
done
eval "$MEC_CORE"
eval "$PBB_CORE"
eval "$RST_CORE"
eval "$DPREP_CORE"
eval "$STBASE_CORE"
for fn in mec_check pbb_mark_blocked rst_run_commands rst_base_compare dprep_ensure_js_deps; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

TAB="$(printf '\t')"
ROOT="$(mktemp -d)"
STUB_BIN="$ROOT/bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/bun" <<'STUB'
#!/usr/bin/env bash
# stub bun: "bun install ..." records the attempt and fails; "bun run test" replays STUB_BASE_OUT.
if [ "${1:-}" = "install" ]; then
  echo "INSTALL $*" >> "$STUB_INSTALL_LOG"
  n="$(grep -c '^INSTALL' "$STUB_INSTALL_LOG")"
  if [ "$n" -eq 1 ]; then echo "error: lockfile had changes, but lockfile is frozen" >&2; else echo "error: registry unreachable after retry" >&2; fi
  exit "${STUB_INSTALL_EXIT:-1}"
fi
echo "RUN $*" >> "${STUB_RUN_LOG:-/dev/null}"
if [ -n "${STUB_BASE_OUT:-}" ]; then cat "$STUB_BASE_OUT"; fi
exit "${STUB_BASE_EXIT:-0}"
STUB
chmod +x "$STUB_BIN/bun"
export STUB_INSTALL_LOG="$ROOT/install.log"
export STUB_RUN_LOG="$ROOT/run.log"
: > "$STUB_INSTALL_LOG"; : > "$STUB_RUN_LOG"

field() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; }

# ---------------------------------------------------------------------------
echo "--- Test 1: mec_check on BLOCKED with failed tests is NOT_GATED, not OK ---"
named_begin
M1_MANIFEST='WO: WO-X
Tests: 4/19 (bun run test) -- FAILED, exit 1
Grep assertions: N/A (spec declares no grep stop conditions)'
M1_ERR="$ROOT/m1.err"
M1_OUT="$(printf '%s\n' "$M1_MANIFEST" | mec_check BLOCKED CODE failed 0 none_declared 1 0 0 0 0 "" 2>"$M1_ERR")"; M1_RC=$?
assert_eq "stdout is NOT_GATED:BLOCKED" "NOT_GATED:BLOCKED" "$M1_OUT"
assert_eq "rc 0" "0" "$M1_RC"
assert_contains "stderr names tests_status=failed" "tests_status=failed" "$(cat "$M1_ERR")"
assert_contains "stderr names the status" "status=BLOCKED" "$(cat "$M1_ERR")"
M1B_OUT="$(printf '%s\n' "$M1_MANIFEST" | mec_check ALREADY_SATISFIED CODE passed 0 none_declared 0 0 0 0 0 "" 2>/dev/null)"
assert_eq "ALREADY_SATISFIED is NOT_GATED too (never OK)" "NOT_GATED:ALREADY_SATISFIED" "$M1B_OUT"
M1C_ERR="$ROOT/m1c.err"
printf '%s\n' "$M1_MANIFEST" | mec_check BLOCKED CODE passed 0 none_declared 0 0 0 0 0 "" >/dev/null 2>"$M1C_ERR"
assert_eq "no stderr note when the tests did not fail" "" "$(cat "$M1C_ERR")"
named_end blocked_with_failed_tests_is_not_ok

echo "--- Test 2: PROCEED with base_red is OK ---"
named_begin
M2_MANIFEST='WO: WO-X
Tests: 5/20 (base-red: 15 tests failing on base abcd1234; newly broken: 0) (bun run test)
Grep assertions: grep -c x f => 1'
M2_OUT="$(printf '%s\n' "$M2_MANIFEST" | mec_check PROCEED CODE base_red 1 passed 1 1 0 0 0 "" 2>&1)"; M2_RC=$?
assert_eq "stdout is OK" "OK" "$M2_OUT"
assert_eq "rc 0" "0" "$M2_RC"
named_end proceed_with_base_red_is_ok

echo "--- Test 3: PROCEED with newly_broken is EVIDENCE_ERROR ---"
named_begin
M3_MANIFEST='WO: WO-X
Tests: 5/20 (bun run test) -- FAILED, exit 1; newly broken: A
Grep assertions: grep -c x f => 1'
M3_OUT="$(printf '%s\n' "$M3_MANIFEST" | mec_check PROCEED CODE failed 1 passed 1 1 0 0 0 "" 2>"$ROOT/m3.err")"; M3_RC=$?
assert_eq "rc 1" "1" "$M3_RC"
assert_eq "no OK on stdout" "" "$M3_OUT"
assert_eq "stderr starts with EVIDENCE_ERROR" "EVIDENCE_ERROR" "$(cut -c1-14 "$ROOT/m3.err" | head -1)"
named_end proceed_with_newly_broken_is_evidence_error

# ---------------------------------------------------------------------------
# Base-compare fixtures: a real git repo whose base commit has package.json (and bun.lock
# when asked); the head run is a hand-built log of vitest-style failures; the base command
# is the stub bun above.
mk_repo() {
  # mk_repo <dir> <lockfile yes|no>  -> prints the base sha
  local dir="$1" lock="$2"
  mkdir -p "$dir"
  (
    cd "$dir" || exit 1
    git init -q . && git config user.email t@t && git config user.name t && git config core.autocrlf false
    printf '{\n  "name": "gate-fixture",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n' > package.json
    if [ "$lock" = yes ]; then printf '{"lockfileVersion":1}\n' > bun.lock; fi
    git add -A && git commit -q -m base
    git rev-parse HEAD
  )
}
head_log() {
  # head_log <file> <n failing>   a vitest-style head run block with <n> failures and 5 passes
  local f="$1" n="$2" i
  {
    echo "### run-stop-tests: bun run test"
    i=1
    while [ "$i" -le "$n" ]; do echo " FAIL  a.test.ts > suite > T$i"; i=$((i + 1)); done
    echo " Tests  $n failed | 5 passed ($((n + 5)))"
    echo "### exit 1"
  } > "$f"
}
base_out() {
  # base_out <file> <n failing>
  local f="$1" n="$2" i
  : > "$f"
  i=1
  while [ "$i" -le "$n" ]; do echo " FAIL  a.test.ts > suite > T$i" >> "$f"; i=$((i + 1)); done
  echo " Tests  $n failed | 5 passed ($((n + 5)))" >> "$f"
}
run_compare() {
  # run_compare <name> <lock yes|no> <head failing> <base exit> <base out file or ""> -> outputs of rst_base_compare
  local name="$1" lock="$2" hn="$3" bexit="$4" bout="$5" base="$ROOT/$1" sha art counts
  sha="$(mk_repo "$base/repo" "$lock")"
  art="$base/art"; mkdir -p "$art"
  echo "$sha" > "$art/run-start-sha.txt"
  printf 'bun run test\n' > "$art/cmds"
  head_log "$art/head.log" "$hn"
  counts="5 $((hn + 5))"
  printf 'TESTS_STATUS=failed\nTESTS_LINE=5/%s (bun run test) -- FAILED, exit 1\n' "$((hn + 5))" > "$art/report"
  : > "$STUB_RUN_LOG"
  ( cd "$base/repo" && PATH="$STUB_BIN:$PATH" STUB_BASE_EXIT="$bexit" STUB_BASE_OUT="$bout" ARTIFACTS_DIR="$art" rst_base_compare "$art/report" "$art/cmds" "$art/head.log" "$counts" 2>/dev/null )
}

echo "--- Test 4: base exit 127 with no counts is base_unrunnable ---"
named_begin
printf 'bash: line 1: vitest: command not found\nerror: script "test" exited with code 127\n' > "$ROOT/b127.out"
T4="$(run_compare t4 no 15 127 "$ROOT/b127.out")"
assert_eq "TESTS_BASE_COMPARE=base_unrunnable" "base_unrunnable" "$(field TESTS_BASE_COMPARE "$T4")"
assert_eq "TESTS_STATUS=failed" "failed" "$(field TESTS_STATUS "$T4")"
assert_not_contains "no newly broken names in TESTS_LINE" "newly broken" "$(field TESTS_LINE "$T4")"
assert_eq "the base command really ran (and found nothing)" "1" "$(grep -c '^RUN run test' "$STUB_RUN_LOG")"
T4B="$(run_compare t4b no 15 126 "$ROOT/b127.out")"
assert_eq "exit 126 is base_unrunnable too" "base_unrunnable" "$(field TESTS_BASE_COMPARE "$T4B")"
printf 'something unparseable\n' > "$ROOT/bnocount.out"
T4C="$(run_compare t4c no 15 1 "$ROOT/bnocount.out")"
assert_eq "unparsed base counts are base_unrunnable" "base_unrunnable" "$(field TESTS_BASE_COMPARE "$T4C")"
assert_eq "an unparsed base never reads newly_broken" "failed" "$(field TESTS_STATUS "$T4C")"
named_end base_exit_127_is_base_unrunnable

echo "--- Test 5: a base with the same 15 failures is base_red ---"
named_begin
base_out "$ROOT/b15.out" 15
T5="$(run_compare t5 no 15 1 "$ROOT/b15.out")"
assert_eq "TESTS_BASE_COMPARE=base_red" "base_red" "$(field TESTS_BASE_COMPARE "$T5")"
assert_eq "TESTS_STATUS=base_red" "base_red" "$(field TESTS_STATUS "$T5")"
named_end same_failures_on_base_is_base_red

echo "--- Test 6: one extra head failure is newly_broken ---"
named_begin
T6="$(run_compare t6 no 16 1 "$ROOT/b15.out")"
assert_eq "TESTS_BASE_COMPARE=newly_broken" "newly_broken" "$(field TESTS_BASE_COMPARE "$T6")"
assert_contains "the extra name is listed" "T16" "$(field TESTS_LINE "$T6")"
named_end one_extra_head_failure_is_newly_broken

echo "--- Test 7: a dprep install failure is in the base log and returns nonzero ---"
named_begin
# (a) dprep alone: two attempts, the second without --frozen-lockfile, rc nonzero, error text on stdout
WT7="$ROOT/t7wt"; mkdir -p "$WT7"
printf '{"name":"x","scripts":{"test":"vitest run"}}\n' > "$WT7/package.json"; printf '{"lockfileVersion":1}\n' > "$WT7/bun.lock"
: > "$STUB_INSTALL_LOG"
D7_OUT="$(cd "$WT7" && PATH="$STUB_BIN:$PATH" dprep_ensure_js_deps)"; D7_RC=$?
assert_eq "dprep returns nonzero when the install fails" "1" "$([ "$D7_RC" -ne 0 ] && echo 1 || echo 0)"
assert_eq "exactly two install attempts" "2" "$(grep -c '^INSTALL' "$STUB_INSTALL_LOG")"
assert_contains "first attempt is frozen" "INSTALL install --frozen-lockfile" "$(sed -n 1p "$STUB_INSTALL_LOG")"
assert_eq "the retry drops --frozen-lockfile" "INSTALL install" "$(sed -n 2p "$STUB_INSTALL_LOG")"
assert_contains "the real install error text is on stdout" "error: lockfile had changes, but lockfile is frozen" "$D7_OUT"
assert_contains "the retry error text is on stdout" "error: registry unreachable after retry" "$D7_OUT"
# a successful retry returns 0 once node_modules exists
WT7B="$ROOT/t7wtb"; mkdir -p "$WT7B"
printf '{"name":"x"}\n' > "$WT7B/package.json"; printf '{"lockfileVersion":1}\n' > "$WT7B/bun.lock"
mkdir -p "$ROOT/bin-ok"
cat > "$ROOT/bin-ok/bun" <<'STUB3'
#!/usr/bin/env bash
echo "INSTALL $*" >> "$STUB_INSTALL_LOG"
if [ "${2:-}" = "--frozen-lockfile" ]; then echo "error: lockfile had changes, but lockfile is frozen" >&2; exit 1; fi
mkdir -p node_modules
exit 0
STUB3
chmod +x "$ROOT/bin-ok/bun"
: > "$STUB_INSTALL_LOG"
( cd "$WT7B" && PATH="$ROOT/bin-ok:$PATH" dprep_ensure_js_deps >/dev/null ); D7B_RC=$?
assert_eq "a retry that succeeds returns 0" "0" "$D7B_RC"
assert_eq "frozen failed then plain install ran" "2" "$(grep -c '^INSTALL' "$STUB_INSTALL_LOG")"
# (b) the base compare: the error is inside stop-tests-base.log and the outcome is base_unrunnable
: > "$STUB_INSTALL_LOG"
T7="$(run_compare t7 yes 15 1 "$ROOT/b15.out")"
assert_eq "TESTS_BASE_COMPARE=base_unrunnable" "base_unrunnable" "$(field TESTS_BASE_COMPARE "$T7")"
assert_eq "TESTS_STATUS=failed" "failed" "$(field TESTS_STATUS "$T7")"
T7_LOG="$ROOT/t7/art/evidence/stop-tests-base.log"
assert_contains "the install error text is inside stop-tests-base.log" "error: lockfile had changes, but lockfile is frozen" "$(cat "$T7_LOG")"
assert_eq "exactly two install attempts in the compare" "2" "$(grep -c '^INSTALL' "$STUB_INSTALL_LOG")"
assert_eq "the base test command never ran" "0" "$(grep -c '^RUN' "$STUB_RUN_LOG")"
named_end dprep_failure_is_in_base_log_and_nonzero

echo "--- Test 8: a BLOCKED-run PR gets the run:blocked label and the banner ---"
named_begin
mkdir -p "$ROOT/ghbin"
cat > "$ROOT/ghbin/gh" <<'GHSTUB'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
if [ "$1 $2" = "pr view" ]; then echo "Original PR body line"; exit 0; fi
if [ "$1 $2" = "pr edit" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--body-file" ]; then cp "$a" "$GH_BODY_COPY"; fi
    prev="$a"
  done
fi
exit 0
GHSTUB
chmod +x "$ROOT/ghbin/gh"
export GH_LOG="$ROOT/gh.log" GH_BODY_COPY="$ROOT/gh-body.txt"
: > "$GH_LOG"; rm -f "$GH_BODY_COPY"
( PATH="$ROOT/ghbin:$PATH" pbb_mark_blocked BLOCKED "https://github.com/o/r/pull/5" "o/r" ) >/dev/null 2>&1
assert_contains "gh label create run:blocked is called" "gh label create run:blocked --repo o/r" "$(cat "$GH_LOG")"
assert_contains "gh pr edit adds the run:blocked label" "--add-label run:blocked" "$(cat "$GH_LOG")"
assert_contains "gh pr edit targets the PR" "gh pr edit https://github.com/o/r/pull/5 --repo o/r" "$(cat "$GH_LOG")"
assert_eq "the body file begins with the banner line" "RUN BLOCKED -- not lane-verified" "$(head -1 "$GH_BODY_COPY")"
assert_contains "the original body is kept below the banner" "Original PR body line" "$(cat "$GH_BODY_COPY")"
# idempotent: an already-bannered body is not bannered twice
: > "$GH_LOG"; rm -f "$GH_BODY_COPY"
( PATH="$ROOT/ghbin:$PATH" pbb_mark_blocked BLOCKED "https://github.com/o/r/pull/5" "o/r" ) >/dev/null 2>&1
assert_eq "banner appears once" "1" "$(grep -c '^RUN BLOCKED -- not lane-verified$' "$GH_BODY_COPY")"
# PROCEED and ALREADY_SATISFIED record neither
for st in PROCEED ALREADY_SATISFIED; do
  : > "$GH_LOG"; rm -f "$GH_BODY_COPY"
  ( PATH="$ROOT/ghbin:$PATH" pbb_mark_blocked "$st" "https://github.com/o/r/pull/5" "o/r" ) >/dev/null 2>&1
  assert_eq "$st: no gh call" "0" "$(grep -c . "$GH_LOG" || true)"
  assert_eq "$st: no body file" "0" "$([ -e "$GH_BODY_COPY" ] && echo 1 || echo 0)"
done
# a missing PR url or repo is a logged no-op, never an error
: > "$GH_LOG"
( PATH="$ROOT/ghbin:$PATH" pbb_mark_blocked BLOCKED "" "o/r" ) >/dev/null 2>&1; NOURL_RC=$?
assert_eq "no url: rc 0 and no gh call" "0 0" "$NOURL_RC $(grep -c . "$GH_LOG" || true)"
named_end blocked_run_pr_gets_label_and_banner

echo "--- wiring: the same cores and when: in all 13 lanes ---"
named_begin
LANE_N=0
MEC_SUM="$(printf '%s\n' "$MEC_CORE" | cksum)"
PBB_SUM="$(printf '%s\n' "$PBB_CORE" | cksum)"
for lane in $LANES; do
  LANE_N=$((LANE_N + 1))
  assert_eq "mec core byte-identical: $lane" "$MEC_SUM" "$(extract_core "$DEFAULTS/$lane" mec | cksum)"
  assert_eq "pbb core byte-identical: $lane" "$PBB_SUM" "$(extract_core "$DEFAULTS/$lane" pbb | cksum)"
  assert_file_has "NOT_GATED: in $lane" "NOT_GATED:" "$DEFAULTS/$lane"
  assert_file_has "run:blocked in $lane" "run:blocked" "$DEFAULTS/$lane"
  assert_file_has "patch-pr-body calls pbb_mark_blocked in $lane" 'pbb_mark_blocked "$STATUS" "$NP_URL" "$NP_REPO"' "$DEFAULTS/$lane"
  WHENLINE="$(tr -d '\r' < "$DEFAULTS/$lane" | awk '/^  - id: /{id=$3} id=="patch-pr-body" && /^    when:/ {print; exit}')"
  assert_contains "patch-pr-body when accepts OK in $lane" "\$manifest-evidence-check.output == 'OK'" "$WHENLINE"
  assert_contains "patch-pr-body when accepts NOT_GATED:BLOCKED in $lane" "\$manifest-evidence-check.output == 'NOT_GATED:BLOCKED'" "$WHENLINE"
done
assert_eq "13 lanes checked" "13" "$LANE_N"
named_end wiring_is_the_same_in_all_13_lanes

rm -rf "$ROOT"
echo
echo "evidence-gate-not-gated.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
