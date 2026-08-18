#!/usr/bin/env bash
# Regression tests for immutable, shared ASCII run scope.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
AUTOFIX="$ROOT/harness/scripts/ascii-autofix.py"
PYTHON_BIN=$(command -v python3 || command -v python || true)
LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-fable.yaml
)

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      $2"; FAIL=$((FAIL + 1)); }

has_non_ascii() {
  od -An -tu1 "$1" | tr ' ' '\n' \
    | grep -qE '^(12[89]|1[3-9][0-9]|2[0-4][0-9]|25[0-5])$'
}

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
REPO="$TMP/repo"
ARTIFACTS="$TMP/artifacts"
mkdir -p "$REPO" "$ARTIFACTS"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.com
git -C "$REPO" config user.name test

printf 'legacy ASCII\n' > "$REPO/importParser.ts"
git -C "$REPO" add importParser.ts
git -C "$REPO" commit -qm baseline
OLD_BASE=$(git -C "$REPO" rev-parse HEAD)

printf 'legacy \342\200\224 debt\n' > "$REPO/importParser.ts"
git -C "$REPO" add importParser.ts
git -C "$REPO" commit -qm 'legacy debt before run'
RUN_SCOPE=$(git -C "$REPO" rev-parse HEAD)
printf '%s\n' "$RUN_SCOPE" > "$ARTIFACTS/run-scope-sha.txt"

mkdir -p "$REPO/.github/workflows"
printf 'name: CE \342\200\224 gate\n' > "$REPO/.github/workflows/ce-change-scope-gate.yml"

