#!/usr/bin/env bash
# install-worktree-deps.sh -- unit tests for the install-worktree-deps node core
# (wdi_*) in .archon/workflows/defaults/bdc-feature-development.yaml and its
# byte-identical mirrors in the other bdc-feature-development lanes.
#
# Run: bash .archon/workflows/defaults/__tests__/install-worktree-deps.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

FAIL=0
PASS=0
TMPS=()

cleanup() {
  local d
  for d in "${TMPS[@]}"; do rm -rf "$d"; done
}
trap cleanup EXIT

newtmp() {
  local d
  d="$(mktemp -d)"
  TMPS+=("$d")
  printf '%s' "$d"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected: [$expected]"; echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle:   $needle"; echo "  haystack: $haystack"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected: $needle"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development.yaml"

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

keyline() {
  local key="$1" text="$2"
  printf '%s\n' "$text" | grep -E "^${key}=" | head -1
}

porcelain() {
  git status --porcelain=v1 --untracked-files=all | LC_ALL=C sort
}

git_identity() {
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t
  export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
}

init_repo() {
  local dir="$1"
  git_identity
  git -C "$dir" init -q
  git -C "$dir" add -A
  git -C "$dir" commit -qm init
}

if ! command -v node >/dev/null 2>&1 && [ -x /usr/local/bun-node-fallback-bin/node ]; then
  PATH="/usr/local/bun-node-fallback-bin:$PATH"
fi
ORIG_PATH="$PATH"
CALL_LOG=""
ENV_DUMP=""

reset_wdi_env() {
  unset WDI_TIMEOUT_SECS WDI_BUDGET_SECS WDI_MIN_FREE_KB WDI_BUN_CACHE || true
  export PATH="$ORIG_PATH"
}

make_stub_bin() {
  local bin
  bin="$(newtmp)"
  printf '%s' "$bin"
}

arm_stub_logs() {
  local bin="$1"
  CALL_LOG="$bin/calls.log"
  ENV_DUMP="$bin/env.dump"
  : > "$CALL_LOG"
  : > "$ENV_DUMP"
}

write_stub() {
  local bin="$1" name="$2" body="$3"
  cat > "$bin/$name" << EOF
#!/usr/bin/env bash
printf '%s %s\n' "\$(pwd)" "\$*" >> "$CALL_LOG"
env > "$ENV_DUMP"
$body
EOF
  chmod +x "$bin/$name"
}

minimal_path() {
  local dest="$1" cmd src
  mkdir -p "$dest"
  for cmd in bash sh git sha256sum df awk sed grep cat mkdir rm cp mv chmod \
    date stat cmp tr head tail find sort env sleep timeout dirname basename \
    comm uname ls touch bun node; do
    src="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$src" ] && ln -sfn "$src" "$dest/$cmd"
  done
}

write_npm_repo() {
  local root="$1"
  mkdir -p "$root/api"
  printf '%s\n' '{"name":"root","private":true}' > "$root/package.json"
  printf '%s\n' '{"name":"api","private":true}' > "$root/api/package.json"
  printf '%s\n' '{"name":"api","lockfileVersion":3}' > "$root/api/package-lock.json"
  printf '%s\n' 'node_modules' > "$root/.gitignore"
  printf '%s\n' 'const m = require("fixture-dep"); if (m.ok !== 1) process.exit(1);' > "$root/api/t.js"
  init_repo "$root"
}

write_bun_fixture_files() {
  local root="$1"
  mkdir -p "$root/vendor/fixture-dep"
  printf '%s\n' '{"name":"wdi-fixture","private":true,"dependencies":{"fixture-dep":"file:./vendor/fixture-dep"}}' > "$root/package.json"
  printf '%s\n' '{"name":"fixture-dep","version":"1.0.0","type":"module","main":"index.js"}' > "$root/vendor/fixture-dep/package.json"
  printf '%s\n' 'export const value = 1;' > "$root/vendor/fixture-dep/index.js"
  printf '%s\n' 'import { test, expect } from "bun:test";
import { value } from "fixture-dep";
test("loads", () => { expect(value).toBe(1); });' > "$root/t.test.ts"
  printf '%s\n' 'node_modules' > "$root/.gitignore"
}

