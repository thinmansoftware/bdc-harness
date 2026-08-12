# Taskmaster architecture and operations

Generated: 2026-08-12

- Source revision: `e84ccf658ff8e11901f6fbad2c1dff76f2d91a9c`
- Repository: `bluedevilcollectibles/bdc-harness`
- Lane: `bdc-audit-claude`
- Scope: Taskmaster Slice 1 (M-133)

This is a reference for the behavior present at the source revision above. It is
not an implementation plan. When this document and a later revision of the code
disagree, the code is authoritative.

## What Taskmaster is

Taskmaster is an always-on, deterministic scheduler in the server process. It
observes dispatch work and selected GitHub issues, classifies each item, proposes
one of a small set of message actions, applies safety and budget checks, records
the proposal, and then sends through the existing dispatch data-access layer.
The scheduler is started with the API server outside tests
(`packages/server/src/routes/api.ts:3055`).

It is model-free. Classification and action selection are pure functions with an
injected clock and no I/O (`packages/server/src/taskmaster/rules.ts:1`). The only
action verbs are `deliver_ruling`, `nudge`, `escalate_p0`, and `digest`
(`packages/server/src/taskmaster/rules.ts:18`).

Taskmaster does not assign work, spend money, contact customers, deploy code, or
create a second transport. Every effect is an allowlisted dispatch message to an
allowlisted internal seat (`packages/server/src/taskmaster/guard.ts:16`). Forbidden
effect types or recipients are rejected and may tighten the control state to a
hard pause (`packages/server/src/taskmaster/loop.ts:692`).

## Runtime components

### Scheduler and tick

`startTaskmaster()` owns a module-level singleton timer and runtime. A second
start is a no-op. It also prevents overlapping ticks with an `inFlight` guard
(`packages/server/src/taskmaster/loop.ts:856`). The timer invokes one tick
immediately after startup and then on the configured interval
(`packages/server/src/taskmaster/loop.ts:874`).

The default interval is 60,000 ms. `TASKMASTER_INTERVAL_MS` accepts a nonnegative
integer; zero disables Taskmaster, a positive value sets the interval, and an
invalid value falls back to 60,000 (`packages/server/src/taskmaster/loop.ts:846`).
Thus "fixed 60 seconds" is the default schedule, not an immutable schedule.

Each tick captures the pause control row and its epoch before doing work. An epoch
change discards pending two-tick confirmations rather than replaying them
(`packages/server/src/taskmaster/loop.ts:537`). It obtains its own headroom
reading, reconciles pending journal rows once after process start, loads journal
history for deduplication and budgets, and grades previously sent actions before
soliciting new work (`packages/server/src/taskmaster/loop.ts:547`).

GitHub work solicitation reads open issues with `wo`, `project`, or `arc` labels.
Each label is queried separately, results are deduplicated by issue number, and
pull requests are excluded (`packages/server/src/taskmaster/loop.ts:183`). Repos
come from `TASKMASTER_GH_REPOS`, defaulting to
`bluedevilcollectibles/bdc-xo`; authentication uses `GITHUB_TOKEN` or `GH_TOKEN`
(`packages/server/src/taskmaster/loop.ts:211`).

Every GitHub response is checked for `x-ratelimit-remaining`. If the integer value
is below five, Taskmaster throws a backoff error instead of advancing on a partial
snapshot (`packages/server/src/taskmaster/loop.ts:189`). HTTP failures likewise
fail the read rather than silently treating missing work as an empty result
(`packages/server/src/taskmaster/loop.ts:223`).

### Deterministic rules

The rules engine classifies an item as `ready`, `stale`, `blocked`, or `healthy`.
Blocked work is watched but never nudged. An undelivered ruling or unclaimed P0 is
ready immediately. Other work becomes stale only after its injected last-activity
clock expires (`packages/server/src/taskmaster/rules.ts:73`).

The clocks are 30 minutes for P0 and customer-facing items, four hours for P1,
and 24 hours for P2 and P3 (`packages/server/src/taskmaster/rules.ts:53`). At most
three automated interventions may be proposed for an item in a rolling 24-hour
window (`packages/server/src/taskmaster/rules.ts:63`).

`computeNextAction()` returns at most one typed proposal per item. Its precedence
is ruling delivery, unclaimed-P0 escalation, then stale-work nudge
(`packages/server/src/taskmaster/rules.ts:93`). Rulings and P0 escalations act on
the confirming tick; ordinary nudges must remain eligible for two consecutive
ticks (`packages/server/src/taskmaster/loop.ts:678`). A daily digest is added
through the same proposal and dispatch path (`packages/server/src/taskmaster/loop.ts:643`).

