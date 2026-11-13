#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
fixture shopops
SHOP="$WT"; mkdir -p "$WT/shopops-api/tests"
printf 'console.log("Tests: 2/2")\n' > "$WT/shopops-api/tests/run_all.js"
fixture lspro
LS="$WT"
printf '{"scripts":{"test":"bash test_contract.sh"}}\n' > "$WT/package.json"
printf 'echo "Tests: 1/1"\n' > "$WT/test_contract.sh"
printf '' > "$WT/bun.lock"
WT="$SHOP"; export ARTIFACTS_DIR="$WT/artifacts"
export FIX_SPEC='WO Class: MIXED
## Canonical stages
```yaml
stages:
  - id: shopops-batch-routes
    repo: thinmansoftware/shopops
    target_branch: staging
    in_scope_files: [shopops-api]
    verify_commands: ["cd shopops-api && node tests/run_all.js"]
    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}
  - id: lspro-contracts
    repo: thinmansoftware/lspro-react
    target_branch: lspro/comics-integration
    in_scope_files: [src]
    verify_commands: ["bun run test"]
    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}
```
Stop 1 (test suite):
  bash forbidden.sh
Expected: pass'
export FIX_MAP=''
out="$(run_node run-stop-tests)"
check contains "$out" 'TESTS_STATUS=blocked'
check contains "$out" 'TESTS_STAGE_LINE=shopops-batch-routes: 2/2'
check contains "$out" 'TESTS_STAGE_LINE=lspro-contracts: BLOCKED (stage_repo_absent:thinmansoftware/lspro-react)'
check test "$(grep -c '### run-stop-tests: bun run test' "$ARTIFACTS_DIR/evidence/stop-tests.log")" = 0
check test "$(cat "$ARTIFACTS_DIR/evidence/stop-tests.commands")" = $'cd shopops-api && node tests/run_all.js\nbun run test'
export RST_STAGE_WORKTREES="shopops-batch-routes=$SHOP
lspro-contracts=$LS"
out="$(run_node run-stop-tests)"
check contains "$out" 'TESTS_STATUS=passed'
check contains "$out" 'TESTS_PASSED=3'
check contains "$out" 'TESTS_TOTAL=3'
printf 'echo "Tests: 0/1"; exit 1\n' > "$LS/test_contract.sh"
out="$(run_node run-stop-tests)"
check contains "$out" 'TESTS_STATUS=failed'
check contains "$out" 'lspro-contracts: 0/1 (bun run test) -- FAILED'
check contains "$out" 'shopops-batch-routes: 2/2'
check contains "$out" 'superseded'
unset RST_STAGE_WORKTREES
fixture environment
mkdir -p "$WT/tests" "$TMP/toolbin/bun-node-fallback-bin"
TOOLS="$TMP/toolbin"
PYTHON_DIR="$(dirname "$(command -v python3)")"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  pytest tests/x.py\nExpected: pass'
out="$(PATH="$TOOLS:/usr/bin:/bin:$PYTHON_DIR" run_node run-stop-tests)"
check contains "$out" 'TESTS_STATUS=blocked'
check contains "$out" 'TESTS_BLOCKED_REASON=missing_tool:pytest'
export FIX_INITIAL="$out"
check contains "$(run_node classify-test-result)" '"repairable":"false"'
cat > "$TOOLS/bun-node-fallback-bin/node" <<'SH'
#!/usr/bin/env bash
echo 'error: Cannot use test outside of the test runner.'
exit 1
SH
chmod +x "$TOOLS/bun-node-fallback-bin/node"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  node tests/x.js\nExpected: pass'
out="$(PATH="$TOOLS/bun-node-fallback-bin:$PATH" run_node run-stop-tests)"
check contains "$out" 'TESTS_BLOCKED_REASON=runner_mismatch:node-is-bun'
printf 'sleep 10\n' > "$WT/tests/sleep.sh"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash tests/sleep.sh\nExpected: pass'
start=$SECONDS
out="$(RST_TIMEOUT_SECONDS=2 run_node run-stop-tests)"
check contains "$out" 'TESTS_BLOCKED_REASON=timeout:2s'
check test "$((SECONDS-start))" -lt 10
cat > "$TOOLS/gh" <<'SH'
#!/usr/bin/env bash
cat "$ARTIFACTS_DIR/map.json"
SH
chmod +x "$TOOLS/gh"
for pair in 900:900 5:60 absent:1500 invalid:1500 1900:1700; do
  value="${pair%:*}"; expected="${pair#*:}"
  python3 - "$ARTIFACTS_DIR/map.json" "$value" <<'PY'
