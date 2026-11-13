#!/usr/bin/env bash
# dprep-package-folder.sh -- tests for the package-folder rules of scripts/lane/dprep.sh
# (WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01, Tests 1, 2, 3 and 9).
#
# A repo whose lockfiles live in a package folder (shopops keeps them in shopops-api/) had no
# dependencies installed, in prep or in the final trusted run. dprep_ensure_js_deps now installs in
# the immediate package folders when the top folder holds no lockfile, and leaves every tracked
# file of such a folder exactly as it was.
#
# The real dprep.sh is sourced; npm, bun and pnpm are stubs on PATH that record their working
# folder and arguments, and can fail or rewrite tracked files on demand.
#
# Run: bash .archon/workflows/defaults/__tests__/dprep-package-folder.sh
# Final line: "<n> passing / <n> total". Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
has()   { if printf '%s\n' "$3" | grep -Fq -- "$2"; then ok "$1"; else bad "$1" "missing [$2] in: $3"; fi; }
hasnt() { if printf '%s\n' "$3" | grep -Fq -- "$2"; then bad "$1" "unexpected [$2] in: $3"; else ok "$1"; fi; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DPREP="$HERE/../../../../scripts/lane/dprep.sh"
[ -f "$DPREP" ] || { echo "dprep.sh not found at $DPREP"; exit 1; }
# shellcheck disable=SC1090
. "$DPREP"

GITDIR="$(dirname "$(command -v git)")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
REC="$WORK/rec"
mkdir -p "$BIN"

# --- stubs --------------------------------------------------------------------------------
cat > "$BIN/npm" <<'STUB'
#!/usr/bin/env bash
echo "npm $* | $PWD" >> "$REC"
failhere() { [ -n "${STUB_FAIL_FOLDER:-}" ] && case "$PWD" in *"$STUB_FAIL_FOLDER") return 0 ;; esac; return 1; }
case "$1" in
  ci)
    [ -n "${STUB_NPM_FAIL_CI:-}" ] && exit 1
    failhere && exit 1
    if [ -n "${STUB_TOUCH_SOURCE:-}" ]; then mkdir -p routes; echo "install clobbered" > routes/x.js; fi
    mkdir -p node_modules; exit 0 ;;
  install)
    failhere && exit 1
    if [ -n "${STUB_REWRITE:-}" ]; then
      echo '{"rewritten":true}' > package-lock.json
      echo '{"name":"x","rewritten":true}' > package.json
      echo "extra" >> generated.txt
    fi
    mkdir -p node_modules; exit 0 ;;
esac
exit 0
STUB
cat > "$BIN/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $* | $PWD" >> "$REC"
if [ "$1" = "install" ] && [ "${2:-}" = "--frozen-lockfile" ]; then
  [ -n "${STUB_BUN_FROZEN_FAIL:-}" ] && exit 1
  mkdir -p node_modules; exit 0
fi
if [ "$1" = "install" ]; then
  if [ -n "${STUB_REWRITE:-}" ]; then
    echo "rewritten bun lock" > bun.lock
    echo "extra" >> generated2.txt
  fi
  mkdir -p node_modules; exit 0
fi
exit 0
STUB
cat > "$BIN/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm $* | $PWD" >> "$REC"
mkdir -p node_modules
exit 0
STUB
chmod +x "$BIN/npm" "$BIN/bun" "$BIN/pnpm"

# NOPNPM: a PATH with npm and bun stubs but no pnpm.
mkdir -p "$WORK/binnp"
cp "$BIN/npm" "$BIN/bun" "$WORK/binnp/"
PATH_FULL="$BIN:/usr/bin:/bin:$GITDIR"
PATH_NOPNPM="$WORK/binnp:/usr/bin:/bin:$GITDIR"

run_dprep() { # run_dprep <dir> [VAR=value ...]  -> OUT, RC; stub calls in $REC
  local dir="$1"; shift
  : > "$REC"
  OUT="$(cd "$dir" && env REC="$REC" PATH="${PATH_USE:-$PATH_FULL}" "$@" bash -c '. "$0"; dprep_ensure_js_deps' "$DPREP" 2>&1)"
  RC=$?
}
reclines() { local n; n="$(grep -c . "$REC" 2>/dev/null)"; echo "${n:-0}"; }

mkpkg() { # mkpkg <dir> [lockfile ...]: package.json plus the named lockfiles
  local dir="$1"; shift
  mkdir -p "$dir"
  echo '{"name":"t"}' > "$dir/package.json"
  local f
  for f in "$@"; do echo "lock" > "$dir/$f"; done
}

