# Smart Cauldron Reliability Final Audit

Date: 2026-07-09

Branch: `codex/smart-cauldron-reliability-design`

Worktree: `C:\Users\pcmed\projects\.worktrees\bdc-harness-smart-cauldron-reliability`

This is a local implementation and evidence audit. Nothing was pushed, deployed,
merged, fired, restarted, rebuilt, or enabled in production. The user explicitly
waived the separate custom-GPT General review; this audit does not claim that review.

## Requirement matrix

| Requirement | Current implementation | Focused proof | Broader verification | Commit |
| --- | --- | --- | --- | --- |
| Truthful multidimensional outcomes | `packages/workflows/src/reliability/outcome-reducer.ts`, `packages/workflows/src/reliability/types.ts` | `outcome-reducer.test.ts`, including failed execution plus PR-ready and predecessor failure | `bun test packages/workflows/src/reliability/` | `46f70d4d`, `f26e33e3` |
| Restart-safe interruption and recovery | `packages/core/src/workflows/recovery.ts`, lease-backed executor transitions | `packages/core/src/workflows/recovery.test.ts`, worker-kill fixtures in `failure-injection.test.ts` | core package tests exit 0; root typecheck exit 0 | `24405f42`, `c8cffe94` |
| Drain mode | durable control rows and audit events in `packages/core/src/db/workflows.ts`; admission rejection in `packages/server/src/routes/api.ts` | real SQLite drain transition with one active lease/run; server conductor drain rejection | core and server package tests exit 0 | `bcf1179d` |
| Durable cancellable provider waits | `packages/workflows/src/reliability/wait-scheduler.ts`, scheduled-wait store contract | before-claim and after-claim cancellation races; failed wake returns to queue | reliability tests and core package tests exit 0 | `f0285ff0`, `c8cffe94` |
| Capability-enforced routing | provider execution capability ledger plus `assertProviderCanExecuteNode` | chat-only builder fallback rejected with provider call count zero; lane registration tests | providers package tests exit 0; workflow loader capability tests pass | `886ba372`, `c8cffe94` |
| Immutable repo, base, diff, and spec authority | run authority, worktree identity, stage base SHA, mechanical evidence | authority byte/hash tests, wrong-base fixture, cross-clone and wrong-branch adoption tests | isolation package tests exit 0; root typecheck exit 0 | `08c4632c`, `2592baff`, `645ab5a6` |
| Deterministic manifests and gates | `evidence-collector.ts`, evidence DAG nodes, manifest-v2 renderer | exact file list, base/head/ref/check gates, fabricated PR URL rejection | bundled-default check and workflow reliability tests pass | `f26e33e3`, `c8cffe94` |
| Safe multi-stage lifecycle | verified stage allocator, `multi-stage-lifecycle.ts`, reducer-gated workflow tail | N=1, N=2 blocked predecessor, N=4 authority fixture, fresh-process reconstruction, BLOCKED cannot become REVIEW | isolation suite, workflow loader (134 pass, 1 skip), defaults/reliability suite pass | `645ab5a6` |
| Actual conductor integration | feature-flagged server request, durable cascade admission, preflight, CLI status mapping | direct-lane-off parity, planned dry run, live admission, drain rejection, replay does not double-fire | 99 server route tests and full Smart Cauldron package pass | `da481e29` |
| Controlled failure injection | 13 workflow fixtures, 3 Smart Cauldron restart fixtures, worktree collision, SQLite drain fixture | every named incident class has a controlled assertion; new fixtures use no real services or credentials | failure matrix 13 pass; Smart Cauldron package 54 pass; collision 4 pass | `c8cffe94` |
| Canary packet | exact harmless WO fixture, observations, aborts, recovery, separate approvals, rollback | Markdown content and ASCII check | Prettier check and diff check pass | `bf12be7f` |
| Original checkout preserved | all edits and commits stayed in the isolated worktree | original checkout still on `pr-389-escalated` with its pre-existing modified/untracked files | worktree list shows separate registered worktree | all local commits |
| No unauthorized production action | feature flag remains disabled unless exact env value is `true`; no runtime config changed | clean local worktree; branch has no published feature upstream | `origin/dev...HEAD` was `0 24` before this audit commit; no push/PR/deploy/fire command executed | all local commits |

## Failure-injection coverage

1. Claude exhausted, Codex capable and healthy: durable failed-over route fixture.
2. Codex exhausted, Claude capable and healthy: durable failed-over route fixture.
3. All capable providers exhausted across restart: scheduled wait survives JSON
   round trip through a fresh Bun process.
