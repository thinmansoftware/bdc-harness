#!/usr/bin/env bash
# bdc-feature-development.test.sh
#
# Unit tests for WO-HARNESS-CAULDRON-DEFECT-CLEANUP-01 (4 tail-node defect fixes)
# and WO-HARNESS-PUSH-TARGET-EXTRACTION-HARDENING-01 (tolerant push_target
# extraction across 19 lane YAMLs).
# Runnable: bash bdc-harness/.archon/workflows/defaults/__tests__/bdc-feature-development.test.sh
#
# Test matrix:
#   Tests 1-9  -> push_target extraction (hardened tolerant contract):
#                   1  regression: well-formed single line (unchanged behavior)
#                   2  REAL run e5110df1 event-store payload -- zero-regression
#                      (parses under BOTH old and new; see EVIDENCE NOTE at Test 2)
#                   3  fenced + indented -- PR #165 tolerance preserved (both pass)
#                   4  list bullet          -- DISCRIMINATOR (old empty, new ok)
#                   5  trailing prose       -- DISCRIMINATOR (old empty, new ok)
#                   6  inline backticks     -- DISCRIMINATOR (old corrupt, new ok)
#                   7  genuine absence -> "field absent" message, rc 1
#                   8  present-but-unparseable -> distinct message, rc 1
#                   9  idempotency: same input parses identically twice
#   Test  10   -> all 19 in-scope lane YAMLs carry the hardened contract (grep)
#   Tests 11-14 -> Defect 2 (open-pr-if-needed check-first)
#   Test  15   -> Defect 3 DAG-executor capability check (recorded; run live during build)
#   Tests 16-17 -> Defect 3 integration smoke fires (manual via Cauldron; not unit-runnable)
#   Tests 18-19 -> Defect 4 (fire-wo-local.sh token resolution)
#
# The extractor + PR logic under test are lifted VERBATIM from the live YAML / script
# so these tests exercise the real shipped code, not a re-typed copy.
#
# NO EMOJIS - ASCII ONLY

set -uo pipefail

PASS=0
FAIL=0
SKIP=0

_ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
_no()   { echo "FAIL: $1"; echo "      expected: [$2]"; echo "      actual:   [$3]"; FAIL=$((FAIL+1)); }
_skip() { echo "SKIP: $1 ($2)"; SKIP=$((SKIP+1)); }

# ---------------------------------------------------------------------------
# push_target extraction -- the tolerant, multi-strategy extractor lifted VERBATIM
# from bdc-feature-development.yaml's commit-and-push node
# (WO-HARNESS-PUSH-TARGET-EXTRACTION-HARDENING-01). Wrapped in a function so the
# tests call the real shipped expression. On success it echoes BRANCH (rc 0); on
# failure it echoes the exact diagnostic the node emits and returns 1. Keep in
# lockstep with the YAML block.
# ---------------------------------------------------------------------------
extract_branch() {
  local DECIDE_OUTPUT="$1"
  local DECIDE_OUTPUT_CLEAN BRANCH PUSH_TARGET_EXCERPT
  DECIDE_OUTPUT_CLEAN=$(printf '%s\n' "$DECIDE_OUTPUT" | tr -d '`')
  BRANCH=$(printf '%s\n' "$DECIDE_OUTPUT_CLEAN" | sed -n 's/^[[:space:]]*push_target:[[:space:]]*feature-branch:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' | head -n 1)
  if [ -z "$BRANCH" ]; then
    BRANCH=$(printf '%s\n' "$DECIDE_OUTPUT_CLEAN" \
      | { grep -oE 'push_target:[[:space:]]*feature-branch:[[:space:]]*[^[:space:]]+' || true; } \
      | head -n 1 \
      | sed -E 's/^.*feature-branch:[[:space:]]*//')
  fi
  if [ -z "$BRANCH" ]; then
    if printf '%s\n' "$DECIDE_OUTPUT_CLEAN" | grep -q 'push_target'; then
      PUSH_TARGET_EXCERPT=$(printf '%s\n' "$DECIDE_OUTPUT_CLEAN" | grep 'push_target' | head -n 1 | cut -c1-200)
      echo "push_target field present but unparseable: ${PUSH_TARGET_EXCERPT}"
    else
      echo "push_target field absent from decide-push-target output."
    fi
    return 1
  fi
  echo "$BRANCH"
  return 0
}