# ---- Test 1: package folder install when the top folder has no lockfile ---------------------
T1="$WORK/t1"; mkpkg "$T1"; mkpkg "$T1/shopops-api" package-lock.json
run_dprep "$T1"
check "T1 return code 0" 0 "$RC"
check "T1 npm ran exactly once" 1 "$(reclines)"
has "T1 npm ci --no-audit --no-fund ran in shopops-api" "npm ci --no-audit --no-fund | " "$(cat "$REC")"
has "T1 the call was inside shopops-api" "/shopops-api" "$(cat "$REC")"
has "T1 output names the package folder" "dprep: package folder shopops-api" "$OUT"
[ -d "$T1/shopops-api/node_modules" ] && ok "T1 shopops-api/node_modules exists" || bad "T1 no node_modules in shopops-api"
[ ! -d "$T1/node_modules" ] && ok "T1 nothing installed in the top folder" || bad "T1 top folder got node_modules"
# The top-folder line the CE runs printed is still printed first.
has "T1 the no-lockfile line is still printed" "dprep: no package.json with a supported lockfile" "$OUT"

# ---- Test 2: precedence, skips and limits ---------------------------------------------------
# (a) both lockfiles -> npm; bun-only -> bun
T2A="$WORK/t2a"; mkpkg "$T2A"; mkpkg "$T2A/a-both" bun.lock package-lock.json; mkpkg "$T2A/b-bun" bun.lock
run_dprep "$T2A"
check "T2a return code 0" 0 "$RC"
has "T2a a folder with both lockfiles used npm ci" "npm ci --no-audit --no-fund | " "$(cat "$REC")"
has "T2a the bun-only folder used bun --frozen-lockfile" "bun install --frozen-lockfile | " "$(cat "$REC")"
check "T2a exactly two installs (bun never ran in the both-lockfiles folder)" 2 "$(reclines)"
check "T2a bun ran only in b-bun" 1 "$(grep -c '^bun .*/b-bun$' "$REC")"
# (b) node_modules already present
T2B="$WORK/t2b"; mkpkg "$T2B"; mkpkg "$T2B/api" package-lock.json; mkdir -p "$T2B/api/node_modules"
run_dprep "$T2B"
check "T2b no stub ran" 0 "$(reclines)"
has "T2b the output says node_modules present" "node_modules present" "$OUT"
# (c) package.json without a lockfile
T2C="$WORK/t2c"; mkpkg "$T2C"; mkpkg "$T2C/api"
run_dprep "$T2C"
check "T2c no stub ran" 0 "$(reclines)"
check "T2c return code 0" 0 "$RC"
# (d) five qualifying folders -> first three in name order
T2D="$WORK/t2d"; mkpkg "$T2D"
for n in e5 e3 e1 e4 e2; do mkpkg "$T2D/$n" package-lock.json; done
run_dprep "$T2D"
check "T2d exactly three installs" 3 "$(reclines)"
check "T2d the first three folders in name order" "e1 e2 e3" "$(sed 's#.*/##' "$REC" | tr '\n' ' ' | sed 's/ $//')"
# (e) ignored names and depth two
T2E="$WORK/t2e"; mkpkg "$T2E"
mkpkg "$T2E/.hidden" package-lock.json; mkpkg "$T2E/node_modules" package-lock.json; mkpkg "$T2E/dist" package-lock.json; mkpkg "$T2E/build" package-lock.json
mkpkg "$T2E/wrapper/inner" package-lock.json
run_dprep "$T2E"
check "T2e no folder qualified" 0 "$(reclines)"
check "T2e return code 0" 0 "$RC"
# (f) a top lockfile means no scan
T2F="$WORK/t2f"; mkpkg "$T2F" package-lock.json; mkpkg "$T2F/sub" package-lock.json
run_dprep "$T2F"
check "T2f only the top folder was installed" 1 "$(reclines)"
hasnt "T2f no package folder line" "dprep: package folder" "$OUT"
# (g) pnpm lockfile on top without pnpm on PATH: the old skip, no scan
T2G="$WORK/t2g"; mkpkg "$T2G" pnpm-lock.yaml; mkpkg "$T2G/sub" package-lock.json
PATH_USE="$PATH_NOPNPM" run_dprep "$T2G"
check "T2g no stub ran" 0 "$(reclines)"
hasnt "T2g subfolders not scanned" "dprep: package folder" "$OUT"
# (h) top folder with a bun lockfile keeps bun first (unchanged precedence)
T2H="$WORK/t2h"; mkpkg "$T2H" bun.lock package-lock.json
run_dprep "$T2H"
has "T2h top-level precedence is unchanged (bun first)" "bun install --frozen-lockfile | " "$(cat "$REC")"
hasnt "T2h npm did not run at the top" "npm " "$(cat "$REC")"

