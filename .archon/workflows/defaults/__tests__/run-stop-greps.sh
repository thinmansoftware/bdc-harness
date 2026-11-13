#!/usr/bin/env bash
# run-stop-greps.sh -- unit tests for the run-stop-greps node core (rsg_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 12 bdc-feature-development lanes (13 total).
#
# bdc-xo #1940: the manifest "Grep assertions:" line was stamped "N/A (no declared
# mechanical assertions)" for every WO, including specs that declared grep stop
# conditions. run-stop-greps extracts each "Stop N (grep assertion ...)" block, runs
# it under the read-only allowlist, and emits OBSERVED counts.
#
# Cores are EXTRACTED from the canonical YAML (never re-typed). A parity test asserts
# the core is byte-identical across all 13 lanes. The tokenizer is the shared script
# scripts/lane/rsg-argv.sh (WO-HARNESS-GREP-ALLOWLIST-QUOTED-MULTIWORD-01); every
# core test runs with BDC_RSGARGV_SCRIPT pointing at it.
#
# Run: bash .archon/workflows/defaults/__tests__/run-stop-greps.sh
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

NAMED_FAIL_MARK=0
named_begin() { NAMED_FAIL_MARK=$FAIL; }
named_end() {
  if [ "$FAIL" -eq "$NAMED_FAIL_MARK" ]; then echo "PASS: $1"; else echo "FAIL: $1"; fi
}
assert_rc() {
  # assert_rc <label> <expected rc> <command...>
  local label="$1" expected="$2" rc
  shift 2
  "$@" >/dev/null 2>&1; rc=$?
  assert_eq "$label" "$expected" "$rc"
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

REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
RSGARGV_SOURCE="$REPO_ROOT/scripts/lane/rsg-argv.sh"
export BDC_RSGARGV_SCRIPT="$RSGARGV_SOURCE"

RSG_CORE="$(extract_core "$CANONICAL_YAML" rsg)"
if [ -z "$RSG_CORE" ]; then
  echo "FATAL: could not extract rsg core from $CANONICAL_YAML"; exit 1
fi
eval "$RSG_CORE"
for fn in rsg_extract rsg_parse_pipeline rsg_argv_looks_readonly rsg_allow_cmd rsg_exec_pipeline rsg_observe rsg_compare rsg_run; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: rsg core byte-identical across all 13 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$RSG_CORE" "$(extract_core "$DEFAULTS/$lane" rsg)"
done

TAB="$(printf '\t')"
TMP="$(mktemp -d)"
printf 'alpha\nbeta\nalpha beta\ngamma\n' > "$TMP/fixture.txt"
mkdir -p "$TMP/src"
printf 'export const x = 1;\n' > "$TMP/src/a.ts"

SPEC='# WO-X

WO Class: CODE

## 8. Stop conditions (CI-executable)

Stop 1a (grep assertion, exact):
  grep -c alpha fixture.txt
  Expected: 2

Stop 1b (grep assertion, at least):
  grep -c beta fixture.txt
  Expected: at least 1 (two lines mention beta)

Stop 1c (grep assertion, absence):
  grep -n delta fixture.txt
  Expected: no output

Stop 1d (grep assertion, not executable under the read-only allowlist):
  grep -rciE password src 2>/dev/null | awk -F: "{s+=$2} END {print s+0}"
  Expected: 0

Stop 1e (grep assertion, header without an Expected line):
  grep -c gamma fixture.txt

Stop 2 (test suite):
  bun test x
  Expected: 3 passing

Stop 3 (ASCII scan):
  LC_ALL=C grep -n "[^ -~]" src/a.ts
  Expected: no output
'

echo "--- rsg_extract ---"
EXTRACTED="$(printf '%s\n' "$SPEC" | rsg_extract)"
assert_contains "eq assertion extracted" "grep -c alpha fixture.txt${TAB}eq${TAB}2" "$EXTRACTED"
assert_contains "ge assertion extracted" "grep -c beta fixture.txt${TAB}ge${TAB}1" "$EXTRACTED"
assert_contains "'no output' becomes eq 0" "grep -n delta fixture.txt${TAB}eq${TAB}0" "$EXTRACTED"
assert_contains "awk assertion still extracted (dropped later, not here)" "| awk -F: \"{s+=\$2} END {print s+0}\"${TAB}eq${TAB}0" "$EXTRACTED"
assert_contains "DECLARED counts every grep command: the five grep headers plus the ASCII-scan stop that uses a grep command (WO-HARNESS-GREP-STOP-EXTRACTION-SILENT-WAIVE-01)" "DECLARED${TAB}6" "$EXTRACTED"
assert_eq "test-suite stops are not grep assertions" "0" "$(printf '%s\n' "$EXTRACTED" | grep -c 'bun test' || true)"
assert_contains "an ASCII-scan stop that uses a grep command is a grep assertion" "LC_ALL=C grep -n \"[^ -~]\" src/a.ts${TAB}eq${TAB}0" "$EXTRACTED"
assert_eq "header without Expected: emits no executable assertion line" "0" "$(printf '%s\n' "$EXTRACTED" | grep -c "gamma.*${TAB}eq${TAB}" || true)"
assert_contains "header without Expected is named as unparsed" "UNPARSED${TAB}1${TAB}grep -c gamma fixture.txt" "$EXTRACTED"
assert_eq "no grep stops -> zero unparsed and declared" "UNPARSED${TAB}0
DECLARED${TAB}0" "$(printf 'Stop 2 (test suite):\n  bun test\n  Expected: ok\n' | rsg_extract)"
assert_contains "'at most' becomes le" "${TAB}le${TAB}3" "$(printf 'Stop 1 (grep assertion):\n  grep -c a b\n  Expected: at most 3\n' | rsg_extract)"
assert_contains "backslash continuation joins the command" "grep -rn \"a\" src | wc -l${TAB}eq${TAB}4" "$(printf 'Stop 1 (grep assertion):\n  grep -rn "a" src \\\n    | wc -l\n  Expected: 4\n' | rsg_extract)"

echo "--- rsg_allow_cmd ---"
for c in 'grep -c alpha fixture.txt' 'grep -rn x src | wc -l' 'LC_ALL=C grep -n x src/a.ts' 'find src -name *.ts | wc -l' 'test -f src/a.ts' 'grep -c x file' 'grep -rn x dir | wc -l' 'find . -name *.ts | wc -l' 'rg -c x dir' '[ -f src/a.ts ]'; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: allowed: $c"; else FAIL=$((FAIL+1)); echo "FAIL: allowed expected: $c"; fi
done
for c in 'grep -c a b; rm -rf /' 'grep a b | awk "{print}"' 'grep a b > out' 'cat $(ls)' 'find . -delete' 'sed -n 1p a' 'FOO=1 grep a b' \
  'find . -execdir sh x.sh \;' 'find . -exec rm x \;' 'sort -o out in' "awk '{print}' f" 'grep -f /etc/passwd x' 'grep x f > out' 'grep x f; curl e' \
  'find . -okdir sh x.sh' 'sort --output=out in' 'grep --file /etc/passwd x' 'find . -fprintf out %p' 'xargs grep x' \
  'grep -c "alpha" fixture.txt' 'LC_ALL=C grep -n "[^ -~]" src/a.ts'; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: forbidden expected: $c"; else PASS=$((PASS+1)); echo "PASS: forbidden: $c"; fi
done

echo "--- unquoted-still-executes ---"
c='grep -c needle fixture.txt'
if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: unquoted-still-executes: $c"; else FAIL=$((FAIL+1)); echo "FAIL: unquoted-still-executes: $c"; fi

echo "--- quoted-pattern-executes (allowlist) ---"
c="grep -c 'needle' fixture.txt"
if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: quoted-pattern-executes allow: $c"; else FAIL=$((FAIL+1)); echo "FAIL: quoted-pattern-executes allow: $c"; fi

echo "--- quoted-colon-and-equals-execute (allowlist) ---"
for c in "grep -c 'SPEC_DEFECT:' fixture.txt" "grep -c 'unparsed=' fixture.txt"; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: quoted-colon-and-equals-execute allow: $c"; else FAIL=$((FAIL+1)); echo "FAIL: quoted-colon-and-equals-execute allow: $c"; fi
done

echo "--- double-quoted-still-dropped ---"
c='grep -c "needle" fixture.txt'
if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: double-quoted-still-dropped: $c"; else PASS=$((PASS+1)); echo "PASS: double-quoted-still-dropped: $c"; fi

echo "--- unsafe-quoted-content-still-dropped ---"
# WO-HARNESS-GREP-ALLOWLIST-QUOTED-MULTIWORD-01: a spaced, caret or command-substitution
# pattern inside single quotes is now a LITERAL pattern and is allowed (see the
# quoted-literal-patterns-allowed block). What stays dropped: unbalanced or empty quotes
# and a quoted word that is itself a write/exec flag.
for c in "grep -c 'x f" "grep -c '' f" "grep '--file=/etc/passwd' x" "find . '-exec' rm" "sort '-o' out"; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: unsafe-quoted-content-still-dropped: $c"; else PASS=$((PASS+1)); echo "PASS: unsafe-quoted-content-still-dropped: $c"; fi
done

echo "--- quoted-literal-patterns-allowed ---"
for c in "grep -c 'a b' f" "grep -c '\$(id)' f" "grep -c '^x' f"; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: quoted-literal-patterns-allowed: $c"; else FAIL=$((FAIL+1)); echo "FAIL: quoted-literal-patterns-allowed: $c"; fi
done

echo "--- rsg_observe / rsg_compare ---"
cd "$TMP"
assert_eq "grep -c prints an integer" "2" "$(rsg_observe 'grep -c alpha fixture.txt')"
assert_eq "grep -n line output is counted" "2" "$(rsg_observe 'grep -n beta fixture.txt')"
assert_eq "clean no-match is 0" "0" "$(rsg_observe 'grep -n delta fixture.txt')"
assert_eq "missing path is ERR" "ERR" "$(rsg_observe 'grep -n x no-such-file.txt')"
assert_eq "pipeline grep | wc -l counts the grep -c line" "1" "$(rsg_observe 'grep -c alpha fixture.txt | wc -l')"
if rsg_compare ge 1 2; then PASS=$((PASS+1)); echo "PASS: ge holds"; else FAIL=$((FAIL+1)); echo "FAIL: ge holds"; fi
if rsg_compare eq 2 3; then FAIL=$((FAIL+1)); echo "FAIL: eq mismatch detected"; else PASS=$((PASS+1)); echo "PASS: eq mismatch detected"; fi
if rsg_compare le 3 3; then PASS=$((PASS+1)); echo "PASS: le holds"; else FAIL=$((FAIL+1)); echo "FAIL: le holds"; fi

echo "--- rsg_run: end to end in the fixture worktree ---"
OUT="$(printf '%s\n' "$SPEC" | rsg_extract | rsg_run)"
assert_contains "GREP_DECLARED=6 (five grep headers plus the ASCII-scan grep)" "GREP_DECLARED=6" "$OUT"
assert_contains "GREP_EXECUTED=3" "GREP_EXECUTED=3" "$OUT"
assert_contains "GREP_DROPPED=2 (the awk one and the double-quoted ASCII scan)" "GREP_DROPPED=2" "$OUT"
assert_contains "GREP_UNPARSED=1 (the missing expectation)" "GREP_UNPARSED=1" "$OUT"
assert_contains "GREP_MISMATCH=0" "GREP_MISMATCH=0" "$OUT"
assert_contains "partial execution is incomplete" "GREP_STATUS=incomplete" "$OUT"
assert_contains "manifest line names the dropped assertion" 'UNVERIFIED (dropped): grep -rciE password src 2>/dev/null | awk' "$OUT"
assert_contains "manifest line names the unparsed assertion" 'UNVERIFIED (unparsed): grep -c gamma fixture.txt' "$OUT"
assert_contains "GREP_LINE carries observed counts in manifest v2 form" 'GREP_LINE=grep -c alpha fixture.txt => 2; grep -c beta fixture.txt => 2; grep -n delta fixture.txt => 0' "$OUT"
assert_contains "dropped assertion is named in detail" 'DROPPED (not on read-only allowlist; not executed): grep -rciE password src 2>/dev/null | awk' "$OUT"

OUT="$(printf 'grep -c alpha fixture.txt\teq\t2\nUNPARSED\t0\nDECLARED\t2\n' | rsg_run)"
assert_contains "executed below declared with no unparsed is incomplete" "GREP_STATUS=incomplete" "$OUT"

OUT="$(printf 'grep -c alpha fixture.txt\teq\t2\nUNPARSED\t1\nDECLARED\t1\n' | rsg_run)"
assert_contains "unparsed is incomplete even when executed equals declared" "GREP_STATUS=incomplete" "$OUT"
assert_contains "unnamed legacy unparsed input is identified" "UNVERIFIED (unparsed): 1 unnamed assertion(s)" "$OUT"

printf 'alpha\n' > "$TMP/fixture.txt"
OUT="$(printf '%s\n' "$SPEC" | rsg_extract | rsg_run)"
assert_contains "mismatch detected when the file changes (alpha eq 2 and beta ge 1 both fail)" "GREP_MISMATCH=2" "$OUT"
assert_contains "GREP_STATUS=mismatch" "GREP_STATUS=mismatch" "$OUT"
assert_contains "MISMATCH detail names expected and observed" 'MISMATCH: grep -c alpha fixture.txt => 1 (expected eq 2)' "$OUT"
assert_contains "GREP_LINE still carries the OBSERVED (not expected) count" 'grep -c alpha fixture.txt => 1;' "$OUT"

OUT="$(printf 'Stop 2 (test suite):\n  bun test\n  Expected: ok\n' | rsg_extract | rsg_run)"
assert_contains "none declared -> none_declared" "GREP_STATUS=none_declared" "$OUT"
assert_contains "none declared -> N/A line" "GREP_LINE=N/A (spec declares no grep stop conditions)" "$OUT"

OUT="$(printf 'Stop 1 (grep assertion):\n  grep a b | awk "{print}"\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "all dropped -> all_dropped" "GREP_STATUS=all_dropped" "$OUT"
assert_contains "all dropped -> N/A line names the count" "GREP_LINE=N/A (1 declared grep stop condition(s) but none executable under the read-only allowlist)" "$OUT"

OUT="$(printf 'Stop 1 (grep assertion):\n  LC_ALL=C grep -c alpha fixture.txt\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "LC_ALL prefix passes the gate and executes" "GREP_EXECUTED=1" "$OUT"
assert_contains "LC_ALL prefixed command kept verbatim in GREP_LINE" 'GREP_LINE=LC_ALL=C grep -c alpha fixture.txt => 1' "$OUT"

echo "--- quoted-pattern-executes ---"
printf 'needle\nneedle\n' > "$TMP/needle.txt"
OUT="$(printf 'Stop 1 (grep assertion):\n  grep -c '\''needle'\'' needle.txt\n  Expected: 2\n' | rsg_extract | rsg_run)"
assert_contains "quoted-pattern-executes is executed" "GREP_EXECUTED=1" "$OUT"
assert_contains "quoted-pattern-executes reports OK with observed 2" "OK: grep -c 'needle' needle.txt => 2 (expected eq 2)" "$OUT"
assert_contains "quoted-pattern-executes is not dropped" "GREP_DROPPED=0" "$OUT"

echo "--- quoted-colon-and-equals-execute ---"
printf 'SPEC_DEFECT:\nunparsed=\nSPEC_DEFECT:\n' > "$TMP/marks.txt"
OUT="$(printf 'Stop 1 (grep assertion):\n  grep -c '\''SPEC_DEFECT:'\'' marks.txt\n  Expected: 2\nStop 2 (grep assertion):\n  grep -c '\''unparsed='\'' marks.txt\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "quoted-colon-and-equals-execute SPEC_DEFECT" "OK: grep -c 'SPEC_DEFECT:' marks.txt => 2 (expected eq 2)" "$OUT"
assert_contains "quoted-colon-and-equals-execute unparsed" "OK: grep -c 'unparsed=' marks.txt => 1 (expected eq 1)" "$OUT"
assert_contains "quoted-colon-and-equals-execute both executed" "GREP_EXECUTED=2" "$OUT"
assert_contains "quoted-colon-and-equals-execute none dropped" "GREP_DROPPED=0" "$OUT"

echo "--- unquoted-still-executes (run) ---"
OUT="$(printf 'Stop 1 (grep assertion):\n  grep -c alpha fixture.txt\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "unquoted-still-executes reports OK" "OK: grep -c alpha fixture.txt => 1 (expected eq 1)" "$OUT"
assert_contains "unquoted-still-executes is executed" "GREP_EXECUTED=1" "$OUT"

echo "--- double-quoted-still-dropped (run) ---"
OUT="$(printf 'grep -c "needle" needle.txt\teq\t2\nUNPARSED\t0\nDECLARED\t1\n' | rsg_run)"
assert_contains "double-quoted-still-dropped" "GREP_DROPPED=1" "$OUT"
assert_contains "double-quoted-still-dropped not executed" "GREP_EXECUTED=0" "$OUT"

echo "--- unsafe-quoted-content-still-dropped (run) ---"
for c in "grep -c 'x f" "grep -c '' f"; do
  OUT="$(printf '%s\teq\t1\nUNPARSED\t0\nDECLARED\t1\n' "$c" | rsg_run)"
  assert_contains "unsafe-quoted-content-still-dropped: $c" "DROPPED (not on read-only allowlist; not executed): $c" "$OUT"
  assert_contains "unsafe-quoted-content-still-dropped not executed: $c" "GREP_EXECUTED=0" "$OUT"
done

echo "--- rsg_run: find -execdir is dropped and never executed ---"
printf 'touch pwned-rsg-execdir.txt\n' > "$TMP/evil.sh"
OUT="$(printf 'Stop 1 (grep assertion):\n  find . -execdir sh evil.sh \\;\n  Expected: 0\n' | rsg_extract | rsg_run)"
assert_contains "execdir declared then dropped" "GREP_DROPPED=1" "$OUT"
assert_contains "execdir allowlist message" "not on read-only allowlist; not executed" "$OUT"
assert_contains "execdir never counts as executed" "GREP_EXECUTED=0" "$OUT"
assert_contains "execdir is all_dropped" "GREP_STATUS=all_dropped" "$OUT"
assert_eq "execdir did not write pwned-rsg-execdir.txt" "0" "$(test -e pwned-rsg-execdir.txt && echo 1 || echo 0)"
assert_eq "observe execdir is ERR and does not run" "ERR" "$(rsg_observe 'find . -execdir sh evil.sh \;')"
assert_eq "observe still did not write pwned-rsg-execdir.txt" "0" "$(test -e pwned-rsg-execdir.txt && echo 1 || echo 0)"

cd "$HERE"
rm -rf "$TMP"

echo "--- rsg_extract: bullet-style Stop conditions section (real shape on bdc-xo main) ---"
SPEC_GCD='# WO-SHOPOPS-GCD-METADATA-TO-LISTING-01

WO Class: CODE

## 9. Stop conditions (CI-executable)

- `node tests/test_cover_resolver.js` exits 0 if that suite exists.
- `grep -c gcd shopops-api/routes/store.js` returns 1 or greater.
- `grep -c skip_gcd_enrichment shopops-api/services/coverResolver.js` returns
  2 or greater (the guard survives the move).
- `LC_ALL=C grep -n NonAscii shopops-api/routes/store.js` returns nothing.
- `rg -c gcd shopops-api/routes/store.js` => 3
- `grep -c x y.js` (no expectation on this line)

## 10. Manifest requirements

- `grep -c "not in a stop section" z.js` returns 1
'
OUT="$(printf '%s\n' "$SPEC_GCD" | rsg_extract)"
assert_contains "'returns 1 or greater' -> ge 1" "grep -c gcd shopops-api/routes/store.js${TAB}ge${TAB}1" "$OUT"
assert_eq "wrapped expectation is not emitted as executable" "0" "$(printf '%s\n' "$OUT" | grep -c "skip_gcd_enrichment.*${TAB}ge${TAB}" || true)"
assert_contains "wrapped expectation assertion is named as unparsed" 'grep -c skip_gcd_enrichment shopops-api/services/coverResolver.js' "$OUT"
assert_contains "'returns nothing' -> eq 0 with LC_ALL prefix kept" "LC_ALL=C grep -n NonAscii shopops-api/routes/store.js${TAB}eq${TAB}0" "$OUT"
assert_contains "'=> 3' -> eq 3 (rg)" "rg -c gcd shopops-api/routes/store.js${TAB}eq${TAB}3" "$OUT"
assert_eq "no-expectation bullet not emitted as executable" "0" "$(printf '%s\n' "$OUT" | grep -c 'x y.js.*\teq\t' || true)"
assert_contains "no-expectation bullet is named as unparsed" 'grep -c x y.js' "$OUT"
assert_eq "bullets outside a Stop conditions section ignored" "0" "$(printf '%s\n' "$OUT" | grep -c 'not in a stop section' || true)"
assert_eq "runner commands are not grep assertions" "0" "$(printf '%s\n' "$OUT" | grep -c 'node tests' || true)"
assert_contains "DECLARED counts every backticked read-only command in the section (5), not the runner" "DECLARED${TAB}5" "$OUT"

echo "--- baseline prose is NOT special any more (round 5: the baseline filter was removed; run 3b8aea39 shape) ---"
SPEC_BASELINE='# WO-HARNESS-AUTO-REREVIEW-REPEAT-REASON-01

WO Class: CODE

## Stop conditions
Baseline on untouched tree: scenario 1 FAILS (enqueue blocked with
`repeat_reason_required`) -- the test must demonstrate the live defect before
the fix. `grep -rn "buildRereviewReason"` returns nothing.
1. Given PR head, greps show the reason builder and its call site, before/after
   counts in the PR body.
2. Test command exits 0 with scenarios 1-8 asserting values.
3. `grep -c "buildRereviewReason" packages/overseer/src/pr-review-ingest.ts` returns 1 or greater.

## Manifest requirements
Manifest v2: greps (stop 1), tests (stop 2).
'
OUT="$(printf '%s\n' "$SPEC_BASELINE" | rsg_extract)"
assert_contains "the grep inside the baseline paragraph is now an ordinary counted line (eq 0)" "grep -rn \"buildRereviewReason\"${TAB}eq${TAB}0" "$OUT"
assert_contains "the numbered post-fix assertion is kept (ge 1)" "grep -c \"buildRereviewReason\" packages/overseer/src/pr-review-ingest.ts${TAB}ge${TAB}1" "$OUT"
assert_contains "DECLARED counts both backticked read-only commands (2)" "DECLARED${TAB}2" "$OUT"
OUT="$(printf '## Stop conditions\n- Baseline: `grep -c x y` returns 0 before this WO.\n- `grep -c x y` returns 2 or greater\n' | rsg_extract)"
assert_contains "the baseline bullet is an ordinary counted line (eq 0)" "grep -c x y${TAB}eq${TAB}0" "$OUT"
assert_contains "the real bullet is kept (ge 2)" "grep -c x y${TAB}ge${TAB}2" "$OUT"
assert_contains "both bullets are declared (2)" "DECLARED${TAB}2" "$OUT"

echo "--- rsg_run on bullet-style spec in a fixture worktree ---"
TMP2="$(mktemp -d)"
mkdir -p "$TMP2/shopops-api/routes" "$TMP2/shopops-api/services"
printf 'gcd\ngcd\ngcd\n' > "$TMP2/shopops-api/routes/store.js"
printf 'skip_gcd_enrichment\nskip_gcd_enrichment\n' > "$TMP2/shopops-api/services/coverResolver.js"
OUT="$(cd "$TMP2" && printf '%s\n' "$SPEC_GCD" | rsg_extract | rsg_run)"
assert_contains "ge 1 holds with observed 3" 'OK: grep -c gcd shopops-api/routes/store.js => 3 (expected ge 1)' "$OUT"
assert_contains "ASCII absence holds" 'OK: LC_ALL=C grep -n NonAscii shopops-api/routes/store.js => 0 (expected eq 0)' "$OUT"
assert_contains "unparsed bullet assertions make evidence incomplete" "GREP_STATUS=incomplete" "$OUT"
rm -rf "$TMP2"

# ---------------------------------------------------------------------------
# WO-HARNESS-GREP-ALLOWLIST-QUOTED-MULTIWORD-01 named tests. Each prints one
# "PASS: <name>" line only when every assertion inside it passed.
# ---------------------------------------------------------------------------

echo "--- multiword_single_quoted_grep_executes ---"
named_begin
TMP3="$(mktemp -d)"
mkdir -p "$TMP3/src/components"
printf 'const a = 1;\n// Grand Comics Database\nconst b = 2;\n' > "$TMP3/src/components/GcdAttribution.tsx"
cd "$TMP3"
assert_rc "multiword allow: grep -c 'Grand Comics Database' src/components/GcdAttribution.tsx" 0 rsg_allow_cmd "grep -c 'Grand Comics Database' src/components/GcdAttribution.tsx"
assert_eq "multiword observe prints 1" "1" "$(rsg_observe "grep -c 'Grand Comics Database' src/components/GcdAttribution.tsx")"
MW_OUT="$(printf 'Stop 1 (grep assertion):\n  grep -c '\''Grand Comics Database'\'' src/components/GcdAttribution.tsx\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "multiword rsg_run GREP_EXECUTED=1" "GREP_EXECUTED=1" "$MW_OUT"
assert_contains "multiword rsg_run GREP_DROPPED=0" "GREP_DROPPED=0" "$MW_OUT"
assert_contains "multiword rsg_run GREP_MISMATCH=0" "GREP_MISMATCH=0" "$MW_OUT"
assert_contains "multiword rsg_run GREP_STATUS=passed (the engine status word for a fully executed set)" "GREP_STATUS=passed" "$MW_OUT"
assert_eq "multiword rsg_run has no DROPPED line" "0" "$(printf '%s\n' "$MW_OUT" | grep -c 'DROPPED (' || true)"
assert_eq "multiword pipeline to wc -l counts the grep -c line" "1" "$(rsg_observe "grep -c 'Grand Comics Database' src/components/GcdAttribution.tsx | wc -l")"
assert_eq "multiword is one argv word (double-space pattern matches 0)" "0" "$(rsg_observe "grep -c 'Grand  Comics' src/components/GcdAttribution.tsx")"
cd "$HERE"
named_end multiword_single_quoted_grep_executes

echo "--- unbalanced_quote_rejected ---"
named_begin
for c in "grep -c 'Grand Comics Database src/x.tsx" "grep -c Grand' Comics src/x.tsx" "grep -c 'a b'c f" "grep -c x'a b' f" "grep -c '' f"; do
  assert_rc "unbalanced/glued/empty rejected: $c" 1 rsg_allow_cmd "$c"
done
assert_rc "rsg_exec_pipeline on the unterminated quote returns 127" 127 rsg_exec_pipeline "grep -c 'Grand Comics Database src/x.tsx"
named_end unbalanced_quote_rejected

echo "--- double_quoted_still_rejected ---"
named_begin
for c in 'grep -c "Grand Comics Database" f' 'grep -c "needle" f' 'grep -c a\ b f' 'LC_ALL=C grep -n "[^ -~]" f' "grep -c 'a\"b' f" "grep -c 'a\\b' f"; do
  assert_rc "double quote / backslash rejected: $c" 1 rsg_allow_cmd "$c"
done
named_end double_quoted_still_rejected

echo "--- metachar_inside_single_quotes_not_executed ---"
named_begin
TMP4="$(mktemp -d)"
printf 'a;rm x\na|b\n$(id)\n' > "$TMP4/fixture.txt"
printf 'sentinel\n' > "$TMP4/x"
cd "$TMP4"
assert_eq "semicolon pattern is a literal (observe 1)" "1" "$(rsg_observe "grep -c 'a;rm x' fixture.txt")"
assert_eq "pipe pattern is a literal (observe 1)" "1" "$(rsg_observe "grep -c 'a|b' fixture.txt")"
assert_eq "command-substitution pattern is a literal (observe 1)" "1" "$(rsg_observe "grep -c '\$(id)' fixture.txt")"
for c in "grep -c a;rm x fixture.txt" "grep -c 'a b' f > out" "grep -c 'a b' f | awk x" "grep '--file=/etc/passwd' x"; do
  assert_rc "unquoted / flag-bearing rejected: $c" 1 rsg_allow_cmd "$c"
done
assert_eq "sentinel file x still exists" "1" "$(test -e x && echo 1 || echo 0)"
assert_eq "no file named out was created" "0" "$(test -e out && echo 1 || echo 0)"
cd "$HERE"
named_end metachar_inside_single_quotes_not_executed

echo "--- all_lanes_share_tokenizer ---"
named_begin
LANE_COUNT=0
for lane in $LANES; do LANE_COUNT=$((LANE_COUNT + 1)); done
assert_eq "LANES names 13 lanes" "13" "$LANE_COUNT"
assert_contains "LANES includes astra" "bdc-feature-development-astra.yaml" "$LANES"
assert_eq "the defaults dir carries exactly 13 bdc-feature-development lanes" "13" "$(ls "$DEFAULTS" | grep -cE '^bdc-feature-development(-[a-z0-9-]+)?\.yaml$' || true)"
for lane in $LANES; do
  LANE_CORE="$(extract_core "$DEFAULTS/$lane" rsg)"
  assert_eq "core byte-identical to codex: $lane" "$RSG_CORE" "$LANE_CORE"
  assert_contains "core uses rsg_parse_pipeline: $lane" "rsg_parse_pipeline" "$LANE_CORE"
  assert_contains "core names BDC_RSGARGV_SCRIPT: $lane" "BDC_RSGARGV_SCRIPT" "$LANE_CORE"
  assert_eq "core has no rsg_strip_arg: $lane" "0" "$(printf '%s\n' "$LANE_CORE" | grep -c 'rsg_strip_arg' || true)"
  assert_eq "core has no whitespace split of the segment: $lane" "0" "$(printf '%s\n' "$LANE_CORE" | grep -c 'set -- \$segment' || true)"
  assert_eq "core has no rsg_tokens_safe: $lane" "0" "$(printf '%s\n' "$LANE_CORE" | grep -c 'rsg_tokens_safe' || true)"
done
named_end all_lanes_share_tokenizer

echo "--- rsg_script_missing_fails_closed ---"
named_begin
TMP5="$(mktemp -d)"
printf 'alpha\nbeta\n' > "$TMP5/fixture.txt"
printf '%s\n' "$RSG_CORE" > "$TMP5/core.sh"
printf '. ./core.sh\nif rsg_allow_cmd "grep -c alpha fixture.txt"; then echo ALLOW_RC=0; else echo ALLOW_RC=1; fi\nprintf "grep -c alpha fixture.txt\\teq\\t1\\nUNPARSED\\t0\\nDECLARED\\t1\\n" | rsg_run\nrsg_exec_pipeline "grep -c alpha fixture.txt" >/dev/null 2>&1; echo EXEC_RC=$?\n' > "$TMP5/drive.sh"
MISSING_OUT="$(cd "$TMP5" && env -u ARCHON_LANE_SCRIPTS_DIR BDC_RSGARGV_SCRIPT=/nonexistent/rsg-argv.sh bash ./drive.sh 2>&1)"
assert_contains "script missing: rsg_allow_cmd returns 1" "ALLOW_RC=1" "$MISSING_OUT"
assert_contains "script missing: GREP_DROPPED=1" "GREP_DROPPED=1" "$MISSING_OUT"
assert_contains "script missing: GREP_EXECUTED=0 (nothing executed)" "GREP_EXECUTED=0" "$MISSING_OUT"
assert_contains "script missing: GREP_STATUS=all_dropped (nothing was executable)" "GREP_STATUS=all_dropped" "$MISSING_OUT"
assert_contains "script missing: rsg_exec_pipeline returns 127 and runs nothing" "EXEC_RC=127" "$MISSING_OUT"
assert_contains "script missing: the tried paths are logged" "rsg-argv.sh missing" "$MISSING_OUT"
named_end rsg_script_missing_fails_closed

echo "--- harness_grep_verdict_fixtures_match ---"
named_begin
VERDICTS="$HERE/fixtures/grep-verdicts.tsv"
ACCEPT_N=0
REJECT_N=0
if [ ! -f "$VERDICTS" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: verdict fixture missing: $VERDICTS"
else
  while IFS= read -r vline || [ -n "$vline" ]; do
    [ -n "$vline" ] || continue
    verdict="${vline%%"$TAB"*}"
    vcmd="${vline#*"$TAB"}"
    case "$verdict" in
      accept)
        ACCEPT_N=$((ACCEPT_N + 1))
        if rsg_allow_cmd "$vcmd"; then PASS=$((PASS + 1)); echo "PASS: fixture accept: $vcmd"; else FAIL=$((FAIL + 1)); echo "FAIL: fixture accept expected: $vcmd"; fi
        ;;
      reject)
        REJECT_N=$((REJECT_N + 1))
        if rsg_allow_cmd "$vcmd"; then FAIL=$((FAIL + 1)); echo "FAIL: fixture reject expected: $vcmd"; else PASS=$((PASS + 1)); echo "PASS: fixture reject: $vcmd"; fi
        ;;
      *) FAIL=$((FAIL + 1)); echo "FAIL: fixture record has an unknown verdict: $vline" ;;
    esac
  done < "$VERDICTS"
  if [ "$ACCEPT_N" -ge 20 ]; then PASS=$((PASS + 1)); echo "PASS: fixture has at least 20 accept records ($ACCEPT_N)"; else FAIL=$((FAIL + 1)); echo "FAIL: fixture accept records: $ACCEPT_N"; fi
  if [ "$REJECT_N" -ge 20 ]; then PASS=$((PASS + 1)); echo "PASS: fixture has at least 20 reject records ($REJECT_N)"; else FAIL=$((FAIL + 1)); echo "FAIL: fixture reject records: $REJECT_N"; fi
  if command -v sha256sum >/dev/null 2>&1; then
    echo "grep-verdicts.tsv sha256: $(sha256sum "$VERDICTS" | cut -d' ' -f1)"
  else
    echo "grep-verdicts.tsv sha256: $(shasum -a 256 "$VERDICTS" | cut -d' ' -f1)"
  fi
