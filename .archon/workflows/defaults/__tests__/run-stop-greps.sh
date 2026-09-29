#!/usr/bin/env bash
# run-stop-greps.sh -- unit tests for the run-stop-greps node core (rsg_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 11 bdc-feature-development lanes.
#
# bdc-xo #1940: the manifest "Grep assertions:" line was stamped "N/A (no declared
# mechanical assertions)" for every WO, including specs that declared grep stop
# conditions. run-stop-greps extracts each "Stop N (grep assertion ...)" block, runs
# it under the read-only allowlist, and emits OBSERVED counts.
#
# Cores are EXTRACTED from the canonical YAML (never re-typed). A parity test asserts
# the core is byte-identical across all 13 lanes.
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

RSG_CORE="$(extract_core "$CANONICAL_YAML" rsg)"
if [ -z "$RSG_CORE" ]; then
  echo "FATAL: could not extract rsg core from $CANONICAL_YAML"; exit 1
fi
eval "$RSG_CORE"
for fn in rsg_extract rsg_tokens_safe rsg_argv_looks_readonly rsg_allow_cmd rsg_exec_pipeline rsg_observe rsg_compare rsg_run; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: rsg core byte-identical across all 13 lanes (parity-all-13-lanes) ---"
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
assert_contains "DECLARED counts every grep header including the one without Expected" "DECLARED${TAB}5" "$EXTRACTED"
assert_eq "test-suite and ASCII stops are not grep assertions" "0" "$(printf '%s\n' "$EXTRACTED" | grep -c 'bun test\|LC_ALL' || true)"
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

# Test 5: unsafe-quoted-content-still-dropped. WO-HARNESS-STOP-GREP-QUOTED-FAIL-CLOSED-01
# REVERSES the two prior pins of WO-HARNESS-RUN-STOP-GREPS-QUOTED-PATTERN-ALLOWLIST-01:
# 'a b' and '^x' now EXECUTE (see quoted-space/quoted-caret below). What stays dropped
# is quoted content that could break out of the argv or collide with the manifest
# assertion delimiters, and a forbidden flag written quoted.
echo "--- unsafe-quoted-content-still-dropped ---"
while IFS= read -r c; do
  [ -z "$c" ] && continue
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: unsafe-quoted-content-still-dropped: $c"; else PASS=$((PASS+1)); echo "PASS: unsafe-quoted-content-still-dropped: $c"; fi
done <<'UNSAFE_CASES'
grep -c 'a;b' f
grep -c '$(id)' f
grep -c 'a`b`' f
grep -c 'x => y' f
grep -c 'x f
grep -c '' f
grep -c a'b' f
grep '--file=/etc/passwd' x
grep -c '-f x' f
find . '-exec' rm
sort '-o' out
UNSAFE_CASES

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
assert_contains "GREP_DECLARED=5" "GREP_DECLARED=5" "$OUT"
assert_contains "GREP_EXECUTED=3" "GREP_EXECUTED=3" "$OUT"
assert_contains "GREP_DROPPED=1 (the awk one)" "GREP_DROPPED=1" "$OUT"
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
while IFS= read -r c; do
  [ -z "$c" ] && continue
  OUT="$(printf '%s\teq\t1\nUNPARSED\t0\nDECLARED\t1\n' "$c" | rsg_run)"
  assert_contains "unsafe-quoted-content-still-dropped: $c" "DROPPED (not on read-only allowlist; not executed): $c" "$OUT"
  assert_contains "unsafe-quoted-content-still-dropped not executed: $c" "GREP_EXECUTED=0" "$OUT"
done <<'UNSAFE_RUN_CASES'
grep -c 'a;b' f
grep -c '$(id)' f
grep -c 'x => y' f
grep -c 'x f
grep -c '' f
grep -c a'b' f
UNSAFE_RUN_CASES

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

echo "--- baseline statements are not stop conditions (live false mismatch, run 3b8aea39, WO-HARNESS-AUTO-REREVIEW-REPEAT-REASON-01) ---"
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
assert_eq "the baseline paragraph grep is skipped" "0" "$(printf '%s\n' "$OUT" | grep -c 'grep -rn "buildRereviewReason"' || true)"
assert_contains "the numbered post-fix assertion is kept (ge 1)" "grep -c \"buildRereviewReason\" packages/overseer/src/pr-review-ingest.ts${TAB}ge${TAB}1" "$OUT"
assert_contains "DECLARED counts only the real stop condition" "DECLARED${TAB}1" "$OUT"
OUT="$(printf '## Stop conditions\n- Baseline: `grep -c x y` returns 0 before this WO.\n- `grep -c x y` returns 2 or greater\n' | rsg_extract)"
assert_contains "single-line baseline bullet skipped, real bullet kept" "grep -c x y${TAB}ge${TAB}2" "$OUT"
assert_contains "single-line baseline bullet not counted" "DECLARED${TAB}1" "$OUT"

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

