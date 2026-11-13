#!/usr/bin/env bash
# archon-db-backup-retention.sh
# Report on the archon.db pre-rebuild snapshots and, only when told to, delete
# old ones. WO-HARNESS-REBUILD-BACKUP-RETENTION-01 (Amendment 1).
#
# Every M-181 rebuild writes archon.db.pre-rebuild-<STAMP> (about 2.2 GB) to
# /opt/bdc/backups/archon (the sdb disk). Nothing removes them. This script:
#
#   REPORT mode (default): lists the snapshots in each location, prints one
#   SNAPSHOT_REPORT line per location and one DISK_FREE line per filesystem, and
#   prints a SNAPSHOT_DISK_LOW line (exit 3) when a disk is below its floor. It
#   never moves, copies or deletes anything. Nothing is ever written to the root
#   filesystem except the log line (LOG).
#
#   DELETE mode, off by default: only when KEEP_NEWEST_SNAPSHOTS or
#   DELETE_AFTER_DAYS is set to a positive integer. Deletes only regular files
#   named archon.db.pre-rebuild-<YYYYMMDD>T<HHMM>Z, oldest first, with these limits:
#     - the newest max(3, KEEP_NEWEST_SNAPSHOTS) snapshots of the snapshot disk
#       (SDB_DIR) are never deleted;
#     - a file modified less than 24 hours ago is never deleted;
#     - KEEP_NEWEST_SNAPSHOTS deletes the SDB_DIR files beyond the newest N;
#     - DELETE_AFTER_DAYS deletes files older than N days in every location.
#   A value that is set but is not a positive integer stops the run (exit 2)
#   before anything is touched.
#   Each deletion is one SNAPSHOT_DELETED line (path and size).
#   DRY_RUN=1 prints WOULD_DELETE lines for the same plan and deletes nothing.
#
# Exit status: 0 ok, 2 bad setting, 3 a disk is below its floor, 4 a deletion
# failed (4 wins over 3).
#
# Installed: /usr/local/sbin/archon-db-backup-retention.sh
# Cron:      /etc/cron.d/archon-db-backup-retention (daily 04:45 UTC, report mode:
#            the cron line must NOT set KEEP_NEWEST_SNAPSHOTS or DELETE_AFTER_DAYS
#            until John records the answer to XO-Q-20261112-07)
# Log:       /var/log/archon-db-backup-retention.log

set -u
export LC_ALL=C

SDB_DIR="${SDB_DIR:-/opt/bdc/backups/archon}"
# Root-disk locations where earlier containment left copies (colon separated).
ROOT_DIRS="${ROOT_DIRS:-/opt/bdc/backups-root/archon-db-snapshots:/opt/bdc/backups-overflow-20261103:/opt/bdc/backups-overflow}"
SDB_DISK_PATH="${SDB_DISK_PATH:-/opt/bdc/backups}"
ROOT_DISK_PATH="${ROOT_DISK_PATH:-/}"
SDB_MIN_FREE_GB="${SDB_MIN_FREE_GB:-20}"
ROOT_MIN_FREE_GB="${ROOT_MIN_FREE_GB:-25}"
DRY_RUN="${DRY_RUN:-0}"
LOG="${LOG:-/var/log/archon-db-backup-retention.log}"
KEEP_NEWEST_SNAPSHOTS="${KEEP_NEWEST_SNAPSHOTS:-}"
DELETE_AFTER_DAYS="${DELETE_AFTER_DAYS:-}"
PREFIX="archon.db.pre-rebuild-"
KEEP_FLOOR=3
MIN_AGE_MINUTES=1440

# One line to stdout (cron mail) and to the log. A log that cannot be written
# does not stop the run.
say() {
  printf '%s\n' "$*"
  printf '%s | %s\n' "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true
}

is_positive_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ]
}

