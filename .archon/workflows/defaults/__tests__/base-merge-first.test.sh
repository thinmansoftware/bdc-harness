#!/usr/bin/env bash
# Unit tests for bdc_base_merge_first and bdc_run_changed_paths.
# The functions are extracted from the lane YAML; these tests run them against
# temporary git repositories.

set -uo pipefail

PASS=0
FAIL=0
REAL_GIT=$(command -v git)
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEFAULTS_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
CANONICAL_YAML="$DEFAULTS_DIR/bdc-feature-development-cursor.yaml"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

LANES=(
  bdc-feature-development.yaml
  bdc-feature-development-astra.yaml
  bdc-feature-development-codex-only.yaml
  bdc-feature-development-codex.yaml
  bdc-feature-development-cursor.yaml
  bdc-feature-development-fable.yaml
  bdc-feature-development-fusion-cx-kimi.yaml
  bdc-feature-development-fusion-cx-qwen.yaml
  bdc-feature-development-grok.yaml
  bdc-feature-development-kimi-k3.yaml
  bdc-feature-development-zero-claude.yaml
  bdc-feature-development-zero-open.yaml
  bdc-feature-development-zero.yaml
)

extract_marked() {
  sed -n '/# ---- BEGIN base-merge-first ----/,/# ---- END base-merge-first ----/p' "$1" | sed '1d;$d;s/^      //'
}

# Lane parity is fatal and is not one of the three counted tests.
python3 - "$DEFAULTS_DIR" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
lanes = [
  "bdc-feature-development.yaml",
  "bdc-feature-development-astra.yaml",
  "bdc-feature-development-codex-only.yaml",
  "bdc-feature-development-codex.yaml",
  "bdc-feature-development-cursor.yaml",
  "bdc-feature-development-fable.yaml",
  "bdc-feature-development-fusion-cx-kimi.yaml",
  "bdc-feature-development-fusion-cx-qwen.yaml",
  "bdc-feature-development-grok.yaml",
  "bdc-feature-development-kimi-k3.yaml",
  "bdc-feature-development-zero-claude.yaml",
  "bdc-feature-development-zero-open.yaml",
  "bdc-feature-development-zero.yaml",
]

def bodies(text):
    name = "bdc_base_merge_first()"
    found = []
    i = 0
    n = len(text)
    while True:
        j = text.find(name, i)
        if j < 0:
            break
        k = j + len(name)
        while k < n and text[k] in " \t":
            k += 1
        if k < n and text[k] == "\n":
            k += 1
            while k < n and text[k] in " \t":
                k += 1
        if k >= n or text[k] != "{":
            i = j + len(name)
            continue
        p = k
        depth = 0
        state = "code"
        while p < n:
            c = text[p]
            if state == "squote":
                if c == "'":
                    state = "code"
                p += 1
                continue
            if state == "dquote":
                if c == "\\":
                    p += 2
                    continue
                if c == '"':
                    state = "code"
                p += 1
                continue
            if c == "'":
                state = "squote"
                p += 1
                continue
            if c == '"':
                state = "dquote"
                p += 1
                continue
            if c == "#":
                nl = text.find("\n", p)
                p = n if nl < 0 else nl + 1
                continue
            if c == "$" and p + 1 < n and text[p + 1] == "{":
                p += 2
                nest = 1
                while p < n and nest:
                    if text[p] == "{":
                        nest += 1
                    elif text[p] == "}":
                        nest -= 1
                    p += 1
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    found.append(text[j:p + 1])
                    i = p + 1
                    break
            p += 1
        else:
            raise SystemExit("unterminated bdc_base_merge_first")
    return found

begin = "# ---- BEGIN base-merge-first ----"
end = "# ---- END base-merge-first ----"
canonical = None
canon_body = None
for lane in lanes:
    file = root / lane
    text = file.read_text()
    if text.count(begin) != 1 or text.count(end) != 1:
        raise SystemExit(f"FATAL: {lane} marker count BEGIN={text.count(begin)} END={text.count(end)}")
    block = text[text.find(begin):text.find(end) + len(end)]
    if canonical is None:
        canonical = block
    elif block != canonical:
        raise SystemExit(f"FATAL: marked block differs in {lane}")
    found = bodies(text)
    if len(found) != 3:
        raise SystemExit(f"FATAL: {lane} has {len(found)} bdc_base_merge_first definitions")
    in_block = bodies(block)
    if len(in_block) != 1:
        raise SystemExit(f"FATAL: {lane} marked block has {len(in_block)} definitions")
    if canon_body is None:
        canon_body = in_block[0]
    for body in found:
        if body != canon_body:
            raise SystemExit(f"FATAL: unmarked bdc_base_merge_first body differs in {lane}")
print("lane parity ok")
PY

