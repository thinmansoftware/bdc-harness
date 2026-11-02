#!/usr/bin/env bash
# manifest-pr-content-check.sh -- T1 fixture for PR-file vs manifest claim check
# WO-HARNESS-ZERO-OPEN-IMPLEMENT-MANIFEST-CHECKPOINT-TRUTH-01
#
# Scoped to the 12 lanes with manifest-consistency-check.
# Run: bash .archon/workflows/defaults/__tests__/manifest-pr-content-check.sh

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
REPO_ROOT="$(cd "$DEFAULTS_DIR/../../.." && pwd)"
export BDC_PR_FILES_HELPER="$REPO_ROOT/scripts/gh-pr-files.sh"

MCC_SISTER=(
  bdc-feature-development.yaml
  bdc-feature-development-astra.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-cursor.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-zero.yaml
  bdc-feature-development-zero-open.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-zero-claude.yaml
  bdc-feature-development-fusion-cx-kimi.yaml
  bdc-feature-development-kimi-k3.yaml
)

extract_pr_block() {
  awk '
    /# ---- BEGIN manifest-pr-content-check ----/ { c=1; next }
    /# ---- END manifest-pr-content-check ----/   { c=0 }
    c
  ' "$1" | sed 's/^      //'
}

echo "--- Parity: 12 manifest-pr-content-check blocks byte-identical ---"
REF=""
REF_NAME=""
for f in "${MCC_SISTER[@]}"; do
  path="$DEFAULTS_DIR/$f"
  block="$(extract_pr_block "$path")"
  if [ -z "$block" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: empty pr-content block in $f"
    continue
  fi
  if [ -z "$REF" ]; then
    REF="$block"
    REF_NAME="$f"
    PASS=$((PASS + 1))
    echo "PASS: reference from $f"
  else
    if [ "$block" = "$REF" ]; then
      PASS=$((PASS + 1))
      echo "PASS: $f matches $REF_NAME"
    else
      FAIL=$((FAIL + 1))
      echo "FAIL: $f differs from $REF_NAME"
    fi
  fi
done

if [ -z "$REF" ]; then
  echo "FATAL: no PR content block"
  exit 1
fi

# Standalone runner for the PR-content block with stubs
run_pr_check() {
  local pr_url="$1" manifest="$2" pr_files_payload="$3"
  local script bin out code
  script=$(mktemp)
  bin=$(mktemp -d)
  cat > "$bin/gh" <<'GHEOF'
#!/usr/bin/env bash
if [ "$#" -eq 5 ] && [ "$1" = "api" ] && [ "$2" = "--paginate" ] &&
   printf '%s\n' "$3" | grep -Eq '^repos/[^/]+/[^/]+/pulls/[0-9]+/files$' &&
   [ "$4" = "--jq" ] && [ "$5" = ".[].filename" ]; then
  cat "$GH_PR_FILES_FIXTURE"
  exit 0
fi
echo "gh stub: unexpected args: $*" >&2
exit 1
GHEOF
  chmod +x "$bin/gh"
  printf '%s\n' "$pr_files_payload" > "$bin/pr_files.txt"

  {
    echo 'set -euo pipefail'
    echo "export PATH=$(printf '%q' "$bin"):\"\$PATH\""
    echo "export GH_PR_FILES_FIXTURE=$(printf '%q' "$bin/pr_files.txt")"
    echo "PR_URL=$(printf '%q' "$pr_url")"
    echo "MANIFEST_OUT=$(printf '%q' "$manifest")"
    echo "PRS_LINE=''"
    echo 'extract() { { printf "%s\n" "$MANIFEST_OUT" | grep -E "^${1}:" | head -1 | sed "s/^${1}:[[:space:]]*//"; } || true; }'
    printf '%s\n' "$REF"
    echo "printf 'OK\n'"
  } > "$script"

  set +e
  out=$(bash "$script" 2>&1)
  code=$?
  set -e
  rm -rf "$bin" "$script"
  printf '%s\n' "$out"
  return "$code"
}

echo "--- Test: claimed path absent from PR files -> fail ---"
MANIFEST=$'Files created: docs/canary/zero-open-lane-canary-01.md\nFiles modified: none\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" ".archon/workflows/x.yaml")
CODE=$?
set -e
assert_nonzero "wrong content non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR'; then
  PASS=$((PASS + 1))
  echo "PASS: PR_CONTENT_ERROR on missing path"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected PR_CONTENT_ERROR"
  echo "$OUT"
fi

echo "--- Test: claimed path present in PR files -> OK ---"
MANIFEST=$'Files created: docs/canary/zero-open-lane-canary-01.md\nFiles modified: none\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "docs/canary/zero-open-lane-canary-01.md")
CODE=$?
set -e
assert_eq "match exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when path matches"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK"
  echo "$OUT"
fi

# Regression: WO-HARNESS-MANIFEST-CONSISTENCY-CHECK-FALSE-DELETE-01
# A claimed path carrying a trailing free-text annotation the build-manifest
# persona appended (e.g. "(deleted)") must NOT be reported absent when the
# clean path genuinely exists in the PR file list. This is the exact
# false-negative from run 3729d35751c72fe6a3bf9e8f404cfa66.
echo "--- Test: annotated claimed path present in PR files -> OK (no false delete) ---"
MANIFEST=$'Files created: none\nFiles modified: staging/src/providers/auth0.ts (deleted)\nPRs: https://github.com/thinmansoftware/comicstoreos-provisioner/pull/15'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/comicstoreos-provisioner/pull/15" "$MANIFEST" "staging/src/providers/auth0.ts")
CODE=$?
set -e
assert_eq "annotated path match exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when annotated path resolves to present file"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for annotated present path"
  echo "$OUT"
fi

# Regression: prove the fix is general, not parenthesis-specific -- a trailing
# annotation without parens (e.g. "renamed") must also truncate cleanly.
echo "--- Test: annotated (no parens) claimed path present -> OK ---"
MANIFEST=$'Files created: none\nFiles modified: src/lib/api.ts renamed\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "src/lib/api.ts")
CODE=$?
set -e
assert_eq "no-parens annotation match exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when no-parens annotated path resolves to present file"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for no-parens annotated present path"
  echo "$OUT"
fi

# Regression: PR #1345 round-1. Trailing-word strip must apply to
# root-level paths with no slash (package.json updated).
echo "--- Test: root-level annotated path (no slash) present -> OK ---"
MANIFEST=$'Files created: none\nFiles modified: package.json updated\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "package.json")
CODE=$?
set -e
assert_eq "root-level annotation match exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when root-level annotated path resolves to present file"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for root-level annotated present path"
  echo "$OUT"
fi

# Regression (ordering lock): the exclusion filter must run BEFORE the new
# leading-path truncation, so multi-word sentinel tokens like "no files" are
# still fully excluded and do NOT leak through truncated to a bogus "no" path.
echo "--- Test: 'no files' sentinel still excluded, non-empty PR files -> OK ---"
MANIFEST=$'Files created: none\nFiles modified: no files\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "some/real/file.ts")
CODE=$?
set -e
assert_eq "no-files exclusion exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: 'no files' treated as nothing-claimed (no leaked 'no' path)"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: 'no files' leaked as a claimed path or otherwise tripped the check"
  echo "$OUT"
fi

echo "--- Test: 156 claimed paths all present -> OK ---"
PR_FILES_156=""
CLAIMS_156=""
i=1
while [ "$i" -le 156 ]; do
  path=$(printf 'src/large-pr/file-%03d.ts' "$i")
  PR_FILES_156="${PR_FILES_156}${path}"$'\n'
  if [ -n "$CLAIMS_156" ]; then
    CLAIMS_156="${CLAIMS_156}, "
  fi
  CLAIMS_156="${CLAIMS_156}${path}"
  i=$((i + 1))
done
PR_FILES_156=${PR_FILES_156%$'\n'}
MANIFEST=$(printf 'Files created: %s\nFiles modified: none\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/908' "$CLAIMS_156")
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/908" "$MANIFEST" "$PR_FILES_156")
CODE=$?
set -e
if [ "$CODE" -eq 0 ] && printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: over_100_files_all_claimed_passes"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: over_100_files_all_claimed_passes"
  echo "$OUT"
fi

echo "--- Test: claimed path beyond position 100 missing -> fail ---"
MISSING_PATH="src/large-pr/file-156.ts"
PR_FILES_155=$(printf '%s\n' "$PR_FILES_156" | sed '$d')
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/908" "$MANIFEST" "$PR_FILES_155")
CODE=$?
set -e
if [ "$CODE" -ne 0 ] && printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR' &&
   printf '%s\n' "$OUT" | grep -Fq "$MISSING_PATH"; then
  PASS=$((PASS + 1))
  echo "PASS: over_100_files_one_missing_fails"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: over_100_files_one_missing_fails"
  echo "$OUT"
fi

# WO-HARNESS-MANIFEST-CONSISTENCY-BRACKET-PATHS-01
# Bracketed Next.js routes must compare as literal strings.
echo "--- Test: bracketed Next.js paths match verbatim ---"
MANIFEST=$'Files created: none\nFiles modified: app/shops/[shopSlug]/bundles/page.tsx, app/api/auth/[...nextauth]/route.ts\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/221'
PR_PAYLOAD=$'app/shops/[shopSlug]/bundles/page.tsx\napp/api/auth/[...nextauth]/route.ts'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/221" "$MANIFEST" "$PR_PAYLOAD")
CODE=$?
set -e
assert_eq "bracketed next.js paths exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when bracketed Next.js paths match"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for bracketed Next.js paths"
  echo "$OUT"
fi

echo "--- Test: literal bracket directory matches, decoy does not ---"
MANIFEST=$'Files created: none\nFiles modified: lib/[tmp]/file.ts\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
PR_PAYLOAD=$'lib/t/file.ts\nlib/[tmp]/file.ts'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "$PR_PAYLOAD")
CODE=$?
set -e
assert_eq "literal bracket path exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when literal bracket directory is present"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for literal bracket directory"
  echo "$OUT"
