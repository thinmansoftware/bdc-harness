#!/usr/bin/env bash
# WO #5217 rescope: no arguments run all cases; use <location> <scenario> to focus.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

if [ "$#" -eq 0 ]; then
  scenarios=(current/chain stage/chain current/product stage/product current/dynamic-product stage/dynamic-product current/dynamic-helper stage/dynamic-helper current/names current/absolute stage/absolute current/absolute-import stage/absolute-import current/absolute-package stage/absolute-package current/absolute-no-repair-failed stage/absolute-no-repair-failed current/absolute-no-repair-passed stage/absolute-no-repair-passed current/absolute-system stage/absolute-system current/absolute-external-import stage/absolute-external-import)
elif [ "$#" -eq 2 ]; then
  scenarios=("$1/$2")
else
  echo 'Specify current or stage and a scenario, or no arguments for all scenarios' >&2; exit 2
fi
for selection in "${scenarios[@]}"; do
location="${selection%%/*}"
scenario="${selection#*/}"
case "$location/$scenario" in
  current/chain|stage/chain|current/product|stage/product|current/dynamic-product|stage/dynamic-product|current/dynamic-helper|stage/dynamic-helper|current/names|current/absolute|stage/absolute|current/absolute-import|stage/absolute-import|current/absolute-package|stage/absolute-package|current/absolute-no-repair-failed|stage/absolute-no-repair-failed|current/absolute-no-repair-passed|stage/absolute-no-repair-passed|current/absolute-system|stage/absolute-system|current/absolute-external-import|stage/absolute-external-import) ;;
  *) echo 'Specify current or stage and a supported r3 scenario; or current names' >&2; exit 2 ;;
esac

commit_fixture() {
  git -C "$WT" add -- "$@"
  git -C "$WT" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
}
saved() {
  python3 - "$ARTIFACTS_DIR/evidence/test-guard.json" "$TARGET" "$1" <<'PY'
import json, pathlib, sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text())[str(pathlib.Path(sys.argv[2]).resolve())]
sys.exit(0 if sys.argv[3] in state['trusted'] else 1)
PY
}

if [[ "$scenario" = absolute* ]]; then
  fixture "r4-$location-$scenario"
  printf '{"type":"commonjs"}\n' > "$WT/package.json"
  CURRENT="$WT"; TARGET="$WT"
  if [ "$location" = stage ]; then TARGET="$TMP/r4-linked-$scenario"; fi
  absolute="$(python3 - "$TARGET/helper.js" <<'PY'
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve().as_posix())
PY
)"
  reference="$absolute"; entry=check.sh; command='bash check.sh'
  if [ "$scenario" = absolute-external-import ]; then
    reference="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve().as_posix())' "$TMP/external-helper.cjs")"
  fi
  if [ "$scenario" = absolute-system ]; then
    reference='./helper.js'; command='bash wrapper.sh'
    printf '/usr/bin/env bash check.sh\n' > "$WT/wrapper.sh"
  fi
  if [ "$scenario" = absolute-package ]; then
    entry=package.json; command='bun run test'
    python3 - "$WT/package.json" "$reference" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps(dict(type='commonjs', scripts=dict(test='node "'+sys.argv[2]+'"'))))
