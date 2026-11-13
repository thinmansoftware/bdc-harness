# Merge holds: what stops the Overseer from merging a pull request

Work order: WO-HARNESS-MERGE-GATES-01 (bdc-xo #6036). Code: `packages/overseer/src/merge-holds.ts`.

## The rule

One function, `mergeHoldReason({ labels, draft, title })`, decides whether a pull request must not be merged.
The merge manager handler (`merge-manager.ts`, `mergePreconditionMiss`), the merge coordinator
(`merge-execution-bridge.ts`) and the single function that calls GitHub's merge API
(`createRealMergePullRequest` in `adapters/github-real-deps.ts`, re-checked on the FRESH `pulls.get` response)
all call it. A PR with any of these reasons is not approved and not merged by any harness path:

| Reason | What holds it | How a person releases it |
|---|---|---|
| `merge_hold_label` | the `merge-hold` label (matched case-insensitively, so `Merge-Hold` holds too) | remove the label |
| `run_blocked_label` | the `run:blocked` label (a PR from a non-PROCEED run, not lane-verified) | remove the label (a human decision) |
| `owner_reworking_label` | the `owner:reworking` label (set and cleared only by the owner; not HOLD) | the owner removes it |
| `pr_is_draft` | the PR is a draft | mark it ready for review |
| `fallback_pr_title` | the title starts with `FALLBACK:` (a lane's salvage PR from a failed run) | a person edits the title once the PR is judged good |
| `pr_labels_unknown`, `pr_draft_unknown` | the merge function's fresh response lacked the labels or the draft field (fails closed, never assumed clean) | none needed; it clears when GitHub returns the field |

Before this change `merge-hold` held only the coordinator. The manager checked `owner:reworking` alone, so a
run-backed PR carrying `merge-hold` was merged by the manager (shopops-storefront PR 239, 2026-11-13:
`overseer_actions` action `merged`, 17:37:42Z). A label added AFTER the evidence was assembled is now stopped
at the merge function itself.

## A draft is released, never finalized

The coordinator releases the claim for a draft BEFORE any approval or merge call (no `actioned_at`, no attempt
counted). As a second line of defence, GitHub's refusal text "Pull Request is still a draft" and every hold
reason are classified transient (`merge-skip-classification.ts`), and a hold that reaches `skip()` releases the
claim instead of consuming the retry budget. Before this change that 405 was recorded as a FINAL outcome, so
marking the PR ready later did nothing (11 verdicts between 2026-11-12 and 2026-11-13, bdc-xo #6036).
A PR that was a draft when the Overseer approved it now merges on the first coordinator tick after it is marked
ready, with no manual requeue. Consequence for people: "mark ready" can be the merge itself. Mark a PR ready
only at a head that is cleared.

## A failed run is held at ANY node

`originatingEvidenceFailure` returns `originating_run_failed` when the originating run is recorded `failed`
at any node (a failed `manifest-evidence-check` keeps `originating_run_failed_evidence_gate`). A run-less human
PR with no traceable run and a normal title still proceeds on green. The coordinator and the manager both apply
it.

Release: an `Evidence-Adjudication: <text containing the full 40-hex head sha>` comment from a login in
`MERGE_MANAGER_EVIDENCE_ADJUDICATORS`. That list is unset in the live container (bdc-xo #5986), so until it is
set the only release is a hand merge. Measured 2026-11-13 in the event store: since 2026-10-30 the manager
recorded 16 `merged` rows, 12 for completed runs and 4 for runs recorded failed; this rule would have newly
held 2 of the 16 (about one a week). This reverses the historical "tail-node false-fail" door in `watch.ts`
for failed runs: a run recorded failed is no longer merged on a green PR alone.

## Fallback PRs are drafts

The `noninteractive-salvage` node of all 13 `bdc-feature-development*.yaml` lanes opens its
"FALLBACK: opus-repaired build needs human review" PR with `--draft`, so no automatic path can approve or merge
it; a person marks it ready.

## Checks

```
cd packages/overseer && bun test src/merge-holds.test.ts src/merge-manager-holds.test.ts src/merge-execution-bridge-holds.test.ts src/adapters/github-real-merge-holds.test.ts src/merge-skip-classification-draft.test.ts src/merge-holds-run-backed.test.ts
bun test ./packages/workflows/src/lane-fallback-draft.test.ts
```

Live outcome (after the container rebuild), read with `scripts/cauldron/inspect-run.ps1 -Sql <file>`:

```
select count(*) from overseer_actions where action='merge_denied' and (result like '%merge_hold_label%' or result like '%fallback_pr_title%' or result like '%originating_run_failed%' or result like '%pr_is_draft%') and created_at > '<rebuild time>'
select count(*) from overseer_verdicts where action_reason like 'Pull Request is still a draft%' and created_at > '<rebuild time>'
```

The first should reach at least 1 within 14 days; the second should stay 0 (it was 11 in the two days before
this change).
