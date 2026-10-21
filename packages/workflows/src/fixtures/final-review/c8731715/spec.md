# WO-HARNESS-OVERSEER-REVIEW-CLAIM-REQUEUE-LOOP-01

WO Class: CODE
cauldron_compatible: true
target_repo: thinmansoftware/bdc-harness
Base branch: dev
Priority: P1
Builder: Codex
depends_on: none
parallel_ok: true
db_constraint_impact: n/a: reuses the existing overseer_required_contexts_attempts durable counter (migration 048); no schema change and no new table or column

Repair target: PR #1213 (branch feat/wo-harness-overseer-review-claim-requeue-loop-01-thread-8915d6c1)

---

## Repair 2026-10-21

This WO is being repaired IN PLACE on PR #1213 (thinmansoftware/bdc-harness, base dev). Do not open a new PR and do not run gh pr create; push the fix to the branch named in the Repair target line above. Everything already on that branch stays; fix every Overseer finding below (Rule G: all findings fixed, then the PR is re-reviewed).

Overseer review at PR head 8915d6c1 (CHANGES_REQUESTED, 2026-10-21 13:02Z), verbatim:

> [major] packages/overseer/src/pr-review-evaluator.ts:checksAreTerminal: The name-only Map collapses distinct apps' check runs after latestAttemptPerCheck preserves them separately. If a required context has a pending run from one app followed by a completed run from another, the completed entry overwrites the pending entry and review proceeds. The downstream approval gate ignores pending runs, permitting approval before required CI completes. Preserve app identity and require all applicable latest runs for each required context to complete; add a regression test covering both input orders.

Required fix:

- checksAreTerminal (pr-review-evaluator.ts, about line 497) must not key the latest runs by normalized name alone. Keep every latest run per (app identity, normalized name) as returned by latestAttemptPerCheck, and treat a required context as terminal only when EVERY applicable latest run for that context has completed. A pending run from any app keeps the context non-terminal.
- Add two regression tests in packages/overseer/src/**tests**/pr-review-evaluator.test.ts whose names carry the bare token crossAppRequiredContext: (a) pending run from app A listed before a completed run from app B for the same required context -> checksAreTerminal returns false; (b) the same two runs in the reverse order -> false. Add a third case where both apps' latest runs completed -> true.
- The [note] items in that review (windows-latest non-required, sandbox) need no change.

Stop 10 (cross-app regression tests present):
grep -c 'crossAppRequiredContext' packages/overseer/src/**tests**/pr-review-evaluator.test.ts
Expected: 3 or more (baseline 0 at 8915d6c1, verified 2026-10-21)
These tests run inside the Stop 5 command and must pass there.

Doctrine: wo-recipe.md, wo-guide-v3.md, ai-engineering-instructions.md.
Rung classification: feature/net-new
Fire: powershell scripts/cauldron/fire.ps1 -Wo WO-HARNESS-OVERSEER-REVIEW-CLAIM-REQUEUE-LOOP-01 -Project bdc-harness -Class CODE -Tags feature
Tracking issue: thinmansoftware/bdc-xo #3485 (XO root-cause comment 2026-10-21)

PRE-FLIGHT: PASSED

- [x] Behavior spec: in-repo source (packages/overseer/src/pr-review-evaluator.ts checksAreTerminal doc comment; packages/overseer/src/adapters/required-contexts.ts header) + incident inlined below
- [x] Code audit: review-worker-clock.ts, pr-review-evaluator.ts, adapters/required-contexts.ts, adapters/github-real-deps.ts, pr-review-submit.ts, pr-review-wiring.ts read at origin/dev c4ad4c10
- [x] Schema audit: N/A (no schema change; existing durable attempt store reused)
- [x] Function inventory: Section 4 + Section 7 of this spec
- [x] UI hierarchy: N/A (no UI)
- [x] Deploy target: archon-app-1 (harness rebuild by XO after merge, Rule 11.5)
- [x] Contracts: #775 (CHECKS_UNAVAILABLE terminal), #1193 (required-checks partition)

