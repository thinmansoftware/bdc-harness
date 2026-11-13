# Workroom order-alert drainer stall alarm

This alarm runs entirely inside archon-app-1. It does not use the Windows desktop Dispatch worker, a desktop heartbeat, or the Duty Officer tick. A dedicated unref'd 60-second server timer starts beside the worker-heartbeat alarm and stops at server shutdown. It does not start under `NODE_ENV=test`.

The receive-only Dispatch principal `workroom-drainer` (credential `workroom-drainer-1`) polls `GET /api/dispatch/messages?recipient=workroom-drainer` and acknowledges its order notices. Principal transport has no heartbeat route, so a successful authenticated list is its heartbeat. Both legacy and selected list reads record the credential's principal ID only after the read succeeds. Invalid credentials, forbidden recipients, invalid selectors, operator reads, and failed database reads do not count.

During working hours an alert is eligible when either condition is older than the configured threshold:

- No successful poll: silence is measured from the later of the last poll and process start. A restarted server grants a new no-poll grace period; a drainer that never polls alerts after that period.
- Old queued notice: the oldest `agent_dispatch_messages` row for recipient `workroom-drainer`, status `queued`, and `acknowledged_at IS NULL` is too old. Continued polling cannot hide failure to acknowledge orders. This condition has no new boot grace for already-old notices.

The oldest notice is read directly from the database. The ordinary list API is priority ordered and page capped, and cannot reliably identify the oldest unacked notice. The alarm never acknowledges, claims, or otherwise changes an order notice. A database read error or malformed timestamp logs `workroom_drainer_stall_check_failed` and skips that tick without an alert. Send failures are logged and retried on the next eligible tick.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKROOM_DRAINER_STALL_ENABLED` | on | Only the exact literal `false` disables checks |
| `WORKROOM_DRAINER_STALL_MINUTES` | 30 | Silence/queued-age threshold in minutes; minimum 1 |
| `WORKROOM_DRAINER_STALL_REPEAT_HOURS` | 4 | Repeat bucket width in hours; minimum 1 |
| `WORKROOM_DRAINER_STALL_HOURS` | `07:00-22:00` | Local working hours every day, start inclusive and end exclusive |
| `WORKROOM_DRAINER_STALL_TZ` | `America/New_York` | IANA timezone interpreted with `Intl.DateTimeFormat`, including DST |

Blank or non-finite numeric values fall back to defaults; finite values below the minimum clamp to 1. Malformed hours, equal start/end times, and invalid timezones fall back to the defaults. Overnight ranges such as `22:00-07:00` are supported. The clock is checked every day of the week. Outside working hours the check performs no database read and sends no message. Polls still record normally; elapsed ages continue through closed hours.

To silence this alarm, set `WORKROOM_DRAINER_STALL_ENABLED=false` through the authorized environment/restart procedure. Changing the desktop worker configuration does not silence it. Environment changes and restarting archon-app-1 are operator actions, not part of installing this source change.

## Alert and repeat behavior

The alarm calls `createAuthenticatedMessage` with the fixed system sender `{kind:'system', sender:'dispatch'}`, recipient `xo`, task type `agent_message`, and priority `normal`. Its JSON body includes `text` as a short plain-English first line, `kind: workroom_drainer_stall`, reason `no_poll`, `unacked_message_age`, or `both`, poll silence minutes, oldest notice ID/age (or null), threshold minutes, and a pointer to this runbook. Existing XO inbox routing owns delivery.

The idempotency key is `workroom-drainer-stall:<episode>:<bucket>`. For a no-poll episode, the episode is the last-poll-or-boot ISO timestamp. For an aged notice, including `both`, the episode is the oldest unacked notice ID, so fresh polls do not restart that notice's repeat window. The bucket is elapsed time since that anchor divided by repeat hours, rounded down. A successful enqueue is remembered in process to avoid repeated calls in the same bucket; Dispatch's existing idempotency key also deduplicates persisted messages. A failed enqueue is not remembered and retries next tick. A newly stalled episode after recovery alerts again. No recovered message is sent.

## Verification

Run the isolated behavior tests and the real authenticated-route seam test locally:

```sh
bun test ./packages/server/src/dispatch/workroom-drainer-stall.test.ts
bun test --timeout 30000 ./packages/server/src/routes/api.dispatch.test.ts -t 'T8:'
```

For an authorized runtime exercise, use a test environment inside the configured working hours:

1. Leave the server running and stop only the drainer. Wait longer than the threshold plus one 60-second timer tick. Verify an XO inbox message of kind `workroom_drainer_stall`, reason `no_poll` (or `both` if an old queued notice exists).
2. Resume authenticated polling and acknowledgements. After recovery there should be no new eligible alarm. A later stall is a new episode.
3. To exercise the acknowledgement check, keep polling while withholding acknowledgement of a controlled test notice. After its age exceeds the threshold, verify `unacked_message_age` even though polls remain fresh. Do not withhold or alter real customer orders for this test.
4. Verify that repeated ticks in the same repeat bucket create no additional alert. A next bucket permits another. Observe `workroom_drainer_stall_check_failed` for a dependency failure; a failed send should retry after recovery.

These runtime steps require operator authorization. Local tests and a pushed commit do not establish that the running container has the alarm or that the XO has received an alert.
