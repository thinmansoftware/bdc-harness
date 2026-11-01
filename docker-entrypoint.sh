#!/bin/bash
set -e

# Emit one timing line per boot phase. SECONDS is the shell uptime; the mark
# is the start of the phase that just finished.
archon_boot_phase() {
  echo "[archon] boot-phase ${1} $((SECONDS - archon_phase_mark))s" >&2
  archon_phase_mark=$SECONDS
}

# Restore dotglob to the state captured before a targeted child scan.
# "1" means it was already on; any other value means it was off.
archon_restore_dotglob() {
  if [ "$1" = "1" ]; then
    shopt -s dotglob
  else
    shopt -u dotglob
  fi
}

# Print the supplied ownership message unchanged.
# Fatal exits the entrypoint. Warn returns nonzero so the caller can stop
# the current tree and continue booting.
archon_chown_fail() {
  echo "$2" >&2
  if [ "$1" = "fatal" ]; then
    exit 1
  fi
  return 1
}

# Fix ownership of one tree.
# ARCHON_FULL_CHOWN=1 (exactly) restores the historical recursive chown.
# Otherwise chown the root and each direct child with -h, and recurse with
# -Rh only into a child whose owner is not appuser, whose stat fails, or
# where a depth-2 probe finds a mismatch (or the probe itself fails).
# -h / -Rh do not follow symlinks. The first chown failure stops the tree.
archon_chown_tree() {
  local root="$1"
  local mode="$2"
  local message="$3"
  local child owner mismatch find_status need_recursive dotglob_was_set

  if [ "${ARCHON_FULL_CHOWN:-}" = "1" ]; then
    if ! chown -Rh appuser:appuser "$root" 2>/dev/null; then
      archon_chown_fail "$mode" "$message" || return 0
    fi
    return 0
  fi

  if ! chown -h appuser:appuser "$root" 2>/dev/null; then
    archon_chown_fail "$mode" "$message" || return 0
  fi

  dotglob_was_set=0
  if shopt -q dotglob; then
    dotglob_was_set=1
  fi
  shopt -s dotglob

  for child in "$root"/*; do
    # Unmatched globs leave a literal path. Broken symlinks are still processed.
    if [ ! -e "$child" ] && [ ! -L "$child" ]; then
      continue
    fi

    owner=""
    if ! owner="$(stat -c %U "$child" 2>/dev/null)"; then
      owner=""
    fi

    mismatch=""
    find_status=0
    mismatch="$(find "$child" -maxdepth 2 ! -user appuser -print -quit 2>/dev/null)" || find_status=$?

    need_recursive=0
    if [ -z "$owner" ] || [ "$owner" != "appuser" ] || [ "$find_status" -ne 0 ] || [ -n "$mismatch" ]; then
      need_recursive=1
    fi

    if [ "$need_recursive" = "1" ]; then
      if ! chown -Rh appuser:appuser "$child" 2>/dev/null; then
        archon_restore_dotglob "$dotglob_was_set"
        archon_chown_fail "$mode" "$message" || return 0
      fi
    else
      if ! chown -h appuser:appuser "$child" 2>/dev/null; then
        archon_restore_dotglob "$dotglob_was_set"
        archon_chown_fail "$mode" "$message" || return 0
      fi
    fi
  done

  archon_restore_dotglob "$dotglob_was_set"
  return 0
}

# Test seam for the ownership phase. Production keeps the cursor-config seed
# inline and does not call this function, so tests do not execute that copy.
archon_ownership_phase() {
  archon_phase_mark=$SECONDS
  archon_chown_tree "$1" fatal "ERROR: Failed to fix ownership of /.archon -- volume may be read-only or mounted with incompatible options"
  archon_chown_tree "$2" fatal "ERROR: Failed to fix ownership of /home/appuser -- volume may be read-only or mounted with incompatible options"
  if [ -d "$3" ]; then
    archon_chown_tree "$3" warn "WARN: Failed to chown /host-artifacts -- bundles may fail to write. Check host directory permissions."
  fi
  archon_boot_phase ownership
}

# Register git repos under root as safe.directory, bounded to depth 7.
# Depth 7 covers:
#   /.archon/workspaces/<owner>/<repo>/source/.git                    (depth 5)
#   /.archon/worktrees/<owner>/<repo>/<branch>/.git                   (depth 5)
#   /.archon/workspaces/<owner>/<repo>/worktrees/<branch>/.git        (depth 6)
#   /.archon/workspaces/<owner>/<repo>/worktrees/<lane>/<task>/.git   (depth 7)
# Worktrees deeper than 7 (branch names with extra path separators, or
# repo-local worktree paths) are not registered by this bounded scan.
# The existing safe.directory list is read once in this shell, not once per repo.
archon_register_safe_directories() {
  local root="$1"
  local safe_list git_dir repo_dir

  safe_list="$($RUNNER git config --global --get-all safe.directory 2>/dev/null || true)"

  # Do not add -L or -follow: a symlink named .git must not walk another tree.
  find "$root" -maxdepth 7 -name ".git" -prune -print 2>/dev/null | while IFS= read -r git_dir; do
    repo_dir="$(dirname "$git_dir")"
    if ! printf '%s\n' "$safe_list" | grep -qxF "$repo_dir"; then
      $RUNNER git config --global --add safe.directory "$repo_dir"
    fi
  done

  archon_boot_phase safe-directory
}

archon_entrypoint_main() {
  archon_phase_mark=$SECONDS

  # Ensure required subdirectories exist.
  # Named volumes inherit these from the image layer on first run; bind mounts do not,
  # which causes the Claude subprocess to fail silently when spawned with a missing cwd.
  mkdir -p /.archon/workspaces /.archon/worktrees

  # Determine if we need to use gosu for privilege dropping
  if [ "$(id -u)" = "0" ]; then
    # Running as root: fix volume permissions, then drop to appuser.
    # Full-tree chown is opt-in (ARCHON_FULL_CHOWN=1) so a multi-million-file
    # /.archon bind mount does not walk every inode on boot.
    archon_chown_tree /.archon fatal \
      "ERROR: Failed to fix ownership of /.archon -- volume may be read-only or mounted with incompatible options"
    # /home/appuser is persisted to a named volume (or bind-mounted via
    # ARCHON_USER_HOME) so Claude/Codex/Pi config, ~/.gitconfig, shell history,
    # and other user-specific state survive rebuilds. On bind mounts, host UIDs
    # don't map to appuser (1001), so fix ownership the same way we do /.archon.
    archon_chown_tree /home/appuser fatal \
      "ERROR: Failed to fix ownership of /home/appuser -- volume may be read-only or mounted with incompatible options"
    # PR #848: seed cursor-agent auth state from the read-only host mount.
    # docker-compose.yml binds ${CURSOR_CONFIG_HOST_PATH:-/dev/null} at
    # /run/secrets/cursor-config. Only a non-empty DIRECTORY is copied; the
    # /dev/null default (a char device) is skipped silently. Copying (rather than
    # mounting over ~/.cursor) keeps ~/.cursor writable for cursor-agent's own
    # state. CURSOR_API_KEY in the environment needs no files at all.
    if [ -d /run/secrets/cursor-config ] && [ -n "$(ls -A /run/secrets/cursor-config 2>/dev/null)" ]; then
      mkdir -p /home/appuser/.cursor
      if cp -a /run/secrets/cursor-config/. /home/appuser/.cursor/ 2>/dev/null; then
        chown -Rh appuser:appuser /home/appuser/.cursor
        echo "[archon] cursor-agent auth state seeded from /run/secrets/cursor-config" >&2
      else
        echo "[archon] WARN: failed to copy /run/secrets/cursor-config into /home/appuser/.cursor -- cursor judge rung / provider will report Authentication required unless CURSOR_API_KEY is set" >&2
      fi
    fi
    # WO-168 Tier 1: /host-artifacts is a host bind mount for load-bearing
    # workflow output (git bundles, raw artifacts). Workflow nodes run as
    # appuser, so we must own it. Best-effort: if the mount is missing
    # (older docker-compose without the new volume), do not block startup.
    if [ -d /host-artifacts ]; then
      archon_chown_tree /host-artifacts warn \
        "WARN: Failed to chown /host-artifacts -- bundles may fail to write. Check host directory permissions."
    fi
    archon_boot_phase ownership
    RUNNER="gosu appuser"
  else
    # Already running as non-root (e.g., --user flag or Kubernetes)
    RUNNER=""
  fi

  # Warn if vars known to be ignored inside the container were set via env_file: .env.
  # These leak in but have no effect (ARCHON_HOME is overridden to /.archon by source;
  # ARCHON_DATA is a host-side compose substitution token, never read by the container).
  if [ -n "${ARCHON_HOME:-}" ]; then
    echo "[archon] ARCHON_HOME=${ARCHON_HOME} ignored in Docker (container home is fixed at /.archon)" >&2
  fi
  if [ -n "${ARCHON_DATA:-}" ]; then
    echo "[archon] ARCHON_DATA=${ARCHON_DATA} is a host-side compose token; not read inside the container" >&2
  fi

  # Git 2.35.2+ (CVE-2022-24765) rejects repos owned by a different UID.
  # On macOS bind mounts (VirtioFS), host UIDs don't map to appuser (1001),
  # so git prints "dubious ownership" and refuses all operations.
  # The Dockerfile RUN-layer registers fixed paths, but that gitconfig lives
  # in the image layer -- bind mounts don't inherit it on restart.
  # With /home/appuser now persisted, ~/.gitconfig survives across restarts --
  # so we must check before --add or duplicate safe.directory lines accumulate
  # every boot.
  archon_register_safe_directories /.archon

  # Configure git to use a GitHub token for HTTPS clones AND pushes via credential
  # helper. Accept either GH_TOKEN (gh CLI legacy) or GITHUB_TOKEN (compose default
  # in this fork -- see WO-HARNESS-CONTAINER-GITHUB-AUTH-BOUNDARY-01 / #171).
  # Uses a helper function so the token stays in the environment, not in ~/.gitconfig.
  _GH_AUTH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$_GH_AUTH_TOKEN" ]; then
    # Export both names so child processes (gh CLI, bun workflow nodes spawning git)
    # find whichever they look for. The credential helper reads GH_AUTH_TOKEN_INTERNAL
    # to avoid coupling to either upstream name.
    export GH_AUTH_TOKEN_INTERNAL="$_GH_AUTH_TOKEN"
    export GH_TOKEN="${GH_TOKEN:-$_GH_AUTH_TOKEN}"
    export GITHUB_TOKEN="${GITHUB_TOKEN:-$_GH_AUTH_TOKEN}"
    $RUNNER git config --global credential."https://github.com".helper \
      '!f() { echo "username=x-access-token"; echo "password=${GH_AUTH_TOKEN_INTERNAL}"; }; f'

    # Pre-flight: verify the token actually authenticates. We use `gh auth status`
    # because an UNauthenticated ls-remote against a public repo always succeeds
    # and proves nothing about the token. gh auth status is the cheapest call that
    # actually exercises token + scopes. Failure is LOUD but non-fatal -- a stale
    # token must not block container startup; workflows that try to push will
    # surface the error in their own run logs. Result written to /tmp so future
    # healthcheck wiring can pick it up.
    if command -v gh >/dev/null 2>&1 && gh auth status 2>&1 | grep -q "Logged in to github.com"; then
      echo "[archon] GitHub auth pre-flight: OK (token authenticates to github.com)" >&2
      echo "ok" > /tmp/github-auth-preflight.status
    else
      echo "[archon] ERROR: GitHub auth pre-flight FAILED -- token is missing, expired, or lacks scope. Workflows that push branches/PRs will fail. Refresh GITHUB_TOKEN in .env and restart. See docs/operations/container-github-auth.md." >&2
      echo "fail" > /tmp/github-auth-preflight.status
    fi
  else
    echo "[archon] WARN: No GITHUB_TOKEN or GH_TOKEN set -- git push and gh CLI will fail. Workflows that author PRs (bdc-author-wo-batch, sync-workflows, engine sortie) will silently fail. See docs/operations/container-github-auth.md." >&2
    echo "missing" > /tmp/github-auth-preflight.status
  fi
  unset _GH_AUTH_TOKEN

  if [ -n "${GITHUB_APP_RUN_NODES_ID:-}" ] && [ "${GITHUB_APP_RUN_NODES_ID:-}" != "${GITHUB_APP_ID:-}" ]; then
    $RUNNER git config --global credential."https://github.com".helper \
      '!f() { if [ "$1" = get ]; then token=$(bun /app/scripts/github-service-token.ts run_nodes) || exit; printf "username=x-access-token\npassword=%s\n" "$token"; fi; }; f'
  elif [ -n "${GITHUB_APP_RUN_NODES_ID:-}" ]; then
    echo "[archon] ERROR: GITHUB_APP_RUN_NODES_ID equals GITHUB_APP_ID -- builder App would be the reviewer; App helper NOT installed, git push uses the PAT" >&2
  fi
  archon_boot_phase github-auth

  # Pin the glibc Claude Code binary to bypass the SDK's musl-first resolver.
  # Bun's hoisted linker installs both glibc and musl optional-dep variants for
  # the current CPU arch; the SDK picks musl first, which fails to execute on
  # this Debian (glibc) image. Only sets CLAUDE_BIN_PATH if the user has not
  # already provided one via docker run -e or docker-compose env_file.
  if [ -z "${CLAUDE_BIN_PATH:-}" ]; then
    case "$(uname -m)" in
      x86_64)  _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" ;;
      aarch64) _CLAUDE_BIN_CANDIDATE="/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude" ;;
      *)
        echo "ERROR: Unsupported CPU architecture $(uname -m). Set CLAUDE_BIN_PATH manually to a glibc Claude binary." >&2
        exit 1
        ;;
    esac
    if [ -x "$_CLAUDE_BIN_CANDIDATE" ]; then
      export CLAUDE_BIN_PATH="$_CLAUDE_BIN_CANDIDATE"
    else
      echo "ERROR: Pinned Claude binary missing or non-executable at ${_CLAUDE_BIN_CANDIDATE}. The SDK package layout may have changed; set CLAUDE_BIN_PATH manually." >&2
      exit 1
    fi
    unset _CLAUDE_BIN_CANDIDATE
  fi
  archon_boot_phase claude-bin

  # Run setup-auth (exits after configuring Codex credentials), then exec the server
  # exec ensures bun is PID 1 and receives SIGTERM for graceful shutdown
  $RUNNER bun run setup-auth
  archon_boot_phase setup-auth

  # BDC fork (WO-HARNESS-PROVIDER-PROACTIVE-AUTH-REFRESH-01, Layer 5):
  # Proactively refresh Claude + Codex OAuth tokens if they're stale at boot.
  # Container may have been stopped for >12h; refresh now so the first
  # workflow/chat doesn't pay the refresh cost. Failure is best-effort -- the
  # script always exits 0 and the reactive refresh path (PR #48) catches
  # any 401 that slips through.
  $RUNNER bun run verify-auth || true
  archon_boot_phase verify-auth

  echo "[archon] entrypoint-ready after ${SECONDS}s" >&2
  exec $RUNNER bun run start
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  archon_entrypoint_main "$@"
fi
