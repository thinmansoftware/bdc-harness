#!/usr/bin/env bash
# manifest-pr-content-check.sh -- T1 fixture for PR-file vs manifest claim check
# WO-HARNESS-ZERO-OPEN-IMPLEMENT-MANIFEST-CHECKPOINT-TRUTH-01
#
# Scoped to the 7 lanes with manifest-consistency-check.
# Run: bash .archon/workflows/defaults/__tests__/manifest-pr-content-check.sh

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

assert_nonzero() {
  local label="$1" code="$2"
  if [ "$code" -ne 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label (exit=$code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (expected non-zero)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MCC_SISTER=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
)

extract_pr_block() {
  awk '
    /# ---- BEGIN manifest-pr-content-check ----/ { c=1; next }
    /# ---- END manifest-pr-content-check ----/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

echo "--- Parity: 7 manifest-pr-content-check blocks byte-identical ---"
REF=""
REF_NAME=""
for f in "${MCC_SISTER[@]}"; do
  path="$DEFAULTS_DIR/$f"
  block="$(extract_pr_block "$path")"
  if [ -z "$block" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: empty pr-content block in $f"
    continue
  fi
  if [ -z "$REF" ]; then
    REF="$block"
    REF_NAME="$f"
    PASS=$((PASS + 1))
    echo "PASS: reference from $f"
  else
    if [ "$block" = "$REF" ]; then
      PASS=$((PASS + 1))
      echo "PASS: $f matches $REF_NAME"
    else
      FAIL=$((FAIL + 1))
      echo "FAIL: $f differs from $REF_NAME"
    fi
  fi
done

if [ -z "$REF" ]; then
  echo "FATAL: no PR content block"
  exit 1
fi

# Standalone runner for the PR-content block with stubs
run_pr_check() {
  local pr_url="$1" manifest="$2" pr_files_payload="$3"
  local script bin out code
  script=$(mktemp)
  bin=$(mktemp -d)
  # stub gh
  cat > "$bin/gh" <<EOF
#!/usr/bin/env bash
# minimal gh stub for pr view --json files
if printf '%s\n' "\$*" | grep -q -- '--json files'; then
  # emit paths one per line like jq '.files[].path'
  printf '%s\n' '$pr_files_payload'
  exit 0
fi
echo "gh stub: unexpected args: \$*" >&2
exit 1
EOF
  # Fix: pr_files_payload may have newlines - use a file instead
  rm -f "$bin/gh"
  cat > "$bin/gh" <<'GHEOF'
#!/usr/bin/env bash
if printf '%s\n' "$*" | grep -q -- '--json files'; then
  cat "$GH_PR_FILES_FIXTURE"
  exit 0
fi
echo "gh stub: unexpected args: $*" >&2
exit 1
GHEOF
  chmod +x "$bin/gh"
  printf '%s\n' "$pr_files_payload" > "$bin/pr_files.txt"

  {
    echo 'set -euo pipefail'
    echo "export PATH=$(printf '%q' "$bin"):\"\$PATH\""
    echo "export GH_PR_FILES_FIXTURE=$(printf '%q' "$bin/pr_files.txt")"
    echo "PR_URL=$(printf '%q' "$pr_url")"
    echo "MANIFEST_OUT=$(printf '%q' "$manifest")"
    echo "PRS_LINE=''"
    echo 'extract() { { printf "%s\n" "$MANIFEST_OUT" | grep -E "^${1}:" | head -1 | sed "s/^${1}:[[:space:]]*//"; } || true; }'
    printf '%s\n' "$REF"
    echo "printf 'OK\n'"
  } > "$script"

  set +e
  out=$(bash "$script" 2>&1)
  code=$?
  set -e
  rm -rf "$bin" "$script"
  printf '%s\n' "$out"
  return "$code"
}

echo "--- Test: claimed path absent from PR files -> fail ---"
MANIFEST=$'Files created: docs/canary/zero-open-lane-canary-01.md\nFiles modified: none\nPRs: https://github.com/bluedevilcollectibles/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/bluedevilcollectibles/bdc-harness/pull/999" "$MANIFEST" ".archon/workflows/x.yaml")
CODE=$?
set -e
assert_nonzero "wrong content non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR'; then
  PASS=$((PASS + 1))
  echo "PASS: PR_CONTENT_ERROR on missing path"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected PR_CONTENT_ERROR"
  echo "$OUT"
fi

echo "--- Test: claimed path present in PR files -> OK ---"
MANIFEST=$'Files created: docs/canary/zero-open-lane-canary-01.md\nFiles modified: none\nPRs: https://github.com/bluedevilcollectibles/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/bluedevilcollectibles/bdc-harness/pull/999" "$MANIFEST" "docs/canary/zero-open-lane-canary-01.md")
CODE=$?
set -e
assert_eq "match exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when path matches"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK"
  echo "$OUT"
fi

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
