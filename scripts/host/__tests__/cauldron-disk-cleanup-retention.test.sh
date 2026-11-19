#!/usr/bin/env bash
# Tests for the snapshot-retention step and the --pressure-check mode of
# scripts/host/cauldron-disk-cleanup.sh (WO-HARNESS-REBUILD-BACKUP-RETENTION-01,
# Amendment 2). The real script's own block (from RETENTION_SCRIPT= up to the
# start log line) is lifted with awk and run against a stub retention script and
# a stub df. Nothing touches the host, docker or any snapshot. Usage:
#   bash scripts/host/__tests__/cauldron-disk-cleanup-retention.test.sh
# Exit 0 when every case passes.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP="$HERE/../cauldron-disk-cleanup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2' got '$3'"; fi; }

# Lift the real block.
awk '/^RETENTION_SCRIPT=/ {on=1} /^log "=== cauldron-disk-cleanup start ==="/ {on=0} on' "$CLEANUP" > "$WORK/block.body"
[ -s "$WORK/block.body" ] && ok "block lifted from the real script ($(wc -l < "$WORK/block.body" | tr -d ' ') lines)" || { bad "block not found in cauldron-disk-cleanup.sh"; echo "passed=$PASS failed=$FAIL"; exit 1; }

mkdir -p "$WORK/bin"
# Stub df: prints a header and "<PCT>%" for `df --output=pcent <mount>`; fails when STUB_DF_FAIL is set.
cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
[ -n "${STUB_DF_FAIL:-}" ] && exit 1
printf 'Use%%\n %s%%\n' "${STUB_DF_PCT:-40}"
STUB
chmod +x "$WORK/bin/df"
# Stub retention script: records one line per call (env as seen) and exits STUB_RETENTION_RC.
cat > "$WORK/retention-stub.sh" <<'STUB'
#!/usr/bin/env bash
echo "called keep=${KEEP_NEWEST_SNAPSHOTS-UNSET} days=${DELETE_AFTER_DAYS-UNSET} dry=${DRY_RUN-UNSET}" >> "$CALLS"
echo "SNAPSHOT_REPORT stub"
exit "${STUB_RETENTION_RC:-0}"
STUB
chmod +x "$WORK/retention-stub.sh"

# run_block <args-for-the-block> -- [VAR=value ...]: stdout in $OUT, status in $RC, calls in $WORK/calls, log in $WORK/log.
run_block() {
  local blockargs="$1"; shift
  rm -f "$WORK/calls" "$WORK/log"
  {
    echo 'log() { echo "[t] $*" >> "$LOG"; }'
    cat "$WORK/block.body"
    echo 'echo BLOCK_FELL_THROUGH'
  } > "$WORK/block.sh"
  OUT="$(env -u KEEP_NEWEST_SNAPSHOTS -u DELETE_AFTER_DAYS -u DRY_RUN -u STUB_DF_FAIL -u STUB_RETENTION_RC \
    PATH="$WORK/bin:$PATH" LOG="$WORK/log" CALLS="$WORK/calls" \
    RETENTION_SCRIPT="$WORK/retention-stub.sh" PRESSURE_MOUNT="/stub-mount" \
    "$@" bash "$WORK/block.sh" $blockargs 2>&1)"
  RC=$?
}
calls() { [ -f "$WORK/calls" ] && wc -l < "$WORK/calls" | tr -d ' ' || echo 0; }

# C1: the nightly step runs the retention script once and passes no deletion variable.
run_block ""
check "C1 block falls through when no argument is given" 0 "$(printf '%s\n' "$OUT" | grep -c 'BLOCK_FELL_THROUGH' | awk '{print ($1==1)?0:1}')"
# run_db_retention is only a function until the main flow calls it, so call it directly.
{ echo 'log() { echo "[t] $*" >> "$LOG"; }'; cat "$WORK/block.body"; echo 'run_db_retention; echo "rc=$?"'; } > "$WORK/call-run.sh"
runfn() { rm -f "$WORK/calls" "$WORK/log"; OUT="$(env -u KEEP_NEWEST_SNAPSHOTS -u DELETE_AFTER_DAYS -u DRY_RUN -u STUB_RETENTION_RC PATH="$WORK/bin:$PATH" LOG="$WORK/log" CALLS="$WORK/calls" RETENTION_SCRIPT="${RS:-$WORK/retention-stub.sh}" PRESSURE_MOUNT="/stub-mount" "$@" bash "$WORK/call-run.sh" 2>&1)"; RC=$?; }
RS="" runfn
check "C1 retention script called once" 1 "$(calls)"
grep -q 'keep=UNSET days=UNSET' "$WORK/calls" && ok "C1 neither deletion variable is set by the cleanup (stub saw UNSET UNSET)" || bad "C1 deletion variable leaked" "$(cat "$WORK/calls" 2>/dev/null)"
printf '%s\n' "$OUT" | grep -q '^\[retention\] SNAPSHOT_REPORT stub' && ok "C1 retention output is prefixed and shown" || bad "C1 output" "$OUT"
grep -q 'db snapshot retention exit=0' "$WORK/log" && ok "C1 exit status logged" || bad "C1 log" "$(cat "$WORK/log")"

# C2: DRY_RUN reaches the retention script unchanged.
runfn DRY_RUN=1
grep -q 'dry=1' "$WORK/calls" && ok "C2 DRY_RUN=1 is passed through" || bad "C2 dry run not passed" "$(cat "$WORK/calls" 2>/dev/null)"

