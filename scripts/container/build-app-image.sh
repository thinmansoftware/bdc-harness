#!/usr/bin/env bash
# Stamp archon-app-1 with the git HEAD being built and refuse a dirty tree.
# Rebuilds of the running image must go through this wrapper so ARCHON_BUILD_SHA
# is the commit that was actually baked, not "unknown".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "DIRTY" >&2
  exit 3
fi

export ARCHON_BUILD_SHA="$(git rev-parse HEAD)"
"${ARCHON_DOCKER_BIN:-docker}" compose build "$@" app
