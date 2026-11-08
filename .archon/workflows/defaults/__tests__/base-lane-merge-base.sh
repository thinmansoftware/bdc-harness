#!/usr/bin/env bash
# Unit tests for the capture-run-scope base-lane merge-base deepening core.

set -uo pipefail

PASS=0
FAIL=0
REAL_GIT=$(command -v git)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEFAULTS_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
CANONICAL_YAML="$DEFAULTS_DIR/bdc-feature-development.yaml"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

extract_core() {
  sed -n '/# ---- BEGIN bmd core/,/# ---- END bmd core/p' "$1" | sed '1d;$d;s/^      //'
}

BMD_CORE=$(extract_core "$CANONICAL_YAML")
[ -n "$BMD_CORE" ] || { echo "FATAL: bmd core not found"; exit 1; }
eval "$BMD_CORE"

configure_repo() {
  "$REAL_GIT" config user.email test@example.com
  "$REAL_GIT" config user.name "BDC Test"
}

commit_n() {
  local prefix="$1" count="$2" i
  i=1
  while [ "$i" -le "$count" ]; do
    printf '%s %s\n' "$prefix" "$i" >> history.txt
    "$REAL_GIT" add history.txt
    "$REAL_GIT" commit -q -m "$prefix $i"
    i=$((i + 1))
  done
}

make_related_origin() {
  local root="$1"
  mkdir -p "$root/seed"
  (cd "$root/seed" && "$REAL_GIT" init -q -b base && configure_repo && commit_n base 20 &&
    "$REAL_GIT" branch repair && commit_n base 10 && "$REAL_GIT" checkout -q repair && commit_n repair 4 &&
    "$REAL_GIT" clone -q --bare . "$root/origin.git")
}

make_unrelated_origin() {
  local root="$1"
  mkdir -p "$root/seed"
  (cd "$root/seed" && "$REAL_GIT" init -q -b base && configure_repo && commit_n base 30 &&
    "$REAL_GIT" checkout -q --orphan repair && rm -f history.txt && commit_n orphan 30 &&
    "$REAL_GIT" clone -q --bare . "$root/origin.git")
}

shallow_repair_clone() {
  local root="$1"
  "$REAL_GIT" clone -q --depth=1 --branch repair "file://$root/origin.git" "$root/clone"
  (cd "$root/clone" && "$REAL_GIT" fetch -q --depth=1 origin base:refs/remotes/origin/base)
}

run_capture() {
  local artifacts="$1" sha
  sha=$(bmd_resolve_merge_base refs/remotes/origin/base HEAD) || return 1
  mkdir -p "$artifacts"
  printf '%s\n' "$sha" > "$artifacts/run-scope-merge-base.txt"
  printf '%s\n' "$sha"
}

echo "--- Test 1: diverged shallow history resolves and writes artifact ---"
R1="$TMP_ROOT/t1"; make_related_origin "$R1"; shallow_repair_clone "$R1"
EXPECTED=$("$REAL_GIT" -C "$R1/seed" merge-base base repair)
ACTUAL=$(cd "$R1/clone" && run_capture "$R1/artifacts")
if [ "$ACTUAL" = "$EXPECTED" ] && [ "$(cat "$R1/artifacts/run-scope-merge-base.txt")" = "$EXPECTED" ]; then pass "diverged merge-base and artifact"; else fail "diverged merge-base and artifact"; fi

echo "--- Test 2: incremental deepen avoids unshallow ---"
R2="$TMP_ROOT/t2"; make_related_origin "$R2"; shallow_repair_clone "$R2"; FETCH_LOG="$R2/fetch.log"
git() { [ "${1:-}" = fetch ] && printf '%s\n' "$*" >> "$FETCH_LOG"; "$REAL_GIT" "$@"; }
export FETCH_LOG REAL_GIT
OUT=$(cd "$R2/clone" && BMD_DEEPEN_STEP=5 BMD_DEEPEN_CAP=1000 bmd_resolve_merge_base refs/remotes/origin/base HEAD)
if [ "$OUT" = "$("$REAL_GIT" -C "$R2/seed" merge-base base repair)" ] && ! grep -q -- --unshallow "$FETCH_LOG" && [ "$("$REAL_GIT" -C "$R2/clone" rev-parse --is-shallow-repository)" = true ]; then pass "incremental deepen only"; else fail "incremental deepen only"; fi
unset -f git

echo "--- Test 3: unrelated history reports no_common_history ---"
R3="$TMP_ROOT/t3"; make_unrelated_origin "$R3"; shallow_repair_clone "$R3"
ERR=$(cd "$R3/clone" && BMD_DEEPEN_STEP=5 BMD_DEEPEN_CAP=10 bmd_resolve_merge_base refs/remotes/origin/base HEAD 2>&1 >/dev/null); STATUS=$?
if [ "$STATUS" -ne 0 ] && printf '%s' "$ERR" | grep -q no_common_history && ! printf '%s' "$ERR" | grep -q merge_base_fetch_failed; then pass "unrelated history classification"; else fail "unrelated history classification"; fi

