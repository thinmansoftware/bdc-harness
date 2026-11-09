#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"
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
