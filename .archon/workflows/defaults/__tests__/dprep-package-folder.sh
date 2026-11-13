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
    if [ -n "${STUB_STAGE_SOURCE:-}" ]; then mkdir -p routes; echo "install staged rewrite" > routes/x.js; git add routes/x.js; fi
    if [ -n "${STUB_STAGE_NEWFILE:-}" ]; then mkdir -p routes; echo "staged new" > routes/staged-new.js; git add routes/staged-new.js; fi
    if [ -n "${STUB_COMMIT:-}" ]; then mkdir -p routes; echo "install committed" > routes/x.js; git add routes/x.js; git -c user.email=t@e.com -c user.name=t commit -qm install-commit; fi
    if [ -n "${STUB_SWITCH_BRANCH:-}" ]; then git checkout -q -b install-branch; fi
    if [ -n "${STUB_UNTRACKED:-}" ]; then echo "install output" > generated-untracked.txt; fi
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

# ---- Refuse-on-dirty (PR 1597 review rounds 1 to 3): a dirty tree gets NO install, NO snapshot, NO restore ----
# Each case: earlier work is in the checkout; dprep returns 1, no stub ran, every byte is as it was.
refuse_case() { # refuse_case <name> <repo> <expected status line fragment, "" to skip>
  local name="$1" repo="$2"
  has "$name: the refusal is printed" "refuse-on-dirty" "$OUT"
  check "$name: return code 1" 1 "$RC"
  check "$name: no install ran" 0 "$(reclines)"
  [ ! -d "$repo/shopops-api/node_modules" ] && ok "$name: no node_modules appeared" || bad "$name: node_modules appeared"
  hasnt "$name: nothing was restored (nothing was touched)" "dprep: restored" "$OUT"
}
mkdirty() { # mkdirty <name>: a committed repo with shopops-api/routes/x.js and a clean tree
  local d="$WORK/$1"; mkrepo "$d"; mkpkg "$d"; mkpkg "$d/shopops-api" package-lock.json
  mkdir -p "$d/shopops-api/routes"; echo "v1" > "$d/shopops-api/routes/x.js"
  gitq "$d" add -A; gitq "$d" commit -m init
  printf '%s' "$d"
}

# (a) an unstaged edit to a source file
T9F="$(mkdirty t9f)"; echo "v2 unstaged implement edit" > "$T9F/shopops-api/routes/x.js"
BEFORE="$(sums "$T9F" shopops-api/routes/x.js)"
run_dprep "$T9F" STUB_TOUCH_SOURCE=1
refuse_case "T9f unstaged edit" "$T9F"
check "T9f the edit is byte-identical" "$BEFORE" "$(sums "$T9F" shopops-api/routes/x.js)"

# (b) a staged edit
T9G="$(mkdirty t9g)"; echo "v2 staged implement edit" > "$T9G/shopops-api/routes/x.js"; gitq "$T9G" add shopops-api/routes/x.js
run_dprep "$T9G" STUB_TOUCH_SOURCE=1
refuse_case "T9g staged edit" "$T9G"
check "T9g the staged edit is still staged" "shopops-api/routes/x.js" "$(git -C "$T9G" diff --cached --name-only)"

# (c) an unstaged deletion (the Overseer's first reproduction class)
T9H="$(mkdirty t9h)"; rm "$T9H/shopops-api/routes/x.js"
run_dprep "$T9H" STUB_TOUCH_SOURCE=1
refuse_case "T9h unstaged deletion" "$T9H"
[ ! -e "$T9H/shopops-api/routes/x.js" ] && ok "T9h the deleted file was not resurrected" || bad "T9h a deleted file was resurrected"

# (d) a STAGED deletion (git rm): invisible to git diff, the Overseer's round-3 finding
T9I="$(mkdirty t9i)"; gitq "$T9I" rm -q shopops-api/routes/x.js
run_dprep "$T9I" STUB_TOUCH_SOURCE=1
refuse_case "T9i staged deletion" "$T9I"
[ ! -e "$T9I/shopops-api/routes/x.js" ] && ok "T9i the staged-deleted file was not recreated" || bad "T9i a staged-deleted file was recreated"