# =============================================================================
# WO-HARNESS-STOP-GREP-QUOTED-FAIL-CLOSED-01 -- quoted patterns, read-only git.
# The tokenizer is quote-aware, so a single-quoted pattern containing a space, a
# caret or ordinary regex characters EXECUTES instead of being silently dropped.
# =============================================================================
TQ="$(mktemp -d)"
printf 'SET LOCAL app.tenant_id\nunrelated line\nSET LOCAL app.tenant_id\n' > "$TQ/store.sql"
printf 'foo bar\nfoo bar baz\nxfoo bar\n' > "$TQ/anchor.txt"
printf '<<<<<<< HEAD\nrest\n' > "$TQ/markers.txt"
printf 'alpha|beta\na1\na.b\nend$\n(paren)\nx  y\n' > "$TQ/rx.txt"
printf 'a b\na b\nc d\n' > "$TQ/spaced.txt"
printf 'xray\n^literal\n' > "$TQ/caret.txt"

echo "--- Test 1: quoted-space-pattern-executes ---"
OUT="$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  grep -c 'SET LOCAL app.tenant_id' store.sql\n  Expected: 2\n" | rsg_extract | rsg_run)"
assert_contains "T1 executed" "GREP_EXECUTED=1" "$OUT"
assert_contains "T1 not dropped" "GREP_DROPPED=0" "$OUT"
assert_contains "T1 status passed" "GREP_STATUS=passed" "$OUT"
assert_contains "T1 OK line carries observed 2" "OK: grep -c 'SET LOCAL app.tenant_id' store.sql => 2 (expected eq 2)" "$OUT"

echo "--- Test 1b: the reversed pin 'a b' now executes ---"
OUT="$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  grep -c 'a b' spaced.txt\n  Expected: 2\n" | rsg_extract | rsg_run)"
assert_contains "T1b quoted space executes" "GREP_EXECUTED=1" "$OUT"
assert_contains "T1b observed 2" "OK: grep -c 'a b' spaced.txt => 2 (expected eq 2)" "$OUT"
if rsg_allow_cmd "grep -c 'a b' f"; then PASS=$((PASS+1)); echo "PASS: T1b allowlist admits quoted space"; else FAIL=$((FAIL+1)); echo "FAIL: T1b allowlist admits quoted space"; fi

echo "--- Test 2: quoted-caret-anchor-executes ---"
OUT="$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  grep -c '^foo bar' anchor.txt\n  Expected: 2\nStop 2 (grep assertion):\n  grep -c '^<<<<<<<' markers.txt\n  Expected: 1\n" | rsg_extract | rsg_run)"
assert_contains "T2 both executed" "GREP_EXECUTED=2" "$OUT"
assert_contains "T2 none dropped" "GREP_DROPPED=0" "$OUT"
assert_contains "T2 caret anchor observed 2" "grep -c '^foo bar' anchor.txt => 2" "$OUT"
assert_contains "T2 conflict marker observed 1" "grep -c '^<<<<<<<' markers.txt => 1" "$OUT"
OUT="$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  grep -c '^x' caret.txt\n  Expected: 1\n" | rsg_extract | rsg_run)"
assert_contains "T2b the reversed pin '^x' now executes" "OK: grep -c '^x' caret.txt => 1 (expected eq 1)" "$OUT"
if rsg_allow_cmd "grep -c '^x' f"; then PASS=$((PASS+1)); echo "PASS: T2b allowlist admits quoted caret"; else FAIL=$((FAIL+1)); echo "FAIL: T2b allowlist admits quoted caret"; fi

echo "--- Test 3: quoted-regex-characters-execute ---"
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  REF="$(cd "$TQ" && grep -c "$pat" rx.txt || true)"
  OUT="$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  grep -c '%s' rx.txt\n  Expected: %s\n" "$pat" "$REF" | rsg_extract | rsg_run)"
  assert_contains "T3 [$pat] executes" "GREP_EXECUTED=1" "$OUT"
  assert_contains "T3 [$pat] observed equals a direct grep -c" "GREP_STATUS=passed" "$OUT"
  assert_contains "T3 [$pat] not dropped" "GREP_DROPPED=0" "$OUT"
