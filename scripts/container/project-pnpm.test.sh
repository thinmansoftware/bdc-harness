#!/usr/bin/env bash
# Host tests for scripts/container/project-pnpm.sh. No Docker. jq must already be installed.
set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected: [$expected]"; echo "  actual:   [$actual]"
  fi
}

assert_path_prefix() {
  local label="$1" prefix="$2" actual="$3"
  case "$actual" in
    "$prefix"|"$prefix":*)
      PASS=$((PASS + 1)); echo "PASS: $label"
      ;;
    *)
      FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  prefix: [$prefix]"; echo "  actual: [$actual]"
      ;;
  esac
}

if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq is required and must already be installed"
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$HERE/project-pnpm.sh"

FAKE_ROOT="$(mktemp -d)"
NODE_DIR="$FAKE_ROOT/node26/bin"
mkdir -p "$NODE_DIR"
FAKE_NODE="$NODE_DIR/node"
FAKE_PNPM="$FAKE_ROOT/pnpm-12.14.0/pnpm"
mkdir -p "$(dirname "$FAKE_PNPM")"
printf 'fake-pnpm\n' > "$FAKE_PNPM"

INVOKED="$FAKE_ROOT/invoked"
cat > "$FAKE_NODE" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" > "$INVOKED.argv1"
printf '%s\n' "\$PATH" > "$INVOKED.path"
exit 0
EOF
chmod +x "$FAKE_NODE"

export PROJECT_PNPM_NODE="$FAKE_NODE"
export PROJECT_PNPM_BIN="$FAKE_PNPM"

reset_invoked() {
  rm -f "$INVOKED.argv1" "$INVOKED.path"
}

run_shim() {
  local dir="$1"
  shift
  SHIM_RC=0
  SHIM_ERR="$(mktemp)"
  ( cd "$dir" && bash "$SHIM" "$@" >"$FAKE_ROOT/stdout" 2>"$SHIM_ERR" ) || SHIM_RC=$?
  SHIM_ERR_TEXT="$(cat "$SHIM_ERR")"
  rm -f "$SHIM_ERR"
}

echo "--- pnpm@12.14.0 uses the pinned node and pnpm bin ---"
reset_invoked
D1="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@12.14.0"}' > "$D1/package.json"
run_shim "$D1" --version
assert_eq "supported rc" "0" "$SHIM_RC"
assert_eq "supported argv1" "$FAKE_PNPM" "$(cat "$INVOKED.argv1")"
assert_path_prefix "supported PATH" "$NODE_DIR" "$(cat "$INVOKED.path")"

echo "--- pnpm@12.14.0+suffix is the same pinned path ---"
reset_invoked
D1S="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@12.14.0+sha512.abc"}' > "$D1S/package.json"
run_shim "$D1S" --version
assert_eq "suffix rc" "0" "$SHIM_RC"
assert_eq "suffix argv1" "$FAKE_PNPM" "$(cat "$INVOKED.argv1")"
assert_path_prefix "suffix PATH" "$NODE_DIR" "$(cat "$INVOKED.path")"

echo "--- pnpm@11.10.0 is refused and does not invoke node ---"
reset_invoked
D2="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@11.10.0"}' > "$D2/package.json"
run_shim "$D2" --version
assert_eq "unsupported version rc" "1" "$SHIM_RC"
assert_eq "unsupported version message" "project-pnpm: unsupported pnpm version 11.10.0 (image provides 12.14.0)" "$SHIM_ERR_TEXT"
if [ -f "$INVOKED.argv1" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: unsupported version did not invoke node"
else
  PASS=$((PASS + 1)); echo "PASS: unsupported version did not invoke node"
fi

echo "--- yarn@4 is refused and does not invoke node ---"
reset_invoked
D3="$(mktemp -d)"
printf '%s\n' '{"packageManager":"yarn@4"}' > "$D3/package.json"
run_shim "$D3" --version
assert_eq "yarn rc" "1" "$SHIM_RC"
assert_eq "yarn message" "project-pnpm: unsupported packageManager yarn@4 (image provides pnpm@12.14.0)" "$SHIM_ERR_TEXT"
if [ -f "$INVOKED.argv1" ]; then
  FAIL=$((FAIL + 1)); echo "FAIL: yarn did not invoke node"
else
  PASS=$((PASS + 1)); echo "PASS: yarn did not invoke node"
fi

echo "--- no package.json uses the pinned path ---"
DNOPKG="$(mktemp -d /tmp/project-pnpm-nopkg.XXXXXX)"
ancestor="$(dirname "$DNOPKG")"
while [ "$ancestor" != "/" ]; do
  if [ -f "$ancestor/package.json" ]; then
    echo "FATAL: ancestor $ancestor has package.json"
    exit 1
  fi
  ancestor="$(dirname "$ancestor")"
done
if [ -f /package.json ]; then
  echo "FATAL: /package.json exists"
  exit 1
fi
reset_invoked
run_shim "$DNOPKG" --version
assert_eq "no package.json rc" "0" "$SHIM_RC"
assert_eq "no package.json argv1" "$FAKE_PNPM" "$(cat "$INVOKED.argv1")"
assert_path_prefix "no package.json PATH" "$NODE_DIR" "$(cat "$INVOKED.path")"

rm -rf "$FAKE_ROOT" "$D1" "$D1S" "$D2" "$D3" "$DNOPKG"

echo
echo "project-pnpm.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
