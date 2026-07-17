#!/usr/bin/env bash
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

active_lanes=(
  ".archon/workflows/defaults/bdc-feature-development.yaml"
  ".archon/workflows/defaults/bdc-feature-development-codex.yaml"
  ".archon/workflows/defaults/bdc-feature-development-codex-only.yaml"
  ".archon/workflows/defaults/bdc-audit-claude.yaml"
  ".archon/workflows/defaults/bdc-bug-fix.yaml"
  ".archon/workflows/defaults/bdc-cleanup-sweep.yaml"
  ".archon/workflows/defaults/bdc-doctrine-update.yaml"
  ".archon/workflows/defaults/bdc-author-wo-batch.yaml"
  ".archon/workflows/defaults/bdc-multi-stage-development.yaml"
  ".archon/workflows/defaults/bdc-feature-development-grok.yaml"
)

missing=0
for lane in "${active_lanes[@]}"; do
  if [ ! -f "$lane" ]; then
    echo "check-no-flip-notion: missing active lane: $lane" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

if grep -n "flip-notion" "${active_lanes[@]}"; then
  echo "check-no-flip-notion: active reusable lanes must use review-issue/blocked-issue, not flip-notion." >&2
  exit 1
fi

echo "check-no-flip-notion: PASS"