done <<'REGEX_CASES'
alpha|beta
[0-9]
a\.b
end$
(paren)
x  y
REGEX_CASES
REF="$(cd "$TQ" && grep -cE 'a|b' rx.txt || true)"
assert_eq "T3 a quoted pipe is data, not a pipe (grep -E 'a|b')" "$REF" "$(cd "$TQ" && rsg_observe "grep -cE 'a|b' rx.txt")"
assert_eq "T3 quoted pipe does not split the command" "1" "$(rsg_split_pipe "grep -c 'a|b' f" | wc -l | tr -d ' ')"

echo "--- Test 4 (extra): double-quoted and unquoted metachars still dropped ---"
while IFS= read -r c; do
  [ -z "$c" ] && continue
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: T4 forbidden expected: $c"; else PASS=$((PASS+1)); echo "PASS: T4 forbidden: $c"; fi
done <<'META_CASES'
grep -c "needle" f
grep -c needle f > out
grep -c needle f; rm x
grep -c needle f && ls
cat $(ls)
grep -c ne\dle f
grep -c x f || ls
META_CASES
assert_eq "T4 no file named out was created" "0" "$(cd "$TQ" && test -e out && echo 1 || echo 0)"

echo "--- Test 6/7/8: read-only git ---"
GTMP="$(mktemp -d)"
(
  cd "$GTMP" && git init -q . && git config user.email t@example.com && git config user.name t
  printf 'line one\na b\n' > f && git add f && git commit -qm one
  printf 'line one\na b\nline three\n' > f && git commit -qam two
) >/dev/null 2>&1
GS1="$(cd "$GTMP" && git rev-parse HEAD~1)"
GS2="$(cd "$GTMP" && git rev-parse HEAD)"

for c in "git diff --name-only $GS1 $GS2 -- f | wc -l" "git log --oneline -1 | wc -l" "git show $GS2:f | grep -c line" "git diff $GS1 HEAD -- f | grep -c 'a b'"; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: T6 git read-only allowed: $c"; else FAIL=$((FAIL+1)); echo "FAIL: T6 git read-only allowed: $c"; fi
done
assert_eq "T6 git diff --name-only count matches a direct run" \
  "$(cd "$GTMP" && git diff --name-only "$GS1" "$GS2" -- f | wc -l | tr -d ' ')" \
  "$(cd "$GTMP" && rsg_observe "git diff --name-only $GS1 $GS2 -- f | wc -l")"
assert_eq "T6 git log --oneline -1 count matches a direct run" "1" \
  "$(cd "$GTMP" && rsg_observe 'git log --oneline -1 | wc -l')"
assert_eq "T6 git show count matches a direct run" \
  "$(cd "$GTMP" && git show "$GS2":f | grep -c line)" \
  "$(cd "$GTMP" && rsg_observe "git show $GS2:f | grep -c line")"
assert_eq "T6 git diff piped into a quoted-space grep counts" \
  "$(cd "$GTMP" && git --no-pager diff --no-ext-diff --no-textconv "$GS1" HEAD -- f | grep -c 'a b')" \
  "$(cd "$GTMP" && rsg_observe "git diff $GS1 HEAD -- f | grep -c 'a b'")"
assert_eq "T6 rsg_git_readonly accepts a bare read-only argv" "0" \
  "$(rsg_git_readonly git diff --name-only A B -- f && echo 0 || echo 1)"

echo "--- Test 7: git-mutating-forms-dropped ---"
for c in "git diff --output=out" "git -c core.pager=x diff" "git push origin x" "git checkout HEAD~1" "git config user.name x" "git diff --ext-diff" "git diff -O x" "git log --exec-path" "git commit -m x" "git diff --textconv" "git log --git-dir=/tmp" "git show --work-tree=/tmp"; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: T7 git mutating dropped: $c"; else PASS=$((PASS+1)); echo "PASS: T7 git mutating dropped: $c"; fi
  OUT="$(cd "$GTMP" && rsg_observe "$c")"
  assert_eq "T7 not executed (ERR): $c" "ERR" "$OUT"
