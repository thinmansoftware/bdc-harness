#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"
eval "$(core sme)"
eval "$(core mec)"

# Amended Tests 2/13: every byte of an existing test is frozen, even without
# assertion syntax. Track both index entries and files not yet added to git.
for location in current stage; do
  for tracking in tracked untracked; do
    for change in truth whitespace newline binary; do
      fixture "freeze-$location-$tracking-$change"
      CURRENT="$WT"
      TARGET="$WT"
      if [ "$location" = stage ]; then
        fixture "freeze-target-$tracking-$change"
        TARGET="$WT"
        WT="$CURRENT"; export ARTIFACTS_DIR="$WT/artifacts"
        printf 'b\tthinmansoftware/other\tbash test_b.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
        export RST_STAGE_WORKTREES="b=$TARGET"
      fi
      printf 'assert False\n' > "$TARGET/test_frozen.py"
      if [ "$tracking" = tracked ]; then git -C "$TARGET" add test_frozen.py; fi
      trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      case "$change" in
        truth) printf 'assert True\n' > "$TARGET/test_frozen.py" ;;
        whitespace) printf 'assert  False\n' > "$TARGET/test_frozen.py" ;;
        newline) printf 'assert False\r\n' > "$TARGET/test_frozen.py" ;;
        binary) printf 'assert False\n\000' > "$TARGET/test_frozen.py" ;;
      esac
      check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      unset RST_STAGE_WORKTREES
    done
  done
done

# Round 7 forbids new tests; markers are also forbidden in new product helpers.
for marker in 'test.skip(x)' 'it.only(x)' 'xit(x)' 'xdescribe(x)' 'it.todo' 'test.todo' '@pytest.mark.skip' 'unittest.skip'; do
  fixture "new-marker-$((PASS+FAIL))"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf '%s\n' "$marker" > "$WT/new-helper.ts"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
done
fixture new-test-forbidden
printf 'assert True\n' > "$WT/test_existing.py"
printf 'bad\n' > "$WT/product"
trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'good\n' > "$WT/product"
printf 'assert True\n' > "$WT/new.test.py"
check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"

# Test 18: real base/build commits, with a different stage target branch. Neither
# the run base nor a moved HEAD may widen the snapshot's stage allowlist.
build_fixture() {
  local base="$1"
  printf 'base\n' > "$WT/a.js"
  printf 'untouched\n' > "$WT/b.js"
  printf '{"scripts":{"test":"bash test_value.sh"}}\n' > "$WT/package.json"
  printf 'if grep -q good a.js; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/test_value.sh"
  printf '[test]\n' > "$WT/bunfig.toml"
  printf '{}\n' > "$WT/tsconfig.json"
  git -C "$WT" add a.js b.js package.json test_value.sh bunfig.toml tsconfig.json
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch "$base"
  printf 'bad build\n' > "$WT/a.js"
  printf '{"private":true,"scripts":{"test":"bash test_value.sh"}}\n' > "$WT/package.json"
  git -C "$WT" add a.js package.json
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
}
for location in current stage; do
  for change in package untouched delete untrack bunfig tsconfig new_test product helper; do
    echo "Test 18: $location/$change"
    fixture "allowlist-$location-$change"
    build_fixture run-base
    export BASE_BRANCH=run-base
    # npm defaults to cmd.exe on Windows; production uses POSIX shell quoting.
    export npm_config_script_shell=bash
    CURRENT="$WT"; TARGET="$WT"
    export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  npm test\nExpected: pass'
    if [ "$location" = stage ]; then
      fixture "allowlist-target-$change"
      build_fixture stage-base
      # The run branch exists here but has no build diff: using it would reject a.js.
      git -C "$WT" branch run-base
      TARGET="$WT"
      WT="$CURRENT"; export ARTIFACTS_DIR="$WT/artifacts"
      export RST_STAGE_WORKTREES="b=$TARGET"
      export FIX_SPEC=$'WO Class: CODE\n## Canonical stages\n```yaml\nstages:\n  - id: b\n    repo: thinmansoftware/other\n    target_branch: stage-base\n    in_scope_files: [src]\n    verify_commands: ["npm test"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n```'
    fi
    export FIX_MAP=''
    export FIX_INITIAL="$(run_node run-stop-tests)"
    check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    case "$change" in
      package)
        printf '{"scripts":{"test":"echo \\"Tests: 1/1\\""}}\n' > "$TARGET/package.json"
        check test "$(cd "$TARGET" && npm test | rst_parse_counts)" = '1 1'
        ;;
      untouched) printf 'repair\n' > "$TARGET/b.js" ;;
      delete) rm "$TARGET/b.js" ;;
      untrack) git -C "$TARGET" rm --cached -q b.js; printf 'repair\n' > "$TARGET/b.js" ;;
      bunfig) printf '[test]\nroot = "elsewhere"\n' > "$TARGET/bunfig.toml" ;;
      tsconfig) printf '{"exclude":["tests"]}\n' > "$TARGET/tsconfig.json" ;;
      new_test) printf 'assert True\n' > "$TARGET/new.test.py" ;;
      product) printf 'good\n' > "$TARGET/a.js" ;;
      helper) printf 'export const helper = 1;\n' > "$TARGET/helper.js"; printf 'good\n' > "$TARGET/a.js" ;;
    esac
    if [ "$change" = product ] || [ "$change" = helper ]; then
      check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    else
      check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    fi
    run_node test-repair until_bash >/dev/null
    out="$(run_node run-stop-tests-final)"
    if [ "$change" = product ] || [ "$change" = helper ]; then
      check contains "$out" 'TESTS_STATUS=passed'
      check contains "$out" 'TESTS_REPAIR_RESULT=repaired'
    else
      check contains "$out" 'TESTS_STATUS=blocked'
      check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
      check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
    fi
    unset RST_STAGE_WORKTREES BASE_BRANCH npm_config_script_shell
  done
