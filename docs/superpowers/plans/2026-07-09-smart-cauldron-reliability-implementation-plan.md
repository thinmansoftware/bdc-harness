# Smart Cauldron Reliability Implementation Plan

Status: APPROVED FOR LOCAL IMPLEMENTATION

Date: 2026-07-09

Design authority:
`docs/superpowers/specs/2026-07-09-smart-cauldron-reliability-kernel-design.md`

Working branch: `codex/smart-cauldron-reliability-design`

Base: `origin/dev` at `b881cb6808e2db87688a5ca705b32e657fb231c8`

## Objective

Implement the approved Smart Cauldron reliability design without replacing the DAG
executor or duplicating merged work. Land the three immediate Phase 0 fixes first,
then add durable control-plane slices in dependency order. Every slice is test-first,
locally committed, independently reviewable, and reversible.

## Non-negotiable boundaries

- Preserve `C:\Users\pcmed\projects\bdc-harness` exactly as found.
- Work only in
  `C:\Users\pcmed\projects\.worktrees\bdc-harness-smart-cauldron-reliability`.
- Never reset, clean, delete, adopt, or overwrite an existing worktree.
- No push, PR, merge, deploy, rebuild, restart, workflow fire, branch-protection
  change, or production mutation without separate authorization.
- No live provider call is required for implementation verification.
- Keep all script/code changes ASCII-only.
- Before each slice, fetch `origin/dev` and recheck open/merged prior art. If the
  behavior already landed, delete that slice from scope instead of rebuilding it.
- Do not combine Phase 0 commits with kernel schema or routing changes.
- Do not claim the full goal complete until controlled failure injection covers every
  required state transition and a canary packet is ready for separate approval.

## Known baseline

- Smart Cauldron: 41 tests pass; typecheck passes.
- `executor-shared.test.ts`: 110 tests pass independently.
- `dag-executor.test.ts`: 288 tests pass with one intentional skip independently.
- Workflow package typecheck passes.
- `check:bundled` passes.
- `check:bundled-skill` has pre-existing drift for 20 documentation files. Do not
  attribute that failure to these changes unless a slice modifies the bundle.
- On Windows, prepend the real Bun executable and Git Bash directories to `PATH` for
  executor tests. Run the two executor test files in separate Bun processes because
  a combined process has a pre-existing logger-mock isolation failure.

## Commit and verification discipline

For each task:

1. Confirm clean worktree and current `origin/dev` relationship.
2. Re-run the focused existing test before editing.
3. Add the smallest failing test that proves the incident.
4. Run it and capture the expected failure.
5. Implement only the behavior required by that test and design slice.
6. Run focused tests and package typecheck.
7. Run generated-artifact checks when YAML/defaults change.
8. Run `git diff --check` and an ASCII scan of changed code/script files.
9. Review the exact `origin/dev..HEAD` slice diff.
10. Commit locally with the task's stated commit message.

## Phase 0A: preserve loop output chunk boundaries

### Prior art to preserve

- PR #298 preserves loop provider/model fields.
- PR #378 added plan-review normalization plus idle/wall timeouts.
- Do not change timeout policy or completion-signal rules in this task.

### Files

- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`
- Do not modify: `packages/workflows/src/executor-shared.ts` unless the failing test
  proves a general helper contract must change.

### Test-first steps

1. Add a loop test whose provider yields these assistant chunks:
   `FIELD_ONE=true`, `\n`, and `FIELD_TWO=value`.
2. Assert the next iteration's `$LOOP_PREV_OUTPUT` contains the exact newline.
3. Assert the persisted `node_completed.data.node_output` preserves the same layout.
4. Add a second case where `<promise>NOT_DONE</promise>` spans or abuts chunks and
   prove tags are removed without joining neighboring words.
5. Run the new test and confirm current code fails because it calls
   `stripCompletionTags(msg.content)` and trims each chunk.

### Implementation steps

1. Continue appending provider chunks unchanged to `fullOutput`.
2. Recompute `cleanOutput` from the full accumulated buffer after each assistant
   chunk: `cleanOutput = stripCompletionTags(fullOutput, loop.until)`.
3. In stream mode, send only the newly added clean delta. Never resend the whole
   accumulated buffer.
4. If removal of a completion tag makes delta calculation ambiguous, buffer that
   iteration for batch emission rather than emitting duplicated or missing text.
5. Keep completion detection on `fullOutput` as PR #378 requires.
6. Keep final `lastIterationOutput = cleanOutput || fullOutput`.

### Verification

```text
bun test packages/workflows/src/dag-executor.test.ts
bun --filter @archon/workflows type-check
git diff --check
```

### Acceptance

- Newlines and spaces at chunk boundaries survive exactly.
- Completion tags do not appear in user or next-iteration output.
- PR #378 timeout and plan-review tests remain green.
- No lane YAML changes.

Commit: `fix(workflows): preserve loop output chunk boundaries`

## Phase 0B: make implementation counters integer-safe

### Prior art to preserve

- PR #380 added integer normalization to some lane copies.
- PR #382 added checkpoint and deliverable-diff truth.
- Do not change REAL_BUILD, ALREADY_SATISFIED, or FALSE_COMPLETE semantics.

### Expected files

Modify only maintained default lanes that contain the unsafe counter pattern:

- `.archon/workflows/defaults/bdc-feature-development.yaml`
- `.archon/workflows/defaults/bdc-feature-development-codex.yaml`
- `.archon/workflows/defaults/bdc-feature-development-codex-only.yaml`
- `.archon/workflows/defaults/bdc-feature-development-zero.yaml`
- `.archon/workflows/defaults/bdc-feature-development-zero-open.yaml`
- `.archon/workflows/defaults/bdc-feature-development-fusion-cx-qwen.yaml`
- `.archon/workflows/defaults/bdc-feature-development-fable.yaml`
- `packages/workflows/src/defaults/bundled-defaults.generated.ts` through generation
  only, never by hand.

Test files:

- Modify: `.archon/workflows/defaults/__tests__/bdc-feature-development.test.sh`
- Add if clearer: `.archon/workflows/defaults/__tests__/integer-counters.sh`

### Test-first steps

1. Add fixtures for zero, one, and multiple `git status --porcelain` lines.
2. Add a fixture where the Git command fails.
3. Assert the counter emits one line matching `^[0-9]+$`.
4. Assert invalid or multiline output exits non-zero with
   `invalid implementation counter`.
5. Add a source scan proving no maintained numeric assignment uses
   `grep -c . || echo 0`.
6. Run the fixture and confirm the unsafe zero case fails before editing YAML.

### Implementation steps

1. Capture `CHANGED_RAW` with `grep -c . || true`; `grep -c` already prints `0`.
2. Capture `AHEAD_RAW` separately.
3. Validate each raw value with a shell `case` accepting digits only.
4. Assign validated values to `CHANGED` and `AHEAD`.
5. On malformed values, print a named error and exit 1. Do not silently coerce an
   unknown count to zero.
6. Apply the identical block to every maintained lane that has the node.
7. Generate bundled defaults.

### Verification

```text
bash .archon/workflows/defaults/__tests__/bdc-feature-development.test.sh
bun test packages/workflows/src/defaults/bundled-defaults.test.ts
bun run generate:bundled
bun run check:bundled
bun --filter @archon/workflows type-check
git diff --check
```

### Acceptance

- Empty status produces integer `0`, once.
- A malformed counter fails explicitly.
- All maintained lane copies have identical semantics.
- Bundled defaults match sources.

Commit: `fix(lanes): make implementation counters integer-safe`

## Phase 0C: scope ASCII enforcement to the current run

### Prior art to preserve

- Existing `run-start-sha.txt` remains useful for run identity but is not a safe
  post-reconciliation mutation boundary.
- Existing `harness/scripts/ascii-autofix.py` remains the normalizer.
- ASCII gate and autofix must consume one identical file list.

### Files

- Modify the seven maintained BDC feature-development YAMLs listed in Phase 0B.
- Modify: `harness/scripts/ascii-autofix.py`
- Modify: `harness/scripts/test-ascii-autofix.py`
- Add: `.archon/workflows/defaults/__tests__/ascii-run-scope.sh`
- Regenerate: `packages/workflows/src/defaults/bundled-defaults.generated.ts`

### Test-first steps

1. Build a temporary Git fixture with target branch `release/ce`.
2. Put non-ASCII bytes in an ancestor/legacy file.
3. Capture a clean scope SHA, then change one unrelated ASCII workflow file.
4. Prove the current widened fallback includes legacy debt in the failing fixture.
5. Assert the desired changed list contains exactly the run-authored file.
6. Add the inverse fixture: introduce non-ASCII in the run-authored file and assert
   the gate fails.
7. Assert autofix and gate read byte-identical path lists.

### Implementation steps

1. Add a `capture-run-scope` bash node after branch selection/plan approval and
   immediately before the first mutating implementation node.
2. Require a clean Git worktree at capture. Fail with `run_scope_dirty_at_capture`
   if tracked or untracked files already exist.
3. Write verified `HEAD` to `$ARTIFACTS_DIR/run-scope-sha.txt`.
4. After implementation, derive one sorted unique path list from:
   `run-scope-sha..HEAD`, unstaged changes, and untracked files.
5. Filter to supported source extensions and generated-file exclusions once.
6. Write the result to `$ARTIFACTS_DIR/run-changed-source-files.txt`.
7. Extend `ascii-autofix.py` with `--files-from <path>`; reject paths outside the
   repository and missing files rather than broadening the scan.
8. Make `ascii-autofix` consume that artifact.
9. Make `ascii-gate` consume the same artifact without recomputing a base.
10. Remove `HEAD~1` and guessed merge-base fallbacks from these two nodes.
11. Missing/invalid scope evidence fails as `scope_authority_missing`.
12. Apply identical DAG wiring to all maintained lanes and regenerate defaults.

### Verification

```text
python harness/scripts/test-ascii-autofix.py
bash .archon/workflows/defaults/__tests__/ascii-run-scope.sh
bun test packages/workflows/src/loader.test.ts
bun test packages/workflows/src/defaults/bundled-defaults.test.ts
bun run generate:bundled
bun run check:bundled
bun --filter @archon/workflows type-check
git diff --check
```

### Acceptance

- The CE fixture scans exactly
  `.github/workflows/ce-change-scope-gate.yml`.
- Untouched legacy `importParser.ts` cannot fail or be rewritten by the run.
- Run-authored non-ASCII still fails.
- Autofix and gate scopes cannot diverge.

Commit: `fix(lanes): bind ASCII checks to immutable run scope`

## Kernel 1: typed reliability contracts and pure outcome reducer

### Files

- Add: `packages/workflows/src/reliability/types.ts`
- Add: `packages/workflows/src/reliability/outcome-reducer.ts`
- Add: `packages/workflows/src/reliability/outcome-reducer.test.ts`
- Modify: `packages/workflows/src/schemas/workflow-run.ts`
- Modify: `packages/workflows/src/schemas/workflow-run.test.ts`
- Modify: `packages/workflows/src/index.ts` only if a public export is required.

### Steps

1. Add failing table tests for CE false-fail, recoverable zombie, provider wait,
   escalated predecessor, no-op success, bad build, ready PR, and multi-stage block.
2. Define the five state dimensions and stable reason-code union from the design.
3. Define immutable run-authority and provider-attempt data shapes.
4. Implement `reduceRunOutcome(evidence)` as a pure, exhaustive function.
5. Implement compatibility projection to current run status without deleting facts.
6. Make dry-run project to `planned`, never `won`.

Verification:

```text
bun test packages/workflows/src/reliability/outcome-reducer.test.ts
bun test packages/workflows/src/schemas/workflow-run.test.ts
bun --filter @archon/workflows type-check
```

Commit: `feat(workflows): add reliability outcome contracts`

## Kernel 2: additive persistence and store interfaces

### Files

- Modify: `packages/core/src/db/adapters/sqlite.ts`
- Modify: `packages/core/src/db/adapters/postgres.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: `packages/workflows/src/store.ts`
- Modify: `packages/core/src/workflows/store-adapter.ts`
- Modify: `packages/core/src/workflows/store-adapter.test.ts`

