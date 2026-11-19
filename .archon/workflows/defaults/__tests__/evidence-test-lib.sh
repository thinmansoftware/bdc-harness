#!/usr/bin/env bash
# Shared fixture driver: extract real YAML, substitute outputs as the engine does.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
LANE="${P0B_TEST_LANE:-$HERE/../bdc-feature-development.yaml}"
PASS=0 FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export BDC_RSGARGV_SCRIPT="$ROOT/scripts/lane/rsg-argv.sh"
check() { if "$@"; then PASS=$((PASS+1)); echo "PASS: check $((PASS+FAIL)) ($1)"; else FAIL=$((FAIL+1)); echo "FAIL: check $((PASS+FAIL)) ($*)"; fi; }
contains() { [[ "$1" == *"$2"* ]]; }
core() { sed -n "/# ---- BEGIN $1 core /,/# ---- END $1 core /p" "$LANE" | sed 's/^      //'; }
node() {
  python3 - "$LANE" "$1" "${2:-bash}" <<'PY'
import os, shlex, sys, yaml
nodes = yaml.safe_load(open(sys.argv[1]))['nodes']
n = next((n for n in nodes if n['id'] == sys.argv[2]), {})
body = n.get('loop', {}).get('until_bash', '') if sys.argv[3] == 'until_bash' else n.get(sys.argv[3], '')
for name, var in [('read-spec','FIX_SPEC'), ('resolve-test-command','FIX_MAP'), ('run-stop-tests','FIX_INITIAL'), ('classify-test-result','FIX_CLASSIFY'), ('run-stop-tests-final','FIX_FINAL')]:
    body = body.replace('$'+name+'.output', shlex.quote(os.environ.get(var,'')))
if not body:
    print('echo missing-node >&2; exit 99')
else:
    print(body)
PY
}
fixture() {
  WT="$TMP/$1"; mkdir -p "$WT"; git -C "$WT" init -q
  git -C "$WT" remote add origin https://github.com/thinmansoftware/shopops.git
  export ARTIFACTS_DIR="$WT/artifacts"; mkdir -p "$ARTIFACTS_DIR/evidence"
}
run_node() { node "$1" "${2:-bash}" > "$TMP/node.sh"; (cd "$WT" && bash "$TMP/node.sh"); }
rejects() { "$@"; [ "$?" -ne 0 ]; }
finish() { echo "$1: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; }
