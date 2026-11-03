# Merge manager operations

The merge manager revalidates Overseer-approved pull requests against live GitHub state and repository policy before performing an unattended squash merge. Temporary conditions are retried with bounded exponential backoff; permanent policy and state failures remain final.

## Skip classification

| Classification | Reasons |
| --- | --- |
| Transient | `mergeable_state_not_clean`, `required_checks_not_success`, `pr_lookup_failed`, `open_pr_not_found`, `changed_files_unresolved`, `pr_context_fetch_failed` |
| Transient when message matches | `merge_failed:<message>` or a bare rejected-merge message matching rate limit, not mergeable, already in progress, base branch was modified, timeout, `ETIMEDOUT`, `ECONNRESET`, or HTTP 502/503/504 |
| Terminal | `spec_only`, `pr_not_open`, `head_moved`, `verdict_stale_head`, `not_mergeable_dirty`, `base_not_allowlisted`, `integration_base_mismatch`, `repo_not_allowed`, `run_context_unresolvable`, `pr_context_unresolvable`, `service_disabled`, `emergency_stop`, `legacy_dry_run`, `merge_actions_disabled`, CE recheck reasons, `github_merge_transport_ambiguous`, `merge_executed*`, bare `merge_failed`, `transient_exhausted:*`, and all unmatched reasons |

## Merge holds

A hold stops an otherwise mergeable pull request without recording a terminal or transient skip. The bridge releases the verdict claim so the next tick evaluates it again. `merge_hold`, `merge_hold_unverified`, and `merge_hold_label` do not enter the transient or terminal tables above, do not write a final outcome, and do not consume the retry attempt budget.

A work order spec on `thinmansoftware/bdc-xo` `main` at `docs/work-orders/<WO-ID>.md` holds its pull request when a whole line matches `/^merge_hold:[ \t]*true[ \t]*\r?$/im`. The key and value are case-insensitive. Spaces or tabs are allowed after the colon and at the end of the line only. A newline between the key and the value, a leading space, a trailing comment, a `false` value, or the same words inside a prose paragraph do not hold. Removing that line lets the next tick merge through the existing guards.

A missing spec (HTTP 404) is not a hold. Any other spec-read failure, including network errors, HTTP 5xx, authorization failures, rate limits, and decode failures, releases the claim with `merge_hold_unverified` and does not merge.

A pull request label named exactly `merge-hold` (case-sensitive) holds any pull request, including ones that are not tied to a work order. The bridge records `merge_hold_label` and does not read a spec. Removing the label lets the next tick merge through the existing guards.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `OVERSEER_MERGE_RETRY_BASE_MINUTES` | 10 | Initial retry delay |
| `OVERSEER_MERGE_RETRY_MAX_DELAY_MINUTES` | 240 | Maximum delay between attempts |
| `OVERSEER_MERGE_RETRY_MAX_ATTEMPTS` | 8 | Attempt cap, including the initial look |

## Repository base policy (staging lineages)

`DEFAULT_MERGE_REPO_POLICY` in `packages/overseer/src/merge-repo-policy.ts` declares merge candidacy per repository and base. A running container that sets `MERGE_MANAGER_REPO_POLICY` overrides the default completely, so the default alone does not change a live deployment (see the operator step below).

| Repository | Base | Unattended | Docs-only |
| --- | --- | --- | --- |
| `thinmansoftware/lspro-react` | `dev` | yes | skip |
| `thinmansoftware/lspro-react` | `staging` | yes | skip |
| `thinmansoftware/lspro-react` | `main` | no | skip |
| `thinmansoftware/shopops-storefront` | `staging` | yes | skip |
| `thinmansoftware/shopops-storefront` | `master` | no | skip |

`release/lspro`, `release/ce`, `main` and `master` are production lanes and are never unattended candidates: `release/*` has no entry at all.

### Operator step after this lands on dev (not part of the code change)

Edit `/opt/bdc/archon/.env`, then run the governed rebuild of `archon-app-1`:

1. Line 99, `MERGE_MANAGER_REPO_POLICY`, replace the value with (generated from the default policy; round-trips through `parseMergeRepoPolicy`):

```
MERGE_MANAGER_REPO_POLICY={"thinmansoftware/bdc-harness":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/shopops":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/lspro-react":{"dev":{"unattended":true,"docs_only":"skip"},"staging":{"unattended":true,"docs_only":"skip"},"main":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/shopops-storefront":{"staging":{"unattended":true,"docs_only":"skip"},"master":{"unattended":false,"docs_only":"skip"}},"thinmansoftware/bdc-xo":{"main":{"unattended":true,"docs_only":"merge"}}}
```

2. Line 97, `OVERSEER_MERGE_DISCOVERY_REPOS`, append `thinmansoftware/lspro-react,thinmansoftware/shopops-storefront` to the existing comma-separated list.

Verify after the rebuild:

```sh
ssh hetzner-prod 'docker exec archon-app-1 printenv MERGE_MANAGER_REPO_POLICY' | grep -c shopops-storefront
```

Expected output: `1`.

## Requeue verdicts stranded by the old behavior

Preview eligible transient skips:

```sh
docker exec -w /app/packages/overseer archon-app-1 bun run requeue-transient-merge-skips -- --dry-run
```

Apply the idempotent requeue:

```sh
docker exec -w /app/packages/overseer archon-app-1 bun run requeue-transient-merge-skips
```

Inspect an outcome with:

```sql
select action_reason, merge_attempts, merge_not_before from overseer_verdicts where pr_url like '%/pull/<N>';
```

Merging this code does not update the running source-copy container. XO must rebuild the container before runtime verification. Production requeue and canary execution are XO post-merge actions, not builder actions.