### Steps

1. Add adapter tests for additive tables/columns before schema changes.
2. Add normalized run-authority, lease, attempt, outcome, and scheduled-wait tables.
3. Add indexes for active leases, due waits, and run/node attempts.
4. Add create/read/update methods with compare-and-swap where ownership matters.
5. Keep existing run rows and events unchanged for compatibility.
6. Prove SQLite and Postgres adapters expose equivalent behavior.

Commit: `feat(core): persist Smart Cauldron reliability state`

## Kernel 3: terminal persistence ordering and reconciliation

### Files

- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: `packages/workflows/src/event-emitter.ts`
- Modify: `packages/workflows/src/event-emitter.test.ts`

### Steps

1. Inject terminal DB write failure and prove current terminal event can diverge.
2. Persist terminal outcome idempotently before publishing terminal SSE/events.
3. On persistence failure, retain recoverable non-terminal state and emit/log
   `status_persist_failed` without claiming completion/failure.
4. Add reconciliation for terminal event/status mismatches.
5. Store node counts and terminal cause for failed runs too.

Commit: `fix(workflows): make terminal persistence authoritative`

## Kernel 4: restart-safe leases and recovery

### Files

- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`
- Modify: `packages/workflows/src/store.ts`
- Modify: `packages/core/src/workflows/store-adapter.ts`
- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`
- Modify: `packages/server/src/index.ts`
- Add focused server startup reconciliation tests beside `packages/server/src/index.ts`.

