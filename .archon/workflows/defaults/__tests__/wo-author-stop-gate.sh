#!/usr/bin/env bash
# wo-author-stop-gate.sh -- tests for the stop-command gate of bdc-wo-author
# (WO-HARNESS-WO-AUTHOR-INTAKE-REPAIR-01, Tests 4 to 10, 12 and 13).
#
# The gate nodes' real bash is EXTRACTED from .archon/workflows/defaults/bdc-wo-author.yaml
# (the stop-command-gate and stop-command-gate-final blocks), its node-output references
# are substituted the way the engine does (single-quoted), and it is run against
# temporary local git fixture repos, a fake bdc-xo worktree (scripts/cauldron/
# cauldron-projects.json) and stub validators. No network.
#
# Every PASS:/FAIL: label starts with its test number and letter, e.g. "Test 8 (e)".
# Run: bash .archon/workflows/defaults/__tests__/wo-author-stop-gate.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail
shopt -u patsub_replacement 2>/dev/null || true

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected: [$expected]"; echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle:   $needle"; echo "  haystack: $haystack"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle present: $needle"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
YAML="$DEFAULTS/bdc-wo-author.yaml"
CODEX="$DEFAULTS/bdc-feature-development-codex.yaml"
GATE_SCRIPT="$REPO_ROOT/scripts/lane/wo-author-stop-gate.sh"

for f in "$YAML" "$CODEX" "$GATE_SCRIPT"; do
  if [ ! -f "$f" ]; then echo "FATAL: missing $f"; exit 1; fi
done

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

extract_core_nth() {
  # Same as run-stop-tests.sh extract_core_nth: the nth core body (1-based).
  tr -d '\r' < "$1" | awk -v m="$2" -v n="$3" '
    index($0, "# ---- BEGIN " m " core") { seen++; if (seen == n + 0) c = 1; next }
    index($0, "# ---- END " m " core") { if (c) { c = 0; exit } next }
    c
  ' | sed 's/^      //'
}

# node_script <node-id>   (-> the node's bash block, de-indented by 6)
node_script() {
  tr -d '\r' < "$YAML" | awk -v id="$1" '
    $0 == "  - id: " id { hit = 1; next }
    hit && !inb && $0 ~ /^    bash: [|]/ { inb = 1; next }
    hit && inb && $0 != "" && $0 !~ /^      / { exit }
    hit && !inb && $0 ~ /^  - id: / { exit }
    inb { print }
  ' | sed 's/^      //'
}

shq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
GIT_ID=(-c user.name=wag-test -c user.email=wag-test@example.invalid)
# Byte-stable fixtures on every host (Windows checkouts default to CRLF).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false

# ---- fixture target repo (branch dev) ----
FIX="$T/fixture"
git init -q -b dev "$FIX"
mkdir -p "$FIX/tests"
printf '#!/usr/bin/env bash\nprintf "PASS: one\\nPASS: two\\n"\nexit 0\n' > "$FIX/tests/ok.sh"
printf '#!/usr/bin/env bash\nprintf "FAIL: one\\n"\nexit 1\n' > "$FIX/tests/bad.sh"
printf '#!/usr/bin/env bash\necho hello\nexit 0\n' > "$FIX/tests/zero.sh"
printf '#!/usr/bin/env bash\nprintf "FAIL: slow\\n"\nsleep 10\nexit 1\n' > "$FIX/tests/slow.sh"
git -C "$FIX" add -A
git "${GIT_ID[@]}" -C "$FIX" commit -qm fixture
FIX_SHA="$(git -C "$FIX" rev-parse HEAD)"

# ---- fake bdc-xo worktree ----
XO="$T/xo"
mkdir -p "$XO/scripts/cauldron" "$XO/docs/work-orders"
cat > "$XO/scripts/cauldron/cauldron-projects.json" <<'EOF_MAP'
{
  "fixture": { "repo": "acme/fixture", "base_branch": "dev" },
  "mismatch": { "repo": "other/mismatch", "base_branch": "dev" }
}
EOF_MAP

