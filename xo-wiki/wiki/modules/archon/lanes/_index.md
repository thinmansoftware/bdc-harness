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

## manifest-evidence-check admission policy (counts_unparsed, SPEC_DEFECT)

`manifest-evidence-check` (the `mec_check` core, byte-identical across all 12
`bdc-feature-development*.yaml` lanes) gates the stamped manifest before
`patch-pr-body` publishes it. bdc-xo #1940 first made it fail closed on
`Tests: N/A` for CODE/MIXED WOs and on any declared grep stop condition that did
not fully pass. `WO-HARNESS-MANIFEST-EVIDENCE-FALSE-POSITIVES-01` narrowed that
gate so it stops producing false positives while still failing closed on real
evidence against the work.

Tests policy (CODE/MIXED, PROCEED runs only):

- A numeric `Tests: <n>/<n> (<command>)` line -> admitted (unchanged).
- `tests_status=counts_unparsed` with `tests_exit=0` -> admitted. The declared
  test command ran and exited clean but printed no parseable pass/total counts
  (typically a custom script such as `build.cjs`/`verify.cjs`). This is "ran, no
  counts", not "N/A". `run-stop-tests` already emits this status; the change is
  that `mec_check` now admits it. An empty `tests_exit` is treated as nonzero, so
  a skipped `run-stop-tests` node still fails closed.
- `tests_status=failed`, a nonzero-exit unparsed command, `no_command_declared`,
  or a missing status -> `EVIDENCE_ERROR` (unchanged, still refused).

Grep policy (any class, declared > 0). `mec_check` branches on `grep_status`,
which `run-stop-greps` derives from its `GREP_EXECUTED`/`GREP_DROPPED`/
`GREP_UNPARSED`/`GREP_MISMATCH` counters:

- `passed` -> admitted (unchanged).
- `incomplete` (>= 1 condition executed, no mismatch, some conditions dropped
  and/or unparsed) -> admitted. `stamp-manifest-evidence` appends the unparsed
  condition names and dropped count to the audit line as
  `Stop conditions: tests=<status>; greps=incomplete; unparsed=<names>; dropped=<n> (...)`.
  This is an audit annotation, not a bdc-ci manifest label.
- `mismatch` (an executed grep returned the wrong count) -> `EVIDENCE_ERROR`
  (unchanged). An executed assertion that fails its expected count is real
  evidence against the work and stays fail-closed.
- `all_dropped` (0 conditions executable: every one was prose the parser could
  not read, refused by the read-only allowlist, or errored) -> still returns
  rc 1, but the message prefix is `SPEC_DEFECT:` (not `EVIDENCE_ERROR:`) and it
  names the conditions verbatim with their `DROPPED (<reason>): ...` detail from
  `run-stop-greps`. This attributes the failure to the spec's stop-condition
  shape (Rule 4: stop conditions must be runnable commands; `validate-wo-spec.sh`
  check 7 should catch it at authoring) rather than to the builder. The
  `SPEC_DEFECT:` prefix is message-only: `block-reclassify` / `review-issue` /
  `patch-pr-body` still route on `$block-reclassify.output.status`, not on the
  mec stderr text.

Both node cores are unit-tested by
`.archon/workflows/defaults/__tests__/manifest-evidence-check.sh`, which extracts
the `mec` and `sme` cores from the YAML, eval's them, and asserts both are
byte-identical across all 12 lanes.