The guard requires an allowlisted verb, an allowlisted recipient, a nonempty
idempotency key and body, and no spend/send/deploy language
(`packages/server/src/taskmaster/guard.ts:60`). This guard is load-bearing: it is
called before any journaled proposal can reach `createMessage()`.

### Headroom ledger

`currentHeadroom()` reports `OK`, `LOW`, or `UNKNOWN`. It prefers a fresh local
usage artifact, then a CLI anchor; the anchor is sampled at startup, every 30
minutes, and following a typed-state transition
(`packages/server/src/taskmaster/ledger.ts:141`). The local artifact path is
`TASKMASTER_USAGE_ARTIFACT` or `$ARCHON_HOME/taskmaster/usage-anchor.json` and
the optional CLI probe is configured by `TASKMASTER_CLI_ANCHOR_CMD`
(`packages/server/src/taskmaster/ledger.ts:103`,
`packages/server/src/taskmaster/ledger.ts:121`).

The hard failure contract is that an unavailable meter never becomes numeric
zero capacity. It becomes `UNKNOWN`, has `tokensRemaining: null`, and is persisted
with `is_unknown=1` when the failure is a fresh observation
(`packages/server/src/taskmaster/ledger.ts:209`). Valid values below the default
50,000-token watermark are `LOW`; other valid values are `OK`
(`packages/server/src/taskmaster/ledger.ts:244`). Slice 1 records and surfaces
headroom but does not suppress its model-free dispatch messages based on it
(`packages/server/src/taskmaster/loop.ts:547`).

### Dead-man detection and escalation

The local dead-man state records scheduler attempts and successful heartbeats.
Health is `degraded` when the last successful heartbeat is at least three configured
intervals old; two missed intervals remain healthy
(`packages/server/src/taskmaster/deadman.ts:39`). A disabled or never-started
runtime reports `not_running` (`packages/server/src/taskmaster/deadman.ts:50`).

That module only computes the observed health. The external checker lives in
Overseer, polls the HTTP status endpoint using `ARCHON_OPERATOR_TOKEN`, and treats
failed HTTP reads as unreachable without claiming an escalation
(`packages/overseer/src/taskmaster-deadman-check.ts:64`). On `degraded`, it sends
one dispatch message from `overseer` to `operator`, keyed by last tick and epoch;
continued degraded polls do not duplicate it, and recovery re-arms the checker
(`packages/overseer/src/taskmaster-deadman-check.ts:92`,
`packages/overseer/src/taskmaster-deadman-check.ts:102`).

## End-to-end data flow

1. The scheduler captures `tm_control` pause state and epoch.
2. The ledger records current capacity as OK, LOW, or UNKNOWN.
3. Dispatch rows and labeled GitHub issues are read as the work sources.
4. Pure rules classify each item and produce at most one typed proposal.
5. Ordinary nudges wait for a second consecutive eligible tick.
6. The guard checks verb, recipient, idempotency key, body, and authority.
7. Budgets limit the loop to ten effects per tick and one per item; overflow is
   journaled as deferred (`packages/server/src/taskmaster/loop.ts:733`).
8. A `tm_journal` row with outcome `pending` is written before the effect.
9. The pause epoch is re-read immediately before dispatch; changed control expires
   the row (`packages/server/src/taskmaster/loop.ts:753`).
10. `createMessage()` sends an `agent_message` with the proposal idempotency key,
    then the journal outcome becomes `sent` or `failed`
    (`packages/server/src/taskmaster/loop.ts:781`).
11. A successful tick advances the heartbeat; status exposes control, health,
    headroom, and recent effect count (`packages/server/src/routes/api.ts:3079`).

Restart reconciliation protects row-first delivery. A pending journal row whose
idempotency key already exists in dispatch becomes `sent` without another send;
one without a matching dispatch effect becomes `expired`
(`packages/server/src/taskmaster/loop.ts:392`).

## Persistence schema

The live DDL is `migrations/041_taskmaster_slice1.sql`. The following column lists
are quoted from that migration; they describe storage and do not propose changes.

### `tm_journal`

```sql
id UUID PRIMARY KEY,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
thread_ref TEXT NOT NULL,
action_type TEXT NOT NULL,
proposal_json TEXT NOT NULL,
idempotency_key TEXT,
before_hash TEXT,
proof_predicate TEXT,
proof_deadline_at TIMESTAMPTZ,
outcome TEXT NOT NULL,
graded_at TIMESTAMPTZ,
grade TEXT
```

The DDL constrains action types to the four supported verbs, outcomes to
`pending`, `sent`, `parked`, `deferred`, `rejected`, `expired`, or `failed`, and
grades to `useful`, `noise`, or `harmful` (`migrations/041_taskmaster_slice1.sql:8`).

### `tm_control`

