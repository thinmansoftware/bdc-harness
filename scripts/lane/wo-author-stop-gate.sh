# scripts/lane/wo-author-stop-gate.sh -- the stop-command gate of the bdc-wo-author
# intake (WO-HARNESS-WO-AUTHOR-INTAKE-REPAIR-01).
#
# SOURCED (not executed) by the stop-command-gate and stop-command-gate-final nodes of
# .archon/workflows/defaults/bdc-wo-author.yaml, through a resolution stub:
# $BDC_WAG_SCRIPT (tests), then $ARCHON_LANE_SCRIPTS_DIR/wo-author-stop-gate.sh
# (engine-materialized bundle), then the image copy /app/scripts/lane/wo-author-stop-gate.sh.
# When no copy is found the node fails closed (gate_script_missing). ASCII only.
#
# What it does, before a drafted spec may be committed (the full rule is the WO's
# "Gate algorithm"):
#   1. reads wo_id, spec_path and target_repo from the dry-run-preview output; no wo_id
#      is GATE no_spec (the run then fails at stop-command-gate-fail)
#   1b. refuses a MIXED spec (mixed_unsupported)
#   2. reads the target repo and base branch from the drafted spec itself (its
#      target_repo: and Base branch: lines) and refuses, before any checkout, unless
#      they agree with the dry-run footer, scripts/cauldron/cauldron-projects.json and
#      scripts/cauldron/repo-canonical-map.json in the bdc-xo worktree (base_unknown,
#      repo_mismatch, base_mismatch)
#   2a. runs the bdc-xo template validator scripts/cauldron/validate-wo-spec.sh on the
#      spec (validator_failed, validator_missing)
#   3. makes a clean shallow clone of the target repo's base branch under $ARTIFACTS_DIR
#      (checkout_failed); the final gate checks out exactly the first gate's
#      GATE_BASE_SHA instead (base_sha_unavailable)
#   4. installs JS dependencies with dprep_ensure_js_deps (output to stderr)
#   5. extracts the spec's commands with the build lane's own rule (rst_extract_commands |
#      rst_split_segments | rst_command_looks_runnable); more than 8 found is
#      commands_over_limit; none runnable is no_runnable_command for CODE or MIXED only
#   6. refuses `bun test` on a path without ./ (bun_path_without_dot_slash)
#   7. treats a command as expected red when its own declaring Stop block, or its own
#      When: line, carries the literal marker [expected red before the fix]; the marker
#      covers only the complete commands that source yields (exact equality)
#   8. runs each command in the clone and judges it with rst_parse_counts / rst_report
#   9. prints exactly ONE JSON object on stdout:
#      {"GATE":"pass|fail|no_spec","GATE_ALLOW":"yes|no","GATE_REASONS":"...",
#       "GATE_BASE_SHA":"<sha or empty>","GATE_OVERRIDES":"<BDC_WAG_* names or empty>"}
#      and writes the report table to $ARTIFACTS_DIR/stop-gate-report.md and stderr.
#
# The gate never commits, pushes or opens a PR. Its clone lives under $ARTIFACTS_DIR and
# is removed on exit (a timeout kill can skip the trap; the leftover stays there).
#
# Test overrides (each one set is named in GATE_OVERRIDES and on stderr):
#   BDC_WAG_SCRIPT     this file (read by the node stub)
#   BDC_WAG_REPO_URL   clone URL (default https://github.com/<target_repo>.git)
#   BDC_WAG_VALIDATOR  validator path (default scripts/cauldron/validate-wo-spec.sh)
#
# Requires, from the calling node: the rst core of the build lanes (rst_class,
# rst_extract_commands, rst_split_segments, rst_command_looks_runnable, rst_parse_cmd,
# rst_rescue_subdir, rst_run_commands, rst_parse_counts, rst_report, rst_failure_reason,
# RST_RS) and dprep_ensure_js_deps.
#
# Entry point: wag_main <first|final> <dry-run-preview output> [first gate JSON]

WAG_MARKER='[expected red before the fix]'
WAG_DIR=""

# wag_json_str <text>   (-> the text as JSON string content: backslash and double quote
#   escaped, control characters turned into spaces)
wag_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s" | LC_ALL=C tr '\000-\037' ' '
}

