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

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

log "=== cauldron-disk-cleanup start ==="
df -h / | tail -1 | tee -a "$LOG"

# --- 1. Orphaned build worktrees (age-gated: only dirs untouched > 3 days; was 24h until 2026-11-03 -- repair-in-place and long arcs idle > 24h) ---
for repo_worktrees in "$WORKSPACES_ROOT"/*/*/worktrees/*; do
  [ -d "$repo_worktrees" ] || continue
  find "$repo_worktrees" -maxdepth 1 -mindepth 1 -type d -mmin +4320 -print 2>/dev/null | while read -r wt; do
    if [ "$DRY_RUN" = "1" ]; then du -sh "$wt" 2>/dev/null; continue; fi
    log "removing stale worktree: $wt"
    sudo rm -rf "$wt"
  done
done
if [ "$DRY_RUN" = "1" ]; then echo "DRY_RUN: worktree section only; nothing removed"; exit 0; fi

# Prune git's own worktree bookkeeping in each repo's source clone
for src in "$WORKSPACES_ROOT"/*/*/source; do
  [ -d "$src/.git" ] || continue
  (cd "$src" && sudo git worktree prune 2>&1 | sed "s#^#[prune $src] #" | tee -a "$LOG")
done

# --- 2. Stale staging/rollback Docker artifacts (age + keep-latest-N floor) ---
# SCOPE: only Cauldron's own naming convention (archon-m<N>-staging*,
# archon-m<N>-attempt*, archon-rollback:m<N>). Anchor 2026-07-17: a naive
# *staging* substring match killed the unrelated long-running
# bug-lifecycle-staging service (5-week uptime) on first run. Never widen this
# pattern to a bare "staging"/"rollback" substring match again.
mapfile -t stale_containers < <(docker ps -a --format '{{.Names}}\t{{.CreatedAt}}' \
  | grep -E '^archon-m[0-9]+-(staging|attempt)' \
  | awk -v days="$STAGING_MAX_AGE_DAYS" '
    { split($2, d, " "); cmd = "date -d \"" d[1] " " d[2] "\" +%s"; cmd | getline created; close(cmd);
      cmd2 = "date +%s"; cmd2 | getline now; close(cmd2);
      age_days = (now - created) / 86400;
      if (age_days > days) print $1 }')
for c in "${stale_containers[@]:-}"; do
  [ -z "$c" ] && continue
  log "removing stale container: $c"
  docker rm -f "$c" >>"$LOG" 2>&1
done

mapfile -t staging_images < <(docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep -E '^archon(-rollback)?:m[0-9]+-(staging|attempt)?' \
  | grep -E ':m[0-9]+-staging|^archon-rollback:m[0-9]+' | sort -r)
if [ "${#staging_images[@]}" -gt "$KEEP_LATEST_STAGING_IMAGES" ]; then
  for img in "${staging_images[@]:$KEEP_LATEST_STAGING_IMAGES}"; do
    if ! docker ps -a --format '{{.Image}}' | grep -qx "$img"; then
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
