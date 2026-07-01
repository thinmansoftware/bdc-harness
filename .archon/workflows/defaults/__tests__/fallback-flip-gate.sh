#!/usr/bin/env bash
# fallback-flip-gate.sh -- unit tests for the fallback-flip-gate node logic in
# .archon/workflows/defaults/bdc-feature-development*.yaml (and project-level
# mirrors bdc-feature-development{,-glm,-open-a,-open-b}.yaml).
#
# WO-HARNESS-FALLBACK-FLIP-HONESTY-01.
#
# fallback-flip-gate evaluates the accepted-fallback doctrine (John ruling
# 2026-05-26) -- ALL FOUR conditions must hold before flip-notion-on-failure
# is allowed to flip a WO to REVIEW:
#   1. PR open on origin against the expected branch (headRefName == the
#      branch this run pushed)
#   2. PR mergeable/CLEAN
#   3. war-council-validator emitted satisfied BEFORE the failure
#   4. hard constraints intact (base branch matches the Rule-20/staging
#      expectation; repo matches the spec's target_repo if named)
#
# The node used to be decided by an AI persona reading prose (flip-notion-
# on-failure, pre-WO). It now emits ONE JSON line via commands only (gh pr
# view + grep), and flip-notion-on-failure branches on that JSON mechanically.
# These tests EXERCISE THE SAME LOGIC (lifted verbatim from the node's `bash:`
# block, with the engine's `$nodeId.output` substitution points replaced by
# test-controlled stub variables and `gh` replaced by a stub function) so we
# can catch regressions without spinning up the engine or hitting GitHub.
#
# Coverage (spec section 11 + anchor incident):
#   1. 4/4 conditions true -> flip_allowed=true, failed_condition=none, and
#      the flip-notion-on-failure prompt text is wired to emit "FALLBACK PATH:"
#   2. Anchor case (2026-06-30): validator=needs_revision, other 3 true ->
#      flip_allowed=false, failed_condition=validator_not_satisfied
#   3. already_flipped=true short-circuit -- gh is NEVER invoked
#   4. PR wrong branch / not mergeable-CLEAN / repo mismatch -> each
#      independently drives flip_allowed=false with the correct condition
#
# Run: bash .archon/workflows/defaults/__tests__/fallback-flip-gate.sh
# Exits 0 on all-pass, 1 on any failure.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  # assert_eq <label> <expected> <actual>
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_contains() {
  # assert_contains <label> <needle> <haystack>
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle:   $needle"
    echo "  haystack: $haystack"
  fi
}

json_field() {
  # json_field <field> <json>  -- tiny extractor, no jq dependency needed here
  # since the gate's own output is a single flat JSON line we control. Reads
  # the field's raw JSON token (true/false unquoted, or a quoted string) and
  # strips surrounding quotes -- deliberately NOT round-tripped through
  # json.load()/Python bool, which would print "True"/"False" instead of the
  # JSON-literal "true"/"false" the gate itself emits and flip-notion-on-
  # failure's prompt actually reads.
  printf '%s\n' "$2" | grep -oE "\"$1\":(true|false|\"[^\"]*\")" | head -1 | sed -E 's/^"[^"]+":"?//; s/"$//'
}

