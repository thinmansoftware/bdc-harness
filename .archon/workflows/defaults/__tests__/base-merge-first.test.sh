#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
LANE="$ROOT/.archon/workflows/defaults/bdc-feature-development-cursor.yaml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sed -n '/^      bdc_base_merge_first() {/,/^      }$/p' "$LANE" | sed 's/^      //' > "$TMP/helper.sh"
. "$TMP/helper.sh"
{
  printf '%s\n' 'lane_scope() {'
  printf '%s\n' '  cd "$WT"' '  SCOPE_SHA_FILE="$ARTIFACTS_DIR/run-scope-sha.txt"' '  LIST_FILE="$ARTIFACTS_DIR/run-changed-source-files.txt"' '  SCOPE_SHA=$(cat "$SCOPE_SHA_FILE")'
  sed -n '/^      BASE_MERGED_SHA=$(cat "$ARTIFACTS_DIR\/base-merged-sha.txt"/,/^      echo "RUN_CHANGED_SOURCE_FILES=$COUNT"/p' "$LANE" | sed 's/^      /  /'
  printf '%s\n' '}'
} > "$TMP/scope.sh"
. "$TMP/scope.sh"

git_config() {
  git config user.name test
  git config user.email test@example.com
}

setup_repo() {
  local name=$1
  git init --bare "$TMP/$name.git" >/dev/null
  git clone "$TMP/$name.git" "$TMP/$name" >/dev/null 2>&1
  cd "$TMP/$name"
  git_config
  echo initial > shared.txt
  git add shared.txt
  git commit -m initial >/dev/null
  git branch -M dev
  git push -u origin dev >/dev/null
  git checkout -b feature >/dev/null 2>&1
}

setup_repo clean
echo feature > feature.sh
git add feature.sh && git commit -m feature >/dev/null
feature_parent=$(git rev-parse HEAD)
git checkout dev >/dev/null 2>&1
echo base > base.sh
git add base.sh && git commit -m base >/dev/null
base_tip=$(git rev-parse HEAD)
git push origin dev >/dev/null
git checkout feature >/dev/null 2>&1
ARTIFACTS_DIR="$TMP/clean-artifacts"; export ARTIFACTS_DIR
bdc_base_merge_first dev >/dev/null
test "$(git rev-parse HEAD^1)" = "$feature_parent"
test "$(git rev-parse HEAD^2)" = "$base_tip"
test "$(cat "$ARTIFACTS_DIR/base-merged-sha.txt")" = "$(git rev-parse HEAD)"
git push origin HEAD:feature >/dev/null
echo 'ok 1 - clean merge records and pushes a real merge commit'

setup_repo conflict
mkdir -p packages/workflows/src/defaults
echo feature > packages/workflows/src/defaults/bundled-defaults.generated.ts
git add . && git commit -m feature-conflict >/dev/null
git checkout dev >/dev/null 2>&1
mkdir -p packages/workflows/src/defaults
echo base > packages/workflows/src/defaults/bundled-defaults.generated.ts
git add . && git commit -m base-conflict >/dev/null
git push origin dev >/dev/null
remote_before=$(git rev-parse refs/remotes/origin/dev)
git checkout feature >/dev/null 2>&1
ARTIFACTS_DIR="$TMP/conflict-artifacts"; export ARTIFACTS_DIR
if bdc_base_merge_first dev >/dev/null 2>&1; then exit 1; fi
grep -qx 'base_merge_conflict=packages/workflows/src/defaults/bundled-defaults.generated.ts' "$ARTIFACTS_DIR/base-merge-conflict.txt"
test -z "$(git status --porcelain)"
test "$(git ls-remote origin refs/heads/dev | awk '{print $1}')" = "$remote_before"
echo 'ok 2 - conflict aborts cleanly and records the path without pushing'

cd "$TMP/clean"
ARTIFACTS_DIR="$TMP/clean-artifacts"; export ARTIFACTS_DIR
printf '%s\n' "$feature_parent" > "$ARTIFACTS_DIR/run-scope-sha.txt"
WT=$PWD lane_scope >/dev/null
grep -qx feature.sh "$ARTIFACTS_DIR/run-changed-source-files.txt"
! grep -qx base.sh "$ARTIFACTS_DIR/run-changed-source-files.txt"
echo 'ok 3 - lane scope uses the recorded merge base parent'

rm "$ARTIFACTS_DIR/base-merged-sha.txt"
printf '%s\n' "$feature_parent" > "$ARTIFACTS_DIR/run-scope-sha.txt"
WT=$PWD lane_scope >/dev/null
grep -qx base.sh "$ARTIFACTS_DIR/run-changed-source-files.txt"
echo 'ok 4 - lane scope falls back to run scope when merge artifact is absent'
echo '4 passing / 4 total'
