#!/usr/bin/env bash
# assert-mailbox-hostile-narration.sh
# WO-HARNESS-NODE-OUTPUT-MAILBOX-ASSERT-01
#
# Proves assert-implement-produced-work survives agent narration that previously
# killed live runs, on EVERY lane YAML carrying the node.
#
# Anchor runs (2026-07-28):
#   4fdc8d95 -- codex lane, exit 127: manifest field lines ("Vercel:", "VALIDATION::",
#               "-") executed as shell commands after the quoted heredoc terminated early.
#   474afb2c -- claude lane, exit 2: apostrophes in the builder's root-cause narration
#               left an unterminated quote ("unexpected EOF while looking for matching quote").
#
# The fix: the assert node reads ONLY $ARTIFACTS_DIR/implement.env (KEY=VALUE), so
# narration never reaches bash. This test asserts BOTH halves:
#   1. no lane body interpolates $implement.output (structural)
#   2. rendering a lane body with hostile narration present in the run still parses
#      (bash -n) and classifies correctly (behavioral)
#
# Run: bash .archon/workflows/defaults/__tests__/assert-mailbox-hostile-narration.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# The exact killers from the anchor runs, in one blob.
HOSTILE_NARRATION=$(cat <<'HOSTILE_EOF'
I've fixed the bug. Here's what I changed and why it wasn't working:

WO: WO-EXAMPLE-01
Files modified: packages/core/src/thing.ts
Tests: 4 passing / 4 total with `bun test`
Vercel deployment: N/A
VALIDATION:: PASS
-
```bash
echo "this fence used to terminate the heredoc"
rm -rf /tmp/should-never-run
```
Root cause: the node's substitution wasn't escaped, so it'd break on $(whoami)
and `hostname` and the builder's own apostrophes.
BDC_FEATURE_DEV_IMPL_IMPLEMENT_20260719_001
COMPLETE
HOSTILE_EOF
)

extract_assert_body() {
  awk '
    /^  - id: assert-implement-produced-work$/ { n=1; next }
    n && /^    bash: \|$/ { b=1; next }
    n && b && /^  - id: / { exit }
    n && b { print }
  ' "$1" | sed 's/^      //'
}

