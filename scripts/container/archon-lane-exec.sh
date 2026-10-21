#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "archon-lane-exec: target command required" >&2
  exit 64
fi
if [ "$(id -u)" -eq 1002 ]; then
  echo "archon-lane-exec: refusing nested lane launch" >&2
  exit 77
fi

unset GITHUB_APP_PRIVATE_KEY GITHUB_APP_PRIVATE_KEY_PATH GITHUB_APP_PRIVATE_KEY_HOST_PATH
unset GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID MERGE_MANAGER_GH_TOKEN GH_TOKEN
unset GITHUB_TOKEN GH_AUTH_TOKEN_INTERNAL ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN
unset ARCHON_OPERATOR_TOKEN ARCHON_ALLOW_PR_MERGE GIT_CONFIG_GLOBAL
unset DATABASE_URL DATABASE_PRIVATE_URL DATABASE_PATH SQLITE_PATH SQLITE_DATABASE
unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGPASSFILE
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGSSLMODE PGSSLKEY PGSSLCERT PGSSLROOTCERT PGSSLCRL
for lane_name in $(env | sed -n 's/^\(GITHUB_APP_\(OVERSEER\|PR_DISCOVERY\|MERGE_MANAGER\|TASKMASTER\|DUTY_OFFICER\|SMART_CAULDRON\)_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$lane_name"
done
for lane_name in $(env | sed -n 's/^\([A-Za-z0-9_]*DATABASE[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$lane_name"
done
export ARCHON_GITHUB_SERVICE=run_nodes HOME=/home/laneuser

# Bash-node scripts are mode 0600 and owned by the server. Open the script
# before the UID switch, then hand that descriptor to bash on stdin.
# Passing the script path to bash reopens it as the lane UID and is denied.
if [ "$1" = "bash" ] && [ -n "${2:-}" ] && [ -f "$2" ]; then
  exec 9<"$2"
  shift 2
  exec 0<&9 9<&-
  set -- bash -s -- "$@"
fi

exec /usr/local/libexec/archon/lane-setpriv \
  --reuid=1002 --regid=1002 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