done

# Always-frozen names at depth, even when the build changed them. Exercise both
# tracked edits and new untracked additions without relying on marker syntax.
for name in package.json bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock bunfig.toml jest.config.js vitest.config.ts vitest.workspace.ts playwright.config.js pytest.ini conftest.py pyproject.toml setup.cfg tox.ini Makefile tsconfig.build.json .github/workflows/check.yaml test_value.py src/value.test.ts; do
  fixture "frozen-name-$PASS"
  mkdir -p "$WT/packages/x/$(dirname "$name")"
  path="packages/x/$name"
  printf 'base\n' > "$WT/$path"
  git -C "$WT" add "$path"
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch run-base
  printf 'build\n' > "$WT/$path"
  git -C "$WT" add "$path"
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
  export BASE_BRANCH=run-base
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'repair\n' > "$WT/$path"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'build\n' > "$WT/$path"
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  mkdir -p "$WT/new/$(dirname "$path")"
  printf 'new\n' > "$WT/new/$path"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  unset BASE_BRANCH
done

# Unresolved bases freeze all tracked product code; helper additions still pass.
for base in missing-base unrelated-base; do
  fixture "unresolved-$base"
  build_fixture run-base
  if [ "$base" = unrelated-base ]; then
    empty_tree="$(git -C "$WT" hash-object -t tree /dev/null)"
    orphan="$(printf 'orphan\n' | git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit-tree "$empty_tree")"
    git -C "$WT" branch "$base" "$orphan"
  fi
  export BASE_BRANCH="$base"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'helper\n' > "$WT/helper.js"
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'good\n' > "$WT/a.js"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  unset BASE_BRANCH
done

# The allowed set is fixed at snapshot time, even if the repair commits b.js.
fixture snapshot-scope
build_fixture run-base
export BASE_BRANCH=run-base
trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'repair\n' > "$WT/b.js"
git -C "$WT" add b.js
git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm repair
check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
unset BASE_BRANCH

