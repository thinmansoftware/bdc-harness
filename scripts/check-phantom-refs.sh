#!/usr/bin/env bash

set -euo pipefail

filter_phantom_refs() {
  awk 'index($0, sprintf("%c", 39)) { print }'
}

enumerate_refs() {
  local repo_slug=$1

  if command -v gh >/dev/null 2>&1; then
    gh api "repos/${repo_slug}/git/matching-refs/heads" --paginate --jq '.[].ref' |
      sed 's|^refs/heads/||'
  else
    git ls-remote --heads "https://github.com/${repo_slug}.git" |
      awk '{ sub(/^refs\/heads\//, "", $2); print $2 }'
  fi
}

main() {
  local offenders

  if [[ ${1:-} == "--stdin" ]]; then
    if (( $# != 1 )); then
      printf 'usage: %s [repo-slug]\n       %s --stdin\n' "$0" "$0" >&2
      return 2
    fi
    offenders=$(filter_phantom_refs)
  else
    if (( $# > 1 )); then
      printf 'usage: %s [repo-slug]\n       %s --stdin\n' "$0" "$0" >&2
      return 2
    fi
    offenders=$(enumerate_refs "${1:-bluedevilcollectibles/bdc-harness}" | filter_phantom_refs)
  fi

  if [[ -n $offenders ]]; then
    printf '%s\n' "$offenders"
    return 1
  fi
}

main "$@"
