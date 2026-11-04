#!/bin/sh
# Smoke test for the builder image's default Node (WO-HARNESS-BUILDER-NODE-CURRENT-LTS-01).
# Usage: node-lts-smoke.sh <expected-node-version, e.g. v26.13.0>
# Run inside the image as appuser (and as root) by the docker-build CI job and by XO
# after a rebuild: it prints each tool version and exits nonzero on any mismatch.
set -eu

expected="${1:?usage: node-lts-smoke.sh <expected node version, e.g. v26.13.0>}"
fail=0

check() {
  label="$1"
  shift
  if out="$("$@" 2>&1)"; then
    printf '%s: %s\n' "$label" "$out"
  else
    printf 'FAIL: %s exited nonzero: %s\n' "$label" "$out" >&2
    fail=1
  fi
}

node_path="$(command -v node || true)"
printf 'command -v node: %s\n' "$node_path"
if [ "$node_path" != "/opt/node26/bin/node" ]; then
  echo "FAIL: node resolves to '$node_path', expected /opt/node26/bin/node" >&2
  fail=1
fi

node_ver="$(node --version)"
printf 'node: %s\n' "$node_ver"
if [ "$node_ver" != "$expected" ]; then
  echo "FAIL: node is $node_ver, expected $expected" >&2
  fail=1
fi

check npm npm --version
check npx npx --version
check pnpm pnpm --version
check bun bun --version
check agent-browser agent-browser --version

if node -e 'require("node:sqlite"); console.log("sqlite ok")'; then
  :
else
  echo "FAIL: require(node:sqlite) failed" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "node-lts-smoke: OK"
