#!/usr/bin/env bash
# WO #5217 round 2b: capture failures affect repair evidence only.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

for location in no-git current stage; do
  for result in passed failed; do
    echo "Round 2b initial evidence: $location/$result"
    fixture "r2b-$location-$result"
    CURRENT="$WT"; TARGET="$WT"
    export ARTIFACTS_DIR="$TMP/r2b-evidence-$location-$result"
    mkdir -p "$ARTIFACTS_DIR/evidence"
    if [ "$location" = no-git ]; then
      # fixture() made this disposable repository. Hide it so capture is unavailable.
      mv "$WT/.git" "$WT/fixture-git"
    elif [ "$location" = stage ]; then
      fixture "r2b-target-$result"
      TARGET="$WT"; WT="$CURRENT"
      export ARTIFACTS_DIR="$TMP/r2b-evidence-$location-$result"
      export RST_STAGE_WORKTREES="s=$TARGET"
    fi
    printf 'HELPER=leaf.js\n. "$HELPER"\n' > "$TARGET/check.sh"
    if [ "$result" = passed ]; then
      printf 'echo "Tests: 1/1"\n' > "$TARGET/leaf.js"
    else
      printf 'echo "Tests: 0/1"\nexit 1\n' > "$TARGET/leaf.js"
    fi
    export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
    if [ "$location" = stage ]; then
      export FIX_SPEC='WO Class: CODE
## Canonical stages
```yaml
stages:
  - id: s
    repo: thinmansoftware/other
    target_branch: master
    in_scope_files: [check.sh]
    verify_commands: ["bash check.sh"]
    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}
```'
    fi
    diagnostic="$TMP/r2b-diagnostic-$location-$result"
    export FIX_INITIAL="$(run_node run-stop-tests 2> "$diagnostic")"
    check contains "$FIX_INITIAL" "TESTS_STATUS=$result"
    check rejects contains "$FIX_INITIAL" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
    check test -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
    if [ "$location" != no-git ]; then
      check contains "$(cat "$diagnostic")" 'test guard: cannot resolve trusted helper: check.sh'
    fi
    if [ "$result" = failed ]; then repairable=true; else repairable=false; fi
    check contains "$(run_node classify-test-result)" "\"repairable\":\"$repairable\""
    out="$(run_node run-stop-tests-final)"
    check contains "$out" "$FIX_INITIAL"
    check contains "$out" 'TESTS_REPAIR_ATTEMPTS=0'
    check rejects contains "$out" 'TESTS_FINAL_INFRA=trusted'
    # A repair attempt cannot turn failed trusted capture into accepted evidence,
    # even if the untrusted live helper has since been changed to pass.
    printf 'echo "Tests: 1/1"\n' > "$TARGET/leaf.js"
    printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
    out="$(run_node run-stop-tests-final 2> "$diagnostic")"
    check contains "$out" 'TESTS_STATUS=blocked'
    check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
    check contains "$out" 'TESTS_FINAL_INFRA=trusted'
    check rejects contains "$out" 'TESTS_STATUS=passed'
    unset RST_STAGE_WORKTREES
  done
done
finish trusted-test-infra-r2b
