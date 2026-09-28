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