fi
named_end harness_grep_verdict_fixtures_match

rm -rf "$TMP3" "$TMP4" "$TMP5"

# ---------------------------------------------------------------------------
# WO-HARNESS-GREP-STOP-EXTRACTION-SILENT-WAIVE-01 named tests (bdc-xo #4753, stage 1).
# Each prints one "PASS: <name>" line only when every assertion inside it passed.
# ---------------------------------------------------------------------------
FIXTURE="$HERE/fixtures/stop-extract-cases.txt"
fixture_part() {
  # fixture_part <case name> <spec|expect>  -> that part of the case, verbatim
  awk -v c="$1" -v part="$2" '
    /^@@CASE / { cur = substr($0, 8); sect = "spec"; next }
    /^@@EXPECT$/ { sect = "expect"; next }
    /^@@END$/ { cur = ""; next }
    cur == c && sect == part { print }
  ' "$FIXTURE"
}
kv() {
  # kv <KEY> <text>  -> the value of the first KEY=value line
  printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1
}
count_records() {
  # count_records <text>  -> number of "<command> TAB <op> TAB <n>" records
  printf '%s\n' "$1" | grep -c "${TAB}\(eq\|ge\|le\)${TAB}" || true
}

echo "--- descriptive_headers_are_counted ---"
named_begin
T1="$(printf '## 8. Stop conditions\n\nStop 1 (dashboard no longer mounts the panel):\n  grep -c a f.ts\n  Expected: 0\n\nStop 1 (dashboard no longer mounts the panel):\n  grep -c b f.ts\n  Expected: 2\n\nStop 1 (dashboard no longer mounts the panel):\n  grep -c c f.ts\n  Expected: at least 1\n' | rsg_extract)"
assert_contains "descriptive header 1 emitted" "grep -c a f.ts${TAB}eq${TAB}0" "$T1"
assert_contains "descriptive header 2 emitted" "grep -c b f.ts${TAB}eq${TAB}2" "$T1"
assert_contains "descriptive header 3 emitted" "grep -c c f.ts${TAB}ge${TAB}1" "$T1"
assert_contains "DECLARED is 3" "DECLARED${TAB}3" "$T1"
assert_contains "UNPARSED is 0" "UNPARSED${TAB}0" "$T1"
assert_eq "three command lines are emitted" "3" "$(count_records "$T1")"
named_end descriptive_headers_are_counted

