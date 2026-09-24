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
