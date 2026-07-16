# Overseer Briefing v1 Contract

Status: M-42 Slice 3 implementation contract.

## Boundary

This slice delivers information only. It creates immutable operator cards, queues
three informational delivery jobs, records append-only attempt receipts, and
exposes authenticated read-only feed routes. It cannot repair, merge, branch,
change lifecycle state, edit Board records, deploy, or close GitHub issues.

## Canonical identity

The identity version is `overseer-actionable-event-v1`. Canonical JSON uses this
exact key order:

1. `identity_version`
2. `source_event_id`
3. `run_id`
4. `wo_id`
5. `event_type`
6. `step_name`
7. `event_created_at`
8. `error_class`

`card_id` is lowercase hexadecimal SHA-256 of the UTF-8 canonical JSON. Every
field is required and the source event ID and timestamp must come from durable
caller state. The workflow bridge awaits the durable event insert and derives
identity only from the returned database row. Insert failure is fail-closed: no
card, delivery job, or authorization request is created. A caller may not create
a new identity while retrying the same event.

The payload contains repository and ref evidence, PR evidence, checks,
mergeability, blocker, mechanical evidence, recovery attempted, proposed
remediation, next permitted action, responsible actor, actionable-event time,
required ruling, evidence links, lifecycle classification, and governance
classification. `payload_digest` is lowercase hexadecimal SHA-256 of recursively
key-sorted JSON. A repeated card ID with a different digest is rejected.

## Persistence

Migration `035_overseer_escalation_briefing.sql` and the SQLite initializer have
observable parity for:

- `overseer_operator_cards`: immutable, one row per card ID.
- `overseer_operator_card_delivery_jobs`: mutable scheduler state only.
- `overseer_operator_card_delivery_receipts`: append-only STARTED and TERMINAL evidence.

Card insertion and creation of the `dispatch`, `builder_monitor`, and `notion`
jobs are one transaction. Cards and receipts reject update and delete.

## Delivery

Each channel has at most three total attempts at offsets 0, 30, and 120 seconds
from card creation. STARTED is committed before a provider call and TERMINAL is
committed after its outcome. Claims use an expiring lease and a monotonically
increasing fencing token.

After restart, an expired lease with STARTED but no TERMINAL is reconciled. An
unknown provider state becomes `indeterminate` and is never retried blindly.
Any thrown transport call is response-loss and therefore `indeterminate`, not a
retryable failure. Retry is permitted only when the adapter returns an explicit
`transient_failure` proving zero provider effect. Before either receipt is
inserted, the same transaction validates that the job is still leased to the
writer with the matching fencing token and attempt number. A stale worker cannot
append evidence after a lease is reclaimed.
Dispatch uses idempotency key `operator-card:<card_id>:dispatch` and the existing
Dispatch content guard. Provider errors stored in receipts are sanitized.

The server runtime owns the delivery scheduler. It starts with the Overseer
watcher, polls due jobs on a fixed interval, and drains any in-flight claim before
shutdown completes. The retry epoch is the card persistence timestamp, not the
source event timestamp.

## XO feed

Authenticated Board principals have read-only access to:

- `GET /api/overseer/operator-cards?cursor=<created_at,card_id>&limit=<1..100>`
- `GET /api/overseer/operator-cards/{card_id}`

The list and detail routes return the same immutable card and payload digest,
derived per-channel delivery summary, and append-only receipt evidence. No POST,
PUT, PATCH, or DELETE route exists under this path.

## Notion lookup and issue 958

Notion database properties are queried separately in the exact order `Task`,
`WO ID`, `Name`, `Title`, `WO_ID`. Candidate-specific errors do not block later
candidates. The first match wins; total failure is sanitized channel evidence.
This code never closes issue 958.

## Activation

Building, testing, reviewing, or merging this slice does not activate Overseer,
enable a capability, contact a live provider for acceptance, or authorize a
production deployment.
