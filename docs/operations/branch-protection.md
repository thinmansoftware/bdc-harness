# Branch Protection -- bdc-harness `dev`

**WO**: WO-HARNESS-MM-DEV-BRANCH-RULES-01 (bdc-xo#1576)
**Behavior source**: M-20260814-151-RULING (1 approving review from a different identity + `enforce_admins=true`)
**Target**: `thinmansoftware/bdc-harness` branch `dev`

## Purpose

Require one approving PR review and enforce the rule for administrators on
`dev`, so Merge Manager / org admins cannot bypass the review gate. GitHub
already blocks PR authors from satisfying their own required review; that is
the platform meaning of "different identity" for this WO. No extra org-level
policy change is required for that clause.

## Out of scope (this doc / WO)

- Branch protection on `main` (not managed here)
- Soft-merge activation
- Expanding required status checks beyond what already exists on `dev`

## Verify (read-only)

```bash
gh api repos/thinmansoftware/bdc-harness/branches/dev/protection \
  --jq '{
    required_approving_review_count: .required_pull_request_reviews.required_approving_review_count,
    enforce_admins: .enforce_admins.enabled,
    status_check_contexts: .required_status_checks.contexts,
    status_check_strict: .required_status_checks.strict
  }'
```

Expected after this WO:

- `required_approving_review_count` == `1`
- `enforce_admins` == `true`
- `status_check_contexts` still includes `docker-build` and `test (ubuntu-latest)`

Boolean one-liner (prints `true` when healthy):

```bash
gh api repos/thinmansoftware/bdc-harness/branches/dev/protection \
  --jq '(.required_pull_request_reviews.required_approving_review_count == 1)
        and (.enforce_admins.enabled == true)
        and (.required_status_checks.contexts | index("docker-build") != null)
        and (.required_status_checks.contexts | index("test (ubuntu-latest)") != null)'
```

## Apply (full-replace PUT -- preserve existing checks)

GitHub `PUT .../branches/{branch}/protection` is a **full replace**. A minimal
payload that only sets reviews + `enforce_admins` will wipe required status
checks and other flags. Always GET first, then restate live values in the PUT.

1. Capture current protection:

```bash
gh api repos/thinmansoftware/bdc-harness/branches/dev/protection \
  > /tmp/dev-protection-before.json
```

2. Apply (canonical payload as of M-151 / this WO; fold any live drift from
   step 1 into the body before running -- never invent, never drop contexts):

```bash
gh api \
  --method PUT \
  repos/thinmansoftware/bdc-harness/branches/dev/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["docker-build", "test (ubuntu-latest)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
```

Do **not** set `required_status_checks` to `null`. Do **not** omit
`restrictions` (org repos require the key; `null` means no push restrictions).

3. Verify after (same commands as the Verify section). Confirm reviews=1,
   enforce_admins=true, and both status check contexts remain.

## Evidence

Before/after JSON and the exact command sequence for this WO are recorded on:

- The implementing PR body (base `dev`)
- bdc-xo issue comment: https://github.com/thinmansoftware/bdc-xo/issues/1576

Admin token required for the PUT. If the caller lacks admin on
`thinmansoftware/bdc-harness`, do not fake success -- hand off the commands and
before JSON to an operator with admin.
