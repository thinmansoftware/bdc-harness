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
echo "=== P4: DB backup ==="; sudo sqlite3 "$DB" ".backup $DBDIR/archon.db.pre-rebuild-$STAMP" && sudo test -s "$DBDIR/archon.db.pre-rebuild-$STAMP" || { echo "ABORT_BACKUP (no backup, nothing rebuilt)"; undrain; exit 3; }
echo "=== P5: pin image ==="; docker tag archon:latest "archon:rollback-$STAMP" || { echo "ABORT_PIN (no rollback image, nothing rebuilt)"; undrain; exit 3; }
echo "=== P6: fetch ==="; PREV=$(git rev-parse HEAD); git fetch -q origin dev || { echo "ABORT_FETCH (git fetch failed; not building a stale commit)"; undrain; exit 3; }; TARGET=$(git rev-parse origin/dev); echo "target=$(git rev-parse --short $TARGET) from=$(git rev-parse --short HEAD)"
git checkout -q "$TARGET" || { echo ABORT_CHECKOUT; undrain; exit 3; }
echo "=== E3: build ==="; BLOG=$(mktemp); docker compose build "$SVC" > "$BLOG" 2>&1; BRC=$?; tail -2 "$BLOG"; rm -f "$BLOG"
if [ "$BRC" -ne 0 ]; then
  echo "ABORT_BUILD rc=$BRC (old image still running; checkout restored to $(git rev-parse --short "$PREV"))"
  git checkout -q "$PREV" || echo "WARN: could not restore the checkout to $PREV"
  undrain; exit 5
fi
# W (WO-HARNESS-BOOT-CHOWN-WALK-AND-REBUILD-EVIDENCE-01): warm the directory cache the entrypoint's ownership
# walk reads. The image build pushes it out, and a cold walk hung two boots on 2026-11-13 (bdc-xo #5970).
# Best effort: a timeout or error is printed and never aborts the rebuild.
echo "=== W: warm directory cache ==="; WS=$(date +%s); sudo timeout 600 find /opt/bdc/archon-data /opt/bdc/archon-user-home -xdev > /dev/null 2>&1; WRC=$?
if [ "$WRC" -eq 124 ]; then echo "warm: timed out after 600 s (continuing)"; elif [ "$WRC" -ne 0 ]; then echo "warm: find rc=$WRC (continuing)"; fi
echo "warm: $(( $(date +%s) - WS ))s"
echo "=== E4: up ==="; ULOG=$(mktemp); docker compose up -d "$SVC" > "$ULOG" 2>&1; URC=$?; tail -2 "$ULOG"; rm -f "$ULOG"
# Up to 360 s (72 polls of 5 s). Docker's "unhealthy" is NOT final (it keeps checking and can report healthy
# later), so the loop ends only on healthy, on a restart count above 1, or at the bound.
echo "=== V: health (up to 360 s) ==="; i=0; S=unknown
while [ $i -lt 72 ]; do S=$(docker inspect --format '{{.State.Health.Status}}' archon-app-1 2>/dev/null || echo missing); R=$(docker inspect --format '{{.RestartCount}}' archon-app-1 2>/dev/null || echo 0); [ "$S" = healthy ] && break; [ "${R:-0}" -gt 1 ] && break; sleep 5; i=$((i+1)); done
TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN 2>/dev/null)
API=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3090/api/workflows -H "x-archon-operator-token: $TOKEN" || echo 000)
echo "health=$S api=$API"
if [ "$URC" -ne 0 ] || [ "$S" != healthy ] || [ "$API" != 200 ]; then
  # Save the failed start's evidence BEFORE anything is rolled back: the rollback removes the container and,
  # with the json-file log driver, its output (bdc-xo #6097). A failed save never stops the rollback.
  FD="${REBUILD_FAIL_DIR:-$HOME}"
  docker logs --timestamps archon-app-1 > "$FD/rebuild-fail-$STAMP.log" 2>&1 || echo "WARN: could not save docker logs"
  docker inspect -f '{{json .State.Health}}' archon-app-1 > "$FD/rebuild-fail-$STAMP.health.json" 2>&1 || echo "WARN: could not save the health log"
  docker top archon-app-1 -eo pid,etime,stat,args > "$FD/rebuild-fail-$STAMP.top.txt" 2>&1 || echo "WARN: could not save docker top"
  echo "saved: $FD/rebuild-fail-$STAMP.log $FD/rebuild-fail-$STAMP.health.json $FD/rebuild-fail-$STAMP.top.txt"
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
# The DB folder is mode 750 owned by the app user, so the glob, the listing and the removal all run under
# sudo, with the folder passed as an argument, never interpolated into the quoted script (bdc-xo #6097).
sudo sh -c 'cd "$1" 2>/dev/null || exit 0; ls -1t archon.db.pre-rebuild* 2>/dev/null | tail -n +3 | while IFS= read -r f; do rm -f -- "$f"; done' _ "$DBDIR"
for t in $(docker images archon --format '{{.Tag}}' | grep '^rollback-' | sort -r | tail -n +2); do docker rmi "archon:$t" >/dev/null 2>&1; done
echo "HEAD=$(git rev-parse --short HEAD) created=$(docker inspect -f '{{.Created}}' archon-app-1) $(df -h / | tail -1 | awk '{print $4" free"}')"
echo "=== DONE $STAMP ==="
