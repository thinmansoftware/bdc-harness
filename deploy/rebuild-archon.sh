#!/usr/bin/env bash
# Single repo-tracked rebuild entry point for archon-app-1.
# Drains new Cauldron work, waits until recreateSafe, then rebuilds.
# ASCII only. Does not print the operator token.
set -euo pipefail

POLL_SEC=30
TIMEOUT_MIN=120
# Seconds to wait for /api/health after recreate. Production leaves this unset
# (120). Tests may set REBUILD_HEALTH_TIMEOUT_SEC; that does not change the default.
HEALTH_TIMEOUT_SEC="${REBUILD_HEALTH_TIMEOUT_SEC:-120}"
API_BASE="${REBUILD_API_BASE:-http://127.0.0.1:3090}"
LOCK_FILE="${REBUILD_LOCK_FILE:-/opt/bdc/archon-data/.rebuild.lock}"
REPO_DIR="${REBUILD_REPO_DIR:-/opt/bdc/archon}"
DB_PATH="${REBUILD_DB:-/opt/bdc/archon-data/archon.db}"
PRUNE_SCRIPT="${REBUILD_PRUNE_SCRIPT:-/opt/bdc/scripts/prune-rebuild-artifacts.sh}"

DRAIN_SET_BY_ME=0
RECREATED=0
# 1 only after the replacement container's /api/health returns HTTP 200.
# Owned-drain cleanup stays eligible until then: `up -d` success is not boot.
CONFIRMED_BOOT=0
CLEANED=0
TOKEN=""
ACTIVE_IDS=""
CURL_MAX_TIME=30
PYTHON="${REBUILD_PYTHON:-python3}"
OWNED_DRAIN_TOKEN=""
ACQUISITION_PENDING=0

usage() {
  cat <<'EOF'
Usage: deploy/rebuild-archon.sh [--poll-sec N] [--drain-timeout-min N]

Drain Cauldron, wait until recreateSafe, then rebuild archon-app-1.

Exit codes:
  0  rebuild completed
  3  drain timed out before recreateSafe
  75 lock already held (LOCKED)
  1  guard or drain-request abort (dirty tree, disk, sha mismatch, health, or ABORT_DRAIN_REQUEST_FAILED)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --poll-sec)
      POLL_SEC="${2:-}"
      shift 2
      ;;
    --drain-timeout-min)
      TIMEOUT_MIN="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Strict acquisition parsing needs Python 3 on the host. Never guess ownership
# with sed or execute Docker/drain operations when this prerequisite is absent.
if ! command -v "$PYTHON" >/dev/null 2>&1 || ! "$PYTHON" -c 'import sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
  printf '%s\n' ABORT_PYTHON3_REQUIRED
  exit 1
fi

parse_drain_grant() {
  "$PYTHON" -c '
import json, sys, uuid
def strict(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out
def reject_constant(value):
    raise ValueError("non-finite constant")
try:
    row = json.load(sys.stdin, object_pairs_hook=strict, parse_constant=reject_constant)
    if not isinstance(row, dict) or row.get("success") is not True or type(row.get("changed")) is not bool or "acquiredDrainToken" not in row:
        raise ValueError("missing acquisition proof")
    token = row["acquiredDrainToken"]
    if row["changed"]:
        if not isinstance(token, str) or str(uuid.UUID(token)) != token:
            raise ValueError("invalid grant")
        print(token)
    else:
        if token is not None:
            raise ValueError("unowned grant")
        print("unowned")
except Exception:
    sys.exit(1)
'
}

json_escape() {
  # Escapes a string for safe use inside a JSON double-quoted value: backslash
  # and double-quote first (order matters -- escaping the backslash first
  # would double-escape the backslashes just added for the quote), then tab,
  # CR, and LF as JSON escapes. Other control characters JSON forbids raw
  # are dropped. USER is attacker-influenced in principle (any value the
  # running account's shell environment sets) and was previously interpolated
  # unescaped into DRAIN_BODY, which could inject JSON fields or read as
  # malformed JSON. Tab, CR, and LF must be escaped rather than deleted:
  # leaving them raw makes the drain body invalid JSON.
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\n'/\\n}"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  printf '%s' "$s"
}

clear_owned_drain() {
  [ "$DRAIN_SET_BY_ME" = "1" ] && [ -n "$OWNED_DRAIN_TOKEN" ] || return 1
  local body http reason
  reason="$(json_escape "$1")"
  body="$(printf '{"draining":false,"expectedDrainToken":"%s","reason":"%s"}' "$OWNED_DRAIN_TOKEN" "$reason")"
  http="$(curl -sS --max-time "$CURL_MAX_TIME" -o /dev/null -w '%{http_code}' \
    -X POST "$API_BASE/api/admin/drain" -H "Content-Type: application/json" \
    -H "x-archon-operator-token: $TOKEN" -d "$body")" || {
    printf '%s\n' DRAIN_CLEAR_UNCONFIRMED
    return 1
  }
  case "$http" in
    200) DRAIN_SET_BY_ME=0; OWNED_DRAIN_TOKEN=""; return 0 ;;
    409) DRAIN_SET_BY_ME=0; OWNED_DRAIN_TOKEN=""; printf '%s\n' DRAIN_OWNERSHIP_LOST; return 1 ;;
    *) printf '%s\n' DRAIN_CLEAR_UNCONFIRMED; return 1 ;;
  esac
}

