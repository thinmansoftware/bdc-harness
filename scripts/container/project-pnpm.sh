#!/usr/bin/env bash
# Select the image-pinned pnpm 12.14.0 on Node 26 for projects that ask for it.
# Never downloads a package manager and never edits package.json.
set -euo pipefail

: "${PROJECT_PNPM_NODE:=/opt/node26/bin/node}"
: "${PROJECT_PNPM_BIN:=/opt/pnpm-12.14.0/pnpm}"

exec_pinned_pnpm() {
  local node_dir
  node_dir="$(dirname "$PROJECT_PNPM_NODE")"
  PATH="${node_dir}${PATH:+:$PATH}"
  export PATH
  exec "$PROJECT_PNPM_BIN" "$@"
}

search_dir="$PWD"
pkg_file=""
while true; do
  if [ -f "${search_dir}/package.json" ]; then
    pkg_file="${search_dir}/package.json"
    break
  fi
  if [ "$search_dir" = "/" ]; then
    break
  fi
  search_dir="$(dirname "$search_dir")"
done

if [ -z "$pkg_file" ]; then
  exec_pinned_pnpm "$@"
fi

manager="$(jq -r '.packageManager // empty' "$pkg_file")"

case "$manager" in
  ""|pnpm@12.14.0|pnpm@12.14.0+*)
    exec_pinned_pnpm "$@"
    ;;
  pnpm@*)
    pnpm_version="${manager#pnpm@}"
    pnpm_version="${pnpm_version%%+*}"
    printf 'project-pnpm: unsupported pnpm version %s (image provides 12.14.0)\n' "$pnpm_version" >&2
    exit 1
    ;;
  *)
    printf 'project-pnpm: unsupported packageManager %s (image provides pnpm@12.14.0)\n' "$manager" >&2
    exit 1
    ;;
esac
