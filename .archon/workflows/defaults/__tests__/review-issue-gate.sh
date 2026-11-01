#!/usr/bin/env bash
# review-issue-gate.sh -- a feature-development lane applies status:review only
# when manifest-evidence-check completed with OK and block-reclassify allows it.
#
# review-issue lanes gate inside the review-issue bash body.
# flip-notion bash lanes gate inside flip-notion and flip-notion-on-failure.
# flip-notion prompt lanes gate with when: $manifest-evidence-check.output == 'OK'.
# all_done still schedules the node; a false when skips it before the body runs.
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

FLIP_BASH_LANES="
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
"

FLIP_PROMPT_LANES="
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
"

CANONICAL_FLIP="$DEFAULTS/bdc-feature-development-fusion-cx-kimi.yaml"

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

extract_node_bash() {
  awk -v id="  - id: $2" '
    $0 == id { in_node=1; next }
    in_node && $0 == "    bash: |" { in_bash=1; next }
    in_node && in_bash && $0 ~ /^  - id: / { exit }
    in_node && in_bash {
      if (substr($0, 1, 6) == "      ") print substr($0, 7)
      else print
    }
  ' "$1"
}

extract_node_header() {
  awk -v id="  - id: $2" '
    $0 == id { in_node=1; next }
    in_node && ($0 == "    bash: |" || $0 == "    prompt: |") { exit }
    in_node { print }
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
extract_node_bash "$CANONICAL_YAML" review-issue > "$BODY"
FLIP_BODY="$TMP/flip-notion.body"
FAIL_BODY="$TMP/flip-notion-on-failure.body"
extract_node_bash "$CANONICAL_FLIP" flip-notion > "$FLIP_BODY"
extract_node_bash "$CANONICAL_FLIP" flip-notion-on-failure > "$FAIL_BODY"

prepare_copy() {
  local evidence="$1" reclassify="$2" dest="$3" src="$4"
  awk -v evidence="$evidence" -v reclassify="$reclassify" '
    index($0, "$manifest-evidence-check.output") { print evidence; next }
    index($0, "$block-reclassify.output") { print reclassify; next }
    index($0, "$war-council-validator.output") { print "Verdict: satisfied"; next }
    index($0, "$flip-notion.output") { print ""; next }
    $0 == "READ_SPEC_OUT=$read-spec.output" { print "READ_SPEC_OUT=\"\""; next }
    {
      gsub(/\$commit-and-push\.output/, "")
      gsub(/\$open-pr-if-needed\.output/, "")
      print
    }
  ' "$src" > "$dest"
}

run_scenario() {
  local name="$1" evidence="$2" reclassify="$3" mode="$4" src="$5"
  local script="$TMP/${name}.sh"
  local out rc status=0
  : > "$GH_LOG"
  prepare_copy "$evidence" "$reclassify" "$script" "$src"
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
    blocked)
      if grep -Fq -- '--add-label status:review' "$GH_LOG"; then
        status=1
      fi
      if ! grep -F -- '--add-label status:blocked' "$GH_LOG" | grep -Fq '3593'; then
        status=1
      fi
      ;;
    *)
      status=1
      ;;
  esac
  record "$name" "$status"
}

if ! command -v python3 >/dev/null 2>&1 || [ ! -s "$BODY" ] || [ ! -s "$FLIP_BODY" ] || [ ! -s "$FAIL_BODY" ]; then
  record review-label-skipped-when-evidence-failed 1
  record review-label-applied-when-evidence-passed 1
  record review-label-skipped-on-reclassify-block 1
  record flip-label-skipped-when-evidence-failed 1
  record flip-label-applied-when-evidence-passed 1
  record flip-label-blocked-skips-review 1
  record flip-fallback-skipped-when-evidence-failed 1
  record flip-fallback-applied-when-evidence-passed 1
else
  run_scenario review-label-skipped-when-evidence-failed '' '{"status":"PROCEED"}' skip "$BODY"
  run_scenario review-label-applied-when-evidence-passed 'OK' '{"status":"PROCEED"}' apply "$BODY"
  run_scenario review-label-skipped-on-reclassify-block 'OK' '{"status":"BLOCKED"}' skip "$BODY"
  run_scenario flip-label-skipped-when-evidence-failed '' '{"status":"PROCEED"}' skip "$FLIP_BODY"
  run_scenario flip-label-applied-when-evidence-passed 'OK' '{"status":"PROCEED"}' apply "$FLIP_BODY"
  run_scenario flip-label-blocked-skips-review 'OK' '{"status":"BLOCKED"}' blocked "$FLIP_BODY"
  run_scenario flip-fallback-skipped-when-evidence-failed '' '{"status":"PROCEED"}' skip "$FAIL_BODY"
  run_scenario flip-fallback-applied-when-evidence-passed 'OK' '{"status":"PROCEED"}' apply "$FAIL_BODY"
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

header_requires_evidence() {
  local header="$1"
  printf '%s\n' "$header" | grep -Eq 'depends_on:.*manifest-evidence-check' \
    && printf '%s\n' "$header" | grep -Fq "\$manifest-evidence-check.output == 'OK'"
}

FLIP_BASH="$(extract_node_bash "$CANONICAL_FLIP" flip-notion)"
FAIL_BASH="$(extract_node_bash "$CANONICAL_FLIP" flip-notion-on-failure)"
if [ -z "$FLIP_BASH" ] || [ -z "$FAIL_BASH" ]; then
  parity_status=1
fi
if ! printf '%s\n' "$FLIP_BASH" | grep -Fq 'manifest-evidence-check=${EVIDENCE:-<none>} -- not marking issue status:review.'; then
  parity_status=1
fi
if ! printf '%s\n' "$FAIL_BASH" | grep -Fq 'manifest-evidence-check=${EVIDENCE:-<none>} -- not marking issue status:review.'; then
  parity_status=1
fi

for lane in $FLIP_BASH_LANES; do
  f="$DEFAULTS/$lane"
  if [ ! -f "$f" ]; then
    parity_status=1
    continue
  fi
  if [ "$FLIP_BASH" != "$(extract_node_bash "$f" flip-notion)" ]; then
    parity_status=1
  fi
  if [ "$FAIL_BASH" != "$(extract_node_bash "$f" flip-notion-on-failure)" ]; then
    parity_status=1
  fi
  for node in flip-notion flip-notion-on-failure; do
    if ! header_requires_evidence "$(extract_node_header "$f" "$node")"; then
      parity_status=1
    fi
  done
done

for lane in $FLIP_PROMPT_LANES; do
  f="$DEFAULTS/$lane"
  if [ ! -f "$f" ]; then
    parity_status=1
    continue
  fi
  for node in flip-notion flip-notion-on-failure; do
    if ! header_requires_evidence "$(extract_node_header "$f" "$node")"; then
      parity_status=1
    fi
  done
done

classified="$TMP/classified-lanes.txt"
found_all="$TMP/found-all-lanes.txt"
{
  printf '%s\n' $REVIEW_LANES
  printf '%s\n' $FLIP_BASH_LANES
  printf '%s\n' $FLIP_PROMPT_LANES
} | sed '/^$/d' | sort > "$classified"
: > "$found_all"
for f in "$DEFAULTS"/bdc-feature-development*.yaml; do
  basename "$f" >> "$found_all"
done
sort -o "$found_all" "$found_all"
if ! cmp -s "$classified" "$found_all"; then
  parity_status=1
fi

record lane-mirrors-stay-identical "$parity_status"

echo "review-issue-gate.sh: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