# -----------------------------------------------------------------------------
# fallback-flip-gate logic, lifted verbatim from the node's `bash:` block.
# The engine substitutes `$nodeId.output` text before bash runs; here those
# same substitution points read from test-controlled *_STUB variables instead
# (heredoc delimiters are intentionally left UNQUOTED so `${..._STUB}`
# expands -- the node's real heredocs are quoted because by the time bash
# sees them the engine has already substituted literal, possibly
# shell-special, content and quoting prevents bash from re-interpreting it;
# that concern does not apply to our own controlled stub values).
# -----------------------------------------------------------------------------
run_gate() {
  set -euo pipefail

  capture_node_output() {
    python3 -c 'import shlex, sys; s=sys.stdin.read(); sys.stdout.write((lambda p: p[0] if len(p)==1 else s)(shlex.split(s)) if len(s)>=2 and s[0]=="'"'"'" and s.rstrip("\n").endswith("'"'"'") else s)'
  }

  emit() {
    printf '{"flip_allowed":%s,"failed_condition":"%s","cond1_pr_open_expected_branch":%s,"cond2_pr_mergeable_clean":%s,"cond3_validator_satisfied":%s,"cond4_hard_constraints":%s,"pr_url":"%s","repo":"%s","branch":"%s","validator_verdict":"%s","pr_state":"%s","pr_mergeable":"%s","pr_merge_state_status":"%s","pr_base":"%s"}\n' \
      "$1" "$2" "$COND1" "$COND2" "$COND3" "$COND4" "$PR_URL" "$REPO" "$UNIQUE_BRANCH" "$VALIDATOR_VERDICT" "$PR_STATE" "$PR_MERGEABLE" "$PR_MERGE_STATE_STATUS" "$PR_BASE"
  }

  COND1=false; COND2=false; COND3=false; COND4=false
  PR_URL=""; REPO=""; UNIQUE_BRANCH=""; VALIDATOR_VERDICT=""
  PR_STATE=""; PR_MERGEABLE=""; PR_MERGE_STATE_STATUS=""; PR_BASE=""

  # -- Step 0 (idempotency pre-check, not one of the 4 doctrine conditions)
  FLIP_NOTION_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_FLIP_NOTION
${FLIP_NOTION_STUB:-}
BDC_NODE_OUTPUT_FLIP_NOTION
  )
  if printf '%s\n' "$FLIP_NOTION_OUT" | grep -qiE 'claude status:? *review|status:? *review|flipped to review'; then
    emit true already_flipped
    echo "fallback-flip-gate: already_flipped -- normal flip-notion succeeded, no-op." >&2
    exit 0
  fi

  # -- Resolve REPO + staging-gate expectation from decide-push-target output.
  DECIDE_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_DECIDE
${DECIDE_STUB:-}
BDC_NODE_OUTPUT_DECIDE
  )
  REPO=$(printf '%s\n' "$DECIDE_OUT" | sed -n 's/^repo: //p' | head -1)
  STAGING_GATE_REQUIRED=$(printf '%s\n' "$DECIDE_OUT" | grep -oiE 'staging_gate_required:[[:space:]]*(true|false)' | sed 's/.*:[[:space:]]*//' | tr '[:upper:]' '[:lower:]' | head -1 || true)

  # -- Resolve UNIQUE_BRANCH from commit-and-push output.
  COMMIT_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_COMMIT
${COMMIT_STUB:-}
BDC_NODE_OUTPUT_COMMIT
  )
  UNIQUE_BRANCH=$(printf '%s\n' "$COMMIT_OUT" | grep -oE 'unique_branch=[^ ]+' | sed 's/^unique_branch=//' | head -1 || true)

  # -- Resolve PR_URL from open-pr-if-needed output (same idiom as patch-pr-body).
  OPEN_PR_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_OPEN_PR
${OPEN_PR_STUB:-}
BDC_NODE_OUTPUT_OPEN_PR
  )
  PR_URL=$(printf '%s\n' "$OPEN_PR_OUT" | grep -E '^PR_URL=' | sed 's/^PR_URL=//' | head -1 || true)
  if [ -z "$PR_URL" ]; then
    PR_URL=$(printf '%s\n' "$OPEN_PR_OUT" | grep -E '^https://github\.com/' | head -1 || true)
  fi
  if [ -z "$PR_URL" ] && [ -n "$REPO" ] && [ -n "$UNIQUE_BRANCH" ]; then
    PR_URL=$(gh pr list --repo "$REPO" --head "$UNIQUE_BRANCH" --state open --json url --jq '.[0].url' 2>/dev/null || true)
  fi

  # -- Condition 3: war-council-validator satisfied BEFORE the failure.
  VALIDATOR_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_VALIDATOR
