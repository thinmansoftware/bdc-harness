#!/usr/bin/env bash
# Single-pass ascii-gate: timing, hunk location, debt, untracked, idempotency.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
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

lane_mode() {
  local gate="$1"
  if grep -q 'run-changed-source-files.txt' "$gate"; then
    printf '%s\n' artifact
  elif grep -q 'run-start-sha.txt' "$gate"; then
    printf '%s\n' startsha
  else
    printf '%s\n' basebranch
  fi
}

prepare_inputs() {
  local mode="$1" repo="$2" art="$3" scope_file="$4"
  mkdir -p "$art"
  case "$mode" in
    artifact)
      cp "$scope_file" "$art/run-changed-source-files.txt"
      git -C "$repo" rev-parse HEAD > "$art/run-scope-sha.txt"
      ;;
    startsha)
      git -C "$repo" rev-parse HEAD > "$art/run-start-sha.txt"
      ;;
    basebranch)
      ;;
  esac
}

run_gate() {
  local mode="$1" repo="$2" art="$3" gate="$4"
  case "$mode" in
    artifact)
      (cd "$repo" && ARTIFACTS_DIR="$art" bash "$gate" 2>&1)
      ;;
    startsha)
      (cd "$repo" && ARTIFACTS_DIR="$art" BASE_BRANCH=main bash "$gate" 2>&1)
      ;;
    basebranch)
      (cd "$repo" && BASE_BRANCH=main bash "$gate" 2>&1)
      ;;
  esac
}

snapshot() {
  local repo="$1" art="$2"
  {
    git -C "$repo" status --porcelain | LC_ALL=C sort
    echo '---ART---'
    if [ -d "$art" ]; then
      (cd "$art" && find . -type f -print | LC_ALL=C sort)
    fi
  }
}

init_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
}

write_scope_151() {
  local scope="$1"
  local i
  : > "$scope"
  for i in $(seq 1 150); do
    printf 'src/f%03d.ts\n' "$i" >> "$scope"
  done
  printf 'src/big.ts\n' >> "$scope"
}

setup_large() {
  local repo="$1" emdash="$2"
  local i n name
  init_repo "$repo"
  mkdir -p "$repo/src"
  for i in $(seq 1 150); do
    printf 'base\n' > "$repo/src/f$(printf '%03d' "$i").ts"
  done
  printf 'base\n' > "$repo/src/big.ts"
  git -C "$repo" add src
  git -C "$repo" commit -qm baseline
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  for i in $(seq 1 150); do
    name="$repo/src/f$(printf '%03d' "$i").ts"
    {
      printf 'base\n'
      for n in $(seq 1 15); do
        if [ "$emdash" = "1" ] && [ "$i" -eq 75 ] && [ "$n" -eq 3 ]; then
          printf 'added \342\200\224 line\n'
        else
          printf 'added line %s\n' "$n"
        fi
      done
    } > "$name"
  done
  dd if=/dev/zero bs=300000 count=1 status=none | tr '\0' 'B' > "$repo/src/big.ts"
  printf '\n' >> "$repo/src/big.ts"
}

setup_debt() {
  local repo="$1"
  init_repo "$repo"
  mkdir -p "$repo/src"
  printf 'const start = 1;\n// legacy \342\200\224 debt\n' > "$repo/src/legacy.ts"
  git -C "$repo" add src/legacy.ts
  git -C "$repo" commit -qm 'legacy non-ascii before run'
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  printf 'const start = 1;\n// legacy \342\200\224 debt\nconst added = 2;\n' > "$repo/src/legacy.ts"
}

setup_untracked() {
  local repo="$1"
  init_repo "$repo"
  mkdir -p "$repo/src"
  printf 'const ok = 1;\n' > "$repo/src/ok.ts"
  git -C "$repo" add src/ok.ts
  git -C "$repo" commit -qm baseline
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  printf 'export const arrow = "\342\206\222";\n' > "$repo/src/new.ts"
}

