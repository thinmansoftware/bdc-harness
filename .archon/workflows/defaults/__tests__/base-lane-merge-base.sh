#!/usr/bin/env bash
# base-lane-merge-base.sh -- unit tests for bmd_resolve_merge_base.
#
# The function is extracted from the canonical lane YAML by the BEGIN/END markers
# (same technique as run-stop-tests.sh) and exercised against throwaway file://
# repos. A parity check asserts the core is byte-identical across all 13 lanes.
#
# Run: bash .archon/workflows/defaults/__tests__/base-lane-merge-base.sh
# Exits 0 on 8/8, 1 on any failure. ASCII only.

set -uo pipefail

ROOT=$(git rev-parse --show-toplevel) || {
  echo "FATAL: not a git repo"
  exit 1
}
cd "$ROOT"

PASS=0
FAIL=0
LAST_RC=0
LAST_OUT=""
LAST_ERR=""

LANES="
bdc-feature-development.yaml
bdc-feature-development-astra.yaml
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-cursor.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-grok.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
"

CANONICAL="$ROOT/.archon/workflows/defaults/bdc-feature-development-cursor.yaml"
DEFAULTS="$ROOT/.archon/workflows/defaults"

extract_core() {
  tr -d '\r' < "$1" | awk '
    index($0, "# ---- BEGIN bmd core") { c = 1; next }
    index($0, "# ---- END bmd core") { c = 0 }
    c
  ' | sed 's/^      //'
}

CORE="$(extract_core "$CANONICAL")"
if [ -z "$CORE" ]; then
  echo "FATAL: could not extract bmd core from $CANONICAL"
  exit 1
fi
eval "$CORE" || {
  echo "FATAL: eval of bmd core failed"
  exit 1
}
if ! declare -F bmd_resolve_merge_base >/dev/null; then
  echo "FATAL: bmd_resolve_merge_base not defined after eval"
  exit 1
fi
export -f bmd_resolve_merge_base

REAL_GIT=$(command -v git)
export REAL_GIT
export GIT_TERMINAL_PROMPT=0

TMP=$(mktemp -d)
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

BIN="$TMP/bin"
mkdir -p "$BIN"
BMD_FETCH_LOG="$TMP/fetch.log"
export BMD_FETCH_LOG
BMD_FETCH_MODE=exec
export BMD_FETCH_MODE
: > "$BMD_FETCH_LOG"

cat > "$BIN/git" << 'EOF'
#!/bin/sh
if [ "$1" = "fetch" ]; then
  printf '%s\n' "$*" >> "$BMD_FETCH_LOG"
  if [ "$BMD_FETCH_MODE" = "fail" ]; then
    printf '%s\n' "bmd-test: fetch refused" >&2
    exit 1
  fi
fi
exec "$REAL_GIT" "$@"
EOF
chmod +x "$BIN/git"
export PATH="$BIN:$PATH"
hash -r

if [ "$REAL_GIT" = "$BIN/git" ]; then
  echo "FATAL: REAL_GIT points at the wrapper"
  exit 1
fi
"$BIN/git" --version >/dev/null || {
  echo "FATAL: git wrapper failed"
  exit 1
}

g() {
  "$REAL_GIT" -c user.email=bmd@example.com -c user.name=bmd "$@"
}

make_linear() {
  local origin="$1" branch="$2" count="$3"
  mkdir -p "$origin"
  g -C "$origin" init -b "$branch" >/dev/null
  g -C "$origin" commit --allow-empty -m "${branch}1" >/dev/null
  local tree parent i
  tree=$(g -C "$origin" rev-parse 'HEAD^{tree}')
  parent=$(g -C "$origin" rev-parse HEAD)
  i=2
  while [ "$i" -le "$count" ]; do
    parent=$(g -C "$origin" commit-tree "$tree" -p "$parent" -m "${branch}${i}")
    i=$((i + 1))
  done
  g -C "$origin" update-ref "refs/heads/${branch}" "$parent"
}

