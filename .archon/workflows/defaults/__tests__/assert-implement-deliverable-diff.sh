#!/usr/bin/env bash
# assert-implement-deliverable-diff.sh -- T2 fixture for zero-open deliverable truth
# WO-HARNESS-ZERO-OPEN-IMPLEMENT-MANIFEST-CHECKPOINT-TRUTH-01
#
# Scoped to bdc-feature-development-zero-open.yaml only.
# Run: bash .archon/workflows/defaults/__tests__/assert-implement-deliverable-diff.sh

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: [$expected]"
    echo "  actual:   [$actual]"
  fi
}

assert_nonzero() {
  local label="$1" code="$2"
  if [ "$code" -ne 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS: $label (exit=$code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (expected non-zero)"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
YAML="$DEFAULTS_DIR/bdc-feature-development-zero-open.yaml"

extract_assert_body() {
  # Extract full assert-implement-produced-work bash body (indented under bash: |)
  awk '
    /^  - id: assert-implement-produced-work$/ { n=1; next }
    n && /^    bash: \|$/ { b=1; next }
    n && b && /^  - id: / { exit }
    n && b { print }
  ' "$1" | sed 's/^      //'
}

BODY="$(extract_assert_body "$YAML")"
if [ -z "$BODY" ]; then
  echo "FATAL: could not extract assert-implement-produced-work body"
  exit 1
fi
if ! printf '%s\n' "$BODY" | grep -q 'BEGIN assert-implement-deliverable-diff'; then
  echo "FATAL: deliverable-diff markers missing from zero-open assert body"
  exit 1
fi
PASS=$((PASS + 1))
echo "PASS: markers present in zero-open assert body"

# Build a minimal runnable script from the body: stub implement.output via IMPL env.
RUNNABLE=$(printf '%s\n' "$BODY" | awk '
  index($0, "IMPL=$(cat <<") == 1 && index($0, "BDC_FEATURE_DEV_IMPL_IMPLEMENT_20260719_") > 0 {
    print "IMPL=\"${IMPL_FIXTURE:-}\""
    skip = 1
    next
  }
  skip {
    if ($0 == ")") skip = 0
    next
  }
  { print }
')
if printf '%s\n' "$RUNNABLE" | grep -Fxq '$implement.output'; then
  echo "FATAL: could not replace implement output heredoc with fixture"
  exit 1
fi

run_assert() {
  local wt="$1" impl="$2" base="$3"
  local script out code
  script=$(mktemp)
  {
    echo 'set -uo pipefail'
    echo "export ARTIFACTS_DIR=$(printf '%q' "$wt/artifacts")"
    echo "export IMPL_FIXTURE=$(printf '%q' "$impl")"
    # git rev-parse will use wt after cd
    echo "cd $(printf '%q' "$wt")"
    printf '%s\n' "$RUNNABLE"
  } > "$script"
  set +e
  out=$(bash "$script" 2>&1)
  code=$?
  set -e
  rm -f "$script"
  printf '%s\n' "$out"
  return "$code"
}

make_repo() {
  local d="$1"
  rm -rf "$d"
  mkdir -p "$d/artifacts" "$d/.archon/workflows" "$d/docs/canary"
  git -C "$d" init -q
  git -C "$d" config user.email "test@example.com"
  git -C "$d" config user.name "test"
  echo base > "$d/README.md"
  git -C "$d" add README.md
  git -C "$d" commit -q -m "base"
  local base
  base=$(git -C "$d" rev-parse HEAD)
  echo "$base" > "$d/artifacts/run-start-sha.txt"
  printf '%s' "$base"
}

echo "--- Test A: claimed canary not in committed diff (only archon yaml) ---"
FIX=$(mktemp -d)
BASE=$(make_repo "$FIX")
# commit only archon workflow junk after BASE; canary exists on disk but is NOT committed
echo "junk: true" > "$FIX/.archon/workflows/bar.yaml"
git -C "$FIX" add .archon/workflows/bar.yaml
git -C "$FIX" commit -q -m "thrash"
mkdir -p "$FIX/docs/canary"
echo "on-disk-only" > "$FIX/docs/canary/foo.md"
# do not git-add the canary -- disk check passes, committed-truth must fail
IMPL=$'COMPLETE\nCreated docs/canary/foo.md for the canary.\nBUILD_COMPLETE'
set +e
OUT=$(run_assert "$FIX" "$IMPL" "$BASE")
CODE=$?
set +e
assert_nonzero "thrash non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'BUILD_OUTCOME=FALSE_COMPLETE'; then
  PASS=$((PASS + 1))
  echo "PASS: FALSE_COMPLETE on thrash"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected FALSE_COMPLETE"
  echo "$OUT"
fi
rm -rf "$FIX" 2>/dev/null || true

echo "--- Test B: claimed canary genuinely committed ---"
FIX=$(mktemp -d)
BASE=$(make_repo "$FIX")
mkdir -p "$FIX/docs/canary"
echo "ZERO_OPEN_LANE_CANARY_OK" > "$FIX/docs/canary/foo.md"
git -C "$FIX" add docs/canary/foo.md
git -C "$FIX" commit -q -m "canary"
IMPL=$'COMPLETE\nCreated docs/canary/foo.md\nBUILD_COMPLETE'
set +e
OUT=$(run_assert "$FIX" "$IMPL" "$BASE")
CODE=$?
set +e
assert_eq "real build exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'BUILD_OUTCOME=REAL_BUILD'; then
  PASS=$((PASS + 1))
  echo "PASS: REAL_BUILD when canary committed"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected REAL_BUILD"
  echo "$OUT"
fi
rm -rf "$FIX" 2>/dev/null || true

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
