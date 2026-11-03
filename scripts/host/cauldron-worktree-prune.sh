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
# Deletes thread-* worktree dirs older than RETENTION_DAYS across all workspace
# repos. Active runs are protected by age: a run in flight wrote its worktree
# within the last RETENTION_DAYS, so it is never matched.
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

log() {
  echo "$(date --utc +%Y-%m-%dT%H:%M:%SZ) | $*" >> "$LOG"
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
WTCOUNT=$(printf '%s\n' "$LIST" | grep -c . || true)
if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "$LIST" | grep . | while read -r wt; do du -sh "$wt" 2>/dev/null; done
  echo "DRY_RUN would prune ${WTCOUNT} worktrees older than ${RETENTION_DAYS}d"
  exit 0
fi
printf '%s\n' "$LIST" | grep . | while read -r wt; do rm -rf "$wt"; done

# Drop git's bookkeeping for the removed worktrees in every source clone.
for src in "$WTROOT"/*/*/source; do
  [ -d "$src/.git" ] || continue
  git -C "$src" worktree prune 2>/dev/null || log "WARN worktree prune failed: $src"
done

AFTER_FREE=$(df -h / | awk 'NR==2{print $4}')
AFTER_SDB=$(df -h /mnt/bdc-builds | awk 'NR==2{print $4}')

log "DONE pruned=${WTCOUNT} worktrees older than ${RETENTION_DAYS}d | free / before=${BEFORE_FREE} after=${AFTER_FREE} | free sdb before=${BEFORE_SDB} after=${AFTER_SDB}"

exit 0
