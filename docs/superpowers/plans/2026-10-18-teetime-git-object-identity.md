# Tee-time Git object identity implementation plan

> Execute inline using superpowers:executing-plans. This is source-only bootstrap
> work under WO-HARNESS-TEETIME-CONFINEMENT-01 / bdc-xo#3332, not app implementation.

Goal: Construct canonical Git tree identities from unchanged validated snapshots.
Architecture: Extend the pure snapshot/evidence candidates, with no directory
scanning, Git subprocess, repository write, commit, ref, credential or model call
in the implementation. The complete candidate is authoritative; absent files
stay absent. Input custody and runtime quiescence remain caller preconditions.
Tech stack: Python standard library; trusted Git plumbing only in isolated tests.
Spec: scripts/staging/TEETIME-EVIDENCE.md and the reviewed admission contract in
bdc-xo docs/behavior-specs/tee-time-admission-contract-draft.md.

## Constraints and review

The required pre-build architect approved this smaller source slice on October18,
after rejecting process scans/reaping as an atomic runtime custody barrier.
No Claude/Fable, dispatch, authentication, registry change, deployment or demo.
Keep SHA-256 manifest identity separate from SHA-1 Git object IDs. Require explicit
SHA-1 format; bound immutable output using the existing snapshot limits. Preserve
binary bytes and executable modes. Git tree ordering treats directories as names
ending in slash, not ordinary full-path sorting.

## Task: identity constructor and independent verification

- [x] Inspect read_snapshot/snapshot_manifest and run-authority/worktree-copy prior art.
- [x] Obtain independent design review before implementation.
- [x] Write scripts/staging/test_teetime_git_objects.py and observe missing-module failure.
- [x] Add scripts/staging/teetime_git_objects.py: canonical blobs and recursive trees,
  immutable bounded output; no commits, refs, filesystem extraction or Git calls.
- [x] Verify empty/nested/executable/binary/add/delete/order/dedup/format cases.
- [x] Cross-check all objects and root trees with trusted Git hash-object,
  update-index and write-tree in fresh bare repositories. Disable inherited Git
  configuration, templates, hooks, attributes, remote protocols and prompting.
- [x] Add the test command to the existing offline qualification workflow and
  invocation runbook. Keep parser/evidence tests passing, ASCII and diff checks clean.
- [x] Independent final source review; correct findings before commit/publication.

## Evidence ledger

Initial red: python -m unittest discover -s scripts/staging -p
test_teetime_git_objects.py failed because teetime_git_objects did not exist.
No product code had been written. Runtime inventory, immutable test worker,
approval consumption and full Cauldron integration remain unresolved gates.

Green: eight constructor tests and nine existing snapshot tests passed. The
existing review-evidence suite passed ten tests with53 assertions. Diff whitespace
and ASCII checks passed on all five changed files. Independent source review
approved implementation, with documentation corrections applied before publication.
No hosted CI result for this new source is claimed by these local checks.