# ---- Test 3: a failed package folder install returns nonzero and the rest still run ----------
T3="$WORK/t3"; mkpkg "$T3"; mkpkg "$T3/a-api" package-lock.json; mkpkg "$T3/b-api" package-lock.json
run_dprep "$T3" STUB_FAIL_FOLDER=a-api
check "T3 return code is 1" 1 "$RC"
has "T3 the failure is reported" "dprep: install failed rc=1" "$OUT"
[ -d "$T3/b-api/node_modules" ] && ok "T3 b-api was still installed" || bad "T3 b-api not installed"
[ ! -d "$T3/a-api/node_modules" ] && ok "T3 a-api has no node_modules" || bad "T3 a-api unexpectedly has node_modules"
has "T3 the retry without the frozen lockfile ran for a-api" "npm install --no-audit --no-fund | " "$(cat "$REC")"

# ---- Test 9: a package folder install leaves tracked files unchanged ------------------------
gitq() { git -C "$1" "${@:2}" >/dev/null 2>&1; }
mkrepo() { # mkrepo <dir>: git repo with node_modules ignored
  mkdir -p "$1"
  git -C "$1" init -q -b main 2>/dev/null || git -C "$1" init -q
  git -C "$1" config user.email t@example.com; git -C "$1" config user.name t
  git -C "$1" config core.autocrlf false
  echo "node_modules/" > "$1/.gitignore"
}
sums() { (cd "$1" && for f in "${@:2}"; do printf '%s ' "$f"; sha256sum "$f" | cut -c1-16; done); }

# (1) npm retry rewrites package-lock.json, package.json and a tracked file
T9A="$WORK/t9a"; mkrepo "$T9A"; mkpkg "$T9A"; mkpkg "$T9A/shopops-api" package-lock.json bun.lock
echo "generated" > "$T9A/shopops-api/generated.txt"
gitq "$T9A" add -A; gitq "$T9A" commit -m init
BEFORE="$(sums "$T9A" shopops-api/package.json shopops-api/package-lock.json shopops-api/bun.lock shopops-api/generated.txt)"
run_dprep "$T9A" STUB_NPM_FAIL_CI=1 STUB_REWRITE=1
AFTER="$(sums "$T9A" shopops-api/package.json shopops-api/package-lock.json shopops-api/bun.lock shopops-api/generated.txt)"
check "T9a every tracked file of the folder is byte-identical after the install" "$BEFORE" "$AFTER"
check "T9a git sees no modified tracked file" "" "$(git -C "$T9A" diff --name-only)"
has "T9a restore line for package-lock.json" "dprep: restored shopops-api/package-lock.json" "$OUT"
has "T9a restore line for package.json" "dprep: restored shopops-api/package.json" "$OUT"
has "T9a restore line for the other tracked file" "dprep: restored shopops-api/generated.txt" "$OUT"
[ -d "$T9A/shopops-api/node_modules" ] && ok "T9a node_modules exists" || bad "T9a no node_modules"
check "T9a return code 0" 0 "$RC"

# (2) a folder with only bun.lock: the unfrozen bun retry rewrites bun.lock and a tracked file
T9B="$WORK/t9b"; mkrepo "$T9B"; mkpkg "$T9B"; mkpkg "$T9B/bun-api" bun.lock
echo "generated2" > "$T9B/bun-api/generated2.txt"
gitq "$T9B" add -A; gitq "$T9B" commit -m init
BEFORE="$(sums "$T9B" bun-api/package.json bun-api/bun.lock bun-api/generated2.txt)"
run_dprep "$T9B" STUB_BUN_FROZEN_FAIL=1 STUB_REWRITE=1
AFTER="$(sums "$T9B" bun-api/package.json bun-api/bun.lock bun-api/generated2.txt)"
check "T9b tracked files byte-identical after the bun retry" "$BEFORE" "$AFTER"
check "T9b git sees no modified tracked file" "" "$(git -C "$T9B" diff --name-only)"
has "T9b restore line for bun.lock" "dprep: restored bun-api/bun.lock" "$OUT"
has "T9b the unfrozen retry ran" "bun install | " "$(cat "$REC")"

# (3) earlier uncommitted edits (an implement edit) are never touched
T9C="$WORK/t9c"; mkrepo "$T9C"; mkpkg "$T9C"; mkpkg "$T9C/shopops-api" package-lock.json
mkdir -p "$T9C/shopops-api/routes"; echo "v1" > "$T9C/shopops-api/routes/x.js"
gitq "$T9C" add -A; gitq "$T9C" commit -m init
echo "v2 implement edit" > "$T9C/shopops-api/routes/x.js"
echo '{"name":"t","dependencies":{"added":"1"}}' > "$T9C/shopops-api/package.json"
BEFORE="$(sums "$T9C" shopops-api/routes/x.js shopops-api/package.json)"
run_dprep "$T9C"
AFTER="$(sums "$T9C" shopops-api/routes/x.js shopops-api/package.json)"
check "T9c uncommitted edits are still present and unchanged" "$BEFORE" "$AFTER"
hasnt "T9c nothing was restored" "dprep: restored" "$OUT"

