#!/usr/bin/env bash
# WO #5217 round 2: bounded regressions only; safe for the operator desktop.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

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
saved_helper() {
  find "$ARTIFACTS_DIR/evidence/trusted-infra" -type f -name "$1" -print -quit 2>/dev/null | grep -q .
}
index_bytes() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
index = subprocess.check_output(['git', 'rev-parse', '--git-path', 'index'], cwd=root, text=True).strip()
print(hashlib.sha256((root/index).read_bytes()).hexdigest())
PY
}

# The two helpers are build-changed product files, so trg_check must allow the
# repair. Only recursively restoring trusted bytes can reject the fake pass.
for location in current stage; do
  for repair in fake product; do
    echo "Round 2 chain: $location/$repair"
    fixture "r2-chain-$location-$repair"
    printf 'base\n' > "$WT/product.txt"
    printf '. ./wrapper.js\n' > "$WT/check.sh"
    printf '. ./helper.js\n' > "$WT/wrapper.js"
    printf 'if grep -q good product.txt; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/helper.js"
    commit_fixture product.txt check.sh wrapper.js helper.js
    git -C "$WT" branch run-base
    printf 'bad build\n' > "$WT/product.txt"
    printf '# build changed wrapper\n' >> "$WT/wrapper.js"
    printf '# build changed helper\n' >> "$WT/helper.js"
    commit_fixture product.txt wrapper.js helper.js
    CURRENT="$WT"; TARGET="$WT"
    if [ "$location" = stage ]; then
      TARGET="$TMP/r2-linked-$repair"
      git -C "$CURRENT" worktree add --detach -q "$TARGET" HEAD
    fi
    prepare_evidence "chain-$location-$repair"
    export BASE_BRANCH=run-base
    if [ "$location" = stage ]; then
      export RST_STAGE_WORKTREES="s=$TARGET"
      printf 's\tthinmansoftware/other\tbash check.sh\trun-base\n' > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
    fi
    export FIX_INITIAL="$(cd "$WT" && rst_execute_saved "$ARTIFACTS_DIR/evidence" CODE)"
    check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
    check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    check saved_helper helper.js
    rst_save_core "$ARTIFACTS_DIR/evidence"
    if [ "$repair" = fake ]; then printf 'echo "Tests: 1/1"\n' > "$TARGET/helper.js"
    else printf 'good repair\n' > "$TARGET/product.txt"; fi
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
    before="$(index_bytes "$TARGET")"
    status="$(git -C "$TARGET" status --porcelain=v1)"
    out="$(run_node run-stop-tests-final)"
    if [ "$repair" = fake ]; then
      check contains "$out" 'TESTS_STATUS=blocked'
      check rejects contains "$out" 'TESTS_STATUS=passed'
      check contains "$out" '0/1'
      check contains "$(cat "$TARGET/helper.js")" 'Tests: 1/1'
    else
      check contains "$out" 'TESTS_STATUS=passed'
      check contains "$out" '1/1'
      check contains "$(cat "$TARGET/product.txt")" 'good repair'
    fi
    check contains "$out" 'TESTS_FINAL_INFRA=trusted'
    check test "$before" = "$(index_bytes "$TARGET")"
    check test "$status" = "$(git -C "$TARGET" status --porcelain=v1)"
    unset RST_STAGE_WORKTREES BASE_BRANCH
  done
done

# These all name existing helpers. Missing recursion, imports or relative-token
# support leaves helper.js out of the snapshot. The helper cycle must terminate.
for form in source dot bash sh node bun python direct require import js_nested py_from py_import py_dotted py_package token token_bare cycle infra infra_root; do
  echo "Round 2 discovery: $form"
  fixture "r2-discovery-$form"
  prepare_evidence "discovery-$form"
  printf 'node wrapper.js\n' > "$WT/check.sh"
  printf '# leaf\n' > "$WT/helper.js"
  case "$form" in
    source) printf 'source ./helper.js\n' > "$WT/wrapper.js" ;;
    dot) printf '. ./helper.js\n' > "$WT/wrapper.js" ;;
    bash|sh|node|bun|python) printf '%s ./helper.js\n' "$form" > "$WT/wrapper.js" ;;
    direct) printf './helper.js\n' > "$WT/wrapper.js" ;;
    require) printf "const leaf = require('./helper.js');\n" > "$WT/wrapper.js" ;;
    import) printf "import leaf from './helper.js';\n" > "$WT/wrapper.js" ;;
    js_nested)
      mkdir -p "$WT/lib"
      printf 'node lib/wrapper.js\n' > "$WT/check.sh"
      printf "require('./helper');\n" > "$WT/lib/wrapper.js"
      printf '# leaf\n' > "$WT/lib/helper.js" ;;
    py_from|py_import)
      printf 'python wrapper.py\n' > "$WT/check.sh"
      printf '# leaf\n' > "$WT/helper.py"
      if [ "$form" = py_from ]; then printf 'from helper import leaf\n' > "$WT/wrapper.py"
      else printf 'import helper\n' > "$WT/wrapper.py"; fi ;;
    py_dotted)
      mkdir -p "$WT/pkg"
      printf 'python wrapper.py\n' > "$WT/check.sh"
      printf 'import pkg.helper\n' > "$WT/wrapper.py"
      printf '# leaf\n' > "$WT/pkg/helper.py" ;;
    py_package)
      mkdir -p "$WT/pkg"
      printf 'python wrapper.py\n' > "$WT/check.sh"
      printf 'import pkg.module\n' > "$WT/wrapper.py"
      printf 'from . import helper\n' > "$WT/pkg/__init__.py"
      printf '# module\n' > "$WT/pkg/module.py"
      printf '# leaf\n' > "$WT/pkg/helper.py" ;;
    token) printf 'runner --helper ./helper.js\n' > "$WT/wrapper.js" ;;
    token_bare) printf 'runner --helper helper.js\n' > "$WT/wrapper.js" ;;
    cycle) printf '. ./helper.js\n' > "$WT/wrapper.js"; printf '. ./wrapper.js\n' > "$WT/helper.js" ;;
    infra|infra_root)
      # Discovery must also start from saved infrastructure, not just entries.
      printf 'echo "Tests: 1/1"\n' > "$WT/check.sh"
      mkdir -p "$WT/scripts"
      printf 'node ../wrapper.js\n' > "$WT/scripts/runner.sh"
      if [ "$form" = infra_root ]; then printf 'node wrapper.js\n' > "$WT/scripts/runner.sh"; fi
      printf "require('./helper.js');\n" > "$WT/wrapper.js" ;;
  esac
  check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  if [[ "$form" = py_* ]]; then check saved_helper helper.py
  else check saved_helper helper.js; fi
