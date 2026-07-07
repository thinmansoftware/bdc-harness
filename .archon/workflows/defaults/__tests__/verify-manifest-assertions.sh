#!/usr/bin/env bash
# verify-manifest-assertions.sh -- unit tests for the verify-manifest-assertions
# node logic in .archon/workflows/defaults/bdc-feature-development.yaml (and its
# byte-identical mirror in bdc-feature-development-codex.yaml).
#
# WO-HARNESS-BUILD-MANIFEST-ASSERTION-EXECUTE-01.
#
# The verify-manifest-assertions node EXECUTES every grep assertion the
# build-manifest node composed, in the run worktree, and rewrites the manifest
# so only proven, bare "<command> => <count>" claims reach patch-pr-body and,
# ultimately, bdc-ci/scripts/validate-pr-manifest.sh.
#
# Rather than re-typing that logic (which would drift), these tests EXTRACT the
# real vma core functions from the canonical YAML (the awk range-match technique
# used in patch-pr-body.sh Test 6) and exercise them against fixtures. A parity
# test also asserts the node's bash block is byte-identical across both lanes,
# since this repo has no shared-include mechanism for workflow YAMLs.
#
# Run: bash .archon/workflows/defaults/__tests__/verify-manifest-assertions.sh
# Exits 0 on all-pass, 1 on any failure.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  # assert_eq <label> <expected> <actual>
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: [$expected]"
    echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  # assert_contains <label> <needle> <haystack>
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle:   $needle"
    echo "  haystack: $haystack"
  fi
}

assert_not_contains() {
  # assert_not_contains <label> <needle> <haystack>
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  unexpected needle present: $needle"
    echo "  haystack: $haystack"
  else
    PASS=$((PASS + 1))
    echo "PASS: $label"
  fi
}

# -----------------------------------------------------------------------------
# Locate the canonical workflows relative to the repo root (this script may be
# invoked from anywhere).
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CANONICAL_YAML="$DEFAULTS_DIR/bdc-feature-development.yaml"
MIRROR_YAML="$DEFAULTS_DIR/bdc-feature-development-codex.yaml"

