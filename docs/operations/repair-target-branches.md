# Repair target branches

Authorized repair of an existing open pull request may select the PR's current
head branch. Ordinary new pushes stay on the feat/fix/wip allowlist.

This document records invocation and limits. It does not deploy the harness,
repair thinmansoftware/shopops#806, or authorize promotion/, hotfix/, or
salvage/ branches.

## Eligible authorized-repair forms

A spec-authorized repair branch must match one of:

- `feat/[A-Za-z0-9_-]+`
- `fix/[A-Za-z0-9_-]+`
- `wip/[A-Za-z0-9_-]+`
- `wo/[A-Za-z0-9_-]+`
- `archon/task-web-worker-[0-9]+-[A-Za-z0-9]+`

The frozen spec must contain this line, with the same PR number and branch:

```text
Repair target: PR #N (branch NAME)
```

decide-push-target must emit matching fields:

- `repair_target_pr`
- `repair_target_branch`
- `repair_target_authorized_by_spec`

Checkout and commit revalidation still require an OPEN same-repository
non-fork PR, a fetched head that matches the live head, a checkout lease that
matches that head, and lease ancestry in HEAD. Any repair field without that
full authorization fails closed. It does not fall back to a new branch name.

## Rejected forms

These are rejected before checkout and before push selection:

- `main`, `master`, `dev`, `staging`
- `release/lspro`
- `promotion/X`, `hotfix/X`, `salvage/X`
- `archon/arbitrary`, `archon/thread-*`
- malformed task-worker names (non-numeric id, underscore, extra hyphen, extra path segment)
- `wo/foo/bar`
- shell metacharacters

## Ordinary push_target

A new push with no spec-authorized repair still accepts only:

- `feat/`
- `fix/`
- `wip/`

`wo/` and `archon/task-web-worker-*` are not ordinary push targets.

## Operator invocation

Recorded for the operator. Do not run this from the builder:

```text
powershell -NoProfile -File C:\Users\pcmed\Downloads\WORKROOM-CURRENT-CAULDRON-FIRE.ps1 -Wo WO-HARNESS-REPAIR-TARGET-WORKROOM-BRANCHES-01 -Project bdc-harness -Class CODE -Tags security -Workflow cursor
```

## Offline verification

```text
bun test packages/workflows/src/bdc-push-correctness.test.ts packages/workflows/src/lane-registration.test.ts
```