# (e) an untracked file (new work not yet added)
T9J="$(mkdirty t9j)"; echo "new work" > "$T9J/shopops-api/routes/new.js"
run_dprep "$T9J" STUB_TOUCH_SOURCE=1
refuse_case "T9j untracked file" "$T9J"
check "T9j the untracked file is still there" "new work" "$(cat "$T9J/shopops-api/routes/new.js")"

# (f) an edit to the folder's own package.json (earlier T9d): refused, the edit untouched
T9K="$(mkdirty t9k)"; echo '{"name":"t","dependencies":{"added":"1"}}' > "$T9K/shopops-api/package.json"
BEFORE="$(sums "$T9K" shopops-api/package.json)"
run_dprep "$T9K" STUB_NPM_FAIL_CI=1 STUB_REWRITE=1
refuse_case "T9k edited package.json" "$T9K"
check "T9k the edited package.json is byte-identical" "$BEFORE" "$(sums "$T9K" shopops-api/package.json)"

# (g) a CLEAN tree is installed normally, and a tracked source file the install rewrites is put back
T9L="$(mkdirty t9l)"
BEFORE="$(sums "$T9L" shopops-api/routes/x.js)"
run_dprep "$T9L" STUB_TOUCH_SOURCE=1
check "T9l return code 0 on a clean tree" 0 "$RC"
check "T9l the source file the install rewrote is back byte for byte" "$BEFORE" "$(sums "$T9L" shopops-api/routes/x.js)"
has "T9l the restore is reported" "dprep: restored shopops-api/routes/x.js" "$OUT"
[ -d "$T9L/shopops-api/node_modules" ] && ok "T9l node_modules exists" || bad "T9l no node_modules after a clean-tree install"
check "T9l git sees no modified tracked file" "" "$(git -C "$T9L" diff --name-only)"

# (h) node_modules present: a dirty tree is NOT refused, the install is simply skipped (the normal later call)
T9M="$(mkdirty t9m)"; mkdir -p "$T9M/shopops-api/node_modules"; echo "v2 edit" > "$T9M/shopops-api/routes/x.js"
run_dprep "$T9M" STUB_TOUCH_SOURCE=1
check "T9m return code 0 (node_modules present)" 0 "$RC"
has "T9m skipped, not refused" "node_modules present" "$OUT"
hasnt "T9m not refused" "refuse-on-dirty" "$OUT"
check "T9m no install ran" 0 "$(reclines)"

# ---- Complete restore on a clean tree (PR 1597 review round 4): reset to the saved pre-install commit ---------
# A lifecycle script may stage a rewrite, stage a NEW file, commit, or leave untracked output.
T9N="$(mkdirty t9n)"; BEFORE="$(sums "$T9N" shopops-api/routes/x.js)"; HEAD0="$(git -C "$T9N" rev-parse HEAD)"
run_dprep "$T9N" STUB_STAGE_SOURCE=1
check "T9n staged rewrite: return code 0" 0 "$RC"
check "T9n the staged rewrite is back byte for byte" "$BEFORE" "$(sums "$T9N" shopops-api/routes/x.js)"
check "T9n nothing is left staged" "" "$(git -C "$T9N" diff --cached --name-only)"
check "T9n git sees no modified tracked file" "" "$(git -C "$T9N" diff --name-only)"
has "T9n the list of what differed was logged first" "dprep: install changed shopops-api/routes/x.js" "$OUT"
has "T9n the restore is reported" "dprep: restored shopops-api/routes/x.js" "$OUT"
check "T9n HEAD is unchanged" "$HEAD0" "$(git -C "$T9N" rev-parse HEAD)"

