# Smart Cauldron Dual-Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the verified P1 defects and add simultaneous Sol/Fable monitoring with database-enforced single-writer repair ownership and real provider-exhaustion failover.

**Architecture:** Existing reliability records remain authoritative. Add a focused supervisor incident store in core, keep observations multi-writer and immutable, and gate mutations with a compare-and-swap lease plus fencing token. Extend the existing declared node failover path for quota exhaustion instead of creating a second router.

**Tech Stack:** Bun, TypeScript, Zod, SQLite, PostgreSQL, Hono, Bun test.

## Global Constraints

- Work only in `C:/Users/pcmed/projects/.worktrees/bdc-harness-smart-cauldron-reliability`.
- Base is `origin/dev`; do not merge, deploy, or enable live recovery.
- ASCII only in every edited source and Markdown file.
- No secrets, production mutations, raw WO fires, or approval bypasses.
- Use test-first red/green cycles for every behavior change.
- Every repair/refire mutation requires a current database-issued fencing token.

---

### Task 1: Restore a truthful green baseline

**Files:**
- Modify: `packages/workflows/src/script-node-deps.test.ts`
- Modify: `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-audit.md`
- Modify: `packages/docs-web/src/content/docs/reference/database.md`

**Interfaces:**
- Consumes: the full `IWorkflowStore` contract used by `withRunLease`.
- Produces: a script-node mock store containing the reliability methods required by the executor.

- [ ] Reproduce the seven failures with `cd packages/workflows && bun test src/script-node-deps.test.ts`.
- [ ] Add only the missing reliability store methods to the existing mock.
- [ ] Re-run the focused test and record the exact pass/fail totals.
- [ ] Append migrations 021 through 025 to the manual migration documentation.
- [ ] Replace the stale audit ledger with command output reproduced at the final branch HEAD.
- [ ] Commit the isolated repair.

### Task 2: Add dispatch uniqueness at the database boundary

**Files:**
- Modify: `migrations/024_smart_cauldron_reliability.sql`
- Modify: `migrations/000_combined.sql`
- Modify: `packages/core/src/db/adapters/sqlite.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: database adapter schema tests as required by current parity patterns.

**Interfaces:**
- Consumes: `upsertRunAuthority(authority: RunAuthorityRecord): Promise<boolean>`.
- Produces: one authoritative run authority per `dispatch_id` across different `run_id` values.

- [ ] Write a failing database test that inserts two authorities with different run IDs and the same dispatch ID and expects the second insert to be rejected without replacing the first.
- [ ] Run the focused core test and confirm failure for missing uniqueness.
- [ ] Add `UNIQUE (dispatch_id)` consistently to SQLite, PostgreSQL migration, and combined schema definitions.
- [ ] Translate uniqueness conflicts into the existing `false` admission result rather than an unhandled provider fire.
- [ ] Re-run core and adapter schema tests.
- [ ] Commit the schema backstop.

### Task 3: Fail closed on unknown AI-node execution capability

**Files:**
- Modify: `packages/workflows/src/schemas/dag-node.ts`
- Modify: `packages/workflows/src/schemas/dag-node.test.ts`
- Modify: `packages/workflows/src/node-failover.test.ts`
- Modify: `packages/workflows/src/lane-registration.test.ts` if fixture expectations change.

**Interfaces:**
- Consumes: `deriveNodeExecutionRequirements(node: DagNode)`.
- Produces: deterministic minimum capabilities that cannot classify an unspecified tool posture as safely chat-only.

- [ ] Add failing tests for `apply-patch` and `fix-lint` nodes with unspecified tools; expect `text`, `repositoryRead`, `repositoryWrite`, and `shell`.
- [ ] Add a failing dispatch test proving a chat-only provider is rejected before its provider call.
- [ ] Preserve explicit text-only review/planning nodes through a mechanical declaration already supported by the schema; do not inspect prompt prose.
- [ ] Implement the smallest fail-closed derivation rule.
- [ ] Run schema, loader, lane registration, and node-failover tests.
- [ ] Commit the capability repair.

### Task 4: Implement real quota-exhaustion cross-routing

**Files:**
- Modify: `packages/workflows/src/node-failover.ts`
- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/node-failover.test.ts`
- Modify: `packages/workflows/src/reliability/failure-injection.test.ts`

**Interfaces:**
- Produces: a pure selection result of either `{ kind: 'failover', provider, model }` or `{ kind: 'wait' }` for a quota-exhausted attempt.
- Reuses: declared `failover_provider`/`failover_model`, provider capability checks, provider attempt persistence, and typed route events.

