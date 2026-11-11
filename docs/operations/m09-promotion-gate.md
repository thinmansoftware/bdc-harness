# M-09 promotion gate: the `m09-promotion-gate` check run

Motion M-09 (docs/board/motions/M-20260710-09-deploy-governance-staging-free-board-prod.md in bdc-xo) says every production deploy needs its own recorded board motion. The Overseer App posts a check run named `m09-promotion-gate` on every pull request to a covered production base so the answer is visible on the pull request. Code: `packages/overseer/src/m09-promotion-gate.ts` (the rules and `COVERED_PRODUCTION_BASES`) and `packages/overseer/src/m09-promotion-gate-wiring.ts` (the webhook handling and the GitHub calls).

## Which repositories and bases

`COVERED_PRODUCTION_BASES`: shopops-storefront `master`, shopops `master`, lspro-react `main` and `release/ce`, bdc-harness `main`, bdc-shopify-app `main`. The guard test `production_bases_match_merge_policy` keeps this table and `DEFAULT_MERGE_REPO_POLICY` (every base the merge manager never merges unattended) identical.

## When it runs

The server route `/webhooks/github/review` (`packages/server/src/index.ts`) hands every signed webhook to `processPromotionWebhook` after the review intake. The gate acts on `pull_request` events with action `opened`, `reopened`, `synchronize` or `edited` whose base is a covered base, and on a `check_run` `rerequested` for the check's own name. It first publishes `in_progress` ("M-09 evaluation pending"), then reads the pull request body, the motion file in bdc-xo at a pinned commit and the compare data, and completes the run as `success` or `failure` with one line per rule in the output summary. A pull request body needs the block `M-09 promotion:` / `motion_id: M-YYYYMMDDx` / `approved_sha: <sha>` for the rules to pass.

## Read it

```bash
gh api repos/thinmansoftware/bdc-harness/commits/<head sha>/check-runs --jq '[.check_runs[] | select (.name == "m09-promotion-gate")] | length'
```

Expected: 1 once the run has been created; the run's `conclusion` is the gate's verdict (a pull request without the block gets `failure`, which is the correct answer, not an error).

## It is informational

The check is not a required status check where branch protection does not list it (shopops-storefront `master` requires only `storefront-unit-tests`; bdc-shopify-app `main` has no branch protection), so it never blocks a merge on its own. What stops an unattended merge is the merge manager's `unattended: false` policy, the host merge script and the motions.

## Why it was silent until 2026-11-11 (bdc-xo#5533)

From its merge on 2026-11-07 (bdc-harness #1516) the gate posted nothing on any covered base. The in-progress publish sent `conclusion: null` (m09-promotion-gate-wiring.ts, in `publish`, the `conclusion` spread; line 187 before the fix), and GitHub rejects a null conclusion with HTTP 422 ("For 'properties/conclusion', nil is not a string"), on both create and update. The gate retried, raised `RejectedPromotionCreate` (line 85), and the webhook handler logged `overseer_review_ingest_error`. The unit tests used a fake GitHub client that accepted null, so they passed. The fake now rejects what GitHub rejects and the request omits `conclusion` until there is a result.

## When it is silent again: how to tell

1. Server log after opening or pushing to a pull request on a covered base: `docker logs archon-app-1 --since 10m 2>&1 | grep -E "POST /repos/.*/check-runs|RejectedPromotionCreate|overseer_review_ingest_error"`. A 4xx on `POST /repos/<repo>/check-runs` names the cause (the GitHub error body is not logged; reproduce it with the Overseer installation token from `scripts/github-service-token.ts overseer` and `curl`).
2. No log line at all for the pull request: the webhook did not reach the server or the repository is not in `COVERED_PRODUCTION_BASES`.
3. A throwaway probe: open a pull request to a covered base from a branch with one doc-only commit, read the check run with the command above within ten minutes, then close it unmerged and delete the branch.

## Re-evaluation and the held verdict (bdc-xo WO-HARNESS-M09-GATE-INVALIDATE-COMPLETED-CHECK-01)

A pull request body edit, a re-delivered webhook or a rerequested check makes the gate evaluate a head that already has a completed `m09-promotion-gate` run. GitHub accepts a PATCH of a COMPLETED check run back to `in_progress` (HTTP 200) and ignores it: the run stays `completed` with its old conclusion. So the gate invalidates an existing run by PATCHing it to `completed` with the conclusion `action_required` ("M-09 evaluation pending"), then PATCHes the real verdict. `neutral` and `skipped` would count as passing for a required check, so they are not used for this; `action_required` and `failure` are accepted on a completed run (tested 2026-11-11). A PATCH of a completed run does not change its `completed_at`. A head with no run still starts with a POST in progress and no `conclusion` key.
