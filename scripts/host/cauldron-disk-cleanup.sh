#!/bin/bash
# Cauldron / Devil's Cauldron disk hygiene sweep.
# Two independent problems, two independent actions -- do not conflate them:
#   1. Orphaned build worktrees (web-conversation envs that never close --
#      see BDC_XO memory reference_worktree-orphan-gap-web-envs-immortal.md).
#      This is a BUG band-aid. Age-gated so a run still in progress is never touched.
#   2. Stale staging/rollback Docker images+containers from concluded deploy
#      rounds. This is RETENTION, not a bug -- age-gated with a keep-latest-N floor
#      so an active rollback target is never pruned out from under John.
set -uo pipefail
LOG="/opt/bdc/backups/cauldron-cleanup.log"
# 2026-11-03: every owner (was bluedevilcollectibles only; work moved to thinmansoftware).
WORKSPACES_ROOT="/opt/bdc/archon-data/workspaces"
DRY_RUN="${DRY_RUN:-0}"
STAGING_MAX_AGE_DAYS=3
KEEP_LATEST_STAGING_IMAGES=2

# Git metadata in the workspaces holds container paths (/.archon/workspaces/...),
# so git commands for them run inside the harness container.
CONTAINER="${CONTAINER:-archon-app-1}"
CWT_ROOT="/.archon/workspaces"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

# Prints a reason and returns 1 when the worktree must be kept. The top-level
# mtime does not move when files deeper in the tree are edited, so age alone does
# not prove a worktree is abandoned. The process check matches on the
# <owner>/<repo>/worktrees/<lane>/<name> suffix so it also catches processes in
# the container, whose paths differ from the host path.
is_abandoned() {
  local wt="$1" suffix pid cwd st
  if [ -n "$(find "$wt" -mmin "-$((STAGING_MAX_AGE_DAYS * 1440))" -print -quit 2>/dev/null)" ]; then
    echo "recent-file"; return 1
  fi
  suffix="${wt#"$WORKSPACES_ROOT"/}"
  for pid in /proc/[0-9]*; do
    cwd=$(readlink "$pid/cwd" 2>/dev/null) || continue
    case "$cwd" in */"$suffix"|*/"$suffix"/*) echo "process ${pid#/proc/}"; return 1;; esac
  done
  st=$(docker exec -u appuser "$CONTAINER" git -C "$CWT_ROOT/$suffix" status --porcelain --untracked-files=all 2>/dev/null) || { echo "git-status-failed"; return 1; }
  [ -z "$st" ] || { echo "uncommitted-changes"; return 1; }
  return 0
}

log "=== cauldron-disk-cleanup start ==="
df -h / | tail -1 | tee -a "$LOG"

# --- 1. Orphaned build worktrees (age-gated: only dirs untouched > 3 days; was 24h until 2026-11-03 -- repair-in-place and long arcs idle > 24h) ---
for repo_worktrees in "$WORKSPACES_ROOT"/*/*/worktrees/*; do
  [ -d "$repo_worktrees" ] || continue
  find "$repo_worktrees" -maxdepth 1 -mindepth 1 -type d -mmin +4320 -print 2>/dev/null | while read -r wt; do
    if ! why=$(is_abandoned "$wt"); then
      log "keep worktree: $wt ($why)"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then du -sh "$wt" 2>/dev/null; continue; fi
    log "removing stale worktree: $wt"
    sudo rm -rf "$wt"
  done
done
if [ "$DRY_RUN" = "1" ]; then echo "DRY_RUN: worktree section only; nothing removed"; exit 0; fi

# Prune git's own worktree bookkeeping in each repo's source clone. This runs in
# the container: on the host every recorded worktree path (/.archon/...) looks
# missing, so a host-side prune would drop live worktrees too.
for src in "$WORKSPACES_ROOT"/*/*/source; do
  [ -d "$src/.git" ] || continue
  docker exec -u appuser "$CONTAINER" git -C "$CWT_ROOT/${src#"$WORKSPACES_ROOT"/}" worktree prune 2>&1 | sed "s#^#[prune $src] #" | tee -a "$LOG"
done

# --- 2. Stale staging/rollback Docker artifacts (age + keep-latest-N floor) ---
# SCOPE: only Cauldron's own naming convention (archon-m<N>-staging*,
# archon-m<N>-attempt*, archon-rollback:m<N>). Anchor 2026-07-17: a naive
# *staging* substring match killed the unrelated long-running
# bug-lifecycle-staging service (5-week uptime) on first run. Never widen this
# pattern to a bare "staging"/"rollback" substring match again.
# Only STOPPED containers are removed: a running archon-m<N>-staging service is a
# live deployment however old it is. Age comes from the full RFC 3339 .Created
# timestamp (date and time), not the date alone.
container_cutoff=$(date -d "-${STAGING_MAX_AGE_DAYS} days" +%s)
docker ps -a --filter status=exited --filter status=created --filter status=dead --format '{{.Names}}' \
  | grep -E '^archon-m[0-9]+-(staging|attempt)' \
  | while read -r c; do
    created=$(date -d "$(docker inspect -f '{{.Created}}' "$c" 2>/dev/null)" +%s 2>/dev/null) || continue
    if [ "$created" -gt "$container_cutoff" ]; then
      log "skip (stopped, newer than ${STAGING_MAX_AGE_DAYS}d): $c"
      continue
    fi
    log "removing stale stopped container: $c"
    docker rm "$c" >>"$LOG" 2>&1
  done

# Newest first by creation time (not by tag text: m9 sorts after m11 as text).
# Matches archon:m<N>-staging* and archon-rollback:m<N>*.
mapfile -t staging_images < <(docker images --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' \
  | grep -E '\|(archon:m[0-9]+-staging|archon-rollback:m[0-9]+)' \
  | sort -r | cut -d'|' -f2)
cutoff=$(date -d "-${STAGING_MAX_AGE_DAYS} days" +%s)
if [ "${#staging_images[@]}" -gt "$KEEP_LATEST_STAGING_IMAGES" ]; then
  for img in "${staging_images[@]:$KEEP_LATEST_STAGING_IMAGES}"; do
    created=$(date -d "$(docker image inspect -f '{{.Created}}' "$img" 2>/dev/null)" +%s 2>/dev/null) || continue
    if [ "$created" -gt "$cutoff" ]; then
      log "skip (newer than ${STAGING_MAX_AGE_DAYS}d): $img"
    elif ! docker ps -a --format '{{.Image}}' | grep -qx "$img"; then
      log "removing stale image: $img"
      docker rmi "$img" >>"$LOG" 2>&1
    else
      log "skip (still referenced by a container): $img"
    fi
  done
fi

docker image prune -f >>"$LOG" 2>&1
docker builder prune -f --keep-storage 5GB >>"$LOG" 2>&1

log "=== cauldron-disk-cleanup end ==="
df -h / | tail -1 | tee -a "$LOG"
