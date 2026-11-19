#!/usr/bin/env bash
# Exercise the merged env_reason/log_path contract through real lane nodes.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

fixture merged-env
printf 'echo "Tests: 1/1"\n' > "$WT/check.sh"
printf 'echo "Tests: 0/1"; exit 1\n' > "$WT/fail.sh"
printf 'timeout: failed to run command pytest\n' > "$TMP/missing.log"
report="$(rst_report CODE 'bash check.sh' 127 '' '' "$TMP/missing.log")"
check contains "$report" 'TESTS_BLOCKED_REASON=missing_tool:pytest'
report="$(rst_report CODE 'bash check.sh' 124 '1 1' 'postgres capability absent in this lane' "$TMP/missing.log")"
check contains "$report" 'TESTS_STATUS=env_unavailable'
check contains "$report" 'TESTS_LINE=1/1 (bash check.sh) -- ENVIRONMENT UNAVAILABLE: postgres capability absent in this lane'
check rejects contains "$report" 'TESTS_BLOCKED_REASON='

unset BDC_BUILDER_POSTGRES
e="$ARTIFACTS_DIR/evidence"
printf 'bash check.sh\nbash check.sh --postgres\n' > "$e/stop-tests.commands"
report="$(cd "$WT" && rst_execute_saved "$e" CODE)"
check contains "$report" 'TESTS_STATUS=env_unavailable'
check contains "$report" 'TESTS_ENV_REASON=postgres capability absent in this lane'
check contains "$report" 'TESTS_PASSED=1'
check contains "$report" 'TESTS_TOTAL=1'
report="$(cd "$WT" && BDC_BUILDER_POSTGRES=1 rst_execute_saved "$e" CODE)"
check contains "$report" 'TESTS_STATUS=passed'
check contains "$report" 'TESTS_TOTAL=2'
printf 'bash fail.sh\nbash check.sh --postgres\n' > "$e/stop-tests.commands"
report="$(cd "$WT" && rst_execute_saved "$e" CODE)"
check contains "$report" 'TESTS_STATUS=env_unavailable'
check contains "$report" 'TESTS_TOTAL=1'

# Stage aggregation preserves env_unavailable over both real failures and missing
# stage worktrees, independently of stage order. Counts remain numeric.
export RST_STAGE_WORKTREES="local=$WT"
for order in env-first env-last; do
  if [ "$order" = env-first ]; then
    printf 'local\tthinmansoftware/shopops\tbash check.sh\nlocal\tthinmansoftware/shopops\tbash check.sh --postgres\nmissing\tthinmansoftware/absent\tbash check.sh\n'
  else
    printf 'missing\tthinmansoftware/absent\tbash check.sh\nlocal\tthinmansoftware/shopops\tbash check.sh\nlocal\tthinmansoftware/shopops\tbash check.sh --postgres\n'
  fi > "$e/stop-tests.stages"
  report="$(cd "$WT" && rst_execute_saved "$e" CODE)"
  check contains "$report" 'TESTS_STATUS=env_unavailable'
  check contains "$report" 'TESTS_ENV_REASON=postgres capability absent in this lane'
  check contains "$report" 'TESTS_BLOCKED_REASON=stage_repo_absent:thinmansoftware/absent'
  check contains "$report" 'TESTS_TOTAL=1'
done

# The actual classifier refuses repair for every non-repairable outcome.
for status in env_unavailable blocked failed; do
  export FIX_INITIAL="TESTS_STATUS=$status"
  report="$(run_node classify-test-result)"
  if [ "$status" = failed ]; then
    check contains "$report" '"repairable":"true"'
  else
    check contains "$report" '"repairable":"false"'
  fi
done

# Run the shipped final node against a persisted plan. If the capability becomes
# unavailable after repair began, do not rewrite it as repair exhaustion.
: > "$e/stop-tests.stages"
printf 'bash check.sh\nbash check.sh --postgres\n' > "$e/stop-tests.commands"
printf 'CODE\n' > "$e/stop-tests.class"
printf '1500\n' > "$e/stop-tests.timeout"
printf '1\n' > "$e/test-repair.attempts"
rst_save_core "$e"
(cd "$WT" && trg_snapshot "$WT" "$e/test-guard.json")
report="$(run_node run-stop-tests-final)"
check contains "$report" 'TESTS_STATUS=env_unavailable'
check contains "$report" 'TESTS_REPAIR_RESULT=env_unavailable'
check rejects contains "$report" 'TESTS_STATUS=blocked'
check rejects contains "$report" 'tests_failed_after_repair:exhausted'

finish env-unavailable-test-loop.sh