# wag_overrides   (-> comma-separated names of the BDC_WAG_* variables that are set)
wag_overrides() {
  local v out=""
  for v in $(compgen -v | grep '^BDC_WAG_' || true); do
    if [ -n "${!v:-}" ]; then out="${out:+$out,}$v"; fi
  done
  printf '%s' "$out"
}

# wag_emit <gate> <allow> <reasons> <base_sha> <overrides>   (the one stdout line)
wag_emit() {
  local reasons="$3"
  if [ "${#reasons}" -gt 2000 ]; then reasons="${reasons:0:2000}"; fi
  printf '{"GATE":"%s","GATE_ALLOW":"%s","GATE_REASONS":"%s","GATE_BASE_SHA":"%s","GATE_OVERRIDES":"%s"}\n' \
    "$1" "$2" "$(wag_json_str "$reasons")" "$4" "$(wag_json_str "$5")"
}

wag_cleanup() {
  if [ -n "${WAG_DIR:-}" ] && [ -d "$WAG_DIR" ]; then rm -rf "$WAG_DIR"; fi
  WAG_DIR=""
}

# wag_field <key> <text>   (-> value of the first "<key>=" line)
wag_field() {
  printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -n 1
}

# wag_spec_value <label> <spec text>   (-> trimmed value of the first "<label>:" line)
wag_spec_value() {
  printf '%s\n' "$2" | sed -n "s/^[[:space:]]*$1:[[:space:]]*//p" | head -n 1 | sed 's/[[:space:]]*$//'
}

