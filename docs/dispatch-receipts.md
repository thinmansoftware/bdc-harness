# Dispatch receipts

## Machine dispositions and the receipt freeze

The operator inbox consumer and M-155 dead-letter expiry record machine actions in
`route_disposition` and `route_disposed_at`. They never write the human receipt columns.

Before rolling back to legacy receipt-writing code, set `OPERATOR_INBOX_INTERVAL_MS=0`,
then freeze receipts before retagging and recreating the container:

```sh
sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-freeze.sql
```

Only after honest code is running again, remove the trigger:

```sh
sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-unfreeze.sql
```

The Taskmaster dead-letter operation remains dry-run by default. After reviewing its count,
run `bun scripts/taskmaster/expire-xo-deadletter.ts --confirm` once against the intended database.

## Acknowledging as xo

An XO session must use all four identity proofs supplied by its own live lease hook. Never copy
lease or token values into documentation or scripts:

```sh
curl -X POST "$ARCHON_URL/api/dispatch/messages/$MESSAGE_ID/ack" \
  -H "x-board-principal-token: $BOARD_PRINCIPAL_TOKEN" \
  -H "x-xo-holder-token: $XO_HOLDER_TOKEN" \
  -H "x-xo-lease-id: $XO_LEASE_ID" \
  -H "x-xo-fencing-token: $XO_FENCING_TOKEN" \
  -H 'content-type: application/json' \
  --data '{}'
```

The lease is checked again in the same transaction that writes the receipt. A stale lease returns
`409 lease_fence_stale`. A bare operator token always binds the actor to `operator`; omitting the
body on a non-`operator` mailbox therefore returns `409 wrong_recipient`.

## Inbox reader

The inbox reader (`packages/server/src/dispatch/inbox-reader.ts`,
WO-HARNESS-DISPATCH-INBOX-READER-01) is an unattended in-process worker in
`archon-app-1`. Every run it classifies the open messages in the `xo` mailbox
(and, when switched on, `operator`), writes a persisted digest the XO reads at
session start, and -- only in enforce mode -- machine-expires the rows that are
provably informational duplicates or collapsed reminders. It leaves every
message that could need a human untouched and listed, and writes alert rows when
actionable mail goes stale or the reader itself stops.

**The reader never acknowledges, addresses or cancels; it only machine-disposes
INFO_DUPLICATE and NUDGE rows as expired, and only in enforce mode.**

Because M-187a gives the store no machine-actor or reason column, the reason a
row was disposed is recorded only in the digest (e.g. `inbox-reader R1
info_review_posted: verdict already posted as a GitHub PR review`). By design the
reader source (`inbox-reader.ts`, `inbox-reader-rules.ts`,
`scripts/dispatch/inbox-reader-report.ts`) contains no `cancel` text in any case,
and `inbox-reader.ts` never references `acknowledgeMessage`, `addressMessage`, or
the `auto_surfaced` disposition -- these prohibitions are enforced by grep at
review time and documented here rather than in the source files.

### Configuration

All settings live in `/opt/bdc/archon/.env`. The build ships INERT: mode
`dry-run`, owner `consumer`.

| env | default | rule |
| --- | --- | --- |
| `INBOX_READER_INTERVAL_MS` | 300000 | integer >= 0; 0 = scheduler off; invalid -> default |
| `INBOX_READER_MODE` | `dry-run` | only the literal `enforce` enables dispositions; anything else = dry-run and a warn log |
| `INBOX_READER_MAX_PER_RUN` | 500 | clamped to 1..500 |
| `INBOX_READER_MIN_AGE_MS` | 600000 | `max(600000, value)`: can be raised, never lowered below 10 minutes |
| `INBOX_READER_OPERATOR_OWNER` | `consumer` | `reader` = the reader also reads `operator` AND the old operator-inbox-consumer does not start; anything else = `consumer` |
| `INBOX_READER_ACTIONABLE_ALERT_HOURS` | 24 | positive number |
| `INBOX_READER_GAP_ALERT_HOURS` | 2 | positive number |
| `INBOX_READER_ALERT_REPEAT_HOURS` | 6 | positive number |
| `INBOX_READER_RETENTION_DAYS` | 14 | positive integer; run files older than this are pruned |

### Where the digest and alerts live

On the host (bind mount of the container's `/.archon/inbox-reader/`):

- `/opt/bdc/archon-data/inbox-reader/latest.md` -- human-readable digest, rewritten every run
- `/opt/bdc/archon-data/inbox-reader/latest.json` -- machine digest, rewritten every run
- `/opt/bdc/archon-data/inbox-reader/alerts.jsonl` -- append-only alert rows
- `/opt/bdc/archon-data/inbox-reader/runs/` -- per-run digest snapshots (kept only when the plan is
  non-empty, an alert fired, or the classified backlog changed)

The XO reads the digest at session start:

```sh
ssh hetzner-prod "cat /opt/bdc/archon-data/inbox-reader/latest.md"
```

### Enabling (XO action after merge -- recreate, not restart)

The reader ships inert. To turn on enforcement and/or hand the operator mailbox
to the reader, edit `/opt/bdc/archon/.env`:

```sh
INBOX_READER_MODE=enforce
# and, separately, to hand the operator mailbox over from the old consumer:
INBOX_READER_OPERATOR_OWNER=reader
```

Then RECREATE the container so the new env file is read (a plain
`docker restart` does NOT re-read the env file):

```sh
cd /opt/bdc/archon && docker compose up -d app
```

### Rollback

Set the reader off and return ownership to the consumer, then recreate:

```sh
INBOX_READER_INTERVAL_MS=0
INBOX_READER_OPERATOR_OWNER=consumer
cd /opt/bdc/archon && docker compose up -d app
```

### Reading the already-surfaced operator backlog (read-only CLI)

The 2,298 rows the operator-inbox-consumer already surfaced live in
`surface.jsonl`. Classify them with the same rules read-only (this never touches
the database or any mailbox row):

```sh
# From a source checkout, against the host copy:
bun scripts/dispatch/inbox-reader-report.ts --surface /opt/bdc/archon-data/operator-inbox/surface.jsonl

# Inside the running container (getArchonHome() resolves to /.archon in Docker):
docker exec archon-app-1 bun scripts/dispatch/inbox-reader-report.ts --surface /.archon/operator-inbox/surface.jsonl
```
