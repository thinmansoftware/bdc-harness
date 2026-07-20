#!/usr/bin/env bash
# ===========================================================================
# deploy-n8n-health.sh
# Sync the git-tracked n8n-health suite to the Hetzner CI host and restart the
# systemd oneshot that runs it.
#
# WO-INFRA-N8N-HEALTH-ALERT-DEDUP-AND-DB-FIX-01
#
# PRODUCTION MUTATION: this restarts a live service on the Hetzner host. It
# REQUIRES John's explicit deploy approval before it is run. Do NOT run this
# from a build/CI context. The git PR/merge does not require this step; the
# host deploy is a separate approval gate (Stop Conditions 2-4 depend on it).
#
# Host layout (unchanged by this WO):
#   /opt/bdc/ci/n8n-health.js          <- deployed target (this file's source)
#   /opt/bdc/ci/.env                   <- systemd EnvironmentFile (secrets)
#   /opt/bdc/ci/.n8n-health-last-alert.json  <- alert-dedup state (runtime)
#   /opt/bdc/ci/health-results.jsonl   <- append-only results log (runtime)
#   bdc-n8n-health.timer / .service    <- systemd units (every 6h)
# ===========================================================================
set -euo pipefail

HOST="${BDC_CI_HOST:-5.78.86.90}"
REMOTE_DIR="/opt/bdc/ci"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[deploy] copying n8n-health.js to ${HOST}:${REMOTE_DIR}/"
scp "${SCRIPT_DIR}/n8n-health.js" "${HOST}:${REMOTE_DIR}/n8n-health.js"

echo "[deploy] confirming deployed copy matches git-tracked source"
if diff <(ssh "${HOST}" "cat ${REMOTE_DIR}/n8n-health.js") "${SCRIPT_DIR}/n8n-health.js" >/dev/null; then
  echo "[deploy] host copy matches source"
else
  echo "[deploy] ERROR: host copy does NOT match source after scp" >&2
  exit 1
fi

echo "[deploy] restarting bdc-n8n-health.service (one-shot run now)"
ssh "${HOST}" 'sudo systemctl restart bdc-n8n-health.service'

echo "[deploy] recent service logs:"
ssh "${HOST}" 'sudo journalctl -u bdc-n8n-health.service -n 25 --no-pager'

echo "[deploy] done."
