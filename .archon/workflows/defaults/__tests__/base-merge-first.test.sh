#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
LANE="$ROOT/.archon/workflows/defaults/bdc-feature-development-cursor.yaml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sed -n '/^      bdc_base_merge_first() {/,/^      }$/p' "$LANE" | sed 's/^      //' > "$TMP/helper.sh"
. "$TMP/helper.sh"

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
echo feature > feature.txt
git add feature.txt && git commit -m feature >/dev/null
feature_parent=$(git rev-parse HEAD)
git checkout dev >/dev/null 2>&1
echo base > base.txt
git add base.txt && git commit -m base >/dev/null
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
merge_sha=$(cat "$TMP/clean-artifacts/base-merged-sha.txt")
git diff --name-only "${merge_sha}^2"..HEAD > "$TMP/scoped"
grep -qx feature.txt "$TMP/scoped"
! grep -qx base.txt "$TMP/scoped"
run_start=$(git rev-parse "${merge_sha}^1")
git diff --name-only "$run_start"..HEAD > "$TMP/fallback"
grep -qx base.txt "$TMP/fallback"
echo 'ok 3 - scope uses the base parent and retains run-start fallback'
echo '3 passing / 3 total'