# Test 16: declared scripts are frozen even when their names do not match the
# test-file rule. Reproduce the Overseer's passing-summary rewrite verbatim.
for location in current stage; do
  for change in rewrite delete product; do
    fixture "declared-$location-$change"
    CURRENT="$WT"
    TARGET="$WT"
    if [ "$location" = stage ]; then
      fixture "declared-target-$change"
      TARGET="$WT"
      WT="$CURRENT"; export ARTIFACTS_DIR="$WT/artifacts"
      export RST_STAGE_WORKTREES="b=$TARGET"
      export FIX_SPEC=$'WO Class: CODE\n## Canonical stages\n```yaml\nstages:\n  - id: b\n    repo: thinmansoftware/other\n    target_branch: staging\n    in_scope_files: [src]\n    verify_commands: ["bash check.sh"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n```'
    else
      export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
    fi
    printf 'bad\n' > "$TARGET/product"
    printf 'if grep -q good product; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$TARGET/check.sh"
    export FIX_MAP=''
    export FIX_INITIAL="$(run_node run-stop-tests)"
    check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
    check contains "$(cat "$ARTIFACTS_DIR/evidence/stop-tests.commands")" 'bash check.sh'
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    case "$change" in
      rewrite) printf 'echo "Tests: 1/1"\n' > "$TARGET/check.sh" ;;
      delete) rm "$TARGET/check.sh" ;;
      product) printf 'good\n' > "$TARGET/product" ;;
    esac
    if [ "$change" = product ]; then
      check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    else
      check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    fi
    run_node test-repair until_bash >/dev/null
    out="$(run_node run-stop-tests-final)"
    if [ "$change" = product ]; then
      check contains "$out" 'TESTS_STATUS=passed'
      check contains "$out" 'TESTS_REPAIR_RESULT=repaired'
    else
      check contains "$out" 'TESTS_STATUS=blocked'
      check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
      check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
    fi
    unset RST_STAGE_WORKTREES
  done
done

# Command tokens are relative to the command's cwd, including a leading cd.
# Existing ignored files are included; directories, flags, interpreters and paths
# escaping the worktree (including symlinks) are excluded.
fixture declared-tokens
mkdir -p "$WT/sub dir"
printf 'check.sh\n' > "$WT/.gitignore"
for name in 'sub dir/check.sh' 'sub dir/helper.sh' check.sh bash; do
  printf 'old\n' > "$WT/$name"
done
printf 'old\n' > "$WT/-flag"
printf 'outside\n' > "$TMP/outside.sh"
ln -s "$TMP/outside.sh" "$WT/escape.sh"
printf '%s\n' "cd 'sub dir' && bash check.sh && bash helper.sh" 'bash check.sh -flag bash ../outside.sh escape.sh' > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
for name in 'sub dir/check.sh' 'sub dir/helper.sh' check.sh; do
  printf 'changed\n' > "$WT/$name"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'old\n' > "$WT/$name"
done
printf 'changed\n' > "$WT/bash"
printf 'changed\n' > "$WT/-flag"
printf 'changed\n' > "$TMP/outside.sh"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"

# A foreign stage's command must not freeze a same-named product file in the
# current worktree: resolve tokens only where that command actually runs.
fixture declared-scope-current
CURRENT="$WT"
printf 'old product\n' > "$WT/check.sh"
fixture declared-scope-stage
TARGET="$WT"
printf 'echo "Tests: 1/1"\n' > "$TARGET/check.sh"
WT="$CURRENT"; export ARTIFACTS_DIR="$WT/artifacts"
printf 'bash check.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
printf 'b\tthinmansoftware/other\tbash check.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
export RST_STAGE_WORKTREES="b=$TARGET"
trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'new product\n' > "$CURRENT/check.sh"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'old product\n' > "$CURRENT/check.sh"
printf 'echo "Tests: 2/2"\n' > "$TARGET/check.sh"
check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
unset RST_STAGE_WORKTREES

