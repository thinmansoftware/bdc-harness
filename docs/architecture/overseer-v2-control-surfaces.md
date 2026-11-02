# Overseer v2 Control Surfaces (M-94 record)

Shipped with WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01 per Motion M-99 binding term 8:
every remaining switch, its default, its writer, and the condition under which it
opens. Nothing on this list is flipped autonomously, ever.

| Surface | Kind | Default | Open condition |
|---|---|---|---|
| `OVERSEER_ENABLED` | env (master enable) | off | Container env on archon-app-1. Master switch for the whole service. |
| `OVERSEER_JUDGE_FIRST` | env (feature flag) | off (`0`) | Flip is a deploy decision announced on bdc-xo#1315 after this WO merges and the container is rebuilt. Flag off = v1 classifier path, byte-identical. |
| `OVERSEER_EMERGENCY_STOP` | env (emergency stop) | off | Human-set only. Halts ALL record handling (judging AND actions) while the watch loop stays alive; recovery is unsetting the var. |
| `OVERSEER_DRY_RUN` | env | off | Suppresses external mutations (steward handoff, PR comments) on both paths. Verdict rows, receipts, and escalation cards still write -- thinking and audit are never gated. |
| `OVERSEER_JUDGE_LADDER` | env (config) | `grok` | Comma-separated judge binaries, cheapest first (each invoked as `<bin> -p <prompt>`). Change = ops decision, announce on #1315. |
| `OVERSEER_JUDGE_MAX_RETRIES` | env (config) | `3` | Per-run routine judge-health retry ceiling. Not a daily call cap (daily circuit deleted -- it killed 60% of verdicts; see #1390 / #602). Sized for transient ladder failures without permanent re-queue. |
| `OVERSEER_JUDGE_P0_MAX_RETRIES` | env (config) | `0` | Per-run P0 judge-health retry ceiling. Default 0 = escalate on first health failure (mode matrix: P0 must not wait the routine budget). Detected via `metadata.priority`/`prio`/`labels` or `WO-P0-*` id marker. |
| `OVERSEER_USE_FAKE_GITHUB_ADAPTER` | env (legacy) | off (real) | Test/dev only. Fake adapter cannot reach GitHub. |
| `OVERSEER_WATCH_MAX_RUNS_PER_TICK` | env (load bound) | `25` | Maximum oldest-first terminal runs evaluated per 60-second watcher tick. Invalid or non-positive values fall back to 25, keeping worst-case search lookups below GitHub's 30/minute search limit. |
| `OVERSEER_MAX_REREVIEW_ATTEMPTS` | env (config) | `3` | Maximum CONSECUTIVE automatic re-reviews of one PR after a `changes_requested` verdict; the initial review is not an attempt. Counted since the last NON-automatic review that actually produced a verdict, so a hand-requested review (Dispatch nudge) re-arms the budget and a converging PR is not locked out forever. Invalid, zero or negative values fall back to 3 -- the guard never disables itself on a typo. When the budget is exhausted the push is blocked and ONE comment is posted on the PR per head (idempotent via an HTML-comment marker). Effective value is logged at boot as `overseer.pr_review.rereview_budget_configured`. (#797) |
| `OVERSEER_MAX_TOTAL_REREVIEWS` | env (config) | `10` | Lifetime hard ceiling on judged automatic re-reviews for one PR. Green fixed pushes and human reviews can re-arm the consecutive budget but never this ceiling. Invalid, zero, or negative values fall back to 10. At the ceiling ingest blocks with `rereview_total_ceiling_reached`; the receipt and PR comment report both lifetime and consecutive counts. (#797 item 4) |
| `OVERSEER_MERGE_MANAGER_MODE` | env (Merge Manager mode) | `hold-canary` | Fail-closed default. `hold-canary` logs `would_comment` / `would_merge` with association proof (run/WO/PR/SHA) and performs **no GitHub write**. `comment_findings` may post one PR review comment via `commentOnPullRequest`; **merge stays hard-off**. `execute` is explicit opt-in only (still subject to production-effect hold + provenance gate). Unknown/empty values resolve to `hold-canary`. Soft-merge / production merge authority are NOT opened by this surface. |
| `overseer_capability_state.merge.action_enabled` | DB row | `0` (writer `migration-034`) | JOHN ONLY, on the Arc B evidence package ((a)+(b) proven separately). The judge-first path never reads or writes it; the steward path keeps all its guards. |
| `overseer_capability_state.{escalation,repair,branch,lifecycle}` | DB rows | per migration-034 | Legacy v1 capability rows. Preserved read-only for history; the judge-first path does not consult them. Tier >= 1 execution tickets are a later M-99 slice. |
| M-31 permit tables (`overseer_m31_*`) | DB tables | append-only | DEAD as a gate (scope ruling 2026-07-28 on #1315). Preserved read-only for history. The permit primitive returns only as a short-lived execution ticket for Tier >= 1 mutations in a later slice. |

## Authority model (one law)

M-15 tiers, implemented in `packages/overseer/src/tier-map.ts`:

- The verdict PROPOSES a tier; code independently maps the action's REQUIRED
  tier; the STRICTER wins. Unknown action kinds fail closed to the maximum tier.
- Tiers gate EXECUTION only. Consultation (judging, verdict rows) is never gated.
- v1-of-v2 executes exactly four Tier 0 actions: `verdict_write`,
  `comment_findings`, `flag_merge_ready`, `escalate_with_evidence`. Everything
  above Tier 0 records a `tier_refused` receipt.

## Judge health (fail-loud)

`judge_unavailable`, `judge_invalid_output`, and `evidence_unavailable` are
operational alarm states on the verdict row -- never semantic verdicts. There is
no `judge_daily_budget_exhausted` outcome kind (daily call circuit removed).
Routine runs retry health failures up to `OVERSEER_JUDGE_MAX_RETRIES` (default 3);
P0 runs use `OVERSEER_JUDGE_P0_MAX_RETRIES` (default 0 = escalate immediately).
Exhaustion escalates with evidence to the operator card rail
(`overseer.judge_first.judge_health_alarm` at error level). The legacy
fail-closed collapse in `judge-second-opinion.ts` survives ONLY on the
merge-steward path, where fail-closed remains correct.

## Idempotency

One primary verdict per `(run_id, head_sha)` (unique index, claim-before-call in
`claimOverseerVerdict`). Replay never re-bills a model call and never re-acts.

## Judge ladder outages and the ladder-exhausted breaker (#847)

When a PR-review judge rung exits non-zero or throws, `pr-review-evaluator.ts`
classifies its stderr/stdout tail (`classifyJudgeOutage` in
`judge-ladder-health.ts`) before falling back to `model_exit_nonzero:<binary>`:

| Rung text | Reason code |
|---|---|
| Codex `You've hit your usage limit ... try again at <date>` | `usage_limit_until:<ISO-8601 UTC>` (`usage_limit` when the date cannot be parsed) |
| xAI / grok `insufficient credits`, `402`, `payment required` | `provider_credits_exhausted` |
| `401`, `unauthorized`, `Authentication required`, invalid API key | `auth_expired` |

These are JUDGMENT failures (the process ran), so the attempt is terminal
exactly as before: the PR review says `Reason code: <code>` and the submit
receipt carries `reason: indeterminate:<code>`.

**Breaker.** Each classified refusal is recorded per rung binary in process
memory (`judge-ladder-health.ts`: a Map keyed by binary, a Map of parked heads
keyed by correlation id, and the hour of the last notice; a clean exit clears
the rung). When EVERY rung in `OVERSEER_JUDGE_LADDER` has a record in force --
stated retry time in the future, or a credit/auth record under 60 minutes old
-- `pr-review-ingest` parks the head instead of enqueueing: ingest receipt
`blocked` / `judge_ladder_exhausted_until:<earliest ISO>`, no `run_review`
row, no review on the PR, and one Dispatch `agent_message` to `operator`
(priority `blocker`, idempotency key `judge-ladder-exhausted:<YYYY-MM-DDTHH>`)
per hour naming the rungs, their codes, the earliest retry, and the parked
heads. Recovery: the review worker tick re-enqueues parked heads
(`repeat_reason` `judge_ladder_recovered:<sha>`) once the ladder is open; an
operator `run_review` whose `repeat_reason` starts
`operator_request:ladder_restored` clears the records and runs immediately.
On restart all records are empty: one review re-spawns the ladder, the breaker
re-trips, and heads parked before the restart are not auto-recovered (their
trail is the `blocked` receipt and the notice). The check-completion ingest and
the stale-verdict sweep do not consult the breaker.

## PR review ingest receipts

Every `pull_request` ingest writes one `pr_review_ingest_receipt` into
`agent_dispatch_messages` (`task_type: run_report`, `recipient: operator`).
Dispositions: `queued`, `duplicate_delivery`, `superseded_head`,
`ignored_event`, `ignored_draft`, `rejected_signature`, `custody_conflict`,
`blocked`.

`blocked` reasons include the existing fail-closed codes (`webhook_secret_not_configured`,
`payload_unparseable`, `incomplete_pull_request_context`, `rereview_attempts_exhausted`,
`rereview_total_ceiling_reached`, `enqueue_failed:...`) and:

- `base_not_incorporated:<baseRef>@<baseSha>` -- GitHub `pulls.get` reported
  `mergeable_state: dirty` (content conflict with the current base). Review is
  not queued. Base ref and SHA come from that `pulls.get` payload. The receipt
  is per delivery, not sticky: a later ingest of the same head after the PR is
  mergeable enqueues normally. `unknown` / omitted `mergeable_state` must not
  block: GitHub returns those while it is still computing mergeability, and
  treating them as conflicts would drop every fresh PR from review. (#845)
- `judge_ladder_exhausted_until:<ISO>` -- every configured judge rung is out of
  quota, credits, or credentials, so the head is parked rather than reviewed.
  See the breaker section above. Checked BEFORE the mergeability read: a parked
  head does not spend a GitHub call. (#847)
