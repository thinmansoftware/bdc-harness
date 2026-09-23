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
`taskmaster`, **authenticated sender `overseer`**, subject key
`gh:owner/repo#number`. The body is JSON discriminated by
`kind: "overseer_remediation_candidate"`:

> The sender is `overseer`, NOT `overseer-review-route`. M-129 Phase 1.5
> (PR #669) replaced `createMessage` with `createAuthenticatedMessage`, whose
> `bindSenderContext` admits exactly three system senders -- `dispatch`,
> `overseer`, `taskmaster`. `REMEDIATION_SENDER` names the real one and the
> emitter binds that constant, so the two cannot drift; an integration test
> asserts the sender on the **stored row**, not just on the constant. This doc
> and the constant both said `overseer-review-route` until PR #740 [minor]
> (2026-09-04).

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

### Two dispatch rules this path must satisfy (both were live defects)

Both were caught by the real-DB integration test in
`pr-review-wiring-integration.test.ts` on 2026-08-28. A mocked emitter passes
happily while production fails on first use, which is why that file exists.

1. **`taskmaster` must be a seeded dispatch principal.** `createMessage` calls
   `assessDispatchRecipientWithQuery` and rejects any recipient with no row in
   `dispatch_principals` (`missing_principal`). Seeded by **migration 046**,
   plus `000_combined.sql` and the SQLite adapter's `seedDispatchPrincipals()`
   mirror -- **that mirror is hand-maintained and NOT derived from the
   migrations**, so a new principal must be added in all three places.
2. **Attempt 2+ must carry a `repeat_reason`.** Once any earlier message under
   the PR's subject key is terminal, `createMessage` throws
   `repeat_reason_required` -- the dispatch layer refuses to silently re-open a
   settled subject. The emitter supplies one naming the attempt and head.
   Without it the cap of 2 would silently have been a cap of 1.

## The auto-fixable class list

A finding is handed back only if its class is on this list. **Adding a class is
routine work: edit `AUTO_FIXABLE_CLASSES` in `remediation-candidate.ts` and add
a test.** Nothing else changes.

| Class id             | Covers                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| `build_failure`      | Build / compile / type errors the toolchain ALREADY REPORTED.                           |
| `test_failure`       | Tests OBSERVED FAILING. Missing coverage is excluded -- see below.                      |
| `lint_or_format`     | Violations a NAMED TOOL reported (eslint/prettier/...). Bare "format"/"style" excluded. |
| `migration_ordering` | Ordering the SCHEMA rejects (FK/constraint violation). Excludes redesign judgments.     |
| `ascii_violation`    | Non-ASCII where the ENCODING RULE is the defect. Excludes Unicode rendering bugs.       |

### The rule when adding a class: demand MECHANICAL EVIDENCE

A pattern must require evidence of an ALREADY-OBSERVED failure (a runner said
which assertion broke, a compiler named a line), not merely mention a mechanical
noun. **This is the actual security boundary** -- not the keyword blocklist
below it.

PR #740's `[major]` finding (2026-09-04) is the anchor. `test_failure` used to
mean "the word _test_ followed by a failure word", which matched
_"Test missing for unescaped user content rendered into the page"_ -- an XSS
defect wearing a coverage-gap costume -- and routed it for unattended
remediation.

The distinction that fixed it: a **missing** test is a judgment call, because
deciding what it should assert requires knowing what the code ought to do. A
**failing** test is mechanical, because the runner already said what broke. So
coverage-gap phrasings ("missing", "absent", "no test for") now fall through to
the fail-closed default and reach a human regardless of how they are worded.

All five classes were audited against this rule after PR #740 round 3
(2026-09-04) found `lint_or_format` still matching any mention of "format" or
"style" -- it routed "The API response format exposes internal identifiers", a
security judgment, for unattended remediation. The audit found two more of the
same shape: a Unicode RENDERING bug reading as `ascii_violation`, and "this
migration should be redesigned" reading as `migration_ordering`. Both fixed in
the same pass. If you add a class, assume this flaw is present until you have
written the counterexample that proves it is not.

Watch precision when editing the blocklist too: an earlier attempt at this fix
added a bare `sql` token, which matched the `.sql` extension of the migration
filename and sent the live shopops#650 anchor -- the case this whole WO exists
for -- to a human.

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
4. **Two properties, enforced in two places.** They cannot share one key.

   The only atomic primitive is the UNIQUE index on
   `(sender_principal_id, idempotency_key)`, so one key buys one guarantee:
   key it on the attempt slot and the cap is atomic but redelivery duplicates;
   key it on the head and redelivery is a no-op but concurrent heads blow the
   cap. This was learned the hard way THREE times on this PR:

   | Round | Key                                   | Fixed      | Broke                                 |
   | ----- | ------------------------------------- | ---------- | ------------------------------------- |
   | 1     | (PR, head, attempt)                   | --         | concurrent heads exceed the cap       |
   | 2     | (PR, attempt)                         | the race   | redelivery duplicates                 |
   | 3     | (PR, head)                            | redelivery | concurrent heads exceed the cap again |
   | 4     | (PR, attempt) + pre-insert head check | both       | --                                    |

   So `emitRemediationCandidate` does it in two steps against the same rows:
   - **Redelivery** is settled FIRST, by identity: if any existing candidate for
     this PR already names this head, return `claimed: false` without inserting.
   - **The cap** is then enforced by the DATABASE: claim the next free attempt
     slot, whose key is `overseer-remediation:owner/repo#N:attempt-K`. That
     insert is atomic, so concurrent racers on different heads contend for one
     row and exactly one wins. A loser tries the next slot; when all slots are
     held the cap has genuinely been reached. The loop is bounded by
     `MAX_REMEDIATION_ATTEMPTS` and cannot spin.

   **Do not fold the head back into the key.** That is rounds 1 and 3, and it
   silently unbounds the reviewer-fix-reviewer loop. A real-DB test fires four
   concurrent racers on four distinct heads and asserts exactly two rows; it
   fails with `Received: 4` against the round-3 design.

   A losing racer gets `claimed: false` and the receipt records
   `attempt_slot_already_claimed` -- never reported as a queued fix. That is
   decided by a per-call UUID nonce in `correlation_id` (caller-controlled,
   stored verbatim, not part of the key): body comparison could not tell a fresh
   insert from a byte-identical replay.

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

The count is an **optimization, not the enforcement mechanism**. It short-
circuits the common case cheaply, but it is a read and therefore racy on its
own. The cap is actually enforced by the UNIQUE constraint on the attempt slot
(safety rule 4). Do not "improve" this by trusting the count alone.

## Known scope limit (deliberate)

Owner selection defaults to the lane that built the PR (`owningLane`). The
general problem -- the machine ASSIGNING an owner to ownerless work -- is a
board design question John raised 2026-08-28 and is explicitly NOT part of this
WO.

## Taskmaster consumer status

**NOT YET BUILT -- and no longer blocked.** The freeze is OVER: bdc-harness
PR #669 (M-129 Phase 1.5) merged **2026-08-30**, so
`packages/server/src/taskmaster/*` is editable again.

The Overseer half and the message contract are complete and tested. What remains
is the consumer that reads candidates and subjects them to
budget/backoff/eligibility -- unblocked, unowned, follow-on work. Spec Section 11
scenario 8 stays skipped only because there is no consumer to assert a refusal
against (verified by grep: nothing in `packages/server/src/taskmaster/` reads
`overseer_remediation_candidate`). It unskips when that lands.

Until the consumer exists, candidates accumulate as queued dispatch rows
addressed to `taskmaster` and nothing fires -- which is the safe direction.