undrain_if_mine() {
  # Gate on confirmed boot, not RECREATED. RECREATED flips as soon as
  # `up -d` returns, which is before clear-on-boot can run. A foreign drain
  # (DRAIN_SET_BY_ME=0) is never cleared.
  if [ "$DRAIN_SET_BY_ME" = "1" ] && [ "$CONFIRMED_BOOT" = "0" ] && [ -n "$TOKEN" ]; then
    clear_owned_drain 'rebuild aborted' || true
  fi
}

on_abort() {
  if [ "$CLEANED" = "1" ]; then
    return 0
  fi
  CLEANED=1
  if [ "$ACQUISITION_PENDING" = "1" ]; then
    printf '%s\n' ABORT_DRAIN_OWNERSHIP_UNKNOWN
  fi
  undrain_if_mine
}
trap 'status=$?; on_abort; exit "$status"' ERR
trap 'on_abort; exit 130' INT
trap 'on_abort; exit 143' TERM

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s\n' LOCKED
  exit 75
fi

TOKEN="$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)"

INITIAL_STATE="$(curl -sS --max-time "$CURL_MAX_TIME" "$API_BASE/api/admin/drain" \
  -H "x-archon-operator-token: $TOKEN")"
case "$INITIAL_STATE" in
  *'"mode":"draining"'*)
    # Someone else already drained (incident freeze or another operator).
    # Do not post clearOnBoot and do not clear it later.
    DRAIN_SET_BY_ME=0
    ;;
  *)
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    USER_NAME="${USER:-unknown}"
    REASON="rebuild ${STAMP} by ${USER_NAME}"
    REASON_JSON="$(json_escape "$REASON")"
    DRAIN_BODY="$(printf '{"draining":true,"clearOnBoot":true,"reason":"%s"}' "$REASON_JSON")"
    DRAIN_RESP_FILE="$(mktemp)"
    ACQUISITION_PENDING=1
    DRAIN_HTTP="$(curl -sS --max-time "$CURL_MAX_TIME" -o "$DRAIN_RESP_FILE" -w '%{http_code}' \
      -X POST "$API_BASE/api/admin/drain" \
      -H "Content-Type: application/json" \
      -H "x-archon-operator-token: $TOKEN" \
      -d "$DRAIN_BODY")" || {
      rm -f "$DRAIN_RESP_FILE"
      printf '%s\n' ABORT_DRAIN_REQUEST_FAILED
      printf '%s\n' ABORT_DRAIN_OWNERSHIP_UNKNOWN
      exit 1
    }
    DRAIN_RESP="$(cat "$DRAIN_RESP_FILE")"
    rm -f "$DRAIN_RESP_FILE"
    case "$DRAIN_HTTP" in
      200) ;;
      *)
        printf '%s\n' ABORT_DRAIN_REQUEST_FAILED
        printf '%s\n' ABORT_DRAIN_OWNERSHIP_UNKNOWN
        exit 1
        ;;
    esac
    GRANT="$(printf '%s' "$DRAIN_RESP" | parse_drain_grant)" || {
      printf '%s\n' ABORT_DRAIN_OWNERSHIP_UNKNOWN
      exit 1
    }
    if [ "$GRANT" != 'unowned' ]; then
      OWNED_DRAIN_TOKEN="$GRANT"
      DRAIN_SET_BY_ME=1
    fi
    ACQUISITION_PENDING=0
    ;;
esac

# STAMP is also used by the backup and rollback pin. A foreign drain skips
# the POST above, so mint it here when that path did not.
if [ -z "${STAMP:-}" ]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
fi

deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
ready=0
while true; do
  STATE="$(curl -sS --max-time "$CURL_MAX_TIME" "$API_BASE/api/admin/drain" \
    -H "x-archon-operator-token: $TOKEN")"
  RUNNING="$(printf '%s' "$STATE" | sed -n 's/.*"runningRunCount":\([0-9][0-9]*\).*/\1/p')"
  PENDING="$(printf '%s' "$STATE" | sed -n 's/.*"pendingRunCount":\([0-9][0-9]*\).*/\1/p')"
  ACTIVE_IDS="$(printf '%s' "$STATE" | sed -n 's/.*"activeRunIds":\(\[[^]]*\]\).*/\1/p')"
  printf 'poll runningRunCount=%s pendingRunCount=%s activeRunIds=%s\n' \
    "${RUNNING:-?}" "${PENDING:-?}" "${ACTIVE_IDS:-[]}"
  case "$STATE" in
    *'"recreateSafe":true'*)
      ready=1
      break
      ;;
  esac
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    break
  fi
  # wait is a builtin, so an INT/TERM trap runs now instead of being
  # deferred until an external sleep exits (and then falling through).
  if [ "$POLL_SEC" != "0" ]; then
    sleep "$POLL_SEC" &
    wait $! || true
  fi
done

if [ "$ready" != "1" ]; then
  if [ "$DRAIN_SET_BY_ME" = "1" ]; then
    clear_owned_drain 'ABORT_DRAIN_TIMEOUT' || true
  fi
  printf 'activeRunIds=%s\n' "${ACTIVE_IDS:-[]}"
  printf '%s\n' ABORT_DRAIN_TIMEOUT
  exit 3
fi

cd "$REPO_DIR"

DIRTY="$(git status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || { printf '%s\n' ABORT_DIRTY; false; }

sqlite3 "$DB_PATH" ".backup /tmp/archon.db.pre-rebuild-$STAMP"

docker tag "$(docker inspect archon-app-1 --format '{{.Image}}')" "archon:rollback-$STAMP"

git fetch origin dev
TARGET="$(git rev-parse --short origin/dev)"
git pull origin dev
HEAD_SHA="$(git rev-parse --short HEAD)"
[ "$HEAD_SHA" = "$TARGET" ] || { printf '%s\n' ABORT_SHA_MISMATCH; false; }

AVAIL="$(df --output=avail -BG / | tail -1 | tr -dc 0-9)"
[ "${AVAIL:-0}" -ge 15 ] || { printf '%s\n' ABORT_DISK; false; }

docker compose build app
docker compose up -d app
# RECREATED is set ONLY after `up -d` itself has returned success. Setting it
# earlier (Overseer review, bdc-harness#949 [major]) made a failed `up -d`
# look like a recreate. Drain cleanup does not key off RECREATED: it keys off
# CONFIRMED_BOOT, which stays 0 until /api/health returns 200. A non-zero
# `up -d` still hits the ERR trap before this assignment (`set -euo pipefail`).
RECREATED=1

health_deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SEC ))
healthy=0
while [ "$(date +%s)" -lt "$health_deadline" ]; do
  if curl -sS --max-time "$CURL_MAX_TIME" -o /dev/null -w '%{http_code}' "$API_BASE/api/health" | grep -q '^200$'; then
    # Close the cleanup gate before leaving the loop so a later abort cannot
    # release a drain once the replacement has actually booted.
    CONFIRMED_BOOT=1
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" != "1" ]; then
  # `exit` does not run the ERR trap. Release an owned drain explicitly.
  # CLEANED keeps a later trap from posting a second release.
  undrain_if_mine
  CLEANED=1
  printf '%s\n' ABORT_HEALTH
  exit 1
fi

POST_STATE="$(curl -sS --max-time "$CURL_MAX_TIME" "$API_BASE/api/admin/drain" \
  -H "x-archon-operator-token: $TOKEN")"
# Only clear a drain this invocation set. A foreign drain (already draining
# before we started, including an incident freeze) must still be draining
# after a successful rebuild.
if [ "$DRAIN_SET_BY_ME" = "1" ]; then
  case "$POST_STATE" in
    *'"mode":"draining"'*)
      if clear_owned_drain 'cleared after recreate'; then
        printf '%s\n' DRAIN_CLEARED_BY_SCRIPT
      fi
      ;;
  esac
fi

printf '%s\n' "docker tag archon:rollback-$STAMP archon:latest && docker compose up -d app"

docker builder prune -af
sh "$PRUNE_SCRIPT"

exit 0
