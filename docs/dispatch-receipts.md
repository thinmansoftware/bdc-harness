# Dispatch receipts and machine dispositions

Authority: board motion **M-187a rev 2a-1** (ratified 2026-09-23), built by
`WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01` and its sibling
`WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01`.

## The rule

A **receipt** (`acknowledged_at` / `acknowledged_by` / `addressed_at` /
`addressed_by`) means a bound human actor read the message. After the cutover,
**no machine may write a receipt.** Machines record what they did in
`route_disposition` (+ the `route_disposed_at` stamp) and nothing else.

`route_disposition` values:

| value | written by | terminal? | meaning |
|-------|-----------|-----------|---------|
| `unroutable` | routing | yes | no active principal to deliver to |
| `superseded` | supersede/cancel | yes | replaced by a newer message |
| `expired` | machine | yes | aged out, never heard (e.g. digest, dead-letter) |
| `auto_surfaced` | machine | **no** | surfaced to a durable human queue; still ackable by a bound human |

Terminal dispositions refuse `acknowledgeMessage` / `addressMessage`
(`reason: 'disposition_terminal'`). `auto_surfaced` rows stay ackable and
addressable by a bound human actor; a later ack writes `acknowledged_*` only,
exactly as on an untouched row.

`status=queued` drain lists exclude every disposed row
(`route_disposition IS NULL` is added next to `addressed_at IS NULL`).
`auto_surfaced` rows are retrievable through the `listMessages`
`route_disposition` filter.

## The machine primitive

`disposeMessageByMachine({ id, actor, disposition })`
(`packages/core/src/db/dispatch.ts`) is the ONLY machine-writable primitive. Its
UPDATE sets exactly `route_disposition` + `route_disposed_at`. It requires
`actor` to be prefixed `system:` (logged, never stored) and rejects an
already-disposed row, an invalid disposition, or a missing row.

Callers:

- **Operator inbox consumer**
  (`packages/server/src/dispatch/operator-inbox-consumer.ts`), actor
  `system:operator-inbox-consumer`: `auto_surfaced` for `needs_human` and
  `code_actionable` (after the JSONL surface append), `expired` for `digest_only`.
- **M-155 dead-letter expiry**
  (`scripts/taskmaster/expire-xo-deadletter.ts`), actor
  `system:m155-deadletter-expiry`, disposition `expired`, per matching row inside
  its existing single transaction alongside the M-155 journal note.

### Running the M-155 dead-letter expiry

Dry-run by default; `--confirm` mutates. Operator action, never run by the loop:

```bash
bun scripts/taskmaster/expire-xo-deadletter.ts            # dry-run count
bun scripts/taskmaster/expire-xo-deadletter.ts --confirm  # mark matching rows expired
```

## The cutover row

Migration 056 creates the one-row `dispatch_receipt_cutover(id, applied_at)`
table and writes row 1 once, on the first boot that applies 056. It is preserved
across every later boot, rebuild and rollback. Every later reader separates
pre-cutover stamps (non-evidence) from post-cutover receipts with:

```sql
SELECT applied_at FROM dispatch_receipt_cutover WHERE id = 1;
```

## Machine dispositions and the receipt freeze

Rolling `archon-app-1` back to a **receipt-writing legacy image** against the
live database is PROHIBITED unless (1) `OPERATOR_INBOX_INTERVAL_MS=0` is set and
(2) the receipt freeze is applied FIRST. The order is load-bearing:

```
interval 0  ->  freeze  ->  retag and recreate (legacy image)
```

Freeze (installs a BEFORE UPDATE trigger that aborts any write to a receipt
column with `dispatch_receipts_frozen`):

```bash
sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-freeze.sql
```

Under the freeze, legacy ack/address routes return 500 and the legacy consumer
logs `message_process_failed` per row and writes nothing.

Unfreeze ONLY after honest code (machines write `route_disposition`, never
receipts) is back live:

```bash
sqlite3 /opt/bdc/archon-data/archon.db < scripts/dispatch/receipt-unfreeze.sql
```

`dispatch_receipt_cutover` is never touched by either script.

## Deploy pairing

`WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01` and
`WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01` merge to `dev` independently, but
`archon-app-1` is rebuilt by XO only after BOTH are in `dev` HEAD (PAIRING RULE).
A rebuild carrying this WO alone leaves the body-supplied actor door open; one
carrying the sibling alone leaves the consumer stamping `operator`.