### Steps

1. Test atomic lease claim, heartbeat, expiry, cancellation, and competing worker.
2. Replace blanket orphan failure with lease-aware `interrupted` classification.
3. Run observe-only reconciliation before accepting new dispatch.
4. Verify frozen authority and worktree path before recovery.
5. Resume through existing `findResumableRun`/`resumeWorkflowRun` behavior.
6. Never commit, push, or delete during recovery.
7. Add process-restart integration fixture proving exactly-once recovery.

Commit: `feat(workflows): add restart-safe run leases`

## Kernel 5: drain mode

### Governing WO

`WO-HARNESS-DRAIN-MODE-01`

### Files

- Modify: `packages/server/src/routes/api.ts`
- Modify: `packages/server/src/routes/schemas/workflow.schemas.ts`
- Modify: `packages/server/src/routes/api.workflow-runs.test.ts`
- Modify: `packages/core/src/db/workflows.ts`
- Modify: `packages/core/src/db/workflows.test.ts`

### Steps

1. Add durable normal/draining mode storage.
2. Reuse existing operator-auth middleware.
3. Reject new dispatch honestly while draining.
4. Leave in-flight runs untouched.
5. Report active lease/run count and computed drained state.
6. Add idempotent enable/disable endpoints and audit evidence.

Commit: `feat(server): add durable Cauldron drain mode`

## Kernel 6: durable worktree identity

### Governing WO

`WO-HARNESS-DURABLE-WORKTREES-01`

### Files

- Modify: `packages/isolation/src/providers/worktree.ts`
- Modify: `packages/isolation/src/providers/worktree.test.ts`
- Modify configuration types only where needed for a configurable durable root.

### Steps

1. Test configured durable root and exact worktree identity record.
2. Preserve current isolation semantics.
3. Reject collision with different authority.
4. Never reset/adopt/delete a collision.
5. Prove local process restart retains uncommitted fixture changes.

Host mount and container restart remain separately approved operational work.

Commit: `feat(isolation): persist authoritative worktree identity`

## Kernel 7: enforce provider execution capabilities

### Files

- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/registry.ts`
- Modify: `packages/providers/src/registry.test.ts`
- Modify provider capability files under Claude, Codex, GLM, Grok, and Pi.
- Modify: `packages/workflows/src/schemas/dag-node.ts`
- Modify: `packages/workflows/src/schemas/dag-node.test.ts`
- Modify: `packages/workflows/src/loader.ts`
- Modify: `packages/workflows/src/loader.test.ts`
- Modify: `packages/workflows/src/node-failover.ts`
- Modify: `packages/workflows/src/node-failover.test.ts`

### Steps

1. Add execution capabilities distinct from existing SDK feature flags.
2. Derive node requirements conservatively from node type/persona/tools.
3. Reject chat-only provider on repo-write/shell nodes at load time.
4. Revalidate capability and persona compatibility on failover.
5. Remove `opr-zero` from builder/repair seats or route those seats to an already
   proven tool-capable provider.
6. Preserve text-only plan/review eligibility for chat providers.

Commit: `feat(providers): enforce workflow execution capabilities`

## Kernel 8: durable provider attempts, failover, and quota waits

### Files

- Modify: `packages/workflows/src/dag-executor.ts`
- Modify: `packages/workflows/src/dag-executor.test.ts`
- Modify: `packages/workflows/src/node-failover.ts`
- Modify: `packages/workflows/src/node-failover.test.ts`
- Modify: `packages/providers/src/types.ts`
- Modify provider adapters that emit prose-only failback.
- Add: `packages/workflows/src/reliability/wait-scheduler.ts`
- Add: `packages/workflows/src/reliability/wait-scheduler.test.ts`
- Modify server startup wiring to run the due-wait scheduler.

### Steps

1. Persist attempt before every provider call.
2. Implement the design's retry precedence and total-attempt ceiling.
3. Require positive quota evidence; zero-token success contradiction alone is not
   quota exhaustion.
4. Retain exactly-one contradiction retry from PR #349.
5. Normalize provider-internal and executor-level failover to one typed event.
6. Convert idle/wall timeout to typed progress failure, not completion.
7. Replace in-process quota sleeps with `waiting_provider` plus `resume_at`.
8. Release lease while waiting and atomically reclaim when due.
9. Make cancellation win the wake race.
10. Re-evaluate capability/health on wake and allow failback.

Commit: `feat(workflows): add durable provider attempt scheduling`

## Kernel 9: immutable run authority and shared scope

### Files

- Add: `packages/workflows/src/reliability/run-authority.ts`
- Add: `packages/workflows/src/reliability/run-authority.test.ts`
- Modify dispatch in `packages/server/src/routes/api.ts`.
- Modify `packages/server/src/routes/api.workflow-runs.test.ts`.
- Modify workflow execution and diff-capture consumers.
- Promote the Phase 0 run-scope artifacts into typed persisted authority.

### Steps

1. Freeze WO source/revision/hash, codebase, canonical remote, base branch/SHA,
   worktree, engine, bundle, and workflow revision before mutation.
2. Store the exact WO bytes as an artifact used by every node.
3. Fail closed on missing canonical source unless an allowed fallback is explicit.
4. Reject authority drift; never guess a new base/source.
5. Make review, gate, manifest, and PR creation consume the same authority.

Commit: `feat(workflows): freeze run authority before mutation`

## Kernel 10: mechanical evidence, manifest, and truthful outcomes

### Governing WO

Reconcile with `WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01`; do not ship two
manifest implementations.

### Files

- Add: `packages/workflows/src/reliability/evidence-collector.ts`
- Add: `packages/workflows/src/reliability/evidence-collector.test.ts`
- Modify maintained lane manifest/tail nodes.
- Modify existing manifest fixture scripts under
  `.archon/workflows/defaults/__tests__/`.
- Modify server run response schemas to expose outcome dimensions.
- Modify web store/types only after API contract tests pass.

### Steps

1. Collect Git, GitHub, gate, scope, and stage facts mechanically.
2. Generate exact manifest-v2 labels from evidence.
3. Execute grep assertions before publication.
4. Ignore model-claimed PR URLs and file lists.
5. Persist reducer outcome and project existing status.
6. Prevent tail nodes from overwriting failed/indeterminate required gates.
7. Reproduce CE incident: failed execution plus ready PR remain separate facts.

Commit: `feat(workflows): derive outcomes and manifests from evidence`

## Kernel 11: integrate the conductor into dispatch

### Files

- Modify: `packages/smart-cauldron/src/types.ts`
- Modify: `packages/smart-cauldron/src/cascade.ts`
- Modify: `packages/smart-cauldron/src/poll.ts`
- Modify Smart Cauldron tests.
- Modify: `packages/server/src/routes/api.ts`
- Modify: `packages/server/src/routes/schemas/workflow.schemas.ts`
- Modify: `packages/server/src/routes/api.workflow-runs.test.ts`

### Steps

1. Replace file-only cascade attempts with durable attempt interfaces.
2. Stop swallowing poll transport errors as `null`.
3. Make dry-run return `planned`.
4. Add opt-in conductor request shape to the existing run endpoint.
5. Apply drain, authority, capability, and idempotency before fire.
6. Preserve explicit direct-lane dispatch when the feature flag is off.
7. Add API/CLI parity tests.
8. Do not enable any production entry point in this commit.

Commit: `feat(smart-cauldron): integrate durable conductor dispatch`

## Kernel 12: harden multi-stage lifecycle

### Files

- Modify: `packages/isolation/src/stage-allocator.ts`
- Add/modify stage allocator tests.
- Modify: `.archon/workflows/defaults/bdc-multi-stage-development.yaml`
- Modify multi-stage manifest/gate fixture tests.
- Regenerate bundled defaults.

### Steps

1. Give each stage its own authority, scope, attempts, evidence, and outcome.
2. Enforce General's readiness bar before stage N+1.
3. Preserve successful earlier-stage PRs when a later stage blocks.
4. Remove unsafe reset/adoption behavior.
5. Aggregate parent outcome with the pure reducer.
6. Prove N=1 regression, N=2 sequential gate, and N=4 dry fixture.
7. Prove BLOCKED cannot become REVIEW through a tail.

Commit: `fix(multistage): enforce authoritative stage lifecycle`

## Kernel 13: controlled failure-injection campaign

### Add test fixtures

- `packages/workflows/src/reliability/failure-injection.test.ts`
- `packages/smart-cauldron/src/__tests__/reliability-integration.test.ts`
- Server integration fixtures as needed.

### Required cases

1. Claude exhausted, Codex capable and healthy.
2. Codex exhausted, Claude capable and healthy.
3. All capable providers exhausted across process restart.
4. Zero-token contradiction without quota evidence.
5. Chat-only fallback rejected before dispatch.
6. Worker killed during implementation.
7. Worker killed during provider wait.
8. Cancellation racing due-wait claim.
9. Provider-internal failback in loop and non-loop nodes.
10. Terminal DB write failure.
11. Wrong base and legacy ASCII debt.
12. Fabricated PR URL.
13. Multi-stage predecessor blocked.
14. Worktree collision.
15. Drain with one active run.
16. Conductor dry run.

### Exit evidence

- Every case asserts persisted state after a fresh process reads it.
- No duplicate provider call or node execution.
- No test uses production credentials, repos, workflows, or services.
- Full proportional validation is green except documented unrelated baseline drift.

Commit: `test(harness): add Smart Cauldron failure injection matrix`

## Kernel 14: canary proof packet, no live fire

### File

- Add:
  `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-canary.md`

### Packet contents

1. Exact harmless WO and canonical repository.
2. Expected branch, files, diff, tests, PR base, and manifest.
3. Provider routes and injected/real availability expectations.
4. Observation commands for leases, attempts, waits, outcomes, and cascade trace.
5. Abort criteria before and during the canary.
6. Recovery commands that do not delete worktrees.
7. Drain/rebuild/restart requirements, each called out as separately gated.
8. Rollback flags.
9. Explicit statement: packet creation is not permission to fire.

Commit: `docs: add Smart Cauldron canary proof packet`

## Final completion audit

Before marking the goal complete, produce a requirement matrix covering:

- Truthful multidimensional outcomes
- Restart-safe interruption and recovery
- Drain mode
- Durable cancellable provider waits
- Capability-enforced routing
- Immutable repo/base/diff/spec authority
- Deterministic manifests and gates
- Safe multi-stage lifecycle
- Actual conductor integration
- Controlled failure injection
- Canary packet
- Original checkout/worktree preservation
- No unauthorized production action

For every row, cite a current file, focused test, broader verification command, and
commit. Missing, indirect, or environment-only evidence means the goal remains open.
