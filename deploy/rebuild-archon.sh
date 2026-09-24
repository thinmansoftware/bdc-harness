#!/usr/bin/env bash
# Single repo-tracked rebuild entry point for archon-app-1.
# Drains new Cauldron work, waits until recreateSafe, then rebuilds.
# ASCII only. Does not print the operator token.
set -euo pipefail

POLL_SEC=30
TIMEOUT_MIN=120
API_BASE="${REBUILD_API_BASE:-http://127.0.0.1:3090}"
LOCK_FILE="${REBUILD_LOCK_FILE:-/opt/bdc/archon-data/.rebuild.lock}"
REPO_DIR="${REBUILD_REPO_DIR:-/opt/bdc/archon}"
DB_PATH="${REBUILD_DB:-/opt/bdc/archon-data/archon.db}"
PRUNE_SCRIPT="${REBUILD_PRUNE_SCRIPT:-/opt/bdc/scripts/prune-rebuild-artifacts.sh}"

DRAIN_SET_BY_ME=0
RECREATED=0
TOKEN=""
ACTIVE_IDS=""

usage() {
  cat <<'EOF'
Usage: deploy/rebuild-archon.sh [--poll-sec N] [--drain-timeout-min N]

Drain Cauldron, wait until recreateSafe, then rebuild archon-app-1.

Exit codes:
  0  rebuild completed
  3  drain timed out before recreateSafe
  75 lock already held (LOCKED)
  1  guard abort (dirty tree, disk, sha mismatch, or health)
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

undrain_if_mine() {
  if [ "$DRAIN_SET_BY_ME" = "1" ] && [ "$RECREATED" = "0" ] && [ -n "$TOKEN" ]; then
    curl -sS -X POST "$API_BASE/api/admin/drain" \
      -H "Content-Type: application/json" \
      -H "x-archon-operator-token: $TOKEN" \
      -d '{"draining":false,"reason":"rebuild aborted"}' >/dev/null || true
  fi
}

on_abort() {
  undrain_if_mine
}
trap on_abort ERR INT TERM

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf '%s\n' LOCKED
  exit 75
fi

TOKEN="$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
USER_NAME="${USER:-unknown}"
REASON="rebuild ${STAMP} by ${USER_NAME}"

DRAIN_BODY="$(printf '{"draining":true,"clearOnBoot":true,"reason":"%s"}' "$REASON")"
DRAIN_RESP="$(curl -sS -X POST "$API_BASE/api/admin/drain" \
  -H "Content-Type: application/json" \
  -H "x-archon-operator-token: $TOKEN" \
  -d "$DRAIN_BODY")"
case "$DRAIN_RESP" in
  *'"changed":true'*|*'\"changed\":true'*) DRAIN_SET_BY_ME=1 ;;
  *) DRAIN_SET_BY_ME=0 ;;
esac

deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
ready=0
while true; do
  STATE="$(curl -sS "$API_BASE/api/admin/drain" \
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
  sleep "$POLL_SEC"
done

if [ "$ready" != "1" ]; then
  if [ "$DRAIN_SET_BY_ME" = "1" ]; then
    curl -sS -X POST "$API_BASE/api/admin/drain" \
      -H "Content-Type: application/json" \
      -H "x-archon-operator-token: $TOKEN" \
      -d '{"draining":false,"reason":"ABORT_DRAIN_TIMEOUT"}' >/dev/null || true
    DRAIN_SET_BY_ME=0
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
RECREATED=1
docker compose up -d app

health_deadline=$(( $(date +%s) + 120 ))
healthy=0
while [ "$(date +%s)" -lt "$health_deadline" ]; do
  if curl -sS -o /dev/null -w '%{http_code}' "$API_BASE/api/health" | grep -q '^200$'; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" != "1" ]; then
  printf '%s\n' ABORT_HEALTH
  exit 1
fi

POST_STATE="$(curl -sS "$API_BASE/api/admin/drain" \
  -H "x-archon-operator-token: $TOKEN")"
case "$POST_STATE" in
  *'"mode":"draining"'*)
    curl -sS -X POST "$API_BASE/api/admin/drain" \
      -H "Content-Type: application/json" \
      -H "x-archon-operator-token: $TOKEN" \
      -d '{"draining":false,"reason":"cleared after recreate"}' >/dev/null || true
    printf '%s\n' DRAIN_CLEARED_BY_SCRIPT
    ;;
esac

printf '%s\n' "docker tag archon:rollback-$STAMP archon:latest && docker compose up -d app"

docker builder prune -af
sh "$PRUNE_SCRIPT"

exit 0
