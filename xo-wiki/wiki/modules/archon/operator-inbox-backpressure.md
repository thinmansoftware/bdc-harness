# Operator Inbox Backpressure

WO: `WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01`
Module: bdc-harness dispatch / operator inbox

## Why this exists

On 2026-08-27 the automated PR reviewer stopped reviewing. Root cause: ~1548
messages sat `queued` for `recipient=operator` in `agent_dispatch_messages`,
accumulating since 2026-07-31. The operator-inbox consumer drained every 60s and
RE-PROCESSED the same unaddressed rows every pass. That loop's GitHub calls
tripped GitHub SECONDARY rate limiting on the shared `bluedevilcollectibles`
token. The PR reviewer shares that token, so it could not reach the GitHub API;
with no APPROVED review pinned to the head SHA, the Merge Manager correctly
denied every merge.

Two fixes landed together:

1. **Backpressure**: bound how much of the backlog a single drain pass reads and
   re-processes, retire stale rows, and alarm before it becomes an outage.
2. **Source suppression**: stop the review route from sending routine receipts to
   the human operator mailbox at all -- they now land in an audit log principal.

## Env knobs

All are optional with safe defaults. `0` or an invalid value falls back to the
default (a batch cap / retention / threshold of 0 is nonsense, so it is ignored).
Set them on the `bdc-harness` server container. Note: a container **restart does
NOT re-read env** -- a change requires a pull + rebuild + `--force-recreate`.

| Env var                          | Default                | Meaning                                                                                    |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `OPERATOR_INBOX_INTERVAL_MS`     | `60000`                | Drain tick interval. `0` disables the consumer entirely (KILLED).                          |
| `OPERATOR_INBOX_BATCH_CAP`       | `50`                   | Max operator rows one drain pass reads + processes. Bounds external API calls per pass.    |
| `OPERATOR_INBOX_RETENTION_MS`    | `1209600000` (14 days) | Age past which an unaddressed operator row is retired (terminal, non-draining, preserved). |
| `OPERATOR_INBOX_ALARM_THRESHOLD` | `200`                  | Backlog size at/above which the episode-deduped alarm fires.                               |

## Behavior

- **Bounded drain**: each pass reads at most `OPERATOR_INBOX_BATCH_CAP` rows,
  oldest-first by severity (blocker, then normal, then heartbeat), excluding rows
  already watermarked, retired, or addressed. The full backlog is never re-read.
- **Processed watermark** (`inbox_watermark_at` column): every row a pass touches
  is watermarked, even if ack/address fails. A watermarked row is excluded from
  the next bounded read, so it is never re-classified and never makes another
  external call. This is what breaks the reprocessing loop.
- **Retention retirement** (`retired_at` column): rows older than the retention
  window that were never addressed are retired. Retirement is monotonic,
  reversible, and terminal-but-non-draining: the row keeps `status='queued'` and
  is preserved (never deleted, never reused as `cancelled`). `retired_at IS NOT
NULL` alone is the terminal marker. Reversal is a real operation, not just
  "the row is preserved": `restoreRetiredOperatorInboxMessage(id)` clears
  `retired_at` and returns the row to the bounded drain (guarded so it only ever
  acts on a genuinely retired operator row, and idempotent).
- **Retirement is auditable, not just reversible.** Clearing `retired_at` on its
  own would erase the only evidence the row had ever been retired, making a
  restored row indistinguishable from one that was never retired. Two durable
  columns carry that history instead: `last_retired_at` (stamped at retirement)
  and `last_restored_at` (stamped at restoration). Neither is ever cleared, so
  after a reversal the row still proves both transitions occurred and when. They
  are deliberately kept out of the drain predicate, which stays the simple,
  index-friendly `retired_at IS NULL`.
- **Backlog alarm**: when the unaddressed backlog crosses the threshold, ONE
  alarm is emitted per episode (deduped, not per tick). It re-arms only after the
  backlog drops back under the threshold. The default alarm sink is a structured
  log event (`operator_inbox.backlog_alarm`) ONLY -- it does NOT wire into
  Telegram/SMS notifiers (that gate stays dark per #1456).
- **Secondary rate-limit classifier**: the shared-token GitHub path
  (`github-real-deps.ts`) now classifies a caught error as `secondary`,
  `primary_exhausted`, or `not_rate_limited`, and applies an increasing backoff
  on repeated secondary hits. SECONDARY limiting reads `/rate_limit` as FULL, so
  it is NEVER reported as quota exhaustion. The classifier is also wired into the
  operator-inbox consumer's optional GitHub comment hook.

## Backlog status read

`GET /api/dispatch/operator-inbox/status` returns the live backlog so an operator
can see pressure building before it becomes an outage:

```json
{
  "generated_at": "2026-08-28T00:00:00.000Z",
  "count": 1548,
  "oldest_created_at": "2026-07-31T13:24:05.000Z",
  "oldest_age_ms": 2372755000,
  "top_senders": [
    { "sender": "overseer", "count": 812 },
    { "sender": "taskmaster", "count": 530 }
  ]
}
```

`count` / `oldest_created_at` exclude retired rows. `top_senders` is the top 5.

## Receipt suppression (review route)

`overseer-review-route` no longer sends routine receipts to `recipient=operator`.
A receipt's disposition is classified as `information-only` or
`operator_decision_required`:

- **Ingest** information-only: `queued`, `duplicate_delivery`, `superseded_head`,
  `ignored_event`, `ignored_draft`. Operator-actionable: `blocked`,
  `custody_conflict`, `rejected_signature`.
- **Submit** information-only: `approved`, `changes_requested`, `stale_head`.
  Operator-actionable: `custody_conflict`, `merge_custody_conflict`,
  `reviewer_failed`, `submission_failed`.

Routine (`information-only`) receipts are written to the new `review-receipts-log`
dispatch principal (`notify_only`, never drained) and remain queryable via
`listMessages({ recipient: 'review-receipts-log' })`. Only operator-actionable
receipts reach `recipient=operator`.

### Enforcement is system-wide, not review-route-only

The classification above is the review route's routing _policy_. The _guarantee_
lives one layer down, in `createMessage` -- the single write path every dispatch
producer uses. A message declared `governance_classification: 'information-only'`
and addressed to the canonical `operator` principal is rejected with
`dispatch_recipient_rejected:information_only_to_operator`.

This matters because the operator mailbox can be written by any producer, not
just the review route (escalation delivery, API handlers, future callers). The
check runs against the **canonical** principal, after alias/casing resolution, so
`'  OPERATOR  '` is refused exactly like `'operator'`. It is fail-closed: the
rejected write persists nothing. Producers that omit `governance_classification`
are unaffected, so the guard is additive -- it constrains callers that have
declared a classification rather than silently changing existing behavior.

## Schema

Migration `046_operator_inbox_backpressure.sql` adds four nullable columns to
`agent_dispatch_messages` -- `inbox_watermark_at` and `retired_at` (drain state),
plus `last_retired_at` and `last_restored_at` (durable retirement audit trail) --
a partial index for the bounded drain read, and the `review-receipts-log`
principal. The SQLite
adapter mirrors all of this (hand-maintained parity, not derived from migrations).
No status-vocabulary change was made -- retirement is a column, not a new status.

## Out of scope (do not confuse)

- Draining the current production backlog is XO's operational task, not code.
- The Merge Manager / review-gate approval deadlock is a separate track
  (chip `task_80f93ecc`); this WO removes the CAUSE, that one fixes the gate.
- Telegram/SMS escalation stays dark (#1456).
