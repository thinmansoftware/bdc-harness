#!/usr/bin/env bash
# run-stop-greps.sh -- unit tests for the run-stop-greps node core (rsg_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 12 bdc-feature-development lanes.
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
for fn in rsg_extract rsg_split_segment rsg_tokens_safe rsg_argv_looks_readonly rsg_allow_cmd rsg_exec_pipeline rsg_observe rsg_compare rsg_run; do
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

echo "--- unsafe-quoted-content-still-dropped ---"
for c in "grep -c '\$(id)' f" "grep -c 'x f" "grep -c '' f" "grep '--file=/etc/passwd' x" "find . '-exec' rm" "sort '-o' out"; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: unsafe-quoted-content-still-dropped: $c"; else PASS=$((PASS+1)); echo "PASS: unsafe-quoted-content-still-dropped: $c"; fi
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
for c in "grep -c '\$(id)' f" "grep -c 'x f" "grep -c '' f"; do
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

echo "--- spaced single-quoted pattern executes (Test 1) ---"
TMP3="$(mktemp -d)"
printf 'Pullers billed: 3\nPullers billed: 3\n' > "$TMP3/notes.txt"
printf '  provider: codex\n' > "$TMP3/lane.yaml"
SPEC_SPACED="$(cat <<'EOF'
Stop 1 (grep assertion):
  grep -c 'Pullers billed' notes.txt
  Expected: 2
Stop 2 (grep assertion):
  grep -cE '^ +provider: codex' lane.yaml
  Expected: 1
EOF
)"
for c in "grep -c 'Pullers billed' notes.txt" "grep -cE '^ +provider: codex' lane.yaml" "grep -n 'two words' a.txt" "grep -E 'two words' a.txt" "grep -F 'two words' a.txt" "grep -i 'two words' a.txt" "grep -o 'two words' a.txt" "grep -cE 'two words' a.txt" "grep -rc 'two words' dir" "grep -ciE 'two words' a.txt" "grep -c -E 'two words' a.txt" "grep -c '^x' f" "grep -c 'a b' f"; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: spaced-or-flag allow: $c"; else FAIL=$((FAIL+1)); echo "FAIL: spaced-or-flag allow: $c"; fi
done
OUT="$(cd "$TMP3" && printf '%s\n' "$SPEC_SPACED" | rsg_extract | rsg_run)"
assert_contains "spaced GREP_DECLARED=2" "GREP_DECLARED=2" "$OUT"
assert_contains "spaced GREP_EXECUTED=2" "GREP_EXECUTED=2" "$OUT"
assert_contains "spaced GREP_DROPPED=0" "GREP_DROPPED=0" "$OUT"
assert_contains "spaced GREP_STATUS=passed" "GREP_STATUS=passed" "$OUT"
assert_contains "spaced GREP_LINE keeps the quoted command" "grep -c 'Pullers billed' notes.txt => 2" "$OUT"
assert_contains "spaced OK pullers" "OK: grep -c 'Pullers billed' notes.txt => 2 (expected eq 2)" "$OUT"
assert_contains "spaced OK provider" "OK: grep -cE '^ +provider: codex' lane.yaml => 1 (expected eq 1)" "$OUT"
if printf '%s\n' "$OUT" | grep -q '^DROPPED'; then FAIL=$((FAIL+1)); echo "FAIL: spaced run emitted DROPPED"; else PASS=$((PASS+1)); echo "PASS: spaced run has no DROPPED line"; fi

echo "--- metacharacters stay dropped (Test 2) ---"
TMP4="$(mktemp -d)"
UNSAFE_CMDS=(
  'grep -c "two words" f'
  "grep -c 'a\\.b' f"
  "grep -c 'cost \$5' f"
  "grep -c 'a|b' f"
  "grep -c 'x' 'y' f"
  "grep -c 'x; rm' f"
  "grep -c 'x' f > out"
  "grep -c 'x' f | xargs rm"
  "grep -c 'un terminated f"
  "grep -f 'list' f"
)
UNSAFE_TSV=""
for c in "${UNSAFE_CMDS[@]}"; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: unsafe allow returned 0: $c"; else PASS=$((PASS+1)); echo "PASS: unsafe allow dropped: $c"; fi
  UNSAFE_TSV="${UNSAFE_TSV}${c}${TAB}eq${TAB}1"$'\n'