make_diverged_origin() {
  local origin="$1"
  make_linear "$origin" base 30
  local tree fork parent i
  tree=$(g -C "$origin" rev-parse 'HEAD^{tree}')
  fork=$(g -C "$origin" rev-parse 'base~10')
  parent=$fork
  i=1
  while [ "$i" -le 4 ]; do
    parent=$(g -C "$origin" commit-tree "$tree" -p "$parent" -m "r${i}")
    i=$((i + 1))
  done
  g -C "$origin" update-ref refs/heads/repair "$parent"
  parent=$(g -C "$origin" rev-parse base)
  i=1
  while [ "$i" -le 10 ]; do
    parent=$(g -C "$origin" commit-tree "$tree" -p "$parent" -m "bextra${i}")
    i=$((i + 1))
  done
  g -C "$origin" update-ref refs/heads/base "$parent"
}

make_orphan_origin() {
  local origin="$1" count="$2"
  make_linear "$origin" base "$count"
  g -C "$origin" checkout --orphan orphan >/dev/null 2>&1
  g -C "$origin" commit --allow-empty -m orphan >/dev/null
}

shallow_clone() {
  local origin="$1" branch="$2" dest="$3"
  g clone --depth=1 --branch "$branch" "file://${origin}" "$dest" >/dev/null 2>&1
  g -C "$dest" fetch --depth=1 origin "base:refs/remotes/origin/base" >/dev/null 2>&1
}

run_bmd() {
  local clone="$1" art="$2" errf
  errf="$TMP/bmd-err.txt"
  : > "$errf"
  mkdir -p "$art"
  LAST_OUT=$(
    cd "$clone" || exit 2
    export ARTIFACTS_DIR="$art"
    if [ "${BMD_USE_TIMEOUT:-}" = "1" ]; then
      timeout 60 bash -c 'set -euo pipefail; bmd_resolve_merge_base "refs/remotes/origin/base" HEAD' 2>"$errf"
    else
      bash -c 'set -euo pipefail; bmd_resolve_merge_base "refs/remotes/origin/base" HEAD' 2>"$errf"
    fi
  )
  LAST_RC=$?
  LAST_ERR=$(cat "$errf")
}

scenario() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n' "$name"
  fi
}

DIV_ORIGIN="$TMP/div-origin"
ORPHAN_ORIGIN="$TMP/orphan-origin"
make_diverged_origin "$DIV_ORIGIN"
make_orphan_origin "$ORPHAN_ORIGIN" 2300
ORACLE=$(g -C "$DIV_ORIGIN" merge-base base repair)

test_1() {
  local clone="$TMP/t1" art="$TMP/art1"
  unset BMD_DEEPEN_STEP BMD_DEEPEN_CAP BMD_USE_TIMEOUT
  export BMD_FETCH_MODE=exec
  shallow_clone "$DIV_ORIGIN" repair "$clone"
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 0 ]; then
    printf '  rc=%s stderr=%s\n' "$LAST_RC" "$LAST_ERR"
    return 1
  fi
  if [ "$LAST_OUT" != "$ORACLE" ]; then
    printf '  stdout=%s oracle=%s\n' "$LAST_OUT" "$ORACLE"
    return 1
  fi
  local got
  got=$(cat "$art/run-scope-merge-base.txt")
  if [ "$got" != "$ORACLE" ]; then
    printf '  artifact=%s oracle=%s\n' "$got" "$ORACLE"
    return 1
  fi
}

test_2() {
  local clone="$TMP/t2" art="$TMP/art2" shallow
  export BMD_DEEPEN_STEP=5 BMD_DEEPEN_CAP=1000 BMD_FETCH_MODE=exec
  unset BMD_USE_TIMEOUT
  : > "$BMD_FETCH_LOG"
  shallow_clone "$DIV_ORIGIN" repair "$clone"
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 0 ]; then
    printf '  rc=%s stderr=%s\n' "$LAST_RC" "$LAST_ERR"
    return 1
  fi
  if ! grep -q -- '--deepen' "$BMD_FETCH_LOG"; then
    printf '  fetch log missing --deepen: %s\n' "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
  if grep -q -- '--unshallow' "$BMD_FETCH_LOG"; then
    printf '  unexpected --unshallow: %s\n' "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
  shallow=$(g -C "$clone" rev-parse --is-shallow-repository)
  if [ "$shallow" != "true" ]; then
    printf '  clone is no longer shallow\n'
    return 1
  fi
}

