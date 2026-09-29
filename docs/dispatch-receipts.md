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

The inbox reader classifies the `xo` mailbox every five minutes and can optionally take ownership
of `operator`. It ships in dry-run mode with the existing operator consumer still enabled.

| Variable | Default | Rule |
|---|---:|---|
| `INBOX_READER_INTERVAL_MS` | `300000` | Integer at least zero; zero disables the scheduler. |
| `INBOX_READER_MODE` | `dry-run` | Only exact `enforce` enables dispositions. |
| `INBOX_READER_MAX_PER_RUN` | `500` | Clamped to 1 through 500. |
| `INBOX_READER_MIN_AGE_MS` | `600000` | May be raised but never lowered below ten minutes. |
| `INBOX_READER_OPERATOR_OWNER` | `consumer` | Exact `reader` transfers the operator mailbox. |
| `INBOX_READER_ACTIONABLE_ALERT_HOURS` | `24` | Positive number. |
| `INBOX_READER_GAP_ALERT_HOURS` | `2` | Positive number. |
| `INBOX_READER_ALERT_REPEAT_HOURS` | `6` | Positive number. |
| `INBOX_READER_RETENTION_DAYS` | `14` | Positive integer. |

Read the current digest with:

```sh
ssh hetzner-prod "cat /opt/bdc/archon-data/inbox-reader/latest.md"
```

The companion files are `/opt/bdc/archon-data/inbox-reader/latest.json`,
`/opt/bdc/archon-data/inbox-reader/alerts.jsonl`, and
`/opt/bdc/archon-data/inbox-reader/runs/`.

To enable expiry, set `INBOX_READER_MODE=enforce` in `/opt/bdc/archon/.env`. To transfer the
operator mailbox too, separately set `INBOX_READER_OPERATOR_OWNER=reader`. Apply either change by
recreating the app container with `docker compose up -d app`: recreate, not restart, because a
restart does not reload the environment file.

Rollback by setting `INBOX_READER_INTERVAL_MS=0`, restoring
`INBOX_READER_OPERATOR_OWNER=consumer`, and recreating the container.

The legacy operator surface can be classified read-only on the host with:

```sh
bun scripts/dispatch/inbox-reader-report.ts --surface /opt/bdc/archon-data/operator-inbox/surface.jsonl
```

Inside the container, `getArchonHome()` resolves to `/.archon`, so use:

```sh
docker exec archon-app-1 bun scripts/dispatch/inbox-reader-report.ts --surface /.archon/operator-inbox/surface.jsonl
```

The reader never acknowledges, addresses or cancels; it only machine-disposes INFO_DUPLICATE and NUDGE rows as expired, and only in enforce mode.

Direct receipt operations and cancellation are prohibited. The legacy non-terminal surface
disposition remains owned by the existing operator consumer and is not produced by this reader.
