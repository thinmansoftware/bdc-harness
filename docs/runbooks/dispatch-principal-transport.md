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

## Credential expiry

A credential record may carry an optional `expires_at`. The value must be an exact UTC timestamp in the form `YYYY-MM-DDTHH:MM:SS.sssZ`, for example `2026-12-12T14:00:00.000Z`. Anything else is rejected when the principal config is loaded, with `dispatch_principal_config_invalid_expiry`. That includes a malformed, empty, null, non-string or impossible date, or a value that does not round-trip through `toISOString()`.

When the current server time is at or after `expires_at`, a matching token is rejected with 401 and the diagnostic `dispatch_principal_expired`. An expired matching record never falls through to legacy authentication in any sender-auth mode. A record without `expires_at` keeps the previous behavior.

For rotation, add the new record with a later `expires_at` beside the old one; each record expires on its own. A new Chief (`grokbot`) credential is issued with `expires_at` no later than 30 days after issuance (WO-HARNESS-COMPANION-MCP-MAILBOX-01).

## Windows worker tunnel recovery

The existing worker scheduled task invokes the supervising launcher from the
repository root with the managed config, SSH alias and loopback port. Its
PowerShell invocation is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dispatch-worker\start-windows.ps1 -ConfigPath "<managed-config-path>" -SshHost hetzner-prod -LocalPort 3900
```

This documents the existing invocation for the operator's installer path. Do
not launch a second copy beside the scheduled task. This source change does
not install or restart the running worker.

After startup, loss of the owned tunnel or listener reconnects only the
launcher-owned forward, still inside the existing kill-on-close job-object
pattern. The SSH alias, identity, keepalive and `ExitOnForwardFailure` options
and `127.0.0.1:3900 -> 127.0.0.1:3090` mapping stay the same. The launcher
verifies cleanup through the captured process and job before replacing its
tunnel. It verifies listener identity instead of adopting a reachable port.

There are at most three reconnect attempts per worker lifetime, with 1, 2
and 4 second backoff. Each attempt has at most 30 readiness checks separated
by one-second waits. Backoff and readiness check for worker exit throughout.
Successful reconnects do not refill the budget. Startup and actual worker
exit still use the existing supervisor policy.

Read the launcher's capped event log (rotated copy has suffix `.1`):

```powershell
Get-Content "$env:USERPROFILE\.config\bdc\logs\dispatch-launcher.log" -Tail 80
```

If `BDC_DISPATCH_LAUNCHER_LOG` is set for the task, that value is its log path
instead. Lines carry a UTC timestamp and launcher PID. Interpret these states:

| State | Meaning |
| --- | --- |
| `RECONNECT_ATTEMPT_<n>` | Attempt 1, 2 or 3 is starting after its logged backoff. |
| `TRANSPORT_RECOVERED` | The owned listener is ready and the same worker remains alive. |
| `DEGRADED_EXHAUSTED` | The budget is spent. The same launcher and worker hold; no worker signal, lock release, replacement worker or automatic budget reset occurs. |
| `FOREIGN_LISTENER_REFUSED` | A listener cannot be attributed to the owned tunnel. It is not killed or borrowed; the worker holds. |
| `OBSERVATION_UNCERTAIN` | Listener enumeration or process observation could not establish ownership. The worker holds without more reconnects. |
| `CLEANUP_UNCERTAIN` | Owned tunnel cleanup or capture could not be proved. The worker holds without retries, and the existing survivor guard blocks replacement after worker exit. |

A hold preserves in-flight work; it does not promise a finite worker shutdown.
Only the operator may arrange a reset through the existing task/installer
path after accounting for in-flight work and uncertain cleanup. Do not kill
processes by name or attach a foreign listener to this launcher.

For a live, identity-checked worker with unavailable loopback transport, the
watchdog logs `dispatch_worker_watchdog_degraded` and starts no task. An
unreadable transport probe also reports degraded. A reachable port reports
healthy, but reachability is not authenticated delivery.

After an authorized install and the next real tunnel drop, record the
`RECONNECT_ATTEMPT_` and `TRANSPORT_RECOVERED` log lines and verify exactly one
worker with the existing identity-aware lock check. Put that evidence on
bdc-xo #5669 and #3983 within seven days of installation, or at the first real
drop. This operational check is separate from hosted Windows CI qualification.

## Preserved limitation

When both principal headers are omitted, a matching `Host` and
`cf-access-authenticated-user-email` can still satisfy `isAllowedAccessEmail`.
That predicate is not cryptographic authentication. This work order does not
close that boundary, and it does not call the boundary a proven production
exploit.

## Activation

Landing this source change does not enable a companion, issue a token, or
open the private API. Those steps stay separate reviewed operations.
