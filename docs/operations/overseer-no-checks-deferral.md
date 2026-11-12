# A head with no check runs: the bounded wait and `no_checks_reported`

Work order WO-HARNESS-OVERSEER-NO-CHECKS-DEFERRAL-BOUND-01 (bdc-xo#5575). Code: `packages/server/src/dispatch/review-worker-clock.ts` (the worker) and `packages/overseer/src/pr-review-submit.ts` (`submitIncomplete`).

## What you see in the log

```text
overseer_review_checks_pending_deferred  ... "pending_checks":[] "reason":"no_checks_reported" "defer_until":"..."
```

The review worker claimed a review row, found that the pull request head reports ZERO check runs, and released the row for 60 seconds (`OVERSEER_REVIEW_CHECKS_PENDING_BACKOFF_MS`). A head has no check runs when GitHub Actions did not run for that push (for example during a Actions or mirror outage). On 2026-11-11 this repeated every minute, for hours, for bdc-harness #1572, bdc-xo spec PRs 5553 and 5554, and the older bdc-xo 4885, 4984 and 5167 and shopops 1051; no review, no comment and no way to tell why.

## What happens now

The deferral stays for `OVERSEER_REVIEW_NO_CHECKS_MAX_WAIT_MS` (default 1,800,000 = 30 minutes, floor 60,000; an invalid value falls back to the default with the warning `overseer_review_no_checks_bound_invalid`), measured from the review row's `created_at`. When the head still reports zero checks after that:

1. one log line `overseer_review_no_checks_bound_reached` (row id, repository, number, head, age and bound);
2. one COMMENT review on that exact head: `Review incomplete: no_checks_reported. No approval was recorded.` (the same text and path as every other `review_incomplete` reason);
3. the row ends `failed` with outcome `blocked` and result `{"disposition":"review_incomplete","reason":"no_checks_reported", ...}`. It is not claimed again, so the deferral line stops.

A head that reports ANY check (running or not terminal, `pendingChecks` set, even an empty list for unknown required contexts) is never ended by this rule; it keeps the deferral exactly as before.

## What to do when you see the comment

- Push a new commit (or merge the base into the branch): the new head gets check runs and a fresh review row.
- Or, when the head is unchanged and checks now exist, re-enqueue that exact head with the operator command in `docs/operations/overseer-re-review.md` (`re-enqueue-review.ts <owner/repo> <pr> <head> <reason>`); it works because the newest row at that head failed.
- Do not nudge by hand to dodge the bound; the bound is what ends the loop.

## Read it

```bash
ssh hetzner-prod "docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --show <owner/repo> <pr-number> <head-sha>"
ssh hetzner-prod "docker logs archon-app-1 --since 30m 2>&1" | grep -E "overseer_review_checks_pending_deferred|overseer_review_no_checks_bound_reached"
```

The first prints one line per review row (`review_incomplete/no_checks_reported` once the bound ended it); the second shows the deferral lines and the single bound line.

Tests: `bun test ./packages/server/src/dispatch/review-worker-no-checks.test.ts` (below the bound, at the bound, the loop stops, reported checks are never ended, the bound's environment variable).
