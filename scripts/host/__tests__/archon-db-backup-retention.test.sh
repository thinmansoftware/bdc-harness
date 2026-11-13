#!/usr/bin/env bash
# Tests for scripts/host/archon-db-backup-retention.sh (spec Tests 1 to 6).
# Runs against temp directories only. Usage:
#   bash scripts/host/__tests__/archon-db-backup-retention.test.sh
# Exit 0 when every case passes.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../archon-db-backup-retention.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2' got '$3'"; fi
}

# make_snap <dir> <n> <age-spec>  -> archon.db.pre-rebuild-2026110<n>T1200Z, mtime = now - age-spec
make_snap() {
  local f="$1/archon.db.pre-rebuild-2026110$2T1200Z"
  mkdir -p "$1"
  head -c 2048 /dev/zero > "$f"
  touch -d "$3 ago" "$f"
}

tree_hash() { (cd "$WORK" && find . -type f ! -name run.log | sort | xargs sha256sum | sha256sum | cut -c1-64); }
file_list() { (cd "$WORK" && find . -type f ! -name run.log | sort); }
count_in() { find "$1" -type f -name 'archon.db.pre-rebuild-*' 2>/dev/null | wc -l | tr -d ' '; }

# fresh <name>: rebuild the standard layout.
#   sdb:     8 snapshots, #1 2h old, #2 5h old, #3..#8 8..13 days old
#   root_a:  3 snapshots 10 days old
#   root_b:  2 snapshots 3 days old
fresh() {
  rm -rf "$WORK/sdb" "$WORK/root_a" "$WORK/root_b" "$WORK/run.log"
  mkdir -p "$WORK/sdb" "$WORK/root_a" "$WORK/root_b"
  make_snap "$WORK/sdb" 1 "2 hours"
  make_snap "$WORK/sdb" 2 "5 hours"
  make_snap "$WORK/sdb" 3 "8 days"
  make_snap "$WORK/sdb" 4 "9 days"
  make_snap "$WORK/sdb" 5 "10 days"
  make_snap "$WORK/sdb" 6 "11 days"
  make_snap "$WORK/sdb" 7 "12 days"
  make_snap "$WORK/sdb" 8 "13 days"
  make_snap "$WORK/root_a" 1 "10 days"
  make_snap "$WORK/root_a" 2 "10 days"
  make_snap "$WORK/root_a" 3 "10 days"
  make_snap "$WORK/root_b" 1 "3 days"
  make_snap "$WORK/root_b" 2 "3 days"
}

# run_script [VAR=value ...]: stdout in $OUT, status in $RC.
run_script() {
  OUT="$(env -u KEEP_NEWEST_SNAPSHOTS -u DELETE_AFTER_DAYS -u DRY_RUN \
    SDB_DIR="$WORK/sdb" \
    ROOT_DIRS="$WORK/root_a:$WORK/root_b:$WORK/missing_dir" \
    SDB_DISK_PATH="$WORK" ROOT_DISK_PATH="$WORK" \
    SDB_MIN_FREE_GB=0 ROOT_MIN_FREE_GB=0 \
    LOG="$WORK/run.log" "$@" bash "$SCRIPT" 2>&1)"
  RC=$?
}

# ---- Test 1: report mode changes nothing -----------------------------------
fresh
before="$(tree_hash)"
run_script
check "T1 exit 0 in report mode" 0 "$RC"
check "T1 three SNAPSHOT_REPORT lines plus the missing one" 4 "$(printf '%s\n' "$OUT" | grep -c '^SNAPSHOT_REPORT')"
printf '%s\n' "$OUT" | grep '^SNAPSHOT_REPORT location=sdb ' | grep -q 'count=8 ' && ok "T1 sdb count 8" || bad "T1 sdb count 8" "$OUT"
printf '%s\n' "$OUT" | grep "root_a" | grep -q 'count=3 ' && ok "T1 root_a count 3" || bad "T1 root_a count 3" "$OUT"
printf '%s\n' "$OUT" | grep "root_b" | grep -q 'count=2 ' && ok "T1 root_b count 2" || bad "T1 root_b count 2" "$OUT"
printf '%s\n' "$OUT" | grep "missing_dir" | grep -q 'count=0 .*note=missing' && ok "T1 missing dir reported, not an error" || bad "T1 missing dir" "$OUT"
printf '%s\n' "$OUT" | grep '^SNAPSHOT_REPORT location=sdb ' | grep -q 'oldest=20261108T1200Z newest=20261101T1200Z' && ok "T1 sdb oldest/newest stamps" || \
  printf '%s\n' "$OUT" | grep '^SNAPSHOT_REPORT location=sdb ' | grep -q 'oldest=20261101T1200Z newest=20261108T1200Z' && ok "T1 sdb oldest/newest stamps" || bad "T1 stamps" "$OUT"