# Test 14: drive a value-only guard violation through all four real consumers.
fixture guard-reason
printf 'bad\n' > "$WT/product"
printf 'true '\''assert False'\''\nif grep -q good product; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/test_reason.sh"
export FIX_SPEC=$'WO Class: CODE\nWO_ID=WO-TEST\nSPEC_PATH=bdc-xo:issues/123\nStop 1 (test suite):\n  bash test_reason.sh\nExpected: pass'
export FIX_MAP=''
export FIX_INITIAL="$(run_node run-stop-tests)"
printf 'good\n' > "$WT/product"
sed -i 's/assert False/assert True/' "$WT/test_reason.sh"
run_node test-repair until_bash >/dev/null
export FIX_FINAL="$(run_node run-stop-tests-final)"
check contains "$FIX_FINAL" 'TESTS_STATUS=blocked'
check contains "$FIX_FINAL" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
check contains "$FIX_FINAL" 'TESTS_REPAIR_RESULT=guard_violation'
stamped="$(printf 'Tests: placeholder\nGrep assertions: placeholder\nVALIDATION: PASS\n' | sme_process "$(sme_field TESTS_LINE "$FIX_FINAL")" "$(sme_field TESTS_STATUS "$FIX_FINAL")" N/A not_required 0 "$(sme_field TESTS_BLOCKED_REASON "$FIX_FINAL")")"
check contains "$(printf '%s\n' "$stamped" | grep '^Stop conditions:')" 'tests_failed_after_repair:guard'
check contains "$stamped" 'VALIDATION: FAIL'
printf '%s\n' "$stamped" | mec_check PROCEED CODE "$(mec_field TESTS_STATUS "$FIX_FINAL")" 0 not_required 0 0 0 0 0 '' "$(mec_field TESTS_BLOCKED_REASON "$FIX_FINAL")" > "$TMP/guard-mec-out" 2> "$TMP/guard-mec-err"
check test "$?" = 1
check contains "$(cat "$TMP/guard-mec-err")" 'TESTS_BLOCKED: tests_failed_after_repair:guard'
mkdir -p "$TMP/guard-bin"
cat > "$TMP/guard-bin/gh" <<'SH'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  if [ "$1" = --body-file ]; then cat "$2" > "$ARTIFACTS_DIR/guard-comment"; break; fi
  shift
done
SH
chmod +x "$TMP/guard-bin/gh"
PATH="$TMP/guard-bin:$PATH" run_node tests-blocked-report >/dev/null
check contains "$(cat "$ARTIFACTS_DIR/guard-comment" 2>/dev/null)" 'tests_failed_after_repair:guard'

fixture repaired
printf 'bad\n' > "$WT/product"
cat > "$WT/test_value.sh" <<'SH'
true 'expect(product).toBe(good)'
if grep -q good product; then echo 'Tests: 1/1'; else echo 'Tests: 0/1'; exit 1; fi
SH
export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash test_value.sh\nExpected: pass'
export FIX_MAP=''
export FIX_INITIAL="$(run_node run-stop-tests)"
check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
check test "$(cat "$ARTIFACTS_DIR/evidence/stop-tests.commands")" = 'bash test_value.sh'
export FIX_CLASSIFY="$(run_node classify-test-result)"
check contains "$FIX_CLASSIFY" '"repairable":"true"'
printf 'good\n' > "$WT/product"
run_node test-repair until_bash > "$TMP/attempt"
out="$(run_node run-stop-tests-final)"
check contains "$out" 'TESTS_STATUS=passed'
check contains "$out" 'TESTS_LINE=1/1 (bash test_value.sh)'
check contains "$out" 'TESTS_REPAIR_ATTEMPTS=1'
check contains "$out" 'TESTS_REPAIR_RESULT=repaired'

for change in delete_assert skip only todo delete_file untracked; do
  fixture "$change"
  printf 'expect(x).toBe(1)\nassert x\n' > "$WT/test_x.ts"
  if [ "$change" != untracked ]; then git -C "$WT" add test_x.ts; fi
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  case "$change" in
    delete_assert|untracked) printf 'assert x\n' > "$WT/test_x.ts" ;;
    skip) printf 'expect(x).toBe(1)\nassert x\ntest.skip(x)\n' > "$WT/test_x.ts" ;;
    only) printf 'expect(x).toBe(1)\nassert x\nit.only(x)\n' > "$WT/test_x.ts" ;;
    todo) printf 'expect(x).toBe(1)\nassert x\ntest.todo(x)\n' > "$WT/test_x.ts" ;;
    delete_file) rm "$WT/test_x.ts" ;;
  esac
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
done

for token in assertTrue .toBeTruthy; do
  fixture "$token"
  printf '%s(x)\n' "$token" > "$WT/test_token.ts"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'x\n' > "$WT/test_token.ts"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
done