import base64,json,sys
project=dict(repo="thinmansoftware/shopops",test_command="bash tests/pass.sh")
if sys.argv[2]!="absent":
    project["test_timeout_seconds"]=int(sys.argv[2]) if sys.argv[2].isdigit() else "invalid"
data=json.dumps(dict(shopops=project)).encode()
json.dump(dict(sha="a"*40,content=base64.b64encode(data).decode()),open(sys.argv[1],"w"))
PY
  check contains "$(PATH="$TOOLS:$PATH" run_node resolve-test-command)" "TEST_TIMEOUT_SECONDS=$expected"
done
printf 'echo "Tests: 1/1"\n' > "$WT/tests/first.sh"
printf 'echo segment-two-failed; exit 1\n' > "$WT/tests/second.sh"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash tests/first.sh && bash tests/second.sh\nExpected: pass'
out="$(run_node run-stop-tests)"
check contains "$out" 'TESTS_COMMAND_RESULT=bash tests/second.sh => exit 1, /'
check contains "$out" 'TESTS_STATUS=failed'
# Reject ambiguous unmarked plans instead of executing a foreign example.
check rejects rst_stage_plan <<< $'```yaml\nstages: []\n```\n```yaml\nstages: []\n```'
# The replay lane must copy executable node bodies, disable pushing and never publish.
check test -f "$HERE/../bdc-evidence-replay.yaml"
check test -f "$ROOT/scripts/evidence-replay/backlog-replay.sh"
# Stub gh and bun: dry selection must neither invoke the engine nor write events.
python3 - "$ARTIFACTS_DIR/backlog.json" <<'PY'
import json,sys
prs=[dict(number=n,updatedAt="2026-11-%02dT00:00:00Z"%n,statusCheckRollup=[] if n%2 else [dict(conclusion="FAILURE")],headRefOid="a"*40) for n in range(1,13)]
prs.append(dict(number=99,updatedAt="2026-12-01T00:00:00Z",statusCheckRollup=[dict(conclusion="SUCCESS")]))
json.dump(prs,open(sys.argv[1],"w"))
PY
cat > "$TOOLS/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ARTIFACTS_DIR/selection.calls"
cat "$ARTIFACTS_DIR/backlog.json"
SH
cat > "$TOOLS/bun" <<'SH'
#!/usr/bin/env bash
touch "$ARTIFACTS_DIR/fired"
exit 88
SH
chmod +x "$TOOLS/gh" "$TOOLS/bun"
out="$(PATH="$TOOLS:$PATH" bash "$ROOT/scripts/evidence-replay/backlog-replay.sh" --sample 10 --dry-run)"
check test "$?" = 0
check test "$out" = $'12\n11\n10\n9\n8\n7\n6\n5\n4\n3'
check test ! -f "$ARTIFACTS_DIR/fired"
check contains "$(cat "$ARTIFACTS_DIR/selection.calls" 2>/dev/null)" '--base dev --state open'
if [ -f "$HERE/../bdc-evidence-replay.yaml" ]; then
  python3 - "$LANE" "$HERE/../bdc-evidence-replay.yaml" <<'PY'
import sys, yaml
a,b = [{n['id']:n for n in yaml.safe_load(open(p))['nodes']} for p in sys.argv[1:]]
for name in ['resolve-test-command','run-stop-tests','classify-test-result','test-repair','run-stop-tests-final']:
    for key in ['bash','loop']:
        assert a[name].get(key) == b[name].get(key), (name,key)
assert not any(n in b for n in ['commit-and-push','open-pr','tests-blocked-report','blocked-issue'])
assert 'DISABLED-evidence-replay' in b['checkout-replay']['bash']
PY
  check test "$?" = 0
fi
# Run the real checkout node against local refs only. A linked worktree shares
# its source config, so the old remote set-url corrupts both source and sibling.
for pushurl in unset original-push-url; do
  fixture "replay-source-$pushurl"
  SOURCE_REPO="$WT"
  printf 'echo "Tests: 1/1"\n' > "$WT/test_replay.sh"
  git -C "$WT" add test_replay.sh
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm seed
  REPLAY_SHA="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" update-ref refs/pull/42/head "$REPLAY_SHA"
  git -C "$WT" remote set-url origin "$SOURCE_REPO"
  if [ "$pushurl" != unset ]; then git -C "$WT" config remote.origin.pushurl "$pushurl"; fi
  before_push="$(git -C "$WT" config --get remote.origin.pushurl || true)"
  WT="$TMP/replay-linked-$pushurl"
  git -C "$SOURCE_REPO" worktree add --detach "$WT" HEAD >/dev/null
  export ARTIFACTS_DIR="$WT/artifacts"
  mkdir -p "$ARTIFACTS_DIR/evidence"
  cat > "$TOOLS/gh" <<SH