KEEP_SET=0
DAYS_SET=0
if [ -n "$KEEP_NEWEST_SNAPSHOTS" ]; then
  if ! is_positive_int "$KEEP_NEWEST_SNAPSHOTS"; then
    say "ERROR KEEP_NEWEST_SNAPSHOTS=${KEEP_NEWEST_SNAPSHOTS} is not a positive integer; nothing done"
    exit 2
  fi
  KEEP_SET=1
fi
if [ -n "$DELETE_AFTER_DAYS" ]; then
  if ! is_positive_int "$DELETE_AFTER_DAYS"; then
    say "ERROR DELETE_AFTER_DAYS=${DELETE_AFTER_DAYS} is not a positive integer; nothing done"
    exit 2
  fi
  DAYS_SET=1
fi
DELETE_MODE=0
if [ "$KEEP_SET" = 1 ] || [ "$DAYS_SET" = 1 ]; then DELETE_MODE=1; fi

# Protected count for SDB_DIR: the newest max(3, KEEP_NEWEST_SNAPSHOTS).
PROTECT="$KEEP_FLOOR"
if [ "$KEEP_SET" = 1 ] && [ "$KEEP_NEWEST_SNAPSHOTS" -gt "$PROTECT" ]; then
  PROTECT="$KEEP_NEWEST_SNAPSHOTS"
fi

NOW=$(date +%s)
EXIT=0

# Prints "<mtime-epoch> <size-bytes> <path>" for each snapshot file in $1,
# newest first (ties broken by path). A snapshot is a regular file named
# archon.db.pre-rebuild-<YYYYMMDD>T<HHMM>Z exactly (so a sidecar such as
# ...Z.sha256 is not one). No symlinks, no recursion.
list_snapshots() {
  [ -d "$1" ] || return 0
  find "$1" -maxdepth 1 -type f -regextype posix-extended -regex '.*/archon\.db\.pre-rebuild-[0-9]{8}T[0-9]{4}Z' -printf '%T@ %s %p\n' 2>/dev/null \
    | awk '{ sub(/\..*$/, "", $1); print }' \
    | sort -k1,1nr -k3,3r
}

report_location() {
  local dir="$1" label="$2" rows count total stamps oldest newest
  if [ ! -d "$dir" ]; then
    say "SNAPSHOT_REPORT location=${label} path=${dir} count=0 total_gb=0.00 oldest=- newest=- note=missing"
    return 0
  fi
  rows=$(list_snapshots "$dir")
  if [ -z "$rows" ]; then
    say "SNAPSHOT_REPORT location=${label} path=${dir} count=0 total_gb=0.00 oldest=- newest=-"
    return 0
  fi
  count=$(printf '%s\n' "$rows" | wc -l | tr -d ' ')
  total=$(printf '%s\n' "$rows" | awk '{ s += $2 } END { printf "%.2f", s / 1073741824 }')
  oldest=$(printf '%s\n' "$rows" | awk '{ n = split($3, p, "/"); print substr(p[n], length("'"$PREFIX"'") + 1) }' | sort | head -1)
  newest=$(printf '%s\n' "$rows" | awk '{ n = split($3, p, "/"); print substr(p[n], length("'"$PREFIX"'") + 1) }' | sort | tail -1)
  say "SNAPSHOT_REPORT location=${label} path=${dir} count=${count} total_gb=${total} oldest=${oldest} newest=${newest}"
}

# disk_free <label> <path> <min-gb>: prints DISK_FREE, then SNAPSHOT_DISK_LOW and
# sets EXIT=3 when free space is below the floor.
disk_free() {
  local label="$1" path="$2" min="$3" line avail_gb pct
  line=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 { print $4 " " $5 }')
  if [ -z "$line" ]; then
    say "ERROR DISK_FREE disk=${label} path=${path} df failed"
    [ "$EXIT" -lt 3 ] && EXIT=3
    return 0
  fi
  avail_gb=$(printf '%s\n' "$line" | awk '{ printf "%.1f", $1 / 1048576 }')
  pct=$(printf '%s\n' "$line" | awk '{ print $2 }')
  say "DISK_FREE disk=${label} path=${path} free_gb=${avail_gb} used=${pct}"
  if awk -v a="$avail_gb" -v m="$min" 'BEGIN { exit !(a + 0 < m + 0) }'; then
    say "SNAPSHOT_DISK_LOW disk=${label} path=${path} free_gb=${avail_gb} min_free_gb=${min}"
    [ "$EXIT" -lt 3 ] && EXIT=3
  fi
  return 0
}