## Self-contained source of truth (RULE)

A design doc that lives OUTSIDE the target repo (e.g. in private bdc-xo) is
UNREACHABLE to the builder container. If the governing design is not in the
target repo, you MUST inline the governing sections verbatim into
"Inlined design excerpts" below and pin BOTH the source commit SHA (40-hex)
and the file sha256 (64-hex). A bare pointer to another private repo is a
validation failure. Anchor: WO-2 plan-review escalation, run ee4ae81d.

## 1. Objective

The Overseer PR reviewer reaches a verdict as soon as every REQUIRED check on the head is complete (a slow optional check no longer holds it), a PR on an unprotected base with no checks ends in a visible terminal non-approving outcome instead of re-queueing forever, and every checks-pending deferral is logged.

## 2. Behavior source of truth

Behavior Source of Truth:
In-repo, thinmansoftware/bdc-harness origin/dev c4ad4c106cce044e640fe0826e321811ec95165f:
packages/overseer/src/pr-review-evaluator.ts (checksAreTerminal and its doc comment; CHECKS_UNAVAILABLE doc at the PrReviewVerdict type),
packages/overseer/src/adapters/required-contexts.ts (header: known / unknown / exhausted states, AttemptCounterStore keying contract),
packages/server/src/dispatch/review-worker-clock.ts (tickReviewWorkerClock deferral branches).
Prior WOs whose semantics MUST be preserved: #775 (bounded required-contexts lookup, CHECKS_UNAVAILABLE terminal non-approving), #1193 (required vs non-required check partition; non-required failures are notes only).

## Inlined design excerpts

Incident (XO, read-only, verified live 2026-10-21 against archon-app-1 at 3a39e2a3 and bdc-harness origin/dev):

1. Silent deferral. In review-worker-clock.ts the checks_pending branch calls deps.deferMessage with no log line, while the rate_limited branch logs overseer_review_rate_limited_deferred and the transport_error branch logs overseer_review_transport_error_deferred. A deferral loop is therefore invisible in the logs.

2. Optional check holds the verdict. checksAreTerminal() in pr-review-evaluator.ts computes allReportedCompleted over EVERY reported check (comment: A reported check that is still queued/in_progress means the suite is mid flight regardless of what is required) and requires it even when requiredContexts is a known non-empty set. On bdc-harness #1204 every required context (docker-build, test (ubuntu-latest)) was green while the non-required test (windows-latest) ran 25-30 minutes; the reviewer deferred every tick for about 33 minutes.

3. Unprotected base never settles. thinmansoftware/bdc-ci main is unprotected (GET .../branches/main/protection/required_status_checks/contexts returns 404 Branch not protected). Live logs show overseer.required_contexts.branch_unprotected_no_required_contexts for bdc-ci, so requiredContexts resolves to the authoritative EMPTY set. The head of bdc-ci #5 (357476a1343266d89eb4728550e97efaa27ada2e) has zero check runs (check-runs total_count 0). checksAreTerminal then takes the fallback `checks.length > 0 && allReportedCompleted`, which is false forever. Dispatch message 3f627e37 (run_review, gh:thinmansoftware/bdc-ci#5) reached fencing_token 1219 in status queued, re-claimed every tick, never terminal.

Live required-context sets for reference (2026-10-21): bdc-xo main ["Gitleaks"]; bdc-harness dev ["docker-build","test (ubuntu-latest)"]; shopops staging ["test-suite / test-suite","secrets-scan / secrets-scan","manifest-validate / manifest-validate"]; bdc-ci main unprotected.
Pinned source commit: N/A
Source file sha256: N/A

## 3. Prior art consulted

