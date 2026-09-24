#!/usr/bin/env bash
# Regression tests for lane format-autofix (target-repo Prettier, run-changed files only).

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
DEFAULTS="$ROOT/.archon/workflows/defaults"
PRETTIER_BIN="$ROOT/node_modules/.bin/prettier"

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

init_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
}

write_prettier_pkg() {
  printf '%s\n' '{' '  "devDependencies": {' '    "prettier": "^3.7.4"' '  }' '}' > "$1/package.json"
}

if [ ! -x "$PRETTIER_BIN" ]; then
  echo "FAIL: prettier binary present"
  echo "      $PRETTIER_BIN missing"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# prettier's shebang is /usr/bin/env node. This image has bun and no node binary.
NODE_SHIM="$TMP/bin"
mkdir -p "$NODE_SHIM"
ln -sf "$(command -v bun)" "$NODE_SHIM/node"
export PATH="$NODE_SHIM:$PATH"

REFERENCE="$DEFAULTS/bdc-feature-development.yaml"
SCRIPT="$TMP/format-autofix.sh"
extract_node_script "$REFERENCE" format-autofix > "$SCRIPT"
if [ ! -s "$SCRIPT" ]; then
  echo "FAIL: extracted format-autofix script"
  echo "      empty script from $REFERENCE"
  exit 1
fi

mapfile -t LANES < <(find "$DEFAULTS" -maxdepth 1 -name 'bdc-feature-development*.yaml' -printf '%f\n' | sort)
PARITY_FAILURES=""
for lane in "${LANES[@]}"; do
  candidate="$TMP/${lane}.sh"
  extract_node_script "$DEFAULTS/$lane" format-autofix > "$candidate"
  cmp -s "$SCRIPT" "$candidate" || PARITY_FAILURES+="$lane "
done
if [ -z "$PARITY_FAILURES" ] && [ "${#LANES[@]}" -eq 12 ]; then
  pass "format-autofix script is identical across 12 lanes"
else
  fail "format-autofix script is identical across 12 lanes" "count=${#LANES[@]} drift=[$PARITY_FAILURES]"
fi

# 1. Unformatted TypeScript + Prettier -> FORMAT_STATUS=fixed and check is clean.
REPO1="$TMP/unformatted"
ART1="$TMP/art1"
mkdir -p "$ART1"
init_repo "$REPO1"
write_prettier_pkg "$REPO1"
printf 'export const value = 1;\n' > "$REPO1/baseline.ts"
git -C "$REPO1" add package.json baseline.ts
git -C "$REPO1" commit -qm baseline
printf 'export const value={a:1,b:2}\n' > "$REPO1/dirty.ts"
git -C "$REPO1" add dirty.ts
printf '%s\n' 'dirty.ts' > "$ART1/run-changed-source-files.txt"
OUT=$(cd "$REPO1" && ARTIFACTS_DIR="$ART1" RUNNER="$PRETTIER_BIN" bash "$SCRIPT" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] \
  && grep -qx 'FORMAT_STATUS=fixed' <<< "$OUT" \
  && "$PRETTIER_BIN" --check "$REPO1/dirty.ts" >/dev/null 2>&1; then
  pass "unformatted file is fixed and prettier --check passes"
else
  fail "unformatted file is fixed and prettier --check passes" "rc=$RC output=[$OUT]"
fi

# 2. Already formatted file -> FORMAT_STATUS=clean and no diff.
REPO2="$TMP/clean"
ART2="$TMP/art2"
mkdir -p "$ART2"
init_repo "$REPO2"
write_prettier_pkg "$REPO2"
printf 'export const value={a:1,b:2}\n' > "$REPO2/clean.ts"
git -C "$REPO2" add package.json clean.ts
"$PRETTIER_BIN" --write "$REPO2/clean.ts" >/dev/null
git -C "$REPO2" add clean.ts
git -C "$REPO2" commit -qm baseline
printf '%s\n' 'clean.ts' > "$ART2/run-changed-source-files.txt"
OUT=$(cd "$REPO2" && ARTIFACTS_DIR="$ART2" RUNNER="$PRETTIER_BIN" bash "$SCRIPT" 2>&1)
RC=$?
DIRTY=$(git -C "$REPO2" status --porcelain)
if [ "$RC" -eq 0 ] && grep -qx 'FORMAT_STATUS=clean' <<< "$OUT" && [ -z "$DIRTY" ]; then
  pass "already formatted file stays clean with no diff"
else
  fail "already formatted file stays clean with no diff" "rc=$RC output=[$OUT] dirty=[$DIRTY]"
fi

