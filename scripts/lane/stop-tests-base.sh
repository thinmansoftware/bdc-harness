# scripts/lane/stop-tests-base.sh -- base-red aware stop tests for the
# bdc-feature-development lanes (WO-HARNESS-STOP-TESTS-BASE-RED-AWARE-01).
#
# SOURCED (not executed) by the run-stop-tests and stamp-manifest-evidence nodes of all
# 13 .archon/workflows/defaults/bdc-feature-development*.yaml lanes, through the same
# resolution stub as dprep.sh: $BDC_STBASE_SCRIPT (tests), then
# $ARCHON_LANE_SCRIPTS_DIR/stop-tests-base.sh (engine-materialized bundle), then the
# image copy /app/scripts/lane/stop-tests-base.sh. ASCII only.
#
# A build should fail its test stop condition only for tests it newly broke. When the
# head result is "failed", rst_base_compare re-runs the same commands on the run's base
# commit ($ARTIFACTS_DIR/run-start-sha.txt) in a temporary detached worktree under
# $ARTIFACTS_DIR, with the same dependency prep (dprep_ensure_js_deps) and the same
# runner and per-command timeout (rst_run_commands). If every head failure also fails
# on base, the status becomes "base_red" and the names go to
# $ARTIFACTS_DIR/base-red-tests.txt. Anything else fails closed (status stays
# "failed"). The temporary worktree is always removed.
#
# Requires, from the run-stop-tests node: rst_run_commands (rst core) and
# dprep_ensure_js_deps (dprep.sh). Uses git, awk, sed, sort, comm.