4. Zero-token contradiction without quota evidence: remains `sdk_contradiction`.
5. Chat-only fallback: capability mismatch before provider call.
6. Worker killed during implementation: interrupted, recoverable, worktree changes preserved.
7. Worker killed during provider wait: waiting state and scheduled wait preserved.
8. Cancellation racing due-wait claim: cancellation wins; resume is not called.
9. Provider-internal failback: availability-only for loop and prompt fixtures.
10. Terminal DB write failure: interrupted and recoverable with
    `status_persist_failed`.
11. Wrong base and legacy ASCII debt: wrong base fails; unrelated legacy path is
    absent from the run diff.
12. Fabricated PR URL: rejected against canonical remote and PR number.
13. Multi-stage predecessor blocked: parent fails and successor is `NOT_RUN`.
14. Worktree collision: cross-clone and wrong-branch adoption are refused.
15. Drain with one active run: real SQLite state remains draining, not drained;
    conductor admission returns 503 without dispatch.
16. Conductor dry run: planned record persists and provider call count stays zero.

## Verification ledger

Green checks run on the final code state before this audit document:

- `bun run type-check`: all workspace packages exit 0.
- `bun run check:bundled`: 36 commands, 96 workflows, 1 policy up to date.
- `bun run format:check`: pass.
- Targeted ESLint on all changed TypeScript: pass with zero warnings.
- `git diff --check`: pass.
- Changed-source ASCII byte scan: pass.
- Smart Cauldron package: 54 pass, 0 fail.
- Server workflow-run route suite: 99 pass, 0 fail.
- Workflow loader: 134 pass, 1 skip, 0 fail.
- Workflow reliability/defaults focused run: 56 pass before the final failure
  matrix addition; the later matrix plus evidence collector run: 21 pass, 0 fail.
- Isolation package suite: exit 0; focused stage allocator: 4 pass, 0 fail.
- Real SQLite drain fixture: 1 pass, 0 fail.

Repository-wide workspace test result:

- Every package except `@archon/workflows` exited 0.
- `@archon/workflows` reported 5 failures, all the same environment class:
  `ENOENT: no such file or directory, uv_spawn 'bash'` on Windows.
- No new failure class appeared. Bash-dependent DAG fixtures remain unverified on
  this Windows host and must be rerun in the normal Linux/Bash CI environment.

## Commit sequence

```text
4cc12c72 fix(lanes): bind ASCII checks to immutable run scope
8490f917 fix(lanes): make implementation counters integer-safe
46f70d4d feat(workflows): add reliability outcome contracts
72927293 feat(core): add Smart Cauldron reliability schema
9cd049f3 feat(core): persist Smart Cauldron reliability state
8e19f350 fix(workflows): make terminal persistence authoritative
24405f42 feat(workflows): add restart-safe run leases
bcf1179d feat(server): add durable Cauldron drain mode
08c4632c feat(isolation): persist authoritative worktree identity
886ba372 feat(providers): enforce workflow execution capabilities
f0285ff0 feat(workflows): add durable provider attempt scheduling
2592baff feat(workflows): freeze run authority before mutation
f26e33e3 feat(workflows): derive outcomes and manifests from evidence
da481e29 feat(smart-cauldron): integrate durable conductor dispatch
645ab5a6 fix(multistage): enforce authoritative stage lifecycle
c8cffe94 test(harness): add Smart Cauldron failure injection matrix
bf12be7f docs: add Smart Cauldron canary proof packet
```

## Remaining gated work

## 2026-07-10 dual-supervisor reliability addendum

The approved Phase 0 and dual-supervisor work is implemented locally. The
additional controls are:

- dispatch identity is unique at the database boundary
- unspecified AI tool authority fails closed to repository-read, repository-write,
  and shell capability requirements
- real quota exhaustion routes to a declared capable provider in both directions;
  a durable provider wait is used only when no eligible declared provider remains
- Sol and Fable can append independent immutable observations to one incident
- one database compare-and-swap repair lease selects the mutation owner
- every repair lease has a monotonically increasing fencing token; expired owners
  cannot authorize a repair after takeover
- repair action evidence is committed before lease release and atomically marks the
  incident recovered, preventing a later duplicate repair
- Smart Cauldron exposes an opt-in failure-supervision hook; no live supervisor,
  provider call, refire, feature flag, or production mutation was enabled

Focused verification at commit `c25de3a8`:

- workflow reliability directory: 50 pass, 0 fail
- core workflow persistence, SQLite/PostgreSQL parity, and store adapter: 151 pass,
  0 fail
