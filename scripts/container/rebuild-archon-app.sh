#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
hold_file="${ARCHON_REBUILD_HOLD_FILE:-/opt/bdc/archon/.rebuild-hold}"
stop_file="${ARCHON_REBUILD_STOP_FILE:-/opt/bdc/archon/.rebuild-stop}"
root="/opt/bdc/archon"
db="/opt/bdc/archon-data/archon.db"
backup_dir="/opt/bdc/backups/archon"

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

cd "$root"

tracked="$(git status --porcelain --untracked-files=no)" || exit $?
if [ -n "$tracked" ]; then
  printf '%s\n' "$tracked" >&2
  exit 3
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp docker-compose.yml "docker-compose.yml.pre-rebuild-${STAMP}"
cp docker-compose.override.yml "docker-compose.override.yml.pre-rebuild-${STAMP}"

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

printf 'docker tag archon:rollback-%s archon:latest && git checkout --detach %s && docker compose up -d --no-build app\n' "$STAMP" "$PREV"
