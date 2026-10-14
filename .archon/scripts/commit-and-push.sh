#!/usr/bin/env bash
set -euo pipefail

attempt="${1:?attempt number required}"
unique_branch="${UNIQUE_BRANCH:?UNIQUE_BRANCH required}"
artifacts_dir="${ARTIFACTS_DIR:?ARTIFACTS_DIR required}"
message="${COMMIT_MESSAGE:-feat: ${WO_ID:-work order} implementation}"
mkdir -p "$artifacts_dir"
printf '%s\n' "$attempt" > "$artifacts_dir/commit-hook-attempt.txt"

git add -A
if ! git diff --cached --quiet; then
  hook_output="$artifacts_dir/commit-hook-output.txt"
  if ! git commit -m "$message" >"$hook_output" 2>&1; then
    cat "$hook_output" >&2
    exit 1
  fi
fi

push_ok=false
for push_attempt in 1 2 3; do
  if [ -n "${REPAIR_TARGET_LEASE_SHA:-}" ]; then
    if git push --force-with-lease="refs/heads/${unique_branch}:${REPAIR_TARGET_LEASE_SHA}" origin "HEAD:${unique_branch}"; then
      push_ok=true
      break
    fi
  elif git push origin "HEAD:${unique_branch}"; then
    push_ok=true
    break
  fi
  sleep $((push_attempt * 5))
done
[ "$push_ok" = true ] || { echo "ERROR: git push failed after 3 attempts" >&2; exit 1; }

remote_head="$(git ls-remote origin "refs/heads/${unique_branch}" | awk '{print $1}')"
local_head="$(git rev-parse HEAD)"
[ "$remote_head" = "$local_head" ] || {
  echo "FATAL: canonical branch ${unique_branch} not durably pushed" >&2
  exit 1
}
echo "VERIFIED: origin/${unique_branch} == local HEAD (${local_head})"
echo "unique_branch=${unique_branch}"