fi

MANIFEST=$'Files created: none\nFiles modified: lib/[tmp]/file.ts\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "lib/t/file.ts")
CODE=$?
set -e
assert_nonzero "bracket decoy is not a match" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR' &&
   printf '%s\n' "$OUT" | grep -Fxq 'lib/[tmp]/file.ts'; then
  PASS=$((PASS + 1))
  echo "PASS: decoy lib/t/file.ts does not satisfy lib/[tmp]/file.ts"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: bracket path was treated as a character class or not reported"
  echo "$OUT"
fi

echo "--- Test: absent bracketed path fails and lists are verbatim ---"
MANIFEST=$'Files created: none\nFiles modified: app/shops/[shopSlug]/missing.tsx\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/221'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/221" "$MANIFEST" "app/shops/[shopSlug]/page.tsx")
CODE=$?
set -e
assert_nonzero "absent bracketed path non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR' &&
   printf '%s\n' "$OUT" | grep -Fxq 'CLAIMED_PATHS' &&
   printf '%s\n' "$OUT" | grep -Fxq 'app/shops/[shopSlug]/missing.tsx' &&
   printf '%s\n' "$OUT" | grep -Fxq 'PR_FILES' &&
   printf '%s\n' "$OUT" | grep -Fxq 'app/shops/[shopSlug]/page.tsx' &&
   ! printf '%s\n' "$OUT" | grep -Fxq 'app/shops/'; then
  PASS=$((PASS + 1))
  echo "PASS: absent bracketed path printed in full under CLAIMED_PATHS and PR_FILES"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: absent bracketed path truncated or lists not verbatim"
  echo "$OUT"
