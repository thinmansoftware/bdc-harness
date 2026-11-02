# Smart Cauldron Round 3 Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Round 2 dual-supervisor review findings with reproducible tests, DB-clock fencing, non-repeatable repair admission, universal authority freezing, and an honest verification ledger.

**Architecture:** Keep the existing Smart Cauldron conductor and workflow engine. Strengthen the supervisor persistence boundary in `@archon/core`, make the workflow executor obtain frozen authority through its existing dependency injection seam, and add narrow safety checks rather than a parallel control plane. External repair is admitted by an atomic action reservation before the callback; completion closes the incident only under the same owner and fencing token.

**Tech Stack:** Bun 1.3, TypeScript, SQLite/PostgreSQL adapters, Archon workflow DAG engine, YAML bundled defaults.

## Global Constraints

- Work only on `codex/smart-cauldron-reliability-design` in the isolated worktree.
- No deployment, live fire, merge, production database mutation, or workflow activation.
- Preserve SQLite and PostgreSQL behavior parity.
- Use database time for supervisor lease validity; caller timestamps are audit fields only.
- Unknown AI tool authority remains fail-closed; text-only nodes must declare `allowed_tools: []`.
- Every code fix follows red-green TDD.
- Every edited file must remain ASCII-only.
- Use `bun run test`, never raw root `bun test`, for workspace truth because Bun `mock.module()` is process-global.

---

## File map

| File | Responsibility |
|---|---|
| `packages/workflows/src/loader.test.ts` | Explicit text-only loader fixture |
| `packages/workflows/src/dag-executor.test.ts` | Explicit text-only attempt fixture and evidence-CAS regression |
| `packages/workflows/src/dag-executor.ts` | Fail when mechanical outcome persistence loses its CAS |
| `packages/workflows/src/deps.ts` | Inject canonical work-order freezing into every executor path |
| `packages/workflows/src/executor.ts` | Freeze missing initial authority centrally and reject missing authority before nodes |
| `packages/core/src/workflows/store-adapter.ts` | Supply `freezeWorkOrderSource` to `WorkflowDeps` |
| `packages/core/src/workflows/store-adapter.test.ts` | Prove the dependency is wired |
| `packages/workflows/src/store.ts` | Supervisor lease and repair reservation contracts |
| `packages/workflows/src/reliability/supervisor.ts` | Reserve one repair before external mutation and finalize it afterward |
| `packages/workflows/src/reliability/supervisor.test.ts` | Dual-observer, one-reservation, failed-finalization behavior |
| `packages/core/src/db/workflows.ts` | DB-clock leases, status guards, atomic reservation/finalization |
| `packages/core/src/db/workflows.test.ts` | PostgreSQL SQL-shape and real SQLite fencing tests |
| `packages/core/src/workflows/store-adapter.test.ts` | Store method parity |
| `migrations/027_supervisor_action_reservation.sql` | One repair reservation per incident and action lifecycle |
| `migrations/000_combined.sql` | Fresh-install schema parity |
| `packages/core/src/db/adapters/sqlite.ts` | SQLite fresh-install schema parity |
| `packages/isolation/src/providers/worktree.ts` | Managed-root path boundary |
| `packages/isolation/src/providers/worktree.test.ts` | Prefix-collision regression |
| `packages/workflows/src/defaults/bundled-defaults.generated.ts` | Regenerated bundled workflow bytes only if source YAML changes |
| `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-audit.md` | Reproducible Round 3 ledger |
| `docs/superpowers/plans/2026-07-10-smart-cauldron-round3-repair-plan.md` | This execution plan |

---

### Task 1: Repair the explicit text-only capability fixtures

**Files:**
- Modify: `packages/workflows/src/loader.test.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`

**Interfaces:**
- Consumes: `deriveNodeExecutionRequirements(node)` fail-closed behavior.
- Produces: fixtures that explicitly request no tools with `allowed_tools: []`.

- [ ] **Step 1: Preserve the observed red evidence**

Run:

```powershell
bun test src/loader.test.ts
bun test src/dag-executor.test.ts
```

Expected branch-owned failures:

```text
keeps a chat-only provider eligible for a text-only plan
persists and completes an attempt around every provider call
```

- [ ] **Step 2: Declare the loader fixture text-only**

Add this field to the `plan` node in the failing YAML fixture:

```yaml
allowed_tools: []
```

- [ ] **Step 3: Declare the provider-attempt fixture text-only**

Change the node to:

```ts
nodes: [
  {
    id: 'investigate',
    prompt: 'Investigate the issue',
    model: 'sonnet',
    allowed_tools: [],
  },
],
```

