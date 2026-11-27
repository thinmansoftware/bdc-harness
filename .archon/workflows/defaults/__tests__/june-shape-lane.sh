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
# Slice 2 (the guarded publication core, pubg_push): Test 4 and Test 13 (every publication path:
# checkpoint wip/, checkout-repair-target backup/, commit-and-push plain and lease, open-pr
# recovery re-push and adopt push, each with a planted secret, a secret only local tracking refs
# claim is on the remote, gitleaks absent, a bad ref, a stale lease where the path carries one,
# and a secret only in a merge result), Test 14 (prompt and doc; the Overseer lookup is a bun test
# in packages/workflows/src/june-shape-agent-branch-link.test.ts), Test 20's refused-push
# variants with bundle recovery after the worktree is released, the published-head ready check,
# and rule 1b (a run with one failed node and no finding is held). gitleaks must be on PATH.
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
  local nonhard
  nonhard=$(tr -d '\r' < "$TSV" | grep -v '^#' | awk -F'\t' '$3 != "HARD"' | head -5)
  assert_eq "every fixture row is HARD" "" "$nonhard"
  local blank_tag
  blank_tag=$(tr -d '\r' < "$TSV" | grep -v '^#' | awk -F'\t' 'NF != 3 || $2 == ""' | head -3)
  assert_eq "every fixture row has a step, a reason tag and a fate" "" "$blank_tag"

  echo "--- Test 8: removed and added steps ---"
  assert_eq "lane has 67 steps (bdc-xo#6687 comment 7211048145)" "67" "$(grep -c '^  - id: ' "$W")"
  for round in 1 2 3 4 5; do
    assert_eq "round $round has an independent reviewer" "1" "$(count_in 'agent: codex-adversarial-reviewer' "$(node_block "review-round-$round")")"
  done
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

  echo "--- Slice 2: one guarded publisher (pubg core), Corrections B and D (Tests 4, 13, 14) ---"
  assert_eq "Stop 19: the pubg core exists once" "1" "$(count_w '# ---- BEGIN pubg core')"
  assert_eq "Stop 4: one gitleaks git call" "1" "$(count_w 'gitleaks git')"
  assert_eq "Stop 31: the scan includes merge-commit patches" "1" "$(count_w 'diff-merges=separate')"
  assert_eq "Stop 33: a refused push is bundled into the host mount" "1" "$(count_w 'git bundle create /host-artifacts/')"
  assert_eq "Stop 32: published.head written once (pubg) and read once (hold-if-findings)" "2" "$(count_w 'evidence/published.head')"
  assert_eq "Stop 16: no push to the remote name" "0" "$(count_w 'git push origin')"
  assert_eq "Stop 11: no git push -u origin" "0" "$(count_w 'git push -u origin')"
  local pre core_free pushes
  pre=$(node_block preflight-github-auth)
  assert_eq "the pubg core lives in preflight-github-auth (the run's first node)" "1" "$(count_in '# ---- BEGIN pubg core' "$pre")"
  assert_eq "preflight-github-auth records the sha256 of the saved core in its output" "1" "$(count_in 'echo "PUBG_CORE_SHA256=$(sha256sum < "$ARTIFACTS_DIR/evidence/pubg.core.sh" | cut -c1-64)"' "$pre")"
  assert_eq "preflight-github-auth saves the core for the publishing nodes" "1" "$(count_in 'declare -f pubg_record pubg_preserve pubg_refuse pubg_have pubg_push > "$ARTIFACTS_DIR/evidence/pubg.core.sh"' "$pre")"
  core_free=$(tr -d '\r' < "$W" | awk '/# ---- BEGIN pubg core/ { c = 1 } !c { print } /# ---- END pubg core ----/ { c = 0 }')
  pushes=$(printf '%s\n' "$core_free" | grep -v '^[[:space:]]*#' | grep -F 'git push' | grep -vF 'echo "ERROR: git push failed after 3 attempts' || true)
  assert_eq "outside the pubg core, the only git push is the preflight dry run" 'if ! git push --dry-run origin "HEAD:refs/heads/preflight-auth-probe-$(date +%s)" 2>&1; then' "$(printf '%s\n' "$pushes" | sed 's/^[[:space:]]*//')"
  assert_eq "exactly one PR creation call" "1" "$(printf '%s\n' "$core_free" | grep -cF '$(gh pr create --repo' || true)"
  local id blk
  for id in checkout-repair-target checkpoint-push commit-and-push open-pr-if-needed; do
    blk=$(node_block "$id")
    assert_eq "$id loads the saved pubg core only after its sha256 check" "1" "$(count_in 'pf=$preflight-github-auth.output' "$blk")"
    assert_eq "$id never sources the saved pubg core file directly" "0" "$(printf '%s\n' "$blk" | grep -cE '^[[:space:]]*(\.|source) .*pubg\.core' || true)"
    assert_eq "$id sources exactly the verified copy" "1" "$(count_in '. "$copy"' "$blk")"
    if [ "$(count_in 'pubg_push ' "$blk")" -ge 1 ]; then ok "$id publishes through pubg_push"; else bad "$id publishes through pubg_push"; fi
  done
  blk=$(node_block checkout-repair-target)
  assert_eq "both rtw backup pushes go through pubg_push" "2" "$(printf '%s\n' "$blk" | grep -cE 'pubg_push "\$(commit|holder_sha)" "\$\{(ref|backup_ref)#refs/heads/\}"' || true)"
  blk=$(node_block checkpoint-push)
  assert_eq "a refused checkpoint push ends the run (abort_run_on_failure)" "1" "$(count_in 'abort_run_on_failure: true' "$blk")"
  blk=$(node_block commit-and-push)
  assert_eq "commit-and-push passes the repair lease to pubg_push" "1" "$(count_in 'pubg_push "$(git rev-parse HEAD)" "$UNIQUE_BRANCH" "${REPAIR_TARGET_LEASE_SHA:-}"' "$blk")"
  blk=$(node_block open-pr-if-needed)
  assert_eq "open-pr recovery re-push goes through pubg_push with the lease" "1" "$(count_in 'pubg_push "$LOCAL_HEAD" "$UNIQUE_BRANCH" "${REPAIR_TARGET_LEASE_SHA:-}"' "$blk")"
  assert_eq "open-pr adopt push goes through pubg_push with the lease" "1" "$(count_in 'pubg_push "$(git rev-parse HEAD)" "$RPR_BRANCH" "${REPAIR_TARGET_LEASE_SHA:-}"' "$blk")"
  assert_eq "no slice-2 placeholder is left" "0" "$(count_w 'TODO-SLICE2')"
  assert_eq "no pushed_sha fallback is left" "0" "$(count_w 'pushed_sha')"

  echo "--- Scan settings are never taken from the run (Test 13 a-d) ---"
  local pcore
  pcore=$(printf '%s\n' "$pre" | awk '/# ---- BEGIN pubg core/ { c = 1 } c { print } /# ---- END pubg core ----/ { c = 0 }')
  assert_eq "gitleaks runs with GITLEAKS_CONFIG and GITLEAKS_CONFIG_TOML unset" "1" "$(count_in 'env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML GIT_DIR="$gitdir"' "$pcore")"
  assert_eq "gitleaks always ignores gitleaks:allow markers" "1" "$(count_in '--ignore-gitleaks-allow' "$pcore")"
  assert_eq "gitleaks gets an explicit --config" "1" "$(count_in '--config "$gld/config.toml"' "$pcore")"
  assert_eq "gitleaks gets an explicit --gitleaks-ignore-path" "1" "$(count_in '--gitleaks-ignore-path "$gld/ignore"' "$pcore")"
  assert_eq "the config comes from the base tip B" "1" "$(count_in 'git show "${b}:.gitleaks.toml"' "$pcore")"
  assert_eq "the ignore list comes from the base tip B" "1" "$(count_in 'git show "${b}:.gitleaksignore"' "$pcore")"
  assert_eq "gitleaks never scans from the worktree (an empty source dir)" "0" "$(count_in 'git rev-parse --show-toplevel' "$pcore")"

  echo "--- Test 14: the implement prompt has no push; the gap is recorded ---"
  local impl_blk
  impl_blk=$(node_block implement)
  assert_eq "the implement prompt contains no git push" "0" "$(count_in 'git push' "$impl_blk")"
  assert_eq "the implement prompt contains no push -u" "0" "$(count_in 'push -u' "$impl_blk")"
  assert_eq "the implement prompt still forbids gh pr create" "1" "$(count_in 'Never run `gh pr create`' "$impl_blk")"
  if grep -q "The agent's write authority is not confined" "$REPO_ROOT/docs/operations/merge-holds.md"; then
    ok "docs/operations/merge-holds.md records the agent write-authority gap"
  else
    bad "docs/operations/merge-holds.md records the agent write-authority gap"
  fi
  if grep -q '`run:blocked` is machine-set and is the only hold this lane applies' "$REPO_ROOT/docs/operations/merge-holds.md"; then
    ok "docs/operations/merge-holds.md records the rebuilt lane's run:blocked rule"
  else
    bad "docs/operations/merge-holds.md records the rebuilt lane's run:blocked rule"
  fi

  echo "--- Rule 1b wiring: hold-if-findings settles after every node ---"
  hold=$(node_block hold-if-findings)
  assert_eq "hold-if-findings reads \$_run.output.failed_nodes once" "1" "$(count_in 'HIF_FAILED_NODES=$_run.output.failed_nodes' "$hold")"
  local missing
  missing=$(tr -d '\r' < "$W" | awk '
    /^  - id: / { id = substr($0, 9); ids[++n] = id; next }
    /^    depends_on: \[/ { line = $0; sub(/^    depends_on: \[/, "", line); sub(/\][[:space:]]*$/, "", line)
      k = split(line, d, /,[[:space:]]*/); for (i = 1; i <= k; i++) { if (id == "hold-if-findings") hif[d[i]] = 1; else used[d[i]] = 1 } }
    END { for (i = 1; i <= n; i++) if (ids[i] != "hold-if-findings" && !(ids[i] in used) && !(ids[i] in hif)) print ids[i] }')
  assert_eq "hold-if-findings depends on every sink node of the DAG" "" "$missing"

  echo "--- The completion-ledger write is unchanged (outside the publication inventory) ---"
  if git -C "$REPO_ROOT" cat-file -e 58251246^{commit} 2>/dev/null; then
    # The contents PUT of one JSON record to the bdc-xo ledger: from its comment to the node end.
    ledger_write() { awk '/# -- Write the pending file to bdc-xo via the contents API/ { c = 1 } c && /^  #/ { exit } c && NF { print }'; }
    local dev_rec now_rec
    dev_rec=$(git -C "$REPO_ROOT" show 58251246:.archon/workflows/defaults/bdc-feature-development.yaml | tr -d '\r' | awk '
      $0 == "  - id: record-wo-completion-candidate" { c = 1; print; next } c && /^  - id: / { exit } c { print }' | ledger_write)
    now_rec=$(node_block record-wo-completion-candidate | ledger_write)
    if [ -n "$dev_rec" ] && [ "$dev_rec" = "$now_rec" ]; then ok "record-wo-completion-candidate ledger write is byte-identical to dev 58251246"; else bad "record-wo-completion-candidate ledger write changed"; fi
  else
    bad "dev 58251246 not reachable; cannot prove record-wo-completion-candidate unchanged"
  fi

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
  for scenario in blocked hold-failures prod-guard markers repair scope returned wall-salvage empty-build round-limit closed-list overseer-repairs idle-published adopted-idle unheld-adoption unreadable-finding idle-spec idle-environment idle-provider pubg-core scan-config tamper publication refused-edit rule-1b unpublished; do
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
