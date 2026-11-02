#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
hold_file="${ARCHON_REBUILD_HOLD_FILE:-/opt/bdc/archon/.rebuild-hold}"
stop_file="${ARCHON_REBUILD_STOP_FILE:-/opt/bdc/archon/.rebuild-stop}"
root="/opt/bdc/archon"
db="/opt/bdc/archon-data/archon.db"
backup_dir="/opt/bdc/backups/archon"
compose_backup_dir="${ARCHON_REBUILD_BACKUP_DIR:-/opt/bdc/backups/archon/compose}"

refuse_hold_or_stop() {
  if [ ! -f "$hold_file" ] && [ ! -f "$stop_file" ]; then
    return 0
  fi
  printf 'refusing to rebuild: hold or stop file present\n' >&2
  if [ -f "$hold_file" ]; then
    printf '%s\n' "$hold_file" >&2
    cat "$hold_file" >&2
  fi
  if [ -f "$stop_file" ]; then
    printf '%s\n' "$stop_file" >&2
    cat "$stop_file" >&2
  fi
  exit 11
}

if [ -f "$hold_file" ]; then
  printf 'refusing to build: rebuild hold present\n' >&2
  cat "$hold_file" >&2
  exit 10
fi

if [ -z "${TARGET:-}" ]; then
  printf 'refusing to rebuild: TARGET is required\n' >&2
  exit 12
fi

runs="$(sqlite3 "$db" "select count(*) from remote_agent_workflow_runs where status in ('running','pending')")" || exit $?
if ! [[ "$runs" =~ ^[0-9]+$ ]] || [ "$runs" != "0" ]; then
  printf 'refusing to rebuild: in-flight workflow runs %s\n' "$runs" >&2
  exit 13
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

drain_enabled=0
operator_token=""

disable_drain() {
  local entered="${1:-0}"
  if [ "$drain_enabled" != "1" ]; then
    return 0
  fi
  drain_enabled=0
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "x-archon-operator-token: ${operator_token}" \
    -H 'Content-Type: application/json' \
    -d '{"draining": false}' \
    "http://127.0.0.1:3090/api/admin/drain")" || code="$?"
  if [ "$code" = "200" ]; then
    printf 'drain_disabled\n' >&2
    return 0
  fi
  printf 'drain_disable_failed\n' >&2
  if [ "$entered" = "0" ]; then
    exit 18
  fi
  return 0
}

trap 'exit_status=$?; trap - EXIT; disable_drain "$exit_status"; exit "$exit_status"' EXIT

operator_token="$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)" || operator_token=""
if [ -z "$operator_token" ]; then
  printf 'refusing to rebuild: operator token unavailable\n' >&2
  exit 17
fi

enable_code="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "x-archon-operator-token: ${operator_token}" \
  -H 'Content-Type: application/json' \
  -d "{\"draining\": true, \"reason\": \"rebuild-archon-app ${STAMP}\"}" \
  "http://127.0.0.1:3090/api/admin/drain")" || enable_code="$?"
if [ "$enable_code" != "200" ]; then
  printf 'refusing to rebuild: drain enable status %s\n' "$enable_code" >&2
  exit 17
fi
drain_enabled=1
printf 'drain_enabled\n' >&2

cd "$root"

tracked="$(git status --porcelain --untracked-files=no)" || exit $?
if [ -n "$tracked" ]; then
  printf '%s\n' "$tracked" >&2
  exit 3
fi

mkdir -p "$compose_backup_dir"
cp docker-compose.yml "${compose_backup_dir}/docker-compose.yml.pre-rebuild-${STAMP}"
cp docker-compose.override.yml "${compose_backup_dir}/docker-compose.override.yml.pre-rebuild-${STAMP}"

sqlite3 "$db" ".backup ${backup_dir}/archon.db.pre-rebuild-${STAMP}" || exit $?
check="$(sqlite3 "$db" "pragma quick_check")" || exit $?
if [ "$check" != "ok" ]; then
  printf '%s\n' "$check" >&2
  exit 16
