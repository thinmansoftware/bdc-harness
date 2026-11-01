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

## Routing since 2026-11-01

WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01. The cut-off is `OPERATOR_HISTORY_CUTOFF` =
`2026-11-01T00:00:00.000Z` in `packages/core/src/db/dispatch-routing.ts`.

| Recipient | What lands there | Who reads it |
|---|---|---|
| `operator` | History only. Rows queued before the cut-off stay as they are. Low-volume senders not moved by this WO (re-review cap claims, judge-ladder blocker notices, model-resource health, Taskmaster deadman, digest and blocker_report) still write here. | Nothing new. The operator inbox consumer skips every row created before the cut-off. |
| `pr-review-log` | The three PR-review receipt kinds: `pr_review_ingest_receipt`, `pr_review_submit_receipt`, `pr_review_recheck_ingest_receipt`. | The reviewer, for re-review authorization. It reads `pr-review-log` first, then `operator` for pre-cut-off receipts. Nothing drains it. |
| `t3-desktop` | `overseer_run_report` rows from operator-card delivery (the resolved board-seat owner is in the body as `owner_seat`, null when unresolved) and Taskmaster `escalate_p0`. | The T3 desktop bridge (WO-XO-T3-RESULTS-BRIDGE-01). |

Rules:

- No code path cancels, deletes, acknowledges or addresses an `operator` row created before
  the cut-off. The consumer compares `created_at` as an instant, so ISO and SQLite
  `YYYY-MM-DD HH:MM:SS` text both work. A stamp it cannot parse is treated as history.
- Taskmaster admits `t3-desktop` only for `escalate_p0`, and `escalate_p0` only to
  `t3-desktop`. Any other pairing is a forbidden effect.
- Taskmaster escalates a stalled item at most once per 24 hours, whatever the outcome of the
  last attempt (sent, failed, rejected). A failed attempt records the error text in the
  journal row's `proposal_json.failure`.
- Both principals are seeded in `migrations/065_dispatch_t3_desktop_and_pr_review_log.sql`,
  `migrations/000_combined.sql` and the SQLite adapter seed.
- `dispatch_receipt_cutover` (2026-09-24) is a different thing. It only decides which
  acknowledge and address stamps count as trustworthy in mailbox depth. No writer reads it, so
  it never moved any traffic.

Post-merge acceptance, on the harness host. Record H0 before the rebuild:

```sh
sqlite3 /opt/bdc/archon-data/archon.db "select count(*) from agent_dispatch_messages where recipient='operator' and created_at < '2026-11-01'"
```

24 hours after the rebuild:

```sh
sqlite3 /opt/bdc/archon-data/archon.db "select count(*) from agent_dispatch_messages where recipient='operator' and created_at < '2026-11-01'"
sqlite3 /opt/bdc/archon-data/archon.db "select count(*) from agent_dispatch_messages where recipient='operator' and json_extract(body,'$.kind') like 'pr_review_%_receipt' and created_at >= datetime('now','-1 day')"
sqlite3 /opt/bdc/archon-data/archon.db "select count(*), count(distinct thread_ref) from tm_journal where action_type='escalate_p0' and created_at >= datetime('now','-1 day')"
```

Expected: the first count equals H0, the second is 0, and in the third the two numbers are
equal and no larger than the number of stalled items.

## Review catch-up after a missed webhook

GitHub does not redeliver an App webhook that arrived while archon-app-1 was down. Two mechanisms feed the existing review ingest path. Neither changes signature checks, receipt shape, or review evaluation.

Startup catch-up (`runWebhookRedeliveryCatchup`) runs once the HTTP listener is up, and only when the review route is configured. It lists App webhook deliveries newer than the last ingest receipt (or process start, which is container start -- not the moment the listener became ready) minus 10 minutes, and redelivers each `pull_request` delivery whose status is not OK or whose delivery GUID has no ingest receipt. Bounds: 200 redeliveries per startup, and 10 pages / 1000 inspected deliveries. Pagination stops when a page is entirely older than the window. Each success is logged as `webhook_redelivered` with the numeric delivery id, the GUID, and the PR number. A failure is logged as `webhook_catchup_failed` and does not reject server startup. Missing App credentials log `webhook_catchup_skipped`. The App JWT is never logged.

The review-gap sweeper (`startReviewGapSweeper`) ticks immediately and then every five minutes. For each repo in the merge allowlist it lists open non-draft pull requests updated in the last two hours. A head with no ingest receipt and no submitted Overseer review, pushed more than 10 minutes ago, is submitted to ingest as a signed `pull_request` `synchronize` event. Age is when that head was pushed, not the git committer timestamp. A submit receipt counts only when GitHub accepted the review (`approved`, `changes_requested`, or a required-contexts comment that landed). `checks_pending`, `transport_error`, and failed submissions do not. Bound: 20 requests per tick. Each success is logged as `review_gap_swept` with owner, repository, PR number, and head SHA.

Merge-candidate discovery reports the digest token `review_missing` (detail: current head has no ingest receipt) when a pull request would otherwise be `review_not_approved` and the current head has no ingest receipt. Drafts, unwatched bases, and other exclusion reasons are left as they are. A receipt lookup failure keeps `review_not_approved` and logs `review_receipt_lookup_failed`.