done
UNSAFE_TSV="${UNSAFE_TSV}UNPARSED${TAB}0"$'\n'"DECLARED${TAB}10"$'\n'
OUT="$(cd "$TMP4" && printf '%s' "$UNSAFE_TSV" | rsg_run)"
assert_contains "unsafe GREP_EXECUTED=0" "GREP_EXECUTED=0" "$OUT"
assert_contains "unsafe GREP_DROPPED=10" "GREP_DROPPED=10" "$OUT"
assert_contains "unsafe GREP_STATUS=all_dropped" "GREP_STATUS=all_dropped" "$OUT"
assert_eq "unsafe redirect did not create out" "0" "$(test -e "$TMP4/out" && echo 1 || echo 0)"

echo "--- allow and exec agree with vma (Test 3) ---"
printf 'two words\n' > "$TMP3/a.txt"
mkdir -p "$TMP3/g"
printf 'two words\n' > "$TMP3/g/a.txt"
printf 'two words\n' > "$TMP3/g/b.txt"
VMA_CORE="$(extract_core "$CANONICAL_YAML" vma)"
if [ -z "$VMA_CORE" ]; then
  FAIL=$((FAIL+1)); echo "FAIL: could not extract vma core"
else
  PASS=$((PASS+1)); echo "PASS: extracted vma core"
fi
count_raw() {
  local raw="$1" rc="$2" rawtrim
  rawtrim="$(printf '%s' "$raw" | tr -d '[:space:]')"
  if printf '%s' "$rawtrim" | grep -qE '^[0-9]+$'; then
    printf '%s' "$rawtrim"
  elif [ -z "$rawtrim" ]; then
    if [ "$rc" -le 1 ]; then printf '0'; else printf 'ERR'; fi
  else
    printf '%s\n' "$raw" | grep -c . || true
  fi
}
for c in "grep -c 'Pullers billed' notes.txt" "grep -cE '^ +provider: codex' lane.yaml" "grep -c 'two words' g/*.txt | wc -l" "grep -n 'two words' a.txt | head -n 3"; do
  rsg_raw="$(cd "$TMP3" && rsg_exec_pipeline "$c")"; rsg_rc=$?
  rsg_n="$(count_raw "$rsg_raw" "$rsg_rc")"
  vma_err="$(mktemp)"
  vma_out="$(
    cd "$TMP3" && eval "$VMA_CORE"
    vma_process_assertions "$c => 0" "" 2>"$vma_err"
  )"
  vma_n="$(printf '%s\n' "$vma_out" | sed -n 's/.*=> //p' | head -n 1)"
  assert_eq "rsg/vma count: $c" "$rsg_n" "$vma_n"
  if [ -s "$vma_err" ] && grep -q 'DROP (command not on read-only allowlist' "$vma_err"; then
    FAIL=$((FAIL+1)); echo "FAIL: vma dropped an executed command: $c"; echo "  $vma_err"
  else
    PASS=$((PASS+1)); echo "PASS: vma did not drop: $c"
  fi
  rm -f "$vma_err"
