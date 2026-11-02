# Archon lanes

## Declaring a repair target and operator-recorded stops in a WO

Feature-development work orders can declare an existing pull request as their repair
target:

```text
Repair target: PR #826 (branch feat/example-repair)
```

The declaration authorizes plan review to record
`repair_target_authorized_by_spec: #826`; it does not require a separate question
about whether the pull request is canonical or should be replaced. Before any push,
the lane verifies with GitHub that the pull request is open in the target repository
and that its live head branch exactly matches the declared branch. A missing or closed
pull request, or a branch mismatch, fails closed. A successful repair checks out and
pushes to that existing branch, allowing the existing pull request to be reused.

A stop condition that must be completed outside the builder lane can be marked by
ending its specification line with one of these forms:

```text
-- recorded by XO
-- recorded by the operator
(operator-recorded)
```

These markers place the stop outside the builder's gate. Plan and diff review must not
escalate merely because the stop is still outstanding. Until XO or the operator records
the result, the manifest represents it as `OPERATOR-RECORDED (pending)` rather than
`FAIL` or `N/A`.

Neither declaration suppresses genuine ambiguity or weakens a repository's staging
crossing gate. Repair-target validation still fails closed, and unmarked stop conditions
remain normal builder requirements.

## Checkpoints and salvage

Feature-development lanes commit changes produced by `diff-repair` before capturing
the final review patch. The `checkpoint-diff-repair` node is a no-op for a clean
worktree; otherwise it creates a `checkpoint(diff-repair): <n> files` commit so
`diff-review-final` judges the repaired HEAD.

For non-interactive runs that remain blocked, `noninteractive-salvage` also preserves
any remaining working-tree changes in a `salvage(uncommitted): <n> files` commit and
pushes the salvage branch for human review. This preservation does not authorize the
normal `commit-and-push` node or bypass its blocked-run approval rules.

## manifest-evidence-check admission policy (counts_unparsed, SPEC_DEFECT, HARNESS_REFUSED)

For CODE and MIXED work orders, `manifest-evidence-check` admits an executed test
command that reports `tests_status=counts_unparsed` only when `tests_exit=0`. The
manifest keeps the existing N/A-style explanation because the command produced no
parseable counts. A nonzero exit, `failed`, `no_command_declared`, or missing test
evidence still fails closed with `EVIDENCE_ERROR`.

Declared grep stop conditions are handled by their observed status. `passed` is
admitted. `incomplete` is admitted only when at least one grep executed and no grep
mismatched; its Stop conditions line publishes `unparsed=<names>; dropped=<n>`.
`mismatch` remains an `EVIDENCE_ERROR`. `all_dropped`, meaning zero conditions
executed, fails with `SPEC_DEFECT:` when one or more conditions were unparsed and
includes their names and any `DROPPED:` reasons, attributing the failure to the
stop-condition specification. When every parsed condition was instead removed by
the allowlist, it fails with `HARNESS_REFUSED:` and includes the `DROPPED:` reasons,
attributing the refusal to harness policy rather than to a malformed specification.

The `mec core` block and the `sme_process` / `mec_check` call sites in
`.archon/workflows/defaults/bdc-feature-development.yaml` are the source of truth;
their mirrored lane copies must remain byte-identical. The unit test checks both the
function bodies and these separate argument-passing surfaces so new evidence fields
cannot silently fall back to defaults in a subset of lanes.
