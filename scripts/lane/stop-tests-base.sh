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
# Evidence is judged PER COMMAND (one "### run-stop-tests: <cmd>" block of the log
# each). Every head command that failed must carry its own complete named evidence:
# parsed counts, exactly one attributable name per failing test, no repeated name. A
# test's identity is <command index> <file> <name>, so one command's names never
# cover another command's failures and equal names in different files never match.
#
# Requires, from the run-stop-tests node: rst_run_commands and rst_parse_counts (rst
# core) and dprep_ensure_js_deps (dprep.sh). Uses git, awk, sed, sort, comm.

# stb_failed_ids   (ONE command's output on stdin -> "<file><TAB><name>" per failing
#   test, in output order, not deduplicated; <file> is empty when the runner printed
#   no file for that test)
#   bun       file header "<path>:" or "::group::<path>:" (also behind a bun --filter
#             "<pkg>:test | " prefix, tracked per prefix), then "(fail) <name> [1ms]".
#             The end-of-run recap ("N tests failed:") repeats names without files and
#             is skipped.
#   node:test top-level "# Subtest: <path>" naming a script file, then
#             "not ok <n> - <name>" (TODO / SKIP are not failures; the file's own
#             top-level "not ok" is not a test).
#   jest      "FAIL <path>", then "<U+25CF> <suite> <U+203A> <name>"; collection stops at
#             "Summary of all failing tests" (a repeat).
#   vitest    "FAIL <path> > <suite> > <name>" (file and name on one line).
#   ANSI colour codes are stripped. A bun --filter prefix is kept in the file as
#   "<pkg> :: <path>".
stb_failed_ids() {
  local esc bullet
  esc="$(printf '\033')"
  bullet="$(printf '\342\227\217')"
  sed -E "s/${esc}\[[0-9;]*[A-Za-z]//g" | tr -d '\r' | LC_ALL=C awk -v B="$bullet" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function emit(f, n) { n = trim(n); if (n != "") printf "%s\t%s\n", f, n }
    {
      line = $0; pfx = ""
      if (match(line, /^(@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*:test[ \t]+[|][ \t]*/)) {
        pfx = substr(line, 1, RLENGTH)
        sub(/:test[ \t]+[|][ \t]*$/, "", pfx)
        line = substr(line, RLENGTH + 1)
      }
      t = trim(line)
      if (t ~ /^Summary of all failing tests/) { stop = 1 }
      if (stop) next
      if (t == "::endgroup::") { file[pfx] = ""; next }
      if (t ~ /^[0-9]+ tests? failed:$/) { recap[pfx] = 1; file[pfx] = ""; next }
      if (t ~ /^(::group::)?[^ \t()]+\.[A-Za-z0-9]+:$/) {
        f = t; sub(/^::group::/, "", f); sub(/:$/, "", f)
        file[pfx] = (pfx == "" ? f : pfx " :: " f); recap[pfx] = 0; next
      }
      if (line ~ /^# Subtest: /) {
        f = trim(substr(line, 12))
        if (f ~ /[.][cm]?[jt]sx?$/) { file[pfx] = f; tapfile[pfx] = f } else { file[pfx] = ""; tapfile[pfx] = "" }
        next
      }
      if (t ~ /^\(fail\) /) {
        if (recap[pfx]) next
        n = substr(t, 8); sub(/[ \t]+\[[0-9.]+m?s\]$/, "", n); emit(file[pfx], n); next
      }
      if (t ~ /^not ok [0-9]+/) {
        if (t ~ /#[ \t]*(TODO|SKIP|todo|skip)/) next
        n = t; sub(/^not ok [0-9]+[ \t]*(-[ \t]*)?/, "", n); n = trim(n)
        if (line == t && tapfile[pfx] != "" && n == tapfile[pfx]) next
        emit(file[pfx], n); next
      }
      if (t ~ /^FAIL[ \t]+.* > /) {
        n = t; sub(/^FAIL[ \t]+/, "", n); f = n; sub(/ > .*$/, "", f); sub(/^[^>]* > /, "", n)
        emit(f, n); next
      }
      if (t ~ /^FAIL[ \t]+[^ \t]+$/) { f = t; sub(/^FAIL[ \t]+/, "", f); file[pfx] = f; next }
      if (index(t, B) == 1) { emit(file[pfx], substr(t, length(B) + 1)); next }
    }
  '
}

# stb_split_blocks <log> <dir> [keep]   Splits a stop-tests log into one block per
#   command: <dir>/<i>.out (output) and <dir>/<i>.rc (exit). With keep, only the last
#   <keep> blocks are kept and renumbered 1..keep (the head log also carries earlier
#   ladder rungs; the final commands file names the commands that produced the
#   result). Prints the number of blocks kept.
stb_split_blocks() {
  local log="$1" dir="$2" keep="${3:-0}" n i j
  mkdir -p "$dir/raw"
  n="$(awk -v d="$dir/raw" '
    /^### run-stop-tests: / { if (f != "") close(f); n++; f = d "/" n ".out"; printf "" > f; next }
    /^### exit [0-9]+$/ && n { r = d "/" n ".rc"; print $3 > r; close(r); next }
    n { print > f }
    END { print n + 0 }
  ' "$log")"
  i=1
  if [ "$keep" -gt 0 ] && [ "$n" -gt "$keep" ]; then i=$((n - keep + 1)); fi
  j=0
  while [ "$i" -le "$n" ]; do
    j=$((j + 1))
    mv "$dir/raw/$i.out" "$dir/$j.out"
    if [ -f "$dir/raw/$i.rc" ]; then mv "$dir/raw/$i.rc" "$dir/$j.rc"; else echo 1 > "$dir/$j.rc"; fi
    i=$((i + 1))
  done
  rm -rf "$dir/raw"
  printf '%s' "$j"
}

# stb__head_identities <dir> <n> <out>   Judges each head command block. Writes
#   "<i><TAB><file><TAB><name>" for every failing test to <out>. Returns 0 when every
#   failing command is fully named, 1 otherwise (fail closed). A command failed when
#   it exited nonzero or its counts show a failing test. Its evidence is complete only
#   when its own counts parse, it did not time out (124), every failure has a file,
#   the number of names equals its own failure count, and no name repeats in it.
stb__head_identities() {
  local dir="$1" n="$2" out="$3" i rc c p t ids nids
  : > "$out"
  i=1
  while [ "$i" -le "$n" ]; do
    rc="$(cat "$dir/$i.rc" 2>/dev/null || echo 1)"
    c="$(rst_parse_counts < "$dir/$i.out")"
    p=""; t=""
    case "$c" in *[0-9]\ [0-9]*) p="${c%% *}"; t="${c##* }" ;; esac
    if [ "$rc" = "0" ] && { [ -z "$t" ] || [ "$p" -ge "$t" ]; }; then i=$((i + 1)); continue; fi
    [ "$rc" = "124" ] && return 1
    [ -n "$t" ] || return 1
    [ $((t - p)) -gt 0 ] || return 1
    ids="$(stb_failed_ids < "$dir/$i.out")"
    [ -n "$ids" ] || return 1
    printf '%s\n' "$ids" | awk -F '\t' '$1 == "" { bad = 1 } END { if (bad) exit 0; exit 1 }' && return 1
    nids="$(printf '%s\n' "$ids" | grep -c .)"
    [ "$nids" -eq $((t - p)) ] || return 1
    [ -z "$(printf '%s\n' "$ids" | cut -f2 | LC_ALL=C sort | uniq -d)" ] || return 1
    printf '%s\n' "$ids" | awk -v i="$i" '{ print i "\t" $0 }' >> "$out"
    i=$((i + 1))
  done
  return 0
}

# stb__base_identities <dir> <n> <out>   Every attributable base failure as
#   "<i><TAB><file><TAB><name>"; returns 2 when a base command timed out (124).
stb__base_identities() {
  local dir="$1" n="$2" out="$3" i rc
  : > "$out"
  i=1
  while [ "$i" -le "$n" ]; do
    rc="$(cat "$dir/$i.rc" 2>/dev/null || echo 1)"
    [ "$rc" = "124" ] && return 2
    stb_failed_ids < "$dir/$i.out" | awk -F '\t' -v i="$i" '$1 != "" { print i "\t" $0 }' >> "$out"
    i=$((i + 1))
  done
  return 0
}

# stb__head_roots <top>   (-> every spelling of the head checkout root, one per line,
#   longest first, no trailing slash): git's form, the logical and physical (pwd -P)
#   paths, cygpath forms where cygpath exists, and the /<drive>/ form of a C:/ path.
stb__head_roots() {
  local top="$1" r
  {
    printf '%s\n' "$top"
    (cd "$top" 2>/dev/null && pwd)
    (cd "$top" 2>/dev/null && pwd -P)
    if command -v cygpath >/dev/null 2>&1; then
      cygpath -u "$top" 2>/dev/null
      cygpath -m "$top" 2>/dev/null
    fi
  } | while IFS= read -r r; do
    [ -n "$r" ] || continue
    while [ "${#r}" -gt 1 ] && [ "${r%/}" != "$r" ]; do r="${r%/}"; done
    [ "$r" = "/" ] && continue
    printf '%s\n' "$r"
    case "$r" in
      [A-Za-z]:/*) printf '/%s%s\n' "$(printf '%s' "${r%%:*}" | tr 'A-Z' 'a-z')" "${r#?:}" ;;
    esac
  done | awk '!seen[$0]++ { print length($0) "\t" $0 }' | sort -rn | cut -f2-
}

# stb__rebase_commands <in> <out> <wt> <roots-file>   Rewrites each command for the
#   base run: every head root (followed by "/", a space or the end) becomes <wt>.
#   Returns 1 (nothing usable written) when a rewritten command still names a head
#   root in any letter case, or starts with "cd <absolute dir>" outside <wt>.
stb__rebase_commands() {
  local in="$1" out="$2" wt="$3" roots="$4"
  LC_ALL=C awk -v WT="$wt" -v RF="$roots" '
    BEGIN { S = "\001BASEWT\001"; while ((getline r < RF) > 0) if (r != "") R[++n] = r }
    function rebase(s, r,   o, i, c) {
      o = ""
      while ((i = index(s, r)) > 0) {
        c = substr(s, i + length(r), 1)
        if (c == "" || c == "/" || c == " ") { o = o substr(s, 1, i - 1) S; s = substr(s, i + length(r)) }
        else { o = o substr(s, 1, i + length(r) - 1); s = substr(s, i + length(r)) }
      }
      return o s
    }
    {
      line = $0
      for (k = 1; k <= n; k++) line = rebase(line, R[k])
      low = tolower(line)
      for (k = 1; k <= n; k++) if (index(low, tolower(R[k])) > 0) bad = 1
      if (match(line, /^[ ]*cd[ ]+[^ ]+[ ]+&&/)) {
        d = line; sub(/^[ ]*cd[ ]+/, "", d); sub(/[ ]+&&.*$/, "", d)
        if ((d ~ /^\// || d ~ /^[A-Za-z]:/) && !(d == S || index(d, S "/") == 1)) bad = 1
      }
      while ((i = index(line, S)) > 0) line = substr(line, 1, i - 1) WT substr(line, i + length(S))
      out[++m] = line
    }
    END {
      if (bad) exit 1
      for (k = 1; k <= m; k++) print out[k]
    }
  ' "$in" > "$out" || { : > "$out"; return 1; }
  return 0
}

# stb__abs <path>   (-> absolute path of an existing file or directory)
stb__abs() {
  local p="$1"
  if [ -d "$p" ]; then (cd "$p" && pwd); return; fi
  printf '%s/%s' "$(cd "$(dirname "$p")" && pwd)" "$(basename "$p")"
}

# stb__names <identities-file>   (-> one "<file> :: <name>" per line; the command
#   index is shown as "[cmd <i>] " only when the run had more than one command)
stb__names() {
  awk -F '\t' -v multi="${STB_MULTI:-0}" '{ print (multi ? "[cmd " $1 "] " : "") $2 " :: " $3 }' "$1"
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

# stb__newly <line> <names>   (-> line with "; newly broken: <names>" after the FAILED
#   marker, before any " [source: ...]" tail)
stb__newly() {
  local line="$1" names="$2"
  if printf '%s' "$line" | grep -q -- '-- FAILED, exit [0-9]*'; then
    STB_N="$names" awk '{ match($0, /-- FAILED, exit [0-9]+/); print substr($0, 1, RSTART + RLENGTH - 1) "; newly broken: " ENVIRON["STB_N"] substr($0, RSTART + RLENGTH) }' <<<"$line"
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

# rst_base_compare <report-file> <commands-file> <head-log> <head-counts>
#   <report-file>   the TESTS_STATUS= / TESTS_LINE= lines rst_report produced
#   <commands-file> the commands the head run executed (one per line)
#   <head-log>      the head run's output (stop-tests.log)
#   <head-counts>   "<passed> <total>" from the head run, or empty
#   Prints the final report plus TESTS_BASE_COMPARE=<outcome>. Outcomes:
#     not_failed      head status is not "failed": base is never run
#     base_red        every head failure also fails on base -> TESTS_STATUS=base_red
#     newly_broken    a head failure passes on base -> failed, "newly broken: <names>"
#     unparsed        a failing head command lacks complete named evidence -> failed
#     no_base_sha     run-start-sha.txt missing or not a commit -> failed
#     no_counts       head pass/total not parsed -> failed
#     base_timeout    a base command timed out (exit 124) -> failed
#     base_passed     the base run did not fail -> failed, every head failure is new
#     base_unrunnable worktree or runner unavailable -> failed
#     escapes_worktree a command reaches outside the base worktree after rebasing
#                     head-checkout paths (an absolute cd elsewhere, or a head path
#                     spelled another way) -> failed, base never runs
#   Never returns nonzero.
rst_base_compare() {
  local report="$1" cmds="$2" head_log="$3" counts="$4"
  local status line art sha sha8 top wt base_log base_res base_exit base_counts bp bt
  local hp ht work ncmd nh nb k names newnames rc
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
  if ! declare -F rst_run_commands >/dev/null 2>&1 || ! declare -F rst_parse_counts >/dev/null 2>&1; then
    stb__emit "$report" base_unrunnable
    return 0
  fi
  work="$(mktemp -d)"
  ncmd="$(grep -c . "$cmds" 2>/dev/null || true)"; ncmd="${ncmd:-0}"
  STB_MULTI=0; [ "$ncmd" -gt 1 ] && STB_MULTI=1
  nh="$(stb_split_blocks "$head_log" "$work/head" "$ncmd")"
  if [ "$ncmd" -eq 0 ] || [ "$nh" -ne "$ncmd" ] || ! stb__head_identities "$work/head" "$nh" "$work/head.ids"; then
    rm -rf "$work"
    stb__emit "$report" unparsed
    return 0
  fi
  k="$(grep -c . "$work/head.ids" || true)"; k="${k:-0}"
  if [ "$k" -eq 0 ]; then
    rm -rf "$work"
    stb__emit "$report" unparsed
    return 0
  fi
  top="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  wt="$(stb__abs "$art")/stop-tests-base-wt.$$"
  # The base run must execute base code: every head-checkout root in a command is
  # rebased onto the base worktree, and a command that still reaches outside it fails
  # closed before any base worktree exists.
  stb__head_roots "$top" > "$work/roots"
  if ! stb__rebase_commands "$cmds" "$work/base.cmds" "$wt" "$work/roots"; then
    rm -rf "$work"
    stb__emit "$report" escapes_worktree
    return 0
  fi
  cmds="$work/base.cmds"
  mkdir -p "$art/evidence" 2>/dev/null || true
  base_log="$(stb__abs "$art/evidence")/stop-tests-base.log"
  : > "$base_log"
  stb__remove_worktree "$top" "$wt"
  if ! git -C "$top" worktree add --detach "$wt" "$sha" >> "$base_log" 2>&1; then
    stb__remove_worktree "$top" "$wt"
    rm -rf "$work"
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
  nb="$(stb_split_blocks "$base_log" "$work/base" "$ncmd")"
  rc=0
  stb__base_identities "$work/base" "$nb" "$work/base.ids" || rc=$?
  if [ "$rc" -eq 2 ] || [ "$base_exit" = "124" ]; then
    rm -rf "$work"
    stb__emit "$report" base_timeout
    return 0
  fi
  LC_ALL=C sort -u "$work/head.ids" > "$work/head.sorted"
  LC_ALL=C sort -u "$work/base.ids" > "$work/base.sorted"
  LC_ALL=C comm -23 "$work/head.sorted" "$work/base.sorted" > "$work/new.ids"
  bp=""; bt=""
  case "$base_counts" in *[0-9]\ [0-9]*) bp="${base_counts%% *}"; bt="${base_counts##* }" ;; esac
  if [ "$base_exit" = "0" ] && { [ -z "$bt" ] || [ "$bp" -ge "$bt" ]; }; then
    stb__names "$work/head.ids" > "$work/names"
    newnames="$(stb__join "$work/names")"
    rm -rf "$work"
    stb__emit "$report" base_passed failed "$(stb__newly "$line" "$newnames")"
    return 0
  fi
  if grep -q . "$work/new.ids"; then
    stb__names "$work/new.ids" > "$work/names"
    newnames="$(stb__join "$work/names")"
    rm -rf "$work"
    stb__emit "$report" newly_broken failed "$(stb__newly "$line" "$newnames")"
    return 0
  fi
  stb__names "$work/head.ids" > "$art/base-red-tests.txt"
  names="$(stb__join "$art/base-red-tests.txt")"
  rm -rf "$work"
  printf 'stop-tests-base: base-red: %s\n' "$names" >&2
  stb__emit "$report" base_red base_red "$(stb__base_red_line "$line" "$hp" "$ht" "$k" "$sha8")"
  return 0
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