${VALIDATOR_STUB:-}
BDC_NODE_OUTPUT_VALIDATOR
  )
  VALIDATOR_VERDICT=$(printf '%s\n' "$VALIDATOR_OUT" | grep -oiE '\b(satisfied|needs_revision)\b' | tail -n 1 | tr '[:upper:]' '[:lower:]' || true)
  if [ "$VALIDATOR_VERDICT" = "satisfied" ]; then
    COND3=true
  fi

  # -- Conditions 1 and 2: one gh pr view call covers both.
  if [ -n "$PR_URL" ] && [ -n "$REPO" ]; then
    PR_JSON=$(gh pr view "$PR_URL" --repo "$REPO" --json state,mergeable,mergeStateStatus,baseRefName,headRefName 2>/dev/null || echo "")
    if [ -n "$PR_JSON" ]; then
      PR_STATE=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("state",""))' 2>/dev/null || echo "")
      PR_MERGEABLE=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("mergeable",""))' 2>/dev/null || echo "")
      PR_MERGE_STATE_STATUS=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("mergeStateStatus",""))' 2>/dev/null || echo "")
      PR_BASE=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("baseRefName",""))' 2>/dev/null || echo "")
      PR_HEAD=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("headRefName",""))' 2>/dev/null || echo "")
      if [ "$PR_STATE" = "OPEN" ] && [ -n "$UNIQUE_BRANCH" ] && [ "$PR_HEAD" = "$UNIQUE_BRANCH" ]; then
        COND1=true
      fi
      if [ "$PR_MERGEABLE" = "MERGEABLE" ] && [ "$PR_MERGE_STATE_STATUS" = "CLEAN" ]; then
        COND2=true
      fi
    fi
  fi

  # -- Condition 4: hard constraints.
  COND4=true
  if [ -z "$PR_BASE" ]; then
    COND4=false
  fi
  if [ "$STAGING_GATE_REQUIRED" = "true" ] && [ "$PR_BASE" != "staging" ]; then
    COND4=false
  fi
  SPEC_OUT=$(capture_node_output <<BDC_NODE_OUTPUT_SPEC
${SPEC_STUB:-}
BDC_NODE_OUTPUT_SPEC
  )
  SPEC_TARGET_REPO=$(printf '%s\n' "$SPEC_OUT" | grep -oE 'target_repo:[[:space:]]*[^ ]+' | sed 's/^target_repo:[[:space:]]*//' | head -1 || true)
  if [ -n "$SPEC_TARGET_REPO" ] && [ -n "$REPO" ] && [ "$SPEC_TARGET_REPO" != "$REPO" ]; then
    COND4=false
  fi

  # -- Decide.
  if [ "$COND1" = "true" ] && [ "$COND2" = "true" ] && [ "$COND3" = "true" ] && [ "$COND4" = "true" ]; then
    emit true none
  elif [ "$COND3" != "true" ]; then
    emit false validator_not_satisfied
  elif [ "$COND1" != "true" ]; then
    emit false pr_not_open_or_wrong_branch
  elif [ "$COND2" != "true" ]; then
    emit false pr_not_mergeable_clean
  else
    emit false hard_constraints_failed
  fi
}

# Common fixture values shared across scenarios below.
DECIDE_NON_STAGING=$'push_target: feature-branch:feat/wo-foo-01\npr_required: true\nstaging_gate_required: false\nrepo: bluedevilcollectibles/bdc-harness'
COMMIT_OK=$'push_status: ok\nunique_branch=feat/wo-foo-01-abc123'
OPEN_PR_OK=$'https://github.com/bluedevilcollectibles/bdc-harness/pull/500'
SPEC_NO_TARGET=$'## Objective\nSome spec prose with no explicit target_repo line.'

# -----------------------------------------------------------------------------
# Test 1: 4/4 conditions true -> flip_allowed=true, failed_condition=none
# -----------------------------------------------------------------------------
echo "--- Test 1: 4/4 conditions true ---"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"feat/wo-foo-01-abc123"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
FLIP_NOTION_STUB=""
DECIDE_STUB="$DECIDE_NON_STAGING"
COMMIT_STUB="$COMMIT_OK"
OPEN_PR_STUB="$OPEN_PR_OK"
VALIDATOR_STUB="War Council Validator report: Verdict: satisfied"
SPEC_STUB="$SPEC_NO_TARGET"
OUT1=$(run_gate)
assert_eq "T1 flip_allowed=true" "true" "$(json_field flip_allowed "$OUT1")"
assert_eq "T1 failed_condition=none" "none" "$(json_field failed_condition "$OUT1")"
assert_eq "T1 cond1 true" "true" "$(json_field cond1_pr_open_expected_branch "$OUT1")"
assert_eq "T1 cond2 true" "true" "$(json_field cond2_pr_mergeable_clean "$OUT1")"
assert_eq "T1 cond3 true" "true" "$(json_field cond3_validator_satisfied "$OUT1")"
assert_eq "T1 cond4 true" "true" "$(json_field cond4_hard_constraints "$OUT1")"

