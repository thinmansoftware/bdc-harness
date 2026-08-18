#!/usr/bin/env bash
# WO-HARNESS-BASE-LANE-AUTHORITY-01 -- Test 3 (early-fail sentinel).
#
# Extracts the capture-run-scope node's bash VERBATIM from the maintained lane and
# runs it against real temp git repos to prove the base-lane authority early-fail:
# when the worktree's HEAD shares no history with origin/$BASE_BRANCH (a disjoint
# lane -- e.g. an orphan release/ce), capture-run-scope MUST fail with the sentinel
# `worktree_not_on_declared_base_lane` BEFORE the implement node runs, instead of
# letting the run reach a tail node after a PR was already opened.
#
# Convention note: like bdc-feature-development.test.sh this is a standalone bash
# script, NOT wired into `bun run test`. It lives at .archon/workflows/__tests__/
# (NOT under defaults/__tests__) so its own sentinel references do not inflate the
# Stop 1 grep, which asserts exactly 11 lane YAMLs under defaults/ carry the
# sentinel. Run it directly:
#   bash .archon/workflows/__tests__/worktree-not-on-declared-base-lane.sh

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
LANE="$ROOT/.archon/workflows/defaults/bdc-feature-development.yaml"

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

NODE="$TMP/capture-run-scope.sh"
extract_node_script "$LANE" capture-run-scope > "$NODE"

# Sanity: the extracted node must actually carry the sentinel we are testing.
if ! grep -q 'worktree_not_on_declared_base_lane' "$NODE"; then
  fail "extraction" "capture-run-scope node did not contain the sentinel; extraction or lane is wrong"
  echo ""
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

git_init() {
  local repo="$1"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
}

# --- Case 1: disjoint lane -> early fail with sentinel ------------------------
disjoint_repo() {
  local repo="$1"
  mkdir -p "$repo/src"
  git_init "$repo"
  # HEAD history (the worktree's actual lineage).
  printf 'const a = 1;\n' > "$repo/src/a.ts"
  git -C "$repo" add src/a.ts
  git -C "$repo" commit -qm 'head-history baseline'
  # Disjoint orphan history for the declared base lane (no common ancestor).
  git -C "$repo" checkout -q --orphan release-ce
  git -C "$repo" rm -rq --cached . >/dev/null 2>&1 || true
  rm -f "$repo/src/a.ts"
  printf 'const orphan = 1;\n' > "$repo/src/orphan.ts"
  git -C "$repo" add src/orphan.ts
  git -C "$repo" commit -qm 'orphan release/ce baseline'
  local orphan_sha
  orphan_sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" update-ref refs/remotes/origin/release/ce "$orphan_sha"
  # Put HEAD back onto the disjoint main-like history and clean the tree.
  git -C "$repo" checkout -q master 2>/dev/null || git -C "$repo" checkout -q main 2>/dev/null || git -C "$repo" checkout -q -
  git -C "$repo" clean -fdq
}

REPO1="$TMP/repo1"
ART1="$TMP/art1"
mkdir -p "$ART1"
disjoint_repo "$REPO1"
OUT1=$(cd "$REPO1" && ARTIFACTS_DIR="$ART1" BASE_BRANCH="release/ce" bash "$NODE" 2>&1)
RC1=$?
if [ "$RC1" -ne 0 ] && printf '%s' "$OUT1" | grep -q 'worktree_not_on_declared_base_lane'; then
  if [ ! -f "$ART1/run-scope-sha.txt" ]; then
    pass "disjoint lane fails early with sentinel and writes no run-scope-sha"
  else
    fail "disjoint lane" "sentinel fired but run-scope-sha.txt was still written (assert not before capture)"
  fi
else
  fail "disjoint lane" "expected non-zero exit + sentinel; rc=$RC1 out=$OUT1"
fi

# --- Case 2: worktree ON the declared lane -> passes -------------------------
onlane_repo() {
  local repo="$1"
  mkdir -p "$repo/src"
  git_init "$repo"
  printf 'const a = 1;\n' > "$repo/src/a.ts"
  git -C "$repo" add src/a.ts
  git -C "$repo" commit -qm 'lane baseline'
  git -C "$repo" update-ref refs/remotes/origin/dev HEAD
  # A later commit that descends from origin/dev.
  printf 'const b = 2;\n' > "$repo/src/b.ts"
  git -C "$repo" add src/b.ts
  git -C "$repo" commit -qm 'descends from dev'
}

REPO2="$TMP/repo2"
ART2="$TMP/art2"
mkdir -p "$ART2"
onlane_repo "$REPO2"
OUT2=$(cd "$REPO2" && ARTIFACTS_DIR="$ART2" BASE_BRANCH="dev" bash "$NODE" 2>&1)
RC2=$?
if [ "$RC2" -eq 0 ] && [ -s "$ART2/run-scope-sha.txt" ] && \
   ! printf '%s' "$OUT2" | grep -q 'worktree_not_on_declared_base_lane'; then
  pass "worktree on declared lane passes and records run-scope-sha"
else
  fail "on-lane" "expected clean pass; rc=$RC2 out=$OUT2"
fi

# --- Case 3: no BASE_BRANCH set -> assertion skipped, passes ------------------
REPO3="$TMP/repo3"
ART3="$TMP/art3"
mkdir -p "$ART3"
onlane_repo "$REPO3"
OUT3=$(cd "$REPO3" && ARTIFACTS_DIR="$ART3" bash "$NODE" 2>&1)
RC3=$?
if [ "$RC3" -eq 0 ] && [ -s "$ART3/run-scope-sha.txt" ]; then
  pass "no BASE_BRANCH -> assertion skipped, capture succeeds"
else
  fail "no-base-branch" "expected clean pass; rc=$RC3 out=$OUT3"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