- Smart Cauldron cascade: 21 pass, 0 fail
- quota/failover focused tests: 29 pass, 0 fail
- repository `check:bundled`: exit 0; 36 commands, 96 workflows, 1 policy
- repository `type-check`: exit 0 for every workspace package and scripts
- repository `format:check`: exit 0

Repository-wide test evidence:

- without a Bash path, the parallel run stopped with exit 130 after five
  `uv_spawn 'bash'` failures
- with Git-for-Windows Bash added only to the child process `PATH`, the run reached
  the complete DAG executor file and reported 292 pass, 1 skip, 8 fail
- all eight remaining failures are pre-existing Windows script-node execution
  failures: the executor spawns `bun` as a native executable, while this host has
  only npm command/PowerShell shims in `PATH`
- all new supervisor, persistence, routing, capability, schema, and cascade tests
  passed; Linux CI remains required for the eight script-node fixtures

New local commits:

```text
acaaa591 docs: design dual-supervisor recovery control plane
a979c15c test(workflows): restore reliability store mock
4adb74a5 fix(core): reject duplicate reliability dispatches
c2690927 fix(workflows): fail closed on undeclared tool authority
effaf2c9 fix(workflows): route quota exhaustion across providers
909a4230 feat(reliability): add fenced supervisor incident ledger
c25de3a8 feat(smart-cauldron): delegate terminal recovery to supervisors
```

No branch was pushed, no PR was created, and nothing was merged, deployed, fired,
restarted, or enabled.

The implementation goal is complete locally, but integration is intentionally not
performed. The following require separate user decisions and authority:

- review the local commit series and decide whether to publish a branch or PR
- rerun the 8 Windows-incompatible script-node fixtures in Linux/Bash CI
- review and approve the canary packet
- separately approve any drain, rebuild, restart, feature-flag enablement, fire,
  push, PR creation, merge, or deployment

The safe current state is a clean isolated worktree with durable local commits and
the original dirty checkout preserved.

## 2026-07-10 Round 3 correction

This section supersedes the dual-supervisor verification claims above where they
conflict. Round 2 review found that the earlier implementation and ledger were not
yet sufficient. Round 3 closes the branch-owned findings as follows:

- text-only AI fixtures now declare `allowed_tools: []`; undeclared authority
  remains fail-closed
- supervisor lease acquisition, takeover, authorization, reservation, and
  finalization compare against database time rather than application clocks
- a repair action must be atomically reserved before the external repair callback
  runs; one unique reservation is allowed per incident
- repair finalization records completed or failed status and closes the incident
  as recovered or escalated under the same owner and fencing token
- recovered or escalated incidents cannot be claimed for another automated repair
- every initial workflow dispatch freezes or reuses persisted work-order authority
  in the shared executor before any DAG node runs
- all seven feature-development lanes are enumerated and tested for frozen-source
  artifact and hash consumption
- managed-clone reset eligibility now uses an exact descendant boundary rather
  than a vulnerable string prefix
- mechanical run-outcome persistence now fails on a lost compare-and-swap instead
  of emitting false completion evidence
- Bun script nodes resolve a real Bun CLI in source and compiled distributions,
  including the native executable behind a Windows npm shim
- stale repair owners cannot finalize after DB-clock lease expiry or takeover;
  SQLite lock contention is treated as a safe lost reservation race

Round 3 verification at commit `f96e0976`:

- `@archon/workflows` package test command with Git-for-Windows Bash on the child
  `PATH`: exit 0
- sequential all-workspace test command with the same child `PATH`: exit 0
- repository `check:bundled`: exit 0; 36 commands, 96 workflows, 1 policy
- repository `type-check`: exit 0 for every workspace package and scripts
- repository `lint --max-warnings 0`: exit 0
- repository `format:check`: exit 0
- `git diff --check`: exit 0
- ASCII scan of changed script and code files: exit 0

Two qualifications remain. Without Git-for-Windows Bash on the child `PATH`, five
Bash fixtures fail with `uv_spawn 'bash'`. With that prerequisite, the root
parallel test wrapper still exits silently on this Windows host, while the same
workspace tests pass sequentially. Also,
`check:bundled-skill` reports an existing CLI documentation inventory drift in
files untouched by this branch. Neither result is represented as green.

An independent pre-publication review found and drove repairs for stale-owner
finalization, SQLite reservation contention, compiled-binary Bun resolution, lease
release on lost fencing, and missing authority reuse tests.

The supervisor hook remains opt-in and unactivated. No live supervisor provider,
refire, feature flag, deployment, merge, production mutation, or production
database migration was performed. PostgreSQL behavior is covered by SQL-shape and
type tests; live PostgreSQL execution remains a canary requirement.
