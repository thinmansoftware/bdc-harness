# scripts/lane/dprep.sh -- shared dependency-prep core for the bdc-feature-development lanes.
#
# SOURCED (not executed) by the prep-dependencies, run-stop-tests and run-stop-tests-final
# nodes of all 13 .archon/workflows/defaults/bdc-feature-development*.yaml lanes. The image
# ships it at /app/scripts/lane/dprep.sh (Dockerfile: COPY scripts/lane/). Before this file
# existed the function was inlined twice per lane (26 copies); one copy now keeps them in step.
#
# dprep_ensure_js_deps installs JavaScript dependencies in the current directory when
# node_modules is absent. Lockfile precedence:
#   bun.lock / bun.lockb            -> bun install --frozen-lockfile
#   pnpm-lock.yaml (pnpm on PATH)   -> pnpm install --frozen-lockfile
#   package-lock.json               -> npm ci --no-audit --no-fund
# Anything else skips (return 0). An install that fails is retried ONCE without the
# frozen lockfile (bun, pnpm: drop --frozen-lockfile; npm: npm install in place of npm ci),
# because a lockfile that drifted from package.json (error: lockfile had changes, but
# lockfile is frozen) is the commonest failure. The install output (stdout and stderr) is
# printed to stdout so the real error text reaches the caller's log. The function returns
# NONZERO when the install still failed, or when node_modules is still absent after it
# (WO-HARNESS-EVIDENCE-GATE-NOT-GATED-AND-BASE-UNRUNNABLE-01); the base-red comparison
# treats that as base_unrunnable, and the other callers (prep-dependencies, the
# run-stop-tests head prep) log it and carry on. The install subshell unsets
# the same credential families as rst_scrub_env and keeps *_TEST_* names.
# node_modules is never symlinked or copied. ASCII only.
#
# PACKAGE FOLDERS (WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01): when the
# current folder holds NO lockfile at all (none of bun.lock, bun.lockb, pnpm-lock.yaml,
# package-lock.json), the function scans the IMMEDIATE subfolders in bytewise name order,
# skipping names that start with a dot, node_modules, dist and build, and installs in each of
# up to 6 that hold a package.json plus a supported lockfile (folders the run's work order names
# as "<folder>/" first, then the rest in name order; see dprep__candidates), printing one line
# "dprep: package folder <name>" first (shopops keeps its lockfiles in shopops-api/). In a
# package folder package-lock.json wins over a bun lockfile when npm is on PATH (shopops-api
# holds both; its maintained lockfile is package-lock.json and its own workflows use npm ci);
# otherwise the order above applies. The install must not change what the repo tracks: the
# folder's package.json and lockfiles are copied aside first and any that differs afterwards is
# copied back, and inside a git work tree any other tracked file that was clean before the install
# and changed by it is restored with git checkout; a file that was already modified before the
# install is never touched. Each restore prints "dprep: restored <path>". Failure in one folder
# does not stop the others; the return code is nonzero when any attempted install failed. When
# the current folder has a lockfile file, nothing is scanned and behaviour is unchanged.

# dprep__install <header> <command...>: run the install with credentials scrubbed.
dprep__install() {
  local header="$1"
  shift
  local start now elapsed rc=0
  start="$(date +%s)"
  printf 'dprep: %s in %s\n' "$header" "$PWD"
  (
    for name in $(env | sed -n 's/=.*//p'); do
      case "$name" in
        *_TEST_*) continue ;;
        OVERSEER_*|MERGE_MANAGER_*|ARCHON_*|DUTY_OFFICER_*|TASKMASTER_*|DISPATCH_*|SMART_CAULDRON_*|BOARD_*|GITHUB_APP_*|GH_TOKEN|GITHUB_TOKEN|GH_AUTH_TOKEN_INTERNAL|TELEGRAM_*)
          unset "$name"
          ;;
      esac
    done
    timeout "${DPREP_TIMEOUT_SECONDS:-600}" "$@" < /dev/null 2>&1
  ) || rc=$?
  now="$(date +%s)"
  elapsed=$((now - start))
  if [ "$rc" -eq 0 ]; then
    printf 'dprep: install ok (%ss)\n' "$elapsed"
  else
    printf 'dprep: install failed rc=%s\n' "$rc"
  fi
  return "$rc"
}