- [ ] Delete the hand-authored JSON exhaustion fixture.
- [ ] Write a failing test that invokes the real selection function for Claude exhaustion with an eligible Codex failover.
- [ ] Write the provider-neutral inverse test and an ineligible-provider wait test.
- [ ] Implement the pure selection function using declared failover configuration and capability enforcement.
- [ ] In both loop and non-loop executor paths, create a linked failover attempt before dispatch and emit the existing typed route event.
- [ ] Schedule the existing durable same-provider wait only when no eligible declared failover exists.
- [ ] Run focused executor and reliability tests.
- [ ] Commit the routing repair.

### Task 5: Add the dual-supervisor incident ledger

**Files:**
- Create: `migrations/026_supervisor_incidents.sql`
- Modify: `migrations/000_combined.sql`
- Modify: `packages/core/src/db/adapters/sqlite.ts`
- Create: `packages/workflows/src/reliability/supervisor.ts`
- Create: `packages/workflows/src/reliability/supervisor.test.ts`
- Modify: `packages/workflows/src/reliability/types.ts`
- Modify: `packages/workflows/src/store.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/workflows/store-adapter.ts`
- Modify: relevant store and schema parity tests.

**Interfaces:**
- Produces: `appendSupervisorObservation`, `claimSupervisorRepairLease`, `heartbeatSupervisorRepairLease`, `authorizeSupervisorMutation`, `releaseSupervisorRepairLease`.
- Lease claims return `{ ownerId: string; fencingToken: number; expiresAt: string }`.

- [ ] Write failing tests proving Sol and Fable can append observations to one incident.
- [ ] Write a failing concurrent-claim test proving only one owner wins.
- [ ] Write a failing expiry/takeover test proving the new owner receives a higher fencing token.
- [ ] Write a failing stale-token test proving the former owner cannot authorize mutation.
- [ ] Add additive incident, observation, and lease schema with foreign keys and unique incident identity.
- [ ] Implement database compare-and-swap operations and store adapters.
- [ ] Implement the thin reliability service with no model-specific policy beyond supervisor IDs.
- [ ] Run workflow, core, SQLite, and PostgreSQL parity tests.
- [ ] Commit the incident ledger.

### Task 6: Integrate observation and guarded recovery actions

**Files:**
- Modify: `packages/smart-cauldron/src/cascade.ts`
- Modify: `packages/smart-cauldron/src/types.ts`
- Modify: `packages/smart-cauldron/src/__tests__/cascade.test.ts`
- Add one focused integration test under `packages/smart-cauldron/src/__tests__/`.

**Interfaces:**
- Consumes: the supervisor incident store from Task 5.
- Produces: observe-only Sol/Fable assessments and a single lease-authorized repair/refire action.

- [ ] Write a failing integration test in which Sol and Fable both observe one failed run but only the lease winner calls the injected repair/refire dependency.
- [ ] Write a failing takeover test in which the original owner stops heartbeating and the standby completes the action with a higher token.
- [ ] Add supervisor hooks to `CascadeDeps` so tests never call a live model or API.
- [ ] Check the fencing token immediately before the injected mutation.
- [ ] Persist the action result before releasing the lease.
- [ ] Keep the feature observe-only unless explicitly invoked by a caller; do not add a live default worker.
- [ ] Run Smart Cauldron unit and integration tests.
- [ ] Commit the integration.

### Task 7: Final verification and evidence correction

**Files:**
- Modify: `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-audit.md`
- Modify: this plan's checkboxes and evidence section.

- [ ] Run focused tests for every changed package.
- [ ] Run `bun run check:bundled`.
- [ ] Run `bun run type-check`.
- [ ] Run `bun run format:check`.
- [ ] Run `bun run test` and record exact totals and any environment-only failures.
- [ ] Run an ASCII scan over every changed code, SQL, YAML, and Markdown file.
- [ ] Run `git diff --check` and review `git diff --stat origin/dev...HEAD`.
- [ ] Correct the audit ledger from these exact outputs; do not preserve stale totals.
- [ ] Stop with the branch and worktree preserved. Do not push, create a PR, merge, deploy, or enable live recovery without a separate instruction.

## Plan Self-Review

- Every approved design requirement maps to Tasks 3 through 6.
- Every P1 verification finding maps to Tasks 1 through 4.
- Notification fanout remains explicitly out of scope.
- No step authorizes production or external mutation.
- No placeholders or invented provider APIs are used; exact internal function names for Task 5 are defined as the interfaces that task must produce.