done
assert_eq "T7 file out was never created" "0" "$(cd "$GTMP" && test -e out && echo 1 || echo 0)"
assert_eq "T7 HEAD is unchanged" "$GS2" "$(cd "$GTMP" && git rev-parse HEAD)"

echo "--- Test 8: git-textconv-and-external-diff-never-run ---"
ETMP="$(mktemp -d)"
(
  cd "$ETMP" && git init -q . && git config user.email t@example.com && git config user.name t
  printf 'alpha\n' > f && git add f && git commit -qm one
  printf 'alpha\nbeta\n' > f && git commit -qam two
  printf 'f diff=evil\n' > .gitattributes
  printf '#!/bin/sh\ntouch "%s/pwned-rsg"\ncat "$1"\n' "$ETMP" > ev.sh && chmod +x ev.sh
  git config diff.evil.textconv "$ETMP/ev.sh"
  git config diff.external "$ETMP/ev.sh"
) >/dev/null 2>&1
ES1="$(cd "$ETMP" && git rev-parse HEAD~1)"
ES2="$(cd "$ETMP" && git rev-parse HEAD)"
# Proof the fixture is real: an UNGUARDED git diff does run the payload.
rm -f "$ETMP/pwned-rsg"
(cd "$ETMP" && git diff "$ES1" "$ES2" -- f >/dev/null 2>&1) || true
assert_eq "T8 fixture is armed (unguarded git diff runs the payload)" "1" "$(test -e "$ETMP/pwned-rsg" && echo 1 || echo 0)"
rm -f "$ETMP/pwned-rsg"
OUT="$(cd "$ETMP" && rsg_observe "git diff $ES1 $ES2 -- f | wc -l")"
if [ "$OUT" != "ERR" ] && [ "$OUT" -ge 1 ] 2>/dev/null; then PASS=$((PASS+1)); echo "PASS: T8 guarded git diff still counts ($OUT)"; else FAIL=$((FAIL+1)); echo "FAIL: T8 guarded git diff still counts (got $OUT)"; fi
OUT2="$(cd "$ETMP" && rsg_observe "git show $ES2 -- f | wc -l")"
if [ "$OUT2" != "ERR" ] && [ "$OUT2" -ge 1 ] 2>/dev/null; then PASS=$((PASS+1)); echo "PASS: T8 guarded git show still counts ($OUT2)"; else FAIL=$((FAIL+1)); echo "FAIL: T8 guarded git show still counts (got $OUT2)"; fi
assert_eq "T8 pwned-rsg was NOT created by the guarded runs" "0" "$(test -e "$ETMP/pwned-rsg" && echo 1 || echo 0)"

echo "--- Test 9: prose-prefix-line-skipped-lowercase-command-kept ---"
PTMP="$(mktemp -d)"
mkdir -p "$PTMP/shopops-api"
printf 'scanToListRouter\nscanToListRouter\nscanToListRouter\nscanToListRouter\n' > "$PTMP/shopops-api/index.js"
OUT="$(cd "$PTMP" && printf "Stop 1 (grep assertion):\n  Baselines below were MEASURED by the author at 395f224 on 2026-09-29. Addition assertions fail on the untouched tree.\n  grep -c 'scanToListRouter' shopops-api/index.js\n  Expected: 4\n" | rsg_extract | rsg_run)"
assert_contains "T9 prose prefix is not glued to the command" "OK: grep -c 'scanToListRouter' shopops-api/index.js => 4 (expected eq 4)" "$OUT"
assert_contains "T9 the real command executed" "GREP_EXECUTED=1" "$OUT"
assert_contains "T9 nothing dropped" "GREP_DROPPED=0" "$OUT"
OUT="$(cd "$PTMP" && printf "Stop 1 (grep assertion):\n  awk '{print}' f\n  Expected: 0\n" | rsg_extract | rsg_run)"
assert_contains "T9 a lowercase non-runner line stays part of the command" "GREP_DECLARED=1" "$OUT"
assert_contains "T9 and is dropped VISIBLY, not silently skipped" "GREP_DROPPED=1" "$OUT"
assert_contains "T9 awk is named in the DROPPED detail" "DROPPED (not on read-only allowlist; not executed): awk '{print}' f" "$OUT"
assert_contains "T9 LC_ALL prefix is still not mistaken for prose" "GREP_EXECUTED=1" \
  "$(cd "$TQ" && printf "Stop 1 (grep assertion):\n  LC_ALL=C grep -c 'a b' spaced.txt\n  Expected: 2\n" | rsg_extract | rsg_run)"

