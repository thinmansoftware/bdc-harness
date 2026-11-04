# scripts/lane/dprep.sh -- shared dependency-prep core for the bdc-feature-development lanes.
#
# SOURCED (not executed) by the prep-dependencies and run-stop-tests nodes of all 13
# .archon/workflows/defaults/bdc-feature-development*.yaml lanes. The image ships it at
# /app/scripts/lane/dprep.sh (Dockerfile: COPY scripts/lane/). Before this file existed
# the function was inlined twice per lane (26 copies); one copy now keeps them in step.
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

dprep_ensure_js_deps() {
  local kind="" rc=0
  if [ -f package.json ]; then
    if [ -f bun.lock ] || [ -f bun.lockb ]; then
      kind="bun"
    elif [ -f pnpm-lock.yaml ]; then
      # Unchanged from the inline core: a pnpm lockfile without pnpm on PATH skips
      # rather than falling through to another package manager.
      if command -v pnpm >/dev/null 2>&1; then kind="pnpm"; fi
    elif [ -f package-lock.json ]; then
      kind="npm"
    fi
  fi
  if [ -z "$kind" ]; then
    printf 'dprep: no package.json with a supported lockfile (bun, pnpm, package-lock.json), skipping\n'
    return 0
  fi
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