done
assert_eq "glob expanded to both txt files" "2" "$(cd "$TMP3" && rsg_exec_pipeline "grep -c 'two words' g/*.txt | wc -l" | tr -d '[:space:]')"

echo "--- grep pipe targets are only wc and head ---"
pipe_deny() {
  local c="$1"
  if rsg_allow_cmd "$c"; then
    FAIL=$((FAIL+1)); echo "FAIL: rsg allowed grep pipe target: $c"
  else
    PASS=$((PASS+1)); echo "PASS: rsg denied grep pipe target: $c"
  fi
}
pipe_allow() {
  local c="$1"
  if rsg_allow_cmd "$c"; then
    PASS=$((PASS+1)); echo "PASS: rsg allowed: $c"
  else
    FAIL=$((FAIL+1)); echo "FAIL: rsg denied allowed command: $c"
  fi
}
pipe_deny "grep -c x f | cat"
pipe_deny "grep -n x f | tail -n 1"
pipe_deny "egrep x f | sort"
pipe_deny "fgrep x f | uniq"
pipe_deny "rg -c x dir | ls"
pipe_deny "grep x f | wc -l | cat"
pipe_allow "grep -c x f | wc -l"
pipe_allow "grep -n x f | head -n 3"
pipe_allow "grep x f | wc -l | head -n 1"
pipe_allow "rg -n x dir | head -n 1"
pipe_allow "find . -name x | cat"
pipe_allow "cat f | head -n 1"
VMA_PIPE="$(
  eval "$VMA_CORE"
  vma_check() {
    local expect="$1" c="$2" rc=0
    allow_cmd "$c" || rc=$?
    if [ "$expect" = allow ] && [ "$rc" -eq 0 ]; then
      echo "PASS: vma allowed: $c"
    elif [ "$expect" = deny ] && [ "$rc" -ne 0 ]; then
      echo "PASS: vma denied grep pipe target: $c"
    else
      echo "FAIL: vma expect $expect rc $rc: $c"
    fi
  }
  vma_check deny "grep -c x f | cat"
  vma_check deny "grep -n x f | tail -n 1"
  vma_check deny "egrep x f | sort"
  vma_check deny "grep x f | wc -l | cat"
  vma_check allow "grep -c x f | wc -l"
  vma_check allow "grep -n x f | head -n 3"
  vma_check allow "grep x f | wc -l | head -n 1"
  vma_check allow "find . -name x | cat"
  vma_check allow "cat f | head -n 1"
)"
while IFS= read -r line; do
  case "$line" in
    PASS:*) PASS=$((PASS+1)); echo "$line" ;;
    FAIL:*) FAIL=$((FAIL+1)); echo "$line" ;;
    '') ;;
    *) FAIL=$((FAIL+1)); echo "FAIL: unexpected vma pipe line: $line" ;;
  esac
done <<EOF
$VMA_PIPE
EOF

echo "--- checkout-repair-target verdict on every path (Test 4) ---"
extract_bash_node() {
  awk -v id="$2" '
    $0 == "  - id: " id { c=1; next }
    c && /^  - id: / { exit }
    c && /^    bash: \|$/ { b=1; next }
    b && /^      / { sub(/^      /, ""); print; next }
    b && /^$/ { print; next }
    b { exit }
  ' "$1"
}
CHECKOUT_BASH="$(extract_bash_node "$CANONICAL_YAML" checkout-repair-target)"
if [ -z "$CHECKOUT_BASH" ]; then
  echo "FATAL: could not extract checkout-repair-target"; exit 1
fi
run_node() {
  local script="$1" spec="$2" work="$3" art out err rc
  art="$(mktemp -d)"
  mkdir -p "$art/authority"
  printf '%s\n' "$spec" > "$art/authority/work-order.md"
  printf '%s\n' "$script" > "$art/node.sh"
  err="$(mktemp)"
  out="$(cd "$work" && ARTIFACTS_DIR="$art" PATH="${GHBIN:-}:$PATH" FAKE_GH_STATE="${FAKE_GH_STATE:-}" FAKE_GH_BRANCH="${FAKE_GH_BRANCH:-}" FAKE_GH_HEAD_OID="${FAKE_GH_HEAD_OID:-}" bash "$art/node.sh" 2>"$err")"
  rc=$?
  if [ -s "$err" ]; then
    printf 'STDERR:%s\n' "$(cat "$err")" >&2
  fi
  printf '%s\n' "$rc"
  printf '%s\n' "$out"
  rm -rf "$art"
  rm -f "$err"
}
NONE_SPEC='WO: EXAMPLE
Objective: ordinary build with no declaration line.'
NONE_RUN="$(run_node "$CHECKOUT_BASH" "$NONE_SPEC" "$TMP4")"
NONE_RC="$(printf '%s\n' "$NONE_RUN" | head -n 1)"
NONE_OUT="$(printf '%s\n' "$NONE_RUN" | tail -n +2)"
assert_eq "none exit" "0" "$NONE_RC"
assert_contains "none status" "REPAIR_TARGET_STATUS=none" "$NONE_OUT"
assert_contains "none legacy line" "REPAIR_TARGET=none" "$NONE_OUT"
INV_SPEC='Repair target: PR #1234 (branch salvage/x)'
INV_RUN="$(run_node "$CHECKOUT_BASH" "$INV_SPEC" "$TMP4")"
INV_RC="$(printf '%s\n' "$INV_RUN" | head -n 1)"
INV_OUT="$(printf '%s\n' "$INV_RUN" | tail -n +2)"
assert_eq "invalid branch exit" "1" "$INV_RC"
assert_contains "invalid branch status" "REPAIR_TARGET_STATUS=invalid" "$INV_OUT"
assert_contains "invalid branch reason" "REPAIR_TARGET_REASON=invalid_repair_target_branch" "$INV_OUT"
ORIGIN="$(mktemp -d)"
WORK="$(mktemp -d)"
GHBIN="$(mktemp -d)"
cat > "$GHBIN/gh" << 'EOF'
#!/bin/sh
printf '%s\t%s\tfalse\tthinmansoftware\tbdc-harness\t%s\n' "$FAKE_GH_STATE" "$FAKE_GH_BRANCH" "$FAKE_GH_HEAD_OID"
EOF
chmod 755 "$GHBIN/gh"
git init --bare --initial-branch=main "$ORIGIN" >/dev/null
git clone "$ORIGIN" "$WORK" >/dev/null
git -C "$WORK" config user.email test@test.com
git -C "$WORK" config user.name Test
printf 'init\n' > "$WORK/README.md"
git -C "$WORK" add README.md
git -C "$WORK" commit -m init >/dev/null
git -C "$WORK" push origin main >/dev/null
printf 'tip\n' > "$WORK/tip.txt"
git -C "$WORK" add tip.txt
git -C "$WORK" commit -m tip >/dev/null
git -C "$WORK" push origin 'HEAD:feat/repair-branch' >/dev/null
REPAIR_SHA="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" remote set-url origin https://github.com/thinmansoftware/bdc-harness.git
git -C "$WORK" config --local "url.${ORIGIN}.insteadOf" https://github.com/thinmansoftware/bdc-harness.git
OPEN_SPEC='Repair target: PR #1234 (branch feat/repair-branch)'
FAKE_GH_STATE=MERGED
FAKE_GH_BRANCH=feat/repair-branch
FAKE_GH_HEAD_OID="$REPAIR_SHA"
MERGED_RUN="$(run_node "$CHECKOUT_BASH" "$OPEN_SPEC" "$WORK")"
MERGED_RC="$(printf '%s\n' "$MERGED_RUN" | head -n 1)"
MERGED_OUT="$(printf '%s\n' "$MERGED_RUN" | tail -n +2)"
assert_eq "merged exit" "1" "$MERGED_RC"
assert_contains "merged status" "REPAIR_TARGET_STATUS=invalid" "$MERGED_OUT"
assert_contains "merged reason" "REPAIR_TARGET_REASON=not_open" "$MERGED_OUT"
HELD_BASH="$(printf '%s\n' "$CHECKOUT_BASH" | python3 -c '
import sys
text = sys.stdin.read()
start = text.find("# ---- BEGIN rtw core")
end = text.find("# ---- END rtw core ----")
if start < 0 or end < 0:
    sys.stderr.write("rtw markers missing\n")
    sys.exit(1)
stub = """rtw_checkout_repair_branch() {
  printf \"repair_target_branch_held: %s is checked out by %s; not reclaimed: %s\\n\" \"$1\" \"/tmp/second-worktree\" \"holder is this worktree\"
  printf \"repair_target_branch_held: %s is checked out by %s; not reclaimed: %s\\n\" \"$1\" \"/tmp/second-worktree\" \"holder is this worktree\" >&2
  return 1
}
"""
sys.stdout.write(text[:start] + stub + text[end + len("# ---- END rtw core ----"):])
')"
FAKE_GH_STATE=OPEN
HELD_RUN="$(run_node "$HELD_BASH" "$OPEN_SPEC" "$WORK")"
HELD_RC="$(printf '%s\n' "$HELD_RUN" | head -n 1)"
HELD_OUT="$(printf '%s\n' "$HELD_RUN" | tail -n +2)"
assert_eq "held exit" "1" "$HELD_RC"
assert_contains "held status" "REPAIR_TARGET_STATUS=held" "$HELD_OUT"
assert_contains "held reason" "REPAIR_TARGET_REASON=branch_held" "$HELD_OUT"
assert_contains "held holder" "REPAIR_TARGET_HOLDER=/tmp/second-worktree" "$HELD_OUT"
OK_RUN="$(run_node "$CHECKOUT_BASH" "$OPEN_SPEC" "$WORK")"
OK_RC="$(printf '%s\n' "$OK_RUN" | head -n 1)"
OK_OUT="$(printf '%s\n' "$OK_RUN" | tail -n +2)"
assert_eq "success exit" "0" "$OK_RC"
assert_contains "success status" "REPAIR_TARGET_STATUS=ok" "$OK_OUT"
assert_contains "success upstream" "REPAIR_TARGET_UPSTREAM=origin/feat/repair-branch" "$OK_OUT"
assert_contains "success pr" "REPAIR_TARGET=#1234" "$OK_OUT"
assert_contains "success branch" "REPAIR_TARGET_BRANCH=feat/repair-branch" "$OK_OUT"
assert_contains "success lease" "REPAIR_TARGET_LEASE_SHA=${REPAIR_SHA}" "$OK_OUT"
if printf '%s\n' "$OK_OUT" | grep -q '^REPAIR_TARGET_REASON='; then FAIL=$((FAIL+1)); echo "FAIL: success printed a reason"; else PASS=$((PASS+1)); echo "PASS: success has no reason"; fi

echo "--- repair-target-verdict degrades honestly (Test 6) ---"
VERDICT_BASH="$(extract_bash_node "$CANONICAL_YAML" repair-target-verdict)"
if [ -z "$VERDICT_BASH" ]; then echo "FATAL: verdict node missing"; exit 1; fi
EMPTY_OUT_DIR="$(mktemp -d)"
VERR="$(mktemp)"
VOUT="$(ARCHON_NODE_OUT="$EMPTY_OUT_DIR" bash -c "$VERDICT_BASH" 2>"$VERR")"
VRC=$?
assert_eq "missing verdict file exit" "0" "$VRC"
assert_contains "missing verdict status" "REPAIR_TARGET_STATUS=unavailable" "$VOUT"
assert_contains "missing verdict reason" "REPAIR_TARGET_REASON=no_verdict" "$VOUT"
HELD_DIR="$(mktemp -d)"
printf '%s\n' "$HELD_OUT" > "$HELD_DIR/checkout-repair-target.out"
VOUT2="$(ARCHON_NODE_OUT="$HELD_DIR" bash -c "$VERDICT_BASH" 2>"$VERR")"
VRC2=$?
assert_eq "held re-emit exit" "0" "$VRC2"
assert_contains "held re-emit status" "REPAIR_TARGET_STATUS=held" "$VOUT2"
assert_contains "held re-emit holder" "REPAIR_TARGET_HOLDER=/tmp/second-worktree" "$VOUT2"

echo "--- published contract (Test 7) ---"
MARKER_COUNT="$(grep -c 'single-quoted-pattern-may-contain-spaces' "$CANONICAL_YAML" || true)"
if [ "$MARKER_COUNT" -ge 2 ]; then PASS=$((PASS+1)); echo "PASS: contract marker count $MARKER_COUNT"; else FAIL=$((FAIL+1)); echo "FAIL: contract marker count $MARKER_COUNT"; fi
PROSE_COUNT="$(grep -c 'A single-quoted pattern may contain spaces' "$CANONICAL_YAML" || true)"
if [ "$PROSE_COUNT" -ge 2 ]; then PASS=$((PASS+1)); echo "PASS: contract prose count $PROSE_COUNT"; else FAIL=$((FAIL+1)); echo "FAIL: contract prose count $PROSE_COUNT"; fi
DROP_COUNT="$(grep -c 'second quoted argument are dropped' "$CANONICAL_YAML" || true)"
if [ "$DROP_COUNT" -ge 2 ]; then PASS=$((PASS+1)); echo "PASS: dropped-shapes prose count $DROP_COUNT"; else FAIL=$((FAIL+1)); echo "FAIL: dropped-shapes prose count $DROP_COUNT"; fi
LANE_VERIFIED_COUNT="$(grep -c 'lane-verified' "$CANONICAL_YAML" || true)"
assert_eq "lane-verified absent from codex lane" "0" "$LANE_VERIFIED_COUNT"
ASTRA_COUNT="$(grep -c 'bdc-feature-development-astra.yaml' "$HERE/run-stop-greps.sh" || true)"
if [ "$ASTRA_COUNT" -ge 1 ]; then PASS=$((PASS+1)); echo "PASS: astra is on the parity list"; else FAIL=$((FAIL+1)); echo "FAIL: astra missing from parity list"; fi

rm -rf "$TMP3" "$TMP4" "$ORIGIN" "$WORK" "$GHBIN" "$EMPTY_OUT_DIR" "$HELD_DIR"
rm -f "$VERR"

echo
echo "run-stop-greps.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