fi

echo "--- Test: path with spaces matches verbatim ---"
MANIFEST=$'Files created: none\nFiles modified: docs/My Notes/read me.md\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "docs/My Notes/read me.md")
CODE=$?
set -e
assert_eq "spaced path exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$'; then
  PASS=$((PASS + 1))
  echo "PASS: OK when path with spaces matches"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: expected OK for path with spaces"
  echo "$OUT"
fi

echo "--- Test: glob metacharacter is literal, not expanded ---"
MANIFEST=$'Files created: src/*.ts\nFiles modified: none\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "src/a.ts")
CODE=$?
set -e
assert_nonzero "literal glob claim non-zero" "$CODE"
if printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR' &&
   printf '%s\n' "$OUT" | grep -Fxq 'src/*.ts'; then
  PASS=$((PASS + 1))
  echo "PASS: src/*.ts stays literal and does not match src/a.ts"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: glob metacharacter was expanded or matched"
  echo "$OUT"
fi

echo "--- Test: ALREADY_SATISFIED none/none skips real PR files ---"
MANIFEST=$'Files created: none\nFiles modified: none\nOutcome: ALREADY_SATISFIED\nPRs: https://github.com/thinmansoftware/bdc-harness/pull/999'
set +e
OUT=$(run_pr_check "https://github.com/thinmansoftware/bdc-harness/pull/999" "$MANIFEST" "some/real/file.ts")
CODE=$?
set -e
assert_eq "already-satisfied none exit 0" "0" "$CODE"
if printf '%s\n' "$OUT" | grep -q '^OK$' &&
   ! printf '%s\n' "$OUT" | grep -q 'PR_CONTENT_ERROR'; then
  PASS=$((PASS + 1))
  echo "PASS: none + ALREADY_SATISFIED does not claim PR files"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: ALREADY_SATISFIED none case tripped the check"
  echo "$OUT"
fi

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
