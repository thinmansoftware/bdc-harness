# Merge manager operations

The merge manager revalidates Overseer-approved pull requests against live GitHub state and repository policy before performing an unattended squash merge. Temporary conditions are retried with bounded exponential backoff; permanent policy and state failures remain final.

## Skip classification

| Classification | Reasons |
| --- | --- |
| Transient | `mergeable_state_not_clean`, `required_checks_not_success`, `pr_lookup_failed`, `open_pr_not_found`, `changed_files_unresolved`, `pr_context_fetch_failed` |
| Transient when message matches | `merge_failed:<message>` or a bare rejected-merge message matching rate limit, not mergeable, already in progress, base branch was modified, timeout, `ETIMEDOUT`, `ECONNRESET`, or HTTP 502/503/504 |
| Terminal | `spec_only`, `pr_not_open`, `head_moved`, `verdict_stale_head`, `not_mergeable_dirty`, `base_not_allowlisted`, `integration_base_mismatch`, `repo_not_allowed`, `run_context_unresolvable`, `pr_context_unresolvable`, `service_disabled`, `emergency_stop`, `legacy_dry_run`, `merge_actions_disabled`, CE recheck reasons, `github_merge_transport_ambiguous`, `merge_executed*`, bare `merge_failed`, `transient_exhausted:*`, and all unmatched reasons |

| Variable | Default | Meaning |
| --- | ---: | --- |
| `OVERSEER_MERGE_RETRY_BASE_MINUTES` | 10 | Initial retry delay |
| `OVERSEER_MERGE_RETRY_MAX_DELAY_MINUTES` | 240 | Maximum delay between attempts |
| `OVERSEER_MERGE_RETRY_MAX_ATTEMPTS` | 8 | Attempt cap, including the initial look |

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