test_3() {
  local clone="$TMP/t3" art="$TMP/art3"
  unset BMD_DEEPEN_STEP BMD_DEEPEN_CAP BMD_USE_TIMEOUT
  export BMD_FETCH_MODE=exec
  shallow_clone "$ORPHAN_ORIGIN" orphan "$clone"
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 1 ]; then
    printf '  rc=%s stdout=%s stderr=%s\n' "$LAST_RC" "$LAST_OUT" "$LAST_ERR"
    return 1
  fi
  case "$LAST_ERR" in
    *worktree_not_on_declared_base_lane*) ;;
    *) printf '  missing class: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *no_common_history*) ;;
    *) printf '  missing no_common_history: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *merge_base_fetch_failed*) printf '  fetch failure class: %s\n' "$LAST_ERR"; return 1 ;;
  esac
}

test_4() {
  local clone="$TMP/t4" art="$TMP/art4" dcount ucount
  export BMD_DEEPEN_STEP=2 BMD_DEEPEN_CAP=6 BMD_FETCH_MODE=exec BMD_USE_TIMEOUT=1
  : > "$BMD_FETCH_LOG"
  shallow_clone "$ORPHAN_ORIGIN" orphan "$clone"
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -eq 124 ]; then
    printf '  timed out\n'
    return 1
  fi
  if [ "$LAST_RC" -ne 1 ]; then
    printf '  rc=%s stderr=%s\n' "$LAST_RC" "$LAST_ERR"
    return 1
  fi
  case "$LAST_ERR" in
    *no_common_history*) ;;
    *) printf '  missing no_common_history: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  dcount=$(grep -c -- '--deepen' "$BMD_FETCH_LOG" || true)
  ucount=$(grep -c -- '--unshallow' "$BMD_FETCH_LOG" || true)
  if [ "$dcount" -gt 6 ]; then
    printf '  deepen count %s exceeds 6\n%s\n' "$dcount" "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
  if [ "$ucount" -ne 1 ]; then
    printf '  unshallow count %s\n%s\n' "$ucount" "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
}

test_5() {
  local clone="$TMP/t5" art="$TMP/art5" shallow
  unset BMD_DEEPEN_STEP BMD_DEEPEN_CAP BMD_USE_TIMEOUT
  export BMD_FETCH_MODE=fail
  : > "$BMD_FETCH_LOG"
  g clone "file://${DIV_ORIGIN}" "$clone" >/dev/null 2>&1
  g -C "$clone" checkout repair >/dev/null 2>&1
  shallow=$(g -C "$clone" rev-parse --is-shallow-repository)
  if [ "$shallow" != "false" ]; then
    printf '  expected a full clone\n'
    return 1
  fi
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 0 ]; then
    printf '  rc=%s stderr=%s\n' "$LAST_RC" "$LAST_ERR"
    return 1
  fi
  if [ "$LAST_OUT" != "$ORACLE" ]; then
    printf '  stdout=%s oracle=%s\n' "$LAST_OUT" "$ORACLE"
    return 1
  fi
  if [ -s "$BMD_FETCH_LOG" ]; then
    printf '  fetch was invoked: %s\n' "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
}

test_6() {
  local clone="$TMP/t6" art="$TMP/art6"
  unset BMD_DEEPEN_STEP BMD_DEEPEN_CAP BMD_USE_TIMEOUT
  export BMD_FETCH_MODE=exec
  shallow_clone "$DIV_ORIGIN" repair "$clone"
  g -C "$clone" remote set-url origin /no/such/bmd-origin
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 1 ]; then
    printf '  rc=%s stderr=%s\n' "$LAST_RC" "$LAST_ERR"
    return 1
  fi
  case "$LAST_ERR" in
    *merge_base_fetch_failed*) ;;
    *) printf '  missing merge_base_fetch_failed: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *no_common_history*) printf '  false no_common_history: %s\n' "$LAST_ERR"; return 1 ;;
  esac
}