echo "--- colon_header_form_is_counted ---"
named_begin
T2="$(printf '## 8. Stop conditions\n\nStop 2: route is mounted\n  grep -c route src/App.tsx\n  Expected: 1\n\n**Stop 3 (route is mounted):**\n  grep -c page src/App.tsx\n  Expected: 2\n' | rsg_extract)"
assert_contains "colon header emitted" "grep -c route src/App.tsx${TAB}eq${TAB}1" "$T2"
assert_contains "bold header emitted" "grep -c page src/App.tsx${TAB}eq${TAB}2" "$T2"
assert_contains "DECLARED is 2" "DECLARED${TAB}2" "$T2"
assert_eq "two lines emitted" "2" "$(count_records "$T2")"
named_end colon_header_form_is_counted

echo "--- multi_command_stop_keeps_every_command ---"
named_begin
T3="$(fixture_part multi_command_stop spec | rsg_extract)"
assert_eq "emitted lines are in order" "grep -c one a.ts${TAB}eq${TAB}1
grep -c two b.ts${TAB}eq${TAB}2
grep -c three c.ts${TAB}ge${TAB}3
grep -c five e.ts${TAB}eq${TAB}5" "$(printf '%s\n' "$T3" | grep "${TAB}\(eq\|ge\|le\)${TAB}")"
assert_contains "the fourth command with no Expected is named in UNPARSED" "UNPARSED${TAB}1${TAB}grep -c four d.ts" "$T3"
assert_contains "DECLARED counts all five commands" "DECLARED${TAB}5" "$T3"
T3B="$(printf '## 8. Stop conditions\n\nStop 2 (three):\n  grep -c a f\n  Expected: 1\n  grep -c b f\n  Expected: 2\n  grep -c c f\n  Expected: 3\n' | rsg_extract)"
assert_contains "three commands in one block: DECLARED 3" "DECLARED${TAB}3" "$T3B"
assert_contains "three commands in one block: UNPARSED 0" "UNPARSED${TAB}0" "$T3B"
named_end multi_command_stop_keeps_every_command