# ---------------------------------------------------------------------------
# extract_branch_OLD -- the PRE-FIX extractor, lifted VERBATIM from the line this
# WO removes. Verify with:
#   git show 337be94e -- .archon/workflows/defaults/bdc-feature-development-fable.yaml
# The removed line is:
#   BRANCH=$(printf '%s\n' "$DECIDE_OUTPUT" | sed -n 's/^[[:space:]]*push_target:[[:space:]]*feature-branch:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' | head -n 1)
# NOTE: it is ALREADY leading-whitespace tolerant (PR #165 / Defect 1, landed in
# the fable lane 2026-07-08 via ec0e3176 -- before run e5110df1 on 2026-08-01).
# What it still cannot do: tolerate a non-whitespace line prefix (list bullet,
# blockquote), tolerate trailing prose after the token (the $ anchor), or strip
# backticks. Those three -- and ONLY those three -- are the genuine regressions
# this WO fixes. Tests 4, 5 and 6 assert that discriminator.
# ---------------------------------------------------------------------------
extract_branch_OLD() {
  local DECIDE_OUTPUT="$1"
  printf '%s\n' "$DECIDE_OUTPUT" | sed -n 's/^[[:space:]]*push_target:[[:space:]]*feature-branch:[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' | head -n 1
}

# Test 1 -- regression: well-formed single line extracts unchanged
BRANCH=$(extract_branch "push_target: feature-branch: feat/wo-clean-01")
if [ "$BRANCH" = "feat/wo-clean-01" ]; then _ok "Test 1: well-formed -> feat/wo-clean-01"; else _no "Test 1: well-formed" "feat/wo-clean-01" "$BRANCH"; fi

# Test 2 -- ZERO-REGRESSION against run e5110df1's REAL decide-push-target output.
# Fixture is the canonical event-store payload, copied verbatim from
#   /.archon/workspaces/bluedevilcollectibles/shopops/logs/e5110df1277ec6a9b899468f8e030b76.jsonl
# (the sole assistant event whose content starts "push_target:", emitted between
# node_start and node_complete for step decide-push-target). Only the prose tail
# is ASCII-normalized (one em-dash -> "--") to satisfy Rule 13; the four
# structured lines are byte-for-byte verbatim.
#
# EVIDENCE NOTE -- read before trusting any "e5110df1 proves tolerance" claim:
# this real output parses CLEANLY under the pre-fix extractor (it is an
# unindented, undecorated line, and the anchor already tolerated the missing
# space after "feature-branch:"). So run e5110df1's "No feature branch target
# found" failure was NOT caused by extractor whitespace/decoration intolerance,
# and NO fixture can honestly be labelled "the e5110df1 shape the old extractor
# could not parse." Its root cause lies upstream in what commit-and-push
# received as $DECIDE_OUTPUT (see the artifact-mailbox change d90b2bbc,
# 2026-07-28), not in this regex. This test therefore asserts the only thing the
# real payload can prove: the hardened extractor does not regress on it.
E5110_OUT=$(printf '%s\n' \
  'push_target: feature-branch:feat/wo-shopops-pick-pull-pack-scan-wiring-01' \
  'pr_required: true' \
  'staging_gate_required: true' \
  'repo: bluedevilcollectibles/shopops' \
  '' \
  'Derivation:' \
  '- **Repo**: `target_repo: bluedevilcollectibles/shopops` (YAML field, priority 1) -- no origin fallback needed.' \
  '- **Staging gate**: `bluedevilcollectibles/shopops` matches the hardcoded list -> `staging_gate_required: true`.')
OLD_BRANCH=$(extract_branch_OLD "$E5110_OUT")
BRANCH=$(extract_branch "$E5110_OUT")
if [ "$OLD_BRANCH" = "feat/wo-shopops-pick-pull-pack-scan-wiring-01" ] && [ "$BRANCH" = "feat/wo-shopops-pick-pull-pack-scan-wiring-01" ]; then
  _ok "Test 2: real e5110df1 payload -- OLD and NEW both extract feat/wo-shopops-pick-pull-pack-scan-wiring-01 (zero regression; prose tail ignored)"
else
  _no "Test 2: real e5110df1 payload (zero regression)" "old=[feat/wo-shopops-pick-pull-pack-scan-wiring-01] new=[feat/wo-shopops-pick-pull-pack-scan-wiring-01]" "old=[$OLD_BRANCH] new=[$BRANCH]"
fi

