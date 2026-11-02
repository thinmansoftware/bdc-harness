# Reconcile tracker discovery

Tracker lookup uses the existing service GitHub transport to list all-state
issues in `thinmansoftware/bdc-xo`, ordered by creation ascending. It excludes
pull requests and matches the WO title exactly. It does not activate the unused
`trackerRepo` option or infer an organization-wide repository inventory.

Each `runReconcileOnce` creates a fresh lookup scope. The default dependency
factory shares one complete-listing promise within that scope, including a
failure. Reusing the factory on another invocation fetches fresh data. Direct
lookups without a scope also fetch fresh data. This scope is a cache lifetime,
not a lease or authorization credential.

The budget is 100 pages of 100 rows, at most 100 logical core requests per
invocation. A short terminal page establishes retrieval completion. A full final
page, failed request, malformed page/row, conflicting issue identity or ambiguous
exact title is unknown and must not become absence or permission to close.
This budget limits page count; it does not introduce a network wall-clock bound.

Only matching/identity metadata is retained. Body shape is validated, but unused
bodies do not become tracker authority or remain in the cached snapshot. REST
pagination is not an atomic GitHub snapshot; changes between pages or after the
read remain possible. Existing claim, spec-only, open-holder and re-close guards
remain necessary.

After an acknowledged successful close, this invocation remembers that tracker
identity so another merged PR cannot repeat its close from cached open state.
A lookup, held/spec-only result or failed close does not set that flag. It is
not a durable cross-run action record and does not replace existing action logs.

Configured App reads retain the existing core-metered transport. App permission
denial does not silently switch tracker reads to a PAT. PAT-only installations
retain their existing route. No token, permission, deployed setting or live data
is changed by the source patch.

This removes one repository-scoped Search lookup. The two organization-wide
reconcile call sites still contain four Search query templates. Replacing them
requires a verified inventory and visibility contract. This change does not
claim overall traffic reduction, Search-free reconciliation, reset-aware
admission recovery or Defect 14 acceptance. The normal-traffic 60-minute window
and an authorized real fire remain separate, unperformed runtime evidence.
