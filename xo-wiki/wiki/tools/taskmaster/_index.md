# Taskmaster (Slice 1)

The Taskmaster is an always-on deterministic loop inside the bdc-harness server
(`archon-app-1`). It moves stalled work forward by SENDING MESSAGES through the
dispatch bus -- delivering undelivered ratified rulings, nudging idle threads,
and escalating unclaimed P0s. It authors no code and mutates no repos.

Authority: **M-133 RATIFIED** (CARRIED 3-0, John 2026-08-06). Slice 1 only --
judgment chair, chair rotation, worker registry, usage-aware routing, UI, and any
money/credential/production action are OUT OF SCOPE and unauthorized here.

Built by `WO-HARNESS-TASKMASTER-SLICE1-01`.

---

## What it does each tick (default every 60s)

1. Reads the pause state (`tm_control`) and captures the pause epoch.
2. Reads its own capacity ledger (failure = `UNKNOWN`, never zero-as-capacity).
3. Reads threads: undelivered ratified rulings + stalled work.
4. Classifies each thread (`ready` / `stale` / `blocked` / `healthy`) and computes
   at most one typed proposal (`deliver_ruling` / `nudge` / `escalate`).
5. Confirms eligibility over TWO consecutive ticks (exception: undelivered rulings
   and unclaimed P0s act on the confirming tick).
6. Validates the proposal (effect allowlist + content guard). Rejections are
   journalled, never sent.
7. Journals the action ROW-FIRST, re-checks the pause epoch, then sends via the
   dispatch DAL with a deterministic `idempotency_key`.

Budgets: max 10 effects/tick, 1 effect/item/tick, max 3 automated interventions
per item per 24h. Nudge clocks: 30min P0/customer, 4h P1, 24h P2-P3.

Everything the loop does is recorded in the `tm_journal` table.

---

## Modes

| Mode       | Tick runs | Sends | P0 escalation | Set by                                      |
| ---------- | --------- | ----- | ------------- | ------------------------------------------- |
| RUNNING    | yes       | yes   | yes           | default                                     |
| PAUSED     | yes       | no    | yes           | John (API) or auto-circuit                  |
| HARD_PAUSE | yes       | no    | yes           | auto on forbidden/duplicate/unlogged effect |
| KILLED     | no        | no    | no            | `TASKMASTER_INTERVAL_MS=0`                  |

An automatic circuit may only tighten INTO pause; it may NEVER convert into KILL.
Resume is John-authorized only, increments the pause epoch, and expires stale
proposals rather than replaying them.

---

## Operating it (HTTP control surface)

All three endpoints require the operator token (send it as
`x-archon-operator-token: <token>` or `Authorization: Bearer <token>`).

Base URL below is the deployed host; substitute your own.

### Status

```bash
curl -s https://<archon-app-host>/api/taskmaster/status \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN"
```

Returns tick health, pause state, epoch, last heartbeat, and the interval:

```json
{
  "success": true,
  "tick_health": "healthy",
  "pause_state": "RUNNING",
  "epoch": 0,
  "last_heartbeat_at": 1786000000000,
  "interval_ms": 60000
}
```

`tick_health` degrades to `degraded` after 3 missed intervals. The EXTERNAL
Overseer dead-man checker (`packages/overseer/src/taskmaster-deadman-check.ts`)
polls this endpoint and escalates exactly once on `degraded`, re-arming on
recovery.

### Pause (stop sends; monitoring + P0 escalation stay alive)

```bash
curl -s -X POST https://<archon-app-host>/api/taskmaster/pause \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"investigating noisy nudges"}'
```

### Resume (John-authorized; increments the epoch, expiring stale proposals)

```bash
curl -s -X POST https://<archon-app-host>/api/taskmaster/resume \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN"
```

---

## Kill switch / rollback

Set the compose env var and restart the container:

```
TASKMASTER_INTERVAL_MS=0
```

`0` means KILLED: the loop never starts and produces zero effects. All Taskmaster
migrations are additive; no existing table is altered, so rollback is env-only.
Default is `60000` (60s), set in the root `docker-compose.yml` `app` service.

---

## Reading the journal (proof of useful action)

Every proposed/attempted action is a row in `tm_journal`. To confirm the loop
acted usefully without anyone asking (the 48h activation proof):

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT count(*) FROM tm_journal WHERE outcome='sent' AND grade='useful'"
```

Inspect recent actions:

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT created_at, thread_ref, action_type, outcome, grade
     FROM tm_journal ORDER BY created_at DESC LIMIT 20"
```

Outcome values: `proposed`, `sent`, `parked` (blocked by pause), `deferred`
(budget ceiling), `rejected` (guard), `expired` (epoch bumped mid-flight).

---

## Tables (Slice 1)

- `tm_journal` -- append-only action record (row-first, deduped on `idempotency_key`).
- `tm_control` -- singleton pause/epoch control plane (`id = 1`).
- `tm_health` -- durable provider health samples with explicit expiry.
- `tm_usage_sample` -- capacity observations; `is_unknown = 1` marks a failed meter
  read (never persisted as zero capacity).

Schema: `migrations/041_taskmaster_slice1.sql` (Postgres) +
`packages/core/src/db/adapters/sqlite.ts` `createSchema()` (sqlite, the deployed
dialect).