# (3b) the install rewrites a package.json the implement step had already edited: the pre-install
#      (implement) version comes back, not the committed one
T9D="$WORK/t9d"; mkrepo "$T9D"; mkpkg "$T9D"; mkpkg "$T9D/shopops-api" package-lock.json
gitq "$T9D" add -A; gitq "$T9D" commit -m init
echo '{"name":"t","dependencies":{"added":"1"}}' > "$T9D/shopops-api/package.json"
BEFORE="$(sums "$T9D" shopops-api/package.json)"
run_dprep "$T9D" STUB_NPM_FAIL_CI=1 STUB_REWRITE=1
AFTER="$(sums "$T9D" shopops-api/package.json)"
check "T9d the implement edit of package.json survives a rewriting install" "$BEFORE" "$AFTER"
has "T9d the restore is reported" "dprep: restored shopops-api/package.json" "$OUT"

# (3c) the install overwrites a tracked SOURCE file (not a manifest or lockfile) that an earlier step had
#      edited but not staged: the earlier edit must come back byte for byte (Overseer finding on PR 1597)
T9F="$WORK/t9f"; mkrepo "$T9F"; mkpkg "$T9F"; mkpkg "$T9F/shopops-api" package-lock.json
mkdir -p "$T9F/shopops-api/routes"; echo "v1" > "$T9F/shopops-api/routes/x.js"
gitq "$T9F" add -A; gitq "$T9F" commit -m init
echo "v2 unstaged implement edit" > "$T9F/shopops-api/routes/x.js"
BEFORE="$(sums "$T9F" shopops-api/routes/x.js)"
run_dprep "$T9F" STUB_TOUCH_SOURCE=1
AFTER="$(sums "$T9F" shopops-api/routes/x.js)"
check "T9f an unstaged edit of a source file survives an install that overwrites it" "$BEFORE" "$AFTER"
has "T9f the restore is reported" "dprep: restored shopops-api/routes/x.js" "$OUT"
has "T9f the install did run" "npm ci --no-audit" "$(cat "$REC")"

# (3d) the same overwrite on a STAGED edit: the staged content comes back
T9G="$WORK/t9g"; mkrepo "$T9G"; mkpkg "$T9G"; mkpkg "$T9G/shopops-api" package-lock.json
mkdir -p "$T9G/shopops-api/routes"; echo "v1" > "$T9G/shopops-api/routes/x.js"
gitq "$T9G" add -A; gitq "$T9G" commit -m init
echo "v2 staged implement edit" > "$T9G/shopops-api/routes/x.js"
gitq "$T9G" add shopops-api/routes/x.js
BEFORE="$(sums "$T9G" shopops-api/routes/x.js)"
run_dprep "$T9G" STUB_TOUCH_SOURCE=1
AFTER="$(sums "$T9G" shopops-api/routes/x.js)"
check "T9g a staged edit of a source file survives an install that overwrites it" "$BEFORE" "$AFTER"
check "T9g git still sees the staged edit and nothing else" "shopops-api/routes/x.js" "$(git -C "$T9G" diff --cached --name-only)"

# (3e) the install recreates a tracked file the implement step had deleted: it is deleted again
T9H="$WORK/t9h"; mkrepo "$T9H"; mkpkg "$T9H"; mkpkg "$T9H/shopops-api" package-lock.json
mkdir -p "$T9H/shopops-api/routes"; echo "v1" > "$T9H/shopops-api/routes/x.js"
gitq "$T9H" add -A; gitq "$T9H" commit -m init
rm "$T9H/shopops-api/routes/x.js"
run_dprep "$T9H" STUB_TOUCH_SOURCE=1
[ ! -e "$T9H/shopops-api/routes/x.js" ] && ok "T9h a deleted tracked file stays deleted" || bad "T9h the install resurrected a deleted tracked file"

# (4) outside a git work tree the lockfile and package.json are still restored
T9E="$WORK/t9e"; mkpkg "$T9E"; mkpkg "$T9E/shopops-api" package-lock.json
BEFORE="$(sums "$T9E" shopops-api/package.json shopops-api/package-lock.json)"
run_dprep "$T9E" STUB_NPM_FAIL_CI=1 STUB_REWRITE=1
AFTER="$(sums "$T9E" shopops-api/package.json shopops-api/package-lock.json)"
check "T9e without .git package.json and package-lock.json are restored" "$BEFORE" "$AFTER"
has "T9e the restore is reported" "dprep: restored shopops-api/package-lock.json" "$OUT"
check "T9e return code 0" 0 "$RC"

echo
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