check "T1 two DISK_FREE lines" 2 "$(printf '%s\n' "$OUT" | grep -c '^DISK_FREE')"
check "T1 every file byte-identical and present" "$before" "$(tree_hash)"
check "T1 the log got the report lines" 4 "$(grep -c 'SNAPSHOT_REPORT' "$WORK/run.log")"

# ---- Test 2: never writes a snapshot anywhere ------------------------------
fresh
files_before="$(file_list)"
run_script
check "T2 report mode: no new file" "$files_before" "$(file_list)"
run_script DRY_RUN=1 KEEP_NEWEST_SNAPSHOTS=5 DELETE_AFTER_DAYS=7
check "T2 dry run: no new, no removed file" "$files_before" "$(file_list)"
run_script DELETE_AFTER_DAYS=7
new_files="$(comm -13 <(printf '%s\n' "$files_before") <(file_list))"
check "T2 delete mode: nothing new appears (only deletions)" "" "$new_files"

# ---- Test 3: low space alarms visibly --------------------------------------
fresh
before="$(tree_hash)"
run_script SDB_MIN_FREE_GB=99999999
check "T3 exit status 3" 3 "$RC"
printf '%s\n' "$OUT" | grep -q '^SNAPSHOT_DISK_LOW disk=sdb .*free_gb=[0-9.]* min_free_gb=99999999' && ok "T3 SNAPSHOT_DISK_LOW names disk and number" || bad "T3 low line" "$OUT"
check "T3 nothing changed" "$before" "$(tree_hash)"
run_script ROOT_MIN_FREE_GB=99999999
check "T3 root floor also exits 3" 3 "$RC"
printf '%s\n' "$OUT" | grep -q '^SNAPSHOT_DISK_LOW disk=root ' && ok "T3 root low line" || bad "T3 root low line" "$OUT"

# ---- Test 4: delete only when a variable is set -----------------------------
fresh
before="$(tree_hash)"
run_script
check "T4 no variable: exit 0" 0 "$RC"
check "T4 no variable: nothing deleted" "$before" "$(tree_hash)"
check "T4 no variable: no SNAPSHOT_DELETED line" 0 "$(printf '%s\n' "$OUT" | grep -c 'SNAPSHOT_DELETED')"

fresh
run_script DELETE_AFTER_DAYS=7
check "T4 DELETE_AFTER_DAYS=7: exit 0" 0 "$RC"
check "T4 DELETE_AFTER_DAYS=7: eight SNAPSHOT_DELETED lines (5 sdb + 3 root_a)" 8 "$(printf '%s\n' "$OUT" | grep -c '^SNAPSHOT_DELETED')"
check "T4 DELETE_AFTER_DAYS=7: sdb keeps the protected newest 3" 3 "$(count_in "$WORK/sdb")"
check "T4 DELETE_AFTER_DAYS=7: root_a emptied" 0 "$(count_in "$WORK/root_a")"
check "T4 DELETE_AFTER_DAYS=7: root_b (3 days old) untouched" 2 "$(count_in "$WORK/root_b")"
for n in 1 2 3; do
  [ -f "$WORK/sdb/archon.db.pre-rebuild-2026110${n}T1200Z" ] && ok "T4 protected sdb #$n still present" || bad "T4 protected sdb #$n deleted"
done

fresh
run_script KEEP_NEWEST_SNAPSHOTS=5
check "T4 KEEP_NEWEST_SNAPSHOTS=5: three SNAPSHOT_DELETED lines" 3 "$(printf '%s\n' "$OUT" | grep -c '^SNAPSHOT_DELETED')"
check "T4 KEEP_NEWEST_SNAPSHOTS=5: sdb keeps 5" 5 "$(count_in "$WORK/sdb")"
check "T4 KEEP_NEWEST_SNAPSHOTS=5: root locations untouched" 5 "$(( $(count_in "$WORK/root_a") + $(count_in "$WORK/root_b") ))"
order="$(printf '%s\n' "$OUT" | grep '^SNAPSHOT_DELETED' | sed 's/.*pre-rebuild-\(20261108\|20261107\|20261106\)T.*/\1/' | tr '\n' ' ')"
check "T4 oldest deleted first" "20261108 20261107 20261106 " "$order"