- [ ] **Step 4: Verify green without weakening production classification**

Run:

```powershell
bun test src/loader.test.ts
bun test src/dag-executor.test.ts
bun test src/schemas/dag-node.test.ts src/node-failover.test.ts
```

Expected: loader and the branch-owned capability assertion pass. Windows bash-launch failures, if any, are reported separately and not relabeled.

- [ ] **Step 5: Commit**

```powershell
git add packages/workflows/src/loader.test.ts packages/workflows/src/dag-executor.test.ts
git commit -m "test(workflows): declare text-only capability fixtures"
```

### Task 2: Move supervisor lease validity to the database clock

**Files:**
- Modify: `packages/workflows/src/store.ts`
- Modify: `packages/workflows/src/reliability/supervisor.ts`
- Modify: `packages/workflows/src/reliability/supervisor.test.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: `packages/core/src/workflows/store-adapter.test.ts`

**Interfaces:**
- Consumes: `claimSupervisorRepairLease`, `heartbeatSupervisorRepairLease`, `authorizeSupervisorMutation`.
- Produces: duration-based lease APIs whose validity predicates use `NOW()` or `julianday('now')`.

- [ ] **Step 1: Write failing SQL-contract tests**

Add tests asserting:

```ts
expect(claimSql).toContain('NOW()');
expect(claimSql).not.toContain('EXCLUDED.acquired_at');
expect(authorizeSql).toContain('NOW()');
expect(authorizeParams).not.toContain('2026-07-10T12:01:04.000Z');
```

Add a real SQLite test that claims a lease, directly expires it with SQL, then proves only a new owner receives fencing token 2.

- [ ] **Step 2: Verify the new tests fail for caller-clock SQL**

Run:

```powershell
bun test src/db/workflows.test.ts
```

Expected: FAIL because supervisor predicates still compare with caller timestamps.

- [ ] **Step 3: Replace absolute expiry inputs with duration inputs**

Change the store contracts to:

```ts
claimSupervisorRepairLease?(data: {
  incidentId: string;
  ownerId: string;
  leaseDurationMs: number;
}): Promise<SupervisorRepairLeaseRecord | null>;

heartbeatSupervisorRepairLease?(data: {
  incidentId: string;
  ownerId: string;
  fencingToken: number;
  leaseDurationMs: number;
}): Promise<boolean>;

authorizeSupervisorMutation?(data: {
  incidentId: string;
  ownerId: string;
  fencingToken: number;
}): Promise<boolean>;
```

In the coordinator, calculate the duration from the two input timestamps and reject non-positive or non-finite durations before observing or claiming.

- [ ] **Step 4: Generate timestamps and validity predicates in SQL**

Use PostgreSQL expressions:

```sql
NOW()
NOW() + ($3::bigint * INTERVAL '1 millisecond')
expires_at <= NOW()
expires_at > NOW()
```

Use SQLite expressions:

```sql
strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ($3 / 1000.0) || ' seconds')
julianday(expires_at) <= julianday('now')
julianday(expires_at) > julianday('now')
```

- [ ] **Step 5: Verify both SQL shape and SQLite behavior**

Run:

```powershell
bun test src/db/workflows.test.ts
bun test src/reliability/supervisor.test.ts
bun test src/workflows/store-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/workflows/src/store.ts packages/workflows/src/reliability/supervisor.ts packages/workflows/src/reliability/supervisor.test.ts packages/core/src/db/workflows.ts packages/core/src/db/workflows.test.ts packages/core/src/workflows/store-adapter.test.ts
git commit -m "fix(reliability): use database time for supervisor leases"
```

### Task 3: Reserve one repair before any external mutation

**Files:**
- Create: `migrations/027_supervisor_action_reservation.sql`
- Modify: `migrations/000_combined.sql`
- Modify: `packages/core/src/db/adapters/sqlite.ts`
- Modify: `packages/workflows/src/reliability/types.ts`
- Modify: `packages/workflows/src/store.ts`
- Modify: `packages/workflows/src/reliability/supervisor.ts`
- Modify: `packages/workflows/src/reliability/supervisor.test.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: `packages/core/src/workflows/store-adapter.ts`
- Modify: `packages/core/src/workflows/store-adapter.test.ts`
- Modify: `packages/docs-web/src/content/docs/reference/database.md`

**Interfaces:**
- Consumes: a valid DB-clock supervisor lease.
- Produces: `reserveSupervisorAction()` before the callback and `finalizeSupervisorAction()` after it.

- [ ] **Step 1: Write failing coordinator tests**

Add tests proving:

```ts
expect(store.reserveSupervisorAction).toHaveBeenCalledBefore(repair);
expect(repair).toHaveBeenCalledTimes(1);
```

When reservation returns false, assert `repair` is never called. When finalization returns false, assert `repaired` is false and the incident is not reported recovered.

- [ ] **Step 2: Write failing database tests**

Test these cases on real SQLite:

1. One valid lease can reserve one action.
2. A stale token cannot reserve.
3. A second owner cannot reserve the same incident.
4. A recovered or escalated incident cannot reserve.
5. Finalization closes only an `open` or `repairing` incident owned by the reservation token.
6. A second reservation after recovery returns false.

- [ ] **Step 3: Verify red**

Run:

```powershell
bun test src/reliability/supervisor.test.ts
bun test src/db/workflows.test.ts
```

Expected: FAIL because reservation/finalization methods do not exist.

- [ ] **Step 4: Add the action lifecycle schema**

Add `status` with allowed values `reserved`, `completed`, and `failed`, plus `completed_at`. Add a unique index on `incident_id` so automated repair admission is one-shot.

Migration safety:

```sql
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE remote_agent_supervisor_actions
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_action_incident
  ON remote_agent_supervisor_actions(incident_id);
```

SQLite fresh-install schema receives the final columns directly. Existing SQLite databases use adapter startup compatibility migration code before the unique index is created.

- [ ] **Step 5: Implement atomic reservation**

`reserveSupervisorAction` must run in a transaction:

1. Join lease and incident.
2. Require owner/token, unreleased lease, DB-clock unexpired lease, and incident status `open` or `repairing`.
3. Insert one `reserved` action with `ON CONFLICT (incident_id) DO NOTHING`.
4. Set incident status to `repairing` only if insertion succeeds.

Return false on any lost race without calling the repair callback.

- [ ] **Step 6: Implement fenced finalization**

`finalizeSupervisorAction` must update the reserved action by action ID, owner, and fencing token, then update the incident from `repairing` to `recovered` in the same transaction. Any zero-row update throws an internal transaction-abort error and returns false after rollback.

- [ ] **Step 7: Update the coordinator order**

The order becomes:

```text
observe -> claim -> authorize -> reserve action -> repair -> finalize action -> release
```

If `repair` throws, finalize the reservation as `failed`, release the lease best-effort, and rethrow. Do not allow another automatic reservation for the same incident; operator reconciliation decides whether the external side effect occurred.

- [ ] **Step 8: Verify schema and behavior**

Run:

```powershell
bun test src/reliability/supervisor.test.ts
bun test src/db/workflows.test.ts
bun test src/workflows/store-adapter.test.ts
bun run type-check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add migrations/027_supervisor_action_reservation.sql migrations/000_combined.sql packages/core/src/db/adapters/sqlite.ts packages/workflows/src/reliability/types.ts packages/workflows/src/store.ts packages/workflows/src/reliability/supervisor.ts packages/workflows/src/reliability/supervisor.test.ts packages/core/src/db/workflows.ts packages/core/src/db/workflows.test.ts packages/core/src/workflows/store-adapter.ts packages/core/src/workflows/store-adapter.test.ts packages/docs-web/src/content/docs/reference/database.md
git commit -m "fix(reliability): reserve supervisor repairs before mutation"
```

### Task 4: Freeze run authority on every initial executor path

**Files:**
- Modify: `packages/workflows/src/deps.ts`
- Modify: `packages/workflows/src/executor.ts`
- Modify: `packages/workflows/src/executor.test.ts`
- Modify: `packages/core/src/workflows/store-adapter.ts`
- Modify: `packages/core/src/workflows/store-adapter.test.ts`
- Modify: `packages/core/src/workflows/work-order-source.test.ts`

**Interfaces:**
- Consumes: `freezeWorkOrderSource(policy, userMessage)`.
- Produces: `WorkflowDeps.freezeWorkOrderSource` and central initial-run freezing.

- [ ] **Step 1: Write failing executor tests**

Add these scenarios:

1. Required authority plus no caller-supplied source invokes `deps.freezeWorkOrderSource` before the first node.
2. The returned source is persisted with `dispatchId: conversationId`.
3. Missing freeze dependency fails `scope_authority_missing` before provider or bash execution.
4. A resumed run with existing persisted authority does not re-fetch the moving spec.
5. Caller-supplied background authority remains byte-identical and is not fetched twice.

- [ ] **Step 2: Verify red**

Run:

```powershell
bun test src/executor.test.ts
bun test src/workflows/store-adapter.test.ts
```

Expected: FAIL because `WorkflowDeps` does not expose the freeze dependency.

- [ ] **Step 3: Add the narrow dependency**