commit_bun_lock() {
  local root="$1"
  ( cd "$root" && bun install >/dev/null )
  rm -rf "$root/node_modules"
  init_repo "$root"
}

WDI_CORE="$(extract_core "$CANONICAL_YAML" wdi)"
if [ -z "$WDI_CORE" ]; then echo "FATAL: could not extract wdi core"; exit 1; fi
eval "$WDI_CORE"
for fn in wdi_class wdi_candidate_dirs wdi_pick_manager wdi_install_dir wdi_scrub_env wdi_main; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined"; exit 1; fi
done

echo "--- Test 1: bun repo installs and a targeted test loads ---"
reset_wdi_env
T1="$(newtmp)"
ART1="$(newtmp)"
export ARTIFACTS_DIR="$ART1"
write_bun_fixture_files "$T1/repo"
commit_bun_lock "$T1/repo"
BEFORE_OUT="$(cd "$T1/repo" && bun test t.test.ts >"$T1/before.log" 2>&1; echo $?)"
assert_eq "Test 1 before: nonzero" "1" "$([ "$BEFORE_OUT" -ne 0 ] && echo 1 || echo 0)"
assert_contains "Test 1 before: Cannot find" "Cannot find" "$(cat "$T1/before.log")"
POR1="$(cd "$T1/repo" && porcelain)"
OUT1="$(cd "$T1/repo" && wdi_main </dev/null)"
assert_eq "Test 1 wdi exit marker present" "0" "0"
assert_contains "Test 1 DEPS_STATUS=installed" "DEPS_STATUS=installed" "$OUT1"
assert_contains "Test 1 DEPS_DIRS .:installed" ".:installed" "$OUT1"
assert_contains "Test 1 DEPS_CACHE_DIR=default" "DEPS_CACHE_DIR=default" "$OUT1"
[ -f "$T1/repo/node_modules/.archon-wdi-stamp" ] && echo "PASS: Test 1 stamp exists" && PASS=$((PASS+1)) || { echo "FAIL: Test 1 stamp exists"; FAIL=$((FAIL+1)); }
AFTER_RC="$(cd "$T1/repo" && bun test t.test.ts >"$T1/after.log" 2>&1; echo $?)"
assert_eq "Test 1 after: exit 0" "0" "$AFTER_RC"
assert_contains "Test 1 after: 1 pass" "1 pass" "$(cat "$T1/after.log")"
POR1B="$(cd "$T1/repo" && porcelain)"
assert_eq "Test 1 porcelain unchanged" "$POR1" "$POR1B"
mkdir -p "$T1/ws/worktrees/archon"
cp -a "$T1/repo" "$T1/ws/worktrees/archon/task-x"
WT="$(cd "$T1/ws/worktrees/archon/task-x" && pwd -P)"
EXPECT_CACHE="${WT%%/worktrees/*}/.deps-cache/bun"
OUT1B="$(cd "$T1/ws/worktrees/archon/task-x" && wdi_main </dev/null)"
assert_contains "Test 1 worktree cache dir" "DEPS_CACHE_DIR=$EXPECT_CACHE" "$OUT1B"
assert_contains "Test 1 worktree same fs" "DEPS_CACHE_SAME_FS=true" "$OUT1B"

