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

# Bash-node scripts are mode 0600 and owned by the server. Copy the script
# with an O_NOFOLLOW openat walk before the UID switch, then hand the copy
# to bash on stdin. A shell open follows symlinks, and a path swap between
# a check and a second open would copy server-readable bytes into the lane.
# Flags such as `bash -c` are not script paths and stay on the original argv.
lane_take_script=0
if [ "$1" = "bash" ] && [ -n "${2:-}" ]; then
  case "$2" in
    -*) lane_take_script=0 ;;
    *) lane_take_script=1 ;;
  esac
fi
if [ "$lane_take_script" -eq 1 ]; then
  lane_script=$2
  shift 2
  lane_dir=$(mktemp -d)
  chmod 700 "$lane_dir"
  lane_copy="$lane_dir/script"
  if ! python3 - "$lane_script" > "$lane_copy" <<'PY'
import os, stat, sys

path = sys.argv[1]
if path == "" or "\0" in path:
    sys.exit(66)
if not os.path.isabs(path):
    path = os.path.join(os.getcwd(), path)
parts = []
for part in path.split("/"):
    if part == "" or part == ".":
        continue
    if part == "..":
        if not parts:
            sys.exit(66)
        parts.pop()
        continue
    parts.append(part)
if not parts:
    sys.exit(66)
flags_dir = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
flags_file = os.O_RDONLY | os.O_NOFOLLOW
dirfd = None
try:
    dirfd = os.open("/", flags_dir)
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        opened = os.open(part, flags_file if last else flags_dir, dir_fd=dirfd)
        os.close(dirfd)
        dirfd = opened
    info = os.fstat(dirfd)
    if not stat.S_ISREG(info.st_mode):
        sys.exit(66)
    while True:
        chunk = os.read(dirfd, 65536)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
except OSError:
    sys.exit(66)
finally:
    if dirfd is not None:
        try:
            os.close(dirfd)
        except OSError:
            pass
PY
  then
    rm -rf "$lane_dir"
    echo "archon-lane-exec: refusing bash script path" >&2
    exit 66
  fi
  exec 9<"$lane_copy"
  rm -rf "$lane_dir"
  exec 0<&9 9<&-
  set -- bash -s -- "$@"
fi

exec /usr/local/libexec/archon/lane-setpriv \
  --reuid=1002 --regid=1002 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"