WIDE=$(cd "$REPO" && {
  git diff --name-only "$OLD_BASE"..HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u)
NARROW=$(cd "$REPO" && {
  git diff --name-only "$RUN_SCOPE"..HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u)

if grep -qx 'importParser.ts' <<< "$WIDE" \
  && [ "$NARROW" = '.github/workflows/ce-change-scope-gate.yml' ]; then
  pass "immutable capture excludes pre-run legacy debt"
else
  fail "immutable capture excludes pre-run legacy debt" "wide=[$WIDE] narrow=[$NARROW]"
fi

printf '%s\n' '.github/workflows/ce-change-scope-gate.yml' \
  > "$ARTIFACTS/run-changed-source-files.txt"
printf 'decoy \342\200\224 must stay untouched\n' > "$REPO/untouched.ts"

OUT=$(cd "$REPO" && "$PYTHON_BIN" "$AUTOFIX" --files-from "$ARTIFACTS/run-changed-source-files.txt" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] \
  && ! has_non_ascii "$REPO/.github/workflows/ce-change-scope-gate.yml" \
  && has_non_ascii "$REPO/importParser.ts" \
  && has_non_ascii "$REPO/untouched.ts" \
  && [ "$OUT" = '.github/workflows/ce-change-scope-gate.yml' ]; then
  pass "autofix consumes only the authoritative file list"
else
  fail "autofix consumes only the authoritative file list" "rc=$RC output=[$OUT]"
fi

printf '%s\n' '../outside.ts' > "$ARTIFACTS/invalid-files.txt"
OUT=$(cd "$REPO" && "$PYTHON_BIN" "$AUTOFIX" --files-from "$ARTIFACTS/invalid-files.txt" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'outside repository' <<< "$OUT"; then
  pass "autofix rejects a path outside the repository"
else
  fail "autofix rejects a path outside the repository" "rc=$RC output=[$OUT]"
fi

printf '%s\n' 'missing.ts' > "$ARTIFACTS/missing-files.txt"
OUT=$(cd "$REPO" && "$PYTHON_BIN" "$AUTOFIX" --files-from "$ARTIFACTS/missing-files.txt" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'missing scope file' <<< "$OUT"; then
  pass "autofix rejects a missing listed file"
else
  fail "autofix rejects a missing listed file" "rc=$RC output=[$OUT]"
fi

WIRING_FAILURES=""
for lane in "${LANES[@]}"; do
  path="$ROOT/.archon/workflows/defaults/$lane"
  CAPTURE_COUNT=$(grep -c '^  - id: capture-run-scope$' "$path" || true)
  DERIVE_COUNT=$(grep -c '^  - id: derive-run-source-scope$' "$path" || true)
  IMPLEMENT_DEP_COUNT=$(grep -c 'depends_on: \[capture-run-scope\]' "$path" || true)
  LIST_COUNT=$(grep -c 'run-changed-source-files.txt' "$path" || true)
  FALLBACK_COUNT=$({
    extract_node_script "$path" ascii-autofix
    extract_node_script "$path" ascii-gate
  } | grep -c 'git merge-base HEAD.*HEAD~1' || true)
  if [ "$CAPTURE_COUNT" -ne 1 ] || [ "$DERIVE_COUNT" -ne 1 ] \
    || [ "$IMPLEMENT_DEP_COUNT" -ne 1 ] \
    || [ "$LIST_COUNT" -ne 3 ] || [ "$FALLBACK_COUNT" -ne 0 ]; then
    WIRING_FAILURES+="$lane($CAPTURE_COUNT/$DERIVE_COUNT/$IMPLEMENT_DEP_COUNT/$LIST_COUNT/$FALLBACK_COUNT) "
  fi
done
if [ -z "$WIRING_FAILURES" ]; then
  pass "all maintained lanes share one immutable ASCII scope artifact"
else
  fail "all maintained lanes share one immutable ASCII scope artifact" "$WIRING_FAILURES"
fi

PARITY_FAILURES=""
for node in capture-run-scope derive-run-source-scope ascii-autofix ascii-gate; do
  reference="$TMP/reference-$node.sh"
  extract_node_script "$ROOT/.archon/workflows/defaults/${LANES[0]}" "$node" > "$reference"
  for lane in "${LANES[@]:1}"; do
    candidate="$TMP/${lane}-${node}.sh"
    extract_node_script "$ROOT/.archon/workflows/defaults/$lane" "$node" > "$candidate"
    cmp -s "$reference" "$candidate" || PARITY_FAILURES+="$lane/$node "
  done
done
if [ -z "$PARITY_FAILURES" ]; then
  pass "ASCII scope scripts are identical across maintained lanes"
else
  fail "ASCII scope scripts are identical across maintained lanes" "$PARITY_FAILURES"
fi

RUNTIME_REPO="$TMP/runtime-repo"
RUNTIME_ARTIFACTS="$TMP/runtime-artifacts"
mkdir -p "$RUNTIME_REPO" "$RUNTIME_ARTIFACTS"
git -C "$RUNTIME_REPO" init -q
git -C "$RUNTIME_REPO" config user.email test@example.com
git -C "$RUNTIME_REPO" config user.name test
printf 'baseline\n' > "$RUNTIME_REPO/README.md"
git -C "$RUNTIME_REPO" add README.md
git -C "$RUNTIME_REPO" commit -qm baseline

REFERENCE_LANE="$ROOT/.archon/workflows/defaults/${LANES[0]}"
CAPTURE_SCRIPT="$TMP/capture-run-scope.sh"
DERIVE_SCRIPT="$TMP/derive-run-source-scope.sh"
GATE_SCRIPT="$TMP/ascii-gate.sh"
extract_node_script "$REFERENCE_LANE" capture-run-scope > "$CAPTURE_SCRIPT"
extract_node_script "$REFERENCE_LANE" derive-run-source-scope > "$DERIVE_SCRIPT"
extract_node_script "$REFERENCE_LANE" ascii-gate > "$GATE_SCRIPT"

OUT=$(cd "$RUNTIME_REPO" && ARTIFACTS_DIR="$RUNTIME_ARTIFACTS" bash "$CAPTURE_SCRIPT" 2>&1)
RC=$?
EXPECTED_SHA=$(git -C "$RUNTIME_REPO" rev-parse HEAD)
CAPTURED_SHA=$(cat "$RUNTIME_ARTIFACTS/run-scope-sha.txt" 2>/dev/null || true)
if [ "$RC" -eq 0 ] && [ "$CAPTURED_SHA" = "$EXPECTED_SHA" ]; then
  pass "actual capture node records clean HEAD"
else
  fail "actual capture node records clean HEAD" "rc=$RC output=[$OUT] captured=[$CAPTURED_SHA]"
fi

mkdir -p "$RUNTIME_REPO/.github/workflows"
printf 'name: authored \342\200\224 file\n' > "$RUNTIME_REPO/.github/workflows/ce-change-scope-gate.yml"
OUT=$(cd "$RUNTIME_REPO" && ARTIFACTS_DIR="$RUNTIME_ARTIFACTS" bash "$CAPTURE_SCRIPT" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'run_scope_dirty_at_capture' <<< "$OUT"; then
  pass "actual capture node rejects a dirty worktree"
else
  fail "actual capture node rejects a dirty worktree" "rc=$RC output=[$OUT]"
fi

MISSING_SCOPE_REPO="$TMP/missing-scope-repo"
MISSING_SCOPE_ARTIFACTS="$TMP/missing-scope-artifacts"
mkdir -p "$MISSING_SCOPE_REPO" "$MISSING_SCOPE_ARTIFACTS"
git -C "$MISSING_SCOPE_REPO" init -q
git -C "$MISSING_SCOPE_REPO" config user.email test@example.com
git -C "$MISSING_SCOPE_REPO" config user.name test
printf 'baseline\n' > "$MISSING_SCOPE_REPO/README.md"
git -C "$MISSING_SCOPE_REPO" add README.md
git -C "$MISSING_SCOPE_REPO" commit -qm baseline

OUT=$(cd "$MISSING_SCOPE_REPO" && ARTIFACTS_DIR="$MISSING_SCOPE_ARTIFACTS" bash "$DERIVE_SCRIPT" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'scope_authority_missing: run scope SHA is missing' <<< "$OUT"; then
  pass "true-missing-scope-still-fails"
else
  fail "true-missing-scope-still-fails" "rc=$RC output=[$OUT]"
fi

printf 'not-a-commit\n' > "$MISSING_SCOPE_ARTIFACTS/run-scope-sha.txt"
OUT=$(cd "$MISSING_SCOPE_REPO" && ARTIFACTS_DIR="$MISSING_SCOPE_ARTIFACTS" bash "$DERIVE_SCRIPT" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'scope_authority_missing: run scope SHA is invalid' <<< "$OUT"; then
  pass "invalid-scope-still-fails"
else
  fail "invalid-scope-still-fails" "rc=$RC output=[$OUT]"
fi

DRIFT_ORIGIN="$TMP/drift-origin.git"
DRIFT_SEED="$TMP/drift-seed"
DRIFT_SHARED="$TMP/drift-shared"
DRIFT_RUN="$TMP/drift-run"
DRIFT_ARTIFACTS="$TMP/drift-artifacts"
git init --bare -q "$DRIFT_ORIGIN"
git clone -q "$DRIFT_ORIGIN" "$DRIFT_SEED"
git -C "$DRIFT_SEED" config user.email test@example.com
git -C "$DRIFT_SEED" config user.name test
git -C "$DRIFT_SEED" checkout -qb dev
printf 'baseline\n' > "$DRIFT_SEED/README.md"
git -C "$DRIFT_SEED" add README.md
git -C "$DRIFT_SEED" commit -qm baseline
git -C "$DRIFT_SEED" push -q origin dev
git clone -q --branch dev "$DRIFT_ORIGIN" "$DRIFT_SHARED"
git -C "$DRIFT_SHARED" config user.email test@example.com
git -C "$DRIFT_SHARED" config user.name test
git -C "$DRIFT_SHARED" worktree add -q -b run "$DRIFT_RUN" dev
git -C "$DRIFT_RUN" config user.email test@example.com
git -C "$DRIFT_RUN" config user.name test
mkdir -p "$DRIFT_ARTIFACTS"

OUT=$(cd "$DRIFT_RUN" && ARTIFACTS_DIR="$DRIFT_ARTIFACTS" bash "$CAPTURE_SCRIPT" 2>&1)
RC=$?
DRIFT_SCOPE=$(cat "$DRIFT_ARTIFACTS/run-scope-sha.txt" 2>/dev/null || true)
printf 'export const feature = true;\n' > "$DRIFT_RUN/feature.ts"
git -C "$DRIFT_RUN" add feature.ts
git -C "$DRIFT_RUN" commit -qm 'implement feature'

git -C "$DRIFT_SEED" checkout -q --orphan rewritten-dev
git -C "$DRIFT_SEED" rm -qr . >/dev/null 2>&1 || true
printf 'rewritten baseline\n' > "$DRIFT_SEED/README.md"
git -C "$DRIFT_SEED" add README.md
git -C "$DRIFT_SEED" commit -qm 'rewrite dev'
git -C "$DRIFT_SEED" push -q --force origin HEAD:dev
git -C "$DRIFT_SHARED" fetch -q origin dev
git -C "$DRIFT_SHARED" checkout -q -f -B dev origin/dev
git -C "$DRIFT_SHARED" reset -q --hard origin/dev
git -C "$DRIFT_RUN" fetch -q origin dev
git -C "$DRIFT_RUN" rebase -q --onto origin/dev "$DRIFT_SCOPE"

OUT=$(cd "$DRIFT_RUN" && BASE_BRANCH=dev ARTIFACTS_DIR="$DRIFT_ARTIFACTS" bash "$DERIVE_SCRIPT" 2>&1)
RC=$?
DRIFT_LIST=$(cat "$DRIFT_ARTIFACTS/run-changed-source-files.txt" 2>/dev/null || true)
DRIFT_NEW_SCOPE=$(cat "$DRIFT_ARTIFACTS/run-scope-sha.txt" 2>/dev/null || true)
if [ "$RC" -eq 0 ] \
  && grep -qx 'feature.ts' <<< "$DRIFT_LIST" \
  && [ "$DRIFT_NEW_SCOPE" != "$DRIFT_SCOPE" ] \
  && git -C "$DRIFT_RUN" merge-base --is-ancestor "$DRIFT_NEW_SCOPE" HEAD; then
  pass "mid-run-shared-clone-head-move-still-passes"
else
  fail "mid-run-shared-clone-head-move-still-passes" "rc=$RC output=[$OUT] list=[$DRIFT_LIST] old=[$DRIFT_SCOPE] new=[$DRIFT_NEW_SCOPE]"
fi

OUT=$(cd "$RUNTIME_REPO" && ARTIFACTS_DIR="$RUNTIME_ARTIFACTS" bash "$DERIVE_SCRIPT" 2>&1)
RC=$?
RUNTIME_LIST=$(cat "$RUNTIME_ARTIFACTS/run-changed-source-files.txt" 2>/dev/null || true)
if [ "$RC" -eq 0 ] && [ "$RUNTIME_LIST" = '.github/workflows/ce-change-scope-gate.yml' ]; then
  pass "actual derive node writes the exact run-authored path"
else
  fail "actual derive node writes the exact run-authored path" "rc=$RC output=[$OUT] list=[$RUNTIME_LIST]"
fi

OUT=$(cd "$RUNTIME_REPO" && ARTIFACTS_DIR="$RUNTIME_ARTIFACTS" bash "$GATE_SCRIPT" 2>&1)
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'ASCII GATE FAILED' <<< "$OUT"; then
  pass "actual gate rejects run-authored non-ASCII"
else
  fail "actual gate rejects run-authored non-ASCII" "rc=$RC output=[$OUT]"
fi

(cd "$RUNTIME_REPO" && "$PYTHON_BIN" "$AUTOFIX" --files-from "$RUNTIME_ARTIFACTS/run-changed-source-files.txt" >/dev/null)
OUT=$(cd "$RUNTIME_REPO" && ARTIFACTS_DIR="$RUNTIME_ARTIFACTS" bash "$GATE_SCRIPT" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'scanned 1 changed source file' <<< "$OUT"; then
  pass "actual gate and autofix consume the same path list"
else
  fail "actual gate and autofix consume the same path list" "rc=$RC output=[$OUT]"
fi

echo ""
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