- Existing code (origin/dev c4ad4c10): review-worker-clock.ts:205-216 (checks_pending deferral, no log) vs :223-240 (rate_limited, logs) and :246-260 (transport_error, logs); pr-review-evaluator.ts:494-510 checksAreTerminal, :588-597 CHECKS_UNAVAILABLE return built from evidence.requiredContextsBlocked, :606-608 checksPending return, :272-285 partitionChecksByRequired (normalized lowercase names, latestAttemptPerCheck); adapters/required-contexts.ts:789-1001 resolveRequiredContexts (known-empty from positive unprotected evidence at :982-997), AttemptCounterStore :264-276; adapters/github-real-deps.ts:503-540 maps exhausted -> requiredContextsBlocked; pr-review-wiring.ts:956-974 maps CHECKS_PENDING -> checksPending and CHECKS_UNAVAILABLE -> requiredContextsUnavailable; pr-review-submit.ts:397-405 checks_pending disposition, blocked_required_contexts_unavailable terminal COMMENT path; review-worker-clock.ts mapSubmitOutcome maps blocked_required_contexts_unavailable to failed/blocked.
- Existing tests: packages/overseer/src/**tests**/pr-review-evaluator.test.ts (27), pr-review-required-checks-gate.test.ts (9, includes no_required_set_keeps_todays_behavior), required-contexts.test.ts, packages/server/src/dispatch/review-worker-clock.test.ts (13).
- Workflow definition: none affected. This is the in-container Overseer review worker (Dispatch run_review), not a .archon/workflows/defaults node; bdc-feature-development.yaml nodes diff-review / open-pr-if-needed are upstream and unchanged.
- Wiki: xo-wiki/wiki/modules/archon/overseer (no entry for this loop); memory note reviewer-defers-on-unprotected-bases (earlier occurrence of the same class, worked around by protecting the base, never fixed in code).
- Oracle: not queried; live code and the event store are the source of truth for this defect.
- Decision: Extend. Keep the #775 fail-closed and exhausted semantics and the #1193 partition; narrow what the reviewer waits on and bound the unprotected/no-checks case using the existing CHECKS_UNAVAILABLE path.

## 4. Scope IN

- review-worker-clock.ts: the checks_pending branch logs at warn with event name overseer_review_checks_pending_deferred and fields messageId, owner, repo, prNumber, headSha, defer_until, and pending_checks (the names of the checks the evaluator is still waiting on, or an empty list plus a reason string when none were reported). The pending names travel from the evaluator to the worker as a new optional field pendingChecks?: string[] added to PrReviewResult, ReviewerVerdict and SubmitOutcome (set by checksPending(), copied in pr-review-wiring.ts where CHECKS_PENDING maps to checksPending: true, and in pr-review-submit.ts where the checks_pending disposition is returned); no new queue or table. (Tests 1, 2)
- pr-review-evaluator.ts checksAreTerminal: when requiredContexts is a known NON-EMPTY set, terminal means every required context has a completed latest attempt (checksAreTerminal itself applies normalizedCheckName -- trim plus lowercase, the rule partitionChecksByRequired uses -- to BOTH the required contexts and the check names, over latestAttemptPerCheck output; callers pass raw names). A non-required check that is queued/in_progress no longer blocks. Delete the regardless-of-what-is-required comment and the all-reported-completed requirement for this case. null (UNKNOWN) still returns non-terminal. A required context that has not reported yet still blocks. (Tests 3, 4, 5)
- Known EMPTY required set (unprotected base) with at least one reported check: unchanged behaviour (wait for all reported checks to complete, then review). (Test 6)
- Known EMPTY required set with ZERO reported checks: bounded. Each such evaluation first increments, then compares (increment-then-check, so the Nth evaluation is the terminal one), the existing durable AttemptCounterStore under a key that does NOT collide with the slot resolveRequiredContexts clears on a known answer (for example a distinct baseRef namespace); after OVERSEER_REQUIRED_CONTEXTS_MAX_ATTEMPTS (default 5, resolveMaxAttempts) the evidence adapter sets requiredContextsBlocked with reason UNPROTECTED_BASE_NO_CHECKS_REASON = 'unprotected_base_no_checks' (exported constant in adapters/required-contexts.ts), so the evaluator returns the existing CHECKS_UNAVAILABLE verdict and the item ends as blocked_required_contexts_unavailable (terminal, non-approving, PR COMMENT explains, operator escalation). If a check run appears before the bound, the counter is cleared and the normal path resumes. (Tests 7, 8)
- buildRequiredContextsBlockedSummary (pr-review-wiring.ts) produces a distinct, human-readable sentence for unprotected_base_no_checks (base has no branch protection and no CI reported on this head; protect the base or add CI). (Test 7)
- Rule G (John 2026-10-21): every Overseer or in-lane reviewer finding on the PR is fixed before the PR is marked ready; none deferred to a follow-up. (no test: process rule)
- Runbook: add a short section to docs/operations/branch-protection.md naming the reviewer behaviour (required-only wait; unprotected base with no checks ends as CHECKS_UNAVAILABLE reason unprotected_base_no_checks after the attempt bound; the env var that sets the bound; the log line overseer_review_checks_pending_deferred to grep). (no test: documentation)

