#!/usr/bin/env bash
# Regression tests for integer-safe implementation counters in maintained BDC lanes.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-fable.yaml
)

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; echo "      $2"; FAIL=$((FAIL + 1)); }

extract_assert_script() {
  local lane="$1"
  awk '
    $0 == "  - id: assert-implement-produced-work" { in_node=1; next }
    in_node && $0 == "    bash: |" { in_bash=1; next }
    in_node && in_bash && $0 ~ /^  - id: / { exit }
    in_node && in_bash {
      if ($0 ~ /^      /) sub(/^      /, "")
      print
    }
  ' "$lane" | sed 's/^IMPL=\$implement\.output$/IMPL=${IMPL_STUB:-}/'
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ASSERT_SCRIPT="$TMP/assert-implement.sh"
extract_assert_script "$ROOT/.archon/workflows/defaults/${LANES[0]}" > "$ASSERT_SCRIPT"

init_fixture_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  printf 'baseline\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm baseline
  mkdir -p "${repo}-artifacts"
  git -C "$repo" rev-parse HEAD > "${repo}-artifacts/run-start-sha.txt"
}

run_assert() {
  local repo="$1"
  shift
  (
    cd "$repo" || exit 1
    ARTIFACTS_DIR="${repo}-artifacts" \
      IMPL_STUB='ALREADY_SATISFIED: fixture' \
      "$@" bash "$ASSERT_SCRIPT"
  ) 2>&1
}

REPO="$TMP/repo"
init_fixture_repo "$REPO"

OUT=$(run_assert "$REPO" env); RC=$?
if [ "$RC" -eq 0 ] && grep -qx 'CHANGED_FILES=0' <<< "$OUT" && grep -qx 'COMMITS_AHEAD=0' <<< "$OUT"; then
  pass "empty status emits one integer zero for each counter"
else
  fail "empty status emits one integer zero for each counter" "rc=$RC output=$OUT"
fi

printf 'one\n' > "$REPO/one.txt"
OUT=$(run_assert "$REPO" env); RC=$?
if [ "$RC" -eq 0 ] && grep -qx 'CHANGED_FILES=1' <<< "$OUT"; then
  pass "one status line emits integer one"
else
  fail "one status line emits integer one" "rc=$RC output=$OUT"
fi
rm -f "$REPO/one.txt"

printf 'one\n' > "$REPO/one.txt"
printf 'two\n' > "$REPO/two.txt"
OUT=$(run_assert "$REPO" env); RC=$?
if [ "$RC" -eq 0 ] && grep -qx 'CHANGED_FILES=2' <<< "$OUT"; then
  pass "multiple status lines emit one integer count"
else
  fail "multiple status lines emit one integer count" "rc=$RC output=$OUT"
fi
rm -f "$REPO/one.txt" "$REPO/two.txt"

NOT_REPO="$TMP/not-repo"
mkdir -p "$NOT_REPO" "${NOT_REPO}-artifacts"
printf 'unknown\n' > "${NOT_REPO}-artifacts/run-start-sha.txt"
OUT=$(run_assert "$NOT_REPO" env); RC=$?
if [ "$RC" -ne 0 ] && grep -q 'invalid implementation counter' <<< "$OUT"; then
  pass "Git command failure fails closed with a named counter error"
else
  fail "Git command failure fails closed with a named counter error" "rc=$RC output=$OUT"
fi

REAL_GIT=$(command -v git)
mkdir -p "$TMP/bin"
cat > "$TMP/bin/git" <<EOF
#!/usr/bin/env bash
case " \$* " in
  *" rev-list --count "*) printf '0\\n0\\n'; exit 0 ;;
esac
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TMP/bin/git"
OUT=$(run_assert "$REPO" env PATH="$TMP/bin:$PATH"); RC=$?
if [ "$RC" -ne 0 ] && grep -q 'invalid implementation counter' <<< "$OUT"; then
  pass "multiline counter output fails closed"
else
  fail "multiline counter output fails closed" "rc=$RC output=$OUT"
fi

REFERENCE_COUNTERS="$TMP/reference-counters.sh"
sed -n '/^validate_implementation_counter()/,/^AHEAD=\$AHEAD_RAW$/p' "$ASSERT_SCRIPT" > "$REFERENCE_COUNTERS"
PARITY_FAILURES=""
for lane in "${LANES[@]}"; do
  candidate="$TMP/${lane}.counters.sh"
  extract_assert_script "$ROOT/.archon/workflows/defaults/$lane" \
    | sed -n '/^validate_implementation_counter()/,/^AHEAD=\$AHEAD_RAW$/p' > "$candidate"
  cmp -s "$REFERENCE_COUNTERS" "$candidate" || PARITY_FAILURES+="$lane "
done
if [ -z "$PARITY_FAILURES" ]; then
  pass "assert counter logic is identical across maintained lanes"
else
  fail "assert counter logic is identical across maintained lanes" "$PARITY_FAILURES"
fi

UNSAFE=""
for lane in "${LANES[@]}"; do
  path="$ROOT/.archon/workflows/defaults/$lane"
  if grep -nF 'grep -c . || echo 0' "$path" >/dev/null; then
    UNSAFE+="$lane "
  fi
  CHANGED_VALIDATIONS=$(grep -c 'validate_implementation_counter CHANGED' "$path" || true)
  AHEAD_VALIDATIONS=$(grep -c 'validate_implementation_counter AHEAD' "$path" || true)
  if [ "$CHANGED_VALIDATIONS" -ne 3 ] || [ "$AHEAD_VALIDATIONS" -ne 3 ]; then
    UNSAFE+="$lane(counter-validation-count=$CHANGED_VALIDATIONS/$AHEAD_VALIDATIONS) "
  fi
done
if [ -z "$UNSAFE" ]; then
  pass "all maintained lanes use validated raw counters"
else
  fail "all maintained lanes use validated raw counters" "$UNSAFE"
fi

echo ""
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