T9O="$(mkdirty t9o)"
run_dprep "$T9O" STUB_STAGE_NEWFILE=1
check "T9o staged new file: return code 0" 0 "$RC"
check "T9o the new file is no longer staged" "" "$(git -C "$T9O" diff --cached --name-only)"
# The install created AND staged it, so pre-install it did not exist: the reset removes it (a file staged by the
# install is the install's own); a file that is merely untracked is never touched (T9r).
[ ! -e "$T9O/shopops-api/routes/staged-new.js" ] && ok "T9o the file the install created and staged is gone (pre-install it did not exist)" || bad "T9o the install's staged new file is still there"

T9P="$(mkdirty t9p)"; BEFORE="$(sums "$T9P" shopops-api/routes/x.js)"; HEAD0="$(git -C "$T9P" rev-parse HEAD)"
run_dprep "$T9P" STUB_COMMIT=1
check "T9p install commit: return code 0" 0 "$RC"
check "T9p HEAD is back at the pre-install commit" "$HEAD0" "$(git -C "$T9P" rev-parse HEAD)"
check "T9p the file is back byte for byte" "$BEFORE" "$(sums "$T9P" shopops-api/routes/x.js)"

# The install switches to its own branch (PR 1597 round 5, Board desk): prep-dependencies exits 0 and implement
# runs with trigger_rule all_done, so dprep must put the checkout back on the SAVED ref, never leave it on the
# install's ref.
T9Q="$(mkdirty t9q)"; BEFORE="$(sums "$T9Q" shopops-api/routes/x.js)"; HEAD0="$(git -C "$T9Q" rev-parse HEAD)"
REF0="$(git -C "$T9Q" symbolic-ref -q HEAD)"
run_dprep "$T9Q" STUB_TOUCH_SOURCE=1 STUB_SWITCH_BRANCH=1
check "T9q ref changed: return code 1 (flagged)" 1 "$RC"
has "T9q the ref change is reported" "changed the checked-out ref" "$OUT"
check "T9q HEAD is back on the saved branch" "$REF0" "$(git -C "$T9Q" symbolic-ref -q HEAD)"
check "T9q HEAD is at the saved commit" "$HEAD0" "$(git -C "$T9Q" rev-parse HEAD)"
has "T9q what the install changed was logged" "dprep: install changed shopops-api/routes/x.js" "$OUT"
has "T9q the restore is reported" "dprep: restored shopops-api/routes/x.js" "$OUT"
check "T9q the file is back byte for byte" "$BEFORE" "$(sums "$T9Q" shopops-api/routes/x.js)"
check "T9q git sees no modified or staged tracked file" "" "$(git -C "$T9Q" status --porcelain --untracked-files=no)"

# Same, from a DETACHED checkout (the lane's repair-in-place and pinned-sha runs): HEAD is detached again at the
# saved commit, not left on the install's branch.
T9QD="$(mkdirty t9qd)"; gitq "$T9QD" checkout --detach; BEFORE="$(sums "$T9QD" shopops-api/routes/x.js)"; HEAD0="$(git -C "$T9QD" rev-parse HEAD)"
run_dprep "$T9QD" STUB_TOUCH_SOURCE=1 STUB_SWITCH_BRANCH=1
check "T9q detached: return code 1 (flagged)" 1 "$RC"
check "T9q detached: HEAD is detached again" "" "$(git -C "$T9QD" symbolic-ref -q HEAD || true)"
check "T9q detached: HEAD is at the saved commit" "$HEAD0" "$(git -C "$T9QD" rev-parse HEAD)"
check "T9q detached: the file is back byte for byte" "$BEFORE" "$(sums "$T9QD" shopops-api/routes/x.js)"
check "T9q detached: git sees no modified or staged tracked file" "" "$(git -C "$T9QD" status --porcelain --untracked-files=no)"

T9R="$(mkdirty t9r)"
run_dprep "$T9R" STUB_UNTRACKED=1
check "T9r untracked output: return code 0" 0 "$RC"
[ -f "$T9R/shopops-api/generated-untracked.txt" ] && ok "T9r what the install created stays (reset never touches untracked files)" || bad "T9r an untracked file was removed"

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
