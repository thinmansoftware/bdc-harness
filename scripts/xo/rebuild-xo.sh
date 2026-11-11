#!/bin/bash
# XO rebuild of archon-app-1 to the tip of origin/dev.
# Drain-gated: sets Cauldron drain, waits for 0 active runs, rebuilds with the rebuild12 guards
# (disk, clean tree, DB backup, image pin, health wait, auto-rollback), serves lanes, clears drain.
# Usage: bash /opt/bdc/scripts/xo/rebuild-xo.sh [max_wait_minutes]
# Exit codes: 0 done; 2 no archon checkout; 3 aborted before the build (not idle, disk, dirty tree, checkout);
#   4 the new container failed to start or was not healthy and the pinned image was restored; 5 the image BUILD FAILED and the old
#   container is still running (the checkout is put back on the starting commit; bdc-xo#5444).
#   Exit 3 also covers: drain not confirmed (ABORT_DRAIN) or never drained, a failed git fetch (ABORT_FETCH), no database backup (ABORT_BACKUP), no pin (ABORT_PIN).
#   Exit 8: the rollback itself failed or the restored container is not healthy (ROLLBACK_FAILED; drain left ON). Exit 6: the lanes could not be published and verified identical (ABORT_LANES; the container is up, drain left ON). Exit 7: drain would not clear (DRAIN_STUCK).
# Overrides for tests: ARCHON_DIR, DB, SCRIPTS_DIR (defaults are the host paths). Runbook: docs/operations/rebuild-xo.md
# Replaces the /tmp/rebuild-892.sh + /tmp/after-*.sh scripts lost in the 2026-09-24 reboot.
set -uo pipefail
MAXW=${1:-120}
ARCHON_DIR=${ARCHON_DIR:-/opt/bdc/archon}
SCRIPTS_DIR=${SCRIPTS_DIR:-/opt/bdc/scripts/xo}
cd "$ARCHON_DIR" || exit 2
DB=${DB:-/opt/bdc/archon-data/archon.db}
DBDIR=$(dirname "$DB")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SVC=$(docker compose config --services | grep -E '^(app|archon|archon-app)$' | head -n 1)
TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)
api() { curl -s --max-time 15 -X "$1" "http://127.0.0.1:3090$2" -H "x-archon-operator-token: $TOKEN" -H 'content-type: application/json' ${3:+--data "$3"}; }
undrain() { TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN 2>/dev/null); api POST /api/admin/drain '{"draining":false,"reason":"rebuild-xo done"}' >/dev/null; UM=$(api GET /api/admin/drain | grep -o '"mode":"[a-z]*"' | head -1); echo "$UM"; [ "$UM" = '"mode":"normal"' ]; }
drain_code() { curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:3090/api/admin/drain" -H "x-archon-operator-token: $TOKEN" -H 'content-type: application/json' --data "$1" || echo 000; }
echo "=== D1: drain on (HTTP 200 and mode not normal, or stop) ==="
DC=$(drain_code "{\"draining\":true,\"reason\":\"rebuild-xo $STAMP\"}"); DM=$(api GET /api/admin/drain | grep -o '"mode":"[a-z]*"' | head -1)
echo "drain POST http=$DC $DM"
if [ "$DC" != 200 ] || [ -z "$DM" ] || [ "$DM" = '"mode":"normal"' ]; then echo "ABORT_DRAIN (drain not confirmed; nothing was changed)"; undrain; exit 3; fi
echo "=== D2: wait until the drain API reports drained (no pending, running, waiting_provider or paused runs, no live leases; max ${MAXW} min) ==="
i=0; while :; do
  api GET /api/admin/drain | grep -q '"drained":true' && break
  i=$((i+1)); [ $i -gt $((MAXW*2)) ] && { echo "ABORT: not drained after ${MAXW} min"; undrain; exit 3; }
  sleep 30
done; echo "drained at $(date -u +%T)"
echo "=== P0b: disk ==="; A=$(df -BG --output=avail / | tail -1 | tr -dc 0-9); echo "avail=${A}G"; [ "$A" -ge 15 ] || { echo ABORT_DISK; undrain; exit 3; }
echo "=== P1: tree clean ==="; [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "ABORT dirty"; git status --short --untracked-files=no | head; undrain; exit 3; }
echo "=== P4: DB backup ==="; sudo sqlite3 "$DB" ".backup $DBDIR/archon.db.pre-rebuild-$STAMP" && [ -s "$DBDIR/archon.db.pre-rebuild-$STAMP" ] || { echo "ABORT_BACKUP (no backup, nothing rebuilt)"; undrain; exit 3; }
echo "=== P5: pin image ==="; docker tag archon:latest "archon:rollback-$STAMP" || { echo "ABORT_PIN (no rollback image, nothing rebuilt)"; undrain; exit 3; }
echo "=== P6: fetch ==="; PREV=$(git rev-parse HEAD); git fetch -q origin dev || { echo "ABORT_FETCH (git fetch failed; not building a stale commit)"; undrain; exit 3; }; TARGET=$(git rev-parse origin/dev); echo "target=$(git rev-parse --short $TARGET) from=$(git rev-parse --short HEAD)"
git checkout -q "$TARGET" || { echo ABORT_CHECKOUT; undrain; exit 3; }
echo "=== E3: build ==="; BLOG=$(mktemp); docker compose build "$SVC" > "$BLOG" 2>&1; BRC=$?; tail -2 "$BLOG"; rm -f "$BLOG"
if [ "$BRC" -ne 0 ]; then
  echo "ABORT_BUILD rc=$BRC (old image still running; checkout restored to $(git rev-parse --short "$PREV"))"
  git checkout -q "$PREV" || echo "WARN: could not restore the checkout to $PREV"
  undrain; exit 5
fi
echo "=== E4: up ==="; ULOG=$(mktemp); docker compose up -d "$SVC" > "$ULOG" 2>&1; URC=$?; tail -2 "$ULOG"; rm -f "$ULOG"
echo "=== V: health (up to 150 s) ==="; i=0; S=unknown
while [ $i -lt 30 ]; do S=$(docker inspect --format '{{.State.Health.Status}}' archon-app-1 2>/dev/null || echo missing); R=$(docker inspect --format '{{.RestartCount}}' archon-app-1 2>/dev/null || echo 0); [ "$S" = healthy ] && break; { [ "$S" = unhealthy ] || [ "${R:-0}" -gt 1 ]; } && break; sleep 5; i=$((i+1)); done
TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN 2>/dev/null)
API=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3090/api/workflows -H "x-archon-operator-token: $TOKEN" || echo 000)
echo "health=$S api=$API"
if [ "$URC" -ne 0 ] || [ "$S" != healthy ] || [ "$API" != 200 ]; then
  echo "=== ROLLBACK to archon:rollback-$STAMP (up rc=$URC health=$S api=$API) ==="
  # Every rollback step is checked. If any step fails, or the restored container is not healthy,
  # drain is left ON (no work starts on a broken container) and the script exits 8.
  RBF=0
  git checkout -q "$PREV" || { echo "ROLLBACK_STEP_FAILED: could not restore the checkout to $PREV"; RBF=1; }
  docker tag "archon:rollback-$STAMP" archon:latest || { echo "ROLLBACK_STEP_FAILED: could not retag the pinned image"; RBF=1; }
  docker compose up -d --no-build --force-recreate "$SVC" 2>&1 | tail -2
  [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "ROLLBACK_STEP_FAILED: could not recreate the container from the pinned image"; RBF=1; }
  i=0; RS=unknown
  while [ $i -lt 30 ]; do RS=$(docker inspect --format '{{.State.Health.Status}}' archon-app-1 2>/dev/null || echo missing); [ "$RS" = healthy ] && break; i=$((i+1)); sleep 5; done
  TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN 2>/dev/null)
  RAPI=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3090/api/workflows -H "x-archon-operator-token: $TOKEN" || echo 000)
  echo "rollback health=$RS api=$RAPI"
  { [ "$RS" = healthy ] && [ "$RAPI" = 200 ]; } || { echo "ROLLBACK_STEP_FAILED: the restored container is not healthy (health=$RS api=$RAPI)"; RBF=1; }
  if [ "$RBF" -ne 0 ]; then echo "ROLLBACK_FAILED (drain left ON so no work starts; fix the container, then clear drain by hand)"; exit 8; fi
  undrain || echo "ALERT DRAIN_STUCK (drain mode is not normal after the rollback; every fire is refused; clear it now)"
  exit 4
