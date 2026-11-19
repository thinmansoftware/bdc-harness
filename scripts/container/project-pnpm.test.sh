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

assert_absent() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  present: [$path]"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
  fi
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

INVOKED="$FAKE_ROOT/invoked"
NODE_INVOKED="$FAKE_ROOT/node-invoked"

cat > "$FAKE_NODE" <<EOF
#!/usr/bin/env bash
printf 'invoked\n' > "$NODE_INVOKED"
exit 99
EOF

cat > "$FAKE_PNPM" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$PATH" > "$INVOKED.path"
printf '%s\n' "\$@" > "$INVOKED.args"
exit "\${PROJECT_PNPM_FAKE_RC:-0}"
EOF
chmod +x "$FAKE_NODE" "$FAKE_PNPM"

export PROJECT_PNPM_NODE="$FAKE_NODE"
export PROJECT_PNPM_BIN="$FAKE_PNPM"
unset PROJECT_PNPM_FAKE_RC

reset_invoked() {
  rm -f "$INVOKED.path" "$INVOKED.args" "$NODE_INVOKED"
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

assert_direct_exec() {
  local label="$1" expected_rc="$2"
  shift 2
  local expected_args
  expected_args="$(printf '%s\n' "$@")"
  assert_eq "$label rc" "$expected_rc" "$SHIM_RC"
  assert_eq "$label args" "$expected_args" "$(cat "$INVOKED.args")"
  assert_path_prefix "$label PATH" "$NODE_DIR" "$(cat "$INVOKED.path")"
  assert_absent "$label node sentinel" "$NODE_INVOKED"
}

assert_pkg_unchanged() {
  local label="$1" path="$2" before="$3"
  assert_eq "$label package.json" "$before" "$(cat "$path")"
}

echo "--- pnpm@12.14.0 execs the native bin directly ---"
reset_invoked
D1="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@12.14.0"}' > "$D1/package.json"
D1_BEFORE="$(cat "$D1/package.json")"
run_shim "$D1" --version
assert_direct_exec "supported" "0" --version
assert_pkg_unchanged "supported" "$D1/package.json" "$D1_BEFORE"

echo "--- pnpm@12.14.0+suffix is the same direct path ---"
reset_invoked
D1S="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@12.14.0+sha512.abc"}' > "$D1S/package.json"
D1S_BEFORE="$(cat "$D1S/package.json")"
run_shim "$D1S" --version
assert_direct_exec "suffix" "0" --version
assert_pkg_unchanged "suffix" "$D1S/package.json" "$D1S_BEFORE"

echo "--- missing packageManager uses the pinned native bin ---"
reset_invoked
DNONE="$(mktemp -d)"
printf '%s\n' '{}' > "$DNONE/package.json"
DNONE_BEFORE="$(cat "$DNONE/package.json")"
run_shim "$DNONE" --version
assert_direct_exec "missing packageManager" "0" --version
assert_pkg_unchanged "missing packageManager" "$DNONE/package.json" "$DNONE_BEFORE"

echo "--- no package.json uses the pinned native bin ---"
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
assert_direct_exec "no package.json" "0" --version

echo "--- fixture exit status and argv order are preserved ---"
reset_invoked
export PROJECT_PNPM_FAKE_RC=7
DRC="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@12.14.0"}' > "$DRC/package.json"
DRC_BEFORE="$(cat "$DRC/package.json")"
run_shim "$DRC" install --frozen-lockfile
assert_direct_exec "nonzero" "7" install --frozen-lockfile
assert_pkg_unchanged "nonzero" "$DRC/package.json" "$DRC_BEFORE"
unset PROJECT_PNPM_FAKE_RC

echo "--- pnpm@11.10.0 is refused and starts neither fixture ---"
reset_invoked
D2="$(mktemp -d)"
printf '%s\n' '{"packageManager":"pnpm@11.10.0"}' > "$D2/package.json"
run_shim "$D2" --version
assert_eq "unsupported version rc" "1" "$SHIM_RC"
assert_eq "unsupported version message" "project-pnpm: unsupported pnpm version 11.10.0 (image provides 12.14.0)" "$SHIM_ERR_TEXT"
assert_absent "unsupported version node sentinel" "$NODE_INVOKED"
assert_absent "unsupported version pnpm path" "$INVOKED.path"
assert_absent "unsupported version pnpm args" "$INVOKED.args"

echo "--- yarn@4 is refused and starts neither fixture ---"
reset_invoked
D3="$(mktemp -d)"
printf '%s\n' '{"packageManager":"yarn@4"}' > "$D3/package.json"
run_shim "$D3" --version
assert_eq "yarn rc" "1" "$SHIM_RC"
assert_eq "yarn message" "project-pnpm: unsupported packageManager yarn@4 (image provides pnpm@12.14.0)" "$SHIM_ERR_TEXT"
assert_absent "yarn node sentinel" "$NODE_INVOKED"
assert_absent "yarn pnpm path" "$INVOKED.path"
assert_absent "yarn pnpm args" "$INVOKED.args"

rm -rf "$FAKE_ROOT" "$D1" "$D1S" "$DNONE" "$D2" "$D3" "$DRC" "$DNOPKG"

echo
echo "project-pnpm.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