test_8() {
  local clone="$TMP/t8" art="$TMP/art8" shallow dcount ucount small
  small="$TMP/small-origin"
  make_orphan_origin "$small" 5
  export BMD_DEEPEN_STEP=50 BMD_DEEPEN_CAP=1000 BMD_FETCH_MODE=exec
  unset BMD_USE_TIMEOUT
  : > "$BMD_FETCH_LOG"
  shallow_clone "$small" orphan "$clone"
  run_bmd "$clone" "$art"
  if [ "$LAST_RC" -ne 1 ]; then
    printf '  rc=%s stdout=%s stderr=%s\n' "$LAST_RC" "$LAST_OUT" "$LAST_ERR"
    return 1
  fi
  case "$LAST_ERR" in
    *worktree_not_on_declared_base_lane*) ;;
    *) printf '  missing class: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *no_common_history*) ;;
    *) printf '  missing no_common_history: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *merge_base_fetch_failed*) printf '  fetch failure class: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  case "$LAST_ERR" in
    *shallow=false*) ;;
    *) printf '  expected completed-repo marker: %s\n' "$LAST_ERR"; return 1 ;;
  esac
  dcount=$(grep -c -- '--deepen' "$BMD_FETCH_LOG" || true)
  ucount=$(grep -c -- '--unshallow' "$BMD_FETCH_LOG" || true)
  if [ "$dcount" -lt 1 ] || [ "$dcount" -gt 2 ]; then
    printf '  deepen count %s (expected one round)\n%s\n' "$dcount" "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
  if [ "$ucount" -ne 0 ]; then
    printf '  unshallow ran after the repo completed: %s\n' "$(cat "$BMD_FETCH_LOG")"
    return 1
  fi
  shallow=$(g -C "$clone" rev-parse --is-shallow-repository)
  if [ "$shallow" != "false" ]; then
    printf '  clone still shallow after deepen\n'
    return 1
  fi
}

test_7() {
  local begin=0 lane hashes old any calls echoes
  local lane_path
  for lane in $LANES; do
    lane_path="$DEFAULTS/$lane"
    if [ ! -f "$lane_path" ]; then
      printf '  missing %s\n' "$lane"
      return 1
    fi
    if grep -q 'BEGIN bmd core' "$lane_path"; then
      begin=$((begin + 1))
    fi
    old=$(grep -F -c 'if ! git merge-base "refs/remotes/origin/${BASE_BRANCH}" HEAD' "$lane_path" || true)
    any=$(grep -F -c 'if ! git merge-base' "$lane_path" || true)
    calls=$(grep -F -c 'BMD_SHA=$(bmd_resolve_merge_base "refs/remotes/origin/${BASE_BRANCH}" HEAD)' "$lane_path" || true)
    echoes=$(grep -F -c 'echo "RUN_SCOPE_MERGE_BASE=$BMD_SHA"' "$lane_path" || true)
    if [ "$old" -ne 0 ] || [ "$any" -ne 0 ] || [ "$calls" -ne 1 ] || [ "$echoes" -ne 1 ]; then
      printf '  %s old=%s any=%s calls=%s echoes=%s\n' "$lane" "$old" "$any" "$calls" "$echoes"
      return 1
    fi
    if [ "$(extract_core "$lane_path")" != "$CORE" ]; then
      printf '  core differs in %s\n' "$lane"
      return 1
    fi
  done
  if [ "$begin" -ne 13 ]; then
    printf '  BEGIN count %s\n' "$begin"
    return 1
  fi
  hashes=$(
    for f in "$DEFAULTS"/bdc-feature-development*.yaml; do
      sed -n '/BEGIN bmd core/,/END bmd core/p' "$f" | sha256sum
    done | sort -u | wc -l
  )
  hashes=$(printf '%s' "$hashes" | tr -d '[:space:]')
  if [ "$hashes" -ne 1 ]; then
    printf '  unique core hashes %s\n' "$hashes"
    return 1
  fi
  if printf '%s\n' "$CORE" | grep -q 'BASE_BRANCH'; then
    printf '  core references BASE_BRANCH\n'
    return 1
  fi
  if printf '%s\n' "$CORE" | grep -q 'if ! git merge-base'; then
    printf '  core still has the old merge-base test\n'
    return 1
  fi
  if ! (cd "$ROOT" && bun run check:bundled); then
    printf '  check:bundled failed\n'
    return 1
  fi
}

scenario "1 diverged shallow clone resolves the full-history merge-base" test_1
scenario "2 deepen stays incremental and the clone stays shallow" test_2
scenario "3 unrelated history fails with no_common_history" test_3
scenario "4 deepen is bounded and unshallow runs once" test_4
scenario "5 resolvable merge-base does not fetch" test_5
scenario "6 fetch failure is its own class" test_6
scenario "7 every lane carries the same core" test_7
scenario "8 deepen that completes unrelated history reports no_common_history" test_8

printf '%s passing / 8 total\n' "$PASS"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