# 3. Repo with no Prettier -> FORMAT_STATUS=skipped, exit 0.
REPO3="$TMP/noprettier"
ART3="$TMP/art3"
mkdir -p "$ART3"
init_repo "$REPO3"
printf '%s\n' '{' '  "name": "no-prettier"' '}' > "$REPO3/package.json"
printf 'export const value={a:1,b:2}\n' > "$REPO3/dirty.ts"
cp "$REPO3/dirty.ts" "$TMP/noprettier-before.ts"
git -C "$REPO3" add package.json dirty.ts
git -C "$REPO3" commit -qm baseline
printf '%s\n' 'dirty.ts' > "$ART3/run-changed-source-files.txt"
OUT=$(cd "$REPO3" && ARTIFACTS_DIR="$ART3" RUNNER="$PRETTIER_BIN" bash "$SCRIPT" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && grep -qx 'FORMAT_STATUS=skipped' <<< "$OUT" \
  && cmp -s "$TMP/noprettier-before.ts" "$REPO3/dirty.ts"; then
  pass "repo without prettier skips and leaves the file untouched"
else
  fail "repo without prettier skips and leaves the file untouched" "rc=$RC output=[$OUT]"
fi

# 4. A file not listed in the run scope stays untouched even if unformatted.
REPO4="$TMP/untouched"
ART4="$TMP/art4"
mkdir -p "$ART4"
init_repo "$REPO4"
write_prettier_pkg "$REPO4"
printf 'export const value = 1;\n' > "$REPO4/changed.ts"
printf 'export const other={c:3,d:4}\n' > "$REPO4/untouched.ts"
cp "$REPO4/untouched.ts" "$TMP/untouched-before.ts"
git -C "$REPO4" add package.json changed.ts untouched.ts
git -C "$REPO4" commit -qm baseline
printf '%s\n' 'changed.ts' > "$ART4/run-changed-source-files.txt"
OUT=$(cd "$REPO4" && ARTIFACTS_DIR="$ART4" RUNNER="$PRETTIER_BIN" bash "$SCRIPT" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$TMP/untouched-before.ts" "$REPO4/untouched.ts" \
  && ! "$PRETTIER_BIN" --check "$REPO4/untouched.ts" >/dev/null 2>&1; then
  pass "file outside the run scope stays unformatted"
else
  fail "file outside the run scope stays unformatted" "rc=$RC output=[$OUT]"
fi

# 5. A syntax error Prettier cannot rewrite -> FORMAT_STATUS=failed, exit 0.
REPO5="$TMP/unfixable"
ART5="$TMP/art5"
mkdir -p "$ART5"
init_repo "$REPO5"
write_prettier_pkg "$REPO5"
printf 'export const value = 1;\n' > "$REPO5/baseline.ts"
git -C "$REPO5" add package.json baseline.ts
git -C "$REPO5" commit -qm baseline
printf 'export const value = {\n' > "$REPO5/broken.ts"
git -C "$REPO5" add broken.ts
printf '%s\n' 'broken.ts' > "$ART5/run-changed-source-files.txt"
OUT=$(cd "$REPO5" && ARTIFACTS_DIR="$ART5" RUNNER="$PRETTIER_BIN" bash "$SCRIPT" 2>&1)
RC=$?
if [ "$RC" -eq 0 ] && grep -qx 'FORMAT_STATUS=failed' <<< "$OUT"; then
  pass "unfixable syntax error prints FORMAT_STATUS=failed and does not block"
else
  fail "unfixable syntax error prints FORMAT_STATUS=failed and does not block" "rc=$RC output=[$OUT]"
fi

# 6. Static parity: every feature-dev lane with ascii-autofix also has format-autofix.
ASCII_LIST="$TMP/ascii-lanes.txt"
FORMAT_LIST="$TMP/format-lanes.txt"
git -C "$ROOT" grep -l "id: ascii-autofix" -- .archon/workflows/defaults/bdc-feature-development*.yaml | sort > "$ASCII_LIST"
git -C "$ROOT" grep -l "id: format-autofix" -- .archon/workflows/defaults/bdc-feature-development*.yaml | sort > "$FORMAT_LIST"
ASCII_N=$(wc -l < "$ASCII_LIST" | tr -d ' ')
FORMAT_N=$(wc -l < "$FORMAT_LIST" | tr -d ' ')
REWIRE_N=$(git -C "$ROOT" grep -l "depends_on: \[format-autofix\]" -- .archon/workflows/defaults/bdc-feature-development*.yaml | wc -l | tr -d ' ')
RSG_REWIRE_N=0
for lane in "${LANES[@]}"; do
  if awk '
    $0 == "  - id: run-stop-greps" { grab=1; next }
    grab && $0 == "    depends_on: [format-autofix]" { found=1; exit }
    grab && $0 ~ /^  - id: / { exit }
    END { exit found ? 0 : 1 }
  ' "$DEFAULTS/$lane"; then
    RSG_REWIRE_N=$((RSG_REWIRE_N + 1))
  fi
done
if [ "$ASCII_N" = "12" ] && [ "$FORMAT_N" = "12" ] && cmp -s "$ASCII_LIST" "$FORMAT_LIST" \
  && [ "$REWIRE_N" = "12" ] && [ "$RSG_REWIRE_N" = "12" ]; then
  pass "12 lanes with ascii-autofix also have format-autofix; run-stop-tests and run-stop-greps both depend on it"
else
  fail "12 lanes with ascii-autofix also have format-autofix; run-stop-tests and run-stop-greps both depend on it" "ascii=$ASCII_N format=$FORMAT_N rewire=$REWIRE_N rsg=$RSG_REWIRE_N"
fi

echo ""
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