# ---- stub validators ----
STUBS="$T/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/pass.sh" <<EOF_PASS
#!/usr/bin/env bash
printf '%s|%s\n' "\$#" "\$*" > "$STUBS/args.txt"
echo "RESULT: PASS"
exit 0
EOF_PASS
cat > "$STUBS/fail.sh" <<'EOF_FAIL'
#!/usr/bin/env bash
echo "FAIL 1: CHECK 7 -- section 2 cites no concrete artifact"
echo "RESULT: FAIL (1 failure(s))"
exit 1
EOF_FAIL

export BDC_WAG_SCRIPT="$GATE_SCRIPT"
export BDC_WAG_REPO_URL="file://$FIX"
export BDC_WAG_VALIDATOR="$STUBS/pass.sh"
export BDC_RSGARGV_SCRIPT="$REPO_ROOT/scripts/lane/rsg-argv.sh"
export BDC_DPREP_SCRIPT="$REPO_ROOT/scripts/lane/dprep.sh"
unset ARCHON_LANE_SCRIPTS_DIR
export ARTIFACTS_DIR="$T/artifacts"
mkdir -p "$ARTIFACTS_DIR"

GATE_NODE="$(node_script stop-command-gate)"
FINAL_NODE="$(node_script stop-command-gate-final)"
if [ -z "$GATE_NODE" ] || [ -z "$FINAL_NODE" ]; then
  echo "FATAL: could not extract the gate node scripts from $YAML"; exit 1
fi

# write_spec <id> <class-line> <header-extra> <body>
write_spec() {
  local id="$1" classline="$2" extra="$3" body="$4"
  {
    printf '# %s\n\n%s\n%s\n\n' "$id" "$classline" "$extra"
    printf '%s\n' "$body"
  } > "$XO/docs/work-orders/$id.md"
}

preview_for() {
  printf '=== DRY-RUN PREVIEW ===\nwo_id=%s\nspec_path=docs/work-orders/%s.md\nspec_on_disk=1\ntarget_repo=%s\nmode=--draft-only\n' "$1" "$1" "${2:-acme/fixture}"
}

OUT=""
ERR=""
# run_gate <first|final> <preview> [first-json]   (sets OUT and ERR)
run_gate() {
  local mode="$1" preview="$2" first="${3:-}" script
  if [ "$mode" = "final" ]; then
    script="$FINAL_NODE"
    script="${script//\$stop-command-gate.output/$(shq "$first")}"
  else
    script="$GATE_NODE"
  fi
  script="${script//\$dry-run-preview.output/$(shq "$preview")}"
  printf '%s\n' "$script" > "$T/node.sh"
  OUT="$(cd "$XO" && bash "$T/node.sh" 2> "$T/err.txt")"
  ERR="$(cat "$T/err.txt")"
}

jfield() { printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get(sys.argv[1], ""))' "$1" 2>/dev/null; }
one_json() {
  local lines
  lines="$(printf '%s\n' "$OUT" | grep -c . || true)"
  if [ "$lines" = "1" ] && printf '%s' "$OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if isinstance(d, dict) and all(k in d for k in ("GATE","GATE_ALLOW","GATE_REASONS","GATE_BASE_SHA","GATE_OVERRIDES")) else 1)' 2>/dev/null; then
    echo yes
  else
    echo "no ($lines lines: $OUT)"
  fi
}
verdict() { printf '%s|%s' "$(jfield GATE)" "$(jfield GATE_ALLOW)"; }
REPORT="$ARTIFACTS_DIR/stop-gate-report.md"
leftover() { find "$ARTIFACTS_DIR" -maxdepth 1 -name 'wag-checkout.*' | wc -l | tr -d ' '; }