# -----------------------------------------------------------------------------
# Extract the vma core functions from the canonical YAML and load them.
# The bash block is indented 6 spaces under `bash: |`; strip that so the
# extracted text is valid standalone bash.
# -----------------------------------------------------------------------------
extract_vma_core() {
  awk '
    /# ---- BEGIN vma core/ { c=1; next }
    /# ---- END vma core/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

VMA_CORE="$(extract_vma_core "$CANONICAL_YAML")"
if [ -z "$VMA_CORE" ]; then
  echo "FATAL: could not extract vma core from $CANONICAL_YAML"
  exit 1
fi
# Define vma_process and vma_process_assertions in this shell.
eval "$VMA_CORE"

if ! declare -F vma_process_assertions >/dev/null || ! declare -F vma_process >/dev/null; then
  echo "FATAL: vma core functions not defined after eval"
  exit 1
fi

# -----------------------------------------------------------------------------
# Deterministic fixture worktree: absolute paths so command execution is
# independent of the caller's CWD.
# -----------------------------------------------------------------------------
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
# data.txt: "alpha" on 2 lines, "beta" on 1 line.
printf 'alpha\nbeta\nalpha\n' > "$FIX/data.txt"

# -----------------------------------------------------------------------------
# Test 1: correct assertion -> sub-assertion unchanged
# -----------------------------------------------------------------------------
echo "--- Test 1: correct assertion unchanged ---"
OUT="$(vma_process_assertions "grep -c alpha $FIX/data.txt => 2" "" 2>/dev/null)"
assert_eq "correct count kept verbatim" "grep -c alpha $FIX/data.txt => 2" "$OUT"

# -----------------------------------------------------------------------------
# Test 2: wrong-count assertion -> count rewritten to ACTUAL, correction logged
# -----------------------------------------------------------------------------
echo "--- Test 2: wrong count rewritten + logged ---"
ERRLOG="$(vma_process_assertions "grep -c alpha $FIX/data.txt => 9" "" 2>&1 >/dev/null)"
OUT="$(vma_process_assertions "grep -c alpha $FIX/data.txt => 9" "" 2>/dev/null)"
assert_eq "wrong count corrected to actual (2)" "grep -c alpha $FIX/data.txt => 2" "$OUT"
assert_contains "correction logged to stderr" "CORRECT (9 -> 2)" "$ERRLOG"

# -----------------------------------------------------------------------------
# Test 3: prose-suffix assertion -> stripped to bare "<command> => <count>"
# -----------------------------------------------------------------------------
echo "--- Test 3: prose suffix stripped ---"
OUT="$(vma_process_assertions "grep -c beta $FIX/data.txt => 1 lines (>= 1 required, PASS)" "" 2>/dev/null)"
assert_eq "prose stripped, bare count kept" "grep -c beta $FIX/data.txt => 1" "$OUT"
# Also confirm a prose suffix on a WRONG count both strips AND corrects.
OUT2="$(vma_process_assertions "grep -c alpha $FIX/data.txt => 16 lines" "" 2>/dev/null)"
assert_eq "prose + wrong count -> bare corrected count" "grep -c alpha $FIX/data.txt => 2" "$OUT2"

# -----------------------------------------------------------------------------
# Test 4: "=> 0" pre-create assertion whose target is in Files created -> dropped
# -----------------------------------------------------------------------------
echo "--- Test 4: forbidden pre-create absence dropped ---"
FILES_CREATED="$FIX/newthing.txt"
ERRLOG="$(vma_process_assertions "grep -rln newthing.txt $FIX => 0" "$FILES_CREATED" 2>&1 >/dev/null)"
OUT="$(vma_process_assertions "grep -rln newthing.txt $FIX => 0" "$FILES_CREATED" 2>/dev/null)"
# The only sub-assertion is forbidden -> nothing survives -> single N/A line.
assert_contains "forbidden pre-create yields N/A (nothing survives)" "N/A (" "$OUT"
assert_not_contains "forbidden assertion not emitted" "newthing.txt => 0" "$OUT"
assert_contains "forbidden drop logged" "FORBIDDEN pre-create absence" "$ERRLOG"
# Guard: expected != 0 for a created file is NOT forbidden. The command
# references the created file's basename (data.txt) but asserts a NONZERO count,
# so it must be kept. grep -rln prints the matching path (1 line) -> count 1.
OUTOK="$(vma_process_assertions "grep -rln alpha $FIX/data.txt => 1" "$FIX/data.txt" 2>/dev/null)"
assert_eq "created-file assertion with nonzero count is kept" "grep -rln alpha $FIX/data.txt => 1" "$OUTOK"

# -----------------------------------------------------------------------------
# Test 5: erroring command (bad path/regex) -> dropped + logged
# -----------------------------------------------------------------------------
echo "--- Test 5: erroring command dropped ---"
ERRLOG="$(vma_process_assertions "grep -rn alpha $FIX/no/such/dir/zzz => 3" "" 2>&1 >/dev/null)"
OUT="$(vma_process_assertions "grep -rn alpha $FIX/no/such/dir/zzz => 3" "" 2>/dev/null)"
assert_contains "erroring command yields N/A (nothing survives)" "N/A (" "$OUT"
assert_not_contains "erroring assertion not emitted with its bogus count" "=> 3" "$OUT"
assert_contains "erroring drop logged" "command errored" "$ERRLOG"

# -----------------------------------------------------------------------------
# Test 6: ALREADY_SATISFIED / BLOCKED short manifest with NO "Grep assertions:"
#         line -> passed through unchanged, no assertions executed, no N/A.
# -----------------------------------------------------------------------------
echo "--- Test 6: short manifest passthrough ---"
SHORT_MANIFEST=$'WO: WO-X-01\nBuilder: major-build\nOUTCOME: ALREADY_SATISFIED\nFiles created: none\nVALIDATION: PASS (verified no-op)'
OUT="$(printf '%s\n' "$SHORT_MANIFEST" | vma_process "" 2>/dev/null)"
# Passed through unchanged (printf adds one trailing newline; compare content).
assert_eq "short manifest content preserved verbatim" "$SHORT_MANIFEST" "$OUT"
assert_not_contains "no spurious Grep assertions line injected" "Grep assertions:" "$OUT"

# -----------------------------------------------------------------------------
# Test 7: full-manifest transform -- only the Grep assertions line changes;
#         multi sub-assertion value split on ';', each corrected per matrix.
# -----------------------------------------------------------------------------
echo "--- Test 7: full manifest, only Grep line rewritten ---"
A="grep -c alpha $FIX/data.txt => 2"                 # unchanged
B="grep -c alpha $FIX/data.txt => 9"                 # -> 2
C="grep -c beta $FIX/data.txt => 1 lines (ok)"       # prose stripped, stays 1
D="grep -rln newthing.txt $FIX => 0"                 # forbidden (created) -> dropped
E="grep -rn alpha $FIX/no/such/zzz => 3"             # error -> dropped
GREP_VAL="$A; $B; $C; $D; $E"
FULL_MANIFEST="$(printf '%s\n' \
  "WO: WO-Y-01" \
  "Builder: Codex" \
  "Files created: $FIX/newthing.txt" \
  "Files modified: none" \
  "Grep assertions: $GREP_VAL" \
  "VALIDATION: PASS")"
OUT="$(printf '%s\n' "$FULL_MANIFEST" | vma_process "$FIX/newthing.txt" 2>/dev/null)"
NEW_GREP_LINE="$(printf '%s\n' "$OUT" | grep -E '^Grep assertions:' | head -1)"
EXPECTED_GREP_LINE="Grep assertions: grep -c alpha $FIX/data.txt => 2; grep -c alpha $FIX/data.txt => 2; grep -c beta $FIX/data.txt => 1"
assert_eq "grep line corrected: kept/rewritten/stripped, forbidden+error dropped" \
  "$EXPECTED_GREP_LINE" "$NEW_GREP_LINE"
assert_contains "WO line preserved" "WO: WO-Y-01" "$OUT"
assert_contains "VALIDATION line preserved" "VALIDATION: PASS" "$OUT"
assert_contains "Files created line preserved" "Files created: $FIX/newthing.txt" "$OUT"
assert_eq "exactly one Grep assertions line" "1" \
  "$(printf '%s\n' "$OUT" | grep -cE '^Grep assertions:')"

# -----------------------------------------------------------------------------
# Test 8: bare "N/A (...)" Grep value passes through untouched.
# -----------------------------------------------------------------------------
echo "--- Test 8: N/A value passthrough ---"
OUT="$(vma_process_assertions "N/A (no source-level greps; behavior covered by Tests)" "" 2>/dev/null)"
assert_eq "N/A value kept verbatim" "N/A (no source-level greps; behavior covered by Tests)" "$OUT"

# -----------------------------------------------------------------------------
# Test 9: parity -- the verify-manifest-assertions node bash block must be
#         byte-identical between the two lanes (no shared include exists).
# -----------------------------------------------------------------------------
echo "--- Test 9: cross-lane node parity ---"
extract_node_block() {
  awk '
    /^  - id: verify-manifest-assertions$/ { c=1 }
    c && /^  - id: manifest-consistency-check$/ { exit }
    c { print }
  ' "$1"
}
BLOCK_A="$(extract_node_block "$CANONICAL_YAML")"
BLOCK_B="$(extract_node_block "$MIRROR_YAML")"
if [ "$BLOCK_A" = "$BLOCK_B" ]; then
  PASS=$((PASS + 1))
  echo "PASS: verify-manifest-assertions node identical across both lanes"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: verify-manifest-assertions node differs across lanes"
  diff <(printf '%s\n' "$BLOCK_A") <(printf '%s\n' "$BLOCK_B") || true
fi
assert_contains "canonical node block is non-empty" "vma_process_assertions" "$BLOCK_A"

# -----------------------------------------------------------------------------
# Test 10: basename substring collision -- a created file whose basename is a
#          literal substring of an UNRELATED file named in a legitimate "=> 0"
#          assertion must NOT be dropped as FORBIDDEN. Regression: the bare
#          `grep -Fq "$base"` matched "index.ts" inside "index.tsx".
# -----------------------------------------------------------------------------
echo "--- Test 10: basename substring collision not forbidden ---"
printf 'x\n' > "$FIX/index.ts"
# Created file: index.ts. Assertion is about a DIFFERENT file, index.tsx, which
# does not exist -> a real "=> 0" that must be executed and KEPT, not dropped.
OUT="$(vma_process_assertions "grep -rln index.tsx $FIX => 0" "$FIX/index.ts" 2>/dev/null)"
assert_eq "created index.ts does not forbid an assertion about index.tsx" \
  "grep -rln index.tsx $FIX => 0" "$OUT"
# The exact created path is still forbidden on a word boundary (true positive).
ERRLOG="$(vma_process_assertions "grep -rln index.ts $FIX => 0" "$FIX/index.ts" 2>&1 >/dev/null)"
assert_contains "exact-basename '=> 0' still forbidden" "FORBIDDEN pre-create absence" "$ERRLOG"

# -----------------------------------------------------------------------------
# Test 11: allowlist gate -- an assertion whose command mutates, chains, or
#          redirects is DROPPED UNEXECUTED (no side effect on the worktree),
#          including the case where an internal ';' fragments a compound command.
# -----------------------------------------------------------------------------
echo "--- Test 11: unsafe command dropped unexecuted ---"
# (a) bare mutating command -- rm is not on the allowlist first-token set.
GUARD="$FIX/data.txt"
vma_process_assertions "rm -f $GUARD => 0" "" >/dev/null 2>&1
if [ -e "$GUARD" ]; then
  PASS=$((PASS + 1)); echo "PASS: rm assertion dropped -- data.txt survived"
else
  FAIL=$((FAIL + 1)); echo "FAIL: rm assertion executed -- data.txt deleted"
fi
# (b) redirection to a file must not execute.
REDIR="$FIX/redir.out"; rm -f "$REDIR"
ERRLOG="$(vma_process_assertions "grep -c alpha $FIX/data.txt > $REDIR => 2" "" 2>&1 >/dev/null)"
if [ -e "$REDIR" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: redirect command executed (redir.out created)"
else
  PASS=$((PASS + 1)); echo "PASS: redirect command not executed"
fi
assert_contains "redirect drop logged" "read-only allowlist" "$ERRLOG"
# (c) internal ';' compound command -- the split fragments it and the mutating
#     fragment ('touch') is dropped by the allowlist; no side effect.
PWNED="$FIX/pwned.txt"; rm -f "$PWNED"
OUT="$(vma_process_assertions "touch $PWNED => 0" "" 2>/dev/null)"
assert_contains "touch assertion yields N/A (nothing survives)" "N/A (" "$OUT"
if [ -e "$PWNED" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: touch assertion executed (pwned.txt created)"
else
  PASS=$((PASS + 1)); echo "PASS: no side effect -- pwned.txt not created"
fi
# (d) a legitimate piped read-only command (grep | wc -l) still passes the gate.
OUTOK="$(vma_process_assertions "grep -c alpha $FIX/data.txt | wc -l => 1" "" 2>/dev/null)"
assert_eq "piped read-only command kept" "grep -c alpha $FIX/data.txt | wc -l => 1" "$OUTOK"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "==== verify-manifest-assertions.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
