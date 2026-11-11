# Worktree copy: what is copied from the source checkout into a run worktree

Since WO-HARNESS-WORKTREE-SYNC-NO-TRACKED-OVERWRITE-01 a path that git tracks in the worktree is never overwritten by the copy.

## What the harness copies

A run works in a git worktree of the repository's source checkout (the "canonical" repo, for example `/.archon/workspaces/thinmansoftware/shopops/source`). Two places copy files from the canonical repo into the worktree:

| Where | When | Code |
|---|---|---|
| Worktree creation | every new worktree; the default entry is `.archon` plus the repository's `copyFiles` | `packages/isolation/src/providers/worktree.ts` (`copyConfiguredFiles`) |
| Archon sync | before a workflow starts, when the canonical `.archon` directory is newer than the worktree's | `packages/core/src/utils/worktree-sync.ts` (`syncArchonToWorktree`) |

Both end in `copyWorktreeFile` (`packages/isolation/src/worktree-copy.ts`).

## The rule

A path that is tracked in the worktree (listed by `git ls-files` run in the worktree) keeps the worktree's content. Every other path is copied as before: files the worktree does not track, ignored files, new files, local-only files such as an untracked `.archon/config.yaml`. A skipped path is counted in the info log line `file_copy_skipped_tracked`. If the destination is not a git checkout, or git cannot list it, nothing is skipped and the copy behaves as it always did.

Why: the canonical checkout can be on another branch than the run's base (shopops: canonical on `master`, runs on `staging`). Before this rule the copy replaced a tracked `.archon` file with the canonical branch's older text, the worktree became dirty, the gate `capture-run-scope` failed with `run_scope_dirty_at_capture`, and the lane's `git add -A` checkpoint committed the older text (runs 4cf23e7e and 39aec919, 2026-11-11).

## Prove it

Run the proof tool in the harness image (no network, throwaway repositories in the temp directory):

```bash
docker exec archon-app-1 bun run /app/scripts/worktree-copy-proof.ts
```

Expected: a line `WORKTREE_COPY_PROOF tracked_overwritten=0 untracked_copied=1` and exit 0 (log lines may come before it). On the old code the same tool prints `tracked_overwritten=1` and exits 1.

Tests: `bun test ./packages/isolation/src/worktree-copy.test.ts ./packages/core/src/utils/worktree-sync.test.ts ./packages/isolation/src/providers/worktree.tracked-copy.integration.test.ts`.

## The staging-only `.archon` case (live canary)

To prove it on a real run, put the shopops source checkout's `.archon` back into a state that differs from `origin/staging`, then fire a shopops canary on `staging`:

1. Containment backup of 2026-11-11 (the stale copy): `/.archon/backups/shopops-source-dot-archon-20261111T174459Z.tar`. Restore it over the checkout: `tar -xf <backup> -C /.archon/workspaces/thinmansoftware/shopops/source` (as the `appuser` user).
2. Check the case is real: `git -C /.archon/workspaces/thinmansoftware/shopops/source diff --name-only origin/staging -- .archon | wc -l` must print at least 1.
3. Fire the canary through the codex lane. `capture-run-scope` must complete and the pull request must change no file under `.archon/`.
4. Put the source checkout's `.archon` back to `origin/staging` afterwards: `git -C <source> restore --source=origin/staging --worktree -- .archon`.

## Not covered

The canonical checkout stays on its own branch, and untracked files copied from it can still be swept into a checkpoint by `git add -A` (unchanged behavior).