echo "--- cgc_section8_fixture_counts_all_commands ---"
named_begin
T4="$(fixture_part cgc_section8 spec | rsg_extract)"
assert_contains "CGC Section 8: DECLARED 16" "DECLARED${TAB}16" "$T4"
assert_contains "CGC Section 8: UNPARSED 0" "UNPARSED${TAB}0" "$T4"
assert_eq "CGC Section 8: 16 emitted lines" "16" "$(count_records "$T4")"
assert_eq "CGC Section 8: the bun run test stop is test-owned and not counted" "0" "$(printf '%s\n' "$T4" | grep -c 'bun run test' || true)"
TMP_EMPTY="$(mktemp -d)"
T4R="$(cd "$TMP_EMPTY" && fixture_part cgc_section8 spec | rsg_extract | rsg_run)"
rm -rf "$TMP_EMPTY"
assert_eq "CGC Section 8: GREP_DECLARED=16" "16" "$(kv GREP_DECLARED "$T4R")"
assert_eq "CGC Section 8: GREP_STATUS is not none_declared" "1" "$([ "$(kv GREP_STATUS "$T4R")" != "none_declared" ] && echo 1 || echo 0)"
assert_contains "CGC Section 8: node -e is listed as DROPPED" "DROPPED (not on read-only allowlist; not executed): node -e" "$T4R"
assert_contains "CGC Section 8: git diff is listed as DROPPED" "DROPPED (not on read-only allowlist; not executed): git diff" "$T4R"
assert_contains "CGC Section 8: bunx tsc is listed as DROPPED" "DROPPED (not on read-only allowlist; not executed): bunx tsc" "$T4R"
assert_contains "CGC Section 8: bunx playwright is listed as DROPPED" "DROPPED (not on read-only allowlist; not executed): bunx playwright" "$T4R"
named_end cgc_section8_fixture_counts_all_commands

echo "--- header_without_command_is_declared_unparsed ---"
named_begin
T5="$(printf '## 8. Stop conditions\n\nStop 1 (staging works):\n  Open the staging page and confirm it loads.\n' | rsg_extract)"
assert_contains "header without a command: DECLARED 1" "DECLARED${TAB}1" "$T5"
assert_contains "header without a command: UNPARSED 1 names the header text" "UNPARSED${TAB}1${TAB}Stop 1 (staging works):" "$T5"
assert_eq "header without a command: no assertion line is emitted" "0" "$(count_records "$T5")"
named_end header_without_command_is_declared_unparsed

echo "--- test_owned_and_foreign_blocks_are_not_counted ---"
named_begin
SPEC_T6='## 8. Stop conditions

Stop 1 (test suite, stage 1):
  bun test x
  Expected: 3 passing

Stop 2 (unit tests):
  node tests/a.js
  Expected: 4 passing

Stop 3 (runtime proof):
  ssh hetzner-prod "docker exec app grep -c x /app/y"
  Expected: at least 1
'
T6="$(printf '%s\n' "$SPEC_T6" | rsg_extract)"
assert_contains "test-owned and foreign blocks: DECLARED 0" "DECLARED${TAB}0" "$T6"
assert_contains "test-owned and foreign blocks: UNPARSED 0" "UNPARSED${TAB}0" "$T6"
T6R="$(printf '%s\n' "$SPEC_T6" | rsg_extract | rsg_run)"
assert_eq "a spec with no grep-class stop is still truthfully none_declared" "none_declared" "$(kv GREP_STATUS "$T6R")"
named_end test_owned_and_foreign_blocks_are_not_counted

echo "--- none_declared_with_uncounted_commands_fails ---"
named_begin
MEC_CORE_T="$(extract_core "$CANONICAL_YAML" mec)"
eval "$MEC_CORE_T"
MEC_MANIFEST='WO: WO-X
Tests: 3/3 (bun test x)
Grep assertions: N/A (spec declares no grep stop conditions)'
mec_for() {
  # mec_for <rsg_run output>  -> "<rc>|<stderr>"
  local o="$1" err rc
  err="$(mktemp)"
  printf '%s\n' "$MEC_MANIFEST" | mec_check PROCEED CODE passed "$(kv GREP_DECLARED "$o")" "$(kv GREP_STATUS "$o")" 0 "$(kv GREP_EXECUTED "$o")" "$(kv GREP_DROPPED "$o")" "$(kv GREP_UNPARSED "$o")" "$(kv GREP_MISMATCH "$o")" "" >/dev/null 2>"$err"; rc=$?
  printf '%s|%s' "$rc" "$(cat "$err")"
  rm -f "$err"
}
T7R="$(printf '## 8. Stop conditions\n\ngrep -c x f.ts\nnode -e x\n' | rsg_extract | rsg_run)"
assert_eq "bare command lines outside any block: GREP_STATUS all_dropped" "all_dropped" "$(kv GREP_STATUS "$T7R")"
assert_eq "bare command lines: GREP_DECLARED 2" "2" "$(kv GREP_DECLARED "$T7R")"
assert_eq "bare command lines: GREP_UNPARSED 2" "2" "$(kv GREP_UNPARSED "$T7R")"
T7M="$(mec_for "$T7R")"
assert_eq "mec_check returns 1 on the uncounted command lines" "1" "${T7M%%|*}"
assert_contains "mec_check prints SPEC_DEFECT" "SPEC_DEFECT:" "$T7M"
T7K="$(printf '## 8. Stop conditions\n\n- `node -e x` exits 0\n' | rsg_extract | rsg_run)"
assert_eq "a backticked node line alone stays none_declared" "none_declared" "$(kv GREP_STATUS "$T7K")"
T7KM="$(mec_for "$T7K")"
assert_eq "a backticked node line alone: mec_check returns 0" "0" "${T7KM%%|*}"
T7P="$(printf '## 8. Stop conditions\n\nStop 1 (grep assertion):\n  grep -c alpha fixture.txt\n  Expected: 1\n\ngrep -c stray f.ts\n' | rsg_extract)"
assert_contains "a stray bare command after a block is part of that block and unparsed" "UNPARSED${TAB}1${TAB}grep -c stray f.ts" "$T7P"
named_end none_declared_with_uncounted_commands_fails

