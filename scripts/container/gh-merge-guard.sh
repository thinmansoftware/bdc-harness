#!/usr/bin/env bash
# gh merge guard -- installed at /usr/local/bin/gh (ahead of /usr/bin/gh in PATH).
#
# bdc-xo#1491 (P0, 2026-08-10): a build-lane implement agent executed
# `gh pr merge --squash --auto` as a tool call and landed its own PR on dev
# with no review, no Overseer, no human. The shared org token carries merge
# rights, so nothing mechanical stopped it. This shim is the mechanical layer:
# builders inside the container may create PRs, view PRs, watch checks -- but
# MERGE VERBS ARE DENIED. The Overseer merge-steward is unaffected: it merges
# via octokit inside the server process and never shells out to gh.
#
# Escape hatch for a human operator debugging inside the container:
#   ARCHON_ALLOW_PR_MERGE=1 gh pr merge ...
# The escape env is NOT set anywhere in workflow lanes or provider spawns.
#
# GH_GUARD_REAL_GH exists for tests only (defaults to /usr/bin/gh).

set -u

REAL_GH="${GH_GUARD_REAL_GH:-/usr/bin/gh}"

if [ "${ARCHON_ALLOW_PR_MERGE:-0}" = "1" ]; then
  exec "$REAL_GH" "$@"
fi

BLOCK=0
for arg in "$@"; do
  case "$arg" in
    merge)
      # Exact token "merge": blocks `gh pr merge` in any flag order. A bare
      # `merge` token in any other gh invocation is rare enough to fail loud
      # on -- overblocking here costs a clear error; underblocking costs an
      # unreviewed merge to dev. Substrings (mergeable, merge-branch-x) do
      # NOT match this exact-token case.
      BLOCK=1
      ;;
    *pulls/*/merge*)
      # REST path form: gh api repos/<o>/<r>/pulls/<n>/merge [-X PUT]
      BLOCK=1
      ;;
    *mergePullRequest*|*enablePullRequestAutoMerge*)
      # GraphQL mutation form.
      BLOCK=1
      ;;
  esac
done

if [ "$BLOCK" = "1" ]; then
  {
    echo "gh-merge-guard: BLOCKED."
    echo "Merging PRs from inside the build container is forbidden (bdc-xo#1491)."
    echo "Builders open PRs; they never merge them. Review paths that may merge:"
    echo "  - Overseer merge-steward (octokit, in-process -- unaffected by this guard)"
    echo "  - A human operator (set ARCHON_ALLOW_PR_MERGE=1 explicitly to override)"
    echo "Blocked argv: $*"
  } >&2
  exit 86
fi

exec "$REAL_GH" "$@"