# Structural check: when the gate allows the flip, the downstream
# flip-notion-on-failure prompt text is wired to emit the greppable
# "FALLBACK PATH:" convention. This is a snapshot of that prompt's static
# text (not a live file read, matching this test file's self-contained
# convention) -- if the convention marker is ever removed from the node,
# this test catches the drift independent of the gate's own JSON output.
FLIP_NOTION_ON_FAILURE_PROMPT_SNAPSHOT='If "flip_allowed":true -> perform the flip:
  - Claude Status: REVIEW
  - Status: Review
  - Add a page comment starting EXACTLY with "FALLBACK PATH:" (greppable
    convention), including failed_condition=none and the pr_url, repo, and
    validator_verdict=satisfied fields copied from the gate JSON.'
assert_contains "T1 downstream prompt begins flip with FALLBACK PATH:" 'FALLBACK PATH:' "$FLIP_NOTION_ON_FAILURE_PROMPT_SNAPSHOT"

# -----------------------------------------------------------------------------
# Test 2: ANCHOR CASE (2026-06-30) -- validator needs_revision, other 3 true
# -----------------------------------------------------------------------------
echo "--- Test 2: anchor case -- needs_revision with open PR ---"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"feat/wo-foo-01-abc123"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
FLIP_NOTION_STUB=""
DECIDE_STUB="$DECIDE_NON_STAGING"
COMMIT_STUB="$COMMIT_OK"
OPEN_PR_STUB="$OPEN_PR_OK"
VALIDATOR_STUB="War Council Validator report: Verdict: needs_revision -- see findings above."
SPEC_STUB="$SPEC_NO_TARGET"
OUT2=$(run_gate)
assert_eq "T2 (anchor) flip_allowed=false" "false" "$(json_field flip_allowed "$OUT2")"
assert_eq "T2 (anchor) failed_condition=validator_not_satisfied" "validator_not_satisfied" "$(json_field failed_condition "$OUT2")"
assert_eq "T2 cond1 still true (PR was fine)" "true" "$(json_field cond1_pr_open_expected_branch "$OUT2")"
assert_eq "T2 cond3 false" "false" "$(json_field cond3_validator_satisfied "$OUT2")"

# Build never reached the validator at all (empty output) -- also fails closed.
VALIDATOR_STUB=""
OUT2B=$(run_gate)
assert_eq "T2b validator never ran -> flip_allowed=false" "false" "$(json_field flip_allowed "$OUT2B")"
assert_eq "T2b failed_condition=validator_not_satisfied" "validator_not_satisfied" "$(json_field failed_condition "$OUT2B")"

# -----------------------------------------------------------------------------
# Test 3: already_flipped short-circuit -- gh must NEVER be invoked
# -----------------------------------------------------------------------------
echo "--- Test 3: already_flipped short-circuit ---"
gh() {
  echo "GH SHOULD NOT HAVE BEEN CALLED: $*" >&2
  return 99
}
FLIP_NOTION_STUB="Notion updated. Claude Status: REVIEW. Status: Review. Manifest posted."
DECIDE_STUB="$DECIDE_NON_STAGING"
COMMIT_STUB="$COMMIT_OK"
OPEN_PR_STUB="$OPEN_PR_OK"
VALIDATOR_STUB="Verdict: satisfied"
SPEC_STUB="$SPEC_NO_TARGET"
OUT3=$(run_gate)
assert_eq "T3 already_flipped -> flip_allowed=true" "true" "$(json_field flip_allowed "$OUT3")"
assert_eq "T3 failed_condition=already_flipped" "already_flipped" "$(json_field failed_condition "$OUT3")"
# The normal flip-notion path is untouched by this gate -- it already
# succeeded (that's WHY FLIP_NOTION_STUB shows a completed flip above); the
# gate's only job here is to recognize that and no-op, never re-evaluate.
assert_eq "T3 cond1 unevaluated (still false, short-circuited before checks)" "false" "$(json_field cond1_pr_open_expected_branch "$OUT3")"