fi
echo "=== L: serve lanes (publish, then verify every baked lane is served identical) ==="
sh "$SCRIPTS_DIR/serve-lanes.sh" --apply > /dev/null 2>&1; LRC=$?
LV=$(sh "$SCRIPTS_DIR/serve-lanes.sh" 2>&1); VRC=$?
SAME=$(printf '%s
' "$LV" | grep -c ' SAME'); DIFFERS=$(printf '%s
' "$LV" | grep -c DIFFERS)
echo "serve-lanes apply_rc=$LRC verify_rc=$VRC SAME=$SAME DIFFERS=$DIFFERS"
if [ "$LRC" -ne 0 ] || [ "$VRC" -ne 0 ] || [ "$DIFFERS" -ne 0 ] || [ "$SAME" -lt 1 ]; then
  echo "ABORT_LANES (stale or unverifiable served lanes; the new container is up but drain is left ON so no work starts on them. Fix, then: sh $SCRIPTS_DIR/serve-lanes.sh --apply and clear drain)"
  exit 6
fi
echo "=== D3: drain off (must read back mode normal) ==="
if ! undrain; then echo "ALERT DRAIN_STUCK (drain mode is not normal after the rebuild; every fire is refused; clear it now)"; exit 7; fi
echo "=== prune: keep newest 2 DB backups and newest 1 rollback image ==="
for f in $(ls -1t "$DBDIR"/archon.db.pre-rebuild* 2>/dev/null | tail -n +3); do sudo rm -f "$f"; done
for t in $(docker images archon --format '{{.Tag}}' | grep '^rollback-' | sort -r | tail -n +2); do docker rmi "archon:$t" >/dev/null 2>&1; done
echo "HEAD=$(git rev-parse --short HEAD) created=$(docker inspect -f '{{.Created}}' archon-app-1) $(df -h / | tail -1 | awk '{print $4" free"}')"
echo "=== DONE $STAMP ==="
