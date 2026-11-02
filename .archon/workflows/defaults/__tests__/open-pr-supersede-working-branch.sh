#!/usr/bin/env bash
# open-pr-supersede-working-branch.sh -- fixture tests for the superseded-pr-close
# block in open-pr-if-needed.
#
# The production block is extracted from bdc-feature-development-cursor.yaml
# (and parity-checked against the other 12 feature lanes). This harness supplies
# REPO, UNIQUE_BRANCH, BASE_BRANCH, and WORKFLOW_ID itself. It does not depend
# on workflow-executor substitution.
#
# Run: bash .archon/workflows/defaults/__tests__/open-pr-supersede-working-branch.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: [$expected]"
    echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle:   $needle"
    echo "  haystack: $haystack"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  needle present: $needle"
  else
    PASS=$((PASS + 1))
    echo "PASS: $label"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-cursor.yaml"
LANES="
bdc-feature-development.yaml
bdc-feature-development-astra.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-codex-only.yaml
bdc-feature-development-cursor.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-grok.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
"

extract_block() {
  awk '
    /# superseded-pr-close: begin/ { c = 1 }
    c { print }
    /# superseded-pr-close: end/ { c = 0 }
  ' "$1" | sed 's/^      //'
}

BLOCK="$(extract_block "$CANONICAL_YAML")"
if [ -z "$BLOCK" ]; then
  echo "FATAL: could not extract superseded-pr-close from $CANONICAL_YAML"
  exit 1
fi

REPO_VALUE="thinmansoftware/bdc-harness"
UNIQUE_VALUE="feat/wo-one-pr-thread-abc"
BASE_VALUE="dev"
WORKFLOW_VALUE="cauldron-run-one-pr-01"
RUN_URL="https://github.com/thinmansoftware/bdc-harness/pull/11"
EXPECTED_BODY="Superseded by #11 (same Cauldron run ${WORKFLOW_VALUE})"

RUN_JSON_DEFAULT='[
  {"number": 99, "url": "https://github.com/thinmansoftware/bdc-harness/pull/99", "headRefName": "decoy-head", "baseRefName": "dev"},
  {"number": 77, "url": "https://github.com/thinmansoftware/bdc-harness/pull/77", "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "main"},
  {"number": 11, "url": "https://github.com/thinmansoftware/bdc-harness/pull/11", "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev"},
  {"number": 88, "url": "https://github.com/thinmansoftware/bdc-harness/pull/88", "headRefName": "other-decoy", "baseRefName": "dev"}
]'

BUILDER_AUTHOR="fixture-builder[bot]"

CAND_JSON_DEFAULT='[
  {"number": 11, "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/11", "user": {"login": "fixture-builder[bot]"}},
  {"number": 10, "headRefName": "archon/task-web-worker-x", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/10", "user": {"login": "fixture-builder[bot]"}}
]'

CAND_JSON_WITH_OTHERS='[
  {"number": 12, "headRefName": "unrelated-branch", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/12", "user": {"login": "fixture-builder[bot]"}},
  {"number": 13, "headRefName": "archon/task-web-worker-x", "baseRefName": "staging", "url": "https://github.com/thinmansoftware/bdc-harness/pull/13", "user": {"login": "fixture-builder[bot]"}},
  {"number": 11, "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/11", "user": {"login": "fixture-builder[bot]"}},
  {"number": 10, "headRefName": "archon/task-web-worker-x", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/10", "user": {"login": "fixture-builder[bot]"}}
]'

CAND_JSON_NONE='[
  {"number": 11, "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/11", "user": {"login": "fixture-builder[bot]"}},
  {"number": 12, "headRefName": "unrelated-branch", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/12", "user": {"login": "fixture-builder[bot]"}}
]'

CAND_JSON_SAME_HEAD='[
  {"number": 10, "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/10", "user": {"login": "fixture-builder[bot]"}},
  {"number": 11, "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev", "url": "https://github.com/thinmansoftware/bdc-harness/pull/11", "user": {"login": "fixture-builder[bot]"}}
]'

