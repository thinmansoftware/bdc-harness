#!/usr/bin/env bash
# june-shape-lane.sh -- tests for the rebuilt bdc-feature-development lane
# (WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01, bdc-xo#6687).
#
# Structural checks read .archon/workflows/defaults/bdc-feature-development.yaml (W) directly.
# Behavior checks run the REAL bash of W's nodes through fixtures/june-shape-fixture.py: a
# local bare Git remote, a stateful gh stub that records every call in order, and the same
# variable and node-output substitution the engine performs before bash runs.
#
# Covered here (slice 1): Test 1, Test 2 (a)-(d), Test 3, Test 7 (draft at create, ready
# last, markers survive a body rewrite, repair-in-place keeps its branch and PR), Test 8
# (exit table, removed and added steps, Correction B), Test 10, Correction F lane (a question
# with no code returns to its author). Test 9 lives in manifest-evidence-check.sh and
# Test 11 in fallback-pr-suppressed.sh.
#
# Run: bash .archon/workflows/defaults/__tests__/june-shape-lane.sh
# Optional: JUNE_SHAPE_ONLY=structural|fixture to run one half. Exits 1 on any failure. ASCII only.

set -uo pipefail

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && printf '  %s\n' "$2"; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] actual [$3]"; fi; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
REPO_ROOT="$(cd "$DEFAULTS/../../.." && pwd)"
W="$DEFAULTS/bdc-feature-development.yaml"
TSV="$HERE/fixtures/june-shape-exit-table.tsv"
FIXTURE="$HERE/fixtures/june-shape-fixture.py"
OTHER_LANES="
bdc-feature-development-astra.yaml
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-cursor.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-grok.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
"

# node_block <id>: the YAML text of one step, from its "- id:" line to the next step.
node_block() {
  tr -d '\r' < "$W" | awk -v id="  - id: $1" '
    $0 == id { c = 1; print; next }
    c && /^  - id: / { exit }
    c { print }
  '
}
count_in() { printf '%s\n' "$2" | grep -cF -- "$1" || true; }
count_w() { tr -d '\r' < "$W" | grep -cF -- "$1" || true; }