# C3: retention script not installed -> logged skip, never a failure.
RS="$WORK/not-installed" runfn
check "C3 missing script: function returns 0" "rc=0" "$(printf '%s\n' "$OUT" | grep '^rc=')"
grep -q 'is not installed' "$WORK/log" && ok "C3 skip is logged" || bad "C3 no skip line" "$(cat "$WORK/log")"
check "C3 nothing was called" 0 "$(calls)"

# C4: a low-disk (3), refused (5) or failed result is logged and never stops the sweep.
for rc in 3 4 5; do
  RS="" runfn STUB_RETENTION_RC=$rc
  check "C4 retention exit $rc: function still returns 0" "rc=0" "$(printf '%s\n' "$OUT" | grep '^rc=')"
  grep -q "db snapshot retention exit=$rc" "$WORK/log" && ok "C4 exit $rc is logged" || bad "C4 exit $rc not logged" "$(cat "$WORK/log")"
done

# C5: pressure check is quiet below the threshold.
run_block "--pressure-check" STUB_DF_PCT=84
check "C5 84% used: retention not called" 0 "$(calls)"
check "C5 84% used: exits 0 without falling through to the sweep" "" "$(printf '%s\n' "$OUT" | grep 'BLOCK_FELL_THROUGH')"
[ ! -s "$WORK/log" ] && ok "C5 84% used: nothing logged (quiet hourly run)" || bad "C5 logged at 84%" "$(cat "$WORK/log")"
# C6: at and above the threshold it runs the retention step only.
for pct in 85 99; do
  run_block "--pressure-check" STUB_DF_PCT=$pct
  check "C6 ${pct}% used: retention called once" 1 "$(calls)"
  check "C6 ${pct}% used: exit 0, no fall-through to the sweep" 0 "$RC"
  printf '%s\n' "$OUT" | grep -q 'BLOCK_FELL_THROUGH' && bad "C6 ${pct}%: fell through to the sweep" || ok "C6 ${pct}%: sweep not reached"
  grep -q "pressure check: /stub-mount at ${pct}%" "$WORK/log" && ok "C6 ${pct}%: the pressure reading is logged" || bad "C6 log" "$(cat "$WORK/log")"
done
# C7: a threshold override is honoured.
run_block "--pressure-check" STUB_DF_PCT=60 PRESSURE_PCT=50
check "C7 PRESSURE_PCT=50 at 60%: retention called" 1 "$(calls)"
# C8: an unreadable mount is a logged skip, not a failure.
run_block "--pressure-check" STUB_DF_FAIL=1
check "C8 df fails: retention not called" 0 "$(calls)"
check "C8 df fails: exit 0" 0 "$RC"
grep -q 'cannot read /stub-mount; skipped' "$WORK/log" && ok "C8 skip is logged" || bad "C8 log" "$(cat "$WORK/log" 2>/dev/null)"
# C9: pressure-check passes the deletion variables through only when the environment has them.
run_block "--pressure-check" STUB_DF_PCT=90 KEEP_NEWEST_SNAPSHOTS=5
grep -q 'keep=5' "$WORK/calls" && ok "C9 a variable set in the cron environment reaches the retention script" || bad "C9 variable not passed" "$(cat "$WORK/calls" 2>/dev/null)"

# C10: structure of the real script.
bash -n "$CLEANUP" && ok "C10 cauldron-disk-cleanup.sh parses" || bad "C10 syntax"
check "C10 the cleanup never assigns a deletion variable" 0 "$(grep -c -E '(KEEP_NEWEST_SNAPSHOTS|DELETE_AFTER_DAYS)=' "$CLEANUP")"
l_press="$(grep -n -- '--pressure-check' "$CLEANUP" | grep '"${1:-}"' | head -1 | cut -d: -f1)"
l_start="$(grep -n '^log "=== cauldron-disk-cleanup start ==="' "$CLEANUP" | head -1 | cut -d: -f1)"
l_call="$(grep -n '^run_db_retention$' "$CLEANUP" | head -1 | cut -d: -f1)"
l_dry="$(grep -n 'DRY_RUN: worktree, rollback-pin and snapshot-retention plan only' "$CLEANUP" | head -1 | cut -d: -f1)"
[ -n "$l_press" ] && [ -n "$l_start" ] && [ "$l_press" -lt "$l_start" ] && ok "C10 --pressure-check is handled before the sweep starts (line $l_press < $l_start)" || bad "C10 dispatch order" "press=$l_press start=$l_start"
[ -n "$l_call" ] && [ -n "$l_dry" ] && [ "$l_call" -lt "$l_dry" ] && ok "C10 the nightly run calls the retention step before the DRY_RUN exit (line $l_call < $l_dry)" || bad "C10 call order" "call=$l_call dry=$l_dry"
grep -q 'RETENTION_SCRIPT="${RETENTION_SCRIPT:-/usr/local/sbin/archon-db-backup-retention.sh}"' "$CLEANUP" && ok "C10 default retention script path is the documented install path" || bad "C10 default path"
grep -q 'PRESSURE_MOUNT="${PRESSURE_MOUNT:-/mnt/bdc-builds}"' "$CLEANUP" && ok "C10 pressure mount defaults to /mnt/bdc-builds" || bad "C10 pressure mount default"

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
