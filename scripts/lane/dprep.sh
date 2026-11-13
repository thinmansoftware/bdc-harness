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
# the first 3 that hold a package.json plus a supported lockfile, printing one line
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

# dprep__candidates: print up to 3 immediate subfolder names that qualify, one per line.
dprep__candidates() {
  local name count=0 kind
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      .*|node_modules|dist|build) continue ;;
    esac
    [ -f "$name/package.json" ] || continue
    kind="$(cd "$name" 2>/dev/null && dprep__kind 1)"
    [ -n "$kind" ] || continue
    printf '%s\n' "$name"
    count=$((count + 1))
    [ "$count" -ge 3 ] && break
  done < <(find . -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | LC_ALL=C sort)
  return 0
}

# dprep__guarded_install_in <folder>: install in one package folder and leave its tracked files
# exactly as they were (see the PACKAGE FOLDERS note above). Returns the install's return code.
dprep__guarded_install_in() {
  local dir="$1" kind rc=0 saved f top before after path nmod rfail=0
  printf 'dprep: package folder %s\n' "$dir"
  kind="$(cd "$dir" && dprep__kind 1)"
  if [ -d "$dir/node_modules" ]; then
    printf 'dprep: node_modules present, skipping\n'
    return 0
  fi
  saved="$(mktemp -d 2>/dev/null)" || saved=""
  if [ -n "$saved" ]; then
    for f in package.json bun.lock bun.lockb pnpm-lock.yaml package-lock.json yarn.lock; do
      [ -f "$dir/$f" ] && cp -p "$dir/$f" "$saved/$f"
    done
  fi
  top=""
  before=""
  nmod=0
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"
    before="$(git -C "$dir" -c core.quotepath=off diff --name-only -- . 2>/dev/null)"
    # Snapshot the bytes of every tracked file that is ALREADY modified (unstaged edit or deletion), so an
    # install that rewrites one of them cannot lose that earlier work.
    if [ -n "$saved" ]; then
      mkdir -p "$saved/mod"
      : > "$saved/mod.list"
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        nmod=$((nmod + 1))
        printf '%s\n' "$path" >> "$saved/mod.list"
        if [ -f "$top/$path" ]; then cp -p "$top/$path" "$saved/mod/$nmod"; fi
      done <<EOF
$before
EOF
    fi
  fi
  (cd "$dir" && dprep__install_here "$kind") || rc=$?
  if [ -n "$saved" ]; then
    for f in package.json bun.lock bun.lockb pnpm-lock.yaml package-lock.json yarn.lock; do
      if [ -f "$saved/$f" ] && ! cmp -s "$saved/$f" "$dir/$f"; then
        if cp -p "$saved/$f" "$dir/$f"; then
          printf 'dprep: restored %s/%s\n' "$dir" "$f"
        else
          printf 'dprep: RESTORE FAILED %s/%s\n' "$dir" "$f"
          rfail=1
        fi
      fi
    done
  fi
  if [ -n "$top" ]; then
    after="$(git -C "$dir" -c core.quotepath=off diff --name-only -- . 2>/dev/null)"
    # Files the install newly modified go back to their indexed content.
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if ! printf '%s\n' "$before" | grep -qxF -- "$path"; then
        if git -C "$top" checkout -- "$path" 2>/dev/null; then
          printf 'dprep: restored %s\n' "$path"
        else
          printf 'dprep: RESTORE FAILED %s\n' "$path"
          rfail=1
        fi
      fi
    done <<EOF
$after
EOF
    # Files that were already modified before the install go back to the exact bytes they had.
    if [ -n "$saved" ] && [ -f "$saved/mod.list" ]; then
      nmod=0
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        nmod=$((nmod + 1))
        if [ -f "$saved/mod/$nmod" ]; then
          if ! cmp -s "$saved/mod/$nmod" "$top/$path"; then
            # The install may have removed the parent folder of an edited file: recreate it first.
            if mkdir -p "$(dirname "$top/$path")" && cp -p "$saved/mod/$nmod" "$top/$path"; then
              printf 'dprep: restored %s\n' "$path"
            else
              printf 'dprep: RESTORE FAILED %s\n' "$path"
              rfail=1
            fi
          fi
        elif [ -e "$top/$path" ]; then
          if rm -f "$top/$path"; then
            printf 'dprep: restored %s\n' "$path"
          else
            printf 'dprep: RESTORE FAILED %s\n' "$path"
            rfail=1
          fi
        fi
      done < "$saved/mod.list"
    fi
  fi
  if [ "$rfail" -ne 0 ]; then
    # Never delete the only copy of an earlier edit: keep the snapshots and say where they are.
    printf 'dprep: restore failed in %s; snapshots kept in %s\n' "$dir" "${saved:-none}"
    [ "$rc" -eq 0 ] && rc=1
  elif [ -n "$saved" ]; then
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
