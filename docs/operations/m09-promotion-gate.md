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

## The motion record the gate reads (WO-HARNESS-M09-GATE-MOTION-FORMAT-01, bdc-xo#5559)

The Board desk's template is `docs/board/templates/deploy-motion.md` in bdc-xo (PR 5558, merge commit 5f2b6bfe8e5b5f39e92add6c481f0012e74873e6). A copy is the test fixture `packages/overseer/src/__tests__/fixtures/deploy-motion-template.md`; the real header of production motion M-20261111b is the fixture `m-20261111b-head.md`. Past motions are not rewritten.

### File naming and where it must be

- One canonical file per motion: `docs/board/motions/<motion_id>-<slug>.md`, with a hyphen after the id. Companion files (packet, votes, execution record) are named `<motion_id>.<what>.md`, with a dot, and do not count. Zero or two matching files fail rule 2, and the check run says which (`expected docs/board/motions/<id>-<slug>.md ...` or `N files match ...`).
- The record must be merged to bdc-xo `main` before the promoting pull request is evaluated: the gate reads the `heads/main` tip at evaluation time and the record at that commit. If it lands later, edit the pull request description to run the gate again. Every push to the promoting pull request moves its head, so re-pin the record and the block.

### The front matter block

If the first non-blank line of the record (after fenced code and HTML comments are removed) is exactly `---`, only the block up to the next line that is exactly `---` is read; prose, tables and headings outside it never count. Inside the block each non-blank line that does not start with `#` is `key: value`, with a lowercase key at column 0. These keys need exactly ONE token as value (trailing spaces are ignored) and may not repeat: `motion_id`, `governs`, `repository`, `status`, `approved_sha`, `approved_tree`. Other keys (for example `johns_go`, `patch_id`) are ignored whatever they hold. A missing closing line, a line that is not `key: value`, a repeated key or a value with two tokens makes the record malformed and rules 2 to 5 fail; the rule 2 line names the problem (line numbers and key names, never values). A record without a block is read by the earlier whole-file scan, unchanged (which treats ANY line beginning with one of the five field names, in any case, as a field and fails the record when it is not a one-token line).

| key | rule | what it must hold |
|---|---|---|
| `motion_id` | 2 | the id in the pull request block, `M-` + 8 digits + an optional lowercase letter |
| `governs` | 3 | exactly `M-09` |
| `repository` | 4 | `owner/name` of the pull request's repository, case-sensitive; several repositories as one comma-separated token without spaces; `none` (a host or container change with no pull request) never matches |
| `status` | 5 | `CARRIED`, `RATIFIED` or `CARRIED_WITH_CONDITIONS` pass; `TABLED`, `DRAFT`, `NOT_CARRIED`, `PARKED`, `EXECUTED` and anything else (including lowercase) fail. `CARRIED_WITH_CONDITIONS` passes and the check run's summary says `carried with conditions: read the motion` |
| `approved_sha` | 6 | the full 40-hex head commit of the promoting pull request |
| `approved_tree` | 6 | one or more 40-hex git trees (`git rev-parse <head>^{tree}`), comma-separated, for a motion voted before the head existed |

### The block in the pull request description

```text
M-09 promotion:
motion_id: M-YYYYMMDDx
approved_sha: <40 hex>        (or: approved_tree: <40 hex>)
```

The third line is `approved_sha` or `approved_tree`; a block with both, or neither, is not a block and rule 1 fails. With `approved_sha` rule 6 needs the value to equal the pull request head and the record's `approved_sha`. With `approved_tree` rule 6 reads the head commit with one extra GitHub call (`GET /repos/{owner}/{repo}/git/commits/{commit_sha}`, `.tree.sha`), and passes when the value is 40 hex, equals that tree and appears in the record's `approved_tree` list (every listed entry must be 40 hex). There is no `patch_id`.

### Check a record before the pull request

```bash
bun run scripts/overseer/check-motion-record.ts <motion-file> <owner/name> <head-sha | tree:TREE>
```

Prints the fields it found and the results of rules 1 to 6 (rule 7 needs the live pull request); exit 0 when the record is readable and every rule passes, 1 otherwise, 2 for bad usage. Run it on a new motion and on every template change. Fixtures and tests: `bun test ./packages/overseer/src/__tests__/m09-motion-format.test.ts`.
