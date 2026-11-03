#!/usr/bin/env bash
# cauldron-worktree-prune.sh
# Prune stale Cauldron thread worktrees on the Hetzner host.
#
# ROOT CAUSE (2026-06-06 disk-full incident): Cauldron creates one git worktree
# per run under .archon/workspaces/<org>/<repo>/worktrees/archon/thread-<id>/ and
# NEVER deletes them. 94 bdc-harness worktrees alone = 21GB. The existing
# docker-disk-hygiene.sh only reclaims Docker build cache + dangling images, which
# does NOT touch worktrees. This script closes that gap.
#
# Deletes thread-* and task-* worktree dirs whose top-level mtime is older than
# RETENTION_DAYS across all workspace repos, but only when the worktree is also
# abandoned (see is_abandoned): no file in it changed within RETENTION_DAYS, no
# process has its cwd inside it, and git reports no uncommitted changes. The
# top-level mtime alone does not move when files deeper in the tree are edited.
#
# Installed: /usr/local/sbin/cauldron-worktree-prune.sh
# Cron:      /etc/cron.d/cauldron-worktree-prune (daily 05:00)
# Log:       /var/log/cauldron-worktree-prune.log

set -u

RETENTION_DAYS="${RETENTION_DAYS:-3}"
# 2026-11-03: all owners, not just bluedevilcollectibles. Work moved to
# thinmansoftware and this script pruned 0 worktrees from 10/29 to 11/03 while
# /mnt/bdc-builds filled to 100% and took the harness down.
WTROOT="/opt/bdc/archon-data/workspaces"
DRY_RUN="${DRY_RUN:-0}"
LOG="/var/log/cauldron-worktree-prune.log"
# Git metadata in the workspaces holds container paths (/.archon/workspaces/...),
# so git commands for them run inside the harness container.
CONTAINER="${CONTAINER:-archon-app-1}"
CWT_ROOT="/.archon/workspaces"

log() {
  echo "$(date --utc +%Y-%m-%dT%H:%M:%SZ) | $*" >> "$LOG"
}

# Prints a reason and returns 1 when the worktree must be kept.
# The process check matches on the <owner>/<repo>/worktrees/archon/<name> suffix,
# so it also catches processes inside the container, whose paths differ from the
# host path.
is_abandoned() {
  local wt="$1" suffix pid cwd
  if [ -n "$(find "$wt" -mmin "-$((RETENTION_DAYS * 1440))" -print -quit 2>/dev/null)" ]; then
    echo "recent-file"; return 1
  fi
  suffix="${wt#"$WTROOT"/}"
  for pid in /proc/[0-9]*; do
    cwd=$(readlink "$pid/cwd" 2>/dev/null) || continue
    case "$cwd" in */"$suffix"|*/"$suffix"/*) echo "process ${pid#/proc/}"; return 1;; esac
  done
  # The worktree's .git points at a container path, so git runs in the container.
  # If git cannot answer (container down, broken worktree), keep it.
  local st
  st=$(docker exec -u appuser "$CONTAINER" git -C "$CWT_ROOT/$suffix" status --porcelain 2>/dev/null) || { echo "git-status-failed"; return 1; }
  [ -z "$st" ] || { echo "uncommitted-changes"; return 1; }
  return 0
}

if [ ! -d "$WTROOT" ]; then
  log "SKIP workspace root not found: $WTROOT"
  exit 0
fi

BEFORE_FREE=$(df -h / | awk 'NR==2{print $4}')
BEFORE_SDB=$(df -h /mnt/bdc-builds | awk 'NR==2{print $4}')

# Count then delete thread-* and task-* worktree dirs older than retention, under
# <owner>/<repo>/worktrees/archon/ for every owner.
LIST=$(find "$WTROOT" -mindepth 5 -maxdepth 5 -type d \( -name "thread-*" -o -name "task-*" \) -path "*/worktrees/archon/*" -mtime "+${RETENTION_DAYS}" 2>/dev/null)
WTCOUNT=0
KEPT=0
while read -r wt; do
  [ -n "$wt" ] || continue
  if ! why=$(is_abandoned "$wt"); then
    KEPT=$((KEPT + 1))
    log "KEEP $wt ($why)"
    [ "$DRY_RUN" = "1" ] && echo "KEEP $wt ($why)"
    continue
  fi
  WTCOUNT=$((WTCOUNT + 1))
  if [ "$DRY_RUN" = "1" ]; then du -sh "$wt" 2>/dev/null; continue; fi
  rm -rf "$wt"
done <<< "$LIST"
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN would prune ${WTCOUNT} worktrees older than ${RETENTION_DAYS}d (kept ${KEPT})"
  exit 0
fi

# Drop git's bookkeeping for the removed worktrees in every source clone. This
# runs in the container: on the host every recorded worktree path (/.archon/...)
# looks missing, so a host-side prune would drop live worktrees too.
for src in "$WTROOT"/*/*/source; do
  [ -d "$src/.git" ] || continue
  docker exec -u appuser "$CONTAINER" git -C "$CWT_ROOT/${src#"$WTROOT"/}" worktree prune 2>/dev/null || log "WARN worktree prune failed: $src"
done

AFTER_FREE=$(df -h / | awk 'NR==2{print $4}')
AFTER_SDB=$(df -h /mnt/bdc-builds | awk 'NR==2{print $4}')

log "DONE pruned=${WTCOUNT} kept=${KEPT} worktrees older than ${RETENTION_DAYS}d | free / before=${BEFORE_FREE} after=${AFTER_FREE} | free sdb before=${BEFORE_SDB} after=${AFTER_SDB}"

exit 0
