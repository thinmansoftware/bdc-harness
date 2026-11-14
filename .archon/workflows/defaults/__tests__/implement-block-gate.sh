#!/usr/bin/env bash
# implement-block-gate.sh -- tests for the implement-block-gate node and the block path it feeds
# (WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01, Tests 5, 7, 8 and 10).
#
# For each of the 13 bdc-feature-development lanes the REAL node scripts are extracted from the lane
# YAML (implement-block-gate, block-classify, block-reclassify, blocked-issue, blocked-terminal-gate),
# node outputs are substituted into them as the engine does ($node.output replaced by the text),
# and they run against fixtures with a stub gh on PATH.
#
# Run: bash .archon/workflows/defaults/__tests__/implement-block-gate.sh
# Final line: "<n> passing / <n> total". Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi; }
has()   { if printf '%s\n' "$3" | grep -Fq -- "$2"; then ok "$1"; else bad "$1" "missing [$2] in: $3"; fi; }
hasnt() { if printf '%s\n' "$3" | grep -Fq -- "$2"; then bad "$1" "unexpected [$2] in: $3"; else ok "$1"; fi; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v python3 >/dev/null 2>&1 || { echo "python3 is required"; exit 1; }

# node_script <lane-yaml> <node-id> <subs-file>: the node's bash script with outputs substituted.
# subs-file lines: "<node-id><TAB><text>", a literal backslash-n in the text becomes a newline.
node_script() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys, yaml, shlex
lane, nid, subs = sys.argv[1:4]
nodes = yaml.safe_load(open(lane, encoding='utf-8'))['nodes']
n = next((x for x in nodes if x['id'] == nid), None)
if n is None or 'bash' not in n:
    print('echo missing-node-%s >&2; exit 99' % nid)
    sys.exit(0)
body = n['bash']
mapping = {}
for line in open(subs, encoding='utf-8').read().split('\n'):
    if '\t' not in line:
        continue
    k, v = line.split('\t', 1)
    mapping[k] = v.replace('\\n', '\n')
# As the engine does: a token alone on a line (a heredoc body) is substituted raw; a token used in an
# assignment or an argument is substituted single-quoted.
out_lines = []
for l in body.split('\n'):
    for k, v in mapping.items():
        tok = '$' + k + '.output'
        if tok in l:
            if l.strip() == tok:
                l = l.replace(tok, v)
            else:
                l = l.replace(tok, shlex.quote(v))
    out_lines.append(l)
print('\n'.join(out_lines))
PY
}

