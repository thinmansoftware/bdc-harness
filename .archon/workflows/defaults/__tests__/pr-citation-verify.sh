#!/usr/bin/env bash
# pr-citation-verify.sh -- tests PR citation verification block.
#
# Run: bash .archon/workflows/defaults/__tests__/pr-citation-verify.sh

set -uo pipefail

FAIL=0
PASS=0

assert_code() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" -eq "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label expected exit $expected got $actual"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
)

extract_pr_citation_block() {
  awk '
    /# ---- BEGIN pr-citation-verification ----/ { c=1; next }
    /# ---- END pr-citation-verification ----/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

REF=""
for f in "${LANES[@]}"; do
  block="$(extract_pr_citation_block "$DEFAULTS_DIR/$f")"
  if [ -z "$block" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: missing PR citation block in $f"
  elif [ -z "$REF" ]; then
    REF="$block"
    PASS=$((PASS + 1))
    echo "PASS: reference $f"
  elif [ "$block" = "$REF" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $f matches"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $f differs"
  fi
done

run_pr_citation_check() {
  local pr_url="$1" manifest="$2" opus="$3" gh_mode="$4" script bin code
  script=$(mktemp)
  bin=$(mktemp -d)
  cat > "$bin/gh" <<'GHEOF'
#!/usr/bin/env bash
case "${GH_MODE:-}" in
  matching)
    printf '%s\n' 'https://github.com/bluedevilcollectibles/bdc-harness/pull/999'
    printf '%s\n' 'STATE=OPEN'
    printf '%s\n' 'HEAD=wo/WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01'
    printf '%s\n' 'TITLE=WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01'
    printf '%s\n' 'BODY=implements WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01'
    printf '%s\n' 'FILES=.archon/workflows/defaults/bdc-feature-development-zero-open.yaml'
    ;;
  merged_other)
    printf '%s\n' 'https://github.com/bluedevilcollectibles/bdc-harness/pull/352'
    printf '%s\n' 'STATE=MERGED'
    printf '%s\n' 'HEAD=workflow-test-infra'
    printf '%s\n' 'TITLE=unrelated workflow test infra'
    printf '%s\n' 'BODY=no matching work order'
    printf '%s\n' 'FILES=packages/workflows/src/other.ts'
    ;;
  *)
    exit 1
    ;;
esac
GHEOF
  chmod +x "$bin/gh"
  {
    echo 'set -euo pipefail'
    echo "export PATH=$(printf '%q' "$bin"):\"\$PATH\""
    echo "export GH_MODE=$(printf '%q' "$gh_mode")"
    echo "PR_URL=$(printf '%q' "$pr_url")"
    echo "MANIFEST_OUT=$(printf '%q' "$manifest")"
    echo "OPUS_OUT=$(printf '%q' "$opus")"
    echo 'WO_ID=WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01'
    printf '%s\n' "$REF"
  } > "$script"
  bash "$script" >/dev/null 2>&1
  code=$?
  rm -rf "$script" "$bin"
  return "$code"
}

run_pr_citation_check \
  "https://github.com/bluedevilcollectibles/bdc-harness/pull/999" \
  $'WO: WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01\nPRs: https://github.com/bluedevilcollectibles/bdc-harness/pull/999\nVALIDATION: PASS' \
  "" \
  matching
assert_code "matching run PR citation passes silently" 0 "$?"

run_pr_citation_check \
  "" \
  $'WO: WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01\nPRs: https://github.com/bluedevilcollectibles/bdc-harness/pull/999\nVALIDATION: PASS' \
  "" \
  matching
assert_code "verified WO-matching non-run PR passes" 0 "$?"

run_pr_citation_check \
  "" \
  $'WO: WO-HARNESS-DOWNSTREAM-NODES-MUST-RESPECT-PLAN-REJECTION-01\nPRs: https://github.com/bluedevilcollectibles/bdc-harness/pull/352\nVALIDATION: PASS' \
  "" \
  merged_other
assert_code "unrelated merged PR citation fails" 1 "$?"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