echo "--- Test 4: deepening is bounded ---"
R4="$TMP_ROOT/t4"; make_unrelated_origin "$R4"; shallow_repair_clone "$R4"; FETCH_LOG="$R4/fetch.log"
git() { [ "${1:-}" = fetch ] && printf '%s\n' "$*" >> "$FETCH_LOG"; "$REAL_GIT" "$@"; }
ERR=$(cd "$R4/clone" && timeout 60 env BMD_DEEPEN_STEP=2 BMD_DEEPEN_CAP=6 bash -c "$(declare -f git); $(declare -f bmd_resolve_merge_base); bmd_resolve_merge_base refs/remotes/origin/base HEAD" 2>&1 >/dev/null); STATUS=$?
DEEPENS=$(grep -c -- --deepen "$FETCH_LOG" || true); UNSHALLOWS=$(grep -c -- --unshallow "$FETCH_LOG" || true)
if [ "$STATUS" -ne 0 ] && [ "$DEEPENS" -le 6 ] && [ "$UNSHALLOWS" -eq 1 ] && printf '%s' "$ERR" | grep -q no_common_history; then pass "bounded deepen and single unshallow"; else fail "bounded deepen and single unshallow"; fi
unset -f git

echo "--- Test 5: resolvable full history performs no fetch ---"
R5="$TMP_ROOT/t5"; make_related_origin "$R5"; "$REAL_GIT" clone -q --branch repair "file://$R5/origin.git" "$R5/clone"; "$REAL_GIT" -C "$R5/clone" fetch -q origin base:refs/remotes/origin/base
git() { [ "${1:-}" != fetch ] || return 97; "$REAL_GIT" "$@"; }
OUT=$(cd "$R5/clone" && bmd_resolve_merge_base refs/remotes/origin/base HEAD); STATUS=$?
if [ "$STATUS" -eq 0 ] && [ "$OUT" = "$("$REAL_GIT" -C "$R5/seed" merge-base base repair)" ]; then pass "full history makes no fetch"; else fail "full history makes no fetch"; fi
unset -f git

echo "--- Test 6: fetch failure has distinct classification ---"
R6="$TMP_ROOT/t6"; make_related_origin "$R6"; shallow_repair_clone "$R6"; "$REAL_GIT" -C "$R6/clone" remote set-url origin "$R6/missing.git"
ERR=$(cd "$R6/clone" && bmd_resolve_merge_base refs/remotes/origin/base HEAD 2>&1 >/dev/null); STATUS=$?
if [ "$STATUS" -ne 0 ] && printf '%s' "$ERR" | grep -q merge_base_fetch_failed && ! printf '%s' "$ERR" | grep -q no_common_history; then pass "fetch failure classification"; else fail "fetch failure classification"; fi

echo "--- Test 7: lane parity and generated defaults ---"
LANES=(bdc-feature-development.yaml bdc-feature-development-astra.yaml bdc-feature-development-codex-only.yaml bdc-feature-development-codex.yaml bdc-feature-development-cursor.yaml bdc-feature-development-fable.yaml bdc-feature-development-fusion-cx-kimi.yaml bdc-feature-development-fusion-cx-qwen.yaml bdc-feature-development-grok.yaml bdc-feature-development-kimi-k3.yaml bdc-feature-development-zero-claude.yaml bdc-feature-development-zero-open.yaml bdc-feature-development-zero.yaml)
HASHES=""; MARKERS=0; OLD=0
for lane in "${LANES[@]}"; do
  file="$DEFAULTS_DIR/$lane"
  grep -q 'BEGIN bmd core' "$file" && MARKERS=$((MARKERS + 1))
  HASHES="$HASHES$(sed -n '/BEGIN bmd core/,/END bmd core/p' "$file" | sha256sum | cut -d' ' -f1)\n"
  grep -q 'if ! git merge-base "refs/remotes/origin/${BASE_BRANCH}" HEAD' "$file" && OLD=$((OLD + 1))
done
UNIQUE=$(printf '%b' "$HASHES" | sed '/^$/d' | sort -u | wc -l)
if [ "$MARKERS" -eq 13 ] && [ "$UNIQUE" -eq 1 ] && [ "$OLD" -eq 0 ] && (cd "$DEFAULTS_DIR/../../.." && bun run check:bundled >/dev/null); then pass "13 lane cores and bundle parity"; else fail "13 lane cores and bundle parity"; fi

echo ""
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
