#!/usr/bin/env bash
# Hermetic tests for bdc_base_merge_first / bdc_run_changed_paths.
# Extracts the marked block from the cursor lane and runs it against temp repos.

set -uo pipefail

PASS=0
FAIL=0
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEFAULTS_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
CANONICAL_YAML="$DEFAULTS_DIR/bdc-feature-development-cursor.yaml"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

extract_block() {
  sed -n '/# ---- BEGIN base-merge-first ----/,/# ---- END base-merge-first ----/p' "$1" | sed '1d;$d;s/^      //'
}

BLOCK=$(extract_block "$CANONICAL_YAML")
[ -n "$BLOCK" ] || { echo "FATAL: base-merge-first block not found"; exit 1; }
eval "$BLOCK"

mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/gh" << 'EOF'
#!/bin/sh
# Harmless stub: tests must never reach GitHub. Exit nonzero so the lane
# function has to tolerate a failed pr view / pr comment.
exit 1
EOF
chmod +x "$TMP_ROOT/bin/gh"
export PATH="$TMP_ROOT/bin:$PATH"

seed_repo() {
  local root="$1"
  mkdir -p "$root/seed"
  git -C "$root/seed" init -q -b dev
  configure_repo_at "$root/seed"
}

configure_repo_at() {
  git -C "$1" config user.email test@example.com
  git -C "$1" config user.name "BDC Test"
  git -C "$1" config commit.gpgsign false
}

commit_file() {
  local repo="$1" path="$2" content="$3" message="$4"
  mkdir -p "$(dirname "$repo/$path")"
  printf '%s\n' "$content" > "$repo/$path"
  git -C "$repo" add -- "$path"
  git -C "$repo" commit -q -m "$message"
}

publish_clone() {
  local root="$1" branch="$2"
  git clone -q --bare "$root/seed" "$root/origin.git"
  git clone -q --branch "$branch" "$root/origin.git" "$root/work"
  configure_repo_at "$root/work"
}

echo "--- Test 1: clean merge then push ---"
R1="$TMP_ROOT/t1"
seed_repo "$R1"
commit_file "$R1/seed" README.md base "base"
git -C "$R1/seed" checkout -q -b feature
commit_file "$R1/seed" file-a.txt "feature side" "feature A"
git -C "$R1/seed" checkout -q dev
commit_file "$R1/seed" file-b.txt "base side" "base B"
publish_clone "$R1" feature
ART1="$R1/artifacts"
mkdir -p "$ART1"
pushd "$R1/work" >/dev/null
ARTIFACTS_DIR="$ART1"
PRE=$(git rev-parse HEAD)
if bdc_base_merge_first dev; then
  HEAD_NOW=$(git rev-parse HEAD)
  P1=$(git rev-parse HEAD^1)
  P2=$(git rev-parse HEAD^2)
  ORIGIN_DEV=$(git rev-parse origin/dev)
  RECORDED=$(tr -d '[:space:]' < "$ART1/base-merged-sha.txt")
  if git push origin "HEAD:feature"; then
    REMOTE=$(git --git-dir "$R1/origin.git" rev-parse refs/heads/feature)
    if [ "$P1" = "$PRE" ] && [ "$P2" = "$ORIGIN_DEV" ] && [ "$RECORDED" = "$HEAD_NOW" ] && [ "$REMOTE" = "$HEAD_NOW" ]; then
      pass "clean merge then push"
    else
      echo "P1=$P1 PRE=$PRE P2=$P2 ORIGIN_DEV=$ORIGIN_DEV RECORDED=$RECORDED HEAD=$HEAD_NOW REMOTE=$REMOTE"
      fail "clean merge then push"
    fi
  else
    fail "clean merge push failed"
  fi
else
  fail "clean merge returned nonzero"
fi
popd >/dev/null