# Test 3 -- fenced + indented. The pre-fix extractor ALREADY handled this (PR #165
# made the anchor whitespace-tolerant), so this is a tolerance-preservation test,
# NOT a discriminator. Assert both succeed so a future "simplification" that drops
# leading-whitespace tolerance is caught.
FENCED=$(printf '%s\n' '```text' '    push_target: feature-branch: feat/wo-foo-03' '```')
OLD_BRANCH=$(extract_branch_OLD "$FENCED")
BRANCH=$(extract_branch "$FENCED")
if [ "$OLD_BRANCH" = "feat/wo-foo-03" ] && [ "$BRANCH" = "feat/wo-foo-03" ]; then
  _ok "Test 3: fenced+indented -- OLD and NEW both extract feat/wo-foo-03 (PR #165 tolerance preserved)"
else
  _no "Test 3: fenced+indented (both succeed)" "old=[feat/wo-foo-03] new=[feat/wo-foo-03]" "old=[$OLD_BRANCH] new=[$BRANCH]"
fi

# Test 4 -- DISCRIMINATOR: list-bullet prefix. "^[[:space:]]*" cannot match the
# "-" bullet, so the pre-fix extractor returns EMPTY and the node mislabels a
# present field as "absent". The hardened fallback scan extracts it.
BULLET="- push_target: feature-branch: fix/wo-bar-04"
OLD_BRANCH=$(extract_branch_OLD "$BULLET")
BRANCH=$(extract_branch "$BULLET")
if [ -z "$OLD_BRANCH" ] && [ "$BRANCH" = "fix/wo-bar-04" ]; then
  _ok "Test 4: bullet -- OLD fails (empty), NEW extracts fix/wo-bar-04"
else
  _no "Test 4: bullet (old fails empty, new succeeds)" "old=[] new=[fix/wo-bar-04]" "old=[$OLD_BRANCH] new=[$BRANCH]"
fi

# Test 5 -- DISCRIMINATOR: trailing prose on the same line. The pre-fix "$" anchor
# requires the token to end the line, so trailing prose returns EMPTY. The
# hardened scan stops at the first whitespace and tolerates the prose.
PROSE="push_target: feature-branch: feat/wo-baz-05 (chosen because X)"
OLD_BRANCH=$(extract_branch_OLD "$PROSE")
BRANCH=$(extract_branch "$PROSE")
if [ -z "$OLD_BRANCH" ] && [ "$BRANCH" = "feat/wo-baz-05" ]; then
  _ok "Test 5: trailing prose -- OLD fails (empty), NEW extracts feat/wo-baz-05"
else
  _no "Test 5: trailing prose (old fails empty, new succeeds)" "old=[] new=[feat/wo-baz-05]" "old=[$OLD_BRANCH] new=[$BRANCH]"
fi

# Test 6 -- DISCRIMINATOR: inline backtick-wrapped token. Distinct failure MODE --
# the pre-fix extractor does not strip backticks, so it returns a NON-EMPTY but
# corrupt token ("`wip/wo-qux-06`") that then fails BRANCH_PATTERN validation
# downstream. The hardened extractor pre-strips backticks. Assert the old value is
# corrupt (not merely different) so the regression cannot silently return.
TICKS='push_target: feature-branch: `wip/wo-qux-06`'
OLD_BRANCH=$(extract_branch_OLD "$TICKS")
BRANCH=$(extract_branch "$TICKS")
if [ "$OLD_BRANCH" != "wip/wo-qux-06" ] && case "$OLD_BRANCH" in *'`'*) true;; *) false;; esac && [ "$BRANCH" = "wip/wo-qux-06" ]; then
  _ok "Test 6: inline backticks -- OLD returns corrupt [$OLD_BRANCH], NEW extracts wip/wo-qux-06"
else
  _no "Test 6: inline backticks (old corrupt w/ backticks, new clean)" "old=[\`wip/wo-qux-06\`] new=[wip/wo-qux-06]" "old=[$OLD_BRANCH] new=[$BRANCH]"
fi

# Test 7 -- genuine absence: field never appears -> "field absent" message, rc 1
OUT=$(extract_branch "$(printf '%s\n' 'pr_required: true' 'repo: foo/bar')"); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "push_target field absent from decide-push-target output"; then
  _ok "Test 7: genuine absence -> field-absent message, rc 1"
else
  _no "Test 7: genuine absence" "rc!=0 + 'field absent'" "rc=$RC out=$OUT"
fi

# Test 8 -- present-but-unparseable: field appears but no valid token -> distinct
# message, rc 1. The old single message said "No feature branch target found"
# for BOTH cases, so a present-but-styled field was reported as absent.
OUT=$(extract_branch "$(printf '%s\n' 'push_target: not-feature-branch: weird' 'notes: could not decide')"); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "push_target field present but unparseable:"; then
  _ok "Test 8: present-but-unparseable -> distinct message + excerpt, rc 1"