done

# A script-looking computed reference is a guard boundary, never an invitation
# to execute repair-modified bytes. Check blocking after an attempted repair.
dynamic_case=0
for expression in 'node "$HELPER"' 'source "${DIR}/helper.js"' 'node "$(cat helper-path).js"' 'require("./" + name + ".js");' 'import(name + ".js");' './$DIR/helper.js'; do
  echo "Round 2 dynamic: $expression"
  dynamic_case=$((dynamic_case+1))
  fixture "r2-dynamic-$dynamic_case"
  prepare_evidence "dynamic-$dynamic_case"
  printf '%s\n' "$expression" > "$WT/check.sh"
  printf 'TESTS_STATUS=failed\nTESTS_LINE=0/1\n' > "$ARTIFACTS_DIR/evidence/stop-tests.initial"
  diagnostic="$(trg_snapshot_report "$WT" "$ARTIFACTS_DIR/evidence" 2>&1)"
  export FIX_INITIAL="$(cat "$ARTIFACTS_DIR/evidence/stop-tests.initial")"
  rst_save_core "$ARTIFACTS_DIR/evidence"
  printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
  out="$(run_node run-stop-tests-final)"
  check contains "$out" 'TESTS_STATUS=blocked'
  check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
  check contains "$diagnostic" 'test guard: cannot resolve trusted helper: check.sh'
  check test -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
done

# The depth cap cannot silently trust an unexamined ninth hop.
fixture r2-depth
prepare_evidence depth
printf '. ./h1.js\n' > "$WT/check.sh"
for n in {1..9}; do printf '. ./h%s.js\n' "$((n+1))" > "$WT/h$n.js"; done
printf 'echo "Tests: 1/1"\n' > "$WT/h10.js"
printf 'TESTS_STATUS=failed\n' > "$ARTIFACTS_DIR/evidence/stop-tests.initial"
diagnostic="$(trg_snapshot_report "$WT" "$ARTIFACTS_DIR/evidence" 2>&1)"
export FIX_INITIAL="$(cat "$ARTIFACTS_DIR/evidence/stop-tests.initial")"
rst_save_core "$ARTIFACTS_DIR/evidence"
printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
out="$(run_node run-stop-tests-final)"
check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
check contains "$diagnostic" 'test guard: cannot resolve trusted helper: check.sh'

# Four tracked files, one staged product repair, and a Git-discovered test. An
# empty scratch index previously skipped the only case and fabricated 0/0.
for index_mode in normal split; do
fixture "r2-index-$index_mode"
prepare_evidence "index-$index_mode"
printf 'base\n' > "$WT/product.txt"
printf 'case\n' > "$WT/case.txt"
printf 'tracked\n' > "$WT/README.md"
cat > "$WT/check.sh" <<'SH'
count=$(git ls-files | wc -l | tr -d ' ')
cached=$(git diff --cached --name-only)
echo "TRACKED=$count"
if [ "$count" != 4 ] || [ -n "$cached" ]; then echo "Tests: 0/1"; exit 1; fi
ran=0
while IFS= read -r name; do
  [ "$name" != case.txt ] || ran=$((ran+1))
done < <(git ls-files)
if [ "$ran" = 1 ] && grep -q good product.txt; then echo "Tests: 1/1"
else echo "Tests: 0/1"; exit 1; fi
SH
commit_fixture product.txt case.txt README.md check.sh
git -C "$WT" branch run-base
printf 'bad build\n' > "$WT/product.txt"
commit_fixture product.txt
export BASE_BRANCH=run-base
check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
printf 'good repair\n' > "$WT/product.txt"
git -C "$WT" add product.txt
if [ "$index_mode" = split ]; then git -C "$WT" update-index --split-index; fi
before="$(index_bytes "$WT")"
out="$(cd "$WT" && trg_execute_trusted "$ARTIFACTS_DIR/evidence" CODE)"
check contains "$out" 'TESTS_STATUS=passed'
check contains "$out" 'TESTS_TOTAL=1'
check contains "$(cat "$ARTIFACTS_DIR/evidence/stop-tests.log")" 'TRACKED=4'
check test "$before" = "$(index_bytes "$WT")"
unset BASE_BRANCH
done
finish trusted-test-infra-r2
