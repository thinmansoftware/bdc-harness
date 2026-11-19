#!/usr/bin/env bash
# trusted-copy-node-modules.sh -- Test 4 of WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01
# (as amended by Amendment 3).
#
# The final trusted test run copies the worktree (everything except .git and the artifacts folder, so
# node_modules IS copied) into a scratch folder and runs the saved test commands there. Dependencies are
# installed once, in prep, in the real worktree (scripts/lane/dprep.sh, package folders included). This suite
# pins the two halves of that design for the 13 bdc-feature-development lanes and bdc-evidence-replay:
#   - no install runs inside the trusted copy (install scripts could rewrite the already-restored trusted
#     test files, the Overseer finding on PR 1597): trg_execute_trusted and run-stop-tests-final carry no dprep;
#   - a package folder's node_modules present in the worktree is present in the trusted copy when the saved
#     commands run, and a worktree without it is not given one.
#
# The REAL rst and trg cores are extracted from the lane YAML, as trusted-test-infra-r2.sh does, and
# trg_execute_trusted runs against a real temporary git repo.
#
# Run: bash .archon/workflows/defaults/__tests__/trusted-copy-node-modules.sh
# Final line: "<n> passing / <n> total". Exits 0 on all-pass, 1 on any failure. ASCII only.

. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"

DEFAULTS="$HERE/.."
LANES=("$DEFAULTS"/bdc-feature-development*.yaml "$DEFAULTS"/bdc-evidence-replay.yaml)

commit_fixture() {
  git -C "$WT" add -- "$@"
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
}
prepare_evidence() {
  export ARTIFACTS_DIR="$TMP/evidence-$1"
  mkdir -p "$ARTIFACTS_DIR/evidence"
  printf 'bash check.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
  printf 'CODE\n' > "$ARTIFACTS_DIR/evidence/stop-tests.class"
  printf '20\n' > "$ARTIFACTS_DIR/evidence/stop-tests.timeout"
}
# build_fixture <name> <with_node_modules yes|no>: a repo with a base branch, a build-changed product file
# and a package folder; the saved test command passes only when the package folder has node_modules.
build_fixture() {
  fixture "$1"
  prepare_evidence "$1"
  printf 'base\n' > "$WT/product.txt"
  mkdir -p "$WT/shopops-api"
  printf '{"name":"shopops-api"}\n' > "$WT/shopops-api/package.json"
  printf 'lock\n' > "$WT/shopops-api/package-lock.json"
  printf '%s\n' 'if [ -f shopops-api/node_modules/.marker ]; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi' > "$WT/check.sh"
  commit_fixture product.txt check.sh shopops-api/package.json shopops-api/package-lock.json
  git -C "$WT" branch run-base
  printf 'bad build\n' > "$WT/product.txt"
  commit_fixture product.txt
  export BASE_BRANCH=run-base
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'good repair\n' > "$WT/product.txt"
  git -C "$WT" add product.txt
  if [ "$2" = yes ]; then
    mkdir -p "$WT/shopops-api/node_modules"
    printf 'ok\n' > "$WT/shopops-api/node_modules/.marker"
  fi
}

for LANE in "${LANES[@]}"; do
  L="$(basename "$LANE" .yaml | sed 's/^bdc-feature-development//; s/^-//')"
  [ -n "$L" ] || L=base
  echo "---- lane: $L"
  eval "$(core rst)"
  eval "$(core trg)"

  # No install in the trusted context: neither the trusted function nor the final node refers to dprep.
  fn="$(declare -f trg_execute_trusted)"
  check rejects contains "$fn" 'dprep'
  final="$(node run-stop-tests-final bash)"
  check rejects contains "$final" 'dprep'

  # Dynamic: node_modules in the worktree is in the trusted copy when the saved command runs.
  build_fixture "t4y-$L" yes
  out="$(cd "$WT" && trg_execute_trusted "$ARTIFACTS_DIR/evidence" CODE 2>/dev/null)"
  check contains "$out" 'TESTS_STATUS=passed'
  check rejects contains "$out" 'trusted infrastructure unavailable'
  unset BASE_BRANCH

  # Dynamic: no node_modules in the worktree -> none appears in the copy, the saved command fails honestly.
  build_fixture "t4n-$L" no
  out="$(cd "$WT" && trg_execute_trusted "$ARTIFACTS_DIR/evidence" CODE 2>/dev/null)"
  check rejects contains "$out" 'TESTS_STATUS=passed'
  unset BASE_BRANCH
done

echo
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