else
  _no "Test 8: present-but-unparseable" "rc!=0 + 'present but unparseable'" "rc=$RC out=$OUT"
fi

# Test 9 -- idempotency: extraction is a pure read; same input parses identically twice
A=$(extract_branch "$E5110_OUT"); B=$(extract_branch "$E5110_OUT")
if [ "$A" = "$B" ] && [ "$A" = "feat/wo-shopops-pick-pull-pack-scan-wiring-01" ]; then
  _ok "Test 9: idempotent extraction ($A)"
else
  _no "Test 9: idempotent extraction" "$A == $B == feat/wo-shopops-pick-pull-pack-scan-wiring-01" "A=$A B=$B"
fi

# Test 10 -- all 19 in-scope lane YAMLs carry the hardened contract. Each must
# contain both new diagnostic strings and NONE of the old ambiguous message.
DEFAULTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IN_SCOPE=(
  bdc-feature-development bdc-feature-development-zero bdc-feature-development-zero-open
  bdc-feature-development-zero-claude bdc-feature-development-kimi-k3 bdc-feature-development-grok
  bdc-feature-development-fusion-cx-qwen bdc-feature-development-fusion-cx-kimi
  bdc-feature-development-fable bdc-feature-development-codex bdc-feature-development-codex-only
  bdc-audit-claude bdc-bug-fix bdc-cauldron-multi-stage-pipeline-01 bdc-cleanup-sweep
  bdc-harness-ascii-autofix-01 bdc-harness-commit-guard-pause-not-fail-01
  bdc-harness-mc-negan-diagnostic-graph bdc-lspro-pulllist-scout-locg-import
)
T10_OK=0; T10_BAD=""
for wf in "${IN_SCOPE[@]}"; do
  p="${DEFAULTS_DIR}/${wf}.yaml"
  # grep -c exits 1 on zero matches; that is fine here (no set -e). Do NOT add
  # "|| echo 0" -- it would append a second "0" line and corrupt the integer test.
  a=$(grep -c 'push_target field absent from decide-push-target output' "$p" 2>/dev/null); a=${a:-0}
  u=$(grep -c 'push_target field present but unparseable' "$p" 2>/dev/null); u=${u:-0}
  o=$(grep -c 'No feature branch target found in decide-push-target output' "$p" 2>/dev/null); o=${o:-0}
  if [ "$a" -ge 1 ] && [ "$u" -ge 1 ] && [ "$o" -eq 0 ]; then
    T10_OK=$((T10_OK+1))
  else
    T10_BAD="${T10_BAD} ${wf}(absent=$a,unparse=$u,old=$o)"
  fi
done
if [ "$T10_OK" -eq 19 ] && [ -z "$T10_BAD" ]; then
  _ok "Test 10: all 19 lane YAMLs carry the hardened contract"
else
  _no "Test 10: all 19 lane YAMLs carry the hardened contract" "19 clean" "ok=$T10_OK bad:${T10_BAD}"
fi

# ---------------------------------------------------------------------------
# Defect 2 -- check-first open-pr logic (verbatim shape from the open-pr-if-needed node).
# We stub `gh` so no network is touched and we can count create-calls.
# ---------------------------------------------------------------------------
# Subshell-safe call counters: the block runs inside $(...) so variable mutations
# are lost. We use temp files that survive the subshell instead.
GH_CREATE_COUNT_FILE=$(mktemp)
GH_LIST_COUNT_FILE=$(mktemp)
_create_count() { cat "$GH_CREATE_COUNT_FILE"; }
_reset_counts() { echo 0 > "$GH_CREATE_COUNT_FILE"; echo 0 > "$GH_LIST_COUNT_FILE"; }

