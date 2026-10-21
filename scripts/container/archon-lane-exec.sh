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
for lane_name in $(env | sed -n 's/^\(GITHUB_APP_\(OVERSEER\|PR_DISCOVERY\|MERGE_MANAGER\|TASKMASTER\|DUTY_OFFICER\|SMART_CAULDRON\)_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$lane_name"
done
export ARCHON_GITHUB_SERVICE=run_nodes HOME=/home/laneuser

# Bash-node scripts are deliberately mode 0600 while the server prepares them.
# Open the descriptor before dropping UID so the lane can execute without making
# the transient script readable to other container users.
if [ "$1" = "bash" ] && [ "${2:-}" != "" ] && [ -f "$2" ]; then
  exec 9<"$2"
  shift 2
  set -- bash /proc/self/fd/9 "$@"
fi

exec /usr/local/libexec/archon/lane-setpriv \
  --reuid=1002 --regid=1002 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