failed_files() {
  awk '
    /ASCII GATE FAILED/ { p=1; next }
    /offending lines/ { exit }
    p && $0 !~ /^$/ { print }
  '
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mapfile -t LANES < <(git -C "$ROOT" grep -l -- '- id: ascii-gate' -- '.archon/workflows/defaults/*.yaml' | LC_ALL=C sort)
if [ "${#LANES[@]}" -eq 0 ]; then
  echo "FAIL: no ascii-gate lanes found"
  echo "RESULT: 0 passed, 1 failed"
  exit 1
fi

LARGE="$TMP/large-repo"
LARGE_ART_BASE="$TMP/large-art"
LARGE_SCOPE="$TMP/scope-151.txt"
setup_large "$LARGE" 0
write_scope_151 "$LARGE_SCOPE"

FAILREPO="$TMP/fail-repo"
FAIL_SCOPE="$TMP/scope-151-fail.txt"
setup_large "$FAILREPO" 1
write_scope_151 "$FAIL_SCOPE"

DEBT="$TMP/debt-repo"
DEBT_SCOPE="$TMP/scope-debt.txt"
setup_debt "$DEBT"
printf 'src/legacy.ts\n' > "$DEBT_SCOPE"

NEWREPO="$TMP/new-repo"
NEW_SCOPE="$TMP/scope-new.txt"
setup_untracked "$NEWREPO"
printf 'src/new.ts\n' > "$NEW_SCOPE"

for lane in "${LANES[@]}"; do
  name=$(basename "$lane")
  gate="$TMP/${name}.ascii-gate.sh"
  extract_node_script "$ROOT/$lane" ascii-gate > "$gate"
  mode=$(lane_mode "$gate")

  art="$LARGE_ART_BASE/$name"
  rm -rf "$art"
  prepare_inputs "$mode" "$LARGE" "$art" "$LARGE_SCOPE"
  start=$(date +%s%N)
  OUT=$(run_gate "$mode" "$LARGE" "$art" "$gate")
  RC=$?
  end=$(date +%s%N)
  ELAPSED=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.3f", (e - s) / 1000000000 }')
  SLOW=$(awk -v s="$start" -v e="$end" 'BEGIN { print ((e - s) >= 20000000000) ? 1 : 0 }')
  if [ "$RC" -eq 0 ] && grep -q 'ascii-gate PASS (scanned 151' <<< "$OUT" && [ "$SLOW" -eq 0 ]; then
    pass "$name large-diff-finishes-fast (${ELAPSED}s, $mode)"
  else
    fail "$name large-diff-finishes-fast" "rc=$RC elapsed=${ELAPSED}s output=[$OUT]"
  fi

  art="$TMP/fail-art/$name"
  rm -rf "$art"
  prepare_inputs "$mode" "$FAILREPO" "$art" "$FAIL_SCOPE"
  OUT=$(run_gate "$mode" "$FAILREPO" "$art" "$gate")
  RC=$?
  FILES=$(printf '%s\n' "$OUT" | failed_files)
  if [ "$RC" -ne 0 ] && [ "$FILES" = "src/f075.ts" ] && grep -q 'src/f075.ts:4:' <<< "$OUT"; then
    pass "$name added-non-ascii-line-fails-with-location"
  else
    fail "$name added-non-ascii-line-fails-with-location" "rc=$RC files=[$FILES] output=[$OUT]"
  fi

  art="$TMP/debt-art/$name"
  rm -rf "$art"
  prepare_inputs "$mode" "$DEBT" "$art" "$DEBT_SCOPE"
  OUT=$(run_gate "$mode" "$DEBT" "$art" "$gate")
  RC=$?
  if [ "$RC" -eq 0 ] && grep -q 'ascii-gate PASS' <<< "$OUT"; then
    pass "$name pre-existing-debt-passes"
  else
    fail "$name pre-existing-debt-passes" "rc=$RC output=[$OUT]"
  fi

  art="$TMP/new-art/$name"
  rm -rf "$art"
  prepare_inputs "$mode" "$NEWREPO" "$art" "$NEW_SCOPE"
  OUT=$(run_gate "$mode" "$NEWREPO" "$art" "$gate")
  RC=$?
  if [ "$RC" -ne 0 ] && grep -q 'ASCII GATE FAILED' <<< "$OUT" && grep -q 'src/new.ts' <<< "$OUT"; then
    pass "$name untracked-file-judged-whole"
  else
    fail "$name untracked-file-judged-whole" "rc=$RC output=[$OUT]"
  fi

  art="$TMP/idem-art/$name"
  rm -rf "$art"
  prepare_inputs "$mode" "$LARGE" "$art" "$LARGE_SCOPE"
  BEFORE=$(snapshot "$LARGE" "$art")
  OUT1=$(run_gate "$mode" "$LARGE" "$art" "$gate")
  RC1=$?
  MID=$(snapshot "$LARGE" "$art")
  OUT2=$(run_gate "$mode" "$LARGE" "$art" "$gate")
  RC2=$?
  AFTER=$(snapshot "$LARGE" "$art")
  if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$OUT1" = "$OUT2" ] && [ "$BEFORE" = "$MID" ] && [ "$BEFORE" = "$AFTER" ]; then
    pass "$name idempotent"
  else
    fail "$name idempotent" "rc1=$RC1 rc2=$RC2 stdout_match=$([ "$OUT1" = "$OUT2" ] && echo yes || echo no) snap_match=$([ "$BEFORE" = "$MID" ] && [ "$BEFORE" = "$AFTER" ] && echo yes || echo no)"
  fi
done

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
