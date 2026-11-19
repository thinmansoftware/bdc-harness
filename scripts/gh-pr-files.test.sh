#!/usr/bin/env bash
# Tests for gh-pr-files.sh.

set -uo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
}

cat > "$TMP_DIR/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${GH_STUB_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ "$#" -eq 5 ] && [ "$1" = "api" ] && [ "$2" = "--paginate" ] &&
   [ "$3" = "repos/o/r/pulls/908/files" ] && [ "$4" = "--jq" ] &&
   [ "$5" = ".[].filename" ]; then
  i=1
  while [ "$i" -le 156 ]; do
    printf 'src/file-%03d.ts\n' "$i"
    i=$((i + 1))
  done
  exit 0
fi
echo "unexpected gh arguments: $*" >&2
exit 1
EOF
chmod +x "$TMP_DIR/gh"
export PATH="$TMP_DIR:$PATH"

OUT=$(bash "$SCRIPT_DIR/gh-pr-files.sh" o/r 908 2>"$TMP_DIR/error")
CODE=$?
LINES=$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')
UNIQUE=$(printf '%s\n' "$OUT" | sort -u | wc -l | tr -d ' ')
if [ "$CODE" -eq 0 ] && [ "$LINES" -eq 156 ] && [ "$UNIQUE" -eq 156 ] &&
   printf '%s\n' "$OUT" | grep -Fxq 'src/file-156.ts'; then
  pass "helper_lists_all_pages"
else
  fail "helper_lists_all_pages"
fi

BAD_ARGS_OK=true
for args in '' 'notarepo 908' 'o/r abc'; do
  set +e
  # Word splitting is intentional so the empty case supplies no arguments.
  bash "$SCRIPT_DIR/gh-pr-files.sh" $args >"$TMP_DIR/output" 2>"$TMP_DIR/error"
  CODE=$?
  set -e
  if [ "$CODE" -eq 0 ] || ! grep -q '^PR_FILES_ERROR:' "$TMP_DIR/error"; then
    BAD_ARGS_OK=false
  fi
done
if [ "$BAD_ARGS_OK" = true ]; then
  pass "helper_rejects_bad_args"
else
  fail "helper_rejects_bad_args"
fi

set +e
GH_STUB_FAIL=1 bash "$SCRIPT_DIR/gh-pr-files.sh" o/r 908 >"$TMP_DIR/output" 2>"$TMP_DIR/error"
CODE=$?
set -e
if [ "$CODE" -ne 0 ] && grep -q '^PR_FILES_ERROR:' "$TMP_DIR/error"; then
  pass "helper_propagates_gh_failure"
else
  fail "helper_propagates_gh_failure"
fi

echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
