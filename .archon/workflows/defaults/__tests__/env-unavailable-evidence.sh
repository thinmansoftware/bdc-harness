#!/usr/bin/env bash
# Execute the shipped node and evidence cores, with local fixture commands only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
T="$(mktemp -d "$PWD/.env-evidence.XXXXXX")"
trap 'rc=$?; if [ "$rc" -ne 0 ]; then cat "$T/absent" "$T/err-absent" "$T/art-absent/evidence/stop-tests.log" 2>/dev/null || true; fi; rm -rf "$T"' EXIT
export BDC_RSGARGV_SCRIPT="$ROOT/scripts/lane/rsg-argv.sh"
YAML="$HERE/../bdc-feature-development.yaml"
tr -d '\r' < "$YAML" | awk '/^  - id: run-stop-tests$/ {n=1;next} n && /^  - id:/ {n=0;b=0} n && /^    bash: \|/ {b=1;next} n && b {sub(/^      /, "");print}' \
  | sed 's/^SPEC=\$read-spec.output$/SPEC="$(cat "$SPEC_FILE")"/;s/^\$resolve-test-command.output$//' > "$T/node.sh"
core() { tr -d '\r' < "$YAML" | awk -v m="$1" 'index($0,"BEGIN " m " core") {n=1;next} index($0,"END " m " core") {n=0} n {sub(/^      /,"");print}'; }
eval "$(core mec)"
eval "$(core sme)"
mkdir -p "$T/wt"
git init -q "$T/wt"
cat > "$T/wt/a.test.js" <<'JS'
import fs from 'node:fs';
fs.appendFileSync('calls', process.argv.includes('--postgres') ? 'db\n' : 'static\n');
console.log('Tests: 1/1');
JS
printf 'WO Class: CODE\n## Test scenarios\nWhen: `node a.test.js; node a.test.js --postgres`\n' > "$T/spec"
export SPEC_FILE="$T/spec"
run() { mkdir -p "$T/art-$1"; (cd "$T/wt"; ARTIFACTS_DIR="$T/art-$1" bash "$T/node.sh") 2>"$T/err-$1"; }
unset BDC_BUILDER_POSTGRES
run absent > "$T/absent"
grep -qx 'static' "$T/wt/calls"
test "$(wc -l < "$T/wt/calls")" -eq 1
grep -qx 'TESTS_PASSED=1' "$T/absent"
grep -qx 'TESTS_TOTAL=1' "$T/absent"
grep -qx 'TESTS_STATUS=env_unavailable' "$T/absent"
grep -qx 'TESTS_ENV_REASON=postgres capability absent in this lane' "$T/absent"
echo 'PASS: missing capability skips only the postgres segment and preserves 1/1'
: > "$T/wt/calls"
BDC_BUILDER_POSTGRES=1 run present > "$T/present"
test "$(cat "$T/wt/calls")" = "$(printf 'static\ndb')"
grep -qx 'TESTS_STATUS=passed' "$T/present"
grep -qx 'TESTS_TOTAL=2' "$T/present"
echo 'PASS: enabled capability executes both segments (2/2)'
for status in PROCEED BLOCKED; do
  rc=0
  printf 'Tests: 1/1 (static only)\nVALIDATION: PASS\n' | mec_check "$status" CODE env_unavailable 0 not_required 0 >"$T/mec" 2>&1 || rc=$?
  test "$rc" -eq 1
  grep -q 'ENVIRONMENT_UNAVAILABLE:' "$T/mec" || { echo 'FAIL: missing ENVIRONMENT_UNAVAILABLE sentinel'; exit 1; }
  ! grep -qx 'OK' "$T/mec"
done
printf 'Tests: 1/1\nVALIDATION: PASS\n' | sme_process '1/1 (static only)' env_unavailable none not_required > "$T/stamp"
grep -qx 'VALIDATION: FAIL' "$T/stamp" || { echo 'FAIL: env_unavailable stamp did not fail validation'; exit 1; }
echo 'PASS: environment evidence always fails closed and stamps VALIDATION: FAIL'
cat > "$T/wt/a.test.js" <<'JS'
console.log('Cannot find module pg; connection refused');
console.log('Tests: 0/1');
process.exitCode = 1;
JS
BDC_BUILDER_POSTGRES=1 run failure > "$T/failure"
grep -qx 'TESTS_STATUS=failed' "$T/failure"
! grep -q '^TESTS_ENV_REASON=' "$T/failure"
echo 'PASS: real assertion/service-looking output remains failed when capability is on'
