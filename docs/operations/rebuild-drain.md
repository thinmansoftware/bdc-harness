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

Python 3 is a new host prerequisite for strict acquisition-response parsing.
The default executable is `python3`; `REBUILD_PYTHON` may name one executable
path. Missing Python refuses before Docker or drain calls. Host availability has
not been verified by the source tests.

Each new drain generation receives a server UUID. The POST response's
`acquiredDrainToken` is the acquisition grant; the separately observed
`drainToken` may already describe a replacement and must never grant ownership.
An already-draining request returns no grant and cannot adopt the drain.
Every automatic script clear sends its captured `expectedDrainToken`; the
database compares it atomically. HTTP 409 means ownership was lost or the drain
already cleared. Cleanup never retries unconditionally. Explicit authenticated
operator clearing without a condition remains available.

Malformed, missing, duplicate-key, or uncertain acquisition proof prints
`ABORT_DRAIN_OWNERSHIP_UNKNOWN` and refuses build. The request may have taken
effect: inspect the authenticated drain state and reconcile ownership manually.
The script cannot safely guess an automatic clear. A failed cleanup prints
`DRAIN_CLEAR_UNCONFIRMED`; a lost generation prints `DRAIN_OWNERSHIP_LOST`.

Exit codes:

  0  rebuild completed
  3  drain timed out before recreateSafe
  75 lock already held (LOCKED)
  1  guard abort (dirty tree, disk, sha mismatch, or health)

Host install of this script to `/opt/bdc/scripts/rebuild-archon.sh`, the
rebuild log, and pin retention stay with bdc-xo#2306.

## PR #949 rollout

An older API cannot grant generation-fenced ownership. This script fails closed
when that contract is absent; its first activation needs a separately reviewed
bootstrap path. Migration 066 adds nullable generation ownership without
backfilling legacy drains. Boot clears only a matching rebuild generation;
incident drains remain in force. Older scripts that clear unconditionally remain
outside this guarantee.

This document grants no deployment authority. Any production rebuild requires
the current environment- and commit-scoped approval and deployment evidence.
Historical M-181 entries do not authorize a new rebuild. Host installation,
rebuild logging, pin retention, automatic run recovery, and a recreate reservation
remain separate work; `recreateSafe` is an observation, not a reservation.

## Taskmaster late drain custody

A drain may begin after Taskmaster receives running admission but before the
provider fire. Running admission alone does not count as sent work. Taskmaster
reconciles the durable cascade and actual workflow identity on later ticks,
including after restart.

A fresh cascade can be deferred without a workflow expectation only when it has
one completed named drain-refused attempt with no run ID, no frontier continuation
or supervisor delegation, and the exact WO/project/cascade execution lock records
a validated release. A terminal cascade checkpoint appears before lock release;
it cannot authorize a retry while release is still pending. Missing, malformed,
legacy tokenless, or superseded lock evidence keeps custody held.

The journal atomically stores this proof, releases the matching launch token, and
marks the action deferred. A stale comparison grants no capacity. A later eligible
tick after drain clears can claim a fresh execution generation under the same
action key, original deadline, recipient, and spec authority. Version 2 execution
IDs use `tm:fire:launch:<launch token>`. Previous drain generations and their proof
remain in `fireLaunchHistory`; their immutable cascade records are preserved.
Legacy version 1 key-bound claims remain readable.

Ambiguous provider responses, generic HTTP 503, cancellation acknowledgments, and
missing run discovery do not prove no fire. A later named refusal discharges only
its own invocation. Earlier actual runs retain their normal workflow expectation;
this partial cascade never becomes a fresh no-fire retry. Release requires all
actual workflows terminal, no earlier ambiguous null attempt, and positive WO
execution settlement. An existing journal is preserved when global drain is on.

Confirmed no-fire deferrals refund that caller's fire reservation while retaining
per-item and per-scope tick guards. They never count as sent or useful work. These
source controls do not establish runtime activation or the seven-day bad-run gate.