PY
  fi
  if [ "$scenario" = absolute-import ] || [ "$scenario" = absolute-external-import ] || [ "$scenario" = absolute-package ]; then
    if [ "$scenario" != absolute-package ]; then
      entry=check.js; command='node check.js'
      printf "require('%s');\n" "$reference" > "$WT/$entry"
    fi
    printf 'if (!require("fs").readFileSync("product.txt", "utf8").includes("good")) { console.log("Tests: 0/1"); process.exit(1); }\nconsole.log("Tests: 1/1");\n' > "$WT/helper.js"
    if [ "$scenario" = absolute-external-import ]; then cp "$WT/helper.js" "$TMP/external-helper.cjs"; fi
  else
    printf 'source "%s"\n' "$reference" > "$WT/$entry"
    printf 'if grep -q good product.txt; then echo "Tests: 1/1"; else echo "Tests: 0/1"; exit 1; fi\n' > "$WT/helper.js"
  fi
  printf 'base\n' > "$WT/product.txt"
  commit_fixture .
  git -C "$WT" branch run-base
  printf 'bad build\n' > "$WT/product.txt"
  if [ "$scenario" = absolute-no-repair-passed ]; then printf 'good build\n' > "$WT/product.txt"; fi
  printf '\n' >> "$WT/helper.js"
  commit_fixture .
  if [ "$location" = stage ]; then
    git -C "$WT" worktree add --detach -q "$TARGET" HEAD
    # Only the mapped stage uses an absolute reference. Keep the run checkout's
    # entry relative, so it cannot mask a stage bypass with a different error.
    if [ "$scenario" = absolute-package ]; then printf '{"type":"commonjs","scripts":{"test":"node helper.js"}}\n' > "$WT/$entry"
    elif [ "$scenario" = absolute-import ] || [ "$scenario" = absolute-external-import ]; then printf "require('./helper.js');\n" > "$WT/$entry"
    else printf 'source ./helper.js\n' > "$WT/$entry"; fi
  fi
  export BASE_BRANCH=run-base ARTIFACTS_DIR="$TMP/r4-evidence-$location-$scenario"
  mkdir -p "$ARTIFACTS_DIR/evidence"
  printf '%s\n' "$command" > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
  printf 'CODE\n' > "$ARTIFACTS_DIR/evidence/stop-tests.class"
  printf '20\n' > "$ARTIFACTS_DIR/evidence/stop-tests.timeout"
  if [ "$location" = stage ]; then
    export RST_STAGE_WORKTREES="s=$TARGET"
    printf 's\tthinmansoftware/other\t%s\trun-base\n' "$command" > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
  fi
  export FIX_INITIAL="$(cd "$WT" && rst_execute_saved "$ARTIFACTS_DIR/evidence" CODE)"
  expected=failed
  if [ "$scenario" = absolute-no-repair-passed ]; then expected=passed; fi
  check contains "$FIX_INITIAL" "TESTS_STATUS=$expected"
  diagnostic="$(trg_snapshot_report "$WT" "$ARTIFACTS_DIR/evidence" 2>&1)"
  message="test guard: absolute reference into the live worktree cannot be verified from the trusted copy: $entry -> $absolute"
  if [ "$scenario" = absolute-system ] || [ "$scenario" = absolute-external-import ]; then
    check rejects contains "$diagnostic" 'absolute reference into the live worktree'
    check test ! -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
  else
    check contains "$diagnostic" "$message"
    check test -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
  fi
  rst_save_core "$ARTIFACTS_DIR/evidence"
  if [[ "$scenario" = absolute-no-repair-* ]]; then
    out="$(run_node run-stop-tests-final)"
    check contains "$out" "$FIX_INITIAL"
    check contains "$out" 'TESTS_REPAIR_ATTEMPTS=0'
    check rejects contains "$out" 'TESTS_FINAL_INFRA=trusted'
    check rejects contains "$out" 'tests_failed_after_repair:guard'
  else
    # A package script's direct target is frozen already. Use a legitimate
    # product repair to prove the absolute reference itself prevents trust.
    if [ "$scenario" = absolute-system ] || [ "$scenario" = absolute-external-import ] || [ "$scenario" = absolute-package ]; then printf 'good repair\n' > "$TARGET/product.txt"
    elif [ "$scenario" = absolute-import ]; then printf 'console.log("Tests: 1/1");\n' > "$TARGET/helper.js"
    else printf 'echo "Tests: 1/1"\n' > "$TARGET/helper.js"; fi
    check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
    live="$(cd "$WT" && rst_execute_saved "$ARTIFACTS_DIR/evidence" CODE)"
    check contains "$live" 'TESTS_STATUS=passed'
    status="$(git -C "$TARGET" status --porcelain=v1)"
    bytes="$(git -C "$TARGET" diff --binary)"
    printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
    out="$(run_node run-stop-tests-final 2> "$TMP/r4-final-diagnostic")"
    check contains "$out" 'TESTS_FINAL_INFRA=trusted'
    if [ "$scenario" = absolute-system ] || [ "$scenario" = absolute-external-import ]; then
      check contains "$out" 'TESTS_STATUS=passed'
      check contains "$out" 'TESTS_REPAIR_RESULT=repaired'
    else
      check contains "$out" 'TESTS_STATUS=blocked'
      check contains "$out" 'TESTS_BLOCKED_REASON=tests_failed_after_repair:guard'
      check contains "$out" 'TESTS_REPAIR_RESULT=guard_violation'
      check rejects contains "$out" 'TESTS_STATUS=passed'
      check grep -Fxq -- "$message" "$TMP/r4-final-diagnostic"
    fi
    check test "$status" = "$(git -C "$TARGET" status --porcelain=v1)"
    check test "$bytes" = "$(git -C "$TARGET" diff --binary)"
  fi
  unset RST_STAGE_WORKTREES BASE_BRANCH
  continue
