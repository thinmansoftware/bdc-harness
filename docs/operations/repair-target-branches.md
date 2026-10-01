# Repair target branches

The feature-development workflows can repair an existing pull request in place only when the frozen Work Order declares `Repair target: PR #N (branch X)` and the push decision repeats the matching PR, branch, and spec authorization.

Supported repair branch forms are `feat/[A-Za-z0-9_-]+`, `fix/[A-Za-z0-9_-]+`, `wip/[A-Za-z0-9_-]+`, `wo/[A-Za-z0-9_-]+`, and `archon/task-web-worker-<numeric-id>-<alphanumeric-suffix>`. Ordinary new pushes remain limited to the `feat`, `fix`, and `wip` forms.

Protected and unsupported forms are rejected. These include `main`, `master`, `dev`, `staging`, `release/*`, `promotion/*`, `hotfix/*`, `salvage/*`, arbitrary `archon/*` names, nested branch suffixes, and names containing shell metacharacters.

Before checkout, the workflow verifies that the PR is OPEN, belongs to the same repository, is not a fork, names the declared branch, and has a live head SHA. It then fetches the declared branch and requires the fetched SHA to equal that live head. Before push selection, it repeats the authorization and identity checks, requires the live and fetched heads to match the checkout lease, and requires the lease commit to be an ancestor of HEAD. Only then is the original branch selected. Missing or partial repair fields fail closed and never fall back to an ordinary push.

This is source-only workflow authority. It does not deploy the harness, authorize a runtime rollout, modify a customer repository, or repair ShopOps PR #806.

After architect approval, canonical spec publication, base recheck, and confirmation that no overlapping work is active, the supported operator invocation is:

```powershell
powershell -NoProfile -File C:\Users\pcmed\Downloads\WORKROOM-CURRENT-CAULDRON-FIRE.ps1 -Wo WO-HARNESS-REPAIR-TARGET-WORKROOM-BRANCHES-01 -Project bdc-harness -Class CODE -Tags security -Workflow cursor
```

Do not use concurrent or unsupervised fire options for this Work Order.
