#!/usr/bin/env bash
# review-issue-gate.sh -- review-issue applies status:review only when
# manifest-evidence-check completed with OK and block-reclassify allows it.
#
# Run: bash .archon/workflows/defaults/__tests__/review-issue-gate.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

PASS=0
FAIL=0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"

REVIEW_LANES="
bdc-feature-development-astra.yaml
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-cursor.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-grok.yaml
bdc-feature-development.yaml
"

FLIP_LANES="
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
"

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

extract_review_issue_bash() {
  awk '
    $0 == "  - id: review-issue" { in_node=1; next }
    in_node && $0 == "    bash: |" { in_bash=1; next }
    in_node && in_bash && $0 ~ /^  - id: / { exit }
    in_node && in_bash {
      if (substr($0, 1, 6) == "      ") print substr($0, 7)
      else print
    }
  ' "$1"
}

record() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS $name"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $name"
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
export GH_LOG="$TMP/gh.log"
: > "$GH_LOG"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
exit 0
EOF
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"

BODY="$TMP/review-issue.body"
extract_review_issue_bash "$CANONICAL_YAML" > "$BODY"

prepare_copy() {
  local evidence="$1" reclassify="$2" dest="$3"
  awk -v evidence="$evidence" -v reclassify="$reclassify" '
    index($0, "$manifest-evidence-check.output") { print evidence; next }
    index($0, "$block-reclassify.output") { print reclassify; next }
    $0 == "READ_SPEC_OUT=$read-spec.output" { print "READ_SPEC_OUT=\"\""; next }
    { print }
  ' "$BODY" > "$dest"
}

run_scenario() {
  local name="$1" evidence="$2" reclassify="$3" mode="$4"
  local script="$TMP/${name}.sh"
  local out rc status=0
  : > "$GH_LOG"
  prepare_copy "$evidence" "$reclassify" "$script"
  out="$(USER_MESSAGE=issue=3593 bash "$script" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    status=1
  fi
  case "$mode" in
    skip)
      if ! printf '%s\n' "$out" | grep -Fq 'not marking'; then
        status=1
      fi
      if grep -Fq -- '--add-label status:review' "$GH_LOG"; then
        status=1
      fi
      ;;
    apply)
      if ! grep -F -- '--add-label status:review' "$GH_LOG" | grep -Fq '3593'; then
        status=1
      fi
      ;;
    *)
      status=1
      ;;
  esac
  record "$name" "$status"
}

if ! command -v python3 >/dev/null 2>&1 || [ ! -s "$BODY" ]; then
  record review-label-skipped-when-evidence-failed 1
  record review-label-applied-when-evidence-passed 1
  record review-label-skipped-on-reclassify-block 1
else
  run_scenario review-label-skipped-when-evidence-failed '' '{"status":"PROCEED"}' skip
  run_scenario review-label-applied-when-evidence-passed 'OK' '{"status":"PROCEED"}' apply
  run_scenario review-label-skipped-on-reclassify-block 'OK' '{"status":"BLOCKED"}' skip
fi

parity_status=0
RIG="$(extract_core "$CANONICAL_YAML" rig)"
if [ -z "$RIG" ]; then
  parity_status=1
fi
for lane in $REVIEW_LANES; do
  [ "$lane" = "bdc-feature-development-codex.yaml" ] && continue
  other="$(extract_core "$DEFAULTS/$lane" rig)"
  if [ "$RIG" != "$other" ]; then
    parity_status=1
  fi
done

expected_file="$TMP/expected-review-lanes.txt"
found_file="$TMP/found-review-lanes.txt"
printf '%s\n' $REVIEW_LANES | sed '/^$/d' | sort > "$expected_file"
: > "$found_file"
for f in "$DEFAULTS"/bdc-feature-development*.yaml; do
  if grep -qx '  - id: review-issue' "$f"; then
    basename "$f" >> "$found_file"
  fi
done
sort -o "$found_file" "$found_file"
if ! cmp -s "$expected_file" "$found_file"; then
  parity_status=1
fi

for lane in $FLIP_LANES; do
  f="$DEFAULTS/$lane"
  if [ ! -f "$f" ]; then
    parity_status=1
    continue
  fi
  if grep -q '  - id: review-issue' "$f" || grep -q 'rig core' "$f"; then
    parity_status=1
  fi
done

record lane-mirrors-stay-identical "$parity_status"

echo "review-issue-gate.sh: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