fi

fixture "r3-$location-$scenario"
printf '{"type":"commonjs"}\n' > "$WT/package.json"
printf 'base\n' > "$WT/product.txt"
case "$scenario" in
  chain)
    printf 'node wrapper.js\n' > "$WT/check.sh"
    printf "require('./helper.js');\n" > "$WT/wrapper.js"
    cat > "$WT/helper.js" <<'JS'
const good = require('fs').readFileSync('product.txt', 'utf8').trim() === 'good';
console.log(good ? 'Tests: 1/1' : 'Tests: 0/1');
process.exit(good ? 0 : 1);
JS
    ;;
  product)
    printf 'from product import good\nprint("Tests: 1/1" if good else "Tests: 0/1")\nraise SystemExit(0 if good else 1)\n' > "$WT/check.py"
    printf 'good = True\n' > "$WT/product.py"
    ;;
  dynamic-product|dynamic-helper)
    printf 'node wrapper.js\n' > "$WT/check.sh"
    printf "require('./%s.js');\n" "${scenario#dynamic-}" > "$WT/wrapper.js"
    # An unresolved import must not hide a later literal, name-marked helper.
    printf "require(moduleName);\nrequire('./leaf-helper.js');\n" > "$WT/${scenario#dynamic-}.js"
    printf '// saved leaf\n' > "$WT/leaf-helper.js"
    ;;
  names)
    printf 'node wrapper.js\n' > "$WT/check.sh"
    : > "$WT/wrapper.js"
    for name in test/plain.js tests/plain.js spec/plain.js specs/plain.js fixtures/plain.js __tests__/plain.js mocks/plain.js lib/TeSt.js lib/SpEc.js lib/FiXtUrE.js lib/MoCk.js lib/HeLpEr.js lib/SeTuP.js lib/CoNfTeSt.js lib/product.js lib/fixtures-extra/plain.js; do
      mkdir -p "$WT/$(dirname "$name")"
      printf '// leaf\n' > "$WT/$name"
      printf "require('./%s');\n" "$name" >> "$WT/wrapper.js"
    done
    ;;
esac
commit_fixture .
git -C "$WT" branch run-base
printf 'bad build\n' > "$WT/product.txt"
case "$scenario" in
  chain) printf '// build wrapper\n' >> "$WT/wrapper.js"; printf '// build helper\n' >> "$WT/helper.js" ;;
  product) printf 'good = False\n' > "$WT/product.py" ;;
esac
commit_fixture .
CURRENT="$WT"; TARGET="$WT"
if [ "$location" = stage ]; then
  TARGET="$TMP/r3-linked-$scenario"
  git -C "$WT" worktree add --detach -q "$TARGET" HEAD