fi

docker tag archon:latest "archon:rollback-${STAMP}" || exit $?

PREV="$(git rev-parse HEAD)" || exit $?
git fetch origin dev || exit $?
git rev-parse --verify "${TARGET}^{commit}" >/dev/null || exit $?
git checkout --detach "$TARGET" || exit $?

refuse_hold_or_stop

bash "$here/build-app-image.sh" || exit $?

dispatch_sql="select count(*) from agent_dispatch_messages where status = 'claimed' and lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"
poll=1
while [ "$poll" -le 30 ]; do
  claimed="$(sqlite3 "$db" "$dispatch_sql")" || exit $?
  if ! [[ "$claimed" =~ ^[0-9]+$ ]]; then
    printf 'refusing to rebuild: dispatch claim count is not an integer: %s\n' "$claimed" >&2
    exit 14
  fi
  if [ "$claimed" = "0" ]; then
    break
  fi
  if [ "$poll" -eq 30 ]; then
    printf 'refusing to rebuild: dispatch claims still %s after 30 polls\n' "$claimed" >&2
    exit 14
  fi
  sleep 10
  poll=$((poll + 1))
done

refuse_hold_or_stop

drain_body_file="$(mktemp /tmp/archon-rebuild-drain.XXXXXX)"
drain_code="$(curl -sS -o "$drain_body_file" -w '%{http_code}' \
  -H "x-archon-operator-token: ${operator_token}" \
  "http://127.0.0.1:3090/api/admin/drain")" || drain_code="$?"
drain_body="$(cat "$drain_body_file")"
rm -f "$drain_body_file"
if [ "$drain_code" != "200" ]; then
  exit 12
fi

active_runs=""
active_leases=""
if [[ "$drain_body" =~ \"activeRunCount\"[[:space:]]*:[[:space:]]*([0-9]+)[[:space:]]*[,}] ]]; then
  active_runs="${BASH_REMATCH[1]}"
elif [[ "$drain_body" =~ \"activeRunCount\"[[:space:]]*:[[:space:]]*([^,}[:space:]]+) ]]; then
  active_runs="${BASH_REMATCH[1]}"
fi
if [[ "$drain_body" =~ \"activeLeaseCount\"[[:space:]]*:[[:space:]]*([0-9]+)[[:space:]]*[,}] ]]; then
  active_leases="${BASH_REMATCH[1]}"
elif [[ "$drain_body" =~ \"activeLeaseCount\"[[:space:]]*:[[:space:]]*([^,}[:space:]]+) ]]; then
  active_leases="${BASH_REMATCH[1]}"
fi
if ! [[ "$active_runs" =~ ^[0-9]+$ ]] || ! [[ "$active_leases" =~ ^[0-9]+$ ]] || [ "$active_runs" -ne 0 ] || [ "$active_leases" -ne 0 ]; then
  printf 'refusing to rebuild: active work remains activeRunCount=%s activeLeaseCount=%s\n' "$active_runs" "$active_leases" >&2
  exit 12
fi

docker compose up -d app || exit $?

poll=1
healthy=0
while [ "$poll" -le 30 ]; do
  status="$(docker inspect --format '{{.State.Health.Status}}' archon-app-1 2>/dev/null)" || status=""
  if [ "$status" = "healthy" ]; then
    healthy=1
    break
  fi
  if [ "$poll" -eq 30 ]; then
    break
  fi
  sleep 10
  poll=$((poll + 1))
done
if [ "$healthy" -ne 1 ]; then
  printf 'refusing to rebuild: archon-app-1 did not become healthy\n' >&2
  exit 15
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3090/api/health)" || exit $?
if [ "$code" != "200" ]; then
  printf 'refusing to rebuild: health endpoint status %s\n' "$code" >&2
  exit 15
fi

disable_drain
printf 'docker tag archon:rollback-%s archon:latest && git checkout --detach %s && docker compose up -d --no-build app\n' "$STAMP" "$PREV"
