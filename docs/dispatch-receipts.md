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

The live lease holder is `xo-claude-board-work` or `xo-codex-board-work`. Both profiles have
seat `xo`. All four headers come from the XO's own lease hook. The board principal token and
the holder token are the same secret in the XO credential store. The lease id and fencing
token come from `GET /api/board/xo-lease/current`. The receipt actor stays `xo`.

Send body `{}`, or a body that names the holder principal id. The body is never proof. Do not
copy token, lease id, or fence values into docs or scripts.

```sh
curl -X POST "$ARCHON_URL/api/dispatch/messages/$MESSAGE_ID/ack" \
  -H "x-board-principal-token: $BOARD_PRINCIPAL_TOKEN" \
  -H "x-xo-holder-token: $XO_HOLDER_TOKEN" \
  -H "x-xo-lease-id: $XO_LEASE_ID" \
  -H "x-xo-fencing-token: $XO_FENCING_TOKEN" \
  -H 'content-type: application/json' \
  --data '{}'
```

| HTTP | Error | When |
|---|---|---|
| 200 |  | The receipt is written. `acknowledged_by` or `addressed_by` is `xo`. |
| 401 | `dispatch_actor_unbound` | A proof is missing, the seat is not `xo`, or the caller is not the live holder. |
| 409 | `lease_fence_stale` | The lease id, fence, holder, release, or expiry no longer matches inside the write. |
| 409 | `wrong_recipient` | The row recipient is not the resolved actor. |
| 409 | `actor_mismatch` | The body names a principal other than `xo` or the bound holder. |
| 409 | `address_before_ack` | Address ran before a successful acknowledgement. |

`status` stays `queued`. `acked_open` is derived from `acknowledged_at` through
`mailboxDepthByPrincipal`.

The lease is checked again in the same transaction that writes the receipt. A bare operator
token always binds the actor to `operator`.

### Operator runbook: xo-mailbox-ack.sh

The live XO seat acknowledges or addresses its mailbox with
`scripts/dispatch/xo-mailbox-ack.sh`. Run it from a bdc-harness checkout. The production
image does not copy `docs/` or `scripts/dispatch/`.

```sh
xo-mailbox-ack.sh <ack|address> <message-id> [message-id...]
```

`ARCHON_URL` defaults to `http://127.0.0.1:3090`.

Required environment variables. The script never echoes their values:

- `BOARD_PRINCIPAL_TOKEN`
- `XO_HOLDER_TOKEN`

Optional:

- `XO_ACK_DRY_RUN=1` prints `POST`, the message URL, the four header names
  (`x-board-principal-token`, `x-xo-holder-token`, `x-xo-lease-id`,
  `x-xo-fencing-token`), and `body={}`, then exits without calling the network.
- `ARCHON_OPERATOR_TOKEN`, when set and non-empty, is sent as
  `x-archon-operator-token` on the lease read and on each receipt write. It is
  never printed.

The script reads `lease_id` and `fencing_token` from `GET /api/board/xo-lease/current`,
then POSTs `{}` to `/api/dispatch/messages/<id>/<ack|address>` with the four lease
headers. It never calls `/cancel`.

| Exit | Meaning |
|---|---|
| 0 | Every id returned HTTP 200, or a dry-run finished. |
| 1 | The lease fetch failed, or at least one id did not return HTTP 200. |
| 2 | Usage error, or a required variable is missing. The message names that variable. |
| 3 | `no_live_xo_lease`. The current-lease route returned HTTP 200 JSON `null`, or an object with no `lease_id`. |

Dry-run. The tokens below are fake and exist only in the environment assignments.
The script must not echo them:

```sh
ARCHON_URL=http://127.0.0.1:3090 \
BOARD_PRINCIPAL_TOKEN=bpt-example \
XO_HOLDER_TOKEN=xht-example \
XO_ACK_DRY_RUN=1 \
  bash scripts/dispatch/xo-mailbox-ack.sh ack 11111111-1111-1111-1111-111111111111
```

`GET /api/dispatch/principals` (operator token) lists every `dispatch_principals` row
and the ack path for that row. Sample:

```json
{
  "principals": [
    {
      "principal_id": "codex",
      "display_name": "Codex",
      "delivery_mode": "worker_poll",
      "active": true,
      "credential_configured": false,
      "ack_path": "worker_claim"
    },
    {
      "principal_id": "operator",
      "display_name": "Operator",
      "delivery_mode": "drain_on_start",
      "active": true,
      "credential_configured": false,
      "ack_path": "operator_token"
    },
    {
      "principal_id": "xo",
      "display_name": "XO",
      "delivery_mode": "drain_on_start",
      "active": true,
      "credential_configured": false,
      "ack_path": "xo_lease"
    },
    {
      "principal_id": "xo-fable",
      "display_name": "XO Fable",
      "delivery_mode": "drain_on_start",
      "active": true,
      "credential_configured": false,
      "ack_path": "none"
    }
  ]
}
```

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

Each run lists at most `INBOX_READER_MAX_PER_RUN` rows in total, split evenly across the owned
mailboxes first (so a full `xo` page can never starve `operator`), with any unused share then
offered to the others. Listing is a keyset walk over the database-assigned `seq`
(`listMessagesBySeqCursor` with `openOnly`); each mailbox's position is saved as `cursors` in
`state.json`, so retained ACTIONABLE mail no longer hides the rows behind it: the next run resumes
after the last row read and wraps to the head once it reaches the tail. Delete `state.json` to
restart every walk at the head.

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