# stb_failed_ids   (test-runner output on stdin -> sorted unique failing test ids)
#   bun       "(fail) <name> [1.23ms]"
#   node:test "not ok <n> - <name>"   (TODO / SKIP directives are not failures)
#   jest      "<U+25CF> <suite> <U+203A> <name>"
#   vitest    "FAIL  <file> > <suite> > <name>"
#   ANSI colour codes are stripped. A bun --filter workspace prefix
#   ("<pkg>:test | ") is kept as "<pkg> :: " so equal names in two packages differ.
stb_failed_ids() {
  local esc bullet
  esc="$(printf '\033')"
  bullet="$(printf '\342\227\217')"
  sed -E "s/${esc}\[[0-9;]*[A-Za-z]//g" | tr -d '\r' | LC_ALL=C awk -v B="$bullet" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    {
      line = $0; pfx = ""
      if (match(line, /^(@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*:test[ \t]+[|][ \t]*/)) {
        pfx = substr(line, 1, RLENGTH)
        sub(/:test[ \t]+[|][ \t]*$/, "", pfx)
        pfx = pfx " :: "
        line = substr(line, RLENGTH + 1)
      }
      t = trim(line); id = ""
      if (t ~ /^\(fail\) /) {
        id = substr(t, 8); sub(/[ \t]+\[[0-9.]+m?s\]$/, "", id)
      } else if (t ~ /^not ok [0-9]+/) {
        if (t ~ /#[ \t]*(TODO|SKIP|todo|skip)/) next
        id = t; sub(/^not ok [0-9]+[ \t]*(-[ \t]*)?/, "", id)
      } else if (index(t, B) == 1) {
        id = substr(t, length(B) + 1)
      } else if (t ~ /^FAIL[ \t]+.* > /) {
        id = t; sub(/^FAIL[ \t]+/, "", id)
      }
      id = trim(id)
      if (id != "") print pfx id
    }
  ' | LC_ALL=C sort -u
}

# stb__abs <path>   (-> absolute path of an existing file or directory)
stb__abs() {
  local p="$1"
  if [ -d "$p" ]; then (cd "$p" && pwd); return; fi
  printf '%s/%s' "$(cd "$(dirname "$p")" && pwd)" "$(basename "$p")"
}

# stb__join <file> [max]   (-> "a, b, c", at most max names, then "and N more")
stb__join() {
  local file="$1" max="${2:-20}" n
  n="$(grep -c . "$file" 2>/dev/null || true)"
  n="${n:-0}"
  head -n "$max" "$file" | paste -sd ',' - | sed 's/,/, /g'
  if [ "$n" -gt "$max" ]; then printf ' and %s more' "$((n - max))"; fi
}

# stb__emit <report-file> <outcome> [status] [line]
#   Prints the report with TESTS_STATUS / TESTS_LINE replaced when given, then
#   TESTS_BASE_COMPARE=<outcome>.
stb__emit() {
  local report="$1" outcome="$2" status="${3:-}" line="${4:-}"
  if [ -n "$status" ]; then
    STB_STATUS="$status" STB_LINE="$line" awk '
      /^TESTS_STATUS=/ && !s { print "TESTS_STATUS=" ENVIRON["STB_STATUS"]; s = 1; next }
      /^TESTS_LINE=/ && !l { print "TESTS_LINE=" ENVIRON["STB_LINE"]; l = 1; next }
      { print }
    ' "$report"
  else
    cat "$report"
  fi
  printf 'TESTS_BASE_COMPARE=%s\n' "$outcome"
}

# stb__remove_worktree <repo-top> <dir>   (always leaves <dir> gone and pruned)
stb__remove_worktree() {
  local top="$1" wt="$2"
  [ -n "$wt" ] || return 0
  git -C "$top" worktree remove --force "$wt" >/dev/null 2>&1 || true
  if [ -e "$wt" ]; then rm -rf "$wt" 2>/dev/null || true; fi
  git -C "$top" worktree prune >/dev/null 2>&1 || true
}

# rst_base_compare <report-file> <commands-file> <head-log> <head-counts>
#   <report-file>   the TESTS_STATUS= / TESTS_LINE= lines rst_report produced
#   <commands-file> the commands the head run executed (one per line)
#   <head-log>      the head run's output (stop-tests.log)
#   <head-counts>   "<passed> <total>" from the head run, or empty
#   Prints the final report plus TESTS_BASE_COMPARE=<outcome>. Outcomes:
#     not_failed      head status is not "failed": base is never run
#     base_red        every head failure also fails on base -> TESTS_STATUS=base_red
#     newly_broken    a head failure passes on base -> failed, "newly broken: <names>"
#     unparsed        failing tests could not be identified on head or base -> failed
#     no_base_sha     run-start-sha.txt missing or not a commit -> failed
#     no_counts       head pass/total not parsed -> failed
#     base_timeout    the base run timed out (exit 124) -> failed
#     base_passed     the base run did not fail -> failed, every head failure is new
#     base_unrunnable worktree or runner unavailable -> failed
#   Never returns nonzero.
rst_base_compare() {
  local report="$1" cmds="$2" head_log="$3" counts="$4"
  local status line art sha sha8 top wt base_log base_res base_exit base_counts bp bt
  local hp ht head_ids base_ids new_ids k nfail names newnames
  art="${ARTIFACTS_DIR:-}"
  if [ -n "$art" ]; then rm -f "$art/base-red-tests.txt" 2>/dev/null || true; fi
  status="$(sed -n 's/^TESTS_STATUS=//p' "$report" | head -1)"
  line="$(sed -n 's/^TESTS_LINE=//p' "$report" | head -1)"
  if [ "$status" != "failed" ]; then
    stb__emit "$report" not_failed
    return 0
  fi
  counts="$(printf '%s' "$counts" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$counts" in
    *[0-9]\ [0-9]*) hp="${counts%% *}"; ht="${counts##* }" ;;
    *) stb__emit "$report" no_counts; return 0 ;;
  esac
  if [ -z "$art" ] || [ ! -d "$art" ]; then
    stb__emit "$report" no_base_sha
    return 0
  fi
  sha="$(head -1 "$art/run-start-sha.txt" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -z "$sha" ] || ! git rev-parse --verify -q "${sha}^{commit}" >/dev/null 2>&1; then
    stb__emit "$report" no_base_sha
    return 0
  fi
  sha8="$(printf '%s' "$sha" | cut -c1-8)"
  head_ids="$(mktemp)"; base_ids="$(mktemp)"; new_ids="$(mktemp)"
  stb_failed_ids < "$head_log" > "$head_ids"
  k="$(grep -c . "$head_ids" || true)"; k="${k:-0}"
  nfail=$((ht - hp))
  if [ "$k" -eq 0 ] || [ "$k" -lt "$nfail" ]; then
    # Some failure has no identifier (a crash, an unhandled error, a non-test
    # command exiting nonzero): it cannot be matched against base.
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" unparsed
    return 0
  fi
  if ! declare -F rst_run_commands >/dev/null 2>&1; then
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" base_unrunnable
    return 0
  fi
  top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  cmds="$(stb__abs "$cmds")"
  mkdir -p "$art/evidence" 2>/dev/null || true
  base_log="$(stb__abs "$art/evidence")/stop-tests-base.log"
  : > "$base_log"
  wt="$(stb__abs "$art")/stop-tests-base-wt.$$"
  stb__remove_worktree "$top" "$wt"
  if ! git -C "$top" worktree add --detach "$wt" "$sha" >> "$base_log" 2>&1; then
    stb__remove_worktree "$top" "$wt"
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" base_unrunnable
    return 0
  fi
  printf 'stop-tests-base: head failed; re-running the same commands on base %s in %s\n' "$sha8" "$wt" >&2
  if declare -F dprep_ensure_js_deps >/dev/null 2>&1; then
    ( cd "$wt" && dprep_ensure_js_deps ) >&2
  fi
  base_res="$( cd "$wt" && rst_run_commands "$cmds" "$base_log" )"
  stb__remove_worktree "$top" "$wt"
  base_exit="${base_res%% *}"
  base_counts="$(printf '%s' "${base_res#* }" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  stb_failed_ids < "$base_log" > "$base_ids"
  LC_ALL=C comm -23 "$head_ids" "$base_ids" > "$new_ids"
  names="$(stb__join "$head_ids")"
  if [ "$base_exit" = "124" ]; then
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" base_timeout
    return 0
  fi
  bp=""; bt=""
  case "$base_counts" in *[0-9]\ [0-9]*) bp="${base_counts%% *}"; bt="${base_counts##* }" ;; esac
  if [ "$base_exit" = "0" ] && { [ -z "$bt" ] || [ "$bp" -ge "$bt" ]; }; then
    newnames="$(stb__join "$head_ids")"
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" base_passed failed "$(stb__newly "$line" "$newnames")"
    return 0
  fi
  if ! grep -q . "$base_ids"; then
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" unparsed
    return 0
  fi
  if grep -q . "$new_ids"; then
    newnames="$(stb__join "$new_ids")"
    rm -f "$head_ids" "$base_ids" "$new_ids"
    stb__emit "$report" newly_broken failed "$(stb__newly "$line" "$newnames")"
    return 0
  fi
  cp "$head_ids" "$art/base-red-tests.txt"
  rm -f "$head_ids" "$base_ids" "$new_ids"
  printf 'stop-tests-base: base-red: %s\n' "$names" >&2
  stb__emit "$report" base_red base_red "$(stb__base_red_line "$line" "$hp" "$ht" "$k" "$sha8")"
  return 0
}