# dprep__kind <prefer_npm>: print the installer kind for the CURRENT folder (bun, pnpm, npm or
# nothing). prefer_npm=0 is the original precedence; prefer_npm=1 (package folders only) lets
# package-lock.json win over a bun lockfile when npm is on PATH.
dprep__kind() {
  local prefer_npm="$1" kind=""
  if [ -f package.json ]; then
    if [ "$prefer_npm" = "1" ] && [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
      kind="npm"
    elif [ -f bun.lock ] || [ -f bun.lockb ]; then
      kind="bun"
    elif [ -f pnpm-lock.yaml ]; then
      # Unchanged from the inline core: a pnpm lockfile without pnpm on PATH skips
      # rather than falling through to another package manager.
      if command -v pnpm >/dev/null 2>&1; then kind="pnpm"; fi
    elif [ -f package-lock.json ]; then
      kind="npm"
    fi
  fi
  printf '%s' "$kind"
}

# dprep__install_here <kind>: the original install body, run in the CURRENT folder.
dprep__install_here() {
  local kind="$1" rc=0
  if [ -d node_modules ]; then
    printf 'dprep: node_modules present, skipping\n'
    return 0
  fi
  case "$kind" in
    bun)
      if ! command -v bun >/dev/null 2>&1; then
        printf 'dprep: bun not found, skipping\n'
        return 0
      fi
      dprep__install 'installing JS dependencies (bun install --frozen-lockfile)' bun install --frozen-lockfile || rc=$?
      if [ "$rc" -ne 0 ]; then
        rc=0
        dprep__install 'retrying without --frozen-lockfile (bun install)' bun install || rc=$?
      fi
      ;;
    pnpm)
      dprep__install 'installing JS dependencies (pnpm, frozen lockfile)' pnpm install --frozen-lockfile || rc=$?
      if [ "$rc" -ne 0 ]; then
        rc=0
        dprep__install 'retrying without --frozen-lockfile (pnpm install)' pnpm install || rc=$?
      fi
      ;;
    npm)
      if ! command -v npm >/dev/null 2>&1; then
        printf 'dprep: npm not found, skipping\n'
        return 0
      fi
      dprep__install 'npm ci (package-lock.json)' npm ci --no-audit --no-fund || rc=$?
      if [ "$rc" -ne 0 ]; then
        rc=0
        dprep__install 'retrying with npm install (npm ci failed)' npm install --no-audit --no-fund || rc=$?
      fi
      ;;
  esac
  if [ "$rc" -eq 0 ] && [ ! -d node_modules ]; then
    printf 'dprep: install reported success but node_modules is still absent\n'
    rc=1
  fi
  return "$rc"
}

# dprep__has_lockfile_file: success when the CURRENT folder holds any lockfile file.
dprep__has_lockfile_file() {
  [ -f bun.lock ] || [ -f bun.lockb ] || [ -f pnpm-lock.yaml ] || [ -f package-lock.json ]
}

# dprep__candidates: print up to DPREP_MAX_PACKAGE_FOLDERS (6) immediate subfolder names that qualify, one per
# line. Folders the run's work order names as "<folder>/" come FIRST (in name order), then the others in name
# order. The work order is BDC_DPREP_SPEC_FILE when set, else $ARTIFACTS_DIR/authority/work-order.md (written by
# read-spec on the authority path); with neither, plain name order. A cap of 3 skipped shopops-api, the 4th of
# shopops's 4 package folders in name order (CE refire e69566fe, 2026-11-13), so the WO's own folder never
# installed. A folder name matches only at a path boundary, so "api" does not match "shopops-api/".
DPREP_MAX_PACKAGE_FOLDERS=6
dprep__candidates() {
  local name kind spec pattern count=0 preferred="" rest=""
  spec="${BDC_DPREP_SPEC_FILE:-}"
  if [ -z "$spec" ] && [ -n "${ARTIFACTS_DIR:-}" ]; then spec="$ARTIFACTS_DIR/authority/work-order.md"; fi
  [ -n "$spec" ] && [ -f "$spec" ] || spec=""
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      .*|node_modules|dist|build) continue ;;
    esac
    [ -f "$name/package.json" ] || continue
    kind="$(cd "$name" 2>/dev/null && dprep__kind 1)"
    [ -n "$kind" ] || continue
    if [ -n "$spec" ]; then
      pattern="(^|[^A-Za-z0-9._-])$(printf '%s' "$name" | sed 's/[.[\*^$+?(){}|]/\\&/g')/"
      if grep -Eq -- "$pattern" "$spec" 2>/dev/null; then
        preferred="$preferred$name