# Commenting an assertion out is a removal, not a kept assertion (Overseer review of
# bdc-harness#1532 at 3a54e3b8: `assert False` -> `# assert False` passed the guard).
for form in py_hash ts_line ts_block; do
  fixture "commented-$form"
  case "$form" in
    py_hash) printf 'def test_x():\n    assert False\n' > "$WT/test_x.py" ;;
    ts_line|ts_block) printf 'it("x", () => {\n  expect(x).toBe(1)\n})\n' > "$WT/x.test.ts" ;;
  esac
  git -C "$WT" add -A
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  case "$form" in
    py_hash) printf 'def test_x():\n    # assert False\n    pass\n' > "$WT/test_x.py" ;;
    ts_line) printf 'it("x", () => {\n  // expect(x).toBe(1)\n})\n' > "$WT/x.test.ts" ;;
    ts_block) printf 'it("x", () => {\n  /* expect(x).toBe(1) */\n})\n' > "$WT/x.test.ts" ;;
  esac
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
done

# Guard violations terminate repair and can never become a final PASS.
for violation in delete_assert skip; do
  fixture "final-$violation"
  printf 'echo "Tests: 0/1"; exit 1\ntrue '\''expect(x).toBe(1)'\''\n' > "$WT/test_bad.sh"
  export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash test_bad.sh\nExpected: pass'
  export FIX_INITIAL="$(run_node run-stop-tests)"
  if [ "$violation" = delete_assert ]; then
    printf 'echo "Tests: 1/1"\n' > "$WT/test_bad.sh"
  else
    printf 'echo "Tests: 1/1"\ntrue '\''expect(x).toBe(1)'\''\ntrue '\''test.skip(x)'\''\n' > "$WT/test_bad.sh"
  fi
  run_node test-repair until_bash >/dev/null
  out="$(run_node run-stop-tests-final)"
  check contains "$out" 'TESTS_STATUS=blocked'
  check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
  check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
done

# The persisted stage plan can execute tests outside the current repository.
# Guard every such directory, including one that disappears after the snapshot.
for change in unchanged delete_assert skip comment delete_file missing_dir; do
  fixture "stage-a-$change"
  STAGE_A="$WT"
  printf 'expect(a).toBe(1)\n' > "$WT/test_a.ts"
  fixture "stage-b-$change"
  STAGE_B="$WT"
  printf 'expect(b).toBe(1)\nassert b\n' > "$WT/test_b.ts"
  git -C "$WT" add test_b.ts
  WT="$STAGE_A"; export ARTIFACTS_DIR="$WT/artifacts"
  printf 'a\tthinmansoftware/shopops\tbash test_a.sh\nb\tthinmansoftware/other\tbash test_b.sh\n' > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
  export RST_STAGE_WORKTREES="b=$STAGE_B"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  case "$change" in
    delete_assert) printf 'assert b\n' > "$STAGE_B/test_b.ts" ;;
    skip) printf 'expect(b).toBe(1)\nassert b\ntest.skip(b)\n' > "$STAGE_B/test_b.ts" ;;
    comment) printf '// expect(b).toBe(1)\nassert b\n' > "$STAGE_B/test_b.ts" ;;
    delete_file) rm "$STAGE_B/test_b.ts" ;;
    missing_dir) mv "$STAGE_B" "$STAGE_B-moved" ;;
  esac
  if [ "$change" = unchanged ]; then
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  else
    check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  fi
  unset RST_STAGE_WORKTREES
done

# A repair that makes both stage commands pass by deleting B's assertion is blocked.
fixture final-stage-a
STAGE_A="$WT"
printf 'echo "Tests: 1/1"\n' > "$WT/test_a.sh"
fixture final-stage-b
STAGE_B="$WT"
printf 'echo "Tests: 0/1"; exit 1\ntrue '\''expect(b).toBe(1)'\''\n' > "$WT/test_b.sh"
WT="$STAGE_A"; export ARTIFACTS_DIR="$WT/artifacts"
export RST_STAGE_WORKTREES="a=$STAGE_A;b=$STAGE_B"
export FIX_SPEC=$'WO Class: MIXED\n## Canonical stages\n```yaml\nstages:\n  - id: a\n    repo: thinmansoftware/shopops\n    target_branch: staging\n    in_scope_files: [src]\n    verify_commands: ["bash test_a.sh"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n  - id: b\n    repo: thinmansoftware/other\n    target_branch: staging\n    in_scope_files: [src]\n    verify_commands: ["bash test_b.sh"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n```'
export FIX_INITIAL="$(run_node run-stop-tests)"
check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
printf 'echo "Tests: 1/1"\n' > "$STAGE_B/test_b.sh"
run_node test-repair until_bash >/dev/null
out="$(run_node run-stop-tests-final)"
check contains "$out" 'TESTS_STATUS=blocked'
check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
unset RST_STAGE_WORKTREES