# stb__newly <line> <names>   (-> line with "; newly broken: <names>" after the FAILED
#   marker, before any " [source: ...]" tail)
stb__newly() {
  local line="$1" names="$2"
  if printf '%s' "$line" | grep -q -- '-- FAILED, exit [0-9]*'; then
    STB_N="$names" awk '{ i = match($0, /-- FAILED, exit [0-9]+/); print substr($0, 1, RSTART + RLENGTH - 1) "; newly broken: " ENVIRON["STB_N"] substr($0, RSTART + RLENGTH) }' <<<"$line"
  else
    printf '%s (newly broken: %s)\n' "$line" "$names"
  fi
}

# stb__base_red_line <line> <pass> <total> <k> <sha8>
#   "<p>/<t> (<cmd>) -- FAILED, exit N [source: x]" ->
#   "<p>/<t> (base-red: <k> tests failing on base <sha8>; newly broken: 0) (<cmd>) [source: x]"
stb__base_red_line() {
  local line="$1" p="$2" t="$3" k="$4" sha8="$5" rest
  rest="${line#"$p/$t"}"
  rest="$(printf '%s' "$rest" | sed -E 's/ -- FAILED, exit [0-9]+//')"
  printf '%s/%s (base-red: %s tests failing on base %s; newly broken: 0)%s\n' "$p" "$t" "$k" "$sha8" "$rest"
}

# stb_stamp_base_red   (stamped manifest on stdin -> stdout)
#   When $ARTIFACTS_DIR/base-red-tests.txt lists names, inserts
#   "Base-red tests: <a>; <b>" right after the first "Tests:" line. A manifest without
#   a "Tests:" line (ALREADY_SATISFIED / BLOCKED short form) passes through.
stb_stamp_base_red() {
  local f="${ARTIFACTS_DIR:-}/base-red-tests.txt" names
  if [ -z "${ARTIFACTS_DIR:-}" ] || [ ! -s "$f" ]; then
    cat
    return 0
  fi
  names="$(grep . "$f" | paste -sd ';' - | sed 's/;/; /g')"
  STB_B="Base-red tests: ${names} (failing on the base commit before this change; not newly broken)" awk '
    { print }
    !b && /^Tests:/ { print ENVIRON["STB_B"]; b = 1 }
  '
}