fi
export BASE_BRANCH=run-base ARTIFACTS_DIR="$TMP/r3-evidence-$location-$scenario"
mkdir -p "$ARTIFACTS_DIR/evidence"
command='bash check.sh'
if [ "$scenario" = product ]; then command='python3 check.py'; fi
printf '%s\n' "$command" > "$ARTIFACTS_DIR/evidence/stop-tests.commands"
printf 'CODE\n' > "$ARTIFACTS_DIR/evidence/stop-tests.class"
printf '20\n' > "$ARTIFACTS_DIR/evidence/stop-tests.timeout"
if [ "$location" = stage ]; then
  export RST_STAGE_WORKTREES="s=$TARGET"
  printf 's\tthinmansoftware/other\t%s\trun-base\n' "$command" > "$ARTIFACTS_DIR/evidence/stop-tests.stages"
fi

if [[ "$scenario" = dynamic-* ]]; then
  diagnostic="$(trg_snapshot_report "$WT" "$ARTIFACTS_DIR/evidence" 2>&1)"
  if [ "$scenario" = dynamic-product ]; then
    check test ! -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
    check rejects contains "$diagnostic" 'cannot resolve trusted helper'
    check saved leaf-helper.js
    check rejects saved product.js
  else
    check test -f "$ARTIFACTS_DIR/evidence/test-repair.guard"
    check contains "$diagnostic" 'helper.js: computed import'
  fi
elif [ "$scenario" = names ]; then
  check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  for name in test/plain.js tests/plain.js spec/plain.js specs/plain.js fixtures/plain.js __tests__/plain.js mocks/plain.js lib/TeSt.js lib/SpEc.js lib/FiXtUrE.js lib/MoCk.js lib/HeLpEr.js lib/SeTuP.js lib/CoNfTeSt.js; do
    check saved "$name"
  done
  check rejects saved lib/product.js
  check rejects saved lib/fixtures-extra/plain.js
else
  export FIX_INITIAL="$(cd "$WT" && rst_execute_saved "$ARTIFACTS_DIR/evidence" CODE)"
  check contains "$FIX_INITIAL" 'TESTS_STATUS=failed'
  check contains "$FIX_INITIAL" '0/1'
  check trg_snapshot "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  if [ "$scenario" = chain ]; then
    check saved helper.js
    check rejects saved wrapper.js
    printf 'console.log("Tests: 1/1");\n' > "$TARGET/helper.js"
  else
    check saved check.py
    check rejects saved product.py
    printf 'good = True\n' > "$TARGET/product.py"
  fi
  check trg_check "$WT" "$ARTIFACTS_DIR/evidence/test-guard.json"
  live="$(cd "$WT" && rst_execute_saved "$ARTIFACTS_DIR/evidence" CODE)"
  check contains "$live" 'TESTS_STATUS=passed'
  check contains "$live" '1/1'
  status="$(git -C "$TARGET" status --porcelain=v1)"
  bytes="$(git -C "$TARGET" diff --binary)"
  rst_save_core "$ARTIFACTS_DIR/evidence"
  printf '1\n' > "$ARTIFACTS_DIR/evidence/test-repair.attempts"
  out="$(run_node run-stop-tests-final)"
  check contains "$out" 'TESTS_FINAL_INFRA=trusted'
  if [ "$scenario" = chain ]; then
    check contains "$out" 'TESTS_STATUS=blocked'
    check rejects contains "$out" 'TESTS_STATUS=passed'
    check contains "$out" '0/1'
    check contains "$(cat "$TARGET/helper.js")" 'Tests: 1/1'
  else
    check contains "$out" 'TESTS_STATUS=passed'
    check contains "$out" '1/1'
    check contains "$out" 'TESTS_PASSED=1'
    check contains "$out" 'TESTS_TOTAL=1'
    check contains "$(cat "$TARGET/product.py")" 'good = True'
  fi
  check test "$status" = "$(git -C "$TARGET" status --porcelain=v1)"
  check test "$bytes" = "$(git -C "$TARGET" diff --binary)"
fi
unset RST_STAGE_WORKTREES BASE_BRANCH
done
finish trusted-test-infra-r3.sh
