#!/usr/bin/env bash
# Offline tests for node-lts-canary-repos.sh (no gh, no network). Needs jq.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/node-lts-canary-repos.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

expected="bdc-crm bdc-harness bdc-shopify-app comicstoreos-provisioner comicstoreos-site fuelglass lspro-react ollama-librarian receiving-shipping-desk scout-service shopops shopops-comic-theme shopops-storefront t3code-bdc whats-that-tee-time"
: > "$scratch/pkg.txt"

# Good map: 14 repos with a package.json, one (receiving-shipping-desk) with only a node
# test_command, plus three non-Node repos.
for n in $expected; do
  [ "$n" = "receiving-shipping-desk" ] || echo "$n" >> "$scratch/pkg.txt"
done
jq -n --arg names "$expected" '
  ($names | split(" ") | map({key: ., value: {repo: ("thinmansoftware/" + .), working_subdir: ".", base_branch: "main",
     test_command: (if . == "receiving-shipping-desk" then "python -m unittest -v test_desk && node --check app.js" else null end)}}) | from_entries)
  + {"bdc-xo": {repo: "thinmansoftware/bdc-xo", base_branch: "main", test_command: null},
     "model-tier-advisor": {repo: "thinmansoftware/model-tier-advisor", base_branch: "main", test_command: "pytest tests/"}}
' > "$scratch/good.json"

out="$(bash "$script" --map "$scratch/good.json" --package-json-repos "$scratch/pkg.txt" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "good map exits 0" || bad "good map exits 0 (rc=$rc)"
case "$out" in *"count=15"*) ok "good map prints count=15" ;; *) bad "good map prints count=15" ;; esac
case "$out" in *"bdc-xo"*|*"model-tier-advisor"*) bad "non-Node repos excluded" ;; *) ok "non-Node repos excluded" ;; esac

# Drift: a sixteenth Node repo appears -> script must fail.
jq '. + {"new-node-repo": {repo: "thinmansoftware/new-node-repo", base_branch: "main", test_command: "npm test"}}' "$scratch/good.json" > "$scratch/drift.json"
out="$(bash "$script" --map "$scratch/drift.json" --package-json-repos "$scratch/pkg.txt" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && ok "extra Node repo fails with exit 1" || bad "extra Node repo fails with exit 1 (rc=$rc)"
case "$out" in *"count=16"*) ok "drift prints count=16" ;; *) bad "drift prints count=16" ;; esac

# Missing repo -> fail.
jq 'del(.fuelglass)' "$scratch/good.json" > "$scratch/short.json"
bash "$script" --map "$scratch/short.json" --package-json-repos "$scratch/pkg.txt" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "missing repo fails with exit 1" || bad "missing repo fails with exit 1 (rc=$rc)"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
