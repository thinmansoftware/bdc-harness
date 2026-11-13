#!/usr/bin/env bash
# WO #5217 round 2d: no arguments run all cases; use <location> <change> to focus.
. "$(dirname "${BASH_SOURCE[0]}")/evidence-test-lib.sh"
eval "$(core rst)"
eval "$(core trg)"

if [ "$#" -eq 0 ]; then
  scenarios=(current/outside current/broken stage/outside stage/broken)
elif [ "$#" -eq 2 ]; then
  scenarios=("$1/$2")
else
  echo 'Specify current or stage, then outside or broken' >&2; exit 2
fi
for scenario in "${scenarios[@]}"; do
set -- "${scenario%%/*}" "${scenario#*/}"
case "$1/$2" in
  current/outside|current/broken|stage/outside|stage/broken) ;;
  *) echo 'Specify current or stage, then outside or broken' >&2; exit 2 ;;
esac

# Reuse the original setup, execution and assertions, limiting only the loop
# inputs. A snapshot boundary must block initial evidence before any repair.
focused="$(python3 - "$HERE/test-repair-guard.sh" "$1" "$2" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('link_file() {')
end = source.index('# Capture the real patch-pr-body node', start)
body = source[start:end]
old = 'for location in current stage; do'
assert body.count(old) == 1
body = body.replace(old, 'for location in '+sys.argv[2]+'; do')
old = 'for change in target repoint delete outside broken product package test_file; do'
assert body.count(old) == 1
body = body.replace(old, 'for change in '+sys.argv[3]+'; do')
print(body)
PY
)" || exit 1
eval "$focused"
done
finish trusted-test-infra-r2d.sh