echo "--- existing_extraction_behavior_preserved ---"
named_begin
# The pre-existing extraction assertions run above and below this block unchanged except
# the rewritten ones named in the WO; this block re-pins the shapes the WO lists.
E1="$(printf 'Stop 2 (test suite):\n  bun test\n  Expected: ok\n' | rsg_extract)"
assert_eq "a test-suite-only spec stays none_declared (extract)" "UNPARSED${TAB}0
DECLARED${TAB}0" "$E1"
assert_eq "a test-suite-only spec stays none_declared (run)" "none_declared" "$(kv GREP_STATUS "$(printf '%s\n' "$E1" | rsg_run)")"
E2="$(printf 'Stop 1 (grep assertion):\n  grep -rn "a" src \\\n    | wc -l\n  Expected: 4\n' | rsg_extract)"
assert_contains "backslash continuation still joins" "grep -rn \"a\" src | wc -l${TAB}eq${TAB}4" "$E2"
E3="$(printf 'Stop 1 (grep assertion):\n  grep -c gamma f\n' | rsg_extract)"
assert_contains "legacy header without Expected is still declared and unparsed" "UNPARSED${TAB}1${TAB}grep -c gamma f" "$E3"
E4="$(printf '## Stop conditions\n- Baseline: `grep -c x y` returns 0 before this WO.\n- `grep -c x y` returns 2 or greater\n' | rsg_extract)"
assert_contains "second shape still counts the real bullet (baseline prose is no longer special)" "grep -c x y${TAB}ge${TAB}2" "$E4"
assert_contains "second shape declares both bullets (the baseline filter was removed in round 5)" "DECLARED${TAB}2" "$E4"
E5="$(printf 'Stop 2 (assert the log line):\n  awk x y\n  Expected: 1\n' | rsg_extract)"
assert_contains "legacy assert header counts any command-like line" "awk x y${TAB}eq${TAB}1" "$E5"
named_end existing_extraction_behavior_preserved

echo "--- all_lanes_share_extraction_core ---"
named_begin
LANE_COUNT2=0
for lane in $LANES; do LANE_COUNT2=$((LANE_COUNT2 + 1)); done
assert_eq "LANES names 13 lanes" "13" "$LANE_COUNT2"
assert_contains "LANES includes astra" "bdc-feature-development-astra.yaml" "$LANES"
RST_REF_SUM="$(extract_core "$CANONICAL_YAML" rst | cksum)"
for lane in $LANES; do
  LANE_CORE2="$(extract_core "$DEFAULTS/$lane" rsg)"
  assert_eq "rsg core byte-identical to codex: $lane" "$RSG_CORE" "$LANE_CORE2"
  assert_contains "rsg core carries note_uncounted: $lane" "note_uncounted" "$LANE_CORE2"
  assert_eq "rsg core has no note_unparsed left: $lane" "0" "$(printf '%s\n' "$LANE_CORE2" | grep -c 'note_unparsed' || true)"
  assert_eq "rst core byte-identical to codex: $lane" "$RST_REF_SUM" "$(extract_core "$DEFAULTS/$lane" rst | cksum)"
done
named_end all_lanes_share_extraction_core

