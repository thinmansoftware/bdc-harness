#!/usr/bin/env bash
set -euo pipefail

dirty="$(git status --porcelain)" || exit $?
if [ -n "$dirty" ]; then
  printf 'refusing to build: dirty tree\n%s\n' "$dirty" >&2
  exit 3
fi

SHA="$(git rev-parse HEAD)" || exit $?
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'refusing to build: invalid HEAD %s\n' "$SHA" >&2
  exit 3
fi

export ARCHON_BUILD_SHA="$SHA"
docker compose build app

found=$(docker image inspect archon --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') || exit $?
if [ "$found" != "$SHA" ]; then
  printf 'revision label mismatch: expected %s found %s\n' "$SHA" "$found" >&2
  exit 4
fi

printf 'built archon revision=%s\n' "$SHA"