code_spec() {
  # code_spec <id> <stop-section body> [files-created]
  write_spec "$1" "WO Class: CODE" "target_repo: acme/fixture
Base branch: dev" "## 8. Stop conditions (CI-executable)

$2

## 9. Manifest requirements (CODE class)

Files created: ${3:-none}"
}

# ---- Test 4: rst core parity ----
echo "--- Test 4: rst core parity and the uncapped extraction copy ---"
CANON="$(extract_core "$CODEX" rst)"
assert_eq "Test 4 (a) bdc-wo-author.yaml carries exactly two rst cores" "2" "$(grep -c 'BEGIN rst core' "$YAML")"
assert_eq "Test 4 (a) codex lane carries exactly one rst core" "1" "$(grep -c 'BEGIN rst core' "$CODEX")"
assert_eq "Test 4 (a) stop-command-gate rst core is byte-identical to the codex lane" "$CANON" "$(extract_core_nth "$YAML" rst 1)"
assert_eq "Test 4 (a) stop-command-gate-final rst core is byte-identical to the codex lane" "$CANON" "$(extract_core_nth "$YAML" rst 2)"
assert_eq "Test 4 (a) no third rst core" "" "$(extract_core_nth "$YAML" rst 3)"
assert_contains "Test 4 (a) the first core sits in stop-command-gate" "BEGIN rst core" "$GATE_NODE"
assert_contains "Test 4 (a) the second core sits in stop-command-gate-final" "BEGIN rst core" "$FINAL_NODE"
LANE_AWK="$(printf '%s\n' "$CANON" | awk '
  /^rst_extract_commands\(\) \{/ { f = 1; next }
  f && /^  awk -v RUNNER=/ { c = 1 }
  f && c && /^  '"'"' [|] head -n 8$/ { exit }
  c { print }')"
GATE_AWK="$(tr -d '\r' < "$GATE_SCRIPT" | awk '
  /^wag_extract_all\(\) \{/ { f = 1; next }
  f && /^  awk -v RUNNER=/ { c = 1 }
  f && c && /^  '"'"'$/ { exit }
  c { print }')"
assert_eq "Test 4 (b) the lane awk body was found (non-empty)" "yes" "$([ "$(printf '%s\n' "$LANE_AWK" | wc -l)" -gt 20 ] && echo yes || echo no)"
assert_eq "Test 4 (b) gate uncapped awk program is byte-identical to rst_extract_commands" "$LANE_AWK" "$GATE_AWK"

# Load the cores in this shell for the helper-level checks.
eval "$CANON"
# shellcheck source=/dev/null
. "$GATE_SCRIPT"

echo "--- Annex check 1: first relative path follows rst_rescue_subdir ---"
for frag in "case \"\$cmd\" in cd\\ *|*'&& cd '*)" "\"\$RST_RS\"|-*|*://*|*'='*|*' '*|*\$'\\t'*) continue ;;" '*/*) p="${tok#./}"; break ;;'; do
  assert_contains "Test 8 (rescue rule) lane rst_rescue_subdir has: $frag" "$frag" "$(declare -f rst_rescue_subdir 2>/dev/null; printf '%s\n' "$CANON")"
  assert_contains "Test 8 (rescue rule) gate wag_first_path has: $frag" "$frag" "$(tr -d '\r' < "$GATE_SCRIPT")"
done
assert_eq "Test 8 (rescue rule) leading ./ removed" "tests/x.sh" "$(wag_first_path 'bash ./tests/x.sh')"
assert_eq "Test 8 (rescue rule) quoted word with a space is skipped" "tests/x.sh" "$(wag_first_path "bash tests/x.sh 'a b/c'" )"
assert_eq "Test 8 (rescue rule) quoted path with a space never counts" "tests/y.sh" "$(wag_first_path "bash 'a b/c.sh' tests/y.sh")"
assert_eq "Test 8 (rescue rule) flag, URL and assignment words are skipped" "a/b.ts" "$(wag_first_path 'bun test --x=y/z --root=./q http://h/p ./a/b.ts')"
assert_eq "Test 8 (rescue rule) cd short-circuit yields no path" "" "$(wag_first_path 'cd sub && bash tests/x.sh')"
assert_eq "Test 8 (rescue rule) && cd short-circuit yields no path" "" "$(wag_first_path 'bash tests/a.sh && cd sub && bash tests/x.sh')"
assert_eq "Test 8 (rescue rule) separator element is skipped" "tests/b.sh" "$(wag_first_path 'make all && bash tests/b.sh')"

# ---- Test 5 ----
echo "--- Test 5: a green command passes; gate-final pins GATE_BASE_SHA ---"
code_spec WO-T-GREEN-01 "Stop 1 (test suite): the ok suite
  bash tests/ok.sh
  Expected: 2 passing / 2 total"
run_gate first "$(preview_for WO-T-GREEN-01)"
FIRST_GREEN="$OUT"
assert_eq "Test 5 (a) stdout is exactly one JSON object" "yes" "$(one_json)"
assert_eq "Test 5 (a) GATE pass and GATE_ALLOW yes" "pass|yes" "$(verdict)"
assert_eq "Test 5 (a) the checkout directory is gone afterwards" "0" "$(leftover)"
assert_contains "Test 5 (a) the report was written" "| 1 | \`bash tests/ok.sh\` | green | 0 | 2 2 | passed |" "$(cat "$REPORT")"
assert_eq "Test 5 (b) GATE_BASE_SHA is the fixture dev commit" "$FIX_SHA" "$(jfield GATE_BASE_SHA)"
assert_contains "Test 5 (b) GATE_OVERRIDES names BDC_WAG_REPO_URL" "BDC_WAG_REPO_URL" "$(jfield GATE_OVERRIDES)"
assert_contains "Test 5 (b) the overrides are reported on stderr" "test overrides set:" "$ERR"
# Move the tip: the new dev commit breaks ok.sh. gate-final must still check the pinned SHA.
printf '#!/usr/bin/env bash\nprintf "FAIL: moved\\n"\nexit 1\n' > "$FIX/tests/ok.sh"
git "${GIT_ID[@]}" -C "$FIX" commit -qam "move the tip"
MOVED_SHA="$(git -C "$FIX" rev-parse HEAD)"
FORCED_FAIL="${FIRST_GREEN/\"GATE\":\"pass\",\"GATE_ALLOW\":\"yes\"/\"GATE\":\"fail\",\"GATE_ALLOW\":\"no\"}"
run_gate final "$(preview_for WO-T-GREEN-01)" "$FORCED_FAIL"
assert_eq "Test 5 (c) gate-final stdout is one JSON object" "yes" "$(one_json)"
assert_eq "Test 5 (c) gate-final checks out the recorded GATE_BASE_SHA, not the moved tip" "$FIX_SHA" "$(jfield GATE_BASE_SHA)"
assert_eq "Test 5 (c) gate-final passes on the pinned commit (the moved tip would fail)" "pass|yes" "$(verdict)"
assert_eq "Test 5 (c) the moved tip really differs" "yes" "$([ "$MOVED_SHA" != "$FIX_SHA" ] && echo yes || echo no)"
assert_eq "Test 5 (c) gate-final leaves no checkout behind" "0" "$(leftover)"
run_gate final "$(preview_for WO-T-GREEN-01)" "$FIRST_GREEN"
assert_eq "Test 5 (c) gate-final prints a first-gate pass unchanged" "$FIRST_GREEN" "$OUT"
BOGUS="${FORCED_FAIL/$FIX_SHA/0123456789012345678901234567890123456789}"
run_gate final "$(preview_for WO-T-GREEN-01)" "$BOGUS"
assert_contains "Test 5 (c) an unfetchable GATE_BASE_SHA fails base_sha_unavailable" "base_sha_unavailable" "$(jfield GATE_REASONS)"
assert_eq "Test 5 (c) an unfetchable GATE_BASE_SHA gives GATE_ALLOW no" "fail|no" "$(verdict)"
# Restore a green tip for the rest of the file.
git -C "$FIX" checkout -q "$FIX_SHA" -- tests/ok.sh
git "${GIT_ID[@]}" -C "$FIX" commit -qam "restore ok.sh"

# ---- Test 6 ----
echo "--- Test 6: zero-test commands are refused ---"
code_spec WO-T-BUNPATH-01 "Stop 1 (test suite): bun without ./
  bun test scripts/x.test.ts
  Expected: 1 passing"
run_gate first "$(preview_for WO-T-BUNPATH-01)"
assert_contains "Test 6 (x1) bun test path without ./ fails bun_path_without_dot_slash" "1:bun_path_without_dot_slash:bun test scripts/x.test.ts" "$(jfield GATE_REASONS)"
assert_eq "Test 6 (x1) GATE fail, GATE_ALLOW no" "fail|no" "$(verdict)"
assert_not_contains "Test 6 (x1) nothing ran (rejected before anything runs)" "### run-stop-tests:" "$ERR"
code_spec WO-T-NOCOUNT-01 "Stop 1 (test suite): prints no counts
  bash tests/zero.sh
  Expected: 1 passing"
run_gate first "$(preview_for WO-T-NOCOUNT-01)"
assert_contains "Test 6 (x2) exit 0 with no counts fails counts_unparsed" "1:counts_unparsed:bash tests/zero.sh" "$(jfield GATE_REASONS)"
assert_eq "Test 6 (x2) GATE fail, GATE_ALLOW no" "fail|no" "$(verdict)"

# ---- Test 7 ----
echo "--- Test 7: an expected-green command that fails ---"
code_spec WO-T-BAD-01 "Stop 1 (test suite): bad, unmarked
  bash tests/bad.sh
  Expected: 1 passing"
run_gate first "$(preview_for WO-T-BAD-01)"
assert_contains "Test 7 green command that fails gives green_failed" "1:green_failed:bash tests/bad.sh" "$(jfield GATE_REASONS)"
assert_eq "Test 7 GATE fail, GATE_ALLOW no" "fail|no" "$(verdict)"

# ---- Test 8 ----
echo "--- Test 8: expected-red commands must really be red ---"
M='[expected red before the fix]'
code_spec WO-T-RED-A-01 "Stop 1 (test suite): bad, marked $M
  bash tests/bad.sh
  Expected: 0 passing before the fix"
run_gate first "$(preview_for WO-T-RED-A-01)"
assert_eq "Test 8 (a) marked failing test passes as red_confirmed" "pass|yes|red_confirmed" "$(verdict)|$(grep -o 'red_confirmed' "$REPORT" | head -n 1)"

code_spec WO-T-RED-B-01 "Stop 1 (test suite): ok, marked $M
  bash tests/ok.sh
  Expected: red"
run_gate first "$(preview_for WO-T-RED-B-01)"
assert_eq "Test 8 (b) marked test that passes fails red_passed_before_fix" "fail|no|1:red_passed_before_fix:bash tests/ok.sh" "$(verdict)|$(jfield GATE_REASONS)"

code_spec WO-T-RED-C-01 "Stop 1 (test suite): new file, marked $M
  bash tests/new.sh
  Expected: passes after the fix" "tests/new.sh, scripts/other.sh"
run_gate first "$(preview_for WO-T-RED-C-01)"
assert_eq "Test 8 (c) marked missing listed file passes as red_new_file" "pass|yes|red_new_file" "$(verdict)|$(grep -o 'red_new_file' "$REPORT" | head -n 1)"

code_spec WO-T-RED-D-01 "Stop 1 (test suite): new file, unmarked
  bash tests/new.sh
  Expected: 1 passing" "tests/new.sh"
run_gate first "$(preview_for WO-T-RED-D-01)"
# The WO text names green_failed here. The gate takes the reason rst_report names
# (Gate algorithm step 8), and rst_report classes exit 127 as blocked:missing_tool
# (rst_failure_reason, codex.yaml rst core). The verdict that matters -- GATE fail,
# not red_new_file -- is asserted; the exact reason is the lane's.
assert_eq "Test 8 (d) unmarked missing file fails as expected green (rst_report reason blocked:missing_tool:bash)" "fail|no|1:blocked:missing_tool:bash:bash tests/new.sh" "$(verdict)|$(jfield GATE_REASONS)"

code_spec WO-T-RED-E-01 "Stop 1 (test suite): new file, marked, not listed $M
  bash tests/new.sh
  Expected: passes after the fix" "scripts/other.sh"
run_gate first "$(preview_for WO-T-RED-E-01)"
assert_eq "Test 8 (e) marked missing file not on Files created fails red_unlisted_path" "fail|no|1:red_unlisted_path:bash tests/new.sh" "$(verdict)|$(jfield GATE_REASONS)"

code_spec WO-T-RED-F-01 "Stop 1 (test suite): slow, marked $M
  bash tests/slow.sh
  Expected: red"
RST_TIMEOUT_SECONDS=2 run_gate first "$(preview_for WO-T-RED-F-01)"
assert_eq "Test 8 (f) a timed-out red command fails red_timeout, not red_confirmed" "fail|no|1:red_timeout:2s:bash tests/slow.sh" "$(verdict)|$(jfield GATE_REASONS)"

write_spec WO-T-RED-G-01 "WO Class: CODE" "target_repo: acme/fixture
Base branch: dev" "## 7. Test scenarios

Test 1: bad
When: the test runs \`bash tests/bad.sh\`
Then: it fails before the fix

## 8. Stop conditions (CI-executable)

Stop 1 (test suite): bad, marked $M
  bash tests/bad.sh
  Expected: red before the fix"
run_gate first "$(preview_for WO-T-RED-G-01)"
assert_eq "Test 8 (g) unmarked When: line plus marked Stop block is judged red and passes red_confirmed" "pass|yes|red" "$(verdict)|$(grep -F '| 1 | `bash tests/bad.sh` |' "$REPORT" | awk -F'|' '{gsub(/ /, "", $4); print $4}')"

NOCARGO_PATH="$(printf '%s\n' "$PATH" | tr ':' '\n' | while IFS= read -r d; do [ -n "$d" ] && { [ -e "$d/cargo" ] || [ -e "$d/cargo.exe" ]; } || printf '%s\n' "$d"; done | paste -sd ':' -)"
code_spec WO-T-RED-H-01 "Stop 1 (test suite): runner missing, marked $M
  cargo test tests/new.sh
  Expected: passes after the fix" "tests/new.sh"
PATH="$NOCARGO_PATH" run_gate first "$(preview_for WO-T-RED-H-01)"
assert_eq "Test 8 (h) marked command whose runner is not on PATH fails red_runner_missing" "fail|no|1:red_runner_missing:cargo test tests/new.sh" "$(verdict)|$(jfield GATE_REASONS)"

# ---- Test 9 ----
echo "--- Test 9: the gate fails closed ---"
code_spec WO-T-UNK-01 "Stop 1 (test suite): ok
  bash tests/ok.sh
  Expected: 2 passing"
run_gate first "$(preview_for WO-T-UNK-01 acme/nothere)"
assert_eq "Test 9 (a) target not in the project map fails base_unknown" "fail|no|yes|base_unknown" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o base_unknown | head -n 1)"
BDC_WAG_REPO_URL="file://$T/does-not-exist" run_gate first "$(preview_for WO-T-UNK-01)"
assert_eq "Test 9 (b) a clone URL that does not exist fails checkout_failed" "fail|no|yes|checkout_failed" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o checkout_failed | head -n 1)"
code_spec WO-T-NONE-01 "Stop 1 (grep assertion): the file is there
  the operator reads it -- recorded by the operator"
run_gate first "$(preview_for WO-T-NONE-01)"
assert_eq "Test 9 (c) CODE spec with no runnable command fails no_runnable_command" "fail|no|yes|no_runnable_command" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o no_runnable_command | head -n 1)"
run_gate first "$(printf '=== DRY-RUN PREVIEW ===\nspec_path=docs/work-orders/WO-T-UNK-01.md\ntarget_repo=acme/fixture\n')"
assert_eq "Test 9 (d) dry-run output with no wo_id gives no_spec" "no_spec|no|yes" "$(verdict)|$(one_json)"
run_gate first ""
assert_eq "Test 9 (e) empty dry-run output gives no_spec" "no_spec|no|yes" "$(verdict)|$(one_json)"
run_gate first "DRY_RUN_PREVIEW: skipped (author-loop emitted BATCH_FAILURE) {not key=value"
assert_eq "Test 9 (f) malformed dry-run output gives no_spec" "no_spec|no|yes" "$(verdict)|$(one_json)"
NINE=""
for i in 1 2 3 4 5 6 7 8 9; do
  NINE="${NINE}Stop $i (test suite): ok $i
  bash tests/ok.sh n$i
  Expected: 2 passing

"
done
code_spec WO-T-NINE-01 "$NINE"
run_gate first "$(preview_for WO-T-NINE-01)"
assert_eq "Test 9 (g) nine runnable commands fail commands_over_limit, never a silent drop" "fail|no|yes|commands_over_limit" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o commands_over_limit | head -n 1)"
write_spec WO-T-REPO-01 "WO Class: CODE" "target_repo: acme/mismatch
Base branch: dev" "## 8. Stop conditions (CI-executable)

Stop 1 (test suite): ok
  bash tests/ok.sh
  Expected: 2 passing"
run_gate first "$(preview_for WO-T-REPO-01 acme/mismatch)"
assert_eq "Test 9 (h) map repo differs from target_repo fails repo_mismatch" "fail|no|yes|repo_mismatch" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o repo_mismatch | head -n 1)"
write_spec WO-T-BASE-01 "WO Class: CODE" "target_repo: acme/fixture
Base branch: main" "## 8. Stop conditions (CI-executable)

Stop 1 (test suite): ok
  bash tests/ok.sh
  Expected: 2 passing"
run_gate first "$(preview_for WO-T-BASE-01)"
assert_eq "Test 9 (i) spec Base branch differs from the map fails base_mismatch" "fail|no|yes|base_mismatch" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o base_mismatch | head -n 1)"
SAVED="$BDC_WAG_SCRIPT"
BDC_WAG_SCRIPT="$T/missing-gate.sh" ARCHON_LANE_SCRIPTS_DIR="$T/none" run_gate first "$(preview_for WO-T-GREEN-01)"
assert_eq "Test 9 (extra) a missing gate script fails closed gate_script_missing" "fail|no|yes|gate_script_missing" "$(verdict)|$(one_json)|$(jfield GATE_REASONS | grep -o gate_script_missing | head -n 1)"
export BDC_WAG_SCRIPT="$SAVED"

# ---- Test 10 ----
echo "--- Test 10: operator stops are left alone ---"
code_spec WO-T-OPS-01 "Stop 1 (test suite): ok
  bash tests/ok.sh
  Expected: 2 passing

Stop 2 (operator check): the operator runs the live health check by hand on staging and records the output -- recorded by the operator"
run_gate first "$(preview_for WO-T-OPS-01)"
assert_eq "Test 10 GATE pass, one command run, operator stop shown as not run" "pass|yes|1|1" "$(verdict)|$(grep -c '^| [0-9]' "$REPORT")|$(grep -c '^not run: Stop 2 (operator check)' "$REPORT")"

# ---- Test 12 ----
echo "--- Test 12: the template validator binds ---"
rm -f "$STUBS/args.txt"
run_gate first "$(preview_for WO-T-GREEN-01)"
assert_eq "Test 12 (x1) passing validator stub gives GATE pass; it got the spec path as its only argument" "pass|yes|1|docs/work-orders/WO-T-GREEN-01.md" "$(verdict)|$(cat "$STUBS/args.txt" 2>/dev/null)"
BDC_WAG_VALIDATOR="$STUBS/fail.sh" run_gate first "$(preview_for WO-T-GREEN-01)"
assert_eq "Test 12 (x2) failing validator gives validator_failed carrying the CHECK 7 line, though the command passed" "fail|no|yes|yes" "$(verdict)|$(jfield GATE_REASONS | grep -q 'validator_failed:exit 1: FAIL 1: CHECK 7' && echo yes)|$(grep -q '| 1 | `bash tests/ok.sh` | green | 0 | 2 2 | passed |' "$REPORT" && echo yes)"
BDC_WAG_VALIDATOR="$STUBS/no-such-validator.sh" run_gate first "$(preview_for WO-T-GREEN-01)"
assert_eq "Test 12 (x3) missing validator gives validator_missing" "fail|no|yes" "$(verdict)|$(jfield GATE_REASONS | grep -q 'validator_missing' && echo yes)"

# ---- Test 13 ----
echo "--- Test 13: each class ---"
NOCMD="## 8. Stop conditions (CI-executable)

Stop 1 (grep assertion): the readme exists
  grep -c 'fixture' README.md
  Expected: 0

Stop 2 (operator check): the operator reads the page by hand -- recorded by the operator"
write_spec WO-T-DOC-01 "WO Class: DOCUMENTATION-ONLY" "target_repo: acme/fixture
Base branch: dev" "$NOCMD"
run_gate first "$(preview_for WO-T-DOC-01)"
assert_eq "Test 13 (a) DOCUMENTATION-ONLY with no command passes, commands not_required" "pass|yes|1" "$(verdict)|$(grep -c '^commands: not_required' "$REPORT")"
write_spec WO-T-OPX-01 "WO Class: OPERATOR-EXECUTION" "target_repo: acme/fixture
Base branch: dev" "$NOCMD"
run_gate first "$(preview_for WO-T-OPX-01)"
assert_eq "Test 13 (b) OPERATOR-EXECUTION with no command passes, commands not_required" "pass|yes|1" "$(verdict)|$(grep -c '^commands: not_required' "$REPORT")"
write_spec WO-T-INFRA-01 "WO Class: INFRA" "target_repo: acme/fixture
Base branch: dev" "$NOCMD"
run_gate first "$(preview_for WO-T-INFRA-01)"
assert_eq "Test 13 (c) INFRA with only grep and operator stops passes, commands not_required" "pass|yes|1" "$(verdict)|$(grep -c '^commands: not_required' "$REPORT")"
write_spec WO-T-CODE0-01 "WO Class: CODE" "target_repo: acme/fixture
Base branch: dev" "$NOCMD"
run_gate first "$(preview_for WO-T-CODE0-01)"
assert_eq "Test 13 (d) CODE with no runnable command fails no_runnable_command" "fail|no|yes" "$(verdict)|$(jfield GATE_REASONS | grep -q no_runnable_command && echo yes)"
write_spec WO-T-MIXED-01 "WO Class: MIXED" "stages:
  - id: one
    repo: acme/fixture
Base branch: dev" "## 8. Stop conditions (CI-executable)

Stop 1 (test suite): ok
  bash tests/ok.sh
  Expected: 2 passing"
run_gate first "$(preview_for WO-T-MIXED-01)"
assert_eq "Test 13 (e) MIXED fails mixed_unsupported before any checkout" "fail|no|yes|0|" "$(verdict)|$(jfield GATE_REASONS | grep -q mixed_unsupported && echo yes)|$(printf '%s\n' "$ERR" | grep -c 'checked out' || true)|$(jfield GATE_BASE_SHA)"

echo ""
echo "wo-author-stop-gate.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
