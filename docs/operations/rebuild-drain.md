# Rebuild drain

Operators use drain mode so a container rebuild of archon-app-1 can wait for
in-flight work without asking every session to hold.

## Status

```bash
curl -sS http://127.0.0.1:3090/api/admin/drain \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN"
```

`recreateSafe` is true only when mode is `draining`, `pendingRunCount` is 0,
`runningRunCount` is 0, and `activeLeaseCount` is 0. Paused and
`waiting_provider` rows are `survivingRunCount`. They do not block a recreate.

`drained` is stricter. It stays false while any paused or `waiting_provider`
run is still counted in `activeRunCount`. A rebuild waits on `recreateSafe`,
not on `drained`.

## Drain on

Rebuild-scoped drain (clears itself after the new container boots):

```bash
curl -sS -X POST http://127.0.0.1:3090/api/admin/drain \
  -H "Content-Type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"draining":true,"clearOnBoot":true,"reason":"rebuild"}'
```

Incident freeze (stays draining across restart; boot logs
`cauldron_drain_persisted_across_boot`):

```bash
curl -sS -X POST http://127.0.0.1:3090/api/admin/drain \
  -H "Content-Type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"draining":true,"clearOnBoot":false,"reason":"incident freeze"}'
```

New fires are refused with HTTP 503, body code `cauldron_draining`, and
`Retry-After: 60`. In-flight runs are not cancelled.

## Drain off

```bash
curl -sS -X POST http://127.0.0.1:3090/api/admin/drain \
  -H "Content-Type: application/json" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -d '{"draining":false,"reason":"resume"}'
```

## Rebuild script

```bash
bash deploy/rebuild-archon.sh
bash deploy/rebuild-archon.sh --poll-sec 30 --drain-timeout-min 120
bash deploy/rebuild-archon.sh --help
```

The script takes an exclusive flock on `/opt/bdc/archon-data/.rebuild.lock`.
A second invocation prints `LOCKED` and exits 75.

Exit codes:

  0  rebuild completed
  3  drain timed out before recreateSafe
  75 lock already held (LOCKED)
  1  guard abort (dirty tree, disk, sha mismatch, or health)

Host install of this script to `/opt/bdc/scripts/rebuild-archon.sh`, the
rebuild log, and pin retention stay with bdc-xo#2306.

## PR #949 rollout

PR #949's own rollout needs a manual M-181 rebuild. The running pre-#949
container reports no `recreateSafe` field, so this script would poll for 120
minutes, undrain, and exit 3. Draining before that manual rebuild leaves a
drain the old container's boot cannot clear.