fixture exhausted
printf 'echo "Tests: 0/1"; exit 1\ntrue '\''expect(x).toBe(1)'\''\n' > "$WT/test_bad.sh"
export FIX_SPEC=$'WO Class: CODE\nWO_ID=WO-TEST\nSPEC_PATH=bdc-xo:issues/123\nStop 1 (test suite):\n  bash test_bad.sh\nExpected: pass'
export FIX_INITIAL="$(run_node run-stop-tests)"
export FIX_CLASSIFY="$(run_node classify-test-result)"
run_node test-repair until_bash >/dev/null
run_node test-repair until_bash >/dev/null
out="$(run_node run-stop-tests-final)"
check contains "$out" 'TESTS_REPAIR_ATTEMPTS=2'
check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:exhausted'
check test "$(grep -c '### run-stop-tests: bash test_bad.sh' "$ARTIFACTS_DIR/evidence/stop-tests.log")" = 4
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ARTIFACTS_DIR/gh.calls"
while [ $# -gt 0 ]; do
  if [ "$1" = --body-file ]; then cat "$2" > "$ARTIFACTS_DIR/comment"; break; fi
  shift
done
SH
chmod +x "$TMP/bin/gh"
export FIX_FINAL="$out"
PATH="$TMP/bin:$PATH" run_node tests-blocked-report >/dev/null
check contains "$(cat "$ARTIFACTS_DIR/comment" 2>/dev/null)" 'tests_failed_after_repair:exhausted'
check contains "$(cat "$ARTIFACTS_DIR/comment" 2>/dev/null)" 'Tests: 0/1'

fixture passthrough
export FIX_INITIAL=$'TESTS_STATUS=passed\nTESTS_LINE=1/1 (bash original.sh)'
out="$(run_node run-stop-tests-final)"
check test "$out" = "$(run_node run-stop-tests-final)"
check test "$out" = "$FIX_INITIAL"$'\nTESTS_REPAIR_ATTEMPTS=0\nRepair touched test infrastructure: none'
for lane in "$HERE"/../bdc-feature-development*.yaml "$HERE"/../bdc-evidence-replay.yaml; do
  check test -f "$lane"
  for name in rst trg; do
    check test "$(core "$name")" = "$(sed -n "/# ---- BEGIN $name core /,/# ---- END $name core /p" "$lane" | sed 's/^      //')"
  done
done
# Ignored paths are still untracked files: the always-frozen and marker rules
# apply there too. Existing ignored helpers must not hide newly added siblings.
for name in new.test.ts package.json helper.js marker.js; do
  fixture "ignored-new-$name"
  printf 'cache/\n' > "$WT/.gitignore"
  mkdir -p "$WT/cache"
  printf 'old helper\n' > "$WT/cache/existing.js"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'new helper\n' > "$WT/cache/$name"
  if [ "$name" = marker.js ]; then printf 'test.skip(x)\n' > "$WT/cache/$name"; fi
  if [ "$name" = helper.js ]; then
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  else
    check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  fi
done
# Round 8: use native symlinks (MSYS ln can silently copy on Windows).
link_file() {
  python3 - "$1" "$2" "$3" <<'PY'
import os, pathlib, sys
root, name, target = sys.argv[1:]
path = pathlib.Path(root)/name
if path.is_symlink() or path.exists(): path.unlink()
os.symlink(target, path)
assert path.is_symlink()
PY
}
r8_build() {
  mkdir -p "$WT/scripts"
  printf 'base\n' > "$WT/a.js"
  printf 'base helper\n' > "$WT/scripts/helper.sh"
  printf 'if grep -q good a.js; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/runner.sh"
  printf '{"scripts":{"test":"bash check.sh"}}\n' > "$WT/package.json"
  link_file "$WT" check.sh runner.sh
  git -C "$WT" add a.js scripts/helper.sh runner.sh check.sh package.json
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch run-base
  printf 'bad build\n' > "$WT/a.js"
  printf 'build helper\n' > "$WT/scripts/helper.sh"
  printf '# build changed runner\n' >> "$WT/runner.sh"
  git -C "$WT" add a.js scripts/helper.sh runner.sh
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
}

# Test 19: freeze resolved targets of declarations, package test entries and tests.
for location in current stage; do
  for change in target repoint delete outside broken product package test_file; do
    echo "Test 19: $location/$change"
    fixture "r8-$location-$change"
    r8_build
    CURRENT="$WT"; TARGET="$WT"
    export BASE_BRANCH=run-base FIX_MAP=''
    export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
    command='bash check.sh'
    if [ "$change" = package ]; then
      command='npm test'
      export npm_config_script_shell=bash
      export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  npm test\nExpected: pass'
    fi
    if [ "$location" = stage ]; then
      fixture "r8-target-$change"
      r8_build
      git -C "$WT" branch stage-base run-base
      TARGET="$WT"; WT="$CURRENT"; export ARTIFACTS_DIR="$WT/artifacts"
      export RST_STAGE_WORKTREES="b=$TARGET"
      export FIX_SPEC="$(printf 'WO Class: CODE\n## Canonical stages\n```yaml\nstages:\n  - id: b\n    repo: thinmansoftware/other\n    target_branch: stage-base\n    in_scope_files: [src]\n    verify_commands: ["%s"]\n    readiness_bar: {spec_complete: true, scope_complete: true, dependencies_ready: true, acceptance_defined: true}\n```' "$command")"
    fi
    case "$change" in
      outside)
        printf 'echo "Tests: 0/1"; exit 1\n' > "$TMP/outside.sh"
        link_file "$TARGET" check.sh "$TMP/outside.sh" ;;
      broken) link_file "$TARGET" check.sh absent.sh ;;
      test_file)
        rm "$TARGET/check.sh"
        printf 'bash runner.sh\n' > "$TARGET/check.sh"
        link_file "$TARGET" test_hidden.sh runner.sh ;;
    esac
    export FIX_INITIAL="$(run_node run-stop-tests)"
    if [ "$change" = outside ] || [ "$change" = broken ]; then
      check contains "$FIX_INITIAL" 'TESTS_STATUS=blocked'
      check contains "$FIX_INITIAL" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
      export FIX_CLASSIFY="$(run_node classify-test-result)"
      check contains "$FIX_CLASSIFY" '"repairable":"false"'
      check test ! -e "$ARTIFACTS_DIR/evidence/test-repair.attempts"
    else
      check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
      check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      case "$change" in
        target|package|test_file) printf 'echo "Tests: 1/1"\n' > "$TARGET/runner.sh" ;;
        repoint)
          printf 'echo "Tests: 1/1"\n' > "$TARGET/new-runner.sh"
          link_file "$TARGET" check.sh new-runner.sh ;;
        delete) rm "$TARGET/runner.sh" ;;
        product) printf 'good\n' > "$TARGET/a.js" ;;
      esac
      if [ "$change" = product ]; then
        check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      else
        check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
      fi
      run_node test-repair until_bash >/dev/null
      out="$(run_node run-stop-tests-final)"
      if [ "$change" = product ]; then
        check contains "$out" 'TESTS_STATUS=passed'
        check contains "$out" 'TESTS_REPAIR_RESULT=repaired'
      else
        check contains "$out" 'TESTS_STATUS=blocked'
        check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
        check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
      fi
    fi
    unset RST_STAGE_WORKTREES BASE_BRANCH npm_config_script_shell
  done