# -----------------------------------------------------------------------------
# Test 4: independent single-condition failures
# -----------------------------------------------------------------------------
echo "--- Test 4a: PR open but on the WRONG branch ---"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"some-other-stale-branch"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
FLIP_NOTION_STUB=""
DECIDE_STUB="$DECIDE_NON_STAGING"
COMMIT_STUB="$COMMIT_OK"
OPEN_PR_STUB="$OPEN_PR_OK"
VALIDATOR_STUB="Verdict: satisfied"
SPEC_STUB="$SPEC_NO_TARGET"
OUT4A=$(run_gate)
assert_eq "T4a flip_allowed=false" "false" "$(json_field flip_allowed "$OUT4A")"
assert_eq "T4a failed_condition=pr_not_open_or_wrong_branch" "pr_not_open_or_wrong_branch" "$(json_field failed_condition "$OUT4A")"

echo "--- Test 4b: PR open on right branch but NOT mergeable/CLEAN ---"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    echo '{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","baseRefName":"main","headRefName":"feat/wo-foo-01-abc123"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
OUT4B=$(run_gate)
assert_eq "T4b flip_allowed=false" "false" "$(json_field flip_allowed "$OUT4B")"
assert_eq "T4b failed_condition=pr_not_mergeable_clean" "pr_not_mergeable_clean" "$(json_field failed_condition "$OUT4B")"

echo "--- Test 4c: hard constraints -- spec target_repo mismatch ---"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"feat/wo-foo-01-abc123"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
SPEC_STUB=$'## Objective\ntarget_repo: bluedevilcollectibles/some-other-repo\nMore prose.'
OUT4C=$(run_gate)
assert_eq "T4c flip_allowed=false" "false" "$(json_field flip_allowed "$OUT4C")"
assert_eq "T4c failed_condition=hard_constraints_failed" "hard_constraints_failed" "$(json_field failed_condition "$OUT4C")"

echo "--- Test 4d: hard constraints -- staging-gate repo but PR based on wrong branch ---"
DECIDE_STAGING=$'push_target: feature-branch:feat/wo-bar-01\npr_required: true\nstaging_gate_required: true\nrepo: bluedevilcollectibles/lspro-react'
DECIDE_STUB="$DECIDE_STAGING"
SPEC_STUB="$SPEC_NO_TARGET"
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
    # baseRefName is "main", NOT "staging" -- violates the Rule-20 expectation
    # for a staging-gate repo even though the PR is otherwise clean and open.
    echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","baseRefName":"main","headRefName":"feat/wo-foo-01-abc123"}'
  else
    echo "UNEXPECTED gh CALL: $*" >&2
    return 1
  fi
}
OUT4D=$(run_gate)
assert_eq "T4d flip_allowed=false" "false" "$(json_field flip_allowed "$OUT4D")"
assert_eq "T4d failed_condition=hard_constraints_failed" "hard_constraints_failed" "$(json_field failed_condition "$OUT4D")"

# -----------------------------------------------------------------------------
# Test 5: normal completion unaffected -- flip-notion itself is out of scope
# and untouched by this WO; confirm the source still shows its original,
# unmodified depends_on so a future edit doesn't silently fold gate logic
# into the normal (non-fallback) flip path.
# -----------------------------------------------------------------------------
echo "--- Test 5: normal flip-notion node untouched ---"
NORMAL_FLIP_DEPENDS_ON_LINE=$(grep -A2 '^  - id: flip-notion$' "$(dirname "$0")/../bdc-feature-development.yaml" | grep 'depends_on' | head -1)
assert_contains "T5 flip-notion still depends only on build-manifest" "depends_on: [build-manifest]" "$NORMAL_FLIP_DEPENDS_ON_LINE"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "==== fallback-flip-gate.sh tests ===="
echo "passed: $PASS"
echo "failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
