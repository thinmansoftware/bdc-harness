# Re-enqueue one Overseer review for a head whose newest review FAILED or ended indeterminate prompt_too_large

Work order WO-HARNESS-OVERSEER-REREVIEW-FAILED-HEAD-COMMAND-01 (bdc-xo#5564), extended by WO-HARNESS-BUNDLE-REVIEW-PROOF-REPAIR-01 (bdc-xo#6398). Script: `scripts/overseer/re-enqueue-review.ts`, copied into the image at `/app/scripts/overseer/re-enqueue-review.ts`.

## When to use it

`prompt_too_large` is terminal: a fully composed review prompt over 1,048,576 UTF-8 bytes invokes no model or ladder and is not automatically retried. Exactly the cap is allowed; all diff text (including generated files and binary markers) remains included. Do not re-enqueue an unchanged oversized prompt; resolve its scope through the XO first.

Bundle exclusion (#6357 B) is OFF by default. It requires a separate XO enable GO and independently admitted immutable `OVERSEER_BUNDLE_PRODUCER_COMMIT` plus `OVERSEER_BUNDLE_EXCLUSION_ENABLED=1`; this runbook is not authorization to set them. The controlled Ubuntu producer uses no cached Bun: Python verifies the pinned official Linux x64 archive SHA256 before extraction/execution, then captures the raw checkout identity and verifies it and the runtime around a dependency-free check, BEFORE installation. Only the exact anchor generator (built-in fs/promises and path imports), root package manifest and Bun configuration are eligible; a changed/non-built-in generator gets no receipt. The receipt explicitly states phase preinstall / dependenciesInstalled false. Installation and ordinary CI, including an ordinary bundle check, follow the receipt; neither can produce a fallback receipt. The identity guard is unchanged and has no mode/path allowlist. Its fresh private HOME and PATH exclude inherited runtimes/config; `HUSKY=0` is an explicit admitted producer delta. XO independently checks the candidate archive pin against official published checksums before admission. Job logs record runner/tool/runtime identities and the producer receipt; a version string is not identity.

For frozen PR1609 head `314720763dcc0e6813582470b99278b79ddac7db`, the future path is ONE separately XO-authorized `reopened` pull-request event after the producer merges. Do not trigger it from construction. GitHub must execute the new approved workflow/helper at the actual refreshed PR merge checkout, with the captured base/head parents and complete bundle/input inventories matching the frozen head. The head's obsolete workflow/helper may equal its merge base or the independently admitted producer, nothing else; the rest of the frozen set is described below. If GitHub does not execute that exact approved producer, proof is unavailable. No head push, historical rerun, workflow_dispatch, local or container output substitutes for the new event-authenticated run.

Anchor and frozen set (#6398 D3, Contract Amendment signed on bdc-xo PR 6397). The anchor is the pull request's authenticated base, not a fixed commit: the live base ref must be `dev`, `compare/<base>...dev` must be `identical` or `ahead` (base is on dev), and `compare/<producer>...<base>` must be `identical` or `ahead` (the admitted producer is an ancestor of base). The coverage notice names that base as the anchor. PRE-RECEIPT files are frozen: the workflow `.github/workflows/test.yml`, everything under `scripts/ci/`, the generator, every closure file directly in the repo root or directly in `scripts/` (lock files, JSON such as `tsconfig.json` and `package.json`, `bunfig.toml`, `.env*`, `.npmrc` and the like), and `.gitattributes` / `.gitmodules` at any depth. The workflow and helper in the tested checkout must equal the admitted producer's; every other pre-receipt file in the tested checkout must equal the base's, and the pull request may not change it (dev drift is accepted; a pull-request change is refused and the full diff is kept). POST-RECEIPT files (workspace manifests, nested lock files, `.husky/`, `patches/`, other JSON) are no longer compared: they run only after the receipt is printed. Python runs the producer as `python3 -I`, so it never imports modules from `scripts/ci/`.

Log rules (#6398 D5). In the job log that is read, more than one timestamped `BUNDLE_PROOF_V1` line refuses the proof, and any timestamped `BUNDLE_PROOF_UNAVAILABLE` line refuses the proof, whatever else the log holds. Code that runs after the producer (install lifecycle scripts, tests) can print such lines; either one only refuses. A receipt is authentic only because of where its log line came from: these rules assume a complete, append-only job log in which masking never rewrites an earlier line.

Timing and re-runs (#6398 D2). When a pull request changes the bundle and its newest Test Suite pull_request run is not yet `completed` (any of its six jobs still running, Windows included), the review defers as `CHECKS_PENDING` with pending check `Test Suite`, before the full diff or any blob is read; the existing checks_pending recheck runs it again. A run that needed a re-run is accepted: the latest attempt's `test (ubuntu-latest)` job is then a carried-forward copy (new id, same start and end times, the earlier attempt's log). The receipt's attempt names the earlier attempt, and that attempt's own job must be its single successful Ubuntu job with a successful step 3 and the same times; the receipt used is the one in that job's log.

The consumer authenticates the Actions run/attempt/suite/check/job/step and complete Git tree inventory, reconciles every text hunk against base/head blobs, preserves genuine binary markers, and requires raw LF-only bundle bytes. Untrusted/missing producer proof retains the entire authenticated diff; incomplete source coverage prevents review. A protected notice names any exact-file exclusion and proof identities independently of model findings. Both live head and base must still match immediately before publication. Exclusion does not relax required-check or prompt-cap gates.

A review row at a head ended `done` with result `changes_requested` / `indeterminate:prompt_too_large` (done-indeterminate), for example a bundle review that started before its Test Suite run finished, and the cause is now fixed (#6398 D2b). The same command re-enqueues it.

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

On success it prints `REENQUEUED row=<new id> head=<head> prior=<prior row id>:failed sender=operator` (or `prior=<prior row id>:done-indeterminate` for a done-indeterminate row) and the `--show` command for that head. Exit codes: 0 sent (or dry run, or `--show`); 2 refused or bad usage; 1 Dispatch unreachable or it rejected the message.

## What it sends, exactly

One `run_review` message to `overseer-reviewer`:

- body: the prior row's body, unchanged (the same owner, repo, pull request number, head, base and author the failed review used); the command reads nothing from GitHub and cannot move a head;
- subject key `gh:<owner>/<repo>#<n>`, correlation id `pr-review:<owner>/<repo>#<n>@<head>` (as the push path writes them);
- idempotency key `pr-rereview:<owner>/<repo>#<n>@<head>:<k>`, where k is the number of rows already at that head plus one: a second run from the same state computes the same key and Dispatch returns the same row, so two runs at once create one row;
- `repeat_reason` `operator_request:rereview_failed:<head> <your reason>` (Dispatch requires a reason once a failed row exists), or `operator_request:rereview_indeterminate:<head> <your reason>` for a done-indeterminate row. The prefix is not the automatic-re-review prefix, so it is not counted as an automatic re-review;
- sender `operator`, through `POST /api/dispatch/messages` with the container's operator token header (the same route a hand-enqueue uses). With `DISPATCH_SENDER_AUTH_MODE` unset the route takes the requested sender as a legacy sender with no principal, so the row carries sender `operator` and no principal id. The command never uses the system sender `overseer`; if the route refuses `operator` (HTTP 401 or 403, for example if sender auth is switched to `enforce`) it stops with a plain line. It does not widen the route.

## When it refuses (exit 2, one plain line)

- the head is not 40 hex characters, or the reason is shorter than 10 characters;
- there is no review row at that head;
- a review is already `queued` or `claimed` at that head (the line names the row);
- the newest NON-cancelled row at that head (highest `seq`) is neither `failed` nor done-indeterminate (`done` with exactly `changes_requested` / `indeterminate:prompt_too_large`); the line names the row, its status and its verdict (use the push, recheck or reconcile path instead). Every other `done` row is refused. Cancelled rows are skipped on purpose: when a claim wins, Dispatch cancels the other deliveries of the same head as `superseded_by_claim`, and those can be created AFTER the row that failed (PR 101, 2026-11-12: row 97be1431 failed, then six duplicates were cancelled; the first version of this command refused with "the newest row is cancelled, not failed").
- every row at that head is cancelled (nothing failed to re-run).

## Proof it worked

After running it, `--show` for the head lists the new row `queued`, then `claimed` within the review queue's normal delay, and the pull request's head (`gh pr view <n> --repo <owner/repo> --json headRefOid`) is unchanged: no close, no reopen, no push.

Tests: `bun test ./scripts/overseer/re-enqueue-review.test.ts` (decision cases on fixture rows; the real Dispatch insert path on a real SQLite store, including the two-at-once case and the premise that a same-head send returns the failed row).

## After a rebuild: the edge sweep

A review claimed while the container drains can fail on a transport reason (for example `submission_failed/head_recheck_failed:Service Unavailable`, PR 101 on 2026-11-12, 40 seconds before the restart) and nothing else will ever review that head. After each rebuild run, inside the NEW container:

```bash
ssh hetzner-prod "docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --edge-sweep <drain-start-iso> <container-start-iso> [--dry-run]"
```

The window is the start of the drain (the wrapper's `REBUILD_START` time) to the container's `StartedAt` (plus a minute of slack). It lists every FAILED review row whose result reason is a transport failure (`submission_failed`, `Service Unavailable`, `rate_limited`, `head_recheck_failed`, `ECONNRESET`, `ETIMEDOUT`) and that completed inside the window, one entry per head, and re-enqueues each through the same decision as the command above, failed rows only (never a done-indeterminate row), with the reason `failed at the rebuild edge`: a head that already has a newer finished review, or pending work, is refused and left alone. It prints one line per head and a summary `EDGE_SWEEP window=... candidates=N reenqueued=K refused=M errors=E`. Exit 0 unless Dispatch itself could not be read or written.

## Re-admitting the bundle exclusion after #6398 merges

Strictly in this order. Merging the work order authorizes none of it, and the exclusion stays disabled until step 3 is done.

1. Archive checksum (XO, independently): download the official `SHASUMS256.txt` from the oven-sh/bun release `bun-v1.3.11` and confirm its `bun-linux-x64.zip` line equals `ARCHIVE_SHA256` in the merged helper. A mismatch stops admission.
2. New pin (XO): the new pin is the merge commit of the #6398 pull request on dev. Confirm on GitHub that it is on dev, that its `test.yml` step 3 line carries `-I`, and that its helper and consumer blob ids equal the approved pull request head.
3. Re-enable (XO, after 1 and 2, with no review or build jobs active): rebuild archon-app-1 to the merge commit by the recorded harness procedure with the exclusion still disabled; take a dated backup of `/opt/bdc/archon/.env`; restore exactly the four enable lines (names checked against the enabled backup, values never printed) with the producer pin set to the new pin; confirm the diff against the new backup is exactly those four lines; recreate the container without a build; record the raw readback (`OVERSEER_BUNDLE_EXCLUSION_ENABLED` prints 1, `OVERSEER_BUNDLE_PRODUCER_COMMIT` prints the new pin, HEAD equals the merge commit, healthy with 0 restarts, `bundleRunPending` found in the running evaluator source). Blank output is a failure. Way back: restore the dated backup and recreate the container.
4. Final live evidence (only after 3): the producer must be an ancestor of base, so no earlier event qualifies. For each bundle pull request, cause one fresh pull_request event (one XO-authorized close and reopen, or the owner's merge of dev), wait for the Test Suite run to complete on all six jobs, confirm the Ubuntu job log has exactly one `BUNDLE_PROOF_V1` line and no `BUNDLE_PROOF_UNAVAILABLE` line, then re-enqueue one review per head with the command above if the newest row is done-indeterminate. The review must post with the coverage notice.

Tests: `bun test ./packages/overseer/src/__tests__/bundle-review-proof.test.ts ./scripts/overseer/re-enqueue-review.test.ts` and `python3 scripts/ci/verified-bundle-proof.test.py`.
