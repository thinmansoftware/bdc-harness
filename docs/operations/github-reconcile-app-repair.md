# GitHub reconciliation App routing repair

Date: 2026-10-17. Scope: source repair; no runtime activation.

Extends the merged per-service implementation in PR #1128 at
10fb1ca5baf70faddc0fda5940056149e57af2ea. Existing tracking: harness #796
(shared user budget) and #1002 (Search budget). This bounded patch does not close
their wider runtime/caching acceptance criteria.

## Evidence and behavior

The earlier live audit measured user and merge PAT core pools at 0/5000 while the
existing Overseer App retained 14929/15000. Deployed reconciliation constructed
Octokit with the PAT directly. PR #1128 added service identity, metering and shared
backoff, but left createDefaultReconcileDeps on that direct PAT path.

The repair extends createDefaultReconcileDeps in packages/overseer/src/reconcile.ts.
It keeps Octokit endpoints and all reconciliation evidence/closure guards intact.
Its request transport delegates authentication to existing
packages/core/src/github/request.ts and service-identity.ts:

- Reads use serviceGitHubFetch with service overseer.
- Existing tracker comment, label and issue-close writes alone may use
  serviceGitHubFetchWithPermissionFallback.
- Only explicit App integration-permission 403 can retry once using the existing
  PAT. Quota, generic authorization and ambiguous transport failures cannot.
- App-only installations work; absent credentials retain the skip path; invalid
  App configuration fails instead of downgrading to PAT.
- Metered pool exhaustion prevents the next HTTP request until reset. Reconciliation
  reports the preflight hold as a rate-limit skip.

This does not change App permissions, merge identity, environment variables,
installation scope, or production deployment. The App's missing Issues:write
permission remains an explicit reason for per-call fallback, not a blanket PAT
read route. Review and merge stay separate actors.

## Verification commands

Run the new default-transport integration tests in an isolated process:

```powershell
bun test packages/overseer/src/__tests__/reconcile-github-auth.test.ts
```

Run existing reconcile guard suites separately from the real transport test to
avoid unrelated process-wide mock.module replacements. Run core service identity,
request and metering suites, existing merge identity tests, the overseer typecheck,
ESLint, Prettier, diff whitespace and ASCII checks. Record real results before
publishing or claiming validation. Use the repository's full validate command for
the pre-PR gate; any baseline failure must be reported, not suppressed.

## Activation boundary

John authorized source repair and WIWN pilot planning, explicitly excluding
production deployments and purchases. A production rebuild or credential change
is outside this task. Prior merged source and this repair are not active runtime
proof. A later governed deployment must name its exact SHA, migration readiness,
active-work count, rollback image/database backup and staging evidence.

After that separately authorized activation, verify actual App-attributed reads,
permission-only PAT writes, metering by resource, no traffic before reset, preserved
review/merge custody and an observed reconciliation workflow. Keep #796/#1002 open
until their full acceptance is evidenced. No fixed read-routing patch alone proves
that all user-pool consumers or Search call amplification have been eliminated.


## Follow-on: Overseer WO discovery without Search (2026-10-18)

Source proposal for bdc-xo#3258 Defect14. The existing findPullRequest adapter
uses complete REST open-pull listing for WO title/body discovery, including
siblings after head-branch recovery. An explicit PR number retains direct lookup.
The existing paginated helper has an opt-in strict mode for this caller; default
merge candidate discovery behavior is unchanged. Strict reads use creation order
ascending,100 rows per page, and the existing10-page bound. Hitting that ceiling
is UNKNOWN, even if an earlier page contains a match.

Every row must have a positive safe PR number, open state, string title, present
string-or-null body and usable head identity. Malformed nonmatching rows also
block selection. Identical duplicate numbers are deduplicated; conflicting
identity blocks selection. Candidate details are refreshed, identity checked and
current title/body claim rechecked before selection. Exclusion headings follow the established Cauldron claimant behavior locally to
avoid a circular package dependency. Body-only claims remain recognized; numeric siblings, hyphen-extended identifiers
and excluded mentions do not claim the WO. The boundary excludes adjacent
hyphens like Taskmaster canonical WO tokens; branch suffix matching is not used
for title/body identity. Primary REST422 failures remain unknown rather than
inheriting the old Search-specific permanent-missing classification.

All matching candidates are considered before the existing sole-match / first
non-builder selection rules. REST creation order replaces Search relevance order;
selection priority is preserved, ordering equivalence is not claimed. The public
otherOpenPrsForWo presentation remains capped at five. Failure of sibling discovery
after a resolved head preserves that PR and sets the existing unknown-siblings
flag; failure of primary discovery returns lookup-failed. No partial response can
prove that there is no PR.

The existing Octokit quota hooks meter these REST calls as core. No new cache,
meter, token fallback, review authority, merge policy or controller is introduced.
Reconcile and Taskmaster Search callers, reset-aware admission waiting and the
60-minute normal-traffic window with zero Search403 responses plus authorized actual-run proof
remain open. Unit/source evidence does not close Defect14 or establish production
activation. No provider fire, merge or deployment is authorized by this proposal.
