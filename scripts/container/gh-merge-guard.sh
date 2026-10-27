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
# Review verbs are denied the same way (builders build, the reviewer reviews):
# `gh pr review` in any flag order, including --approve, REST POST/PUT to
# pulls/*/reviews (including field flags), and GraphQL addPullRequestReview
# or submitPullRequestReview. Reading reviews stays allowed. `gh pr create`
# is not blocked here.
#
# Escape hatches for a human operator debugging inside the container:
#   ARCHON_ALLOW_PR_MERGE=1 gh pr merge ...
#     bypasses the entire shim (merge and review rules).
#   ARCHON_ALLOW_PR_REVIEW=1 gh pr review --approve ...
#     bypasses review rules only; merge rules still apply.
# Neither escape env is set anywhere in workflow lanes or provider spawns.
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

# Review submission is denied unless ARCHON_ALLOW_PR_REVIEW=1. The merge denial
# above still wins when that hatch is set. Command and subcommand are the first
# two positional tokens. Value-taking flags consume the next token so
# `gh pr -R o/r review` is still `pr review`, and `gh pr view --json reviews`
# is not a review subcommand. PATCH is not a write signal here.
REVIEW_BLOCK=0
REVIEWS_PATH=0
REVIEW_WRITE=0
REVIEW_CMD=""
REVIEW_SUB=""
REVIEW_ARGS=("$@")
REVIEW_INDEX=0
while [ "$REVIEW_INDEX" -lt "${#REVIEW_ARGS[@]}" ]; do
  REVIEW_ARG="${REVIEW_ARGS[$REVIEW_INDEX]}"
  case "$REVIEW_ARG" in
    *addPullRequestReview*|*submitPullRequestReview*)
      REVIEW_BLOCK=1
      ;;
  esac
  case "$REVIEW_ARG" in
    *pulls/*/reviews*)
      REVIEWS_PATH=1
      ;;
  esac

  case "$REVIEW_ARG" in
    --method=POST|--method=PUT|--method=post|--method=put|-XPOST|-XPUT|-Xpost|-Xput)
      REVIEW_WRITE=1
      REVIEW_INDEX=$((REVIEW_INDEX + 1))
      continue
      ;;
    --field=*|--raw-field=*|--input=*|-f=*|-F=*)
      REVIEW_WRITE=1
      REVIEW_INDEX=$((REVIEW_INDEX + 1))
      continue
      ;;
    -R|--repo|--hostname|--json|--jq|--template|-X|--method|-f|-F|--field|--raw-field|--input|-b|--body|-t|--title|--head|--base)
      REVIEW_NEXT_INDEX=$((REVIEW_INDEX + 1))
      REVIEW_NEXT=""
      if [ "$REVIEW_NEXT_INDEX" -lt "${#REVIEW_ARGS[@]}" ]; then
        REVIEW_NEXT="${REVIEW_ARGS[$REVIEW_NEXT_INDEX]}"
        case "$REVIEW_NEXT" in
          *addPullRequestReview*|*submitPullRequestReview*)
            REVIEW_BLOCK=1
            ;;
        esac
        case "$REVIEW_NEXT" in
          *pulls/*/reviews*)
            REVIEWS_PATH=1
            ;;
        esac
      fi
      case "$REVIEW_ARG" in
        -X|--method)
          case "$REVIEW_NEXT" in
            POST|PUT|post|put)
              REVIEW_WRITE=1
              ;;
          esac
          ;;
        -f|-F|--field|--raw-field|--input)
          REVIEW_WRITE=1
          ;;
      esac
      REVIEW_INDEX=$((REVIEW_INDEX + 2))
      continue
      ;;
    -*)
      REVIEW_INDEX=$((REVIEW_INDEX + 1))
      continue
      ;;
  esac

  if [ -z "$REVIEW_CMD" ]; then
    REVIEW_CMD="$REVIEW_ARG"
  elif [ -z "$REVIEW_SUB" ]; then
    REVIEW_SUB="$REVIEW_ARG"
  fi
  REVIEW_INDEX=$((REVIEW_INDEX + 1))
done

if [ "$REVIEW_CMD" = "pr" ] && [ "$REVIEW_SUB" = "review" ]; then
  REVIEW_BLOCK=1
fi
if [ "$REVIEWS_PATH" = "1" ] && [ "$REVIEW_WRITE" = "1" ]; then
  REVIEW_BLOCK=1
fi

if [ "$REVIEW_BLOCK" = "1" ] && [ "${ARCHON_ALLOW_PR_REVIEW:-0}" != "1" ]; then
  {
    echo "gh-merge-guard: BLOCKED."
    echo "Submitting PR reviews from inside the build container is forbidden (builders build, the reviewer reviews)."
    echo "Builders open PRs; the reviewer submits the review. Human operator override:"
    echo "  - set ARCHON_ALLOW_PR_REVIEW=1 explicitly"
    echo "Blocked argv: $*"
  } >&2
  exit 86
fi

if [ -n "${GITHUB_APP_ID:-}${GITHUB_APP_RUN_NODES_ID:-}${GITHUB_APP_TASKMASTER_ID:-}" ]; then
  exec bun /app/scripts/github-service-exec.ts "${ARCHON_GITHUB_SERVICE:-run_nodes}" "$REAL_GH" "$@"
fi
exec "$REAL_GH" "$@"
