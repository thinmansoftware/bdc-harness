# Smart Cauldron Round 3 Verification

Date: 2026-07-10

## Verdict

The Round 2 branch-owned defects are repaired locally. The implementation is
ready for code review and CI, but it is not activated or deployed.

## Repairs

1. Capability fixtures explicitly declare text-only authority. Unknown AI seats
   continue to fail closed.
2. Supervisor lease validity uses database time for acquisition, takeover,
   authorization, repair reservation, and finalization. Expired or replaced owners
   cannot close an incident.
3. Exactly one repair reservation can be created per incident. Reservation occurs
   before the external callback, and finalization is fenced by owner and token.
4. Closed incidents cannot be reclaimed for another automated repair.
5. The shared workflow executor freezes authority for every initial dispatch and
   reuses persisted authority on resume. Missing freeze support fails closed.
6. All seven feature-development lanes are mechanically checked for frozen
   work-order artifact and hash consumption.
7. Managed-clone cleanup requires an exact root descendant, preventing sibling
   prefix collisions.
8. A lost run-outcome compare-and-swap now fails the evidence node instead of
   emitting false completion.
9. Bun script nodes resolve a real Bun CLI instead of a Windows shell shim or the
   compiled Archon executable.
10. SQLite reservation lock/constraint contention returns a safe lost-race result;
    no external repair callback runs.
11. Lost reservation or finalization fencing releases the caller's lease when it
    is still the current lease.

## Verification evidence

| Gate | Result |
|---|---|
| `packages/workflows: bun run test` | PASS, exit 0 with Git-for-Windows Bash on child `PATH` |
| `bun --filter '*' test` | PASS, exit 0 across all workspaces |
| `bun run check:bundled` | PASS, 36 commands, 96 workflows, 1 policy |
| `bun run type-check` | PASS, every package and scripts |
| `bun run lint --max-warnings 0` | PASS |
| `bun run format:check` | PASS |
| `git diff --check 80569162..HEAD` | PASS |
| changed script/code ASCII scan | PASS |
| `bun run check:bundled-skill` | FAIL, unrelated existing CLI docs inventory drift |
| root parallel `bun run test` on Windows | INCONCLUSIVE, silent exit 1 |

The Bash-dependent workflow fixtures require
`C:\Program Files\Git\bin` and `C:\Program Files\Git\usr\bin` on the child
process `PATH` on this Windows host. Without that prerequisite, the workflows
package stops with five `uv_spawn 'bash'` failures. The root parallel wrapper
result is not hidden: the equivalent workspace test command passes when run
sequentially with the same Bash `PATH`. The bundled-skill drift concerns CLI skill
documentation and `packages/cli/src/bundled-skill.ts`, none of which this branch
changes.

## Activation boundary

No branch merge, deployment, production database migration, live workflow fire,
feature-flag change, refire, supervisor provider activation, or production mutation
was performed. The current supervisor integration remains an opt-in hook. Live
PostgreSQL and real Sol/Fable provider behavior require the canary phase after code
review and approval.

## Commit sequence

```text
f25dde9a docs: plan smart cauldron round three repairs
7234c97d test(workflows): declare text-only capability fixtures
0d96d116 fix(reliability): use database time for supervisor leases
80710e8d fix(reliability): reserve supervisor repairs before mutation
feff6280 fix(workflows): freeze authority on every initial dispatch
e4a5f8b7 fix(reliability): close path and outcome safety gaps
94b16f48 test(workflows): cover authority on every feature lane
f96e0976 fix(workflows): spawn current bun runtime for script nodes
```

## Review order

1. Review migration 027 and database-time SQL for SQLite/PostgreSQL parity.
2. Review the reserve-before-repair coordinator order and incident closure guards.
3. Review shared-executor authority freezing and resume behavior.
4. Review path-boundary and outcome compare-and-swap regressions.
5. Review the real Bun CLI resolver in source and compiled-binary modes.
6. Run Linux CI and a disposable PostgreSQL integration canary.
7. Only after those gates, separately approve supervisor activation and controlled
   Sol/Fable canary traffic.

## Round 4 CI and authority correction

Fable's Round 3 PR verification found two branch-owned CI failures and an
undisclosed authority compatibility gap. The repair keeps PR #390 in draft and
changes the implementation as follows:

- Bun runtime path parsing now uses Win32 or POSIX path semantics selected by the
  injected platform instead of the host running the test.
- The production Docker stage copies `packages/smart-cauldron/`; the prior image
  contained its package manifest but not the source imported by the server.
- All seven feature-development lanes remain fail-closed and WO-scoped.
- Each lane enables the explicit issue fallback. A message with `issue=<number>`
  may freeze the GitHub issue body only when its title or body identifies a WO.
- A message with neither a WO ID nor an approved issue remains rejected before DAG
  execution.
- Production authority retrieval accepts `GITHUB_TOKEN` or `GH_TOKEN`; a custom
  injected fetcher remains available for hermetic tests.

GitHub CI run `29090147158` established the original failures: three Linux resolver
tests failed, and the Docker smoke exited because the server could not resolve
`@archon/smart-cauldron/cascade`. The local host has no Docker CLI, so container
boot is not claimed locally and must be proven by the repaired disposable GitHub
Docker job. No Hetzner or production container was accessed.

The existing per-run executor lease still uses application time. That is not
silently represented as fixed; it is a separate follow-up described in
`2026-07-10-smart-cauldron-run-lease-db-clock-follow-up.md`.
