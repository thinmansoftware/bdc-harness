# Archon lanes

## Checkpoints and salvage

Feature-development lanes commit changes produced by `diff-repair` before capturing
the final review patch. The `checkpoint-diff-repair` node is a no-op for a clean
worktree; otherwise it creates a `checkpoint(diff-repair): <n> files` commit so
`diff-review-final` judges the repaired HEAD.

For non-interactive runs that remain blocked, `noninteractive-salvage` also preserves
any remaining working-tree changes in a `salvage(uncommitted): <n> files` commit and
pushes the salvage branch for human review. This preservation does not authorize the
normal `commit-and-push` node or bypass its blocked-run approval rules.