#!/usr/bin/env bash
printf '%s\n' '{"body":"WO: WO-REPLAY-FIXTURE","headRefOid":"$REPLAY_SHA"}'
SH
  chmod +x "$TOOLS/gh"
  export PR_NUMBER=42
  checkout="$(LANE="$HERE/../bdc-evidence-replay.yaml" PATH="$TOOLS:$PATH" run_node checkout-replay)"
  check test "$?" = 0
  check test "$(git -C "$SOURCE_REPO" config --get remote.origin.pushurl || true)" = "$before_push"
  check test "$(git -C "$WT" config --get remote.origin.pushurl || true)" = "$before_push"
  REPLAY_WT="$(cat "$ARTIFACTS_DIR/evidence/replay-checkout" 2>/dev/null || printf '%s' "$WT")"
  check test "$(git -C "$REPLAY_WT" config --get remote.origin.pushurl)" = DISABLED-evidence-replay
  check test "$(git -C "$REPLAY_WT" rev-parse HEAD)" = "$REPLAY_SHA"
  check rejects git -C "$REPLAY_WT" symbolic-ref -q HEAD
  # Subsequent nodes start in the engine worktree but must test the clone.
  printf 'echo "Tests: 0/1"; exit 1\n' > "$WT/test_replay.sh"
  export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash test_replay.sh\nExpected: pass'
  export FIX_MAP=''
  out="$(LANE="$HERE/../bdc-evidence-replay.yaml" run_node run-stop-tests)"
  check contains "$out" 'TESTS_STATUS=passed'
  unset PR_NUMBER
done
# Test 17: follow the parsed lane dependency when scheduling grep evidence. On
# the old wiring the passing pre-repair result survives a grep-breaking repair.
eval "$(core rsg)"
eval "$(core sme)"
eval "$(core mec)"
fixture grep-after-repair
printf 'bad required\n' > "$WT/product"
printf 'if grep -q good product; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/test_product.sh"
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash test_product.sh\nExpected: pass\nStop 2 (grep assertion):\n  grep -c required product\nExpected: 1'
export FIX_MAP=''
before_greps="$(run_node run-stop-greps)"
check contains "$before_greps" 'GREP_STATUS=passed'
export FIX_INITIAL="$(run_node run-stop-tests)"
check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
after_repair="$(python3 - "$LANE" <<'PY'
import sys, yaml
nodes = yaml.safe_load(open(sys.argv[1]))['nodes']
greps = next(n for n in nodes if n['id'] == 'run-stop-greps')
print('yes' if 'run-stop-tests-final' in greps.get('depends_on', []) else 'no')
PY
)"
greps="$before_greps"
# Stub product repair: fixes the test while removing the required grep token.
printf 'good\n' > "$WT/product"
run_node test-repair until_bash >/dev/null
final="$(run_node run-stop-tests-final)"
check contains "$final" 'TESTS_STATUS=passed'
check contains "$final" 'TESTS_REPAIR_RESULT=repaired'
if [ "$after_repair" = yes ]; then greps="$(run_node run-stop-greps)"; fi
check contains "$greps" 'GREP_STATUS=mismatch'
check contains "$greps" 'GREP_LINE=grep -c required product => 0'
stamped="$(printf 'Tests: placeholder\nGrep assertions: placeholder\nVALIDATION: PASS\n' | sme_process "$(sme_field TESTS_LINE "$final")" "$(sme_field TESTS_STATUS "$final")" "$(sme_field GREP_LINE "$greps")" "$(sme_field GREP_STATUS "$greps")")"
check contains "$stamped" 'VALIDATION: FAIL'
printf '%s\n' "$stamped" | mec_check PROCEED CODE "$(mec_field TESTS_STATUS "$final")" "$(mec_field GREP_DECLARED "$greps")" "$(mec_field GREP_STATUS "$greps")" 0 "$(mec_field GREP_EXECUTED "$greps")" "$(mec_field GREP_DROPPED "$greps")" "$(mec_field GREP_UNPARSED "$greps")" "$(mec_field GREP_MISMATCH "$greps")" '' > "$TMP/grep-mec-out" 2> "$TMP/grep-mec-err"
check test "$?" = 1
check test "$(cat "$TMP/grep-mec-out")" != OK
check contains "$(cat "$TMP/grep-mec-err")" 'EVIDENCE_ERROR:'
finish stage-evidence.sh