# wag_extract_all   (spec on stdin -> every command rst_extract_commands would find,
#   WITHOUT its final head -n 8). The awk program below is a byte-identical copy of the
#   awk body of rst_extract_commands in bdc-feature-development-codex.yaml; the gate test
#   (Test 4 b) fails on any drift.
wag_extract_all() {
  awk -v RUNNER='(^|[ /&|;(])(node|bun|bunx|npm|npm[.]cmd|npx|pnpm|yarn|vitest|jest|mocha|pytest|python3?|go|cargo|bash|sh|make|deno|dotnet|mvn|gradle|tap)( |$)' '
    function clean(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); gsub(/`/, "", s); sub(/^\$ /, "", s); return s }
    function emit(c) { c = clean(c); if (c != "" && !(c in seen)) { seen[c] = 1; print c } }
    tstate == 1 {
      if ($0 ~ /^[ \t]*```/) next
      line = clean($0)
      if (line == "") next
      if (line ~ /^[Ee]xpected:/) { if (tcmd != "") emit(tcmd); tcmd = ""; tstate = 0; next }
      if (line ~ /^[*]*[Ss]top [0-9A-Za-z.]+/) { if (tcmd != "") emit(tcmd); tcmd = ""; tstate = 0 }
      else { tcmd = (tcmd == "" ? line : tcmd " " line); sub(/[ \t]*\\$/, "", tcmd); next }
    }
    tstate == 0 && /^[ \t]*[*]*[Ss]top [0-9A-Za-z.]+[ \t]*\(([Tt]est|[Uu]nit|[Ss]uite)/ { tstate = 1; tcmd = ""; next }
    /^#+ / { insec = ($0 ~ /[Ss]top [Cc]ondition|[Ss]top [Pp]oint|[Tt]est [Ss]cenario|[Tt]est [Pp]lan|[Vv]erification/) ? 1 : 0 }
    insec || $0 ~ /^[ \t]*-?[ \t]*[*]*[Ww]hen[*]*:/ {
      s = $0
      while (match(s, /`[^`]+`/)) {
        g = substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH)
        if (g ~ RUNNER) emit(g)
      }
    }
    /^[ \t]*Tests:[ \t]/ {
      s = $0
      while (match(s, /\([^)]*\)/)) {
        g = substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH)
        if (g ~ RUNNER) emit(g)
      }
    }
    END { if (tstate == 1 && tcmd != "") emit(tcmd) }
  '
}

# wag_first_path <cmd>   (-> the command's first relative path by rst_rescue_subdir's
#   token rule: the cd short-circuit, then the first parsed argv word that contains a /
#   and is not the segment separator, a flag, a URL, an assignment or a word holding a
#   space or tab, with a leading ./ removed; empty when there is none)
wag_first_path() {
  local cmd="$1" tok p=""
  case "$cmd" in cd\ *|*'&& cd '*) return 0 ;; esac
  rst_parse_cmd "$cmd" || return 0
  for tok in "${RST_WORDS[@]}"; do
    case "$tok" in
      "$RST_RS"|-*|*://*|*'='*|*' '*|*$'\t'*) continue ;;
      */*) p="${tok#./}"; break ;;
    esac
  done
  printf '%s' "$p"
}

# wag_runner <cmd>   (-> the command's runner word: the first argv word, or the word
#   after "cd <dir> &&")
wag_runner() {
  rst_parse_cmd "$1" || return 0
  if [ "${RST_WORDS[0]:-}" = "cd" ]; then printf '%s' "${RST_WORDS[3]:-}"; else printf '%s' "${RST_WORDS[0]:-}"; fi
}

# wag_bun_path_without_dot_slash <cmd>   (rc 0 when a "bun test" segment names a path
#   argument -- it holds a / or ends in .ts .tsx .js .mjs .cjs -- that starts with
#   neither ./ nor /; bun reads such an argument as a name filter and runs zero tests)
wag_bun_path_without_dot_slash() {
  local i j n
  local -a w=()
  rst_parse_cmd "$1" || return 1
  w=("${RST_WORDS[@]}")
  n=${#w[@]}
  for ((i = 0; i + 1 < n; i++)); do
    if [ "${w[i]}" = "bun" ] && [ "${w[i+1]}" = "test" ] && { [ "$i" -eq 0 ] || [ "${w[i-1]}" = "$RST_RS" ]; }; then
      for ((j = i + 2; j < n; j++)); do
        [ "${w[j]}" = "$RST_RS" ] && break
        case "${w[j]}" in
          -*|./*|/*) ;;
          */*|*.ts|*.tsx|*.js|*.mjs|*.cjs) return 0 ;;
        esac
      done
    fi
  done
  return 1
}

# wag_marked_sources <spec-file>   (-> one record per MARKED source, each ended by a
#   line holding only ASCII 0x1E: a "Stop N" block, from its header line to the next
#   Stop header or heading, whose text holds the expected-red marker anywhere, printed
#   after the heading that governs it; or a When: line that holds the marker itself)
wag_marked_sources() {
  WAG_MARK="$WAG_MARKER" awk -v RSEP="$(printf '\036')" '
    function flush() { if (inblk && marked) { print head; printf "%s", blk; print RSEP } inblk = 0; marked = 0; blk = "" }
    /^[ \t]*[*]*[Ss]top [0-9A-Za-z.]+/ { flush(); inblk = 1; blk = $0 "\n"; marked = (index($0, ENVIRON["WAG_MARK"]) > 0); next }
    /^#+ / { flush(); head = $0; next }
    {
      if ($0 ~ /^[ \t]*-?[ \t]*[*]*[Ww]hen[*]*:/ && index($0, ENVIRON["WAG_MARK"])) { print $0; print RSEP }
      if (inblk) { blk = blk $0 "\n"; if (index($0, ENVIRON["WAG_MARK"])) marked = 1 }
    }
    END { flush() }
  ' "$1"
}

# wag_marked_red <cmd> <spec-file>   (rc 0 when ANY source occurrence of the command
#   carries the expected-red marker. The marker applies only to the COMPLETE commands
#   that its own declaring source yields: each marked Stop block (with its governing
#   heading) or marked When: line is run through the same extraction rule as the whole
#   spec (wag_extract_all | rst_split_segments), and the command must EQUAL one of
#   them. A substring never matches, and a marker never reaches another block.)
wag_marked_red() {
  local want="$1" rec="" line c rs
  rs="$(printf '\036')"
  while IFS= read -r line; do
    if [ "$line" = "$rs" ]; then
      while IFS= read -r c; do
        if [ -n "$c" ] && [ "$c" = "$want" ]; then return 0; fi
      done <<EOF_WAG_MARKED
$(printf '%s' "$rec" | wag_extract_all | rst_split_segments)
EOF_WAG_MARKED
      rec=""
      continue
    fi
    rec+="$line"$'\n'
  done <<EOF_WAG_SOURCES
$(wag_marked_sources "$2")
EOF_WAG_SOURCES
  return 1
}

# wag_listed_created <path> <spec text>   (rc 0 when the path is on the spec's manifest
#   "Files created:" line)
wag_listed_created() {
  local want="$1" line item
  line="$(wag_spec_value 'Files created' "$2")"
  [ -n "$line" ] || return 1
  local IFS=','
  for item in $line; do
    item="$(printf '%s' "$item" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/`//g; s#^\./##')"
    [ "$item" = "$want" ] && return 0
  done
  return 1
}

# wag_operator_stops <spec text>   (-> one "Stop N (operator check)" header per line)
wag_operator_stops() {
  printf '%s\n' "$1" | grep -oE '^[[:space:]]*[*]*[Ss]top [0-9A-Za-z.]+[[:space:]]*\(operator check\)' | sed 's/^[[:space:]]*//' || true
}

# wag_map_entry <bare-repo-name>   (map file on stdin -> two lines: repo, base_branch;
#   rc 2 when the map is not JSON, 3 when the entry is missing)
wag_map_entry() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
e = d.get(sys.argv[1]) if isinstance(d, dict) else None
if not isinstance(e, dict):
    sys.exit(3)
r = e.get("repo")
b = e.get("base_branch")
print(r if isinstance(r, str) else "")
print(b if isinstance(b, str) else "")
' "$1"
}

# wag_canon_entry <bare-repo-name>   (-> the entry's "github" owner/repo from
#   scripts/cauldron/repo-canonical-map.json; rc nonzero when the file, the entry or
#   the field is missing)
wag_canon_entry() {
  [ -f scripts/cauldron/repo-canonical-map.json ] || return 1
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
e = d.get(sys.argv[1]) if isinstance(d, dict) else None
g = e.get("github") if isinstance(e, dict) else None
if not isinstance(g, str) or not g:
    sys.exit(3)
print(g)
' "$1" < scripts/cauldron/repo-canonical-map.json
}

wag_main() {
  local mode="$1" preview="${2:-}" first="${3:-}"
  local ovr="" wo_id="" spec_path="" target_repo="" spec="" class="" name="" map_out="" map_repo="" base="" spec_base="" spec_target="" canon_repo=""
  local validator="" vout="" vrc=0 vlines="" url="" sha="" pin_sha="" g1="" reasons="" fatal=0 cmds_status=""
  local report="" art="" cmd="" all_count=0 line="" idx=0 expect="" rescued="" cf="" clog="" result="" rc=0 counts="" env=""
  local rep="" status="" breason="" fr="" p="" t="" first_path="" runner="" verdict=""
  local -a cmds=()
  ovr="$(wag_overrides)"
  if [ -n "$ovr" ]; then echo "wo-author-stop-gate: test overrides set: $ovr" >&2; fi
  art="${ARTIFACTS_DIR:-${TMPDIR:-/tmp}}"
  mkdir -p "$art" 2>/dev/null || true
  report="$art/stop-gate-report.md"

  add_reason() { reasons="${reasons:+$reasons; }$1:$2:$3"; }

  if [ "$mode" = "final" ]; then
    g1="$(printf '%s' "$first" | sed -n 's/.*"GATE":"\([a-z_]*\)".*/\1/p' | head -n 1)"
    if [ "$g1" = "pass" ] || [ "$g1" = "no_spec" ]; then
      echo "wo-author-stop-gate: first gate returned $g1; passing it through unchanged" >&2
      printf '%s\n' "$first"
      return 0
    fi
    pin_sha="$(printf '%s' "$first" | sed -n 's/.*"GATE_BASE_SHA":"\([0-9a-f]*\)".*/\1/p' | head -n 1)"
  fi

  # 1. Inputs.
  wo_id="$(wag_field wo_id "$preview")"
  spec_path="$(wag_field spec_path "$preview")"
  target_repo="$(wag_field target_repo "$preview")"
  if [ -z "$wo_id" ]; then
    echo "wo-author-stop-gate: no wo_id in the dry-run-preview output; no spec drafted" >&2
    wag_emit no_spec no "no spec drafted" "" "$ovr"
    return 0
  fi
  {
    echo "## stop-command gate ($mode) for $wo_id"
    echo ""
    echo "spec_path: $spec_path; target_repo: $target_repo"
    echo ""
  } > "$report.part"
  if [ -z "$spec_path" ] || [ ! -f "$spec_path" ]; then
    add_reason 0 spec_missing "${spec_path:-(empty spec_path)}"
    fatal=1
  else
    spec="$(cat "$spec_path")"
  fi

  # 1b. Class.
  if [ "$fatal" -eq 0 ]; then
    class="$(printf '%s\n' "$spec" | rst_class)"
    echo "class: $class" >> "$report.part"
    if [ "$class" = "MIXED" ]; then
      add_reason 0 mixed_unsupported "MIXED specs carry a stages: list and no target_repo: line; this gate checks out one repo"
      fatal=1
    fi
  fi

  # 2. Target repo and base branch come from the drafted spec itself. The spec's
  #    target_repo: line must equal the dry-run footer, the project map entry and the
  #    repo-canonical-map.json entry; its Base branch: line must equal the project map's
  #    base_branch. Any mismatch is refused here, before any checkout.
  if [ "$fatal" -eq 0 ]; then
    spec_target="$(wag_spec_value 'target_repo' "$spec")"
    spec_base="$(wag_spec_value 'Base branch' "$spec")"
    name="${spec_target#*/}"
    if [ -z "$spec_target" ] || [ "$name" = "$spec_target" ]; then
      add_reason 0 repo_mismatch "spec has no owner/repo target_repo: line (footer says '${target_repo}')"
      fatal=1
    elif [ "$spec_target" != "$target_repo" ]; then
      add_reason 0 repo_mismatch "spec target_repo '$spec_target' is not the dry-run footer target_repo '$target_repo'"
      fatal=1
    elif [ ! -f scripts/cauldron/cauldron-projects.json ]; then
      add_reason 0 base_unknown "scripts/cauldron/cauldron-projects.json missing"
      fatal=1
    elif ! map_out="$(wag_map_entry "$name" < scripts/cauldron/cauldron-projects.json)"; then
      add_reason 0 base_unknown "$name not in scripts/cauldron/cauldron-projects.json"
      fatal=1
    else
      map_repo="$(printf '%s\n' "$map_out" | sed -n 1p)"
      base="$(printf '%s\n' "$map_out" | sed -n 2p)"
      if [ -z "$base" ]; then
        add_reason 0 base_unknown "$name has no base_branch in scripts/cauldron/cauldron-projects.json"
        fatal=1
      elif [ "$map_repo" != "$spec_target" ]; then
        add_reason 0 repo_mismatch "project map repo $map_repo is not spec target_repo $spec_target"
        fatal=1
      elif ! canon_repo="$(wag_canon_entry "$name")"; then
        add_reason 0 repo_mismatch "$name not in scripts/cauldron/repo-canonical-map.json"
        fatal=1
      elif [ "$canon_repo" != "$spec_target" ]; then
        add_reason 0 repo_mismatch "repo-canonical-map.json github $canon_repo is not spec target_repo $spec_target"
        fatal=1
      elif [ "$spec_base" != "$base" ]; then
        add_reason 0 base_mismatch "spec Base branch '$spec_base' is not map base_branch '$base'"
        fatal=1
      else
        echo "target: $spec_target (spec, footer, project map and canonical map agree); base branch: $base" >> "$report.part"
      fi
    fi
  fi

  # 2a. Template validator (normal mode; needs GitHub auth, so it runs before step 8).
  if [ "$fatal" -eq 0 ]; then
    validator="${BDC_WAG_VALIDATOR:-scripts/cauldron/validate-wo-spec.sh}"
    if [ ! -f "$validator" ]; then
      add_reason 0 validator_missing "$validator"
      echo "validator: MISSING ($validator)" >> "$report.part"
    else
      vout="$(bash "$validator" "$spec_path" 2>&1)"
      vrc=$?
      printf '%s\n' "$vout" | sed 's/^/validate-wo-spec: /' >&2
      if [ "$vrc" -eq 0 ] && printf '%s\n' "$vout" | grep -q '^RESULT: PASS'; then
        echo "validator: RESULT: PASS" >> "$report.part"
      else
        vlines="$(printf '%s\n' "$vout" | grep -E '^FAIL' | head -n 5 | paste -sd '|' - | sed 's/|/ | /g')"
        [ -n "$vlines" ] || vlines="$(printf '%s\n' "$vout" | grep -v '^[[:space:]]*$' | tail -n 5 | paste -sd '|' - | sed 's/|/ | /g')"
        add_reason 0 validator_failed "exit $vrc: ${vlines:-no output}"
        echo "validator: FAILED (exit $vrc): $vlines" >> "$report.part"
      fi
    fi
  fi

  # 3. Clean checkout under $ARTIFACTS_DIR. Removed on every exit path.
  if [ "$fatal" -eq 0 ]; then
    url="${BDC_WAG_REPO_URL:-https://github.com/${target_repo}.git}"
    WAG_DIR="$(mktemp -d "$art/wag-checkout.XXXXXX")"
    trap wag_cleanup EXIT
    if [ "$mode" = "final" ]; then
      if ! printf '%s' "${pin_sha:-}" | grep -qE '^[0-9a-f]{40}$'; then
        add_reason 0 base_sha_unavailable "first gate recorded no GATE_BASE_SHA"
        fatal=1
      elif ! { git init -q "$WAG_DIR/repo" && git -C "$WAG_DIR/repo" remote add origin "$url" \
          && git -C "$WAG_DIR/repo" fetch -q --depth 1 origin "$pin_sha" \
          && git -C "$WAG_DIR/repo" checkout -q --detach FETCH_HEAD; } >&2 2>&1; then
        add_reason 0 base_sha_unavailable "$pin_sha"
        fatal=1
      fi
    elif ! git clone -q --depth 1 --branch "$base" -- "$url" "$WAG_DIR/repo" >&2 2>&1; then
      add_reason 0 checkout_failed "$base"
      fatal=1
    fi
    if [ "$fatal" -eq 0 ]; then
      sha="$(git -C "$WAG_DIR/repo" rev-parse HEAD 2>/dev/null || true)"
      if [ "$mode" = "final" ] && [ "$sha" != "$pin_sha" ]; then
        add_reason 0 base_sha_unavailable "checked out $sha, wanted $pin_sha"
        fatal=1
      else
        echo "checkout: $base at $sha" >> "$report.part"
        echo "wo-author-stop-gate: checked out $sha" >&2
      fi
    fi
  fi

  # 4. Dependencies (stdout of the install goes to stderr).
  if [ "$fatal" -eq 0 ] && declare -F dprep_ensure_js_deps >/dev/null; then
    ( cd "$WAG_DIR/repo" && dprep_ensure_js_deps ) >&2 2>&1 || true
  fi

  # 5. Extraction, by the build lane's own rule.
  if [ "$fatal" -eq 0 ]; then
    all_count="$(printf '%s\n' "$spec" | wag_extract_all | grep -c . || true)"
    if [ "${all_count:-0}" -gt 8 ]; then
      add_reason 0 commands_over_limit "$all_count commands found; the build lane runs only the first 8"
      fatal=1
    fi
  fi
  if [ "$fatal" -eq 0 ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if rst_command_looks_runnable "$line"; then cmds+=("$line"); else echo "wo-author-stop-gate: not a runnable command, ignored: $line" >&2; fi
    done <<EOF_WAG_CMDS
$(printf '%s\n' "$spec" | rst_extract_commands | rst_split_segments)
EOF_WAG_CMDS
    if [ "${#cmds[@]}" -eq 0 ]; then
      case "$class" in
        CODE|MIXED) add_reason 0 no_runnable_command "$class spec declares no runnable test command"; cmds_status="no_runnable_command" ;;
        *) cmds_status="not_required" ;;
      esac
    fi
  fi

  # 6. Static rule, before anything runs.
  if [ "$fatal" -eq 0 ] && [ "${#cmds[@]}" -gt 0 ]; then
    idx=0
    for cmd in "${cmds[@]}"; do
      idx=$((idx + 1))
      if wag_bun_path_without_dot_slash "$cmd"; then add_reason "$idx" bun_path_without_dot_slash "$cmd"; fatal=1; fi
    done
  fi

  # 7 and 8. Expectation and run.
  printf '%s\n' "$spec" > "$art/wag-spec.txt" 2>/dev/null || true
  if [ "$fatal" -eq 0 ] && [ "${#cmds[@]}" -gt 0 ]; then
    {
      echo ""
      echo "| # | command | expected | exit | counts | verdict |"
      echo "|---|---|---|---|---|---|"
    } >> "$report.part"
    idx=0
    for cmd in "${cmds[@]}"; do
      idx=$((idx + 1))
      if wag_marked_red "$cmd" "$art/wag-spec.txt"; then expect="red"; else expect="green"; fi
      rescued="$(cd "$WAG_DIR/repo" && rst_rescue_subdir "$cmd")"
      cf="$(mktemp)"; clog="$(mktemp)"
      printf '%s\n' "$rescued" > "$cf"
      # Subshell: rst_run_commands scrubs GH_TOKEN and friends from the calling shell.
      result="$(cd "$WAG_DIR/repo" && rst_run_commands "$cf" "$clog")"
      env=""
      case "$result" in *$'\t'*) env="${result#*$'\t'}"; result="${result%%$'\t'*}" ;; esac
      rc="${result%% *}"; counts="${result#* }"
      counts="$(printf '%s' "$counts" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      cat "$clog" >&2
      if [ "$expect" = "green" ]; then
        rep="$(SOURCE=spec_declared rst_report "$class" "$cmd" "$rc" "$counts" "$env" "$clog")"
        status="$(printf '%s\n' "$rep" | sed -n 's/^TESTS_STATUS=//p' | head -n 1)"
        breason="$(printf '%s\n' "$rep" | sed -n 's/^TESTS_BLOCKED_REASON=//p' | head -n 1)"
        case "$status" in
          passed) verdict="passed" ;;
          failed) verdict="green_failed" ;;
          counts_unparsed) verdict="counts_unparsed" ;;
          env_unavailable) verdict="env_unavailable" ;;
          blocked) verdict="blocked:${breason}" ;;
          *) verdict="green_failed" ;;
        esac
      else
        fr="$(rst_failure_reason "$rc" "$clog" "$cmd")"
        p="${counts%% *}"; t="${counts##* }"
        if [ "$rc" -eq 0 ]; then
          verdict="red_passed_before_fix"
        elif [ -n "$env" ]; then
          verdict="red_env"
        elif [ -n "$counts" ] && [ "$t" -gt "$p" ] && [ -z "$fr" ]; then
          verdict="red_confirmed"
        else
          case "$fr" in
            timeout:*) verdict="red_$fr" ;;
            *)
              first_path="$(wag_first_path "$cmd")"
              runner="$(wag_runner "$cmd")"
              if [ -n "$first_path" ] && [ "$rescued" = "$cmd" ] && [ ! -e "$WAG_DIR/repo/$first_path" ]; then
                if ! wag_listed_created "$first_path" "$spec"; then verdict="red_unlisted_path"
                elif [ -z "$runner" ] || ! command -v "$runner" >/dev/null 2>&1; then verdict="red_runner_missing"
                else verdict="red_new_file"
                fi
              elif [ -n "$fr" ]; then
                verdict="red_$fr"
              else
                verdict="red_unparsed"
              fi
              ;;
          esac
        fi
      fi
      echo "| $idx | \`$cmd\` | $expect | $rc | ${counts:-none} | $verdict |" >> "$report.part"
      case "$verdict" in
        passed|red_confirmed|red_new_file) ;;
        *) add_reason "$idx" "$verdict" "$cmd" ;;
      esac
      rm -f "$cf" "$clog"
    done
  fi
  rm -f "$art/wag-spec.txt"

  {
    if [ -n "$cmds_status" ]; then echo ""; echo "commands: $cmds_status"; fi
    if [ "$fatal" -eq 0 ] && [ -n "${spec:-}" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] && echo "not run: $line -- recorded by the operator"
      done <<EOF_WAG_OPS
$(wag_operator_stops "$spec")
EOF_WAG_OPS
    fi
    echo ""
    if [ -z "$reasons" ]; then echo "GATE: pass"; else echo "GATE: fail -- $reasons"; fi
    echo ""
  } >> "$report.part"
  if [ "$mode" = "final" ]; then cat "$report.part" >> "$report"; else cat "$report.part" > "$report"; fi
  cat "$report.part" >&2
  rm -f "$report.part"
  wag_cleanup
  if [ -z "$reasons" ]; then
    wag_emit pass yes "" "${sha:-}" "$ovr"
  else
    wag_emit fail no "$reasons" "${sha:-}" "$ovr"
  fi
  return 0
}
