#!/usr/bin/env bash
# Focused rescope-2 round-2 regressions; execute the real lane nodes and guard.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

directory_link() {
  python3 - "$1" "$2" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
os.symlink(sys.argv[2], path, target_is_directory=True)
assert path.is_symlink() and path.is_dir()
PY
}

# A dependency-directory link must not turn passing tests into BLOCKED. The
# actual build-changed workspace source remains repairable in both saved roots.
for location in current stage; do
  echo "Workspace dependency: $location"
  fixture "workspace-$location"
  CURRENT="$WT"
  if [ "$location" = stage ]; then fixture workspace-target; fi
  mkdir -p "$WT/packages/lib" "$WT/node_modules"
  printf 'node_modules/\n' > "$WT/.gitignore"
  printf 'base\n' > "$WT/packages/lib/value.js"
  printf 'if grep -q good packages/lib/value.js; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/check.sh"
  git -C "$WT" add .gitignore packages/lib/value.js check.sh
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch run-base
  printf 'good build\n' > "$WT/packages/lib/value.js"
  git -C "$WT" add packages/lib/value.js
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
  directory_link "$WT/node_modules/lib" ../packages/lib
  TARGET="$WT"; WT="$CURRENT"
  export ARTIFACTS_DIR="$WT/artifacts" BASE_BRANCH=run-base FIX_MAP=''
  export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
  if [ "$location" = stage ]; then
    export RST_STAGE_WORKTREES="b=$TARGET"
    export FIX_SPEC=$'WO Class: CODE\n## Canonical stages\n```yaml\nstages:\n  - id: b\n    repo: thinmansoftware/other\n    target_branch: run-base\n    in_scope_files: [packages]\n    verify_commands: ["bash check.sh"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n```'
  fi
  check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  export FIX_INITIAL="$(run_node run-stop-tests)"
  check contains "$FIX_INITIAL" 'TESTS_STATUS=passed'
  check rejects contains "$FIX_INITIAL" 'TESTS_STATUS=blocked'
  check contains "$(run_node run-stop-tests-final)" 'TESTS_STATUS=passed'
  printf 'good repair\n' > "$TARGET/packages/lib/value.js"
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  check test "$(trg_infrastructure "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json")" = 'Repair touched test infrastructure: none'
  unset RST_STAGE_WORKTREES BASE_BRANCH
done

# All named tree segments are excluded at any depth, even when they contain
# shell/test names or newly installed files bearing forbidden test markers.
fixture excluded-trees
for prefix in '' nested/; do
  for tree in node_modules .git .venv venv __pycache__ .bun .pnpm-store; do
    path="$prefix$tree"
    mkdir -p "$WT/$path/scripts"
    printf 'old\n' > "$WT/$path/scripts/check.sh"
  done
done
check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
for prefix in '' nested/; do
  for tree in node_modules .git .venv venv __pycache__ .bun .pnpm-store; do
    path="$prefix$tree"
    printf 'changed\n' > "$WT/$path/scripts/check.sh"
    printf 'test.skip(x)\n' > "$WT/$path/new.test.js"
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  done
done
check test "$(trg_infrastructure "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json")" = 'Repair touched test infrastructure: none'

# Exclusions also apply to tracked build-changed files, not just new installs.
fixture tracked-dependency
mkdir -p "$WT/nested/venv"
printf 'base\n' > "$WT/nested/venv/check.sh"
git -C "$WT" add nested/venv/check.sh
git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
git -C "$WT" branch run-base
printf 'build\n' > "$WT/nested/venv/check.sh"
git -C "$WT" add nested/venv/check.sh
git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
export BASE_BRANCH=run-base
check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'repair\n' > "$WT/nested/venv/check.sh"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
unset BASE_BRANCH

# An explicitly named dependency entrypoint is excluded too. Entrypoints
# outside those trees still freeze their real file through a directory link.
fixture declared-dependency
mkdir -p "$WT/node_modules/.bin"
printf 'echo "Tests: 1/1"\n' > "$WT/node_modules/.bin/check.sh"
printf 'bash node_modules/.bin/check.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'echo "Tests: 2/2"\n' > "$WT/node_modules/.bin/check.sh"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"

for command in 'node alias/check.js' 'npm test'; do
  fixture "directory-entry-$PASS"
  mkdir -p "$WT/packages/lib" "$WT/scripts/bin"
  chmod +x "$WT/scripts/bin"
  printf 'base\n' > "$WT/packages/lib/check.js"
  directory_link "$WT/alias" packages/lib
  directory_link "$WT/scripts/lib" ../packages/lib
  printf '{"scripts":{"test":"node alias/check.js"}}\n' > "$WT/package.json"
  git -C "$WT" add packages/lib/check.js package.json
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch run-base
  printf 'build\n' > "$WT/packages/lib/check.js"
  git -C "$WT" add packages/lib/check.js
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
  export BASE_BRANCH=run-base
  printf '%s\n' "$command" > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
  check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'forged pass\n' > "$WT/packages/lib/check.js"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  unset BASE_BRANCH
done

# A product directory link outside the worktree is not a test entrypoint.
# The same external directory used as scripts/ remains a boundary violation.
for name in product scripts; do
  fixture "outside-directory-$name"
  mkdir -p "$TMP/outside"
  directory_link "$WT/$name" "$TMP/outside"
  if [ "$name" = product ]; then
    check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  else
    check rejects trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  fi
done
finish test-guard-dependencies.sh
