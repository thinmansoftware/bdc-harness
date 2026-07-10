# Smart Cauldron Round 3 Verification

Date: 2026-07-10

## Verdict

The Round 2 branch-owned defects are repaired locally. The implementation is
ready for code review and CI, but it is not activated or deployed.

## Repairs

1. Capability fixtures explicitly declare text-only authority. Unknown AI seats
   continue to fail closed.
2. Supervisor lease validity uses database time for acquisition, takeover,
   authorization, repair reservation, and finalization.
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
9. Bun script nodes spawn the current runtime executable on Windows.

## Verification evidence

| Gate | Result |
|---|---|
| `packages/workflows: bun run test` | PASS, exit 0 |
| `bun --filter '*' test` | PASS, exit 0 across all workspaces |
| `bun run check:bundled` | PASS, 36 commands, 96 workflows, 1 policy |
| `bun run type-check` | PASS, every package and scripts |
| `bun run lint --max-warnings 0` | PASS |
| `bun run format:check` | PASS |
| `git diff --check 80569162..HEAD` | PASS |
| changed script/code ASCII scan | PASS |
| `bun run check:bundled-skill` | FAIL, unrelated existing CLI docs inventory drift |
| root parallel `bun run test` on Windows | INCONCLUSIVE, silent exit 1 |

The root parallel wrapper result is not hidden: the equivalent workspace test
command passes when run sequentially. The bundled-skill drift concerns CLI skill
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
5. Run Linux CI and a disposable PostgreSQL integration canary.
6. Only after those gates, separately approve supervisor activation and controlled
   Sol/Fable canary traffic.