echo "--- shared_fixture_cases_match_in_harness ---"
named_begin
CASE_N=0
if [ ! -f "$FIXTURE" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: shared extraction fixture missing: $FIXTURE"
else
  for cname in $(sed -n 's/^@@CASE //p' "$FIXTURE"); do
    CASE_N=$((CASE_N + 1))
    assert_eq "fixture case $cname" "$(fixture_part "$cname" expect)" "$(fixture_part "$cname" spec | ( unset RSG_STAGE_REPO; export GIT_DIR=/nonexistent; rsg_extract ))"
  done
  if [ "$CASE_N" -ge 12 ]; then PASS=$((PASS + 1)); echo "PASS: fixture has at least 12 cases ($CASE_N)"; else FAIL=$((FAIL + 1)); echo "FAIL: fixture case count: $CASE_N"; fi
  if command -v sha256sum >/dev/null 2>&1; then
    echo "stop-extract-cases.txt sha256: $(sha256sum "$FIXTURE" | cut -d' ' -f1)"
  else
    echo "stop-extract-cases.txt sha256: $(shasum -a 256 "$FIXTURE" | cut -d' ' -f1)"
  fi
fi
named_end shared_fixture_cases_match_in_harness

echo "--- multi_file_grep_count_is_summed ---"
named_begin
TMPM="$(mktemp -d)"
printf 'x\n' > "$TMPM/a.js"; : > "$TMPM/b.js"; : > "$TMPM/c.js"; : > "$TMPM/d.js"
assert_eq "4-file grep -c with counts 0,0,0,0 gives 0" "0" "$(cd "$TMPM" && rsg_observe 'grep -c zzz a.js b.js c.js d.js')"
printf 'k\n' > "$TMPM/a.js"; : > "$TMPM/b.js"; printf 'k\nk\n' > "$TMPM/c.js"; : > "$TMPM/d.js"
assert_eq "4-file grep -c with counts 1,0,2,0 gives 3" "3" "$(cd "$TMPM" && rsg_observe 'grep -c k a.js b.js c.js d.js')"
assert_eq "4-file grep -c -r style flag cluster is summed" "3" "$(cd "$TMPM" && rsg_observe 'grep -rc k a.js b.js c.js d.js')"
assert_eq "a single-file grep -c is unchanged" "2" "$(cd "$TMPM" && rsg_observe 'grep -c k c.js')"
printf '5:123\n7:9\n' > "$TMPM/n.txt"
assert_eq "grep -n output that looks like path:digits is NOT summed (no -c)" "2" "$(cd "$TMPM" && rsg_observe 'grep -n . n.txt')"
OUTM="$(cd "$TMPM" && printf 'Stop 1 (grep assertion):\n  grep -c k a.js b.js c.js d.js\n  Expected: 3\n' | rsg_extract | rsg_run)"
assert_contains "rsg_run reports OK with the summed count" "OK: grep -c k a.js b.js c.js d.js => 3 (expected eq 3)" "$OUTM"
assert_eq "rsg_run status passed" "passed" "$(kv GREP_STATUS "$OUTM")"
rm -rf "$TMPM"
named_end multi_file_grep_count_is_summed

echo "--- other_stage_stops_are_skipped_visibly ---"
named_begin
TMPS="$(mktemp -d)"
printf 'alpha\nalpha\n' > "$TMPS/fixture.txt"
SPEC_2STAGE='# WO-X

stages:
  - repo: thinmansoftware/bdc-harness
    what: harness side
  - repo: thinmansoftware/bdc-xo
    what: validator side

## 8. Stop conditions (CI-executable)

Stop 1 (grep assertion, stage 1):
  grep -c alpha fixture.txt
  Expected: 2

Stop 2 (grep assertion, stage 2):
  grep -c check22 scripts/cauldron/validate-wo-spec.sh
  Expected: at least 1

Stop 3 (test suite, stage 2):
  bash scripts/cauldron/tests/t.sh
  Expected: exit 0

Stop 4 (grep assertion, repo thinmansoftware/bdc-xo):
  grep -c note scripts/cauldron/lib/x.awk
  Expected: at least 1

Stop 5 (grep assertion, untagged):
  grep -c alpha fixture.txt
  Expected: 2

Stop 6 (grep assertion, stage 9):
  grep -c alpha fixture.txt
  Expected: 2
'
# current repo = stage 1 (bdc-harness)
OS1="$(cd "$TMPS" && printf '%s\n' "$SPEC_2STAGE" | RSG_STAGE_REPO=thinmansoftware/bdc-harness rsg_extract)"
assert_contains "stage 2 stop is emitted as OTHER_STAGE with its tag" "OTHER_STAGE${TAB}grep -c check22 scripts/cauldron/validate-wo-spec.sh${TAB}stage repo thinmansoftware/bdc-xo" "$OS1"
assert_contains "repo-tagged stop is emitted as OTHER_STAGE" "OTHER_STAGE${TAB}grep -c note scripts/cauldron/lib/x.awk${TAB}stage repo thinmansoftware/bdc-xo" "$OS1"
assert_contains "DECLARED counts only this stage plus untagged plus unknown-stage stops (3)" "DECLARED${TAB}3" "$OS1"
OS1R="$(cd "$TMPS" && printf '%s\n' "$SPEC_2STAGE" | RSG_STAGE_REPO=thinmansoftware/bdc-harness rsg_extract | rsg_run)"
assert_eq "stage 1 run: GREP_DECLARED=3" "3" "$(kv GREP_DECLARED "$OS1R")"
assert_eq "stage 1 run: GREP_EXECUTED=3" "3" "$(kv GREP_EXECUTED "$OS1R")"
assert_eq "stage 1 run: GREP_OTHER_STAGE=2" "2" "$(kv GREP_OTHER_STAGE "$OS1R")"
assert_eq "stage 1 run: nothing dropped" "0" "$(kv GREP_DROPPED "$OS1R")"
assert_eq "stage 1 run: status passed" "passed" "$(kv GREP_STATUS "$OS1R")"
assert_contains "stage 1 run: skipped stop is visible in GREP_LINE" "SKIPPED (other-stage): grep -c check22 scripts/cauldron/validate-wo-spec.sh" "$OS1R"
assert_contains "stage 1 run: skipped stop is visible in the detail with its tag" "SKIPPED (other-stage: stage repo thinmansoftware/bdc-xo): grep -c note scripts/cauldron/lib/x.awk" "$OS1R"
# current repo = stage 2 (bdc-xo): the stage 1 stop is the skipped one
OS2="$(cd "$TMPS" && printf '%s\n' "$SPEC_2STAGE" | RSG_STAGE_REPO=thinmansoftware/bdc-xo rsg_extract)"
assert_contains "stage 1 stop is OTHER_STAGE when running as stage 2" "OTHER_STAGE${TAB}grep -c alpha fixture.txt${TAB}stage repo thinmansoftware/bdc-harness" "$OS2"
assert_contains "stage 2 stops are declared when running as stage 2 (check22, note, untagged, stage 9)" "DECLARED${TAB}4" "$OS2"
# a stage-only spec with nothing for this stage stays visible
OS3R="$(cd "$TMPS" && printf '%s\n' "$SPEC_2STAGE" | grep -v 'Stop [3456]' | RSG_STAGE_REPO=thinmansoftware/bdc-other rsg_extract | rsg_run)"
assert_contains "unknown current repo still skips by tag, and says so" "stop(s) belong to other stages" "$OS3R"
# no known current repo (no git, no override): nothing is scoped, every stop counts
OS4="$(cd "$TMPS" && unset RSG_STAGE_REPO && export GIT_DIR=/nonexistent && printf '%s\n' "$SPEC_2STAGE" | rsg_extract)"
assert_eq "no current repo: no OTHER_STAGE record" "0" "$(printf '%s\n' "$OS4" | grep -c '^OTHER_STAGE' || true)"
assert_contains "no current repo: every grep stop is declared (5)" "DECLARED${TAB}5" "$OS4"
rm -rf "$TMPS"
named_end other_stage_stops_are_skipped_visibly

echo "--- backticked_command_with_separate_expected_is_one_assertion ---"
named_begin
R2A="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n  `grep -c x f`\n  Expected: 2\n' | rsg_extract)"
assert_contains "backticked command plus a separate Expected: 2 is executable with eq 2" "grep -c x f${TAB}eq${TAB}2" "$R2A"
assert_contains "UNPARSED is 0" "UNPARSED${TAB}0" "$R2A"
assert_contains "DECLARED is 1" "DECLARED${TAB}1" "$R2A"
R2B="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n- `grep -c x y` returns 2 or greater\n' | rsg_extract)"
assert_contains "an inline expectation on the same line still uses the inline path" "grep -c x y${TAB}ge${TAB}2" "$R2B"
named_end backticked_command_with_separate_expected_is_one_assertion

echo "--- foreign_command_closes_a_pending_counted_command ---"
named_begin
R2C="$(printf '## 8. Stop conditions\n\nStop 1 (mixed block):\n  grep -c x f\n  curl -s https://example.test/health\n  Expected: 0\n' | rsg_extract)"
assert_eq "no grep assertion with eq 0 is emitted" "0" "$(printf '%s\n' "$R2C" | grep -c "^grep -c x f${TAB}" || true)"
assert_contains "the grep is declared and unparsed" "UNPARSED${TAB}1${TAB}grep -c x f" "$R2C"
assert_contains "DECLARED is 1" "DECLARED${TAB}1" "$R2C"
R2CR="$(printf '## 8. Stop conditions\n\nStop 1 (mixed block):\n  grep -c x f\n  curl -s https://example.test/health\n  Expected: 0\n' | rsg_extract | rsg_run)"
assert_eq "such a stop can no longer pass: nothing executed, status all_dropped" "all_dropped" "$(kv GREP_STATUS "$R2CR")"
named_end foreign_command_closes_a_pending_counted_command

echo "--- counted_then_foreign_each_keep_their_own_expected ---"
named_begin
R2D="$(printf '## 8. Stop conditions\n\nStop 1 (mixed block):\n  grep -c x f\n  Expected: 1\n  curl -s https://example.test/health\n  Expected: 200\n' | rsg_extract)"
assert_contains "the grep is paired with its own Expected" "grep -c x f${TAB}eq${TAB}1" "$R2D"
assert_eq "the curl is ignored (no record for it)" "0" "$(printf '%s\n' "$R2D" | grep -c 'curl' || true)"
assert_contains "UNPARSED is 0" "UNPARSED${TAB}0" "$R2D"
assert_contains "DECLARED is 1" "DECLARED${TAB}1" "$R2D"
named_end counted_then_foreign_each_keep_their_own_expected

# ---------------------------------------------------------------------------
# Round 3 (Overseer CHANGES_REQUESTED at e321afc1, two majors): a command word ends at a space
# OR a tab, and EVERY command start (counted, foreign, inline backticked) closes the pending
# command as unparsed through the one begin_command function.
# ---------------------------------------------------------------------------
echo "--- tab_separated_command_is_counted ---"
named_begin
TTAB="$(cd "$HERE" && printf '## 8. Stop conditions\n\nStop 1 (tabbed):\n  grep\t-c x f\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "tab-separated grep is emitted (tab normalised to a space) with eq 1" "grep -c x f${TAB}eq${TAB}1" "$TTAB"
assert_contains "DECLARED is 1" "DECLARED${TAB}1" "$TTAB"
assert_contains "UNPARSED is 0" "UNPARSED${TAB}0" "$TTAB"
TTMP="$(mktemp -d)"
printf 'x\n' > "$TTMP/f"
TTABR="$(cd "$TTMP" && printf '## 8. Stop conditions\n\nStop 1 (tabbed):\n  grep\t-c x f\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract | rsg_run)"
assert_eq "tab-separated grep: GREP_DECLARED=1" "1" "$(kv GREP_DECLARED "$TTABR")"
assert_eq "tab-separated grep is executed" "1" "$(kv GREP_EXECUTED "$TTABR")"
assert_eq "tab-separated grep passes" "passed" "$(kv GREP_STATUS "$TTABR")"
for form in 'LC_ALL=C\tgrep -c x f' 'cd\t.\t&&\tgrep -c x f' 'test\t-f f' '- grep\t-c x f' '`grep\t-c x f`'; do
  TF="$(printf "## 8. Stop conditions\n\nStop 1 (tabbed):\n  $form\n  Expected: 1\n" | RSG_STAGE_REPO=x/y rsg_extract)"
  assert_contains "tab form is counted: $form" "DECLARED${TAB}1" "$TF"
done
TBK="$(printf '## 8. Stop conditions\n\ngrep\t-c x f.ts\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "a bare tab-separated command outside a block is the uncounted backstop" "UNPARSED${TAB}1${TAB}grep -c x f.ts" "$TBK"
rm -rf "$TTMP"
named_end tab_separated_command_is_counted

echo "--- inline_command_closes_a_pending_command ---"
named_begin
INL="$(printf '## 8. Stop conditions\n\nStop 1 (inline after pending):\n  grep -c missing f\n- `grep -c x f` returns 1\n  Expected: 0\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the earlier pending command is UNPARSED" "UNPARSED${TAB}1${TAB}grep -c missing f" "$INL"
assert_contains "the inline command keeps its own inline expectation" "grep -c x f${TAB}eq${TAB}1" "$INL"
assert_eq "the final Expected: 0 is not paired with the earlier command" "0" "$(printf '%s\n' "$INL" | grep -c "grep -c missing f${TAB}" || true)"
assert_contains "DECLARED is 2" "DECLARED${TAB}2" "$INL"
INL2="$(printf '## 8. Stop conditions\n\nStop 1 (two inlines):\n  grep -c a f\n- `grep -c b f` returns 2\n- `grep -c c f`\n  Expected: 3\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "a backticked command with no inline expectation pairs with the next Expected" "grep -c c f${TAB}eq${TAB}3" "$INL2"
assert_contains "and the first pending grep is unparsed" "UNPARSED${TAB}1${TAB}grep -c a f" "$INL2"
named_end inline_command_closes_a_pending_command

# ---------------------------------------------------------------------------
# Round 4 (Overseer CHANGES_REQUESTED at aa9950d1, rescoped to fail-closed pairing): inside a
# stop block a pending counted command is closed ONLY by its immediately following Expected
# line (blank lines between them are allowed); ANY other non-blank line closes it as UNPARSED.
# ---------------------------------------------------------------------------
echo "--- env_prefixed_foreign_closes_pending ---"
named_begin
ENVF="$(printf '## 8. Stop conditions\n\nStop 1 (env foreign):\n  grep -c missing /dev/null\n  LC_ALL=C curl -s https://example.test/health\n  Expected: 0\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the grep is declared and unparsed" "UNPARSED${TAB}1${TAB}grep -c missing /dev/null" "$ENVF"
assert_eq "no grep assertion is emitted" "0" "$(count_records "$ENVF")"
assert_contains "DECLARED is 1" "DECLARED${TAB}1" "$ENVF"
ENVFR="$(cd "$HERE" && printf '## 8. Stop conditions\n\nStop 1 (env foreign):\n  grep -c missing /dev/null\n  LC_ALL=C curl -s https://example.test/health\n  Expected: 0\n' | RSG_STAGE_REPO=x/y rsg_extract | rsg_run)"
assert_eq "the stop can no longer pass (nothing executed)" "all_dropped" "$(kv GREP_STATUS "$ENVFR")"
for pre in 'FOO=1 BAR=2 ssh host true' 'cd sub && curl -s u' 'sudo -n docker ps' 'env X=1 gh pr view'; do
  EP="$(printf "## 8. Stop conditions\n\nStop 1 (foreign):\n  grep -c x f\n  $pre\n  Expected: 0\n" | RSG_STAGE_REPO=x/y rsg_extract)"
  assert_eq "foreign line closes the pending grep: $pre" "0" "$(count_records "$EP")"
done
named_end env_prefixed_foreign_closes_pending

echo "--- any_nonblank_line_closes_pending ---"
named_begin
for mid in '  (run from the repo root)' '- a bullet note' '  `curl -s https://example.test/health`' '  1. numbered note' '  **bold note**' '  # a comment-looking line' '  cd sub'; do
  NB="$(printf '## 8. Stop conditions\n\nStop 1 (closed by a line):\n  grep -c x f\n%s\n  Expected: 1\n' "$mid" | RSG_STAGE_REPO=x/y rsg_extract)"
  assert_contains "the grep is unparsed when this line follows it: $mid" "UNPARSED${TAB}1${TAB}grep -c x f" "$NB"
  assert_eq "and the Expected pairs with nothing: $mid" "0" "$(count_records "$NB")"
done
NBH="$(printf '## 8. Stop conditions\n\nStop 1 (closed by the next header):\n  grep -c x f\n\nStop 2 (next):\n  grep -c y f\n  Expected: 2\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "a following header closes the pending command" "UNPARSED${TAB}1${TAB}grep -c x f" "$NBH"
assert_contains "and the next block pairs normally" "grep -c y f${TAB}eq${TAB}2" "$NBH"
named_end any_nonblank_line_closes_pending

echo "--- blank_lines_between_command_and_expected_pair ---"
named_begin
BLK="$(printf '## 8. Stop conditions\n\nStop 1 (blank lines):\n  grep -c x f\n\n\n   \n  Expected: 2\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "blank and whitespace-only lines between command and Expected still pair" "grep -c x f${TAB}eq${TAB}2" "$BLK"
assert_contains "UNPARSED is 0" "UNPARSED${TAB}0" "$BLK"
BLKF="$(printf '## 8. Stop conditions\n\nStop 1 (fenced):\n```\n  grep -c x f\n```\n  Expected: 2\n```\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "a command wrapped in a code fence still pairs (fence lines are not content)" "grep -c x f${TAB}eq${TAB}2" "$BLKF"
named_end blank_lines_between_command_and_expected_pair

echo "--- earlier_round_repros_still_hold ---"
named_begin
RR1="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n  `grep -c x f`\n  Expected: 2\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "round 1: backticked command plus a separate Expected is one assertion" "grep -c x f${TAB}eq${TAB}2" "$RR1"
RR1B="$(printf '## 8. Stop conditions\n\nStop 1 (mixed):\n  grep -c x f\n  curl -s https://example.test/health\n  Expected: 0\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "round 1: grep, curl, Expected: 0 leaves the grep unparsed" "UNPARSED${TAB}1${TAB}grep -c x f" "$RR1B"
RR2="$(printf '## 8. Stop conditions\n\nStop 1 (tabbed):\n  grep\t-c x f\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "round 2: a tab-separated grep is counted" "grep -c x f${TAB}eq${TAB}1" "$RR2"
RR2B="$(printf '## 8. Stop conditions\n\nStop 1 (inline):\n  grep -c missing f\n- `grep -c x f` returns 1\n  Expected: 0\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "round 3: an inline command closes the earlier pending command" "UNPARSED${TAB}1${TAB}grep -c missing f" "$RR2B"
assert_contains "round 3: the inline command keeps its own expectation" "grep -c x f${TAB}eq${TAB}1" "$RR2B"
named_end earlier_round_repros_still_hold

# ---------------------------------------------------------------------------
# Round 5 (Overseer CHANGES_REQUESTED at 7b30ac9e; acting XO ruling fence 283): the baseline
# filter is REMOVED from the rsg core. It scanned the whole line, so a real assertion whose
# command merely contained the word "baseline" was silently waived. Baseline prose is just
# prose: inside a stop block it closes a pending command as UNPARSED like any other
# non-blank non-Expected line.
# ---------------------------------------------------------------------------
echo "--- baseline_word_in_command_args_is_run ---"
named_begin
BLT="$(mktemp -d)"
B1="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n  grep -c baseline /dev/null\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "DECLARED is 1 (the assertion is not waived)" "DECLARED${TAB}1" "$B1"
assert_contains "the command is emitted with its expectation" "grep -c baseline /dev/null${TAB}eq${TAB}1" "$B1"
B1R="$(cd "$BLT" && printf '## 8. Stop conditions\n\nStop 1 (route check):\n  grep -c baseline /dev/null\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract | rsg_run)"
assert_eq "GREP_DECLARED=1" "1" "$(kv GREP_DECLARED "$B1R")"
assert_eq "the assertion is EXECUTED" "1" "$(kv GREP_EXECUTED "$B1R")"
assert_eq "and it FAILS: the actual count is 0, not 1" "mismatch" "$(kv GREP_STATUS "$B1R")"
assert_contains "the observed count is 0" "MISMATCH: grep -c baseline /dev/null => 0 (expected eq 1)" "$B1R"
B1Q="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n  `grep -c baseline /dev/null`\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the backticked form is counted too" "grep -c baseline /dev/null${TAB}eq${TAB}1" "$B1Q"
B2="$(printf '## 8. Stop conditions\n\nStop 1 (route check):\n- `grep -c baseline f` returns 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "an inline command with baseline in its arguments is counted" "grep -c baseline f${TAB}eq${TAB}1" "$B2"
B3="$(printf '## 8. Stop conditions\n\n- `grep -c baseline f` returns 1\n- `grep -c before-the-fix f` returns 2\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "outside a block the second shape counts it" "grep -c baseline f${TAB}eq${TAB}1" "$B3"
assert_contains "and so does a before-the-fix looking argument" "grep -c before-the-fix f${TAB}eq${TAB}2" "$B3"
rm -rf "$BLT"
named_end baseline_word_in_command_args_is_run

echo "--- baseline_prose_closes_pending_as_unparsed ---"
named_begin
BP1="$(printf '## 8. Stop conditions\n\nStop 1 (x):\n  grep -c x y\n  Baseline: this returned 0 before this WO.\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the pending command is UNPARSED" "UNPARSED${TAB}1${TAB}grep -c x y" "$BP1"
assert_eq "the Expected pairs with nothing" "0" "$(count_records "$BP1")"
for lab in 'Baseline (before): 2' '(baseline 2)' 'Baseline on untouched tree: scenario 1 fails' 'before the fix this was 0'; do
  BPL="$(printf '## 8. Stop conditions\n\nStop 1 (x):\n  grep -c x y\n  %s\n  Expected: 1\n' "$lab" | RSG_STAGE_REPO=x/y rsg_extract)"
  assert_contains "baseline-looking line closes the pending command: $lab" "UNPARSED${TAB}1${TAB}grep -c x y" "$BPL"
done
BP2="$(printf '## 8. Stop conditions\n\nStop 1 (x):\n  Baseline: nothing yet\n  grep -c x y\n  Expected: 2\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "baseline prose before a command does not hide the command" "grep -c x y${TAB}eq${TAB}2" "$BP2"
named_end baseline_prose_closes_pending_as_unparsed

# ---------------------------------------------------------------------------
# Round 6 (Overseer CHANGES_REQUESTED at 3a964c78): the stage list was deduplicated before
# ordinal stage tags were resolved, so repeated repositories shifted every later stage and
# a stage's own assertions were skipped as another stage's. The list now keeps EVERY entry of
# the spec's first "stages:" block, in order; stage N is entry N; an unresolvable tag is
# counted (fail closed), never skipped.
# ---------------------------------------------------------------------------
echo "--- repeated_repo_stages_keep_ordinals ---"
named_begin
RS_SPEC='# WO-X

stages:
  - repo: org/a
    what: one
  - repo: org/a
    what: two
  - repo: org/b
    what: three

## 8. Stop conditions (CI-executable)

Stop 1 (grep assertion, stage 1):
  grep -c alpha f.txt
  Expected: 1

Stop 2 (grep assertion, stage 2):
  grep -c needle f.txt
  Expected: 1

Stop 3 (grep assertion, stage 3):
  grep -c alpha f.txt
  Expected: 1
'
RST="$(mktemp -d)"
printf 'alpha\n' > "$RST/f.txt"
RS_A="$(cd "$RST" && printf '%s\n' "$RS_SPEC" | RSG_STAGE_REPO=org/a rsg_extract)"
assert_contains "running in org/a: the stage 2 grep is declared (not shifted onto org/b)" "grep -c needle f.txt${TAB}eq${TAB}1" "$RS_A"
assert_contains "running in org/a: stages 1 and 2 are declared" "DECLARED${TAB}2" "$RS_A"
assert_contains "running in org/a: the stage 3 grep is skipped visibly as other-stage" "OTHER_STAGE${TAB}grep -c alpha f.txt${TAB}stage repo org/b" "$RS_A"
RS_AR="$(cd "$RST" && printf '%s\n' "$RS_SPEC" | RSG_STAGE_REPO=org/a rsg_extract | rsg_run 2>/dev/null)"
assert_eq "running in org/a: both declared greps are executed" "2" "$(kv GREP_EXECUTED "$RS_AR")"
assert_eq "running in org/a: the stage 2 grep FAILS as it should (needle is absent)" "mismatch" "$(kv GREP_STATUS "$RS_AR")"
assert_contains "running in org/a: the failure names the stage 2 command" "MISMATCH: grep -c needle f.txt => 0 (expected eq 1)" "$RS_AR"
assert_eq "running in org/a: one stop is skipped as other-stage" "1" "$(kv GREP_OTHER_STAGE "$RS_AR")"
RS_B="$(cd "$RST" && printf '%s\n' "$RS_SPEC" | RSG_STAGE_REPO=org/b rsg_extract)"
assert_contains "running in org/b: only the stage 3 grep is declared" "DECLARED${TAB}1" "$RS_B"
assert_eq "running in org/b: stages 1 and 2 are both skipped as other-stage" "2" "$(printf '%s\n' "$RS_B" | grep -c '^OTHER_STAGE' || true)"
RS_BR="$(cd "$RST" && printf '%s\n' "$RS_SPEC" | RSG_STAGE_REPO=org/b rsg_extract | rsg_run 2>/dev/null)"
assert_eq "running in org/b: the stage 3 grep is executed and passes" "passed" "$(kv GREP_STATUS "$RS_BR")"
assert_eq "running in org/b: executed 1" "1" "$(kv GREP_EXECUTED "$RS_BR")"
rm -rf "$RST"
named_end repeated_repo_stages_keep_ordinals

echo "--- stage_mapping_table_keeps_every_entry ---"
named_begin
stage_case() {
  # stage_case <list "a a b"> <stage n> <current repo>  -> expect: skipped iff entry n exists and differs
  local list="$1" n="$2" cur="$3" spec="" r out entry="" i=0 want
  spec="stages:"$'\n'
  for r in $list; do spec="$spec  - repo: org/$r"$'\n'"    what: x"$'\n'; i=$((i + 1)); [ "$i" -eq "$n" ] && entry="$r"; done
  spec="$spec"$'\n'"## 8. Stop conditions"$'\n\n'"Stop 1 (grep assertion, stage $n):"$'\n'"  grep -c x f"$'\n'"  Expected: 1"$'\n'
  out="$(printf '%s' "$spec" | RSG_STAGE_REPO="org/$cur" rsg_extract)"
  if [ -n "$entry" ] && [ "$entry" != "$cur" ]; then want=skipped; else want=counted; fi
  if [ "$want" = skipped ]; then
    assert_eq "stages [$list] stage $n in org/$cur is skipped as other-stage" "1 0" "$(printf '%s\n' "$out" | grep -c '^OTHER_STAGE' || true) $(printf '%s\n' "$out" | grep -c "grep -c x f${TAB}eq" || true)"
  else
    assert_eq "stages [$list] stage $n in org/$cur is counted (never skipped)" "0 1" "$(printf '%s\n' "$out" | grep -c '^OTHER_STAGE' || true) $(printf '%s\n' "$out" | grep -c "grep -c x f${TAB}eq" || true)"
  fi
}
for lst in "a a b" "a b a" "a a a" "a b" "b a a b"; do
  for sn in 1 2 3 4 5; do
    for cr in a b; do stage_case "$lst" "$sn" "$cr"; done
  done
done
named_end stage_mapping_table_keeps_every_entry

echo "--- a second stages: list (the canonical-stages copy) does not extend the stage list ---"
named_begin
DUP_SPEC='stages:
  - repo: org/a
    what: one
  - repo: org/b
    what: two

## Canonical stages

```yaml
stages:
  - id: x
    repo: org/a
  - id: y
    repo: org/b
```

## 8. Stop conditions

Stop 1 (grep assertion, stage 2):
  grep -c x f
  Expected: 1
'
DUP_A="$(printf '%s\n' "$DUP_SPEC" | RSG_STAGE_REPO=org/a rsg_extract)"
assert_eq "stage 2 is org/b in a spec that repeats its stage list: skipped in org/a" "1" "$(printf '%s\n' "$DUP_A" | grep -c '^OTHER_STAGE' || true)"
DUP_B="$(printf '%s\n' "$DUP_SPEC" | RSG_STAGE_REPO=org/b rsg_extract)"
assert_contains "and counted in org/b" "DECLARED${TAB}1" "$DUP_B"
named_end repeated_stage_list_does_not_shift_ordinals

# ---------------------------------------------------------------------------
# Operator-check tag (stage 1 follow-up, acting XO ruling fence 283): a stop header
# "Stop N (operator check): ..." is skipped VISIBLY as OPERATOR; untagged prose stops stay
# UNPARSED (fail closed); a spec whose stops are ALL operator-tagged reports operator_only
# with a loud stderr warning.
# ---------------------------------------------------------------------------
echo "--- operator_tagged_stop_is_skipped_visibly ---"
named_begin
OPT="$(mktemp -d)"
printf 'x\n' > "$OPT/f"
OP1X="$(fixture_part operator_check_skipped_visibly spec | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the operator stop is emitted as an OPERATOR record" "OPERATOR${TAB}Stop 2 (operator check): sign in on the desktop and confirm the page loads." "$OP1X"
assert_contains "it is not declared: DECLARED counts only the grep stop" "DECLARED${TAB}1" "$OP1X"
assert_contains "and not unparsed" "UNPARSED${TAB}0" "$OP1X"
OP1R="$(cd "$OPT" && fixture_part operator_check_skipped_visibly spec | RSG_STAGE_REPO=x/y rsg_extract | rsg_run 2>/dev/null)"
assert_eq "GREP_OPERATOR=1" "1" "$(kv GREP_OPERATOR "$OP1R")"
assert_contains "GREP_LINE shows SKIPPED (operator check)" "SKIPPED (operator check): Stop 2 (operator check)" "$OP1R"
assert_eq "the grep stop still runs and the spec passes (the operator stop never fails)" "passed" "$(kv GREP_STATUS "$OP1R")"
assert_eq "nothing is dropped" "0" "$(kv GREP_DROPPED "$OP1R")"
assert_contains "the detail lists it too" "SKIPPED (operator check): Stop 2 (operator check)" "$(printf '%s\n' "$OP1R" | sed -n '/per-assertion detail/,$p')"
OPC="$(printf '## 8. Stop conditions\n\nStop 1 (Operator Check): do A\n  Expected: done\n\nStop 2 (grep assertion):\n  grep -c x f\n  Expected: 1\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the tag is case-insensitive" "OPERATOR${TAB}Stop 1 (Operator Check): do A" "$OPC"
OPS="$(printf '## 8. Stop conditions\n\nStop 1 (  operator   check  ): do A\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "spaces inside the parentheses are tolerated" "OPERATOR${TAB}" "$OPS"
rm -rf "$OPT"
named_end operator_tagged_stop_is_skipped_visibly

echo "--- untagged_prose_stop_is_unparsed_next_to_operator ---"
named_begin
OP2="$(fixture_part untagged_prose_stop_next_to_operator spec | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "the operator stop is skipped visibly" "OPERATOR${TAB}Stop 1 (operator check): do X on the desktop." "$OP2"
assert_contains "the untagged prose stop is declared and unparsed" "UNPARSED${TAB}1${TAB}Stop 2 (staging works): open the page" "$OP2"
OP2R="$(fixture_part untagged_prose_stop_next_to_operator spec | RSG_STAGE_REPO=x/y rsg_extract | rsg_run 2>/dev/null)"
assert_eq "an untagged prose stop can never pass (all_dropped, not operator_only)" "all_dropped" "$(kv GREP_STATUS "$OP2R")"
OP2M="$(printf '## 8. Stop conditions\n\nStop 3 (staging operator check works):\n  Open the page.\n' | RSG_STAGE_REPO=x/y rsg_extract)"
assert_eq "operator check in the middle of the header text is not the tag" "0" "$(printf '%s\n' "$OP2M" | grep -c '^OPERATOR' || true)"
assert_contains "so that header is unparsed" "UNPARSED${TAB}1" "$OP2M"
named_end untagged_prose_stop_is_unparsed_next_to_operator

echo "--- untagged_prose_stop_still_fails (spec Test 22: only the exact tag counts) ---"
named_begin
OP22SPEC='## 8. Stop conditions

Stop 1 (staging works):
  Given the staging page, when it loads, then the header shows.

Stop 2 (operator proof): sign in on the desktop and look.

Stop 3 (operator): sign in on the desktop and look.

Stop 4 (operator check, John desktop): sign in and look.
'
OP22="$(printf '%s\n' "$OP22SPEC" | RSG_STAGE_REPO=x/y rsg_extract)"
assert_contains "DECLARED is 4: none of the four is the exact tag" "DECLARED${TAB}4" "$OP22"
assert_contains "UNPARSED is 4" "UNPARSED${TAB}4${TAB}" "$OP22"
assert_eq "no OPERATOR line is emitted" "0" "$(printf '%s\n' "$OP22" | grep -c '^OPERATOR' || true)"
assert_contains "(operator proof is named" "Stop 2 (operator proof): sign in on the desktop and look." "$OP22"
assert_contains "(operator) is named" "Stop 3 (operator): sign in on the desktop and look." "$OP22"
assert_contains "(operator check, x) is named" "Stop 4 (operator check, John desktop): sign in and look." "$OP22"
OP22R="$(printf '%s\n' "$OP22SPEC" | RSG_STAGE_REPO=x/y rsg_extract | rsg_run 2>/dev/null)"
OP22M="$(mec_for "$OP22R")"
assert_eq "the run fails through mec_check" "1" "${OP22M%%|*}"
assert_contains "as SPEC_DEFECT" "SPEC_DEFECT:" "$OP22M"
named_end untagged_prose_stop_still_fails

echo "--- all_operator_spec_warns ---"
named_begin
OP3ERR="$(mktemp)"
OP3="$(fixture_part all_operator_stops spec | RSG_STAGE_REPO=x/y rsg_extract | rsg_run 2>"$OP3ERR")"
assert_eq "GREP_STATUS=operator_only" "operator_only" "$(kv GREP_STATUS "$OP3")"
assert_eq "GREP_OPERATOR=2" "2" "$(kv GREP_OPERATOR "$OP3")"
assert_eq "GREP_DECLARED=0" "0" "$(kv GREP_DECLARED "$OP3")"
assert_contains "GREP_LINE names the operator checks" "SKIPPED (operator check): Stop 1 (operator check): do A." "$OP3"
assert_contains "a loud stderr warning" "WARNING: GREP_STATUS=operator_only" "$(cat "$OP3ERR")"
assert_eq "no warning when some stop is verified mechanically" "" "$(cd "$HERE" && fixture_part operator_check_skipped_visibly spec | RSG_STAGE_REPO=x/y rsg_extract | rsg_run 2>&1 >/dev/null | grep WARNING || true)"
assert_contains "the warning names every operator stop" "Stop 2 (Operator Check): do B." "$(cat "$OP3ERR")"
rm -f "$OP3ERR"
# mec_check and sme_process: operator_only is a visible N/A, never a pass line
OP3M="$(mec_for "$OP3")"
assert_eq "mec_check does not fail an operator_only spec (declared 0)" "0" "${OP3M%%|*}"
SME_CORE_T="$(extract_core "$CANONICAL_YAML" sme)"
eval "$SME_CORE_T"
SME_IN='WO: WO-X
Tests: 3/3 (bun test x)
Grep assertions: N/A (placeholder)
VALIDATION: PASS'
SME_OUT="$(printf '%s\n' "$SME_IN" | sme_process "3/3 (bun test x)" passed "$(kv GREP_LINE "$OP3")" "$(kv GREP_STATUS "$OP3")" 0)"
assert_contains "the manifest carries a visible N/A for the Grep assertions line" "Grep assertions: N/A (all 2 stop condition(s) are operator checks" "$SME_OUT"
assert_contains "and the audit line says operator_only, not passed" "greps=operator_only" "$SME_OUT"
assert_not_contains "never a pass line for the greps" "greps=passed" "$SME_OUT"
named_end all_operator_spec_warns

echo "--- every_counted_command_pairs_with_its_own_expected_or_is_unparsed (mixed-sequence table + seeded fuzz) ---"
named_begin
export RSG_STAGE_REPO=thinmansoftware/fuzz-none
fz_close() {
  # close a pending counted command as unparsed (the invariant under test)
  case "$FZ_PENDING" in zq*) FZ_UNP="$FZ_UNP $FZ_PENDING"; FZ_ANYC=1 ;; esac
}
fz_other() {
  # any non-blank line that is not a counted command closes a pending counted command too
  fz_close; FZ_PENDING=OTHER
}
fz_check() {
  # fz_check <tokens...>: render the sequence, compute the oracle, compare with rsg_extract
  local k=0 t id n spec out expected_paired actual_paired expected_unp actual_unp line hdr_exp="" label="$*"
  FZ_PENDING=""; FZ_UNP=""; FZ_ANYC=0; FZ_ANYE=0
  local paired=""
  spec=$'## 8. Stop conditions\n\nStop 1 (fuzz):\n'
  for t in "$@"; do
    k=$((k + 1)); id="zq${k}zq"
    case "$t" in
      C)  spec="$spec  grep -c $id f"$'\n'; fz_close; FZ_PENDING="$id" ;;
      T)  spec="$spec  grep${TAB}-c $id f"$'\n'; fz_close; FZ_PENDING="$id" ;;
      BL) spec="$spec- grep -c $id f"$'\n'; fz_close; FZ_PENDING="$id" ;;
      BQ) spec="$spec  \`grep -c $id f\`"$'\n'; fz_close; FZ_PENDING="$id" ;;
      BQB) spec="$spec  \`grep -c baseline-$id f\`"$'\n'; fz_close; FZ_PENDING="$id" ;;
      CB) spec="$spec  grep -c baseline-$id f"$'\n'; fz_close; FZ_PENDING="$id" ;;
      BP) spec="$spec  Baseline: this returned 0 before this WO ($k)."$'\n'; fz_other ;;
      F)  spec="$spec  curl -s https://x.test/$k"$'\n'; fz_other ;;
      LF) spec="$spec  LC_ALL=C curl -s https://x.test/$k"$'\n'; fz_other ;;
      BF) spec="$spec- curl -s https://x.test/$k"$'\n'; fz_other ;;
      QF) spec="$spec  \`curl -s https://x.test/$k\`"$'\n'; fz_other ;;
      I)  n=$((100 + k)); spec="$spec- \`grep -c $id f\` returns $n"$'\n'; fz_close; paired="$paired $id=$n"; FZ_ANYC=1; FZ_PENDING="" ;;
      E)  spec="$spec  Expected: $k"$'\n'; FZ_ANYE=1
          case "$FZ_PENDING" in zq*) paired="$paired ${FZ_PENDING}=$k"; FZ_ANYC=1 ;; esac
          FZ_PENDING="" ;;
      B)  spec="$spec"$'\n' ;;
      P)  spec="$spec  note that this matters"$'\n'; fz_other ;;
    esac
  done
  case "$FZ_PENDING" in zq*) FZ_UNP="$FZ_UNP $FZ_PENDING"; FZ_ANYC=1 ;; esac
  if [ "$FZ_ANYC" -eq 0 ] && [ "$FZ_ANYE" -eq 0 ]; then hdr_exp="Stop 1 (fuzz):"; fi
  out="$(printf '%s' "$spec" | rsg_extract)"
  expected_paired="$(printf '%s\n' $paired | sort | grep . || true)"
  actual_paired="$(printf '%s\n' "$out" | while IFS= read -r line; do
    case "$line" in *"${TAB}eq${TAB}"*)
      printf '%s=%s\n' "$(printf '%s' "$line" | grep -o 'zq[0-9]*zq' | head -1)" "${line##*"${TAB}"}" ;;
    esac
  done | sort | grep . || true)"
  expected_unp="$(printf '%s\n' $FZ_UNP | sort | grep . || true)"
  actual_unp="$(printf '%s\n' "$out" | sed -n 's/^UNPARSED\t[0-9]*\t*//p' | grep -o 'zq[0-9]*zq' | sort | grep . || true)"
  assert_eq "fuzz [$label] paired commands are exactly the oracle's" "$expected_paired" "$actual_paired"
  assert_eq "fuzz [$label] unparsed commands are exactly the oracle's" "$expected_unp" "$actual_unp"
  if [ -n "$hdr_exp" ]; then
    assert_contains "fuzz [$label] a block with no command and no Expected names its header" "$hdr_exp" "$(printf '%s\n' "$out" | sed -n '/^UNPARSED/p')"
  fi
  local declared_exp=$(( $(printf '%s\n' $paired | grep -c . || true) + $(printf '%s\n' $FZ_UNP | grep -c . || true) + $([ -n "$hdr_exp" ] && echo 1 || echo 0) ))
  assert_contains "fuzz [$label] DECLARED is paired + unparsed" "DECLARED${TAB}${declared_exp}" "$out"
}
FZ_TABLE=(
  "C E" "T E" "BL E" "BQ E" "C F E" "C E F E" "I E" "C I E" "C I" "F E C E" "C B E" "C P E"
  "C LF E" "C BF E" "C QF E" "C B B E" "LF E C E" "C E LF E" "BQ P E" "C B P B E" "T QF E"
  "BQB E" "CB E" "C BP E" "BQB BP E" "BP C E" "BP E" "C B BP B E" "BP BP CB E" "I BP E" "CB CB E"
  "C E E" "T I E" "BQ F E I" "E C" "C C E E" "F F E" "P B" "C" "I I E" "BQ BQ E" "T F I E" "B C B E B"
)
for seq in "${FZ_TABLE[@]}"; do
  # shellcheck disable=SC2086
  fz_check $seq
done
FZ_TOKENS=(C T BL BQ BQB CB BP F LF BF QF I E E B P)
RANDOM=4753
for ((fzn = 0; fzn < 60; fzn++)); do
  fzlen=$((RANDOM % 8 + 2)); fzseq=""
  for ((fzi = 0; fzi < fzlen; fzi++)); do fzseq="$fzseq ${FZ_TOKENS[RANDOM % ${#FZ_TOKENS[@]}]}"; done
  # shellcheck disable=SC2086
  fz_check $fzseq
done
unset RSG_STAGE_REPO
named_end every_counted_command_pairs_with_its_own_expected_or_is_unparsed

echo
echo "run-stop-greps.sh: $PASS passed, $FAIL failed (PASS=$PASS FAIL=$FAIL)"
[ "$FAIL" -eq 0 ]
