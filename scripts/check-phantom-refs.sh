#!/usr/bin/env bash
# check-phantom-refs.sh -- detect (and optionally delete) remote branch refs
# whose names contain a single-quote character (phantom/apostrophe refs).
#
# Usage:
#   bash scripts/check-phantom-refs.sh [OWNER/REPO]
#   bash scripts/check-phantom-refs.sh OWNER/REPO --cleanup
#   printf 'refs/heads/...\n' | bash scripts/check-phantom-refs.sh --stdin
#
# Default repo: bluedevilcollectibles/bdc-harness
#
# Exit 0 when no phantom refs are found.
# Exit 1 when one or more phantom refs are listed (or on usage/API error).
#
# Enumeration prefers `git ls-remote --heads` when a local clone of the
# target is available via origin; otherwise falls back to
# `gh api repos/<slug>/git/matching-refs/heads`.
#
# --stdin mode reads ref lines from stdin (one per line; accepts bare branch
# names or full refs/heads/* forms) and never touches a remote. Used by
# fixture tests so no real phantom refs need to be created. Bare names are
# preserved exactly in output (e.g. feat/x-thread-abc' lists as-is).
#
# --cleanup deletes each detected phantom ref via:
#   git push "https://github.com/<slug>.git" --delete "<branch>"
# Only refs containing a single-quote character are targeted.

set -euo pipefail

DEFAULT_REPO="bluedevilcollectibles/bdc-harness"
STDIN_MODE=0
CLEANUP_MODE=0
REPO=""

usage() {
  cat <<'EOF' >&2
Usage:
  bash scripts/check-phantom-refs.sh [OWNER/REPO]
  bash scripts/check-phantom-refs.sh OWNER/REPO --cleanup
  printf 'refs/heads/...\n' | bash scripts/check-phantom-refs.sh --stdin
EOF
}

for arg in "$@"; do
  case "$arg" in
    --stdin)
      STDIN_MODE=1
      ;;
    --cleanup)
      CLEANUP_MODE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: unknown flag: $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [ -n "$REPO" ]; then
        echo "ERROR: multiple repo arguments: $REPO and $arg" >&2
        usage
        exit 1
      fi
      REPO="$arg"
      ;;
  esac
done

if [ "$STDIN_MODE" -eq 1 ] && [ "$CLEANUP_MODE" -eq 1 ]; then
  echo "ERROR: --stdin and --cleanup are mutually exclusive" >&2
  exit 1
fi

if [ "$STDIN_MODE" -eq 1 ] && [ -n "$REPO" ]; then
  echo "ERROR: --stdin does not accept a repo argument" >&2
  exit 1
fi

if [ -z "$REPO" ]; then
  REPO="$DEFAULT_REPO"
fi

# Return 0 if the ref name (branch or full refs/heads/*) contains a single quote.
is_phantom() {
  case "$1" in
    *"'"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Normalize a ref line for display/filter.
# Accepts "refs/heads/foo", bare "foo", or "sha<TAB>refs/heads/foo".
# Bare branch names are preserved exactly so fixture Test 1 lists
# feat/x-thread-abc' as-is (not rewritten to refs/heads/...).
normalize_ref() {
  local line="$1"
  local ref

  # git ls-remote lines are "<sha><TAB>refs/heads/..."
  case "$line" in
    *$'\t'*)
      ref="${line#*$'\t'}"
      ;;
    *)
      ref="$line"
      ;;
  esac

  # Strip CR if present
  ref="${ref//$'\r'/}"

  if [ -z "$ref" ]; then
    return 0
  fi

  # Preserve input form: full refs stay full; bare names stay bare.
  printf '%s\n' "$ref"
}

# Branch name without refs/heads/ prefix (for git push --delete).
branch_name_of() {
  local ref="$1"
  case "$ref" in
    refs/heads/*) printf '%s\n' "${ref#refs/heads/}" ;;
    *)            printf '%s\n' "$ref" ;;
  esac
}

collect_phantoms_from_lines() {
  local line ref
  while IFS= read -r line || [ -n "$line" ]; do
    ref=$(normalize_ref "$line")
    [ -z "$ref" ] && continue
    if is_phantom "$ref"; then
      printf '%s\n' "$ref"
    fi
  done
}

enumerate_remote_refs() {
  local slug="$1"
  local out
  # Prefer gh api matching-refs (works without a local clone of the target).
  # Fall back to git ls-remote against the public HTTPS URL.
  # Both paths must surface failure: never return 0 after a failed enumeration
  # (that would falsely report the repository as clean).
  if command -v gh >/dev/null 2>&1; then
    if out=$(gh api "repos/${slug}/git/matching-refs/heads" --paginate \
        -q '.[].ref' 2>/dev/null); then
      printf '%s\n' "$out"
      return 0
    fi
  fi

  if command -v git >/dev/null 2>&1; then
    # Capture first so a failed ls-remote is not masked by awk/pipe success.
    if ! out=$(git ls-remote --heads "https://github.com/${slug}.git" 2>/dev/null); then
      echo "ERROR: git ls-remote failed for ${slug}" >&2
      return 1
    fi
    printf '%s\n' "$out" | awk -F'\t' '{print $2}'
    return 0
  fi

  echo "ERROR: neither gh nor git available to enumerate refs for ${slug}" >&2
  return 1
}

delete_phantom() {
  local slug="$1"
  local ref="$2"
  local branch
  branch=$(branch_name_of "$ref")

  echo "DELETE: ${slug} :: ${branch}"
  # Exact quoting required: branch may contain a trailing apostrophe.
  git push "https://github.com/${slug}.git" --delete "${branch}"
}

# --- main ---

PHANTOMS=""
if [ "$STDIN_MODE" -eq 1 ]; then
  PHANTOMS=$(collect_phantoms_from_lines)
else
  REFS=$(enumerate_remote_refs "$REPO") || {
    echo "ERROR: failed to enumerate heads for ${REPO}" >&2
    exit 1
  }
  PHANTOMS=$(printf '%s\n' "$REFS" | collect_phantoms_from_lines)
fi

# Drop empty lines
PHANTOMS=$(printf '%s\n' "$PHANTOMS" | sed '/^$/d' || true)

if [ -z "$PHANTOMS" ]; then
  exit 0
fi

# List offenders on stdout (one per line)
printf '%s\n' "$PHANTOMS"

if [ "$CLEANUP_MODE" -eq 1 ]; then
  if [ "$STDIN_MODE" -eq 1 ]; then
    echo "ERROR: refusing cleanup in --stdin mode" >&2
    exit 1
  fi
  FAIL=0
  while IFS= read -r ref || [ -n "$ref" ]; do
    [ -z "$ref" ] && continue
    if ! delete_phantom "$REPO" "$ref"; then
      echo "ERROR: failed to delete ${ref} from ${REPO}" >&2
      FAIL=1
    fi
  done <<EOF
$PHANTOMS
EOF
  if [ "$FAIL" -ne 0 ]; then
    exit 1
  fi
  # Re-enumerate to confirm clean
  REMAINING=$(enumerate_remote_refs "$REPO" | collect_phantoms_from_lines | sed '/^$/d' || true)
  if [ -n "$REMAINING" ]; then
    echo "ERROR: phantom refs remain after cleanup on ${REPO}:" >&2
    printf '%s\n' "$REMAINING" >&2
    exit 1
  fi
  echo "CLEAN: ${REPO} has zero phantom refs"
  exit 0
fi

# Detection-only mode: non-zero because phantoms exist
exit 1
