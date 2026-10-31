# Dispatch principal transport

WO-HARNESS-DISPATCH-PRINCIPAL-TRANSPORT-01.

This runbook describes the source contract for a low-privilege Dispatch
principal that sends, lists, and acknowledges ordinary mail without an
operator credential. Source merge is not live activation. Do not mint a
credential, edit a registry, change a network rule, or call a production API
from this document.

## Supported routes

Principal-only transport is exact. No other private API accepts it.

| Method | Path |
| --- | --- |
| POST | `/api/dispatch/messages` |
| GET | `/api/dispatch/messages` |
| POST | `/api/dispatch/messages/{id}/ack` |

`{id}` is one path segment. Claim, result, address, cancel, renew-lease,
worker, lease, and every other private route stay denied for this transport.

## Credential headers

Send both headers together:

- `x-dispatch-principal-id`
- `x-dispatch-principal-token`

Placeholder values only:

- principal id: `example-principal`
- token: `example-token-not-real`

The companion never receives an operator token. Do not put
`ARCHON_OPERATOR_TOKEN`, `x-archon-operator-token`, or an `Authorization`
bearer operator token in a companion request.

A real operator token, when it is actually valid, keeps the existing operator
path even if these principal headers are also present. An empty, partial,
invalid, or disabled principal header fails closed. It does not fall back to
a legacy sender.

## Least privilege

Send requires the `send` role and a `send_as` value that matches the message
sender. The only permitted task is ordinary `agent_message`. The recipient
cannot be `board`. `run_review`, `draft_spec`, `run_report`, `board_motion`,
and board petitions are denied. Message text does not add rights.

List requires the `receive` role and exactly one `recipient` query parameter
whose canonical value is in `receive_as`. A missing, empty, duplicate, or
foreign recipient is denied before a mailbox read. `message_id`,
`correlation_id`, and `after_seq` stay mutually exclusive. Status, limit, and
subject filters do not widen the recipient. Board alias and worker credentials
are not honored on this transport (`allowBoardAlias` stays false).

Ack requires the `receive` role. The authenticated actor is the principal id.
A body `principal_id` cannot replace that actor. The row mailbox recipient
(`resolved_recipient` when set, otherwise `recipient`) must be in `receive_as`.
A `receive_as` alias does not mint a different mailbox actor. Repeated ack of
the caller's own row stays idempotent. Address, cancel, claim, and result are
not part of this transport.

Denials use the existing principal error codes. Responses do not echo tokens,
header values, or digests.

## Queued after_seq cursor

A queued `after_seq` read is one bounded ascending page for that recipient
and `status=queued`. The page does not use the open-row SQL filter. Cursor
calculation therefore still sees a deferred row.

Addressed rows (`addressed_at` set) and route-disposed rows
(`route_disposition` set) are skipped. Their bodies are not returned, and the
safe cursor advances over each skipped sequence. `acknowledged_at` by itself
does not skip a row.

The first otherwise-open row whose `not_before` is strictly in the future is
a barrier. The response returns only eligible earlier rows and stops before
that sequence. The barrier and every later row stay out of this page.
`next_after_seq` remains the last safe sequence before the barrier.
`page_full` is false. That false value means the walk stopped at a deferral.
Later queued rows for this recipient can still be waiting. Poll again from
the returned `next_after_seq` on a later normal poll. Do not busy-loop.

A raw page filled with addressed or route-disposed rows sets `page_full` to
true when that raw page reaches its limit. Continue from `next_after_seq`.
`page_full` follows the raw page size, not the number of visible messages.

A non-null `not_before` that cannot be parsed fails the request with
`dispatch_not_before_unparseable`. The response has no message body and no
cursor fields, and the stored delay stays in place.

Other recipients are unaffected. Legacy list, `message_id`, `correlation_id`,
and non-queued `after_seq` keep their existing behavior.

## Preserved limitation

When both principal headers are omitted, a matching `Host` and
`cf-access-authenticated-user-email` can still satisfy `isAllowedAccessEmail`.
That predicate is not cryptographic authentication. This work order does not
close that boundary, and it does not call the boundary a proven production
exploit.

## Activation

Landing this source change does not enable a companion, issue a token, or
open the private API. Those steps stay separate reviewed operations.
