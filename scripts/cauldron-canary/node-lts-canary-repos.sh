#!/usr/bin/env bash
# Derive the Node canary repo set for WO-HARNESS-BUILDER-NODE-CURRENT-LTS-01.
#
# A repo is a Node canary when its working_subdir holds a package.json on its base
# branch, OR its test_command names node, npm, npx or pnpm. The set comes from
# bdc-xo scripts/cauldron/cauldron-projects.json. The script prints the derived repos
# and the count, and exits 1 if the set differs from EXPECTED below (the 15 repos the
# WO's Section 2 table marks "yes"). A new Node repo therefore forces a deliberate edit
# here plus a canary run, instead of a silent gap.
#
# Usage:
#   node-lts-canary-repos.sh [--map FILE] [--ref SHA] [--package-json-repos FILE]
#     --map FILE                 use a local cauldron-projects.json (default: fetch from
#                                bdc-xo at --ref with gh)
#     --ref SHA                  bdc-xo ref to fetch (default: the WO's pinned commit)
#     --package-json-repos FILE  newline list of project names known to have a
#                                package.json; skips the gh probe (offline/test use)
# Needs: jq. Needs gh only when --map or --package-json-repos is not given.
set -euo pipefail

PINNED_REF="b3bfeef18b438dbb090ea585019134bdbc511016"
EXPECTED="bdc-crm bdc-harness bdc-shopify-app comicstoreos-provisioner comicstoreos-site fuelglass lspro-react ollama-librarian receiving-shipping-desk scout-service shopops shopops-comic-theme shopops-storefront t3code-bdc whats-that-tee-time"

map_file=""
ref="$PINNED_REF"
pkg_list=""
while [ $# -gt 0 ]; do
  case "$1" in
    --map) map_file="$2"; shift 2 ;;
    --ref) ref="$2"; shift 2 ;;
    --package-json-repos) pkg_list="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

if [ -z "$map_file" ]; then
  map_file="$scratch/cauldron-projects.json"
  gh api "repos/thinmansoftware/bdc-xo/contents/scripts/cauldron/cauldron-projects.json?ref=${ref}" \
    --jq '.content' | base64 -d > "$map_file"
fi

has_package_json() {
  local name="$1" repo="$2" subdir="$3" base="$4" path
  if [ -n "$pkg_list" ]; then
    grep -qxF "$name" "$pkg_list"
    return
  fi
  if [ "$subdir" = "." ] || [ -z "$subdir" ]; then path="package.json"; else path="${subdir}/package.json"; fi
  gh api "repos/${repo}/contents/${path}?ref=${base}" --silent >/dev/null 2>&1
}

derived=()
while IFS=$'\t' read -r name repo subdir base test_cmd; do
  node_repo=0
  if has_package_json "$name" "$repo" "$subdir" "$base"; then node_repo=1; fi
  if printf '%s' "$test_cmd" | grep -Eq '(^|[^[:alnum:]_-])(node|npm|npx|pnpm)([^[:alnum:]_-]|$)'; then node_repo=1; fi
  if [ "$node_repo" -eq 1 ]; then derived+=("$name"); fi
done < <(jq -r 'to_entries[] | [.key, .value.repo, (.value.working_subdir // "."), (.value.base_branch // "main"), (.value.test_command // "")] | @tsv' "$map_file")

derived_sorted="$(printf '%s\n' "${derived[@]}" | sort)"
expected_sorted="$(printf '%s\n' $EXPECTED | sort)"

printf '%s\n' "$derived_sorted"
echo "count=${#derived[@]}"

if [ "$derived_sorted" != "$expected_sorted" ]; then
  echo "FAIL: derived canary set differs from the 15-repo expected set" >&2
  diff <(printf '%s\n' "$expected_sorted") <(printf '%s\n' "$derived_sorted") >&2 || true
  exit 1
fi
if [ "${#derived[@]}" -ne 15 ]; then
  echo "FAIL: count is ${#derived[@]}, expected 15" >&2
  exit 1
fi
echo "node-lts-canary-repos: OK (15)"
