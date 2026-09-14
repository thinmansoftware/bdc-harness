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