done

# Capture the real patch-pr-body node with both external commands stubbed.
r8_pr_body() {
  mkdir -p "$TMP/r8-bin"
  export R8_REAL_GIT="$(command -v git)"
  cat > "$TMP/r8-bin/git" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = fetch ]; then exit 0; fi
exec "$R8_REAL_GIT" "$@"
SH
  cat > "$TMP/r8-bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
  label\ create*) exit 0 ;;
  *--json\ baseRefName*) echo run-base ;;
  *--json\ body*) echo 'Fixture PR prose' ;;
  *--body-file*)
    while [ "$1" != --body-file ]; do shift; done
    cp "$2" "$ARTIFACTS_DIR/pr-body" ;;
  *) echo "unexpected gh: $*" >&2; exit 1 ;;
esac
SH
  chmod +x "$TMP/r8-bin/git" "$TMP/r8-bin/gh"
  git -C "$WT" update-ref refs/remotes/origin/run-base run-base
  python3 - "$LANE" "${1:-PROCEED}" > "$TMP/r8-pr-node.sh" <<'PY'
import os, re, shlex, sys, yaml
body = next(n for n in yaml.safe_load(open(sys.argv[1]))['nodes'] if n['id']=='patch-pr-body')['bash']
values = {'block-reclassify':'{"status":"PROCEED"}', 'open-pr-if-needed':'https://github.com/fixture/repo/pull/1', 'decide-push-target':'repo: fixture/repo', 'stamp-manifest-pr':'WO: WO-TEST\nTests: 1/1\nVALIDATION: PASS', 'read-spec':'', 'build-manifest':'', 'run-stop-tests-final':os.environ['FIX_FINAL']}
values['block-reclassify'] = '{"status":"'+sys.argv[2]+'"}'
body = re.sub(r'\$([a-z][a-z0-9-]*)\.output',lambda m:shlex.quote(values.get(m[1],'')),body)
print(body)
PY
  (cd "$WT" && PATH="$TMP/r8-bin:$PATH" bash "$TMP/r8-pr-node.sh")
}

