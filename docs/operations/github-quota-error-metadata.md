# GitHub quota refusal metadata

This prerequisite preserves a local pool-backoff deadline through the existing
GitHub command wrapper and Smart Cauldron claim discovery. It adds no wait,
provider retry, status, controller, migration, or admission authority.

The meter throws `GitHubPoolBackoffError` with the existing message and readonly
`poolId`, `resource`, and `retryAtMs` fields. The deadline can originate from
Retry-After, a quota reset, or the existing conservative fallback. It must not be
described as an observed GitHub reset.

After persisting a captured nonzero HTTP rate-limit response, the wrapper throws
the same typed refusal before permission fallback. Untraced rate-limit prose
retains its existing conservative CLI backoff; its first failure remains generic.
An elapsed or unrecognized-resource refusal remains generic when serialized and
cannot trigger the App-to-PAT permission retry.

The CLI emits one `ARCHON_GITHUB_QUOTA_V1:` record containing exactly `version: 1`,
`kind: pool_backoff`, `poolId`, `resource`, and integer future `retryAtMs`.
Allowed pools are `user-pat`, `merge-manager-pat`, and positive numeric
`app-<id>-<installation>` identities. Resources are core, graphql, search, and cli.
Errors, stacks, tokens, URLs, commands, and provider bodies are not serialized.
Forwarded provider stderr has the reserved prefix replaced to prevent injection.

Discovery accepts exactly one canonical record amid unrelated runtime warnings,
then discards all diagnostics. Duplicate prefixes, embedded records, duplicate
JSON keys, extra fields, invalid values, and expired deadlines lose metadata.
The existing `request_failed` code and message remain unchanged; optional `quota`
metadata does not establish that an operation is safe to retry.

Production routing remains conditional on the existing App environment check in
`gh-merge-guard.sh`. PAT-only native bypasses still return generic discovery
failures. The child-process fixture proves wrapper stderr crosses execFile into
discovery using a substituted exec seam, not container PATH or shim activation.
No live provider or runtime acceptance is claimed.

Source prerequisites: draft #1162 (resource admission) and draft #1163 (complete
fail-closed REST discovery). Reset-aware admission waiting remains separate work:
durable custody, caller cancellation/authority rechecks, bounded episode policy,
and complete claim revalidation are required before any wait can be introduced.
