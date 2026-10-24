#!/usr/bin/env bash
set -euo pipefail

attempt="${1:?attempt number required}"
unique_branch="${UNIQUE_BRANCH:?UNIQUE_BRANCH required}"
artifacts_dir="${ARTIFACTS_DIR:?ARTIFACTS_DIR required}"
message="${COMMIT_MESSAGE:-feat: ${WO_ID:-work order} implementation}"
mkdir -p "$artifacts_dir"
printf '%s\n' "$attempt" > "$artifacts_dir/commit-hook-attempt.txt"
if [ "$attempt" = 1 ]; then
  rm -f "$artifacts_dir/commit-and-push.succeeded"
fi

staged_paths_file="$artifacts_dir/commit-hook-staged-paths.nul"
if [ "$attempt" = 1 ]; then
  {
    git diff --name-only -z
    git diff --cached --name-only -z
    git ls-files --others --exclude-standard -z
  } | LC_ALL=C sort -zu > "$staged_paths_file"
elif [ ! -f "$staged_paths_file" ]; then
  echo "ERROR: initial path record missing; refusing to stage unrelated retry files" >&2
  exit 1
fi
if [ -s "$staged_paths_file" ]; then
  git add --pathspec-from-file="$staged_paths_file" --pathspec-file-nul
fi
# A repair may stage additional paths itself. Check the entire index without
# resetting or discarding any of that work before committing the frozen scope.
index_paths_file="$artifacts_dir/commit-hook-index-paths.nul"
outside_paths_file="$artifacts_dir/commit-hook-outside-paths.nul"
git diff --cached --name-only -z | LC_ALL=C sort -zu > "$index_paths_file"
LC_ALL=C comm -z -23 "$index_paths_file" "$staged_paths_file" > "$outside_paths_file"
if [ -s "$outside_paths_file" ]; then
  echo "ERROR: staged paths outside initial repair scope; refusing commit" >&2
  exit 1
fi
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
printf '%s\n' "$local_head" > "$artifacts_dir/commit-and-push.succeeded"
echo "unique_branch=${unique_branch}"

# A leased repair push advanced the remote. Downstream retry consumers must
# use its new head for any bounded visibility re-push.
if [ -n "${REPAIR_TARGET_LEASE_SHA:-}" ]; then
  echo "REPAIR_TARGET_LEASE_SHA=${local_head}"
fi
