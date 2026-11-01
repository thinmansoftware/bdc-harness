#!/usr/bin/env bash
# Usage: gh-pr-files.sh <owner/repo> <pr-number>

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "PR_FILES_ERROR: expected <owner/repo> <pr-number>" >&2
  exit 2
fi

REPO="$1"
PR_NUMBER="$2"

if ! printf '%s\n' "$REPO" | grep -Eq '^[^/]+/[^/]+$'; then
  echo "PR_FILES_ERROR: repository must be owner/repo" >&2
  exit 2
fi

if ! printf '%s\n' "$PR_NUMBER" | grep -Eq '^[0-9]+$'; then
  echo "PR_FILES_ERROR: pull request number must be numeric" >&2
  exit 2
fi

if ! gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/files" --jq '.[].filename'; then
  echo "PR_FILES_ERROR: failed to list pull request files" >&2
  exit 1
fi
