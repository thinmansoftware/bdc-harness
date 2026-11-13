#!/usr/bin/env bash
# trusted-final-dprep.sh -- Test 4 of WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01.
#
# The final trusted test run builds a scratch copy of the worktree that skips node_modules and runs the
# saved test commands in it. Before this work order nothing installed dependencies there, so a repo whose
# tests need them (shopops-api) blocked with "trusted infrastructure unavailable". trg_execute_trusted now
# calls dprep_ensure_js_deps inside the scratch copy, and run-stop-tests-final sources the shared dprep.
#
# For each of the 13 bdc-feature-development lanes (and the evidence-replay lane, whose test nodes must stay
# byte-identical) the REAL rst and trg cores are extracted from the lane YAML, as trusted-test-infra-r2.sh
# does, and trg_execute_trusted runs against a real temporary git repo with a stub dprep_ensure_js_deps.
#
# Run: bash .archon/workflows/defaults/__tests__/trusted-final-dprep.sh
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
# build_fixture <name> <check.sh body>: a repo with a base branch and a build-changed product file.
build_fixture() {
  fixture "$1"
  prepare_evidence "$1"
  printf 'base\n' > "$WT/product.txt"
  mkdir -p "$WT/shopops-api"
  printf '{"name":"shopops-api"}\n' > "$WT/shopops-api/package.json"
  printf 'lock\n' > "$WT/shopops-api/package-lock.json"
  printf '%s\n' "$2" > "$WT/check.sh"
  commit_fixture product.txt check.sh shopops-api/package.json shopops-api/package-lock.json
  git -C "$WT" branch run-base
  printf 'bad build\n' > "$WT/product.txt"
  commit_fixture product.txt
  export BASE_BRANCH=run-base
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'good repair\n' > "$WT/product.txt"
  git -C "$WT" add product.txt
}

NEEDS_DEPS='if [ -d node_modules ] && [ -f dprep.marker ]; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi'
NEEDS_NOTHING='echo "Tests: 1/1"'

for LANE in "${LANES[@]}"; do
  L="$(basename "$LANE" .yaml | sed 's/^bdc-feature-development//; s/^-//')"
  [ -n "$L" ] || L=base
  echo "---- lane: $L"
  eval "$(core rst)"
  eval "$(core trg)"
  REC="$TMP/rec-$L"; : > "$REC"

  # The real function must be present in this lane's trg core and reference dprep after the cd into the copy.
  fn="$(declare -f trg_execute_trusted)"
  check contains "$fn" 'dprep_ensure_js_deps'
  cd_pos="$(printf '%s' "$fn" | grep -n 'scratch/current' | head -1 | cut -d: -f1)"
  dp_pos="$(printf '%s' "$fn" | grep -n 'dprep_ensure_js_deps' | head -1 | cut -d: -f1)"
  ex_pos="$(printf '%s' "$fn" | grep -n 'rst_execute_saved' | head -1 | cut -d: -f1)"
  check test "$cd_pos" -lt "$dp_pos"
  check test "$dp_pos" -lt "$ex_pos"

  # The final node sources the shared dprep script before it runs the trusted copy.
  final="$(node run-stop-tests-final bash)"
  src_pos="$(printf '%s' "$final" | grep -n '\. "\$DPREP_SCRIPT"' | head -1 | cut -d: -f1)"
  trg_pos="$(printf '%s' "$final" | grep -n '^trg_execute_trusted ' | head -1 | cut -d: -f1)"
  check test -n "$src_pos"
  check test "$src_pos" -lt "$trg_pos"

  # Dynamic: dprep runs once, inside the scratch copy (not the worktree), before the saved command.
  dprep_ensure_js_deps() { echo "$PWD" >> "$REC"; mkdir -p node_modules; echo ok > dprep.marker; }
  build_fixture "t4-$L" "$NEEDS_DEPS"
  out="$(cd "$WT" && trg_execute_trusted "$ARTIFACTS_DIR/evidence" CODE 2>/dev/null)"
  check contains "$out" 'TESTS_STATUS=passed'
  check test "$(grep -c . "$REC")" = 1
  recorded="$(head -1 "$REC")"
  check test -n "$recorded"
  check test "$recorded" != "$WT"
  check test "$recorded" != "$(cd "$WT" && pwd)"
  check rejects contains "$out" 'trusted infrastructure unavailable'
  unset BASE_BRANCH

  # No dprep function available (no script found): the trusted run still goes on without it.
  unset -f dprep_ensure_js_deps
  build_fixture "t4n-$L" "$NEEDS_NOTHING"
  out="$(cd "$WT" && trg_execute_trusted "$ARTIFACTS_DIR/evidence" CODE 2>/dev/null)"
  check contains "$out" 'TESTS_STATUS=passed'
  unset BASE_BRANCH
done

echo
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