"
        continue
      fi
    fi
    rest="$rest$name
"
  done < <(find . -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | LC_ALL=C sort)
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$name"
    count=$((count + 1))
    [ "$count" -ge "$DPREP_MAX_PACKAGE_FOLDERS" ] && break
  done <<EOF
$preferred$rest
EOF
  return 0
}

# dprep__guarded_install_in <folder>: install in one package folder and leave every tracked file as it was.
#
# REFUSE-ON-DIRTY (PR 1597 review rounds 1 to 3, acting XO ruling 2026-11-13): inside a git work tree the
# install runs ONLY on a clean tree (nothing modified, staged, deleted or untracked other than node_modules).
# A dirty tree means earlier work is in the checkout (an implement edit); the install is refused, rc 1,
# and nothing is installed or touched: no snapshot, no restore, so there is no restore logic to get wrong.
# This costs nothing on the normal path: prep-dependencies installs on the clean tree BEFORE implement, so a
# later call finds node_modules present and skips. On a clean tree every tracked change after the install is
# the install's own doing (a lifecycle script may rewrite a file, stage it, add a new file to the index or even
# commit), so the restore is COMPLETE BY CONSTRUCTION rather than path by path: the commit and ref saved before
# the install are the pre-install state, and `git reset --hard` to that commit puts the index and every tracked
# file back (`dprep: restored <path>` per path). Nothing of value can be lost because the tree was proven clean.
# If the install changed the checked-out ref, HEAD is pointed back at the saved ref and the same reset runs, so
# implement never builds on the install's ref; the return code is 1 to flag it. Outside a git work
# tree the folder's package.json and lockfiles are copied aside and restored.
dprep__guarded_install_in() {
  local dir="$1" kind rc=0 saved="" f top dirty changed path head_before ref_before ref_after
  printf 'dprep: package folder %s\n' "$dir"
  kind="$(cd "$dir" && dprep__kind 1)"
  if [ -d "$dir/node_modules" ]; then
    printf 'dprep: node_modules present, skipping\n'
    return 0
  fi
  top=""
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"
    if ! dirty="$(git -C "$top" -c core.quotepath=off status --porcelain --untracked-files=normal 2>/dev/null)"; then
      dirty="git status failed"
    fi
    # An install in an earlier package folder leaves an untracked node_modules when the repo does not ignore
    # it: that is not earlier work.
    dirty="$(printf '%s\n' "$dirty" | grep -v '^?? .*node_modules/$' || true)"
    if [ -n "$dirty" ]; then
      printf 'dprep: working tree has uncommitted changes; install skipped in %s (refuse-on-dirty: nothing installed, nothing touched)\n' "$dir"
      return 1
    fi
    head_before="$(git -C "$top" rev-parse --verify -q HEAD 2>/dev/null)" || head_before=""
    if [ -z "$head_before" ]; then
      printf 'dprep: the repository has no commit to restore to; install skipped in %s\n' "$dir"
      return 1
    fi
    ref_before="$(git -C "$top" symbolic-ref -q HEAD 2>/dev/null || echo detached)"
  else
    saved="$(mktemp -d 2>/dev/null)" || saved=""
    if [ -z "$saved" ]; then
      printf 'dprep: no temporary folder; install skipped in %s (cannot protect package.json and lockfiles)\n' "$dir"
      return 1
    fi
    for f in package.json bun.lock bun.lockb pnpm-lock.yaml package-lock.json yarn.lock; do
      [ -f "$dir/$f" ] || continue
      if ! cp -p "$dir/$f" "$saved/$f"; then
        printf 'dprep: SNAPSHOT FAILED %s/%s; install skipped\n' "$dir" "$f"
        rm -rf "$saved"
        return 1
      fi
    done
  fi
  (cd "$dir" && dprep__install_here "$kind") || rc=$?
  if [ -n "$top" ]; then
    ref_after="$(git -C "$top" symbolic-ref -q HEAD 2>/dev/null || echo detached)"
    if [ "$ref_after" != "$ref_before" ]; then
      # The install switched the checkout to another ref. prep-dependencies ends "exit 0" and implement runs
      # with trigger_rule all_done, so leaving the tree there would make implement build on the install's ref
      # (Board desk, PR 1597 round 5). Point HEAD back at the saved ref WITHOUT touching the tree or index
      # (symbolic-ref for a branch, update-ref --no-deref for a detached HEAD), so the reset below logs every
      # path the install changed and then puts index and files back at the saved commit. rc stays 1 to flag it.
      printf 'dprep: the install changed the checked-out ref (%s -> %s); restoring %s in %s\n' "$ref_before" "$ref_after" "$ref_before" "$dir"
      [ "$rc" -eq 0 ] && rc=1
      if [ "$ref_before" = "detached" ]; then
        git -C "$top" update-ref --no-deref HEAD "$head_before" 2>/dev/null
      else
        git -C "$top" symbolic-ref HEAD "$ref_before" 2>/dev/null
      fi || printf 'dprep: RESTORE FAILED (could not point HEAD back at %s) in %s\n' "$ref_before" "$dir"
    fi
    if [ "$(git -C "$top" symbolic-ref -q HEAD 2>/dev/null || echo detached)" != "$ref_before" ]; then
      printf 'dprep: RESTORE FAILED (HEAD is not on %s); nothing reset in %s\n' "$ref_before" "$dir"
      [ "$rc" -eq 0 ] && rc=1
    elif [ "$(git -C "$top" rev-parse --verify -q HEAD 2>/dev/null)" != "$head_before" ] \
      || ! git -C "$top" diff --quiet "$head_before" 2>/dev/null \
      || ! git -C "$top" diff --cached --quiet "$head_before" 2>/dev/null; then
      # Differs from the pre-install commit in the worktree, the index or HEAD itself (staged edits, staged new
      # files, an install commit, deletions). List the paths, then put everything back.
      changed="$(
        { git -C "$top" -c core.quotepath=off diff --name-only "$head_before" 2>/dev/null
          git -C "$top" -c core.quotepath=off diff --cached --name-only "$head_before" 2>/dev/null
          git -C "$top" -c core.quotepath=off diff --name-only "$head_before" HEAD 2>/dev/null
        } | LC_ALL=C sort -u
      )"
      # Log what differed BEFORE the reset, so the evidence exists even if the reset itself fails.
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        printf 'dprep: install changed %s
' "$path"
      done <<EOF
