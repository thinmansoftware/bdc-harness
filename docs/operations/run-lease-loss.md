# Run lease loss: how to read it

WO-HARNESS-RUN-LEASE-LOST-SAYS-SO-01 (bdc-xo#5695), 2026-11-12.

## What a run lease is

A workflow run holds a lease on its row in `remote_agent_run_leases`: 60 seconds long, renewed every 20 seconds by a timer in the same process (`packages/workflows/src/run-lease.ts`). The renewal is refused once the lease has expired (`expires_at` earlier than the renewal time), and one refused or failed renewal is final for that run: the lease stays lost for the rest of the run, even if the process is alive and still holds the worktree. The usual cause is a stalled event loop: a process that cannot run its timer for more than a minute loses its leases (run cf52e179, 2026-11-12: last renewal 17:56:45Z, the run kept building to 18:10:02Z, then was stopped and failed).

## What the executor does when the lease is lost

It stops the run at one of two points and writes no terminal success:

| Point | Where in `dag-executor.ts` | `where` in the event |
|---|---|---|
| before the next layer of nodes | the layer loop | `layer_boundary` |
| before the final completion write | just before the terminal status | `before_terminal` |

Before this work order the stop left only two log lines, and the run ended with the backstop's generic text `Workflow exited without finalizing -- see logs`.

## What it records now

1. One event of type `run_lease_lost` in the run's event stream, `data`:
   `where`, `reason` (`renewal_refused` or `renewal_error`), `last_renewed_at`, `expires_at`, `detected_at` (all ISO), and `gap_seconds` (seconds from `expires_at` to the moment the executor stopped the run).
2. The run row's failure message, written by the executor's backstop, now reads
   `Run lease lost: last renewed <ISO>, expired <ISO>, noticed <ISO>, gap <n> s after expiry; the run was stopped at a layer boundary` (or `before the terminal write`).
   Here `noticed` is when the heartbeat saw the refusal, and the gap in the message is expiry to noticed. A run that failed for any other reason keeps its own message; a run with no recorded loss still gets the generic backstop text.

The loss is remembered in the process (up to 200 runs), so a restart in between loses the detail and the generic text is used.

## How to look at one

```
powershell -NoProfile -File scripts/cauldron/inspect-run.ps1 -Run <run id prefix>
```

Look for the `run_lease_lost` event and the `error` text in the run metadata. For the lease row itself: `select run_id, acquired_at, last_heartbeat_at, expires_at, released_at from remote_agent_run_leases where run_id like '<prefix>%'` (read-only).

## Not changed here

The lease length, the heartbeat interval, and whether a process may re-take its own lease after a stall (an open design question tabled to the Board desk: bdc-xo#5695, "Open design question").
