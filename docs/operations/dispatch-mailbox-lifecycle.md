# Dispatch mailbox lifecycle

WO-HARNESS-XO-MAILBOX-LIFECYCLE-01 (bdc-xo#5180). This page records how a
mailbox row ends, how repeats collapse, the cooldown variable, and the one-time
cleanup script with its dry-run to execute procedure. It is the invocation
record for `scripts/dispatch/mailbox-lifecycle.ts`.

A mailbox principal is an active `dispatch_principals` row with delivery mode
`drain_on_start` or `notify_only` (for example `xo`, `operator`, `astra`). A
row in a mailbox is **open** when it is status `queued`, has no
`acknowledged_at`, no `addressed_at` and no `route_disposition`.

## Terminal state on address

`addressMessage` (packages/core/src/db/dispatch.ts) now sets, in the same
UPDATE that writes `addressed_at` and `addressed_by`:

- `status = 'done'`
- `completed_at = addressed_at`

So an addressed row leaves every reader that selects status `queued`. Unread
and acknowledged-not-addressed rows are unchanged and stay `queued`.

A repeated address, and an acknowledge on an addressed row, still return ok for
the row's own principal: `validateMailboxActor` lets a row with status `done`
and `addressed_at` set pass. Any other non-queued status is still refused with
`not_queued`. A different principal is refused before the status check
(`wrong_recipient` for another mailbox, `actor_mismatch` for a different
acting principal).

The dispatch outcome-notice reconciler skips rows with `addressed_at` set or a
`route_disposition` set, so addressed and superseded rows never produce an
`outcome-notice:` blocker back to their sender.

`/api/dispatch/status` takes `queue` from a whole-table `GROUP BY status` and
adds, for each mailbox principal under `mailbox`, `unread`, `acked` and
`addressed` derived from the timestamp columns. The existing `mailbox` keys keep
their meaning; the 500-row page is used only for `operator_reports` and
`execution_handoffs`.

## Supersede on repeat

`supersedeRepeatByNewer({ older_id, newer_id, actor }, query?)` retires an older
open row in favour of a newer row of the same group:

- the older row becomes `status = 'done'`, `completed_at` set,
  `route_disposition = 'superseded'`, `route_disposed_at` set, and
  `result_body = {"reason":"repeat","superseded_by":"<newer id>"}`;
- it is **never** set to `cancelled` (cancellation means cancellation only) and
  stays readable;
- the newer row is not touched and stays open.

It changes the older row only when that row is still `queued`, never
acknowledged or addressed, not already disposed, from a sender principal that
starts with `system:`, and has the same recipient, sender and subject as the
newer row. The subject is `subject_key`, or `correlation_id` when both rows
have no `subject_key`. The actor must start with `system:`.

## Emitters and the cooldown

`createAuthenticatedMessage` takes `collapse_repeats: true`. It is honoured only
for a fixed system sender writing to a mailbox principal; a `worker_poll`
recipient is never collapsed. In one transaction it:

1. returns the existing row on an idempotency hit;
2. reads the open rows from the same sender to the same recipient for the same
   subject;
3. if one of them is younger than `DISPATCH_REPEAT_COOLDOWN_HOURS`, writes
   nothing, returns that existing row and logs `dispatch.repeat_suppressed`;
4. otherwise inserts the new row and supersedes every older open row of the
   group. When it folds in older rows it appends one line to the new row's body:
   `Folded in: <N> earlier open notice(s) for this subject (<ids>).`

`DISPATCH_REPEAT_COOLDOWN_HOURS`: unset or empty means 24. A finite number of 0
or more is used as given; `0` disables the cooldown, so every send writes a row
(and still supersedes the older open rows). Anything else means 24.

The emitters that set `collapse_repeats: true`:

| Emitter | File | Sender | Subject |
|---|---|---|---|
| Duty Officer escalation (`escalateToXo`) | packages/server/src/dispatch/duty-officer-clock.ts | system:dispatch | the source row's subject |
| XO escalation handoff (`ensureXoEscalationHandoffs`) | packages/core/src/db/dispatch.ts | system:dispatch | the source row's subject |
| Taskmaster nudge | packages/server/src/taskmaster/loop.ts | system:taskmaster | the thread's subject |
| Taskmaster expectation retry | packages/server/src/taskmaster/expectations.ts | system:taskmaster | the original row's subject |
| Taskmaster EXHAUSTED escalation | packages/server/src/taskmaster/expectations.ts | system:taskmaster | the chased row's subject, else none |

Duty Officer escalations and XO handoffs share sender `system:dispatch`, so one
can suppress or supersede the other for the same subject in the xo mailbox.

Notes on each emitter:

- Handoffs: the source query skips a source whose subject already has an open
  `system:dispatch` xo row younger than the cooldown, and reads newest first, so
  suppressed sources cannot starve the 100-row limit. A suppressed send does not
  count in the returned number.
- Nudges: a suppressed nudge registers no new expectation; the existing open row
  already has one.
- Retries (decision D1): a retry to a mailbox whose original is still open and
  unread inside the cooldown is suppressed. A suppressed retry still spends its
  attempt; the recovery step treats it as sent (not crashed), so the next retry
  or the EXHAUSTED escalation follows on schedule.
- EXHAUSTED (decision D2): the row carries the `subject_key` of the item the
  expectation chases, so EXHAUSTED rows collapse per subject. When the chased
  item has no `subject_key`, the row has none and groups per expectation (its
  correlation id is `tm-expectation-<id>`).

## One-time cleanup: scripts/dispatch/mailbox-lifecycle.ts

The only path for the backlog cleanup. No hand SQL. It never cancels or deletes
a row. SQLite only (the deployed harness database). Machine actor:
`system:mailbox-lifecycle-01`.

Flags:

| Flag | Meaning |
|---|---|
| `--recipient <r>` | mailbox to act on (default `xo`) |
| `--evidence-file <path>` | disk evidence for class K3 (see below) |
| `--execute` | mutate; without it the run is a dry run |
| `--confirm <token>` | the `confirm_token` printed by the approved dry run |
| `--out-dir <dir>` | export directory; required with `--execute` |
| `--github` | read issue state and labels for the open-work list (needs `GH_TOKEN` or `GITHUB_TOKEN`; read only) |

Classes:

| Class | What it does |
|---|---|
| `backfill` | addressed rows still `queued` become `done` with `completed_at = addressed_at`. Counts are printed for every recipient; only `--recipient` is changed |
| `k1_collapse_dispatch` | open `system:dispatch` repeats collapse to the newest per group |
| `k2_collapse_system` | open repeats from every other `system:*` sender collapse the same way |
| `k3_disk_alerts` | open rows from sender `xo` whose body begins `DISK ALERT` are expired, only with fresh evidence below threshold |
| `k4_customer` | protected: rows from `order-events` or `whatnot-webhook` are never changed by any class; open ones are listed for the desk operator |
| `k5_large_bodies` | bodies over 20000 bytes are exported, verified and then stubbed |

Collapse groups are recipient, sender principal and subject (`subject_key`,
else `correlation_id`). The newest row of each group stays open. Collapse only
applies when the recipient is a mailbox principal, so worker queues such as
`run_review` rows are never touched. Seat-authored rows (sender principal not
`system:*`) are never superseded or expired, except by K3. Old subject-less
EXHAUSTED rows each carry their own correlation id, so the cleanup does not
group them; the dry run prints their count as `exhausted_subjectless_uncollapsed`.
No `subject_key` is backfilled into existing rows.

K3 evidence file (JSON, taken by the operator on the host, at most 15 minutes
old when the script runs):

```json
{
  "taken_at": "2026-11-22T18:00:00.000Z",
  "host": "ubuntu-8gb-hil-1",
  "threshold_percent": 85,
  "df": "<the output of df -P>"
}
```

A DISK ALERT row is expired only when its body names that host and the mount
it names (the first path after the host, else `/`) reads below the threshold in
the `df` text. The evidence is stored as the row's `result_body` note. Missing,
unreadable or stale evidence refuses the class; each row left open is listed
with its reason (`evidence_missing`, `evidence_stale`, `host_mismatch`,
`above_threshold:<n>%`, `mount_not_in_reading:<mount>`).

K5 export: each large body is written to `<out-dir>/<id>.body`, read back and
checked against its sha256, and listed in `<out-dir>/large-bodies-manifest.json`
(`id`, `file`, `sender`, `subject`, `bytes`, `sha256`). All exports happen
before any class changes a row; if one fails the script exits 1 and nothing
changes. Inside the class transaction each live body is checked again against
the exported hash before it is replaced by
`{"archived_to":"<id>.body","sha256":"<hash>","bytes":<n>}`.

Journal: each class that changes rows writes one `tm_journal` row in the same
transaction: `action_type 'digest'`, `outcome 'expired'`, `thread_ref
mailbox-lifecycle:<recipient>`, idempotency key
`mailbox-lifecycle:<class>:<token>`, and a `proposal_json` citing this work
order with the count, the first and last id and the ids.

### Procedure

1. After the merge and the harness rebuild, on the host inside `archon-app-1`:

   ```bash
   bun scripts/dispatch/mailbox-lifecycle.ts --recipient xo
   ```

   For K3, take `df -P` on the host first, write the evidence file, and add
   `--evidence-file <path>`.
2. Post the full dry-run output on the work order issue for the acting XO.
   Nothing is acknowledged, addressed or cancelled until the XO confirms.
3. On the XO's confirmation, run the execute step with the token from that dry
   run (within 15 minutes of a fresh evidence file if K3 is included):

   ```bash
   bun scripts/dispatch/mailbox-lifecycle.ts --recipient xo --execute \
     --confirm <confirm_token> --out-dir /.archon/mailbox-lifecycle
   ```

   The script recomputes the set and refuses (exit 2, nothing changed) if its
   token differs, for example because new rows arrived. Then re-run the dry
   run and ask again.
4. Hand `<out-dir>/open-work-xo.txt` to Taskmaster and the arc owners. The
   script contacts nobody.
5. Post the execute output and the `open_count_sql` result on the issue, and the
   same count 24 hours later.

Exit codes: 0 done; 2 refused (usage, token missing or mismatched, schema check
failed, unsupported database); 1 failed (an export failed, or a class
transaction failed and rolled back; classes already committed stay committed,
each with its journal row).

## Known gap

`scripts/dispatch/address-batch.ts` sets `addressed_at` without moving the row
to status `done`; its test pins that status never changes. Rows it addresses
are picked up by the `backfill` class of this script.