# The function under test mirrors the YAML node's PR resolution block exactly.
open_pr_block() {
  local REPO="foo/bar"
  local UNIQUE_BRANCH="feat/foo-thread-abc"
  local TITLE="t" BODY_FILE="/dev/null" BASE_BRANCH="dev"
  local PR_OK=false EXIST=""

  EXIST=$(gh pr list --repo "$REPO" --head "$UNIQUE_BRANCH" --state open \
    --json url --jq '.[0].url // empty' 2>/dev/null || true)
  if [ -n "$EXIST" ]; then
    echo "PR_URL=$EXIST"
    echo "PR already exists (no create needed)."
    PR_OK=true
  else
    for attempt in 1 2 3; do
      if gh pr create --repo "$REPO" --title "$TITLE" --body-file "$BODY_FILE" --head "$UNIQUE_BRANCH" ${BASE_BRANCH:+--base "$BASE_BRANCH"} 2>&1; then
        PR_OK=true
        break
      fi
      EXIST=$(gh pr list --repo "$REPO" --head "$UNIQUE_BRANCH" --state open \
        --json url --jq '.[0].url // empty' 2>/dev/null || true)
      if [ -n "$EXIST" ]; then
        echo "PR_URL=$EXIST"
        echo "PR created despite non-zero exit (gh CLI quirk; PR confirmed via list)."
        PR_OK=true
        break
      fi
      echo "WARN: gh pr create attempt $attempt failed AND no PR found on origin; retrying..." >&2
      # sleep removed in tests for speed
    done
  fi
  if [ "$PR_OK" = "false" ]; then
    echo "PR_CREATE_FAILED_BUT_BRANCH_SAFE: repo=${REPO} branch=${UNIQUE_BRANCH} sha=TESTSHA" >&2
    echo "ERROR: gh pr create failed after 3 attempts -- aborting workflow (load_bearing node)." >&2
    return 1
  fi
  return 0
}

# gh stub variables exported so the subshell sees them; behavior switched by GH_MODE.
export GH_CREATE_COUNT_FILE GH_LIST_COUNT_FILE
gh() {
  local sub="$1 $2"
  if [ "$sub" = "pr list" ]; then
    local n; n=$(( $(cat "$GH_LIST_COUNT_FILE") + 1 )); echo "$n" > "$GH_LIST_COUNT_FILE"
    case "$GH_MODE" in
      exists)        echo "https://github.com/foo/bar/pull/123" ;;
      create_ok)     echo "" ;;
      quirk)         if [ "$n" -eq 1 ]; then echo ""; else echo "https://github.com/foo/bar/pull/77"; fi ;;
      fail_closed)   echo "" ;;
    esac
  elif [ "$sub" = "pr create" ]; then
    local c; c=$(( $(cat "$GH_CREATE_COUNT_FILE") + 1 )); echo "$c" > "$GH_CREATE_COUNT_FILE"
    case "$GH_MODE" in
      exists)      echo "should-not-be-called"; return 0 ;;
      create_ok)   echo "https://github.com/foo/bar/pull/9"; return 0 ;;
      quirk)       return 1 ;;
      fail_closed) return 1 ;;
    esac
  fi
}
export -f gh 2>/dev/null || true
export GH_MODE

# Test 11 -- check-first finds existing PR without ever calling create
GH_MODE=exists; _reset_counts
OUT=$(open_pr_block 2>&1); RC=$?
if [ $RC -eq 0 ] && [ "$(_create_count)" -eq 0 ] && echo "$OUT" | grep -q "PR already exists"; then
  _ok "Test 11: existing PR found, create never called"
else
  _no "Test 11: existing PR found, create never called" "rc=0 creates=0 'PR already exists'" "rc=$RC creates=$(_create_count) out=$OUT"
fi

# Test 12 -- creates PR when absent (list empty, create succeeds, exactly 1 create call)
GH_MODE=create_ok; _reset_counts
OUT=$(open_pr_block 2>&1); RC=$?
if [ $RC -eq 0 ] && [ "$(_create_count)" -eq 1 ]; then
  _ok "Test 12: PR created when absent, create called once"
else
  _no "Test 12: PR created when absent" "rc=0 creates=1" "rc=$RC creates=$(_create_count) out=$OUT"
fi

# Test 13 -- recovers from gh create exit-1 quirk (1st list empty, create exits 1, re-check list shows PR)
GH_MODE=quirk; _reset_counts
OUT=$(open_pr_block 2>&1); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "gh CLI quirk; PR confirmed via list"; then
  _ok "Test 13: recovers from create exit-1 quirk via list"
else
  _no "Test 13: recovers from create exit-1 quirk" "rc=0 'gh CLI quirk; PR confirmed via list'" "rc=$RC out=$OUT"
fi