BLOCK=$(extract_marked "$CANONICAL_YAML")
[ -n "$BLOCK" ] || { echo "FATAL: could not extract marked block"; exit 1; }
eval "$BLOCK"

configure_repo() {
  "$REAL_GIT" config user.email test@example.com
  "$REAL_GIT" config user.name "BDC Test"
  "$REAL_GIT" config commit.gpgsign false
}

make_repo() {
  local root="$1"
  mkdir -p "$root"
  "$REAL_GIT" init -q -b dev "$root/work"
  (
    cd "$root/work"
    configure_repo
    printf 'root\n' > README
    "$REAL_GIT" add README
    "$REAL_GIT" commit -q -m 'base'
    "$REAL_GIT" init -q --bare "$root/origin.git"
    "$REAL_GIT" remote add origin "$root/origin.git"
    "$REAL_GIT" push -q -u origin dev
  )
}

echo "--- Test 1: clean merge then push ---"
R1="$TMP_ROOT/t1"
make_repo "$R1"
(
  cd "$R1/work"
  "$REAL_GIT" checkout -q -b feature
  printf 'run\n' > file-a.txt
  "$REAL_GIT" add file-a.txt
  "$REAL_GIT" commit -q -m 'run adds A'
  PRE=$("$REAL_GIT" rev-parse HEAD)
  PRE_TREE=$("$REAL_GIT" rev-parse "${PRE}^{tree}")
  "$REAL_GIT" push -q origin HEAD:feature
  "$REAL_GIT" checkout -q dev
  printf 'base\n' > file-b.txt
  "$REAL_GIT" add file-b.txt
  "$REAL_GIT" commit -q -m 'base adds B'
  DEV=$("$REAL_GIT" rev-parse HEAD)
  "$REAL_GIT" push -q origin dev
  "$REAL_GIT" checkout -q feature
  export ARTIFACTS_DIR="$R1/artifacts"
  mkdir -p "$ARTIFACTS_DIR"
  bdc_base_merge_first dev
  HEAD_NOW=$("$REAL_GIT" rev-parse HEAD)
  PARENT1=$("$REAL_GIT" rev-parse 'HEAD^1')
  PARENT2=$("$REAL_GIT" rev-parse 'HEAD^2')
  ORIGIN_DEV=$("$REAL_GIT" rev-parse 'origin/dev')
  RECORDED=$(tr -d '[:space:]' < "$ARTIFACTS_DIR/base-merged-sha.txt")
  "$REAL_GIT" push -q origin HEAD:feature
  REMOTE=$("$REAL_GIT" --git-dir "$R1/origin.git" rev-parse 'refs/heads/feature')
  AFTER_TREE=$("$REAL_GIT" rev-parse "${PRE}^{tree}")
  if [ "$PARENT1" = "$PRE" ] && [ "$PARENT2" = "$ORIGIN_DEV" ] && [ "$PARENT2" = "$DEV" ] \
    && [ "$RECORDED" = "$HEAD_NOW" ] && [ "${base_merged_sha:-}" = "$HEAD_NOW" ] \
    && [ "$REMOTE" = "$HEAD_NOW" ] && [ "$AFTER_TREE" = "$PRE_TREE" ]; then
    exit 0
  else
    echo "PARENT1=$PARENT1 PRE=$PRE PARENT2=$PARENT2 ORIGIN_DEV=$ORIGIN_DEV DEV=$DEV" >&2
    echo "RECORDED=$RECORDED HEAD=$HEAD_NOW REMOTE=$REMOTE exported=${base_merged_sha:-}" >&2
    exit 1
  fi
)
if [ $? -eq 0 ]; then
  pass "clean merge records HEAD and pushes that sha"
else
  fail "clean merge records HEAD and pushes that sha"
fi

