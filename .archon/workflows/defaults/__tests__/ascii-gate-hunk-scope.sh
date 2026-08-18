#!/usr/bin/env bash
# Regression tests for hunk-scoped ASCII gate behavior.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
MAINTAINED_LANE="$ROOT/.archon/workflows/defaults/bdc-feature-development.yaml"
LEGACY_LANE="$ROOT/.archon/workflows/defaults/bdc-bug-fix.yaml"
AUTOFIX_LANE="$ROOT/.archon/workflows/defaults/bdc-harness-ascii-autofix-01.yaml"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      $2"; FAIL=$((FAIL + 1)); }

extract_node_script() {
  local lane="$1" node="$2"
  awk -v wanted="$node" '
    $0 == "  - id: " wanted { in_node=1; next }
    in_node && $0 == "    bash: |" { in_bash=1; next }
    in_node && in_bash && $0 ~ /^  [^ ]/ { exit }
    in_node && in_bash {
      if ($0 ~ /^      /) sub(/^      /, "")
      print
    }
  ' "$lane"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MAINTAINED_GATE="$TMP/maintained-ascii-gate.sh"
LEGACY_GATE="$TMP/legacy-ascii-gate.sh"
MAINTAINED_AUTOFIX="$TMP/maintained-ascii-autofix.sh"
LEGACY_AUTOFIX="$TMP/legacy-ascii-autofix.sh"
extract_node_script "$MAINTAINED_LANE" ascii-gate > "$MAINTAINED_GATE"
extract_node_script "$LEGACY_LANE" ascii-gate > "$LEGACY_GATE"
extract_node_script "$MAINTAINED_LANE" ascii-autofix > "$MAINTAINED_AUTOFIX"
extract_node_script "$AUTOFIX_LANE" ascii-autofix > "$LEGACY_AUTOFIX"

setup_repo() {
  local repo="$1" artifacts="$2"
  mkdir -p "$repo/src" "$artifacts"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  printf 'const start = 1;\n' > "$repo/src/legacy.ts"
  git -C "$repo" add src/legacy.ts
  git -C "$repo" commit -qm baseline
  printf 'const start = 1;\n// legacy \342\200\224 debt\n' > "$repo/src/legacy.ts"
  git -C "$repo" add src/legacy.ts
  git -C "$repo" commit -qm 'legacy non-ascii before run'
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" rev-parse HEAD > "$artifacts/run-scope-sha.txt"
}

run_maintained_gate() {
  local repo="$1" artifacts="$2" list="$3"
  printf '%s\n' "$list" > "$artifacts/run-changed-source-files.txt"
  (cd "$repo" && ARTIFACTS_DIR="$artifacts" bash "$MAINTAINED_GATE" 2>&1)
}

run_legacy_gate() {
  local repo="$1"
  (cd "$repo" && BASE_BRANCH=main bash "$LEGACY_GATE" 2>&1)
}

for family in maintained legacy; do
  REPO="$TMP/${family}-pass-repo"
  ARTIFACTS="$TMP/${family}-pass-artifacts"
  setup_repo "$REPO" "$ARTIFACTS"
  printf 'const start = 1;\n// legacy \342\200\224 debt\nconst added = 2;\n' > "$REPO/src/legacy.ts"
  if [ "$family" = maintained ]; then
    OUT=$(run_maintained_gate "$REPO" "$ARTIFACTS" "src/legacy.ts")
  else
    OUT=$(run_legacy_gate "$REPO")
  fi
  RC=$?
  if [ "$RC" -eq 0 ] && grep -q 'ascii-gate PASS' <<< "$OUT"; then
    pass "$family gate ignores pre-existing non-ASCII outside added hunks"
  else
    fail "$family gate ignores pre-existing non-ASCII outside added hunks" "rc=$RC output=[$OUT]"
  fi

  REPO="$TMP/${family}-fail-repo"
  ARTIFACTS="$TMP/${family}-fail-artifacts"
  setup_repo "$REPO" "$ARTIFACTS"
  printf 'const start = 1;\n// legacy \342\200\224 debt\nconst added = "\342\200\224";\n' > "$REPO/src/legacy.ts"
  if [ "$family" = maintained ]; then
    OUT=$(run_maintained_gate "$REPO" "$ARTIFACTS" "src/legacy.ts")
  else
    OUT=$(run_legacy_gate "$REPO")
  fi
  RC=$?
  if [ "$RC" -ne 0 ] \
    && grep -q 'ASCII GATE FAILED' <<< "$OUT" \
    && grep -q 'src/legacy.ts:3:const added' <<< "$OUT" \
    && ! grep -q 'legacy .* debt' <<< "$OUT"; then
    pass "$family gate reports only added non-ASCII lines"
  else
    fail "$family gate reports only added non-ASCII lines" "rc=$RC output=[$OUT]"
  fi

  REPO="$TMP/${family}-new-repo"
  ARTIFACTS="$TMP/${family}-new-artifacts"
  setup_repo "$REPO" "$ARTIFACTS"
  printf 'export const arrow = "\342\206\222";\n' > "$REPO/src/new.ts"
  if [ "$family" = maintained ]; then
    OUT=$(run_maintained_gate "$REPO" "$ARTIFACTS" "src/new.ts")
  else
    OUT=$(run_legacy_gate "$REPO")
  fi
  RC=$?
  if [ "$RC" -ne 0 ] && grep -q 'ASCII GATE FAILED' <<< "$OUT" && grep -q 'src/new.ts' <<< "$OUT"; then
    pass "$family gate whole-file scans untracked new files"
  else
    fail "$family gate whole-file scans untracked new files" "rc=$RC output=[$OUT]"
  fi

  REPO="$TMP/${family}-rename-repo"
  ARTIFACTS="$TMP/${family}-rename-artifacts"
  setup_repo "$REPO" "$ARTIFACTS"
  git -C "$REPO" mv src/legacy.ts src/renamed.ts
  if [ "$family" = maintained ]; then
    OUT=$(run_maintained_gate "$REPO" "$ARTIFACTS" "src/renamed.ts")
  else
    OUT=$(run_legacy_gate "$REPO")
  fi
  RC=$?
  if [ "$RC" -eq 0 ] && grep -q 'ascii-gate PASS' <<< "$OUT"; then
    pass "$family gate does not whole-file scan tracked renames"
  else
    fail "$family gate does not whole-file scan tracked renames" "rc=$RC output=[$OUT]"
  fi
done

AUTOFIX_REPO="$TMP/autofix-repo"
AUTOFIX_ARTIFACTS="$TMP/autofix-artifacts"
mkdir -p "$AUTOFIX_REPO" "$AUTOFIX_ARTIFACTS"
git -C "$AUTOFIX_REPO" init -q
printf 'src/legacy.ts\n' > "$AUTOFIX_ARTIFACTS/run-changed-source-files.txt"
OUT=$(cd "$AUTOFIX_REPO" && ARTIFACTS_DIR="$AUTOFIX_ARTIFACTS" bash "$MAINTAINED_AUTOFIX" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'WARN' <<< "$OUT" && grep -q 'skipping' <<< "$OUT"; then
  pass "maintained ascii-autofix warns and skips when script is absent"
else
  fail "maintained ascii-autofix warns and skips when script is absent" "rc=$RC output=[$OUT]"
fi

OUT=$(cd "$AUTOFIX_REPO" && ARTIFACTS_DIR="$AUTOFIX_ARTIFACTS" bash "$LEGACY_AUTOFIX" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'WARN' <<< "$OUT" && grep -q 'skipping' <<< "$OUT"; then
  pass "legacy ascii-autofix warns and skips when script is absent"
else
  fail "legacy ascii-autofix warns and skips when script is absent" "rc=$RC output=[$OUT]"
fi

echo ""
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