echo "--- Test 2: npm depth-1, scrubbed, depth-1 gitignore ---"
reset_wdi_env
T2="$(newtmp)"
ART2="$(newtmp)"
export ARTIFACTS_DIR="$ART2"
write_npm_repo "$T2/repo"
BIN2="$(make_stub_bin)"
arm_stub_logs "$BIN2"
LOG2="$CALL_LOG"
write_stub "$BIN2" npm 'mkdir -p node_modules/fixture-dep; printf "%s\n" "module.exports = { ok: 1 };" > node_modules/fixture-dep/index.js'
export PATH="$BIN2:$ORIG_PATH"
export GH_TOKEN=x ARCHON_OPERATOR_TOKEN=y
IGN_RC=0
( cd "$T2/repo" && git check-ignore -q api/node_modules ) || IGN_RC=$?
assert_eq "Test 2 depth-1 check-ignore" "0" "$IGN_RC"
assert_eq "Test 2 root gitignore is one node_modules line" "node_modules" "$(cd "$T2/repo" && cat .gitignore)"
POR2="$(cd "$T2/repo" && porcelain)"
OUT2="$(cd "$T2/repo" && wdi_main </dev/null)"
assert_contains "Test 2 root skipped_no_lockfile" ".:skipped_no_lockfile" "$OUT2"
assert_contains "Test 2 api installed" "api:installed" "$OUT2"
assert_eq "Test 2 stub called once" "1" "$(grep -c . "$LOG2" || true)"
assert_eq "Test 2 stub argv" "ci --no-audit --no-fund" "$(awk '{print substr($0, index($0, " ")+1)}' "$LOG2")"
CALL_CWD="$(awk '{print $1}' "$LOG2")"
case "$CALL_CWD" in
  */api) PASS=$((PASS+1)); echo "PASS: Test 2 stub cwd ends in /api" ;;
  *) FAIL=$((FAIL+1)); echo "FAIL: Test 2 stub cwd ends in /api" ;;
esac
POR2B="$(cd "$T2/repo" && porcelain)"
assert_eq "Test 2 porcelain unchanged" "$POR2" "$POR2B"
NODE_RC="$(cd "$T2/repo/api" && node t.js >/dev/null 2>&1; echo $?)"
assert_eq "Test 2 node t.js" "0" "$NODE_RC"
assert_not_contains "Test 2 env has no GH_TOKEN" "GH_TOKEN=" "$(cat "$ENV_DUMP")"
assert_not_contains "Test 2 env has no ARCHON_OPERATOR_TOKEN" "ARCHON_OPERATOR_TOKEN=" "$(cat "$ENV_DUMP")"
assert_eq "Test 2 parent still has GH_TOKEN" "x" "${GH_TOKEN:-}"
unset GH_TOKEN ARCHON_OPERATOR_TOKEN

echo "--- Test 3: no package.json ---"
reset_wdi_env
T3="$(newtmp)"
ART3="$(newtmp)"
export ARTIFACTS_DIR="$ART3"
mkdir -p "$T3/repo"
printf '%s\n' 'readme' > "$T3/repo/README.md"
printf '%s\n' 'print(1)' > "$T3/repo/main.py"
init_repo "$T3/repo"
BIN3="$(make_stub_bin)"
arm_stub_logs "$BIN3"
write_stub "$BIN3" bun 'exit 0'
write_stub "$BIN3" npm 'exit 0'
export PATH="$BIN3:$ORIG_PATH"
POR3="$(cd "$T3/repo" && porcelain)"
OUT3="$(cd "$T3/repo" && wdi_main </dev/null)"
assert_contains "Test 3 DEPS_STATUS=skipped" "DEPS_STATUS=skipped" "$OUT3"
assert_contains "Test 3 DEPS_DIRS" ".:skipped_no_package_json" "$OUT3"
assert_eq "Test 3 stubs not called" "0" "$(grep -c . "$CALL_LOG" || true)"
POR3B="$(cd "$T3/repo" && porcelain)"
assert_eq "Test 3 porcelain unchanged" "$POR3" "$POR3B"

echo "--- Test 4: tool absent ---"
reset_wdi_env
T4="$(newtmp)"
ART4="$(newtmp)"
export ARTIFACTS_DIR="$ART4"
mkdir -p "$T4/repo"
write_npm_repo "$T4/repo"
MIN4="$(newtmp)"
minimal_path "$MIN4"
rm -f "$MIN4/npm" "$MIN4/npx" "$MIN4/yarn" "$MIN4/pnpm"
export PATH="$MIN4"
OUT4="$(cd "$T4/repo" && wdi_main </dev/null)"
assert_contains "Test 4 api skipped_no_tool" "api:skipped_no_tool" "$OUT4"
assert_contains "Test 4 DEPS_STATUS=skipped" "DEPS_STATUS=skipped" "$OUT4"