```sql
id INTEGER PRIMARY KEY,
pause_state TEXT NOT NULL DEFAULT 'RUNNING',
pause_scope TEXT,
pause_reason TEXT,
pause_actor TEXT,
epoch BIGINT NOT NULL DEFAULT 0,
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

The singleton row has `id = 1`; pause state is constrained to `RUNNING`, `PAUSED`,
or `HARD_PAUSE` (`migrations/041_taskmaster_slice1.sql:31`).

### `tm_health`

```sql
provider TEXT PRIMARY KEY,
state TEXT NOT NULL,
sampled_at TIMESTAMPTZ NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
evidence TEXT
```

These are expiring provider-health samples, not the process-local dead-man state
(`migrations/041_taskmaster_slice1.sql:51`).

### `tm_usage_sample`

```sql
id UUID PRIMARY KEY,
provider TEXT NOT NULL,
window_kind TEXT NOT NULL,
source TEXT NOT NULL,
observed_at TIMESTAMPTZ NOT NULL,
value_json TEXT,
confidence TEXT,
is_unknown INTEGER NOT NULL DEFAULT 0
```

Each row is one observation. `is_unknown` is constrained to zero or one, preserving
the distinction between a failed meter and zero available capacity
(`migrations/041_taskmaster_slice1.sql:62`).

## Operations

### Check status

Call `GET /api/taskmaster/status`. The route is covered by the global `/api/*`
operator-token middleware and declares 401 for a missing or invalid token
(`packages/server/src/routes/api.ts:2161`). Supply the configured token using the
`x-archon-operator-token` header:

```bash
curl -sS -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  http://localhost:3090/api/taskmaster/status
```

The response contains `pause_state`, `pause_scope`, `pause_reason`, `pause_actor`,
`epoch`, `tick_health`, `interval_ms`, `last_tick_at`, `headroom_state`, and
`effects_last_24h` (`packages/server/src/routes/api.ts:3080`). Interpret health as:

- `healthy`: the scheduler has started and has not missed three intervals.
- `degraded`: the last successful heartbeat is at least three intervals old.
- `not_running`: no active runtime or no expected tick.

### Decide whether it is alive

Start with the status response: `last_tick_at` should advance after successful
ticks and `tick_health` should remain healthy. Then query `tm_journal` for recent
activity and outcomes:

```sql
SELECT created_at, thread_ref, action_type, outcome, idempotency_key
FROM tm_journal
ORDER BY created_at DESC
LIMIT 50;
```

An empty recent journal does not alone prove failure: healthy ticks can find no
eligible action, and ordinary nudges require confirmation. A stale `last_tick_at`
plus `tick_health = 'degraded'` is the scheduler failure signal. Repeated `failed`,
`rejected`, or `deferred` outcomes explain activity that did not become an effect.

### Configure or stop the loop

Set `TASKMASTER_INTERVAL_MS` before starting the server. Omit it for 60 seconds,
set a positive integer for another millisecond interval, or set it to `0` for an
operator kill. This is read during `startTaskmaster()`; changing the process
environment without restarting does not replace the existing singleton timer
(`packages/server/src/taskmaster/loop.ts:860`).

Do not treat pause and kill as synonyms. Pause state is durable in `tm_control`
and continues monitoring; zero interval prevents the scheduler from starting.
Under pause, P0 escalation and the digest remain exempt while other proposals are
parked (`packages/server/src/taskmaster/loop.ts:717`).

### Investigate a dead-man alarm

1. Call the status endpoint with the operator token.
2. Compare `last_tick_at`, `interval_ms`, and `tick_health`.
3. Inspect the application logs for `taskmaster.tick_failed` and GitHub read or
   ledger warnings.
4. Inspect recent `tm_journal` outcomes and the current `tm_control` epoch.
5. Confirm the external checker can reach the configured `TASKMASTER_STATUS_URL`.

The external checker defaults to localhost port 3090, polls every 60 seconds, and
can be disabled with `TASKMASTER_DEADMAN_INTERVAL_MS=0`
(`packages/overseer/src/taskmaster-deadman-check.ts:53`,
`packages/overseer/src/taskmaster-deadman-check.ts:153`). Its escalation is a
dispatch message to the operator path, not an email, SMS, or deployment action.

## Design intent versus current behavior

The M-133 Slice 1 work order in bdc-xo records the ratification rationale and
binding conditions. It is useful historical design intent, but it is not the
current behavior source. This document derives current behavior and every line
citation from the bdc-harness revision in the provenance header.

## Maintenance checklist

Regenerate or review this document when scheduler ordering, rules, guard authority,
ledger semantics, dead-man delivery, operator routes, or migration-backed columns
change. Update the generated date and source revision together. Re-open every cited
location at the new revision: line numbers are intentionally revision-specific.