echo "--- Test 2: conflict means no push and recorded paths ---"
R2="$TMP_ROOT/t2"
seed_repo "$R2"
CONFLICT_PATH="packages/workflows/src/defaults/bundled-defaults.generated.ts"
commit_file "$R2/seed" "$CONFLICT_PATH" "base line" "base bundle"
git -C "$R2/seed" checkout -q -b feature
commit_file "$R2/seed" "$CONFLICT_PATH" "feature line" "feature bundle"
git -C "$R2/seed" checkout -q dev
commit_file "$R2/seed" "$CONFLICT_PATH" "dev line" "dev bundle"
publish_clone "$R2" feature
ART2="$R2/artifacts"
mkdir -p "$ART2"
BEFORE=$(git --git-dir "$R2/origin.git" rev-parse refs/heads/feature)
(
  cd "$R2/work" || exit 1
  ARTIFACTS_DIR="$ART2"
  if bdc_base_merge_first dev; then
    git push origin "HEAD:feature"
    echo "PUSHED=yes"
  else
    echo "PUSHED=no"
  fi
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "MERGING=yes"
  else
    echo "MERGING=no"
  fi
  git status --porcelain > "$ART2/status.txt"
) > "$ART2/run.out"
AFTER=$(git --git-dir "$R2/origin.git" rev-parse refs/heads/feature)
LINE=$(cat "$ART2/base-merge-conflict.txt" 2>/dev/null || true)
STATUS=$(cat "$ART2/status.txt" 2>/dev/null || true)
RUN_OUT=$(cat "$ART2/run.out")
if printf '%s\n' "$RUN_OUT" | grep -q '^PUSHED=no$' \
  && printf '%s\n' "$RUN_OUT" | grep -q '^MERGING=no$' \
  && [ "$LINE" = "base_merge_conflict=${CONFLICT_PATH}" ] \
  && [ -z "$STATUS" ] \
  && [ "$BEFORE" = "$AFTER" ]; then
  pass "conflict records paths and does not push"
else
  echo "LINE=$LINE"
  echo "STATUS=$STATUS"
  echo "BEFORE=$BEFORE AFTER=$AFTER"
  echo "RUN_OUT<<EOF"
  printf '%s\n' "$RUN_OUT"
  echo "EOF"
  fail "conflict records paths and does not push"
fi

echo "--- Test 3: scope record carries base_merged_sha ---"
R3="$TMP_ROOT/t3"
seed_repo "$R3"
commit_file "$R3/seed" root.txt root "root"
RUN_START=$(git -C "$R3/seed" rev-parse HEAD)
git -C "$R3/seed" checkout -q -b feature
commit_file "$R3/seed" file-a.txt "only A" "feature A"
git -C "$R3/seed" checkout -q dev
commit_file "$R3/seed" file-b.txt "only B" "base B"
publish_clone "$R3" feature
ART3="$R3/artifacts"
mkdir -p "$ART3"
printf '%s\n' "$RUN_START" > "$ART3/run-start-sha.txt"
(
  cd "$R3/work" || exit 1
  ARTIFACTS_DIR="$ART3"
  bdc_base_merge_first dev >/dev/null
  bdc_run_changed_paths > "$ART3/with-sha.txt"
  rm -f "$ART3/base-merged-sha.txt"
  bdc_run_changed_paths > "$ART3/fallback.txt"
)
WITH=$(cat "$ART3/with-sha.txt" 2>/dev/null || true)
FALLBACK=$(cat "$ART3/fallback.txt" 2>/dev/null || true)
if [ "$WITH" = "file-a.txt" ] \
  && printf '%s\n' "$FALLBACK" | grep -qx 'file-a.txt' \
  && printf '%s\n' "$FALLBACK" | grep -qx 'file-b.txt'; then
  pass "scope uses base_merged_sha and falls back to run-start-sha"
else
  echo "WITH<<EOF"
  printf '%s\n' "$WITH"
  echo "EOF"
  echo "FALLBACK<<EOF"
  printf '%s\n' "$FALLBACK"
  echo "EOF"
  fail "scope uses base_merged_sha and falls back to run-start-sha"
fi

echo "${PASS} passing / 3 total"
if [ "$FAIL" -ne 0 ] || [ "$PASS" -ne 3 ]; then
  exit 1
fi