echo "--- Test 5: second run is cached ---"
reset_wdi_env
export PATH="$BIN2:$ORIG_PATH"
export ARTIFACTS_DIR="$ART2"
OUT5="$(cd "$T2/repo" && wdi_main </dev/null)"
assert_contains "Test 5 api cached" "api:cached" "$OUT5"
assert_eq "Test 5 stub still once" "1" "$(grep -c . "$LOG2" || true)"
assert_eq "Test 5 class stable" "$(keyline DEPS_CLASS "$OUT2")" "$(keyline DEPS_CLASS "$OUT5")"
assert_eq "Test 5 cache dir stable" "$(keyline DEPS_CACHE_DIR "$OUT2")" "$(keyline DEPS_CACHE_DIR "$OUT5")"
assert_eq "Test 5 log stable" "$(keyline DEPS_LOG "$OUT2")" "$(keyline DEPS_LOG "$OUT5")"

echo "--- Test 6: node_modules not gitignored ---"
reset_wdi_env
T6="$(newtmp)"
ART6="$(newtmp)"
export ARTIFACTS_DIR="$ART6"
mkdir -p "$T6/repo"
printf '%s\n' '{"name":"wdi-fixture","private":true}' > "$T6/repo/package.json"
printf '%s\n' 'lock' > "$T6/repo/bun.lock"
init_repo "$T6/repo"
BIN6="$(make_stub_bin)"
arm_stub_logs "$BIN6"
LOG6="$CALL_LOG"
write_stub "$BIN6" bun 'exit 0'
export PATH="$BIN6:$ORIG_PATH"
OUT6="$(cd "$T6/repo" && wdi_main </dev/null)"
assert_contains "Test 6 skipped_not_ignored" ".:skipped_not_ignored" "$OUT6"
assert_eq "Test 6 stub not called" "0" "$(grep -c . "$CALL_LOG" || true)"

echo "--- Test 7: failure and timeout never gate ---"
reset_wdi_env
T7="$(newtmp)"
ART7="$(newtmp)"
export ARTIFACTS_DIR="$ART7"
mkdir -p "$T7/repo"
printf '%s\n' '{"name":"wdi-fixture","private":true}' > "$T7/repo/package.json"
printf '%s\n' 'lock' > "$T7/repo/bun.lock"
printf '%s\n' 'node_modules' > "$T7/repo/.gitignore"
init_repo "$T7/repo"
BIN7A="$(make_stub_bin)"
arm_stub_logs "$BIN7A"
write_stub "$BIN7A" bun 'exit 3'
export PATH="$BIN7A:$ORIG_PATH"
OUT7A="$(cd "$T7/repo" && wdi_main </dev/null; echo EXIT:$?)"
assert_contains "Test 7a failed_exit_3" ".:failed_exit_3" "$OUT7A"
assert_contains "Test 7a DEPS_STATUS=failed" "DEPS_STATUS=failed" "$OUT7A"
assert_contains "Test 7a exit 0" "EXIT:0" "$OUT7A"
BIN7B="$(make_stub_bin)"
arm_stub_logs "$BIN7B"
write_stub "$BIN7B" bun 'sleep 30'
export PATH="$BIN7B:$ORIG_PATH"
export WDI_TIMEOUT_SECS=1
T7START="$(date +%s)"
OUT7B="$(cd "$T7/repo" && rm -rf node_modules && wdi_main </dev/null; echo EXIT:$?)"
T7ELAPSED=$(( $(date +%s) - T7START ))
assert_contains "Test 7b failed_timeout" ".:failed_timeout" "$OUT7B"
assert_contains "Test 7b DEPS_STATUS=failed" "DEPS_STATUS=failed" "$OUT7B"
assert_contains "Test 7b exit 0" "EXIT:0" "$OUT7B"
if [ "$T7ELAPSED" -lt 10 ]; then PASS=$((PASS+1)); echo "PASS: Test 7b wall under 10s"; else FAIL=$((FAIL+1)); echo "FAIL: Test 7b wall under 10s ($T7ELAPSED)"; fi
unset WDI_TIMEOUT_SECS

