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
finish stage-evidence.sh
