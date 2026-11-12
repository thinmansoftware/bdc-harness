#!/usr/bin/env bash
# WO #5217 round 2c: no arguments run all cases; use <scenario> to focus.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

if [ "$#" -eq 0 ]; then
  scenarios=(artifacts-current artifacts-stage artifacts-custom capture-current capture-stage)
elif [ "$#" -eq 1 ]; then
  scenarios=("$1")
else
  echo 'Specify one scenario or no arguments for all scenarios' >&2; exit 2
fi
for scenario in "${scenarios[@]}"; do
case "$scenario" in
  artifacts-current|artifacts-stage|artifacts-custom|capture-current|capture-stage) ;;
  *) echo 'Specify artifacts-current, artifacts-stage, artifacts-custom, capture-current or capture-stage' >&2; exit 2 ;;
esac
fixture "r2c-$scenario"
CURRENT="$WT"; TARGET="$WT"
if [[ "$scenario" = *-stage ]]; then
  fixture "r2c-target-$scenario"
  TARGET="$WT"
fi
printf 'base\n' > "$TARGET/product.txt"
if [[ "$scenario" = capture-* ]]; then
  printf 'HELPER=helper.js\n. "$HELPER"\n' > "$TARGET/check.sh"
  printf 'echo "Tests: 0/1"; exit 1\n' > "$TARGET/helper.js"
else
  printf 'if grep -q good product.txt; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$TARGET/check.sh"
fi
git -C "$TARGET" add product.txt check.sh
git -C "$TARGET" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
git -C "$TARGET" branch run-base
printf 'bad build\n' > "$TARGET/product.txt"
git -C "$TARGET" add product.txt
git -C "$TARGET" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
WT="$CURRENT"
export ARTIFACTS_DIR="$WT/artifacts" BASE_BRANCH=run-base FIX_MAP=''
if [ "$scenario" = artifacts-custom ]; then export ARTIFACTS_DIR="$WT/lane-output"; fi
mkdir -p "$ARTIFACTS_DIR/evidence"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
if [[ "$scenario" = *-stage ]]; then
  export RST_STAGE_WORKTREES="s=$TARGET"
  export FIX_SPEC='WO Class: CODE
## Canonical stages
```yaml
stages:
  - id: s
    repo: thinmansoftware/other
    target_branch: run-base
    in_scope_files: [product.txt]
    verify_commands: ["bash check.sh"]
    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}
```'
fi

# Real runs save this dynamic harness code before taking the snapshot.
rst_save_core "$ARTIFACTS_DIR/evidence"
if [[ "$scenario" = artifacts-* ]]; then
  # Exercise an explicit reference as well as the infrastructure inventory.
  harness="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).as_posix())' "$ARTIFACTS_DIR/evidence/stop-tests.core.sh")"
  printf '. "%s"\n' "$harness" >> "$TARGET/check.sh"
  git -C "$TARGET" add check.sh
  git -C "$TARGET" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm harness-reference
fi
diagnostic="$TMP/diagnostic"
export FIX_INITIAL="$(run_node run-stop-tests 2> "$diagnostic")"
check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
if [[ "$scenario" = capture-* ]]; then
  check contains "$(cat "$diagnostic")" 'test guard: cannot resolve trusted helper: check.sh'
  check test -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
else
  check test ! -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
  check rejects contains "$(cat "$diagnostic")" 'cannot resolve trusted helper'
fi
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
check test "$(trg_infrastructure "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json")" = 'Repair touched test infrastructure: none'
if [[ "$scenario" = artifacts-* ]]; then
  check python3 - "$ARTIFACTS_DIR/evidence/test-guard.json" "$ARTIFACTS_DIR" "$TARGET" <<'PY'
import json, pathlib, sys
snapshot, artifacts = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()
states = json.loads(snapshot.read_text())
assert 'check.sh' in states[str(pathlib.Path(sys.argv[3]).resolve())]['trusted']
for directory, state in states.items():
    for name in state['trusted']:
        assert not (pathlib.Path(directory)/name).resolve().is_relative_to(artifacts), name
for path in (snapshot.parent/'trusted-infra').rglob('*'):
    assert 'stop-tests.core.sh' != path.name, path
PY
  # Subsequent evidence writes do not become repairs to project infrastructure.
  printf 'source "$DYNAMIC_HARNESS_HELPER"\n' >> "$ARTIFACTS_DIR/evidence/stop-tests.core.sh"
  printf 'source "$NEW_HARNESS_HELPER"\n' > "$ARTIFACTS_DIR/evidence/generated.sh"
else
  printf 'echo "Tests: 1/1"\n' > "$TARGET/helper.js"
fi
printf 'good repair\n' > "$TARGET/product.txt"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
check test "$(trg_infrastructure "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json")" = 'Repair touched test infrastructure: none'
printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
# Restore the executable harness functions before the final node sources them.
rst_save_core "$ARTIFACTS_DIR/evidence"
out="$(run_node run-stop-tests-final)"
check contains "$out" 'TESTS_FINAL_INFRA=trusted'
if [[ "$scenario" = capture-* ]]; then
  check contains "$out" 'TESTS_STATUS=blocked'
  check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
  check rejects contains "$out" 'TESTS_STATUS=passed'
else
  check contains "$out" 'TESTS_STATUS=passed'
  check contains "$out" 'TESTS_REPAIR_RESULT=repaired'
fi
# A capture error must never suppress a real frozen-file violation either.
printf '# changed frozen project entrypoint\n' >> "$TARGET/check.sh"
check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
unset RST_STAGE_WORKTREES BASE_BRANCH
done
finish trusted-test-infra-r2c.sh