# plan_deletes: prints "<mtime> <path>" for each file to delete.
plan_deletes() {
  local now_cut age_cut dir
  now_cut=$((NOW - MIN_AGE_MINUTES * 60))
  age_cut=0
  if [ "$DAYS_SET" = 1 ]; then age_cut=$((NOW - DELETE_AFTER_DAYS * 86400)); fi

  # SDB_DIR: rank by age, newest first; the newest PROTECT are never listed.
  list_snapshots "$SDB_DIR" | awk -v prot="$PROTECT" -v keepset="$KEEP_SET" -v keep="$KEEP_NEWEST_SNAPSHOTS"       -v dayset="$DAYS_SET" -v agecut="$age_cut" -v nowcut="$now_cut" '
    NF {
      rank++
      if (rank <= prot) next
      if ($1 + 0 > nowcut + 0) next
      if (keepset == 1 && rank > keep) { print $1, $3; next }
      if (dayset == 1 && $1 + 0 < agecut + 0) print $1, $3
    }'

  # Root locations: DELETE_AFTER_DAYS only.
  if [ "$DAYS_SET" = 1 ]; then
    for dir in $(printf '%s
' "$ROOT_DIRS" | tr ':' ' '); do
      list_snapshots "$dir" | awk -v agecut="$age_cut" -v nowcut="$now_cut" '
        NF && $1 + 0 <= nowcut + 0 && $1 + 0 < agecut + 0 { print $1, $3 }'
    done
  fi
}

# ---- report (always) -------------------------------------------------------
say "START archon-db-backup-retention mode=$([ "$DELETE_MODE" = 1 ] && echo delete || echo report) dry_run=${DRY_RUN} keep_newest=${KEEP_NEWEST_SNAPSHOTS:-unset} delete_after_days=${DELETE_AFTER_DAYS:-unset}"

report_location "$SDB_DIR" sdb
for d in $(printf '%s
' "$ROOT_DIRS" | tr ':' ' '); do
  report_location "$d" root
done

disk_free sdb "$SDB_DISK_PATH" "$SDB_MIN_FREE_GB"
disk_free root "$ROOT_DISK_PATH" "$ROOT_MIN_FREE_GB"

# ---- delete (only when a variable is set) ---------------------------------
if [ "$DELETE_MODE" = 1 ]; then
  PLAN=$(plan_deletes | sort -k1,1n | awk 'NF { print $2 }')
  if [ -z "$PLAN" ]; then
    say "DELETE_PLAN nothing to delete"
  else
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # Last guard: regular file, snapshot name, not a symlink.
      if ! [[ "$(basename "$f")" =~ ^archon\.db\.pre-rebuild-[0-9]{8}T[0-9]{4}Z$ ]]; then
        say "SKIP not-a-snapshot path=${f}"
        continue
      fi
      if [ ! -f "$f" ] || [ -L "$f" ]; then
        say "SKIP not-a-regular-file path=${f}"
        continue
      fi
      size=$(stat -c %s "$f" 2>/dev/null || echo 0)
      if [ "$DRY_RUN" = "1" ]; then
        say "WOULD_DELETE path=${f} bytes=${size}"
      elif rm -f -- "$f"; then
        say "SNAPSHOT_DELETED path=${f} bytes=${size}"
      else
        say "SNAPSHOT_DELETE_FAILED path=${f}"
        EXIT=4
      fi
    done <<EOF
$PLAN
EOF
  fi
fi

say "DONE exit=${EXIT}"
exit "$EXIT"