# REST pull shape (gh api /pulls). Same head+base is closed for every author.
# The approved plan filters headRefName and baseRefName only.
CAND_JSON_OTHER_AUTHOR='[
  {"number": 10, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/10", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "fixture-builder[bot]"}},
  {"number": 14, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/14", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "other-human"}},
  {"number": 15, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/15", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "app/Fixture-Builder"}},
  {"number": 16, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/16", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": null}
]'

# --paginate --slurp returns one JSON array per page, wrapped. Every same
# head+base PR is closed, including a match that appears only on a later page.
# An unrelated head on page 1 stays open.
CAND_JSON_PAGES='[
  [
    {"number": 14, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/14", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "other-human"}},
    {"number": 30, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/30", "head": {"ref": "unrelated-branch"}, "base": {"ref": "dev"}, "user": {"login": "fixture-builder[bot]"}}
  ],
  [
    {"number": 21, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/21", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "fixture-builder[bot]"}},
    {"number": 22, "html_url": "https://github.com/thinmansoftware/bdc-harness/pull/22", "head": {"ref": "archon/task-web-worker-x"}, "base": {"ref": "dev"}, "user": {"login": "someone-else[bot]"}}
  ]
]'

RUN_JSON_TRAP='[
  {"number": 99, "url": "https://github.com/thinmansoftware/bdc-harness/pull/99", "headRefName": "feat/wo-one-pr-thread-abc", "baseRefName": "dev"}
]'

PY_BIN="$(command -v python3 || true)"
BASH_BIN="$(command -v bash || true)"
if [ -z "$PY_BIN" ] || [ -z "$BASH_BIN" ]; then
  echo "FATAL: python3 and bash are required"
  exit 1
fi

LAST_RC=0
LAST_OUT=""
LAST_ERR=""
LAST_LOG=""

reset_case() {
  WORKING="archon/task-web-worker-x"
  UNIQUE="$UNIQUE_VALUE"
  CLOSE_RC=0
  COMMENT_RC=0
  SAME_KIND=""
  SAME_URL=""
  EXIST_URL=""
  RUN_JSON="$RUN_JSON_DEFAULT"
  CAND_JSON="$CAND_JSON_DEFAULT"
  ACTING="$BUILDER_AUTHOR"
}

run_block() {
  local case_dir bin script out_file err_file
  case_dir="$(mktemp -d)"
  bin="$case_dir/bin"
  mkdir -p "$bin"
  cat > "$bin/git" << 'EOF'
#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ] && [ "$3" = "HEAD" ]; then
  printf '%s\n' "${STUB_WORKING_BRANCH-}"
  exit 0
fi
echo "unexpected git invocation: $*" >&2
exit 1
EOF
  cat > "$bin/gh" << 'EOF'
#!/bin/bash
{
  printf 'CALL'
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
} >> "$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--head" ]; then
      cat "$GH_RUN_PR_JSON"
      exit 0
    fi
  done
  cat "$GH_CAND_JSON"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  exit "${GH_COMMENT_RC:-0}"
fi
if [ "$1" = "pr" ] && [ "$2" = "close" ]; then
  exit "${GH_CLOSE_RC:-0}"
fi
if [ "$1" = "api" ]; then
  cat "$GH_CAND_JSON"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
EOF
  chmod 755 "$bin/git" "$bin/gh"
  printf '%s\n' "$RUN_JSON" > "$case_dir/run.json"
  printf '%s\n' "$CAND_JSON" > "$case_dir/cand.json"
  : > "$case_dir/gh.log"
  script="$case_dir/block.sh"
  {
    echo 'set -euo pipefail'
    printf '%s\n' "$BLOCK"
  } > "$script"
  out_file="$case_dir/stdout"
  err_file="$case_dir/stderr"
  (
    unset BASH_ENV
    set -euo pipefail
    export PATH="$bin:$(dirname "$PY_BIN"):$(dirname "$BASH_BIN"):/usr/bin:/bin"
    export REPO="$REPO_VALUE"
    export UNIQUE_BRANCH="$UNIQUE"
    export BASE_BRANCH="$BASE_VALUE"
    export WORKFLOW_ID="$WORKFLOW_VALUE"
    export STUB_WORKING_BRANCH="$WORKING"
    export GH_RUN_PR_JSON="$case_dir/run.json"
    export GH_CAND_JSON="$case_dir/cand.json"
    export GH_LOG="$case_dir/gh.log"
    export GH_CLOSE_RC="$CLOSE_RC"
    export GH_COMMENT_RC="$COMMENT_RC"
    if [ -n "$SAME_KIND" ]; then
      export same_head_kind="$SAME_KIND"
    else
      unset same_head_kind
    fi
    if [ -n "$SAME_URL" ]; then
      export same_head_url="$SAME_URL"
    else
      unset same_head_url
    fi
    if [ -n "$EXIST_URL" ]; then
      export EXIST="$EXIST_URL"
    else
      unset EXIST
    fi
    if [ -n "$ACTING" ]; then
      export ACTING_LOGIN="$ACTING"
    else
      unset ACTING_LOGIN
    fi
    bash "$script"
  ) >"$out_file" 2>"$err_file"
  LAST_RC=$?
  LAST_OUT="$(cat "$out_file")"
  LAST_ERR="$(cat "$err_file")"
  LAST_LOG="$(cat "$case_dir/gh.log")"
  rm -rf "$case_dir"
}

comment_body() {
  local number="$1"
  printf '%s\n' "$LAST_LOG" | awk -F '\t' -v n="$number" '
    $1 == "CALL" && $2 == "pr" && $3 == "comment" && $4 == n { print $8 }
  '
}

close_numbers() {
  printf '%s\n' "$LAST_LOG" | awk -F '\t' '
    $1 == "CALL" && $2 == "pr" && $3 == "close" { print $4 }
  '
}

comment_numbers() {
  printf '%s\n' "$LAST_LOG" | awk -F '\t' '
    $1 == "CALL" && $2 == "pr" && $3 == "comment" { print $4 }
  '
}

head_list_count() {
  printf '%s\n' "$LAST_LOG" | awk -F '\t' '
    $1 == "CALL" && $2 == "pr" && $3 == "list" {
      for (i = 1; i <= NF; i++) if ($i == "--head") c++
    }
    END { print c + 0 }
  '
}

api_call() {
  printf '%s\n' "$LAST_LOG" | awk -F '\t' '
    $1 == "CALL" && $2 == "api" { print; exit }
  '
}

api_count() {
  printf '%s\n' "$LAST_LOG" | awk -F '\t' '
    $1 == "CALL" && $2 == "api" { c++ }
    END { print c + 0 }
  '
}

echo "--- Block shape ---"
assert_contains "literal workflow id expansion" '$WORKFLOW_ID' "$BLOCK"
assert_contains "working branch lookup" 'git rev-parse --abbrev-ref HEAD' "$BLOCK"
assert_not_contains "no checkout of UNIQUE_BRANCH" 'git checkout' "$BLOCK"
assert_not_contains "close does not delete the branch" '--delete-branch' "$BLOCK"
assert_contains "candidates are paginated" 'gh api --paginate --slurp --method GET' "$BLOCK"
assert_contains "candidates are filtered by head server-side" 'head=${REPO_OWNER}:${WORKING_BRANCH}' "$BLOCK"
assert_contains "no author filter is stated" 'No author filter' "$BLOCK"
assert_not_contains "close block does not read ACTING_LOGIN" 'ACTING_LOGIN' "$BLOCK"
assert_not_contains "close block does not compare logins" 'norm_login' "$BLOCK"
assert_not_contains "no capped global open list" 'gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefName,baseRefName,url' "$BLOCK"

echo "--- Test 1: builder PR on the working branch is closed as superseded ---"
reset_case
run_block
assert_eq "test1 exit" "0" "$LAST_RC"
assert_eq "test1 stdout" "superseded_pr_closed:10" "$LAST_OUT"
assert_eq "test1 stderr" "" "$LAST_ERR"
assert_eq "test1 comment body" "$EXPECTED_BODY" "$(comment_body 10)"
assert_eq "test1 close targets" "10" "$(close_numbers)"
assert_eq "test1 comment targets" "10" "$(comment_numbers)"
assert_eq "test1 fallback list used" "1" "$(head_list_count)"
assert_eq "test1 candidate query count" "1" "$(api_count)"
assert_contains "test1 paginates" "--paginate" "$(api_call)"
assert_contains "test1 slurps every page" "--slurp" "$(api_call)"
assert_contains "test1 server-side head" "head=thinmansoftware:archon/task-web-worker-x" "$(api_call)"
assert_contains "test1 server-side base" "base=dev" "$(api_call)"
assert_not_contains "test1 candidate query has no limit" "--limit" "$(api_call)"
assert_not_contains "test1 log has no close 11" $'\tclose\t11\t' "$LAST_LOG"

echo "--- Test 2: other branches and other bases are never touched ---"
reset_case
CAND_JSON="$CAND_JSON_WITH_OTHERS"
run_block
assert_eq "test2 exit" "0" "$LAST_RC"
assert_eq "test2 stdout" "superseded_pr_closed:10" "$LAST_OUT"
assert_eq "test2 close targets" "10" "$(close_numbers)"
assert_eq "test2 comment targets" "10" "$(comment_numbers)"
assert_not_contains "test2 no call on 12" $'\t12\t' "$LAST_LOG"
assert_not_contains "test2 no call on 13" $'\t13\t' "$LAST_LOG"

echo "--- Test 3: no builder PR, nothing closed ---"
reset_case
CAND_JSON="$CAND_JSON_NONE"
run_block
assert_eq "test3 exit" "0" "$LAST_RC"
assert_eq "test3 stdout" "superseded_pr_none" "$LAST_OUT"
assert_eq "test3 close targets" "" "$(close_numbers)"
assert_eq "test3 comment targets" "" "$(comment_numbers)"

echo "--- Test 4: close failure does not fail the node ---"
reset_case
CLOSE_RC=1
run_block
assert_eq "test4 exit" "0" "$LAST_RC"
assert_eq "test4 stdout" "superseded_pr_close_failed:10" "$LAST_OUT"
assert_eq "test4 close targets" "10" "$(close_numbers)"
assert_not_contains "test4 did not close 11" $'\tclose\t11\t' "$LAST_LOG"
assert_not_contains "test4 no success token" "superseded_pr_closed:10" "$LAST_OUT"

echo "--- Test 5: lanes stay identical ---"
REF_BLOCK="$BLOCK"
for lane in $LANES; do
  got="$(extract_block "$DEFAULTS/$lane")"
  assert_eq "parity $lane" "$REF_BLOCK" "$got"
  begin_n="$(grep -c '# superseded-pr-close: begin' "$DEFAULTS/$lane" || true)"
  end_n="$(grep -c '# superseded-pr-close: end' "$DEFAULTS/$lane" || true)"
  assert_eq "begin count $lane" "1" "$begin_n"
  assert_eq "end count $lane" "1" "$end_n"
done
cursor_count="$(grep -c 'superseded_pr_closed' "$CANONICAL_YAML" || true)"
if [ "$cursor_count" -ge 1 ]; then
  PASS=$((PASS + 1))
  echo "PASS: cursor lane superseded_pr_closed count >= 1 ($cursor_count)"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: cursor lane superseded_pr_closed count >= 1 (got $cursor_count)"
fi

echo "--- Test 6: detached HEAD skips close ---"
reset_case
WORKING="HEAD"
run_block
assert_eq "test6 exit" "0" "$LAST_RC"
assert_eq "test6 stdout" "superseded_pr_none" "$LAST_OUT"
assert_eq "test6 gh log" "" "$LAST_LOG"

echo "--- Test 7: empty working branch skips close ---"
reset_case
WORKING=""
run_block
assert_eq "test7 exit" "0" "$LAST_RC"
assert_eq "test7 stdout" "superseded_pr_none" "$LAST_OUT"
assert_eq "test7 gh log" "" "$LAST_LOG"

echo "--- Test 8: working branch equal to UNIQUE_BRANCH does not close the run PR ---"
reset_case
WORKING="$UNIQUE_VALUE"
CAND_JSON="$CAND_JSON_SAME_HEAD"
run_block
assert_eq "test8 exit" "0" "$LAST_RC"
assert_eq "test8 stdout" "superseded_pr_none" "$LAST_OUT"
assert_eq "test8 close targets" "" "$(close_numbers)"
assert_eq "test8 comment targets" "" "$(comment_numbers)"

echo "--- Test 9: adopted run PR URL wins over the fallback list ---"
reset_case
SAME_KIND="adopt"
SAME_URL="$RUN_URL"
RUN_JSON="$RUN_JSON_TRAP"
run_block
assert_eq "test9 exit" "0" "$LAST_RC"
assert_eq "test9 stdout" "superseded_pr_closed:10" "$LAST_OUT"
assert_eq "test9 comment body" "$EXPECTED_BODY" "$(comment_body 10)"
assert_eq "test9 no fallback list" "0" "$(head_list_count)"

echo "--- Test 10: EXIST url is used when same-head did not adopt ---"
reset_case
EXIST_URL="$RUN_URL"
RUN_JSON="$RUN_JSON_TRAP"
run_block
assert_eq "test10 exit" "0" "$LAST_RC"
assert_eq "test10 comment body" "$EXPECTED_BODY" "$(comment_body 10)"
assert_eq "test10 no fallback list" "0" "$(head_list_count)"
assert_eq "test10 close targets" "10" "$(close_numbers)"

echo "--- Test 11: no usable run PR URL does not close ---"
reset_case
RUN_JSON='[]'
run_block
assert_eq "test11 exit" "0" "$LAST_RC"
assert_eq "test11 close targets" "" "$(close_numbers)"
assert_eq "test11 comment targets" "" "$(comment_numbers)"
assert_contains "test11 warns" "no usable run PR URL" "$LAST_ERR"
assert_not_contains "test11 no closed token" "superseded_pr_closed:" "$LAST_OUT"

echo "--- Test 12: unparsable run PR URL does not close ---"
reset_case
SAME_KIND="adopt"
SAME_URL="https://example.com/not-a-pr"
run_block
assert_eq "test12 exit" "0" "$LAST_RC"
assert_eq "test12 close targets" "" "$(close_numbers)"
assert_contains "test12 warns" "could not parse run PR number" "$LAST_ERR"

echo "--- Test 13: comment failure still attempts close ---"
reset_case
COMMENT_RC=1
run_block
assert_eq "test13 exit" "0" "$LAST_RC"
assert_eq "test13 stdout" "superseded_pr_closed:10" "$LAST_OUT"
assert_contains "test13 comment warn" "comment failed for #10" "$LAST_ERR"
assert_not_contains "test13 no comment-failure stdout token" "comment_failed" "$LAST_OUT"
assert_eq "test13 close targets" "10" "$(close_numbers)"

echo "--- Test 14: same branch and base is closed for every author ---"
reset_case
CAND_JSON="$CAND_JSON_OTHER_AUTHOR"
run_block
assert_eq "test14 exit" "0" "$LAST_RC"
assert_eq "test14 stdout" "$(printf '%s\n' "superseded_pr_closed:10" "superseded_pr_closed:14" "superseded_pr_closed:15" "superseded_pr_closed:16")" "$LAST_OUT"
assert_eq "test14 close targets" "$(printf '%s\n' "10" "14" "15" "16")" "$(close_numbers)"
assert_eq "test14 comment targets" "$(printf '%s\n' "10" "14" "15" "16")" "$(comment_numbers)"
assert_contains "test14 still queries the working branch" "head=thinmansoftware:archon/task-web-worker-x" "$(api_call)"

echo "--- Test 15: a later page is closed and another branch stays open ---"
reset_case
CAND_JSON="$CAND_JSON_PAGES"
run_block
assert_eq "test15 exit" "0" "$LAST_RC"
assert_eq "test15 stdout" "$(printf '%s\n' "superseded_pr_closed:14" "superseded_pr_closed:21" "superseded_pr_closed:22")" "$LAST_OUT"
assert_eq "test15 close targets" "$(printf '%s\n' "14" "21" "22")" "$(close_numbers)"
assert_eq "test15 comment targets" "$(printf '%s\n' "14" "21" "22")" "$(comment_numbers)"
assert_not_contains "test15 no close 30" $'\tclose\t30\t' "$LAST_LOG"
assert_contains "test15 paginates" "--paginate" "$(api_call)"
assert_not_contains "test15 no limit cap" "--limit" "$(api_call)"

echo "--- Test 16: close does not depend on ACTING_LOGIN ---"
reset_case
ACTING=""
CAND_JSON="$CAND_JSON_DEFAULT"
run_block
assert_eq "test16 exit" "0" "$LAST_RC"
assert_eq "test16 stdout" "superseded_pr_closed:10" "$LAST_OUT"
assert_eq "test16 close targets" "10" "$(close_numbers)"
assert_eq "test16 comment targets" "10" "$(comment_numbers)"
assert_eq "test16 candidate query count" "1" "$(api_count)"
assert_not_contains "test16 no author skip" "builder author unresolved" "$LAST_ERR"

echo ""
echo "RESULTS: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
