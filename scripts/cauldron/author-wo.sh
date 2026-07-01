#!/usr/bin/env bash
set -euo pipefail

# GitHub-native WO authoring helper.
# Step 4 intentionally uses `gh issue create` and preserves the legacy
# `--notion` flag consumed by the BDC operator wrapper.

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/cauldron/author-wo.sh --wo-id WO-EXAMPLE-01 --body-file /path/to/body.md [--notion PAGE_ID]

Required:
  --wo-id       Work Order ID. Used as the GitHub issue title.
  --body-file   Markdown body generated from the 12-section WO recipe.

Optional:
  --repo        GitHub repo for the WO queue. Defaults to bluedevilcollectibles/bdc-xo.
  --notion      Legacy Notion page ID retained for old operator flows.
USAGE
  exit 2
}

REPO="bluedevilcollectibles/bdc-xo"
WO_ID=""
BODY_FILE=""
NOTION_PAGE_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --wo-id)
      WO_ID="${2:-}"
      shift 2
      ;;
    --body-file)
      BODY_FILE="${2:-}"
      shift 2
      ;;
    --notion)
      NOTION_PAGE_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[ -n "$WO_ID" ] || usage
[ -n "$BODY_FILE" ] || usage
[ -f "$BODY_FILE" ] || { echo "Body file not found: $BODY_FILE" >&2; exit 1; }

NOTION_ARGS=()
if [ -n "$NOTION_PAGE_ID" ]; then
  NOTION_ARGS=(--notion "$NOTION_PAGE_ID")
fi

gh issue create \
  --repo "$REPO" \
  --title "$WO_ID" \
  --body-file "$BODY_FILE" \
  --label wo \
  --label needs-spec-review \
  "${NOTION_ARGS[@]}"
