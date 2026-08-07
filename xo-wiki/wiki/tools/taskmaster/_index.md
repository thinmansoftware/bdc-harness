# Taskmaster (Slice 1) -- Operator Runbook

WO: WO-HARNESS-TASKMASTER-SLICE1-01 | Authority: M-133 (CARRIED 3-0, John 2026-08-06)

The Taskmaster is an always-on deterministic loop inside the bdc-harness
server (archon-app-1, Hetzner 5.78.86.90). Every tick (default 60s) it:

1. Delivers undelivered ratified rulings (queued board-motion mailbox rows
   with no acknowledgement) to their seat.
2. Nudges idle threads past their clock: 30min P0/customer, 4h P1, 24h P2-P3.
3. Escalates unclaimed P0s to John (via the `operator` dispatch drain).
4. Sends one daily digest summarizing its journal.

All effects are dispatch messages through the existing dispatch DAL
(`agent_dispatch_messages`). It has NO spend, send-to-customer, deploy,
merge, assignment, or WO-authoring authority (Slice 1 exclusions, ratified).

## Environment

| Variable                    | Meaning                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TASKMASTER_INTERVAL_MS`    | Tick interval. `60000` in production compose. `0` = KILLED (loop off, zero effects) -- this is the rollback switch. |
| `TASKMASTER_GH_REPOS`       | Comma-separated GitHub repos read as the work SOR (default `bluedevilcollectibles/bdc-harness`).                    |
| `TASKMASTER_USAGE_ARTIFACT` | Optional path to a local usage-anchor JSON (`{"tokensRemaining": N, "observedAt": ISO}`).                           |
| `TASKMASTER_CLI_ANCHOR_CMD` | Optional shell probe printing tokens-remaining; failure reads as UNKNOWN, never 0.                                  |

## Status

```bash
curl -s -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  http://localhost:3090/api/taskmaster/status
```

Returns `pause_state` (RUNNING | PAUSED | HARD_PAUSE), `epoch`,
`tick_health` (healthy | degraded | not_running), `interval_ms`,
`last_tick_at`, `headroom_state` (OK | LOW | UNKNOWN), `effects_last_24h`.

`tick_health` flips to `degraded` after 3 missed intervals; the EXTERNAL
dead-man checker in the Overseer package
(`packages/overseer/src/taskmaster-deadman-check.ts`) escalates exactly once
per degradation episode and re-arms on recovery.

## Pause (John or operator)

```bash
curl -s -X POST -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"why","actor":"john"}' \
  http://localhost:3090/api/taskmaster/pause
```

Paused mode stops ordinary sends but NEVER stops watching: monitoring, P0
escalation, and the digest stay alive. Parked proposals are journaled with
`outcome='parked'`. An automatic circuit (forbidden/duplicate/unlogged
effect) HARD-PAUSES effects on its own; it can only tighten into pause,
never convert into KILL.

## Resume (John-authorized)

```bash
curl -s -X POST -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"john"}' \
  http://localhost:3090/api/taskmaster/resume
```

Resume increments the pause epoch and EXPIRES stale parked/pending proposals
rather than replaying them (response includes `expired_proposals`).

## Journal queries (on archon-app-1)

Activation-proof query (SC7 kill test -- binding condition 4):

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT count(*) FROM tm_journal WHERE outcome='sent' AND grade='useful'"
```

Recent actions:

```bash
sqlite3 /opt/bdc/archon-data/archon.db \
  "SELECT created_at, action_type, thread_ref, outcome, grade FROM tm_journal ORDER BY created_at DESC LIMIT 20"
```

Pause state:

```bash
sqlite3 /opt/bdc/archon-data/archon.db "SELECT * FROM tm_control WHERE id=1"
```

## Kill / rollback

Set `TASKMASTER_INTERVAL_MS=0` in compose and restart the container. The
loop never starts, zero effects occur, monitoring endpoints still answer
(`tick_health=not_running`). All Slice 1 migrations are additive; no
existing table was altered.

## Budgets (ratified Q1)

- Max 10 effects per tick; overflow journaled `deferred`, not dropped.
- Max 1 effect per item per tick.
- Max 3 automated interventions per item per 24h.
- Ordinary nudges require eligibility on two consecutive ticks; undelivered
  rulings and unclaimed P0s act on the confirming tick.
