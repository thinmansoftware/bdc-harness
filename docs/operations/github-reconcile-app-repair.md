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
