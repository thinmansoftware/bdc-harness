#!/usr/bin/env bash
# stamp-manifest-pr.sh -- unit tests for the stamp-manifest-pr node logic.
#
# WO-HARNESS-MANIFEST-PR-FIELD-MECHANICAL-01.
#
# The stamp-manifest-pr node makes the manifest's load-bearing PRs: line
# mechanical: when block-reclassify.status=PROCEED and open-pr-if-needed
# resolved a PR URL, the manifest is rewritten to contain that exact URL.
#
# Run: bash .archon/workflows/defaults/__tests__/stamp-manifest-pr.sh
# Exits 0 on all-pass, 1 on any failure.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CANONICAL_YAML="$DEFAULTS_DIR/bdc-feature-development.yaml"
LANES="
$DEFAULTS_DIR/bdc-feature-development.yaml
$DEFAULTS_DIR/bdc-feature-development-codex.yaml
$DEFAULTS_DIR/bdc-feature-development-codex-only.yaml
$DEFAULTS_DIR/bdc-feature-development-fusion-cx-qwen.yaml
$DEFAULTS_DIR/bdc-feature-development-zero.yaml
$DEFAULTS_DIR/bdc-feature-development-zero-open.yaml
"

extract_smp_core() {
  awk '
    /# ---- BEGIN stamp-manifest-pr core/ { c=1; next }
    /# ---- END stamp-manifest-pr core/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

SMP_CORE="$(extract_smp_core "$CANONICAL_YAML")"
if [ -z "$SMP_CORE" ]; then
  echo "FATAL: could not extract stamp-manifest-pr core from $CANONICAL_YAML"
  exit 1
fi

eval "$SMP_CORE"
if ! declare -F smp_process >/dev/null; then
  echo "FATAL: smp_process not defined after eval"
  exit 1
fi

# Match manifest-consistency-check / stamp-manifest-pr extraction by
# construction: PR_URL= first, then a bare GitHub URL fallback.
extract_pr_url() {
  local open_pr_out="$1" pr_url
  pr_url=$(printf '%s\n' "$open_pr_out" | grep -E '^PR_URL=' | sed 's/^PR_URL=//' | head -1 || true)
  if [ -z "$pr_url" ]; then
    pr_url=$(printf '%s\n' "$open_pr_out" | grep -E '^https://github\.com/' | head -1 || true)
  fi
  printf '%s' "$pr_url"
}

extract_status() {
  printf '%s\n' "$1" | sed -n 's/.*"status":"\([A-Z_]*\)".*/\1/p' | head -1
}

echo "--- Test 1: PROCEED + PR_URL overwrites AI N/A ---"
MANIFEST=$'WO: WO-X\nBuilder: Codex\nPRs: N/A (committed)\nVALIDATION: PASS'
RECLASSIFY='{"status":"PROCEED"}'
OPEN_PR_OUT='PR_URL=https://github.com/thinmansoftware/bdc-harness/pull/409'
STATUS="$(extract_status "$RECLASSIFY")"
PR_URL="$(extract_pr_url "$OPEN_PR_OUT")"
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "$STATUS" "$PR_URL")"
PRS_LINE="$(printf '%s\n' "$OUT" | grep -E '^PRs:' | head -1)"
assert_eq "PRs line stamped with exact PR_URL" "PRs: https://github.com/thinmansoftware/bdc-harness/pull/409" "$PRS_LINE"
assert_contains "other manifest line preserved" "VALIDATION: PASS" "$OUT"

echo "--- Test 2: ALREADY_SATISFIED manifest unchanged ---"
MANIFEST=$'WO: WO-X\nBuilder: Codex\nOUTCOME: ALREADY_SATISFIED\nPRs: N/A (ALREADY_SATISFIED)\nVALIDATION: PASS'
STATUS="$(extract_status '{"status":"ALREADY_SATISFIED"}')"
PR_URL="$(extract_pr_url 'PR_URL=https://github.com/thinmansoftware/bdc-harness/pull/409')"
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "$STATUS" "$PR_URL")"
assert_eq "ALREADY_SATISFIED passthrough" "$MANIFEST" "$OUT"

echo "--- Test 3: PROCEED with no PR_URL unchanged ---"
MANIFEST=$'WO: WO-X\nBuilder: Codex\nPRs: N/A (open-pr failed)\nVALIDATION: FAIL'
STATUS="$(extract_status '{"status":"PROCEED"}')"
PR_URL="$(extract_pr_url 'open-pr-if-needed: gh pr create failed')"
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "$STATUS" "$PR_URL")"
assert_eq "PROCEED without PR_URL does not fabricate PR" "$MANIFEST" "$OUT"

echo "--- Test 4: bare URL fallback is stamped ---"
MANIFEST=$'WO: WO-X\nBuilder: Codex\nPRs: no PR opened\nVALIDATION: PASS'
OPEN_PR_OUT='https://github.com/thinmansoftware/bdc-harness/pull/410'
PR_URL="$(extract_pr_url "$OPEN_PR_OUT")"
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "PROCEED" "$PR_URL")"
PRS_LINE="$(printf '%s\n' "$OUT" | grep -E '^PRs:' | head -1)"
assert_eq "bare URL fallback stamped" "PRs: https://github.com/thinmansoftware/bdc-harness/pull/410" "$PRS_LINE"

echo "--- Test 5: PROCEED with no PRs line appends one ---"
MANIFEST=$'WO: WO-X\nBuilder: Codex\nVALIDATION: PASS'
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "PROCEED" "https://github.com/thinmansoftware/bdc-harness/pull/411")"
PRS_LINE="$(printf '%s\n' "$OUT" | grep -E '^PRs:' | head -1)"
assert_eq "missing PRs line appended" "PRs: https://github.com/thinmansoftware/bdc-harness/pull/411" "$PRS_LINE"
assert_contains "original short manifest preserved" "VALIDATION: PASS" "$OUT"

echo "--- Test 6: BLOCKED short manifest with no PRs line unchanged ---"
MANIFEST=$'WO: WO-X\nOUTCOME: BLOCKED\nVALIDATION: FAIL (blocked)'
OUT="$(printf '%s\n' "$MANIFEST" | smp_process "BLOCKED" "https://github.com/thinmansoftware/bdc-harness/pull/412")"
assert_eq "BLOCKED no-PRs passthrough" "$MANIFEST" "$OUT"

echo "--- Test 7: six-lane stamp core parity ---"
BASE_CORE="$SMP_CORE"
COUNT=0
while IFS= read -r lane; do
  [ -z "$lane" ] && continue
  COUNT=$((COUNT + 1))
  CORE="$(extract_smp_core "$lane")"
  if [ "$CORE" = "$BASE_CORE" ]; then
    PASS=$((PASS + 1))
    echo "PASS: stamp core parity $(basename "$lane")"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: stamp core differs in $(basename "$lane")"
    diff <(printf '%s\n' "$BASE_CORE") <(printf '%s\n' "$CORE") || true
  fi
done <<EOF_LANES
$LANES
EOF_LANES
assert_eq "six lanes checked" "6" "$COUNT"

echo ""
echo "==== stamp-manifest-pr.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
