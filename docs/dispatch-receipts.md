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
## Inbox reader

The inbox reader classifies the `xo` mailbox every five minutes and can optionally take ownership
of `operator`. It ships in dry-run mode with the existing operator consumer still enabled.

| Variable | Default | Rule |
|---|---:|---|
| `INBOX_READER_INTERVAL_MS` | `300000` | Integer at least zero; zero disables the scheduler. |
| `INBOX_READER_MODE` | `dry-run` | Only exact `enforce` enables dispositions. |
| `INBOX_READER_MAX_PER_RUN` | `500` | Clamped to 1 through 500. |
| `INBOX_READER_MIN_AGE_MS` | `600000` | May be raised but never lowered below ten minutes. |
| `INBOX_READER_OPERATOR_OWNER` | `reader` | Default is now the reader (A2); exact `consumer` rolls back to the legacy operator consumer. |
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

## Ops-inbox digest and event routing (WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01)

Routine ops events no longer interrupt the XO and no longer pile into an unread Dispatch
mailbox. The Duty Officer and the inbox reader post them to one pinned GitHub issue (the
`ops-inbox` issue) as a single daily digest comment; only events that genuinely need a person
or are a blocker create a Dispatch `xo` interrupt row.

### The ops-inbox issue

One open issue labelled `ops-inbox` in `OPS_INBOX_REPO` (default `thinmansoftware/bdc-xo`)
holds the digest. `ensureOpsInboxIssue` finds it, or creates the label and the issue
("OPS INBOX -- daily digest (do not close)") exactly once. There is one digest comment per UTC
date, addressed by the marker `<!-- ops-inbox-digest:YYYY-MM-DD -->`. Each writer owns a fenced
section (`<!-- section:KEY -->` ... `<!-- /section:KEY -->`), so independent writers (the
`routine` section here, the `john-queue` section in WO-HARNESS-TASKMASTER-JOHN-DIGEST-01) update
the same comment without clobbering each other. This module never closes, cancels, or deletes
anything.

Read today's digest:

```sh
gh api "repos/thinmansoftware/bdc-xo/issues/$(gh issue list --repo thinmansoftware/bdc-xo \
  --label ops-inbox --state open --json number --jq '.[0].number')/comments" --paginate \
  --jq '.[] | select(.body | contains("ops-inbox-digest:'"$(date -u +%F)"'")) | .body'
```

### The routing table

`routeOpsEvent(event)` returns one of three classes, first match wins:

| Class | Goes to | Examples |
|---|---|---|
| `ROUTINE` | the digest `routine` section; no Dispatch row | run finished, run failed with a retry path, PR opened, checks green, rate-limit reset, session archived, an ORDINARY-priority `expectation EXHAUSTED` notice |
| `NEEDS_A_PERSON` | one `xo` `ops_interrupt` row, Dispatch priority `normal` | decision / approval / human-only / rotate / `owner:john` / `owner:board`; a customer-facing `broken`/`down`/`wrong`/`failing`/`overcharged` |
| `BLOCKER` | one `xo` `ops_interrupt` row, Dispatch priority `blocker` | `priority: blocker` or a Taskmaster `blocker_report`; a failure with no retry path (`retries exhausted`, `max attempts`, `gave up`, `all tiers exhausted`, ...); an owner-seat question (`?`); `security`/`secret`/`service_role`/`money`/`billing`/`refund`/`charge` |

A second `BLOCKER` for the same `subject_key` within 24 hours is downgraded to `ROUTINE`
(digest), so a repeating alarm pages once, not every tick. The `ops_interrupt` body carries
`kind`, `class`, `item` (the subject_key) and `default_if_unanswered`.

### Additional env flags

| Variable | Default | Rule |
|---|---:|---|
| `OPS_INBOX_REPO` | `thinmansoftware/bdc-xo` | `owner/repo` for the ops-inbox issue. |
| `OPS_INBOX_GITHUB_TIMEOUT_MS` | `15000` | GitHub request timeout, floored at 1000. |
| `INBOX_READER_CANARY_AGE_HOURS` | `6` | Rows older than this count toward the unread canary. |
| `INBOX_READER_CANARY_MAX` | `25` | A principal with MORE than this many stale unread rows fires the canary. |

### Owner-ack deadline

For every row the reader classifies ACTIONABLE or BRING, if the recipient has not acknowledged
it 24 hours after `created_at`, the reader appends one line (once per message id) to the digest
`overdue` section naming the recipient, message id, subject_key and default action. After 72
hours it creates exactly one `duty-officer` row (`kind: owner_ack_overdue`); the Duty Officer
clock appends that to the digest `escalated` section. It never creates a second `xo` row for an
already-overdue `xo` row, and never acknowledges, addresses or disposes the original.

### Unread canary

Each run computes, per principal, `unread_older_than_6h` (unacknowledged, unaddressed, older
than `INBOX_READER_CANARY_AGE_HOURS`, and either not route-disposed or an `auto_surfaced` row
past the surface cursor). If any principal exceeds `INBOX_READER_CANARY_MAX`, OR any queued row
exists for a principal that has no consumer, the reader writes one `queued_age_canary` alert to
`alerts.jsonl` and upserts the digest `canary` section (suppressed per recipient for
`INBOX_READER_ALERT_REPEAT_HOURS`). The per-principal numbers are also written to `latest.json`
under `canary`.

### Honest inbox status (A7)

`GET /api/dispatch/status` now reports, per principal, `unread_older_than_6h` and
`surface_unread` (auto_surfaced rows past the reader's surface cursor) alongside the existing
`surfaced_unacked`:

```sh
ssh hetzner-prod 'TOKEN=$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN); \
  curl -s http://localhost:3090/api/dispatch/status -H "x-archon-operator-token: $TOKEN"' \
  | jq ".mailbox"
```

An inbox is clean for a principal only when `unread`, `surface_unread` and
`unread_older_than_6h` are all `0`. A zero `unread` count alone is not enough.

### Bounded enforce of the new rules

The new triage rules ship in dry-run; the digest lists planned dispositions without writing any.
Enabling enforce is an XO ops step after the dry-run digest is reviewed and John re-confirms the
"drain the queue" instruction. Use the bounded procedure from the wiki tool page
(`xo-wiki/wiki/tools/dispatch-inbox-reader/_index.md`): set `INBOX_READER_MODE=enforce` with
`INBOX_READER_MAX_PER_RUN` capped low, recreate the container (`docker compose up -d app`),
watch one or two runs, then revert to `INBOX_READER_MODE=dry-run` and confirm `latest.json`
reads `"mode": "dry-run"`. Rollback is `INBOX_READER_MODE=dry-run` (dispositions) and
`INBOX_READER_OPERATOR_OWNER=consumer` (ownership), applied by recreating the container.