fresh
run_script KEEP_NEWEST_SNAPSHOTS=1
check "T4 KEEP_NEWEST_SNAPSHOTS=1: floor of 3 holds, sdb keeps 3" 3 "$(count_in "$WORK/sdb")"

# Every file in every location under 24 hours old: nothing is deleted whatever the setting.
fresh
find "$WORK" -type f -name 'archon.db.pre-rebuild-*' -exec touch -d "3 hours ago" {} +
before="$(tree_hash)"
run_script KEEP_NEWEST_SNAPSHOTS=1 DELETE_AFTER_DAYS=1
check "T4 files under 24h old are never deleted" "$before" "$(tree_hash)"

# A set but invalid value stops the run before anything is touched.
for bad_val in "KEEP_NEWEST_SNAPSHOTS=0" "KEEP_NEWEST_SNAPSHOTS=abc" "DELETE_AFTER_DAYS=-1" "DELETE_AFTER_DAYS=0" "DELETE_AFTER_DAYS=7d"; do
  fresh
  before="$(tree_hash)"
  run_script "$bad_val"
  check "T4 $bad_val: exit 2" 2 "$RC"
  check "T4 $bad_val: nothing deleted" "$before" "$(tree_hash)"
done

# ---- Test 5: DRY_RUN deletes nothing ----------------------------------------
fresh
before="$(tree_hash)"
run_script DRY_RUN=1 KEEP_NEWEST_SNAPSHOTS=5
check "T5 dry run: exit 0" 0 "$RC"
check "T5 dry run: three WOULD_DELETE lines" 3 "$(printf '%s\n' "$OUT" | grep -c '^WOULD_DELETE')"
check "T5 dry run: no SNAPSHOT_DELETED line" 0 "$(printf '%s\n' "$OUT" | grep -c '^SNAPSHOT_DELETED')"
check "T5 dry run: no file removed" "$before" "$(tree_hash)"

# ---- Test 6: only snapshot files are considered -----------------------------
fresh
echo "db" > "$WORK/sdb/archon.db"
echo "notes" > "$WORK/sdb/notes.txt"
echo "sum" > "$WORK/sdb/archon.db.pre-rebuild-20261108T1200Z.sha256"
echo "x" > "$WORK/sdb/archon.db.pre-rebuild-latest"
echo "x" > "$WORK/root_a/archon.db.pre-rebuild-20261101T1200Z.partial"
touch -d "30 days ago" "$WORK/sdb/archon.db" "$WORK/sdb/notes.txt" "$WORK/sdb/archon.db.pre-rebuild-20261108T1200Z.sha256" \
  "$WORK/sdb/archon.db.pre-rebuild-latest" "$WORK/root_a/archon.db.pre-rebuild-20261101T1200Z.partial"
run_script
printf '%s\n' "$OUT" | grep '^SNAPSHOT_REPORT location=sdb ' | grep -q 'count=8 ' && ok "T6 unrelated and sidecar files are not counted" || bad "T6 count" "$OUT"
run_script DELETE_AFTER_DAYS=7 KEEP_NEWEST_SNAPSHOTS=5
for f in "$WORK/sdb/archon.db" "$WORK/sdb/notes.txt" "$WORK/sdb/archon.db.pre-rebuild-20261108T1200Z.sha256" \
  "$WORK/sdb/archon.db.pre-rebuild-latest" "$WORK/root_a/archon.db.pre-rebuild-20261101T1200Z.partial"; do
  [ -f "$f" ] && ok "T6 untouched: $(basename "$f")" || bad "T6 deleted: $(basename "$f")"
done
# A symlink named like a snapshot is never followed or deleted.
fresh
echo "outside" > "$WORK/outside.txt"
if ln -s "$WORK/outside.txt" "$WORK/sdb/archon.db.pre-rebuild-20261109T1200Z" 2>/dev/null && [ -L "$WORK/sdb/archon.db.pre-rebuild-20261109T1200Z" ]; then
  touch -h -d "30 days ago" "$WORK/sdb/archon.db.pre-rebuild-20261109T1200Z" 2>/dev/null
  run_script DELETE_AFTER_DAYS=7
  [ -f "$WORK/outside.txt" ] && ok "T6 symlink target untouched" || bad "T6 symlink target deleted"
  [ -L "$WORK/sdb/archon.db.pre-rebuild-20261109T1200Z" ] && ok "T6 symlink itself not deleted" || bad "T6 symlink deleted"
else
  ok "T6 symlink case skipped (no symlink support here)"
fi

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