## 5. Scope OUT

- Changing which contexts are required on any repo, or protecting bdc-ci main (operator action, separate).
- The stale-verdict sweep, check-completion recheck ingest, judge ladder, merge manager.
- New verdict types, new dispositions, new tables or migrations.
- The duty officer security detector (sibling WO-HARNESS-SECURITY-DETECTOR-READS-APP-TOKEN-01; no file overlap).
- Container rebuild (XO does it after merge under Rule 11.5).

## 6. Dependencies & Sequencing

depends_on: none
Standalone -- no sibling WOs. Builds from bdc-harness dev at or after c4ad4c10 (container currently runs 3a39e2a3, an ancestor). No dependency on the in-flight simplify round.

## 7. Test scenarios

Test 1: checks_pending_deferral_is_logged_with_pending_names
Given: a review worker tick whose runAndSubmitReview double returns disposition checks_pending with pending check names ['test (windows-latest)'] and a captured logger
When: tickReviewWorkerClock processes the message
Then: one warn record overseer_review_checks_pending_deferred is emitted carrying messageId, defer_until equal to the value passed to deferMessage, and pending_checks ['test (windows-latest)']; deferMessage is still called once
Fail: no log record, or defer_until in the log differs from the deferMessage argument

Test 2: checks_pending_with_no_reported_checks_logs_reason
Given: a checks_pending outcome with an empty pending list and reason no_checks_reported
When: the tick runs
Then: the warn record has pending_checks [] and the reason field
Fail: the record is missing or omits the reason

Test 3: optional_check_in_progress_does_not_block_when_required_green
Given: requiredContexts ['docker-build','test (ubuntu-latest)'], reported check runs named 'Docker-Build' and ' test (ubuntu-latest) ' (case and whitespace differ) both completed success, and test (windows-latest) status in_progress
When: evaluatePullRequest runs with a model double that approves
Then: the verdict is APPROVE (not CHECKS_PENDING) and the model is invoked exactly once; the windows check appears under non-required in the prompt
Fail: CHECKS_PENDING is returned

Test 4: required_context_still_running_blocks
Given: requiredContexts ['docker-build','test (ubuntu-latest)'], docker-build completed, test (ubuntu-latest) in_progress
When: checksAreTerminal / evaluatePullRequest runs
Then: CHECKS_PENDING; the pending list names test (ubuntu-latest)
Fail: a verdict is formed while a required check runs