$changed
EOF
      # WHY A HARD RESET IS SAFE HERE: it runs only on a tree that refuse-on-dirty above proved CLEAN before
      # the install (nothing modified, staged, deleted or untracked except node_modules), and only once HEAD
      # is on the saved ref again. So everything that differs from the saved commit is the install's own doing, and
      # nothing of anyone's work can be lost. `git reset --hard` leaves untracked files (node_modules) in place, with
      # one exception: untracked install output that sits where the saved commit has a tracked path is replaced by it.
      if git -C "$top" reset -q --hard "$head_before" 2>/dev/null; then
        while IFS= read -r path; do
          [ -n "$path" ] || continue
          printf 'dprep: restored %s\n' "$path"
        done <<EOF
$changed
EOF
      else
        printf 'dprep: RESTORE FAILED (git reset --hard %s) in %s\n' "$head_before" "$dir"
        [ "$rc" -eq 0 ] && rc=1
      fi
    fi
  else
    for f in package.json bun.lock bun.lockb pnpm-lock.yaml package-lock.json yarn.lock; do
      if [ -f "$saved/$f" ] && ! cmp -s "$saved/$f" "$dir/$f"; then
        if cp -p "$saved/$f" "$dir/$f"; then
          printf 'dprep: restored %s/%s\n' "$dir" "$f"
        else
          printf 'dprep: RESTORE FAILED %s/%s; copies kept in %s\n' "$dir" "$f" "$saved"
          return 1
        fi
      fi
    done
    rm -rf "$saved"
  fi
  return "$rc"
}

dprep_ensure_js_deps() {
  local kind dir rc=0 one=0
  kind="$(dprep__kind 0)"
  if [ -n "$kind" ]; then
    dprep__install_here "$kind"
    return $?
  fi
  printf 'dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping\n'
  # Package folders: only when this folder holds no lockfile file at all.
  if dprep__has_lockfile_file; then
    return 0
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    one=0
    dprep__guarded_install_in "$dir" || one=$?
    [ "$one" -ne 0 ] && rc=1
  done <<EOF
$(dprep__candidates)
EOF
  return "$rc"
}
