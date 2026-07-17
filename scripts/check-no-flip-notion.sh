#!/usr/bin/env bash
# check-no-flip-notion.sh -- guard active reusable lanes against retired Notion tails
#
# Usage:
#   bash scripts/check-no-flip-notion.sh
#   bash scripts/check-no-flip-notion.sh .archon/workflows/defaults/
#   bash scripts/check-no-flip-notion.sh --check

set -euo pipefail

TARGET_DIR=".archon/workflows/defaults"
if [ "${1:-}" = "--check" ]; then
  shift
fi
if [ -n "${1:-}" ]; then
  TARGET_DIR="$1"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "ERROR: directory not found: $TARGET_DIR" >&2
  exit 1
fi

# Active reusable lanes covered by the GitHub-issue status pattern. This list
# intentionally excludes bdc-harness-wo-onramp.yaml and one-off WO archive YAMLs.
ACTIVE_LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-fable.yaml
  bdc-audit-claude.yaml
  bdc-bug-fix.yaml
  bdc-cleanup-sweep.yaml
  bdc-doctrine-update.yaml
  bdc-author-wo-batch.yaml
  bdc-multi-stage-development.yaml
  bdc-feature-development-grok.yaml
)

VIOLATIONS=""
for lane in "${ACTIVE_LANES[@]}"; do
  path="$TARGET_DIR/$lane"
  if [ ! -f "$path" ]; then
    VIOLATIONS="${VIOLATIONS}${path}: missing active lane file"$'\n'
    continue
  fi
  matches=$(grep -nH 'flip-notion' "$path" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    VIOLATIONS="${VIOLATIONS}${matches}"$'\n'
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "FAIL: retired flip-notion tail found in active reusable lane YAML:"
  printf '%s' "$VIOLATIONS"
  echo ""
  echo "Use review-issue / blocked-issue GitHub issue status nodes instead."
  exit 1
fi

echo "PASS: active reusable lane YAMLs contain no flip-notion references."