Test 5: unknown_required_set_and_unreported_required_context_still_fail_closed
Given: (a) requiredContexts null with all reported checks green; (b) requiredContexts ['docker-build','test (ubuntu-latest)'] with only docker-build reported
When: checksAreTerminal runs
Then: false in both cases (#775 / #1193 semantics kept); existing tests in pr-review-evaluator.test.ts and pr-review-required-checks-gate.test.ts pass unchanged
Fail: either case returns true

Test 6: unprotected_base_with_reported_checks_keeps_todays_behavior
Given: requiredContexts [] and one reported check in_progress, then the same check completed success
When: evaluatePullRequest runs twice
Then: first CHECKS_PENDING, then a verdict; the zero-checks counter is never incremented
Fail: terminal CHECKS_UNAVAILABLE while a check is running on an unprotected base

Test 7: unprotected_base_with_zero_checks_terminates_after_bound
Given: the evidence adapter with an in-memory AttemptCounterStore, a base resolving known-empty (unprotected_branch) and zero check runs, OVERSEER_REQUIRED_CONTEXTS_MAX_ATTEMPTS=3
When: the adapter plus evaluatePullRequest run 3 times for the same owner/repo/base/head
Then: attempts 1-2 return CHECKS_PENDING; attempt 3 returns CHECKS_UNAVAILABLE whose error contains unprotected_base_no_checks; the submit path disposition is blocked_required_contexts_unavailable and the worker posts status failed / task_outcome blocked (not deferMessage); the COMMENT summary names the unprotected base
Fail: CHECKS_PENDING on attempt 3, an APPROVE, or a deferMessage call

Test 8: zero_checks_counter_clears_when_a_check_appears_and_does_not_collide
Given: two zero-check evaluations, then a third evaluation where one check run is reported; separately, a known-answer resolveRequiredContexts call for the same head
When: the evaluations run
Then: the counter is cleared when the check appears (a later zero-check streak starts at 1), and resolveRequiredContexts clearing its own slot does not reset the zero-checks counter (distinct keys)
Fail: the bound is reached from stale counts, or a known answer resets the zero-checks streak every tick (which would loop forever again)

## 8. Stop conditions (CI-executable)

Stop 1 (deferral is logged):
grep -c 'overseer_review_checks_pending_deferred' packages/server/src/dispatch/review-worker-clock.ts
Expected: 1 or more (baseline 0)

Stop 2 (mid-flight-regardless rule removed):
grep -c 'regardless of what is required' packages/overseer/src/pr-review-evaluator.ts
Expected: 0 (baseline 1)

Stop 3 (unprotected/no-checks reason exported):
grep -c 'UNPROTECTED_BASE_NO_CHECKS_REASON' packages/overseer/src/adapters/required-contexts.ts
Expected: 1 or more (baseline 0)

Stop 4 (runbook documents the behaviour):
grep -c 'unprotected_base_no_checks' docs/operations/branch-protection.md
Expected: 1 or more (baseline 0)

Stop 5 (overseer tests):
cd packages/overseer && bun test --timeout 30000 src/**tests**/pr-review-evaluator.test.ts src/**tests**/pr-review-required-checks-gate.test.ts src/**tests**/required-contexts.test.ts src/**tests**/pr-review-wiring.test.ts src/**tests**/pr-review-submit.test.ts
Expected: all passing, 0 failing (existing tests plus Tests 3-8)

Stop 6 (worker tests):
bun test packages/server/src/dispatch/review-worker-clock.test.ts
Expected: all passing, 0 failing (existing 13 plus Tests 1-2)

Stop 7 (type check):
bun run type-check
Expected: exit 0

Stop 8 (ASCII scan):
LC_ALL=C grep -n '[^ -~]' packages/server/src/dispatch/review-worker-clock.ts packages/overseer/src/pr-review-evaluator.ts packages/overseer/src/adapters/required-contexts.ts packages/overseer/src/adapters/github-real-deps.ts
Expected: no output (exit nonzero from grep = clean)

Stop 9 (live replay, recorded by XO after merge and container rebuild):
Given archon-app-1 rebuilt to a dev head containing this PR's merge commit,
When the review worker ticks for 15 minutes,
Then sqlite3 /opt/bdc/archon-data/archon.db with query select status, task_outcome from agent_dispatch_messages where id like '3f627e37%' returns a terminal status (failed with task_outcome blocked, or done), and docker logs archon-app-1 shows no further overseer_review_checks_pending_deferred records for gh:thinmansoftware/bdc-ci#5 after that row turned terminal.
And for the next bdc-harness PR whose required checks finish before test (windows-latest), the Overseer review is submitted within one worker interval (60 s default) of the last required check completing, not after the windows check.
Failure action: reopen the issue with the log lines and the row.

## 9. Manifest requirements (CODE class)

The completion manifest MUST be manifest v2 and include:

```
WO: WO-HARNESS-OVERSEER-REVIEW-CLAIM-REQUEUE-LOOP-01
Builder: Codex
Files modified: packages/overseer/src/pr-review-evaluator.ts and packages/overseer/src/__tests__/pr-review-evaluator.test.ts (repair 2026-10-21), packages/server/src/dispatch/review-worker-clock.ts, packages/server/src/dispatch/review-worker-clock.test.ts, packages/overseer/src/pr-review-evaluator.ts, packages/overseer/src/adapters/required-contexts.ts, packages/overseer/src/adapters/github-real-deps.ts, packages/overseer/src/pr-review-wiring.ts, packages/overseer/src/pr-review-submit.ts,52 |     "yaml": "^2.7.0"
         ^
warn: Duplicate key "yaml" in object literal
   at /.archon/workspaces/thinmansoftware/bdc-harness/worktrees/archon/task-web-worker-1792598085461-v9cpv8/package.json:52:5
 packages/overseer/src/__tests__/pr-review-evaluator.test.ts, packages/overseer/src/__tests__/required-contexts.test.ts, docs/operations/branch-protection.md (touch only the files the change needs)
Files created: none expected
Tests: all/all (Stop 5 and Stop 6 commands)
PRs: <bdc-harness PR, base dev>
Merge ancestors:
 - thinmansoftware/bdc-harness dev HEAD: <sha> | manifest commit: <sha> | behind_by: 0
Grep assertions:
 - thinmansoftware/bdc-harness: grep -c 'overseer_review_checks_pending_deferred' packages/server/src/dispatch/review-worker-clock.ts -> 1 or more (baseline 0)
 - thinmansoftware/bdc-harness: grep -c 'regardless of what is required' packages/overseer/src/pr-review-evaluator.ts -> 0 (baseline 1)
 - thinmansoftware/bdc-harness: grep -c 'UNPROTECTED_BASE_NO_CHECKS_REASON' packages/overseer/src/adapters/required-contexts.ts -> 1 or more (baseline 0)
Runtime verification: Stop 9 (XO records after rebuild; message 3f627e37 terminal, required-only verdict timing observed)
Vercel deployment: N/A (not Vercel-deployed)
Invocation documented at: bdc-harness docs/operations/branch-protection.md (reviewer wait rules, bound env var, log line)
VALIDATION: PASS
```

Reviewer findings: Rule G (John 2026-10-21) -- no merge with any known finding. The builder fixes every Overseer and in-lane reviewer finding before the PR is marked ready; nothing is deferred.

## 10. Required questions (wo-guide-v3)

1. Behavior after: verdicts wait only on required checks; unprotected bases with no checks end visibly after a bound; every deferral is logged.
2. Source of truth: the in-repo files in Section 2 at c4ad4c10 plus the inlined incident.
3. Owner: bdc-harness Overseer review worker (Codex builds; Overseer reviews; XO rebuilds archon-app-1).
4. Reused logic: CHECKS_UNAVAILABLE verdict, requiredContextsBlocked evidence field, blocked_required_contexts_unavailable disposition, AttemptCounterStore (migration 048), resolveMaxAttempts, partitionChecksByRequired name normalization, latestAttemptPerCheck.
5. Schema: none changed (db_constraint_impact n/a).
6. Invariants: never APPROVE while a required check runs or the required set is unknown; CHECKS_UNAVAILABLE stays terminal and non-approving; non-required failures stay notes (#1193); stale/superseded heads stay terminal.
7. CI proof: Stops 1-8; live proof Stop 9.
8. Runs twice: deferrals are idempotent re-evaluations of the same head; the durable counter makes the bound survive restarts; a terminal item is never re-released.