json_ok() { printf '%s' "$1" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' >/dev/null 2>&1; }

# stub gh: records every call
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_REC"
exit 0
STUB
chmod +x "$WORK/bin/gh"
export GH_REC="$WORK/gh.rec"

# a git repo for block-reclassify (it inspects the worktree)
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q 2>/dev/null
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name t
git -C "$REPO" config core.autocrlf false
git -C "$REPO" commit -q --allow-empty -m init 2>/dev/null

run_gate() { # run_gate <script> <artifacts-dir|UNSET>  -> OUT, RC
  if [ "$2" = "UNSET" ]; then
    OUT="$(cd "$REPO" && env -u ARTIFACTS_DIR bash "$1" 2>&1)"
  else
    OUT="$(cd "$REPO" && ARTIFACTS_DIR="$2" bash "$1" 2>&1)"
  fi
  RC=$?
}

chain() { # chain <lane> <gate-output> <build-text> <diff-text>  -> CL RC1 TG TGRC and GH_REC
  local lane="$1" gate="$2" build="$3" diff="$4" s="$WORK/subs"
  : > "$GH_REC"
  printf 'diff-review-final\t%s\n' "$diff" > "$s"
  printf 'assert-implement-produced-work\t%s\n' "$build" >> "$s"
  printf 'gate-already-satisfied\t{}\n' >> "$s"
  printf 'implement-block-gate\t%s\n' "$gate" >> "$s"
  node_script "$lane" block-classify "$s" > "$WORK/bc.sh"
  CL="$(cd "$REPO" && bash "$WORK/bc.sh" 2>&1)"
  printf 'block-classify\t%s\n' "$CL" > "$s"
  printf 'opus-repair\t\n' >> "$s"
  printf 'classify-opus-rereview\t\n' >> "$s"
  node_script "$lane" block-reclassify "$s" > "$WORK/br.sh"
  RC1="$(cd "$REPO" && bash "$WORK/br.sh" 2>&1)"
  printf 'block-reclassify\t%s\n' "$RC1" > "$s"
  printf 'read-spec\tWO_ID=WO-FIX-01\n' >> "$s"
  node_script "$lane" blocked-issue "$s" > "$WORK/bi.sh"
  (cd "$REPO" && PATH="$WORK/bin:$PATH" USER_MESSAGE="issue=5970" bash "$WORK/bi.sh" >/dev/null 2>&1)
  node_script "$lane" blocked-terminal-gate "$s" > "$WORK/bt.sh"
  TG="$(cd "$REPO" && PATH="$WORK/bin:$PATH" bash "$WORK/bt.sh" 2>&1)"
  TGRC=$?
}
labeled() { grep -q 'issue edit 5970 .*--add-label status:blocked' "$GH_REC" 2>/dev/null && echo yes || echo no; }
# Three lanes (fusion-cx-kimi, fusion-cx-qwen, kimi-k3) have no blocked-issue node at all, so a blocked
# run there is never labeled (existing behaviour, not changed here); the label check then only records it.
HAS_BI=1
want_label() { # want_label <name> <yes|no>
  if [ "$HAS_BI" = "0" ]; then ok "$1 (this lane has no blocked-issue node)"; else check "$1" "$2" "$(labeled)"; fi
}

GOOD_BUILD='BUILD_OUTCOME=REAL_BUILD\nCHANGED_FILES=2'
GOOD_DIFF='DIFF_REVIEW_FINAL=satisfied'
CLEAN_BUILD='BUILD_OUTCOME=FALSE_COMPLETE\nCHANGED_FILES=0'
CLEAN_DIFF='DIFF_REVIEW_FINAL=needs_revision'

for LANEFILE in "$DEFAULTS"/bdc-feature-development*.yaml; do
  L="$(basename "$LANEFILE" .yaml | sed 's/^bdc-feature-development//; s/^-//')"
  [ -n "$L" ] || L=base
  echo "---- lane: $L"
  if grep -q '^  - id: blocked-issue' "$LANEFILE"; then HAS_BI=1; else HAS_BI=0; fi
  : > "$WORK/empty.subs"
  node_script "$LANEFILE" implement-block-gate "$WORK/empty.subs" > "$WORK/gate.sh"

  # ---- Test 5: the gate reads the engine's blocked-preserve record -------------------------
  A="$WORK/art-a"; rm -rf "$A"; mkdir -p "$A"
  run_gate "$WORK/gate.sh" "$A"
  check "T5 $L (a) no blocked-preserve folder" '{"terminal":"no"}' "$OUT"; check "T5 $L (a) exit 0" 0 "$RC"

  B="$WORK/art-b"; rm -rf "$B"; mkdir -p "$B/blocked-preserve/implement-iter-1"
  printf 'workflow_run_id=r1\nnode_id=implement\niteration=1\nblocked_reason=The plan needs "John" decision and $HOME and a back\\slash and it'"'"'s long\npreserved_at=now\n' > "$B/blocked-preserve/implement-iter-1/blocked-reason.txt"
  run_gate "$WORK/gate.sh" "$B"
  check "T5 $L (b) exit 0" 0 "$RC"
  has "T5 $L (b) terminal yes" '{"terminal":"yes","reason":"' "$OUT"
  json_ok "$OUT" && ok "T5 $L (b) valid JSON" || bad "T5 $L (b) invalid JSON" "$OUT"
  has "T5 $L (b) the reason text is kept" 'The plan needs John decision' "$OUT"
  hasnt "T5 $L (b) no backslash in the reason" '\' "$OUT"
  hasnt "T5 $L (b) no dollar sign in the reason" '$' "$OUT"
  hasnt "T5 $L (b) no apostrophe in the reason" "'" "$OUT"
  check "T5 $L (b) one line" 1 "$(printf '%s\n' "$OUT" | grep -c .)"

  C="$WORK/art-c"; rm -rf "$C"; mkdir -p "$C/blocked-preserve/plan-review-iter-1"
  echo 'blocked_reason=plan' > "$C/blocked-preserve/plan-review-iter-1/blocked-reason.txt"
  run_gate "$WORK/gate.sh" "$C"
  check "T5 $L (c) only another node's block" '{"terminal":"no"}' "$OUT"

  D="$WORK/art-d"; rm -rf "$D"; mkdir -p "$D/blocked-preserve/implement-iter-1" "$D/blocked-preserve/implement-iter-2"
  echo 'blocked_reason=first' > "$D/blocked-preserve/implement-iter-1/blocked-reason.txt"
  echo 'blocked_reason=second' > "$D/blocked-preserve/implement-iter-2/blocked-reason.txt"
  run_gate "$WORK/gate.sh" "$D"
  has "T5 $L (d) two iterations is terminal yes" '"terminal":"yes"' "$OUT"
  json_ok "$OUT" && ok "T5 $L (d) valid JSON" || bad "T5 $L (d) invalid JSON" "$OUT"

  run_gate "$WORK/gate.sh" "$WORK/does-not-exist"
  check "T5 $L (e) unreadable artifacts folder" '{"terminal":"no"}' "$OUT"; check "T5 $L (e) exit 0" 0 "$RC"
  run_gate "$WORK/gate.sh" UNSET
  check "T5 $L (e) ARTIFACTS_DIR unset" '{"terminal":"no"}' "$OUT"; check "T5 $L (e) unset exit 0" 0 "$RC"

  # ---- Test 8: the gate is idempotent ---------------------------------------------------------
  run_gate "$WORK/gate.sh" "$B"; FIRST="$OUT"
  run_gate "$WORK/gate.sh" "$B"
  check "T8 $L gate prints the same line twice" "$FIRST" "$OUT"

  # ---- Test 10: a missing or unparseable gate output ends BLOCKED with a reason ----------------
  for g in '' 'garbage'; do
    chain "$LANEFILE" "$g" "$GOOD_BUILD" "$GOOD_DIFF"
    tag="gate='${g:-empty}'"
    has "T10 $L $tag block-classify says BLOCKED" '"status":"BLOCKED"' "$CL"
    has "T10 $L $tag block-classify note" '"note":"implement_block_gate_missing"' "$CL"
    json_ok "$CL" && ok "T10 $L $tag block-classify output is valid JSON" || bad "T10 $L $tag block-classify output is not JSON" "$CL"
    check "T10 $L $tag block-reclassify keeps the note" '{"status":"BLOCKED","note":"implement_block_gate_missing"}' "$RC1"
    want_label "T10 $L $tag blocked-issue labels status:blocked" yes
    check "T10 $L $tag blocked-terminal-gate exits 1" 1 "$TGRC"
    has "T10 $L $tag build_blocked names the reason" 'build_blocked: BLOCKED implement_block_gate_missing' "$TG"
  done
  # gate says no: exactly as today (good build, satisfied review -> PROCEED)
  chain "$LANEFILE" '{"terminal":"no"}' "$GOOD_BUILD" "$GOOD_DIFF"
  has "T10 $L gate=no block-classify PROCEED" '"status":"PROCEED"' "$CL"
  hasnt "T10 $L gate=no no note" '"note"' "$CL"
  check "T10 $L gate=no block-reclassify PROCEED" '{"status":"PROCEED"}' "$RC1"
  want_label "T10 $L gate=no no blocked label" no
  check "T10 $L gate=no blocked-terminal-gate exits 0" 0 "$TGRC"
  # gate says yes on a GOOD build: BLOCKED with the reason
  chain "$LANEFILE" '{"terminal":"yes","reason":"x"}' "$GOOD_BUILD" "$GOOD_DIFF"
  has "T10 $L gate=yes good build still BLOCKED" '"status":"BLOCKED"' "$CL"
  has "T10 $L gate=yes note" '"note":"implement_blocked: x"' "$CL"
  check "T10 $L gate=yes block-reclassify keeps the note" '{"status":"BLOCKED","note":"implement_blocked: x"}' "$RC1"
  want_label "T10 $L gate=yes blocked-issue labels status:blocked" yes
  check "T10 $L gate=yes blocked-terminal-gate exits 1" 1 "$TGRC"
  has "T10 $L gate=yes build_blocked names the reason" 'build_blocked: BLOCKED implement_blocked: x' "$TG"

  # ---- Test 7: the declared-blocker path still ends the run blocked ------------------------------
  chain "$LANEFILE" '{"terminal":"yes","reason":"x"}' "$CLEAN_BUILD" "$CLEAN_DIFF"
  has "T7 $L declared blocker, clean worktree: BLOCKED with the reason" '"note":"implement_blocked: x"' "$CL"
  check "T7 $L declared blocker: block-reclassify keeps the note" '{"status":"BLOCKED","note":"implement_blocked: x"}' "$RC1"
  want_label "T7 $L declared blocker: issue labeled status:blocked" yes
  check "T7 $L declared blocker: blocked-terminal-gate exits 1" 1 "$TGRC"
  chain "$LANEFILE" '{"terminal":"no"}' "$CLEAN_BUILD" "$CLEAN_DIFF"
  has "T7 $L gate no, clean worktree: BLOCKED as today" '"status":"BLOCKED"' "$CL"
  hasnt "T7 $L gate no: no note" '"note"' "$CL"
  check "T7 $L gate no: block-reclassify as today" '{"status":"BLOCKED","note":"opus-could-not-resolve"}' "$RC1"
  want_label "T7 $L gate no: issue labeled status:blocked" yes
  has "T7 $L gate no: build_blocked as today" 'build_blocked: BLOCKED opus-could-not-resolve' "$TG"
done

echo
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