Add:

```ts
freezeWorkOrderSource?: (
  policy: RunAuthorityPolicy,
  userMessage: string
) => Promise<FrozenSpecSource>;
```

Wire it in `createWorkflowDeps()` using the existing core implementation.

- [ ] **Step 4: Resolve initial authority centrally**

After the run row and artifact directory exist but before any workflow node:

```ts
let effectiveAuthoritySource = authoritySource;
if (workflow.run_authority?.required && !effectiveAuthoritySource) {
  const existing = await deps.store.getRunAuthority(workflowRun.id);
  if (!existing) {
    if (!deps.freezeWorkOrderSource) {
      throw new Error('scope_authority_missing: frozen dispatch source');
    }
    const frozen = await deps.freezeWorkOrderSource(workflow.run_authority, userMessage);
    effectiveAuthoritySource = { ...frozen, dispatchId: conversationId };
  }
}
```

Then persist `effectiveAuthoritySource` through the existing `captureRunAuthorityInput` path.

- [ ] **Step 5: Verify all initial surfaces share the invariant**

Run:

```powershell
bun test src/executor.test.ts
bun test src/workflows/store-adapter.test.ts
bun test src/orchestrator/orchestrator.test.ts
bun test src/orchestrator/orchestrator-agent.test.ts
bun test src/commands/workflow.test.ts
bun test src/routes/api.workflow-runs.test.ts
```

Expected: PASS. If the CLI has no `workflow.test.ts`, record that absence and rely on the shared executor test plus type checking; do not invent a filename.

- [ ] **Step 6: Commit**

```powershell
git add packages/workflows/src/deps.ts packages/workflows/src/executor.ts packages/workflows/src/executor.test.ts packages/core/src/workflows/store-adapter.ts packages/core/src/workflows/store-adapter.test.ts packages/core/src/workflows/work-order-source.test.ts
git commit -m "fix(workflows): freeze authority on every initial dispatch"
```

### Task 5: Close the two carried narrow safety defects

