# Re-enqueue one Overseer review for a head whose newest review FAILED

Work order WO-HARNESS-OVERSEER-REREVIEW-FAILED-HEAD-COMMAND-01 (bdc-xo#5564). Script: `scripts/overseer/re-enqueue-review.ts`, copied into the image at `/app/scripts/overseer/re-enqueue-review.ts`.

## When to use it

A review row at a head ended `failed` (for example `review_incomplete` / `review_body_credential_leak`), the cause is now fixed, and the pull request has not changed. Nothing else will start a review of that head:

| Path | Why it does not help |
|---|---|
| push, `reopened`, `ready_for_review` | one row per head under the key `pr-review:<owner>/<repo>#<n>@<head>`; the failed row holds it, so the intake answers `duplicate_delivery` / `idempotent_replay` and inserts nothing (seen on bdc-xo PR 5518 on 2026-11-11 after a close and reopen) |
| check-completed recheck | needs a check to complete on that head; works when it does |
| unreviewed-head reconcile | leaves a head alone when it has ANY row, a failed one included |

This command is not automatic and does not retry anything by itself: an operator runs it once, with a reason.

## The command

Run it on the Hetzner host, inside the app container (the container has the operator token and Dispatch):

```bash
ssh hetzner-prod "docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts <owner/repo> <pr-number> <head-sha> <reason, at least 10 characters>"
```

Add `--dry-run` to print what would be sent without sending. To read the rows afterwards:

```bash
ssh hetzner-prod "docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --show <owner/repo> <pr-number> [head-sha]"
```

`--show` prints one line per review row (head, row id, status, created, claimed, done, and the result's disposition and reason).

On success it prints `REENQUEUED row=<new id> head=<head> prior=<failed row id>:failed sender=operator` and the `--show` command for that head. Exit codes: 0 sent (or dry run, or `--show`); 2 refused or bad usage; 1 Dispatch unreachable or it rejected the message.

## What it sends, exactly

One `run_review` message to `overseer-reviewer`:

- body: the failed row's body, unchanged (the same owner, repo, pull request number, head, base and author the failed review used); the command reads nothing from GitHub and cannot move a head;
- subject key `gh:<owner>/<repo>#<n>`, correlation id `pr-review:<owner>/<repo>#<n>@<head>` (as the push path writes them);
- idempotency key `pr-rereview:<owner>/<repo>#<n>@<head>:<k>`, where k is the number of rows already at that head plus one: a second run from the same state computes the same key and Dispatch returns the same row, so two runs at once create one row;
- `repeat_reason` `operator_request:rereview_failed:<head> <your reason>` (Dispatch requires a reason once a failed row exists). The prefix is not the automatic-re-review prefix, so it is not counted as an automatic re-review;
- sender `operator`, through `POST /api/dispatch/messages` with the container's operator token header (the same route a hand-enqueue uses). With `DISPATCH_SENDER_AUTH_MODE` unset the route takes the requested sender as a legacy sender with no principal, so the row carries sender `operator` and no principal id. The command never uses the system sender `overseer`; if the route refuses `operator` (HTTP 401 or 403, for example if sender auth is switched to `enforce`) it stops with a plain line. It does not widen the route.

## When it refuses (exit 2, one plain line)

- the head is not 40 hex characters, or the reason is shorter than 10 characters;
- there is no review row at that head;
- a review is already `queued` or `claimed` at that head (the line names the row);
- the newest NON-cancelled row at that head (highest `seq`) is not `failed` (use the push, recheck or reconcile path instead). Cancelled rows are skipped on purpose: when a claim wins, Dispatch cancels the other deliveries of the same head as `superseded_by_claim`, and those can be created AFTER the row that failed (PR 101, 2026-11-12: row 97be1431 failed, then six duplicates were cancelled; the first version of this command refused with "the newest row is cancelled, not failed").
- every row at that head is cancelled (nothing failed to re-run).

## Proof it worked

After running it, `--show` for the head lists the new row `queued`, then `claimed` within the review queue's normal delay, and the pull request's head (`gh pr view <n> --repo <owner/repo> --json headRefOid`) is unchanged: no close, no reopen, no push.

Tests: `bun test ./scripts/overseer/re-enqueue-review.test.ts` (decision cases on fixture rows; the real Dispatch insert path on a real SQLite store, including the two-at-once case and the premise that a same-head send returns the failed row).

## After a rebuild: the edge sweep

A review claimed while the container drains can fail on a transport reason (for example `submission_failed/head_recheck_failed:Service Unavailable`, PR 101 on 2026-11-12, 40 seconds before the restart) and nothing else will ever review that head. After each rebuild run, inside the NEW container:

```bash
ssh hetzner-prod "docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --edge-sweep <drain-start-iso> <container-start-iso> [--dry-run]"
```

The window is the start of the drain (the wrapper's `REBUILD_START` time) to the container's `StartedAt` (plus a minute of slack). It lists every FAILED review row whose result reason is a transport failure (`submission_failed`, `Service Unavailable`, `rate_limited`, `head_recheck_failed`, `ECONNRESET`, `ETIMEDOUT`) and that completed inside the window, one entry per head, and re-enqueues each through the same decision as the command above with the reason `failed at the rebuild edge`: a head that already has a newer finished review, or pending work, is refused and left alone. It prints one line per head and a summary `EDGE_SWEEP window=... candidates=N reenqueued=K refused=M errors=E`. Exit 0 unless Dispatch itself could not be read or written.
