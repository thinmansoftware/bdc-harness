# Overseer Remediation Hand-Back (verdict -> Taskmaster)

WO: WO-HARNESS-OVERSEER-VERDICT-TO-TASKMASTER-REMEDIATION-01 | Issue: bdc-xo#1835
Architecture ruled by John 2026-08-28: "Overseer's job is to give it back to Taskmaster."

## What this is

The arrow that closes the review loop. Before this, the wheel was:

```
build -> review -> [GAP] -> merge -> deploy
```

The Overseer Review Gate went live 2026-08-28 and did its first unassisted
review on `thinmansoftware/shopops#650` (head `f868542e`). It found a REAL
defect -- a backfill migration updating a parent row's `tenant_id` before its
child rows, which the composite foreign key `(case_id, tenant_id)` rejects, so
the migration can never reach its own later step. It refused the PR correctly.
Then it stopped: an operator card, zero dispatch messages, zero runs, no
builder told to fix anything.

Now a CHANGES_REQUESTED verdict whose blocking findings are all mechanically
fixable becomes a **remediation candidate** on the existing
`agent_dispatch_messages` seam that Taskmaster already reads.

## Division of labor (do not redesign this)

**Overseer judges and hands back. Taskmaster decides what actually fires.**

Overseer MUST NEVER spawn or refire a builder directly. Taskmaster already owns
lane budget, backoff, pause state, fire-eligibility, and the tick. Emitting a
candidate is a **proposal**; Taskmaster's existing gates still govern and may
refuse it. A refusal is a correct outcome, not a failure of this path.

## Invocation

There is **no command to run**. This path is invoked by the review route
itself: when the governed reviewer returns a non-approving verdict,
`runAndSubmitReview` submits REQUEST_CHANGES to GitHub and then hands the
verdict back. It is wired, not triggered.

| Concern                               | Where                                                                |
| ------------------------------------- | -------------------------------------------------------------------- |
| Classification + decision (pure)      | `packages/overseer/src/remediation-candidate.ts`                     |
| Emit site in the review path          | `packages/overseer/src/pr-review-submit.ts` (`handBackToTaskmaster`) |
| Live dispatch binding                 | `packages/overseer/src/pr-review-wiring.ts` (`createRealSubmitDeps`) |
| Tests (spec Section 11 scenarios 1-9) | `packages/overseer/src/__tests__/remediation-candidate.test.ts`      |

Run the tests:

```bash
bun test packages/overseer/src/__tests__/remediation-candidate.test.ts
```

Replay a verdict through the classifier without touching GitHub -- import
`decideRemediation` from `@archon/overseer/remediation-candidate` and pass the
finding list; it is pure (no clock, no DB, no env), so it is safe to call from
a scratch script.

## The wire contract

Written to `agent_dispatch_messages` with `task_type: 'run_review'`, recipient
`taskmaster`, sender `overseer-review-route`, subject key
`gh:owner/repo#number`. The body is JSON discriminated by
`kind: "overseer_remediation_candidate"`:

| Field                         | Meaning                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `kind`                        | Always `overseer_remediation_candidate`. Taskmaster discriminates on this. |
| `owner` / `repo` / `prNumber` | The PR to fix.                                                             |
| `headSha`                     | The exact head the reviewer examined and rejected.                         |
| `attempt` / `maxAttempts`     | 1-based attempt; cap is 2.                                                 |
| `findingClasses`              | Matched auto-fixable class ids, for audit and routing.                     |
| `verdictBody`                 | The reviewer's text, verbatim, so the builder fixes the NAMED defect.      |
| `woId`                        | Work order id when known, else null.                                       |
| `owningLane`                  | The lane that built the PR (see Known scope limit).                        |

`task_type` reuses the existing `run_review` value deliberately: adding a new
one would require a DB CHECK-constraint migration for no behavioral gain, and
the `kind` discriminator already identifies a remediation candidate.

## The auto-fixable class list

A finding is handed back only if its class is on this list. **Adding a class is
routine work: edit `AUTO_FIXABLE_CLASSES` in `remediation-candidate.ts` and add
a test.** Nothing else changes.

| Class id             | Covers                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `build_failure`      | Compilation / build / type errors named by the reviewer.                 |
| `test_failure`       | Failing or missing tests.                                                |
| `lint_or_format`     | Lint, formatting, style-rule violations.                                 |
| `migration_ordering` | Migration statement ordering, including FK-violating parent/child order. |
| `ascii_violation`    | Non-ASCII in files required to be ASCII-only.                            |

### What must NEVER be added

Design disagreements, scope questions, governance objections, security
judgments. Those are cases where a human must decide, and routing them to a
builder would launder a judgment call into a code change. A `NON_AUTO_PATTERN`
override catches these **first**, so a finding is non-auto even when its text
also matches a mechanical class ("the migration ordering here leaks a
credential" is non-auto).

## Safety rules (all enforced in code and tested)

1. **Bounded retries.** Cap 2 per PR. Exhaustion escalates to a human with
   reason `remediation_attempts_exhausted`. An unattended reviewer-fix-reviewer
   loop burning lane budget is the failure this must not create.
2. **Fail closed.** A finding matching no known class is NON-AUTO. There is no
   wildcard and no default-auto branch.
3. **Mixed verdicts go to the human.** One blocking judgment-call finding among
   otherwise fixable ones refuses the whole verdict.
4. **Idempotent per (PR, head SHA, attempt).** The key is
   `overseer-remediation:owner/repo#N:sha:attempt`, and `createMessage` is
   idempotent on it at the DATABASE level -- a re-delivered verdict returns the
   existing row instead of enqueuing a second candidate. A new head SHA yields
   a new key, which is what permits attempt 2 after a fix push.
5. **Taskmaster still decides.** Budget, pause, backoff, and eligibility all
   still apply.
6. **A hand-back failure never un-lands a review.** If the counter or the emit
   throws, the outcome degrades to "not emitted" with a stated reason and the
   finding goes to a human -- exactly where it went before this existed.

## Attempt counting: no new table

The attempt count is **derived** from the dispatch rows themselves. Every prior
candidate IS a durable row under that PR's subject key, so
`countPriorRemediationAttempts` counts them. This removes the class of bug
where a separate counter and the queue disagree. Rows count regardless of
status: a candidate Taskmaster refused still consumed an attempt -- that is the
point of the cap.

## Known scope limit (deliberate)

Owner selection defaults to the lane that built the PR (`owningLane`). The
general problem -- the machine ASSIGNING an owner to ownerless work -- is a
board design question John raised 2026-08-28 and is explicitly NOT part of this
WO.

## Taskmaster consumer status

**NOT YET BUILT.** `packages/server/src/taskmaster/*` was frozen pending
bdc-harness PR #669 (M-129 Phase 1.5), which was still OPEN when this landed.
The Overseer half and the message contract are complete and tested; the
consumer that reads candidates and subjects them to budget/backoff/eligibility
is the follow-on work. Spec Section 11 scenario 8 is skipped for this reason
and unskips when #669 merges and the consumer lands.

Until the consumer exists, candidates accumulate as queued dispatch rows
addressed to `taskmaster` and nothing fires -- which is the safe direction.