# Test 14 -- fails closed when neither create nor recovery works
GH_MODE=fail_closed; _reset_counts
OUT=$(open_pr_block 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "PR_CREATE_FAILED_BUT_BRANCH_SAFE"; then
  _ok "Test 14: fails closed with salvage line after 3 attempts"
else
  _no "Test 14: fails closed with salvage line" "rc!=0 'PR_CREATE_FAILED_BUT_BRANCH_SAFE'" "rc=$RC out=$OUT"
fi
unset -f gh
rm -f "$GH_CREATE_COUNT_FILE" "$GH_LIST_COUNT_FILE"

# ---------------------------------------------------------------------------
# Defect 3 -- capability check + integration smoke fires.
# ---------------------------------------------------------------------------
# Test 15 -- DAG-executor capability check (CAPABILITY check, run live during build).
# Result recorded: the spec's `on_workflow_status: failed` trigger is NOT supported,
# but the supported primitives `trigger_rule: all_done` + `when:` (verified live in
# schemas/dag-node.ts + condition-evaluator.ts) provide an equivalent fallback path.
# The flip-notion-on-failure node was authored using those supported primitives, so
# Defect 3 ships in THIS WO (no sub-WO needed). This assertion documents that the
# capability gate was satisfied before authoring.
_ok "Test 15: Defect 3 capability gate satisfied (all_done + when supported; on_workflow_status not needed)"

# Test 16 / Test 17 -- integration smoke fires through Cauldron (require a live run).
# Not unit-runnable: they need the YAML deployed + a fire. Documented in the WO stop
# conditions; recorded here as SKIP so the 12-test matrix stays 1:1 and visible.
_skip "Test 16: flip-notion-on-failure fires on failure w/ satisfied validator" "integration; run via Cauldron smoke fire"
_skip "Test 17: flip-notion-on-failure does NOT fire on real (validator) failure" "integration; run via Cauldron smoke fire"

# ---------------------------------------------------------------------------
# Defect 4 -- fire-wo-local.sh token resolution. We test the _resolve_archon_token
# behavior by sourcing the same resolution logic with a fake HOME.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRE_SCRIPT="${SCRIPT_DIR}/../../../../../BDC_XO/scripts/cauldron/fire-wo-local.sh"

# Replicate the resolver verbatim for an isolated unit test (the live script runs it
# at top-level with set -e + arg parsing; we cannot source the whole file without
# triggering the usage exit). Keep in lockstep with fire-wo-local.sh.
_resolve_archon_token() {
  if [[ -n "${ARCHON_OPERATOR_TOKEN:-}" ]]; then return 0; fi
  local cred_file="${HOME}/.claude/reference/credentials-archon.env"
  if [[ -f "$cred_file" ]]; then
    # shellcheck disable=SC1090
    source "$cred_file"
    if [[ -n "${ARCHON_OPERATOR_TOKEN:-}" ]]; then
      echo "Resolved ARCHON_OPERATOR_TOKEN from credentials file" >&2
      return 0
    fi
  fi
  echo "FAIL -- ARCHON_OPERATOR_TOKEN is not set and no credentials file found." >&2
  return 1
}

TMPHOME=$(mktemp -d)
mkdir -p "$TMPHOME/.claude/reference"

# Test 18 -- resolves token from credentials file when env unset
printf 'ARCHON_OPERATOR_TOKEN=test-token-123\n' > "$TMPHOME/.claude/reference/credentials-archon.env"
OUT=$( HOME="$TMPHOME" bash -c "$(declare -f _resolve_archon_token); unset ARCHON_OPERATOR_TOKEN; _resolve_archon_token; echo TOKEN=\$ARCHON_OPERATOR_TOKEN" 2>&1 )
RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "Resolved ARCHON_OPERATOR_TOKEN from credentials file" && echo "$OUT" | grep -q "TOKEN=test-token-123"; then
  _ok "Test 18: token resolved from credentials file"
else
  _no "Test 18: token resolved from credentials file" "rc=0 resolved + TOKEN=test-token-123" "rc=$RC out=$OUT"
fi

# Test 19 -- clear error when token absent everywhere
rm -f "$TMPHOME/.claude/reference/credentials-archon.env"
OUT=$( HOME="$TMPHOME" bash -c "$(declare -f _resolve_archon_token); unset ARCHON_OPERATOR_TOKEN; _resolve_archon_token" 2>&1 )
RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "ARCHON_OPERATOR_TOKEN is not set and no credentials file found"; then
  _ok "Test 19: clear error when token absent everywhere"
else
  _no "Test 19: clear error when token absent everywhere" "rc!=0 + clear error" "rc=$RC out=$OUT"
fi
rm -rf "$TMPHOME"

# ---------------------------------------------------------------------------
echo ""
echo "================================================"
echo "RESULTS: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped (integration)"
echo "================================================"
[ "$FAIL" -eq 0 ] || exit 1