LANES=$(cd "$DEFAULTS_DIR" && grep -l '^  - id: assert-implement-produced-work$' ./*.yaml | sed 's|^\./||')
if [ -z "$LANES" ]; then
  echo "FATAL: no lane YAML carries assert-implement-produced-work"
  exit 1
fi
LANE_COUNT=$(printf '%s\n' "$LANES" | grep -c .)
echo "Lanes under test: $LANE_COUNT"

make_repo() {
  local d="$1"
  rm -rf "$d" "$d-artifacts"
  # Artifacts live OUTSIDE the repo: an in-repo artifacts dir would leave the
  # worktree permanently dirty and defeat the clean-worktree fixtures.
  mkdir -p "$d" "$d-artifacts"
  git -C "$d" init -q 2>/dev/null
  git -C "$d" config user.email "test@example.com"
  git -C "$d" config user.name "test"
  # Windows git autocrlf would dirty the worktree on checkout and break the
  # clean-worktree fixtures below; pin the fixture repo to no conversion.
  git -C "$d" config core.autocrlf false
  echo base > "$d/README.md"
  git -C "$d" add README.md
  git -C "$d" commit -q -m "base"
  git -C "$d" rev-parse HEAD > "$d-artifacts/run-start-sha.txt"
}

# Render a lane's assert body into a runnable script and execute it against a
# fixture repo whose mailbox holds $2, with hostile narration on disk as a
# stand-in for what the agent actually emitted.
run_lane() {
  local body="$1" wt="$2" mailbox="$3"
  local script out
  printf '%s' "$mailbox" > "$wt-artifacts/implement.env"
  printf '%s\n' "$HOSTILE_NARRATION" > "$wt-artifacts/implement-narration.txt"
  script=$(mktemp)
  {
    echo 'set -uo pipefail'
    echo "export ARTIFACTS_DIR=$(printf '%q' "$wt-artifacts")"
    echo "cd $(printf '%q' "$wt")"
    printf '%s\n' "$body"
  } > "$script"
  out=$(bash "$script" 2>&1)
  rm -f "$script"
  printf '%s\n' "$out"
}

for lane in $LANES; do
  YAML="$DEFAULTS_DIR/$lane"
  BODY="$(extract_assert_body "$YAML")"

  if [ -z "$BODY" ]; then
    fail "$lane: could not extract assert body"
    continue
  fi

  # 1. Structural: no raw node-output interpolation anywhere in the gate.
  if printf '%s\n' "$BODY" | grep -Fq '$implement.output'; then
    fail "$lane: assert body still interpolates raw \$implement.output"
  else
    pass "$lane: no raw \$implement.output in assert body"
  fi

  # 2. Structural: the old quoted-heredoc sentinel is gone.
  if printf '%s\n' "$BODY" | grep -q 'BDC_FEATURE_DEV_IMPL_IMPLEMENT'; then
    fail "$lane: old narration heredoc sentinel still present"
  else
    pass "$lane: narration heredoc sentinel removed"
  fi

  # 3. Structural: the gate reads the mailbox.
  if printf '%s\n' "$BODY" | grep -q 'IMPL_ENV="\$ARTIFACTS_DIR/implement.env"'; then
    pass "$lane: gate reads the artifact mailbox"
  else
    fail "$lane: gate does not read \$ARTIFACTS_DIR/implement.env"
  fi

  # 4. Behavioral: body is syntactically valid shell.
  SCRIPT=$(mktemp)
  printf '%s\n' "$BODY" > "$SCRIPT"
  if bash -n "$SCRIPT" 2>/dev/null; then
    pass "$lane: assert body passes bash -n"
  else
    fail "$lane: assert body fails bash -n"
    bash -n "$SCRIPT" 2>&1 | head -3
  fi
  rm -f "$SCRIPT"

  # 5. Behavioral: real build + hostile narration present -> REAL_BUILD, exit 0.
  FIX=$(mktemp -d)
  make_repo "$FIX"
  echo "real change" > "$FIX/README.md"
  git -C "$FIX" add README.md
  git -C "$FIX" commit -q -m "real work"
  OUT=$(run_lane "$BODY" "$FIX" "$(printf 'COMPLETE=true\nALREADY_SATISFIED=no\nCLAIMED_DELIVERABLES=\n')")
  CODE=$?
  if [ "$CODE" -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'BUILD_OUTCOME=REAL_BUILD'; then
    pass "$lane: REAL_BUILD despite hostile narration in the run"
  else
    fail "$lane: expected REAL_BUILD exit 0, got exit=$CODE"
    printf '%s\n' "$OUT" | head -10
  fi
  # Nothing in the hostile narration may have executed.
  if printf '%s\n' "$OUT" | grep -qE 'command not found|unexpected EOF|this fence used to terminate'; then
    fail "$lane: hostile narration leaked into shell execution"
    printf '%s\n' "$OUT" | head -10
  else
    pass "$lane: no narration leaked into shell execution"
  fi
  rm -rf "$FIX" "$FIX-artifacts" 2>/dev/null || true

  # 6. Behavioral: clean worktree + mailbox says already-satisfied -> ALREADY_SATISFIED.
  FIX=$(mktemp -d)
  make_repo "$FIX"
  OUT=$(run_lane "$BODY" "$FIX" "$(printf 'COMPLETE=true\nALREADY_SATISFIED=yes\nCLAIMED_DELIVERABLES=\n')")
  if printf '%s\n' "$OUT" | grep -q 'BUILD_OUTCOME=ALREADY_SATISFIED'; then
    pass "$lane: ALREADY_SATISFIED from mailbox on clean worktree"
  else
    fail "$lane: expected ALREADY_SATISFIED from mailbox"
    printf '%s\n' "$OUT" | head -10
  fi
  rm -rf "$FIX" "$FIX-artifacts" 2>/dev/null || true

  # 7. Behavioral: clean worktree + missing mailbox -> FALSE_COMPLETE (fail closed).
  FIX=$(mktemp -d)
  make_repo "$FIX"
  rm -f "$FIX-artifacts/implement.env"
  SCRIPT=$(mktemp)
  {
    echo 'set -uo pipefail'
    echo "export ARTIFACTS_DIR=$(printf '%q' "$FIX-artifacts")"
    echo "cd $(printf '%q' "$FIX")"
    printf '%s\n' "$BODY"
  } > "$SCRIPT"
  OUT=$(bash "$SCRIPT" 2>&1)
  rm -f "$SCRIPT"
  if printf '%s\n' "$OUT" | grep -q 'BUILD_OUTCOME=FALSE_COMPLETE'; then
    pass "$lane: FALSE_COMPLETE when mailbox absent and worktree clean"
  else
    fail "$lane: expected FALSE_COMPLETE with no mailbox"
    printf '%s\n' "$OUT" | head -10
  fi
  rm -rf "$FIX" "$FIX-artifacts" 2>/dev/null || true
done

echo ""
echo "RESULTS: $PASS passed, $FAIL failed (across $LANE_COUNT lanes)"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