**Files:**
- Modify: `packages/isolation/src/providers/worktree.ts`
- Modify: `packages/isolation/src/providers/worktree.test.ts`
- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`

**Interfaces:**
- Produces: path-segment-safe managed clone detection and checked mechanical outcome persistence.

- [ ] **Step 1: Write the managed-root prefix collision test**

Use a canonical path under `workspaces-staging/owner/repo` and expect:

```ts
expect(syncWorkspaceSpy).toHaveBeenCalledWith(
  request.canonicalRepoPath,
  undefined,
  { resetAfterFetch: false }
);
```

Add the positive control under the exact `workspaces/owner/repo` root expecting `resetAfterFetch: true`.

- [ ] **Step 2: Verify the collision test fails**

Run:

```powershell
bun test src/providers/worktree.test.ts
```

Expected: FAIL because `startsWith` misclassifies the sibling prefix.

- [ ] **Step 3: Use a path boundary instead of string prefix**

Normalize both paths, append one `/` to the managed root, and accept only an exact descendant:

```ts
const normalizedRepo = repoPath.replace(/\\/g, '/');
const normalizedRoot = getArchonWorkspacesPath().replace(/\\/g, '/').replace(/\/+$/, '');
const isManagedClone = normalizedRepo.startsWith(`${normalizedRoot}/`);
```

- [ ] **Step 4: Write the mechanical outcome CAS test**

Configure `upsertRunOutcome` to return false and assert the evidence node does not emit `node_completed` and the workflow records a failure.

- [ ] **Step 5: Verify the CAS test fails**

Run:

```powershell
bun test src/dag-executor.test.ts
```

Expected: FAIL because `executeEvidenceNode` currently discards the false return.

- [ ] **Step 6: Check the CAS result**

Use:

```ts
const outcomeUpdated = await deps.store.upsertRunOutcome(
  workflowRun.id,
  evidence.outcome,
  new Date().toISOString()
);
if (!outcomeUpdated) {
  throw new Error(`run_outcome_conflict: ${workflowRun.id}`);
}
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
bun test src/providers/worktree.test.ts
bun test src/dag-executor.test.ts
```

Then:

```powershell
git add packages/isolation/src/providers/worktree.ts packages/isolation/src/providers/worktree.test.ts packages/workflows/src/dag-executor.ts packages/workflows/src/dag-executor.test.ts
git commit -m "fix(reliability): close path and outcome safety gaps"
```

### Task 6: Prove the seven default lanes and regenerate bundles

**Files:**
- Modify only if required: `.archon/workflows/defaults/bdc-feature-development*.yaml`
- Regenerate only if YAML changes: `packages/workflows/src/defaults/bundled-defaults.generated.ts`
- Modify: `packages/workflows/src/lane-registration.test.ts`

**Interfaces:**
- Consumes: central executor authority freezing.
- Produces: all seven feature lanes load with required authority and no caller-specific artifact assumption.

- [ ] **Step 1: Add a lane contract test**

Discover every `bdc-feature-development*.yaml` lane and assert:

```ts
expect(lane.run_authority?.required).toBe(true);
expect(lane.run_authority?.spec_repository).toBe('bluedevilcollectibles/bdc-xo');
expect(lane.nodes.some(node => node.id === 'read-spec')).toBe(true);
```

The test must assert exactly seven lane names so an eighth lane cannot silently escape review.

- [ ] **Step 2: Run lane and bundled checks**

```powershell
bun test src/lane-registration.test.ts
bun run check:bundled
```

Expected: PASS without YAML changes. If source YAML is already correct, do not rewrite or regenerate it.

- [ ] **Step 3: Commit only if the contract test changes**

```powershell
git add packages/workflows/src/lane-registration.test.ts
git commit -m "test(workflows): cover authority on every feature lane"
```

### Task 7: Run canonical verification and replace the evidence ledger

**Files:**
- Modify: `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-audit.md`
- Create: `docs/superpowers/plans/2026-07-10-smart-cauldron-round3-verification.md`

**Interfaces:**
- Produces: exact command, exit code, pass/fail totals, environment limitations, and remaining risks.

- [ ] **Step 1: Run focused suites**

```powershell
bun test packages/workflows/src/loader.test.ts
bun test packages/workflows/src/dag-executor.test.ts
bun test packages/workflows/src/reliability/supervisor.test.ts
bun test packages/core/src/db/workflows.test.ts
bun test packages/core/src/workflows/store-adapter.test.ts
bun test packages/isolation/src/providers/worktree.test.ts
```

- [ ] **Step 2: Run package-isolated workspace truth**

```powershell
bun run test
```

Do not replace this with raw root `bun test`.

- [ ] **Step 3: Run non-test gates**

```powershell
bun run check:bundled
bun run check:bundled-skill
bun run type-check
bun run lint --max-warnings 0
bun run format:check
git diff --check
```

- [ ] **Step 4: Verify ASCII only in every touched source file**

```powershell
$files = git diff --name-only origin/dev...HEAD
foreach ($file in $files) {
  if (Test-Path $file) {
    $bad = Select-String -Path $file -Pattern '[^\x00-\x7F]'
    if ($bad) { throw "Non-ASCII: $file" }
  }
}
```

- [ ] **Step 5: Write the Round 3 report from observed output**

The report must separate:

- branch-owned deterministic failures;
- Windows/bash environment failures;
- invalid raw-root mock-pollution runs;
- package-isolated canonical totals;
- unverified real PostgreSQL behavior;
- unverified live dispatch and deployment.

- [ ] **Step 6: Commit**

```powershell
git add docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-audit.md docs/superpowers/plans/2026-07-10-smart-cauldron-round3-verification.md
git commit -m "docs: record smart cauldron round three verification"
```

### Task 8: Submit for independent review

**Files:**
- Read: `.github/PULL_REQUEST_TEMPLATE.md`
- Read: all commits over `origin/dev`

- [ ] **Step 1: Verify branch scope**

```powershell
git status --short
git diff --stat origin/dev...HEAD
git log --oneline origin/dev..HEAD
```

Expected: clean worktree and only Smart Cauldron reliability changes.

- [ ] **Step 2: Push the feature branch**

```powershell
git push -u origin codex/smart-cauldron-reliability-design
```

- [ ] **Step 3: Create or update the PR to `dev`**

Use the repository PR template verbatim and include:

- Round 2 findings disposition table;
- exact canonical validation commands and totals;
- no deployment performed;
- supervisor still not activated;
- real PostgreSQL and live fire-path proof still require canary approval if not executed locally.

- [ ] **Step 4: Request independent Round 3 verification**

The review packet must link the Round 2 report, this repair plan, the Round 3 evidence report, and the PR head SHA.

## Stop conditions

Stop and report instead of publishing if any of these remains true:

1. A deterministic branch-owned test is red.
2. `bun run test` exits non-zero.
3. A supervisor can reserve two repair actions for one incident.
4. A lease-validity predicate compares to a caller timestamp.
5. A required-authority initial run can reach a node without persisted authority artifacts.
6. The seven-lane contract test does not enumerate exactly seven lanes.
7. The evidence ledger does not reproduce from the commands recorded in it.
8. The worktree contains unrelated changes.
