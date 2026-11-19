# Conflict-only gate verdict: a merge conflict does not climb

Work order WO-HARNESS-CONFLICT-ONLY-GATE-NO-TIER-CLIMB-01 (bdc-xo#5658). Code: `packages/smart-cauldron/src/judge.ts` (`conflictOnly`), `packages/smart-cauldron/src/poll.ts` (`prMergeabilityFromGh`), `packages/smart-cauldron/src/conflict-only.ts` (the handler), `packages/smart-cauldron/src/cascade.ts` (the branch before the climb).

## What happened

Run 17b2d1c3 (2026-11-12) completed cleanly and opened PR 106 for WO-CSOS-PROVISIONER-WALKER-SIGNUP-01. 21 seconds later the conductor started a codex rung for the same work order. The only failing gate condition was `PR is not mergeable`: the run took 81 minutes, main moved by two merges that touch files PR 106 also changes, and the PR conflicted. A person merged main into the branch at 15:01Z. A whole higher rung was spent on a mechanical merge.

## The verdict

`judgeGate` sets `conflictOnly: true` when ALL of these hold: terminal status `completed`, a PR was opened, the validator verdict is not `needs_revision`, and the one failing reason is `PR is not mergeable`. The flag is absent on every other verdict, so existing verdict shapes are unchanged. A rejected rung, a failed run and a run with no PR keep climbing exactly as before.

## What the conductor does instead of climbing

1. `conflict-only.ts` reads the PR (head, base, comments). If a comment with `<!-- conflict-only:<head sha> -->` already exists for this head, it does nothing again.
2. It tries ONE branch update: `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch` with `expected_head_sha`. This is GitHub's merge of the base into the branch: a merge commit, never a rebase, never a force push. It is NOT attempted on a covered production base (M-09 list); that PR gets the comment only.
3. On success (`updated`) there is no comment and no climb. The new head gets the normal checks and Overseer review. The cascade record says `status: blocked`, `blockedReason: conflict_resolved_by_update`, `conflictOnly.outcome: updated` ("blocked" here only means "no further rung was fired"; the gate has not passed yet).
4. On a conflict (HTTP 422), a refused update (403, 404) or any other failure it posts ONE comment with the marker, what the update did (the comment says plainly when no conflict was observed), the files changed on both sides since the merge base (the likely conflict set, not git's exact list), and "no higher rung was started". The record says `blockedReason: conflict_only`.
5. A handler that throws still does not climb: `conflict_only` with a note, no comment.

## Mergeability reading (fixed in the same change)

`gh pr view --json mergeable,mergeStateStatus` is read together. Only a conflict is "not mergeable" (`mergeable` CONFLICTING or `mergeStateStatus` DIRTY). A PR waiting for a required review (`BLOCKED`), behind its base (`BEHIND`), unstable, or still being computed (`UNKNOWN`) is not. The old code treated `mergeable === BLOCKED` as false, but GitHub's `mergeable` field never returns BLOCKED (it belongs to `mergeStateStatus`), so that branch was dead; it would have made every PR awaiting a review climb if it had ever fired.

## Reading it

- The cascade record JSON: `blockedReason` and the `conflictOnly` object (outcome, update HTTP status, files, whether the comment was posted).
- The PR: a comment containing `conflict-only:` is the conflict case; a new merge commit from the base is the updated case.
- The comment's `Files changed on both sides` list is computed from two compare calls and the PR's file list; it can be empty when GitHub refuses the compare.

## Not covered

The cause of the conflict (a long run opening its PR against a base that has moved) and automatic conflict resolution are not part of this change.