echo "--- Test 2: conflict means no push and recorded paths ---"
R2="$TMP_ROOT/t2"
make_repo "$R2"
CONFLICT_PATH='packages/workflows/src/defaults/bundled-defaults.generated.ts'
(
  cd "$R2/work"
  mkdir -p packages/workflows/src/defaults
  printf 'line-one\nline-two\n' > "$CONFLICT_PATH"
  "$REAL_GIT" add "$CONFLICT_PATH"
  "$REAL_GIT" commit -q -m 'add bundle'
  "$REAL_GIT" push -q origin dev
  "$REAL_GIT" checkout -q -b feature
  printf 'feature-one\nline-two\n' > "$CONFLICT_PATH"
  "$REAL_GIT" add "$CONFLICT_PATH"
  "$REAL_GIT" commit -q -m 'feature edits bundle'
  "$REAL_GIT" push -q origin HEAD:feature
  TIP_BEFORE=$("$REAL_GIT" --git-dir "$R2/origin.git" rev-parse 'refs/heads/feature')
  "$REAL_GIT" checkout -q dev
  printf 'base-one\nline-two\n' > "$CONFLICT_PATH"
  "$REAL_GIT" add "$CONFLICT_PATH"
  "$REAL_GIT" commit -q -m 'base edits bundle'
  "$REAL_GIT" push -q origin dev
  "$REAL_GIT" checkout -q feature
  export ARTIFACTS_DIR="$R2/artifacts"
  mkdir -p "$ARTIFACTS_DIR"
  set +e
  OUT=$(bdc_base_merge_first dev 2>"$R2/err")
  STATUS=$?
  set -e
  TIP_AFTER=$("$REAL_GIT" --git-dir "$R2/origin.git" rev-parse 'refs/heads/feature')
  DIRTY=$("$REAL_GIT" status --porcelain)
  if "$REAL_GIT" rev-parse --verify --quiet MERGE_HEAD >/dev/null 2>&1; then
    MID=yes
  else
    MID=no
  fi
  LINE="base_merge_conflict=${CONFLICT_PATH}"
  if [ "$STATUS" -ne 0 ] && [ -f "$ARTIFACTS_DIR/base-merge-conflict.txt" ] \
    && grep -qx "$LINE" "$ARTIFACTS_DIR/base-merge-conflict.txt" \
    && printf '%s\n' "$OUT" | grep -qx "$LINE" \
    && [ -z "$DIRTY" ] && [ "$MID" = "no" ] && [ "$TIP_BEFORE" = "$TIP_AFTER" ]; then
    exit 0
  else
    echo "STATUS=$STATUS DIRTY=$(printf '%s' "$DIRTY") MID=$MID TIP_BEFORE=$TIP_BEFORE TIP_AFTER=$TIP_AFTER" >&2
    echo "OUT=$OUT" >&2
    echo "ERR=$(cat "$R2/err" 2>/dev/null)" >&2
    exit 1
  fi
)
if [ $? -eq 0 ]; then
  pass "conflict records paths and does not push"
else
  fail "conflict records paths and does not push"
fi

echo "--- Test 4: scope record carries base_merged_sha ---"
R4="$TMP_ROOT/t4"
make_repo "$R4"
(
  cd "$R4/work"
  START=$("$REAL_GIT" rev-parse HEAD)
  "$REAL_GIT" checkout -q -b feature
  printf 'only-a\n' > file-a.txt
  "$REAL_GIT" add file-a.txt
  "$REAL_GIT" commit -q -m 'run adds A'
  FEATURE_TIP=$("$REAL_GIT" rev-parse HEAD)
  "$REAL_GIT" checkout -q dev
  printf 'only-b\n' > file-b.txt
  "$REAL_GIT" add file-b.txt
  "$REAL_GIT" commit -q -m 'base adds B'
  "$REAL_GIT" push -q origin dev
  "$REAL_GIT" checkout -q feature
  export ARTIFACTS_DIR="$R4/artifacts"
  mkdir -p "$ARTIFACTS_DIR"
  printf '%s\n' "$START" > "$ARTIFACTS_DIR/run-start-sha.txt"
  bdc_base_merge_first dev
  MERGED=$(bdc_run_changed_paths)
  rm -f "$ARTIFACTS_DIR/base-merged-sha.txt"
  FALLBACK=$(bdc_run_changed_paths)
  EXPECT_FALLBACK=$("$REAL_GIT" diff --name-only "$START" HEAD)
  printf '%s\n' "$FEATURE_TIP" > "$ARTIFACTS_DIR/base-merged-sha.txt"
  set +e
  NONMERGE=$(bdc_run_changed_paths 2>"$R4/nonmerge.err")
  NONMERGE_STATUS=$?
  set -e
  MERGED_OK=no
  if [ "$MERGED" = "file-a.txt" ] && ! printf '%s\n' "$MERGED" | grep -qx 'file-b.txt'; then
    MERGED_OK=yes
  fi
  if [ "$MERGED_OK" = "yes" ] && [ "$FALLBACK" = "$EXPECT_FALLBACK" ] \
    && printf '%s\n' "$FALLBACK" | grep -qx 'file-b.txt' \
    && [ "$NONMERGE_STATUS" -eq 0 ] && [ "$NONMERGE" = "$EXPECT_FALLBACK" ]; then
    exit 0
  else
    echo "MERGED=$MERGED" >&2
    echo "FALLBACK=$FALLBACK" >&2
    echo "EXPECT=$EXPECT_FALLBACK" >&2
    echo "NONMERGE_STATUS=$NONMERGE_STATUS NONMERGE=$NONMERGE" >&2
    exit 1
  fi
)
if [ $? -eq 0 ]; then
  pass "changed paths use merge second parent and fall back safely"
else
  fail "changed paths use merge second parent and fall back safely"
fi

echo ""
echo "$PASS passing / $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
