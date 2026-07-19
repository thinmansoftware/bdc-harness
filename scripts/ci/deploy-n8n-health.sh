#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/ci/n8n-health.js"
TARGET_DIR="${N8N_HEALTH_INSTALL_DIR:-/opt/bdc/ci}"
TARGET="$TARGET_DIR/n8n-health.js"

if [ ! -f "$SOURCE" ]; then
  echo "ERROR: missing source health checker: $SOURCE" >&2
  exit 1
fi

install -d -m 0755 "$TARGET_DIR"
install -m 0755 "$SOURCE" "$TARGET"

echo "N8N_HEALTH_DEPLOYED=$TARGET"