# Tests 20/21: accepted helper residual is disclosed in both real output paths.
for change in helper product no_repair; do
  echo "Test 20/21: $change"
  fixture "r8-disclosure-$change"
  r8_build
  export BASE_BRANCH=run-base FIX_MAP=''
  # A frozen entrypoint may source a build-changed helper: do not trace it.
  rm "$WT/check.sh"
  printf '. scripts/helper.sh\nif grep -q good a.js; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/check.sh"
  printf 'true # build helper\n' > "$WT/scripts/helper.sh"
  if [ "$change" = no_repair ]; then printf 'good\n' > "$WT/a.js"; fi
  export FIX_SPEC=$'WO Class: CODE\nStop 1 (test suite):\n  bash check.sh\nExpected: pass'
  export FIX_INITIAL="$(run_node run-stop-tests)"
  if [ "$change" != no_repair ]; then
    check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
    printf 'good\n' > "$WT/a.js"
    if [ "$change" = helper ]; then printf 'true # repaired helper\n' > "$WT/scripts/helper.sh"; fi
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    run_node test-repair until_bash >/dev/null
  fi
  export FIX_FINAL="$(run_node run-stop-tests-final)"
  check contains "$FIX_FINAL" 'TESTS_STATUS=passed'
  check r8_pr_body
  body="$(cat "$ARTIFACTS_DIR/pr-body" 2>/dev/null)"
  for text in "$FIX_FINAL" "$body"; do
    if [ "$change" = helper ]; then
      check contains "$text" $'Repair touched test infrastructure\nscripts/helper.sh'
      check rejects contains "$text" $'\na.js\n'
    else
      check test "$(printf '%s\n' "$text" | grep -c '^Repair touched test infrastructure: none$')" = 1
      check rejects contains "$text" $'Repair touched test infrastructure\n'
    fi
  done
  if [ "$change" = helper ]; then
    check r8_pr_body BLOCKED
    check contains "$(cat "$ARTIFACTS_DIR/pr-body")" $'Repair touched test infrastructure\nscripts/helper.sh'
  fi
  unset BASE_BRANCH
done
# The governing boundary also includes symlinks in the always-frozen set and
# tracked paths outside the build allowlist. Neither is execution tracing.
for name in bunfig.toml frozen-alias.txt; do
  fixture "r8-frozen-alias-$name"
  printf 'base\n' > "$WT/a.js"
  link_file "$WT" "$name" a.js
  git -C "$WT" add a.js "$name"
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm base
  git -C "$WT" branch run-base
  printf 'build\n' > "$WT/a.js"
  git -C "$WT" add a.js
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm build
  export BASE_BRANCH=run-base
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf 'repair\n' > "$WT/a.js"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  unset BASE_BRANCH
done
finish test-repair-guard.sh