echo "--- Test 8: tree hygiene ---"
reset_wdi_env
T8="$(newtmp)"
ART8="$(newtmp)"
export ARTIFACTS_DIR="$ART8"
mkdir -p "$T8/repo/src"
printf '%s\n' '{"name":"wdi-fixture","private":true}' > "$T8/repo/package.json"
printf '%s\n' 'lock-v1' > "$T8/repo/bun.lock"
printf '%s\n' 'node_modules' > "$T8/repo/.gitignore"
printf '%s\n' 'base' > "$T8/repo/src/a.ts"
init_repo "$T8/repo"
printf '%s\n' 'builder' > "$T8/repo/notes.txt"
printf '%s\n' 'changed' > "$T8/repo/src/a.ts"
BIN8="$(make_stub_bin)"
arm_stub_logs "$BIN8"
write_stub "$BIN8" bun 'printf "%s\n" extra >> bun.lock; printf "%s\n" migrated > bun.lock.migrated'
export PATH="$BIN8:$ORIG_PATH"
POR8="$(cd "$T8/repo" && porcelain)"
HEAD_LOCK="$(git -C "$T8/repo" show HEAD:bun.lock)"
OUT8="$(cd "$T8/repo" && wdi_main </dev/null)"
assert_contains "Test 8 dirty_reverted" ".:dirty_reverted" "$OUT8"
assert_eq "Test 8 bun.lock equals HEAD" "$HEAD_LOCK" "$(cat "$T8/repo/bun.lock")"
[ ! -e "$T8/repo/bun.lock.migrated" ] && echo "PASS: Test 8 migrated removed" && PASS=$((PASS+1)) || { echo "FAIL: Test 8 migrated removed"; FAIL=$((FAIL+1)); }
assert_eq "Test 8 notes kept" "builder" "$(cat "$T8/repo/notes.txt")"
assert_eq "Test 8 src kept" "changed" "$(cat "$T8/repo/src/a.ts")"
POR8B="$(cd "$T8/repo" && porcelain)"
assert_eq "Test 8 porcelain unchanged" "$POR8" "$POR8B"
[ ! -e "$T8/repo/node_modules/.archon-wdi-stamp" ] && echo "PASS: Test 8 no stamp" && PASS=$((PASS+1)) || { echo "FAIL: Test 8 no stamp"; FAIL=$((FAIL+1)); }

mkdir -p "$T8/api/api"
printf '%s\n' '{"name":"root","private":true}' > "$T8/api/package.json"
printf '%s\n' '{"name":"api","private":true}' > "$T8/api/api/package.json"
printf '%s\n' 'api-lock' > "$T8/api/api/bun.lock"
printf '%s\n' 'node_modules' > "$T8/api/.gitignore"
init_repo "$T8/api"
BIN8B="$(make_stub_bin)"
arm_stub_logs "$BIN8B"
write_stub "$BIN8B" bun 'printf "%s\n" extra >> bun.lock; printf "%s\n" migrated > bun.lock.migrated'
export PATH="$BIN8B:$ORIG_PATH"
OUT8B="$(cd "$T8/api" && wdi_main </dev/null)"
assert_contains "Test 8 depth-1 dirty_reverted" "api:dirty_reverted" "$OUT8B"
[ ! -e "$T8/api/api/bun.lock.migrated" ] && echo "PASS: Test 8 depth-1 migrated removed" && PASS=$((PASS+1)) || { echo "FAIL: Test 8 depth-1 migrated removed"; FAIL=$((FAIL+1)); }
assert_eq "Test 8 depth-1 lock equals HEAD" "api-lock" "$(cat "$T8/api/api/bun.lock")"

