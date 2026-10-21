#!/bin/bash
# archon-lane-exec -- lane UID launcher (WO-HARNESS-APP-KEY-ISOLATION-01).
#
# Drops the given command to the unprivileged lane UID/GID (laneuser 1002),
# clears supplementary groups (so the lane loses the archon-secrets and
# archon-launch groups the server holds), and strips inheritable/ambient
# capabilities, via a root-owned copy of setpriv that carries
# cap_setuid,cap_setgid+ep (installed at ${ARCHON_LANE_SETPRIV}).
#
# Invoked by:
#   - dag-executor bash/script/loop nodes, and the Claude/Cursor/Grok providers,
#     as argv[0] prefixed ahead of the real command.
#   - the Codex provider, which can only pass a single executable path to its
#     SDK: it sets ARCHON_LANE_WRAPPED_CMD to the real codex binary, which this
#     launcher prepends to the argument vector before dropping privileges.
#
# The server process (appuser, 1001) is a member of group archon-launch and so
# may execute this launcher; laneuser is NOT, so a lane cannot re-launch itself
# to any other UID. setpriv is required to be allowed to raise no new privileges
# (container runs with NoNewPrivs=0 and the Docker default SETUID/SETGID bounding
# caps).
set -euo pipefail

LANE_UID="${ARCHON_LANE_UID:-1002}"
LANE_GID="${ARCHON_LANE_GID:-1002}"
LANE_SETPRIV="${ARCHON_LANE_SETPRIV:-/usr/local/libexec/archon/lane-setpriv}"

# Refuse to re-enter the lane UID: a process already at the lane UID must not be
# able to invoke the launcher (defence in depth; the launcher is also not
# executable by laneuser via the archon-launch group gate).
if [ "$(id -u)" = "${LANE_UID}" ]; then
  echo "archon-lane-exec: refusing to re-enter lane UID ${LANE_UID}" >&2
  exit 90
fi

# Codex single-path SDK: prepend the real binary recorded in the environment.
if [ -n "${ARCHON_LANE_WRAPPED_CMD:-}" ]; then
  set -- "${ARCHON_LANE_WRAPPED_CMD}" "$@"
fi

if [ "$#" -eq 0 ]; then
  echo "archon-lane-exec: no command given" >&2
  exit 91
fi

if [ ! -x "${LANE_SETPRIV}" ]; then
  echo "archon-lane-exec: launcher ${LANE_SETPRIV} missing or not executable" >&2
  exit 92
fi

exec "${LANE_SETPRIV}" \
  --reuid="${LANE_UID}" \
  --regid="${LANE_GID}" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  -- "$@"
