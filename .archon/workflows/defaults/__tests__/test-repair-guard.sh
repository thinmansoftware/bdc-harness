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

# New tests are allowed, but every forbidden marker is refused even in a new file.
for marker in 'test.skip(x)' 'it.only(x)' 'xit(x)' 'xdescribe(x)' 'it.todo' 'test.todo' '@pytest.mark.skip' 'unittest.skip'; do
  fixture "new-marker-$PASS"
  trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  printf '%s\n' "$marker" > "$WT/new.test.ts"
  check rejects trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
done
fixture new-test-allowed
printf 'assert True\n' > "$WT/test_existing.py"
printf 'bad\n' > "$WT/product"
trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'good\n' > "$WT/product"
printf 'assert True\n' > "$WT/new.test.py"
check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"

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
check test "$out" = "$FIX_INITIAL"$'\nTESTS_REPAIR_ATTEMPTS=0'
for lane in "$HERE"/../bdc-feature-development*.yaml "$HERE"/../bdc-evidence-replay.yaml; do
  check test -f "$lane"
  for name in rst trg; do
    check test "$(core "$name")" = "$(sed -n "/# ---- BEGIN $name core /,/# ---- END $name core /p" "$lane" | sed 's/^      //')"
  done
done
finish test-repair-guard.sh