echo "--- Test 13: replay-live-runs-ea46da63-and-8ab3032a ---"
RTMP="$(mktemp -d)"
mkdir -p "$RTMP/shopops-api/routes" "$RTMP/shopops-api/migrations" "$RTMP/shopops-api/tests"
printf 'INSERT INTO stripe_webhook_events\nINSERT INTO stripe_webhook_events\nON CONFLICT (tenant_id, stripe_payment_id)\nON CONFLICT (tenant_id, stripe_payment_id)\n' > "$RTMP/shopops-api/routes/webhooks.js"
printf 'CREATE TABLE IF NOT EXISTS stripe_webhook_events\n' > "$RTMP/shopops-api/migrations/20260928_stripe_webhook_events_ledger.sql"
printf 'test_stripe_webhook_ack_after_commit\n' > "$RTMP/shopops-api/tests/run_all.js"
printf 'SET LOCAL app.tenant_id\n' > "$RTMP/shopops-api/migrations/20260706c_orderlines_exempt_inventory_ratio.sql"
printf 'SET LOCAL app.tenant_id\n' > "$RTMP/shopops-api/migrations/20260619_clear_unresolved_cover_sources.sql"
printf 'no conflict marker here\n' > "$RTMP/shopops-api/tests/test_ci_staging_migrations.js"
SPEC_EA="$(printf '%s\n' \
  "Stop 1 (grep assertion):" \
  "  grep -c 'INSERT INTO stripe_webhook_events' shopops-api/routes/webhooks.js" \
  "  Expected: 2" \
  "Stop 2 (grep assertion):" \
  "  grep -c 'paid_at) VALUES' shopops-api/routes/webhooks.js" \
  "  Expected: 0" \
  "Stop 3 (grep assertion):" \
  "  grep -c 'ON CONFLICT (tenant_id, stripe_payment_id)' shopops-api/routes/webhooks.js" \
  "  Expected: 2" \
  "Stop 4 (grep assertion):" \
  "  grep -c 'CREATE TABLE IF NOT EXISTS stripe_webhook_events' shopops-api/migrations/20260928_stripe_webhook_events_ledger.sql" \
  "  Expected: 1" \
  "Stop 5 (grep assertion):" \
  "  grep -c 'test_stripe_webhook_ack_after_commit' shopops-api/tests/run_all.js" \
  "  Expected: 1")"
OUT="$(cd "$RTMP" && printf '%s\n' "$SPEC_EA" | rsg_extract | rsg_run)"
assert_contains "T13 ea46da63 declared 5" "GREP_DECLARED=5" "$OUT"
assert_contains "T13 ea46da63 executed 5 (was 1 on the live run)" "GREP_EXECUTED=5" "$OUT"
assert_contains "T13 ea46da63 dropped 0 (was 4 on the live run)" "GREP_DROPPED=0" "$OUT"
assert_contains "T13 ea46da63 status passed" "GREP_STATUS=passed" "$OUT"
SPEC_8A="$(printf '%s\n' \
  "Stop 1 (grep assertion):" \
  "  grep -c 'SET LOCAL app.tenant_id' shopops-api/migrations/20260706c_orderlines_exempt_inventory_ratio.sql" \
  "  Expected: 1" \
  "Stop 2 (grep assertion):" \
  "  grep -c 'SET LOCAL app.tenant_id' shopops-api/migrations/20260619_clear_unresolved_cover_sources.sql" \
  "  Expected: 1" \
  "Stop 3 (grep assertion):" \
  "  grep -c '^<<<<<<<' shopops-api/tests/test_ci_staging_migrations.js" \
  "  Expected: 0")"
OUT="$(cd "$RTMP" && printf '%s\n' "$SPEC_8A" | rsg_extract | rsg_run)"
assert_contains "T13 8ab3032a declared 3" "GREP_DECLARED=3" "$OUT"
assert_contains "T13 8ab3032a executed 3 (was 0 on the live run)" "GREP_EXECUTED=3" "$OUT"
assert_contains "T13 8ab3032a dropped 0 (was 3 on the live run)" "GREP_DROPPED=0" "$OUT"
assert_contains "T13 8ab3032a status passed" "GREP_STATUS=passed" "$OUT"

rm -rf "$TQ" "$GTMP" "$ETMP" "$PTMP" "$RTMP"

echo
echo "run-stop-greps.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