echo "--- Test 9: class gate ---"
reset_wdi_env
export ARTIFACTS_DIR="$ART6"
export PATH="$BIN6:$ORIG_PATH"
: > "$LOG6"
OUT9="$(cd "$T6/repo" && printf '%s\n' 'WO Class: DOCUMENTATION' | wdi_main)"
assert_contains "Test 9 DOCUMENTATION not_required" "DEPS_STATUS=not_required" "$OUT9"
assert_eq "Test 9 stub not called" "0" "$(grep -c . "$LOG6" || true)"
OUT9B="$(cd "$T6/repo" && printf '%s\n' 'WO Class: OPERATOR' | wdi_main)"
assert_contains "Test 9 OPERATOR not_required" "DEPS_STATUS=not_required" "$OUT9B"
assert_eq "Test 9 operator stub not called" "0" "$(grep -c . "$LOG6" || true)"

echo "--- Test 10: disk guard ---"
reset_wdi_env
export ARTIFACTS_DIR="$ART2"
export PATH="$BIN2:$ORIG_PATH"
export WDI_MIN_FREE_KB=999999999999
: > "$LOG2"
OUT10="$(cd "$T2/repo" && rm -rf api/node_modules && wdi_main </dev/null)"
assert_contains "Test 10 skipped_low_disk" "api:skipped_low_disk" "$OUT10"
assert_eq "Test 10 stub not called" "0" "$(grep -c . "$LOG2" || true)"
unset WDI_MIN_FREE_KB

echo "--- Test 11: lane wiring ---"
lane_scan() {
  local yaml n=0 core="" first="" block dep
  for yaml in "$DEFAULTS"/*.yaml; do
    grep -q -- '- id: run-stop-tests' "$yaml" || continue
    n=$((n + 1))
    grep -q -- '- id: install-worktree-deps' "$yaml" || { echo "MISSING_NODE $yaml"; continue; }
    dep="$(awk '
      /- id: run-stop-tests$/ { p = 1; next }
      p && /depends_on:/ { print; exit }
      p && /- id: / { exit }
    ' "$yaml")"
    printf '%s\n' "$dep" | grep -q 'install-worktree-deps' || echo "MISSING_EDGE $yaml"
    block="$(awk '
      /- id: install-worktree-deps$/ { p = 1; next }
      p && /- id: / { exit }
      p
    ' "$yaml")"
    printf '%s\n' "$block" | grep -q 'depends_on: \[ascii-gate\]' || echo "BAD_DEP $yaml"
    printf '%s\n' "$block" | grep -q '^    when:' && echo "HAS_WHEN $yaml"
    if [ -z "$first" ]; then first="$(extract_core "$yaml" wdi)"; else
      core="$(extract_core "$yaml" wdi)"
      [ "$core" = "$first" ] || echo "CORE_DIFF $yaml"
    fi
  done
  echo "LANE_COUNT $n"
}
SCAN1="$(lane_scan)"
SCAN2="$(lane_scan)"
assert_eq "Test 11 scan deterministic" "$SCAN1" "$SCAN2"
assert_eq "Test 11 lane count" "LANE_COUNT 12" "$(printf '%s\n' "$SCAN1" | grep '^LANE_COUNT')"
if printf '%s\n' "$SCAN1" | grep -Eq 'MISSING_|BAD_DEP|HAS_WHEN|CORE_DIFF'; then
  FAIL=$((FAIL+1)); echo "FAIL: Test 11 wiring"; printf '%s\n' "$SCAN1"
else
  PASS=$((PASS+1)); echo "PASS: Test 11 wiring and core parity"
fi
echo "Test 11 lanes: $(printf '%s\n' "$SCAN1" | grep '^LANE_COUNT' | awk '{print $2}')"

echo
echo "install-worktree-deps.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