structural() {
  echo "--- Test 8: exit table regenerated from W equals june-shape-exit-table.tsv ---"
  local regen expected
  regen=$(tr -d '\r' < "$W" | awk '
    /^  - id: / { node = substr($0, 9) }
    /exit [1-9]/ && $0 !~ /^[[:space:]]*#/ { print node }
  ')
  expected=$(tr -d '\r' < "$TSV" | grep -v '^#' | cut -f1)
  if [ "$regen" = "$expected" ]; then
    ok "exit lines of W match the fixture row for row ($(printf '%s\n' "$regen" | grep -c .) rows)"
  else
    bad "exit lines of W differ from the fixture" "$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$regen") | head -20 | tr '\n' ' ')"
  fi
  # TODO-SLICE3: diff-repair is replaced by the written-out repair rounds; then every row is HARD.
  local nonhard
  nonhard=$(tr -d '\r' < "$TSV" | grep -v '^#' | awk -F'\t' '$3 != "HARD" && !($1 == "diff-repair" && $3 == "PENDING-SLICE3")' | head -5)
  assert_eq "every fixture row is HARD (diff-repair pending slice 3)" "" "$nonhard"
  local blank_tag
  blank_tag=$(tr -d '\r' < "$TSV" | grep -v '^#' | awk -F'\t' 'NF != 3 || $2 == ""' | head -3)
  assert_eq "every fixture row has a step, a reason tag and a fate" "" "$blank_tag"

  echo "--- Test 8: removed and added steps ---"
  local id
  for id in evidence-repair-start evidence-repair-final evidence-repair-verify implement-block-gate blocked-terminal-gate; do
    assert_eq "step $id is gone (no id line, no reference)" "0" "$(count_w "$id")"
  done
  for id in lane-scope-check hold-if-findings; do
    assert_eq "step $id exists once" "1" "$(tr -d '\r' < "$W" | grep -cx "  - id: $id" || true)"
  done
  assert_eq "hold-if-findings is the last step" "hold-if-findings" "$(tr -d '\r' < "$W" | grep '^  - id: ' | tail -1 | sed 's/^  - id: //')"
  local hold
  hold=$(node_block hold-if-findings)
  assert_eq "hold-if-findings declares no timeout key" "0" "$(printf '%s\n' "$hold" | grep -cE '^    (timeout|idle_timeout|wall_timeout_ms):' || true)"
  assert_eq "hold-if-findings runs all_done" "1" "$(count_in 'trigger_rule: all_done' "$hold")"
  assert_eq "hold-if-findings never applies merge-hold" "0" "$(count_in 'merge-hold' "$hold")"

  echo "--- Test 8: Correction B (HEAD name) in commit-and-push ---"
  local cap
  cap=$(node_block commit-and-push)
  assert_eq "commit-and-push no longer keys on HEAD named archon/thread-*" "0" "$(printf '%s\n' "$cap" | grep -cE 'archon/thread-\*\)|in[[:space:]]*archon/thread-' || true)"
  assert_eq "W:5855 thread-id token check remains" "1" "$(count_in "is not a bare [A-Za-z0-9_-] token" "$cap")"
  assert_eq "W:6084 final pushed ref shape check remains (with the run marker)" "1" "$(count_in 'Malformed branch name' "$cap")"
  assert_eq "new run branch carries -run-<12 hex>" "1" "$(count_in 'UNIQUE_BRANCH="${BRANCH}-thread-${THREAD_ID}-run-${RUN_MARKER:-}"' "$cap")"
  assert_eq "commit-and-push no longer applies the out-of-scope rule" "0" "$(count_in 'out_of_scope: true' "$cap")"
  assert_eq "commit-and-push depends on noninteractive-salvage" "1" "$(printf '%s\n' "$cap" | grep -cE '^    depends_on: .*noninteractive-salvage' || true)"
  assert_eq "commit-and-push runs all_done" "1" "$(printf '%s\n' "$cap" | grep -cx '    trigger_rule: all_done' || true)"

  echo "--- Salvage decided once, before publication ---"
  local sal
  sal=$(node_block noninteractive-salvage)
  assert_eq "noninteractive-salvage depends on block-reclassify only" "1" "$(count_in 'depends_on: [block-reclassify]' "$sal")"
  assert_eq "noninteractive-salvage never pushes" "0" "$(count_in 'git push' "$sal")"
  assert_eq "noninteractive-salvage never opens a PR" "0" "$(count_in 'gh pr' "$sal")"
  assert_eq "noninteractive-salvage commits with the salvage trailer" "1" "$(count_in 'Cauldron-Role: salvage' "$sal")"

  echo "--- Draft-first PR, production guard, single ready ---"
  assert_eq "one gh pr ready in W" "1" "$(count_w 'gh pr ready')"
  assert_eq "gh pr create --repo: the create plus the recovery hint" "2" "$(count_w 'gh pr create --repo')"
  assert_eq "bdc_refuse_production_base on the override and the final base" "2" "$(count_w 'bdc_refuse_production_base')"
  local opr
  opr=$(node_block open-pr-if-needed)
  assert_eq "the PR create is a draft" "1" "$(printf '%s\n' "$opr" | grep -c 'CREATE_OUT=$(gh pr create --repo "$REPO" --draft' || true)"
  assert_eq "open-pr-if-needed has no create retry loop" "0" "$(count_in 'for attempt in 1 2 3; do' "$(printf '%s\n' "$opr" | sed -n '/same-head-adopt: end/,$p')")"
  assert_eq "PR body starts with the Cauldron-Run marker" "1" "$(count_in 'echo "Cauldron-Run: ${OPR_RUN_ID}"' "$opr")"

  echo "--- Test 10: lane-scope-check before implement ---"
  local lsc impl
  lsc=$(node_block lane-scope-check)
  impl=$(node_block implement)
  assert_eq "lane-scope-check ends the run on failure" "1" "$(count_in 'abort_run_on_failure: true' "$lsc")"
  assert_eq "lane-scope-check runs after read-spec" "1" "$(count_in 'depends_on: [read-spec]' "$lsc")"
  assert_eq "implement depends on lane-scope-check" "1" "$(printf '%s\n' "$impl" | grep -cE '^    depends_on: .*lane-scope-check' || true)"
  assert_eq "implement runs only on LANE_SCOPE=ok and no plan-review question" "1" "$(printf '%s\n' "$impl" | grep -c "lane-scope-check.output == 'LANE_SCOPE=ok' && \$plan-review.output != 'UNATTENDED_QUESTION=true'" || true)"

  echo "--- Correction F: workflow key and lane wiring ---"
  assert_eq "unattended_questions: report set once in W" "1" "$(tr -d '\r' < "$W" | grep -cx 'unattended_questions: report' || true)"
  local lane
  for lane in $OTHER_LANES; do
    if grep -q 'unattended_questions:' "$DEFAULTS/$lane"; then bad "$lane must not set unattended_questions"; else ok "$lane does not set unattended_questions"; fi
  done
  for id in commit-and-push open-pr-if-needed noninteractive-salvage derive-run-source-scope; do
    assert_eq "$id skips a run returned to its author" "1" "$(count_in "BUILD_OUTCOME=RETURNED_TO_AUTHOR'" "$(node_block "$id")")"
  done

  echo "--- Test 12 (parity): the other 12 lane files are byte-identical to dev 58251246 ---"
  if git -C "$REPO_ROOT" cat-file -e 58251246^{commit} 2>/dev/null; then
    for lane in $OTHER_LANES; do
      if git -C "$REPO_ROOT" diff --quiet 58251246 -- ".archon/workflows/defaults/$lane"; then ok "$lane unchanged"; else bad "$lane changed since 58251246"; fi
    done
  else
    bad "dev 58251246 not reachable in this checkout; cannot prove the other lanes are unchanged"
  fi

  echo "--- ASCII only ---"
  local f
  for f in "$W" "$TSV" "$FIXTURE" "${BASH_SOURCE[0]}"; do
    if LC_ALL=C grep -q '[^[:print:][:space:]]' "$f"; then bad "non-ASCII in $(basename "$f")"; else ok "ASCII only: $(basename "$f")"; fi
  done
}

fixture() {
  local scenario out rc
  for scenario in blocked hold-failures prod-guard markers repair scope returned; do
    echo "--- fixture scenario: $scenario ---"
    out=$(python3 "$FIXTURE" "$scenario" 2>&1); rc=$?
    printf '%s\n' "$out" | grep -E '^(PASS|FAIL): '
    PASS=$((PASS + $(printf '%s\n' "$out" | grep -c '^PASS: ' || true)))
    FAIL=$((FAIL + $(printf '%s\n' "$out" | grep -c '^FAIL: ' || true)))
    if [ "$rc" -ne 0 ] && ! printf '%s\n' "$out" | grep -q '^FAIL: '; then
      bad "fixture scenario $scenario exited $rc without a FAIL line" "$(printf '%s\n' "$out" | tail -5 | tr '\n' ' ')"
    fi
  done
}

case "${JUNE_SHAPE_ONLY:-all}" in
  structural) structural ;;
  fixture) fixture ;;
  *) structural; fixture ;;
esac

echo "june-shape-lane.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
