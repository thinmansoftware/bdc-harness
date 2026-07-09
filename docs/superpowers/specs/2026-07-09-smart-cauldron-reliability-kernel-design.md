# Smart Cauldron Reliability Kernel Design

Status: DRAFT FOR GENERAL REVIEW

Date: 2026-07-09

Repository: `bluedevilcollectibles/bdc-harness`

Authoring branch: `codex/smart-cauldron-reliability-design`

Design base: `origin/dev` at `b881cb6808e2db87688a5ca705b32e657fb231c8`

Decision requested: approve Approach B, an incremental reliability kernel around
the current engine. Approval of this document authorizes implementation planning,
not implementation, merge, rebuild, restart, workflow fire, or deployment.

## 1. Executive decision

Adopt Approach B: retain the current DAG executor, provider adapters, lane YAMLs,
Smart Cauldron cascade, and multi-stage wrapper, then add a small reliability
kernel that makes their state durable and their outcomes truthful.

Do not continue indefinite point patching as the main architecture. Do not rewrite
the engine. The kernel is an incremental control plane around proven execution
paths. It owns identity, leases, attempts, provider availability, run scope,
outcome reduction, and recovery. Existing components keep doing the work.

Three Phase 0 defects land before kernel work:

1. Preserve loop output whitespace across provider stream chunks.
2. Make shell counters in `assert-implement-produced-work` always produce one
   valid integer.
3. Make the ASCII autofix and gate inspect only the files changed by the run.

These are independent, narrow PRs. They are not queued behind this program.

## 2. Binding approval conditions

This design incorporates four non-negotiable conditions from John:

1. Phase 0 lands first. The three immediate defects above get their own focused
   tests and PRs before kernel implementation begins.
2. Extend prior art. Every kernel component maps to current `dev`, a merged PR,
   or an existing WO. An implementation plan must name the exact extension point
   before it may add a module or schema.
3. General approves this design before implementation planning or code begins.
   Approval to write this document is not approval to build it.
4. This program stays off the closure-day critical path. It runs in an isolated
   harness lane and cannot block product fires, PRH payment, `/terms`, theme
   submission, sales work, or other revenue closure work.

## 3. Safety and governance boundaries

- Work only from isolated worktrees based on a verified current `origin/dev`.
- Preserve the user's dirty harness checkout and every existing worktree.
- Never reset, clean, delete, overwrite, or adopt an existing worktree.
- Never fire a production WO to test this work without separate approval.
- Never merge, deploy, rebuild, restart a container, change branch protection,
  or mutate production as part of an implementation PR.
- Never print or persist secrets. Store provider identifiers and classifications,
  not credentials or raw authorization material.
- Use test-driven development for each behavior change.
- Stop before any action that can interrupt active runs or customer work.
- Treat failure injection and a canary as separate, explicitly approved stages.
- Keep Phase 0 PRs and kernel slices independently reviewable and reversible.

## 4. Evidence and problem statement

The 2026-07-09 event-store audit covered 265 runs since July 1:

| Terminal label | Count |
|---|---:|
| Completed | 100 |
| Failed | 123 |
| Cancelled | 41 |
| Still marked running | 1 |

The same audit found 401 `node_failed` events. Lane outcomes were uneven:

| Lane | Completed | Failed | Cancelled |
|---|---:|---:|---:|
| Codex | 78 | 28 | 18 |
| Fusion Qwen | 2 | 26 | 5 |
| Zero-open | 1 | 19 | 1 |
| Zero | 0 | 20 | 3 |

The count is diagnostic, not a permanent service-level baseline. It proves that
the current system conflates several different realities into `failed`, leaves
some interrupted work as `running`, and spends too much operator time deciding
what actually happened.

### 4.1 Incident ledger

| Incident | Observed truth | Architectural requirement |
|---|---|---|
| Run `02d9fa10`, CE reconcile | Run label failed, but PR #429 contained exactly the intended one-file workflow change. An ASCII gate evaluated unrelated legacy bytes and a promotion gate applied the wrong branch rule. | Separate execution, deliverable, and gate outcomes. Gates consume immutable run scope and target-branch authority. |
| Run `c1c9a14e`, Connect cookie | Last implement activity was immediately followed by a container restart. The DB remained `running`; the durable worktree retained useful uncommitted changes. | Durable lease and heartbeat, explicit `interrupted`, recovery from the preserved worktree, and drain mode before maintenance. |
| Run `42ee6575`, Fable loop | Provider output chunks were individually trimmed and concatenated, mashing signals and losing newlines. | Chunk-safe loop accumulation with final normalization only. |
| Usage exhaustion on `581f4543`, `faa25315`, and `d63993f9` | Claude-seat calls returned zero-token contradictory results. Runs failed or burned repair iterations. Current classification can also turn contradictions into long in-process sleeps. | Distinguish quota exhaustion from SDK contradiction. Persist waits, release workers, allow cancellation, and choose only capable fallback providers. |
| Fabricated PR #376/#379 citations | Model prose was treated as artifact truth. | PR and manifest evidence must be derived mechanically from Git and GitHub, never trusted from model output. |
| Wrong-base reviews and Rule 20 confusion | Review diffs and gates were sometimes computed against a guessed or lane-default base instead of the registered target base. | Capture canonical repo, base branch, and base SHA before mutation; all later diff consumers use the same authority record. |
| Three zombies and Fable process exit | Process lifetime was treated as run lifetime. | Run state must survive process exit and be reconciled on startup. |
| Multi-stage false REVIEW tail | A consolidated manifest could say BLOCKED while a later tail still labeled the WO REVIEW. | Final state is reduced from required stage outcomes; a tail cannot override a failed required gate. |
| Smart Cauldron not on normal fire paths | `runCascade()` is invoked by the Smart CLI, while normal dispatch paths bypass the conductor. | Make the conductor an explicit dispatch policy used by approved fire entry points, behind a rollout flag. |
| Terminal event/store divergence | Current completion and failure paths can continue to emit terminal events after terminal DB persistence reports an error. | Persist terminal truth idempotently before terminal publication; reconcile any status/event mismatch. |
| Provider failback hidden in prose | Executor-level failover has a structured event, while provider-internal Codex/GLM failback can be embedded in output or disappear on loop paths. | Normalize all provider route changes into the durable attempt ledger and one typed event contract. |
| Idle timeout reported as completion | The loop idle timeout can return a normal-looking iteration result and consume iterations instead of producing a typed progress outcome. | Timeout is a typed progress failure with cancellation evidence, never successful completion. |
| Nested retry layers | Provider retry, contradiction retry, node retry, quota recursion, failover, and loop iteration have no unified durable history. | One attempt ledger and explicit precedence make every provider call and retry reason visible. |

## 5. Design goals and measurable invariants

### 5.1 Goals

1. Report what happened without forcing an operator to reconstruct truth from
   prose logs.
2. Survive provider exhaustion, process exit, and planned restart without losing
   the run's state or worktree.
3. Route only to providers that can perform the node's required capabilities.
4. Use one immutable repository and diff authority for builders, reviewers,
   gates, manifests, and PR creation.
5. Produce manifests and artifact status from mechanical evidence.
6. Integrate Smart Cauldron routing into real dispatch without rewriting the DAG
   executor.
7. Preserve the existing single-repo build loop and wrap it safely for N stages.

### 5.2 Invariants

- A process exit cannot leave a run indefinitely `running` without a live lease.
- Every provider dispatch has a durable attempt row before the provider is called.
- A quota wait does not occupy a worker process or consume a loop iteration.
- A provider cannot be selected unless its capabilities satisfy the node contract.
- A zero-token SDK contradiction is never classified as quota exhaustion solely
  because its token count is zero.
- A gate cannot inspect files outside the run-scope manifest.
- A PR URL, base, head, mergeability value, CI result, and file list come from an
  API or Git command, not an LLM claim.
- `execution failed` and `deliverable ready` can both be true and are preserved as
  separate facts.
- A required stage failure prevents the aggregate workflow from becoming REVIEW.
- A dry run never returns a success outcome; it returns a distinct `planned`
  outcome.
- Provider failover is sideways for availability. Quality failure climbs. Lack of
  progress triggers a bounded interruption and then a policy decision.
- A terminal event is published only after the matching terminal state is durably
  persisted. Persistence failure remains non-terminal and retryable.
- Idle and wall timeouts are typed progress outcomes and can never be recorded as
  successful loop completion.
- Provider-internal and executor-level failover produce the same structured route
  evidence.

## 6. Non-goals

- Replacing the DAG executor.
- Building a model-driven router. The conductor remains deterministic rules.
- Removing human gates for deploys, customer sends, money movement, or production.
- Automatic merge as part of this program.
- Rebuilding the dashboard before the durable state exists.
- Cleaning legacy non-ASCII code that the current run did not change.
- Changing product repositories or closure-day product priorities.
- Running a production canary under implementation authority.

## 7. Prior-art inventory: extend, do not rebuild

| Capability | Current authority on `dev` or governing WO | Decision |
|---|---|---|
| Per-run cascade | PR #300, commit `767f2539`; `packages/smart-cauldron/src/cascade.ts` | Extend. Keep it as an outer wrapper. Replace file-only attempt recording with the durable attempt interface, then retain JSON export as a view if useful. |
| Deterministic conductor | `packages/smart-cauldron/src/conductor.ts` and `config/ruleset.config.json` | Extend. Add dispatch integration and capability-aware eligibility. Do not add a model call. |
| Node provider failover | Commit `5bf46c81` and failover fields in the workflow loader/executor | Extend. Reuse error classification and persona re-resolution. Add durable attempts, capability checks, and provider-health state. |
| Loop provider/model preservation | PR #298, commit `b7855efc` | Preserve. Add regression coverage to every loop-path change. |
| Loop mashed-signal handling and iteration timeout | PR #378, commit `b773bae1` | Extend only the remaining chunk-whitespace defect. Do not reimplement timeout handling. |
| Resource-exhaustion handling | Existing executor classification plus branch `fix/usage-exhaustion-pause`; WO-HARNESS-USAGE-EXHAUSTION-PAUSE-01 | Reconcile and extend. Keep verified classification patterns, remove in-process long sleep, persist `resume_at`, and split SDK contradiction from real quota exhaustion. |
| ESCALATED run status | PR #389, current `dev` commit `b881cb68` | Preserve as a compatibility projection. The kernel records the richer facts and maps them to existing UI status during migration. |
| Truth guards | PRs #380 and #382; commits `cea65158` and `ca31f220` | Extend. Reuse their checkpoint, PR-content, and deliverable-diff assertions in the outcome reducer. |
| Dispatch honesty | PR #351, commit `57408b71` | Extend. Drain rejection uses the same explicit rejection contract. |
| Drain mode | WO-HARNESS-DRAIN-MODE-01 | Implement as its own approved slice. Do not invent a second maintenance flag. |
| Durable worktrees | WO-HARNESS-DURABLE-WORKTREES-01 and `packages/isolation` worktree provider | Implement through the existing provider and configurable root. Do not change isolation semantics. |
| Orphan detection | `failOrphanedRuns()` exposed by `packages/core/src/workflows/store-adapter.ts` | Extend into startup reconciliation. Do not create a competing orphan scanner. Replace blanket failure with lease-aware interruption classification. |
| PR status and canonical base | WO-HARNESS-PR-STATUS-TRUTH-AND-AUTOMERGE-01 | Share the registry authority and artifact query code. Auto-merge remains outside this reliability program. |
| PR manifest autofill | WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01, status QUEUED | Implement or supersede explicitly with the mechanical evidence builder. Do not create two manifest formats. |
| Multi-stage pipeline | `.archon/workflows/defaults/bdc-multi-stage-development.yaml`, `packages/isolation/src/stage-allocator.ts`, and WO-CAULDRON-MULTI-STAGE-PIPELINE-01 | Harden. Preserve the orchestrator-over-single-stage design and General's C1-C8 corrections. |
| Existing pause/resume | Workflow store and run events already expose pause/resume behavior | Extend for provider waits and recovery. Do not create a parallel resume engine. |
| Provider capability declarations | Capability files already exist under `packages/providers/src/*/capabilities.ts` | Promote them into an enforced node-routing contract. Do not create a second provider registry. |

The implementation plan must refresh this table against current `origin/dev` and
open PRs immediately before each slice. If an existing WO or merged change fully
satisfies a slice, the slice is deleted rather than rebuilt.

## 8. Proposed architecture

The kernel is a set of small services and durable records at existing boundaries.
It is not a second executor.

```text
approved dispatch entry point
  -> dispatch policy (drain + idempotency + conductor)
  -> run authority (repo/base/scope + workflow identity)
  -> durable run and attempt ledger
  -> existing DAG executor
       -> provider policy (capabilities + health + failover/wait)
       -> existing provider adapters
       -> heartbeat/lease updates
       -> existing pause/resume
  -> mechanical evidence collector
  -> outcome reducer
  -> existing status/dashboard projections
  -> Smart Cauldron climb or stop decision
```

### 8.1 Durable run authority

Create one immutable authority record before any builder mutation:

| Field | Meaning |
|---|---|
| `run_id` | Existing workflow run ID. |
| `dispatch_id` | Idempotency key shared by retries of one operator request. |
| `wo_id` | Parsed and mechanically validated WO identifier. |
| `workflow_name` | Registered workflow selected for this attempt. |
| `codebase_id` | Existing codebase registry ID. |
| `canonical_remote` | Normalized owner/repo from the registry and verified worktree origin. |
| `base_branch` | Registry authority, never inferred from lane name. |
| `base_sha` | Fetched and resolved base branch SHA at dispatch. |
| `run_scope_sha` | Clean worktree HEAD captured immediately before the first mutating node. |
| `head_branch` | Deterministic run branch. |
| `worktree_path` | Durable provider-owned worktree path. |
| `workflow_revision` | Hash of the exact loaded workflow definition. |
| `created_at` | Durable creation time. |

The authority record is append-only. If remote, base, workflow revision, or
worktree identity changes, execution stops with an explicit authority conflict.
The system does not silently recalculate a more convenient base.

### 8.2 Multidimensional outcomes

Replace the single-status mental model with facts. Existing `status` remains a
projection during migration.

`execution_state`:

- `queued`
- `running`
- `waiting_provider`
- `paused_human`
- `interrupted`
- `completed`
- `failed`
- `cancelled`

`deliverable_state`:

- `none`
- `worktree_changes`
- `committed`
- `pushed`
- `pr_open`
- `pr_ready`

`validation_state`:

- `not_run`
- `passed`
- `failed`
- `indeterminate`

`recovery_state`:

- `not_needed`
- `recoverable`
- `recovering`
- `recovered`
- `abandoned_by_operator`

`route_state`:

- `current`
- `failed_over`
- `escalated`
- `spec_repair`
- `exhausted`

Each state change carries a reason code and evidence reference. Human-readable
messages are presentation, not the source of truth.

Example: CE reconcile becomes `execution_state=failed`,
`deliverable_state=pr_ready`, `validation_state=indeterminate` with reason
`gate_scope_mismatch`. The PR remains visibly good while the run's broken gate is
also visible. No fact is overwritten to force one red or green label.

### 8.3 Attempt ledger

Persist an attempt before every provider call or whole-lane cascade fire:

| Field | Meaning |
|---|---|
| `attempt_id` | Stable UUID. |
| `run_id` and `node_id` | Owning run and node. Whole-lane attempts use a reserved cascade node ID. |
| `attempt_number` | Monotonic within run/node. |
| `provider` and `model` | Requested route. |
| `declared_provider` and `declared_model` | Workflow authority used for served-vs-declared integrity. |
| `required_capabilities` | Frozen node contract. |
| `started_at`, `completed_at` | Attempt timing. |
| `served_model_id` | Actual served model, when returned. |
| `outcome_class` | `success`, `availability`, `quality`, `progress`, `quota`, `contradiction`, or `cancelled`. |
| `reason_code` | Stable machine-readable classifier output. |
| `resume_at` | Durable provider reset/retry time for quota waits. |
| `supersedes_attempt_id` | Link for retry, failover, or recovery. |

No raw secret, full auth error, or prompt body belongs in this table. Existing
events can retain redacted diagnostics.

Attempt handling follows one precedence order:

1. Fatal auth/config/authority error: stop for operator action.
2. Verified quota exhaustion: durable wait or capable independent fallback.
3. Availability error: bounded primary retry, then eligible failover.
4. Empty or contradictory result: exactly one evidence-rich same-provider retry.
5. Progress timeout: cancel the attempt and apply declared failover/climb policy.
6. Semantic or gate failure: node retry policy or Smart Cauldron quality climb.

A single total-attempt ceiling bounds the composition of these policies. Loop
iteration remains a workflow concept but every provider call within an iteration
still has an attempt ID.

### 8.4 Lease, heartbeat, interruption, and recovery

The worker obtains a time-bounded lease for a run. The lease contains owner ID,
acquisition time, expiry time, and last heartbeat. Heartbeats update through the
existing store, not an in-memory timer alone.

State transitions:

```text
queued -> running -> completed | failed | cancelled
                  -> waiting_provider -> queued
                  -> paused_human -> queued
                  -> interrupted -> recovering -> queued | failed | cancelled
```

Rules:

1. Startup reconciliation runs before new dispatch is accepted.
2. An expired lease with a non-terminal run becomes `interrupted`, not blindly
   `failed` and never left `running`.
3. Recovery verifies the authority record and preserved worktree before resume.
4. If the worktree exists and authority matches, recovery uses existing resume
   semantics and completed-node outputs.
5. If the worktree is missing, recovery records `worktree_missing`; it never
   pretends a clean refire is continuation.
6. A new worker may claim only an expired lease using compare-and-swap semantics.
7. Operator cancellation wins over a scheduled resume.
8. Recovery never commits, pushes, opens a PR, or deletes a worktree by itself.

`failOrphanedRuns()` is the extension point. Its behavior is migrated from blanket
failure to lease-aware reconciliation while preserving a compatibility wrapper for
callers until they move.

### 8.5 Drain mode

Implement WO-HARNESS-DRAIN-MODE-01 before restart recovery is trusted live:

- `normal`: accept new dispatch.
- `draining`: reject new dispatch honestly; existing runs continue.
- `drained`: computed view where mode is draining and active lease count is zero.

The flag is durable and operator-authenticated. It does not pause or cancel active
runs. Status reports active run IDs, lease freshness, and provider waits without
exposing secrets. Turning drain off is explicit and audited.

### 8.6 Provider capability and availability policy

The existing `ProviderCapabilities` contract remains the authority for SDK feature
support such as session resume, MCP, hooks, skills, sub-agents, tool restrictions,
structured output, environment injection, cost control, effort control, thinking,
fallback model, and sandbox behavior. Those flags are currently warnings in the DAG
executor. Promote applicable checks to enforced validation rather than duplicating
them.

Add a separate execution profile to `ProviderRegistration` for operational abilities
that the existing feature flags do not express. This distinction prevents a provider
that supports structured output but has no repository tools from being treated as a
builder. Each node declares required execution capabilities derived from node type,
persona, configured tools, and mutation policy:

- `text_generation`
- `repo_read`
- `repo_write`
- `shell`
- `network`
- `browser`

Requirements for `structuredOutput`, `sandbox`, `sessionResume`, and other existing
feature flags continue to use `ProviderCapabilities`; they are not copied into the
execution profile.

Each provider registration declares only abilities its current adapter and toolset
actually provide. Potential model abilities do not count. Routing evaluates both the
existing feature flags and the new execution profile before dispatch. A chat-only
provider cannot be a builder fallback. Persona resolution runs again for the selected
provider, as the existing node failover WO requires.

Provider outcomes have distinct responses:

| Class | Example | Response |
|---|---|---|
| Availability | timeout, connection failure, eligible 429/5xx | Persist attempt, fail over sideways to the next healthy capable provider. |
| Quota | verified usage exhausted with reset evidence | Persist `waiting_provider` with `resume_at`, or fail over to a capable provider with independent quota. Release the worker. |
| SDK contradiction | `isError=true`, zero tokens, `errorSubtype=success` without quota evidence | Persist `contradiction`, take one bounded evidence-rich retry, then fail over or escalate. Never sleep six hours. |
| Quality | Provider returned work and a hard gate rejected it | Climb according to Smart Cauldron. |
| Progress | No meaningful tool or output progress within configured bounds | Cancel the active provider attempt, persist evidence, then fail over or climb by policy. |
| Auth/config | Missing credential, invalid model, invalid persona | Stop with operator action required. Do not rotate providers blindly. |

Provider health is a short-lived policy input, not a permanent circuit breaker.
Successful probes or calls permit failback. Health updates never contain credential
values.

Provider-internal fallback must emit the same typed route-change data as
executor-level failover: from provider/model, to provider/model, attempt ID, and
reason code. Loop and non-loop paths consume this event identically. Bracketed prose
such as `[CODEX FAILBACK]` is presentation only and cannot be the evidence source.

### 8.7 Durable, cancellable provider waits

Remove long sleeps from the executor process. A quota wait performs these steps:

1. Classify using provider-specific evidence.
2. Complete the current attempt as `quota`.
3. Persist `execution_state=waiting_provider`, provider, reason, and `resume_at`.
4. Release the worker lease.
5. A scheduler queries due waits and atomically moves one to `queued`.
6. Re-evaluate capabilities and provider health at resume time.
7. Resume the same run and worktree through existing resume semantics.

Cancellation changes the run to `cancelled` and makes any due-wait claim fail.
Restart requires no timer reconstruction because the database is authoritative.

### 8.8 Run-scope manifest

The kernel produces one mechanical run-scope manifest after branch setup and before
the first mutating node:

```json
{
  "canonical_remote": "owner/repo",
  "base_branch": "release/ce",
  "base_sha": "<verified sha>",
  "run_scope_sha": "<clean pre-implementation sha>",
  "head_branch": "<run branch>",
  "workflow_revision": "<sha256>",
  "expected_paths": [".github/workflows/ce-change-scope-gate.yml"]
}
```

After work, a mechanical evidence collector adds actual changed paths from:

- committed difference from `run_scope_sha` to `HEAD`;
- unstaged difference from `HEAD`;
- untracked files reported by Git.

All scope-aware consumers use this list: ASCII autofix, ASCII gate, diff capture,
contract review, manifest generation, and PR content verification. A missing or
invalid scope manifest fails closed with `scope_authority_missing`. It does not fall
back to `HEAD~1` or a guessed default branch.

### 8.9 Mechanical evidence and outcome reducer

Build evidence from authoritative adapters:

- Git: base SHA, head SHA, commit list, changed files, cleanliness.
- GitHub: PR URL/number, base/head, mergeability, checks, review state.
- Workflow store: node outcomes, validator verdict, required gates, event timing.
- Scope manifest: authorized and actual paths.
- Stage ledger: required stage outcomes and handoff artifacts.

The reducer is a pure function. It receives evidence and returns the five outcome
dimensions plus reason codes. It never calls a model. It must support at least:

- execution succeeded, no deliverable required;
- execution succeeded, PR ready;
- execution failed, PR ready;
- execution succeeded, PR not ready;
- gate failed because work is bad;
- gate indeterminate because the gate evaluated the wrong scope;
- run interrupted with recoverable worktree;
- run escalated to a successor;
- run waiting on provider quota;
- required multi-stage predecessor failed.

Terminal persistence is idempotent and authoritative. The engine first persists the
terminal state and reducer output, then publishes terminal events/SSE. If persistence
fails, it records or logs `status_persist_failed`, retains a non-terminal recoverable
state, and retries. Startup reconciliation detects terminal-event/status mismatches
instead of accepting either side silently.

Existing dashboard labels are projections:

- `completed` only when the workflow's required completion contract is true;
- `escalated` when route state moved to a successor and the predecessor is not the
  winning deliverable;
- `failed` for terminal unrecovered execution failure;
- `cancelled` for explicit cancellation;
- new visible waiting/interrupted states when the UI supports them.

Projection cannot erase the underlying facts.

### 8.10 Deterministic manifest and gates

The PR manifest is produced after evidence collection in the exact manifest-v2
format used by the repository validator. Model output may supply explanatory notes,
but not authoritative file lists, command results, SHAs, PR IDs, or pass labels.

Rules:

1. `Files modified` and `Files created` come from Git name-status.
2. Tests include command, exit code, and captured evidence reference.
3. Grep assertions are executed before inclusion.
4. `VALIDATION: PASS` is emitted only when all required evidence is passed.
5. A failed or indeterminate gate cannot be overwritten by a later tail node.
6. PR body patching is idempotent and uses the actual PR returned by GitHub.
7. The final manifest is stored as an evidence artifact and patched into the PR.
8. Fabricated PR references in agent output are ignored.

This work must reconcile with WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01. That WO
is either implemented as the first manifest slice or explicitly superseded by an
approved plan; both cannot remain active implementations.

### 8.11 Conductor integration

Smart Cauldron is currently a CLI-driven wrapper. Integration adds a dispatch policy
at existing approved fire entry points:

1. Validate dispatch and drain state.
2. Resolve codebase/base authority.
3. Apply deterministic conductor rules.
4. Filter lanes/providers by required capabilities and current health.
5. Create the cascade and first attempt durably.
6. Call the existing fire path.
7. Reduce attempt evidence at terminal, interruption, or wait.
8. Win, fail over, wait, climb, or request spec repair.

Rollout is feature-flagged per entry point and defaults off. Direct lane fire remains
available for controlled rollback. Once parity tests prove identical explicit-lane
behavior, approved entry points can opt in one at a time. No hidden global switch.

Dry run returns `planned` with the selected route and reasons. It never returns
`won` because no gate ran.

### 8.12 Multi-stage safety

Preserve General's decision: multi-stage is an orchestrator over the existing
single-repo loop. Each stage gets its own authority record, worktree, attempt ledger,
scope manifest, PR evidence, and outcome. The parent holds ordered dependencies and
handoff artifacts.

Stage N+1 can begin only when all configured readiness facts for stage N are true.
The default required facts are build complete, tests green, adversarial review clean,
PR open, branch pushed, mergeability known and acceptable, and manifest valid.

Aggregate outcome is a pure reduction:

- all required stages ready -> parent ready;
- any required stage failed or indeterminate -> parent blocked;
- any stage interrupted or waiting -> parent non-terminal;
- cancellation -> pending stages never start.

The allocator may create only a new deterministic stage worktree or reattach to the
exact worktree recorded in authority. It may not hard reset, adopt an unrelated
directory, or delete a collision automatically.

## 9. Phase 0: immediate fixes before kernel work

Each item is test-first, its own PR, and may merge independently after review.

### 9.1 P0-A: preserve loop output across chunks

Defect:

`packages/workflows/src/dag-executor.ts` appends raw content to `fullOutput`, but
also calls `stripCompletionTags(msg.content, loop.until)` on each chunk and appends
the result to `cleanOutput`. `stripCompletionTags()` trims its input. Whitespace at
chunk boundaries disappears, so separate fields or fences become one mashed token.
PR #378 added signal handling and per-iteration timeouts but did not remove this
general chunk-trimming path.

Implementation sequence:

1. Add a failing executor test with the completion signal and surrounding fields
   split across multiple chunks, including chunks containing only newlines.
2. Add a failing test proving the final stored iteration output retains meaningful
   whitespace while completion tags are removed.
3. Accumulate raw chunks unchanged.
4. Derive cleaned output from the full accumulated buffer, or use a streaming
   normalizer that provably preserves boundaries; never trim each chunk.
5. Trim only at the final presentation boundary if the existing output contract
   requires it.
6. Keep PR #378 timeout and mashed-signal behavior unchanged.
7. Run focused executor tests, workflow typecheck, and full workflow tests.

Acceptance:

- Split `PLAN_REVIEW_PASS=true` and approved-plan fences are detected.
- `field1\nfield2` never becomes `field1field2` because of chunk boundaries.
- Timeout and cancellation tests from PR #378 remain green.

### 9.2 P0-B: make shell counters integer-safe

Defect:

Several lane scripts use patterns such as `grep -c . || echo 0`. When `grep -c`
prints `0` and exits non-zero, the fallback prints another `0`. Command substitution
then contains multiple lines and numeric tests can fail with an expression like
`[: 0` or `integer expression expected`. Some newer lane copies normalize digits,
but the duplicated scripts are not uniformly safe.

Implementation sequence:

1. Add shell fixture tests for zero, one, and multiple changed lines, plus failing
   Git commands.
2. Inventory every numeric counter used by `assert-implement-produced-work` and
   its checkpoint/salvage variants across all maintained default lanes.
3. Replace double-output fallbacks with one shared integer-safe shell idiom or
   helper that always emits exactly one base-10 integer.
4. Validate `CHANGED` and `AHEAD` before `-gt`; invalid output becomes an explicit
   node error, not an implicit zero.
5. Regenerate bundled workflow defaults from sources.
6. Run YAML loading tests, shell fixture tests, `check:bundled`, and bundled-skill
   verification.

Acceptance:

- Empty input yields exactly `0` followed by one newline.
- No maintained lane contains `grep -c . || echo 0` in a numeric assignment.
- A malformed counter fails with a named reason instead of misclassifying work.

### 9.3 P0-C: scope ASCII enforcement to this run

Defect:

The current gate tries to use `run-start-sha.txt`, then widens to merge-base or
`HEAD~1`. If branch/base changes occur after that anchor, endpoint diffing can include
legacy files the run never touched. That is how a correct one-file CE PR can be
reported failed because `importParser.ts` contained pre-existing non-ASCII bytes.

Implementation sequence:

1. Add a fixture repository where the target branch contains a legacy non-ASCII
   file and the run changes one unrelated ASCII file.
2. Add a failing test showing the current widened base includes the legacy file.
3. Capture a clean `run-scope-sha` after all branch selection/reconciliation and
   immediately before the first mutating implementation node.
4. Fail explicitly if the worktree is not clean when the scope anchor is captured.
5. Build the changed-file list from `run-scope-sha..HEAD`, unstaged changes, and
   untracked files. Store the list as an artifact.
6. Make both ASCII autofix and ASCII gate consume the same artifact.
7. Remove widening fallbacks from these two nodes. Missing scope authority is an
   explicit failure, not permission to scan a broader diff.
8. Apply the same source change to maintained lane templates and regenerate bundled
   defaults.
9. Run fixture tests, YAML load tests, `check:bundled`, and full workflow tests.

Acceptance:

- The legacy non-ASCII file is not scanned when untouched by the run.
- A non-ASCII byte introduced by the run fails the gate.
- A run that changes only `.github/workflows/ce-change-scope-gate.yml` reports that
  exact file as its gate scope.
- Autofix and gate lists are byte-for-byte identical.

## 10. Kernel delivery sequence after General approval

This is the dependency order for the later implementation plan. Each numbered slice
must be its own reviewable change unless General explicitly combines two adjacent
slices.

### Slice 1: contracts and reducer, no runtime routing change

1. Define reason codes, outcome dimensions, capability vocabulary, authority record,
   and attempt record as types and schemas.
2. Add pure reducer tests for all incident cases.
3. Add compatibility projection tests for existing status values.
4. Add terminal persistence ordering and reconciliation tests.
5. Add migrations without changing dispatch behavior.
6. Add read-only evidence collection adapters behind interfaces.

Exit: types, migration, and pure tests are green; runtime behavior is unchanged.

### Slice 2: durable attempts and served-vs-declared integrity

1. Persist attempts before provider calls.
2. Complete attempts on success/error/cancel.
3. Record requested, declared, and served model IDs.
4. Emit integrity reason codes on mismatch.
5. Normalize provider-internal and executor-level failover into one typed route event.
6. Apply and test the total-attempt ceiling and retry precedence.
7. Keep existing events for backward compatibility.

Exit: failure injection proves an attempt survives process exit after dispatch.

### Slice 3: lease and startup reconciliation

1. Add lease acquisition and compare-and-swap claim semantics.
2. Heartbeat active runs.
3. Replace blanket orphan failure with interruption classification.
4. Verify authority and worktree before recovery.
5. Resume through existing pause/resume.
6. Add idempotent startup reconciliation.

Exit: a killed test worker leaves one interrupted recoverable run, and a new worker
resumes it once without duplicate nodes.

### Slice 4: drain mode and durable worktree dependency

1. Implement WO-HARNESS-DRAIN-MODE-01 through existing authenticated endpoints.
2. Implement WO-HARNESS-DURABLE-WORKTREES-01 through the existing worktree provider.
3. Prove drain rejects new dispatch while leaving active runs unchanged.
4. Prove worktree contents survive a controlled test-process restart.

Exit: code-level and local integration evidence exists. Host mount or container
restart remains a separate John-approved operational change.

### Slice 5: provider policy and durable quota waits

1. Enforce provider capability eligibility.
2. Reconcile existing node failover with the durable attempt ledger.
3. Split quota, contradiction, availability, auth, progress, and quality classes.
4. Persist `waiting_provider` and `resume_at` instead of sleeping.
5. Add due-wait scheduler and cancellation race protection.
6. Make idle and wall timeouts typed progress failures, never completion.
7. Re-evaluate health/capability on wake and allow failback.

Exit: simulated Claude exhaustion continues through capable Codex when policy permits;
simulated exhaustion of all capable providers waits durably and resumes after restart.

### Slice 6: immutable authority and shared run scope

1. Create authority before mutation.
2. Enforce canonical repo/base/worktree identity.
3. Promote the Phase 0 scope artifact to the typed kernel record.
4. Move diff capture, reviews, gates, and PR creation to that authority.
5. Reject authority drift rather than guessing.

Exit: wrong-base and legacy-file fixtures cannot create false review or gate results.

### Slice 7: mechanical manifest and truthful outcomes

1. Reconcile the queued manifest-autofill WO.
2. Generate manifest-v2 from mechanical evidence.
3. Execute assertions before publication.
4. Query PR and CI truth.
5. Reduce and persist multidimensional outcomes.
6. Project them to current API/dashboard status.

Exit: the CE reconcile fixture reports failed execution plus ready PR without losing
either fact, and fabricated model citations have no effect.

### Slice 8: conductor integration

1. Add feature-flagged dispatch policy at one non-production entry point.
2. Route explicit lane requests unchanged.
3. Route conductor requests through durable cascade records.
4. Return a distinct dry-run result.
5. Add parity tests for CLI and API dispatch.
6. Expand only after each entry point passes controlled integration tests.

Exit: an approved fire path cannot bypass conductor policy when its flag is on, and
turning the flag off restores direct-lane behavior without data loss.

### Slice 9: multi-stage lifecycle hardening

1. Give every stage its own authority, attempt, scope, evidence, and outcome.
2. Enforce General's readiness gate before starting the next stage.
3. Remove unsafe allocator reset/adoption behavior.
4. Make aggregate status a pure reduction.
5. Add N=1 regression and N=2/N=4 controlled fixtures.

Exit: a blocked stage cannot become REVIEW through any tail path, and no unrelated
worktree can be adopted or reset.

### Slice 10: failure-injection campaign and canary packet

1. Run the failure matrix in local/CI environments only.
2. Capture evidence for every invariant.
3. Run migration rollback and feature-flag rollback tests.
4. Produce a canary packet naming the exact WO class, repo, expected files, abort
   criteria, observation commands, and recovery commands.
5. Request separate approval for any container rebuild, restart, or live fire.

Exit: General and John receive evidence. No production canary is implied.

## 11. Test and failure-injection matrix

| Scenario | Injection | Required proof |
|---|---|---|
| Chunk boundaries | Split signals, newlines, and tags across provider chunks | Exact final output and completion detection preserved. |
| Empty worktree counter | Zero Git status and zero commits | One integer `0`; no shell expression error. |
| Legacy ASCII debt | Non-ASCII ancestor file outside run scope | Gate ignores it; run-changed non-ASCII still fails. |
| Claude exhausted, Codex healthy | Provider-specific quota response | Capable Codex fallback continues same node/run where policy allows. |
| Codex exhausted, Claude healthy | Reverse quota response | Capable Claude fallback continues without consuming quality climb. |
| Both exhausted | Quota responses with future reset | Run becomes durable waiting, worker exits, restart retains wait, cancellation works. |
| Contradictory zero-token success | `isError=true`, zero tokens, subtype success, no quota evidence | One bounded contradiction retry; no long sleep; evidence persisted. |
| Chat-only fallback | Builder node plus provider lacking repo-write/shell | Route rejected before dispatch. |
| Process killed during implement | Terminate test worker after heartbeat and worktree write | Lease expires, run becomes interrupted/recoverable, next worker resumes once. |
| Process killed during provider wait | Terminate scheduler/worker | Due wait remains durable and is claimed once after restart. |
| Cancel races with wake | Cancel immediately before due claim | Cancelled wins; no provider call occurs. |
| Idle timeout | Stream produces no meaningful activity inside idle bound | Attempt is progress-failed and cancelled; iteration is not recorded completed. |
| Provider-internal failback | Adapter changes model/provider internally | Same typed route event and attempt link as executor failover on loop and non-loop nodes. |
| Terminal DB write fails | Inject failure before terminal persistence | No terminal SSE/event is published; reconciliation retries without duplicate execution. |
| Wrong registered base | Lane default conflicts with registry base | Registry wins or dispatch fails; no guessed diff. |
| Good PR with failed run tail | Mock exact CE incident | Both facts persist; operator action recommends PR review, not code repair. |
| Fabricated PR URL | Model emits nonexistent PR | Mechanical evidence reports no PR. |
| Multi-stage predecessor blocked | Stage 1 manifest blocked | Stage 2 never starts; parent cannot become REVIEW. |
| Worktree collision | Expected path exists with different authority | Fail closed; no reset, adoption, or deletion. |
| Drain mode | Enable drain with one active run | New dispatch rejected, active run unaffected, count reaches zero. |
| Dry run | Conductor selection only | Outcome is planned, no run/attempt provider call, no success claim. |

## 12. Verification ladder for every implementation slice

1. Failing focused test committed or captured before production code.
2. Focused unit tests.
3. Package typecheck.
4. Package test suite.
5. Workflow YAML loader and shell fixtures when lane files change.
6. `bun run generate:bundled` when default workflows change.
7. `bun run check:bundled` and `bun run check:bundled-skill`.
8. Repository typecheck, lint, format check, and full test suite as proportional to
   the slice.
9. `git diff --check` and ASCII scan of changed script/code files.
10. Adversarial review against the exact authority diff.
11. Local commit only until publication is separately authorized.

Tests do not prove a provider or restart behavior unless they inject the relevant
failure and assert the persisted state after a new process reads it.

## 13. Rollout and rollback

### 13.1 Rollout

- Schema additions are backward compatible before writers switch.
- New writers dual-emit existing events and new records during migration.
- Outcome projection preserves existing API values until consumers migrate.
- Conductor integration is opt-in per dispatch entry point.
- Durable waiting is enabled per provider only after its classifier fixtures pass.
- Recovery begins in observe-only mode: report stale leases without claiming them.
- Automatic claim is enabled only after controlled process-kill tests pass.

### 13.2 Rollback

- Disable conductor integration flag to restore direct-lane dispatch.
- Disable automatic recovery while retaining records and manual resume.
- Disable durable wait scheduling while retaining explicit waiting state.
- Keep additive schema during rollback; do not drop evidence under incident pressure.
- Restore old status projection without deleting multidimensional outcomes.
- Never roll back by deleting worktrees or run records.

Operational rollback that needs a rebuild or restart requires separate approval and
drain evidence.

## 14. Observability and operator contract

Every run view must answer these questions without log archaeology:

1. Is execution active, waiting, interrupted, or terminal?
2. Is there useful work in the worktree, a commit, a push, or a PR?
3. Which gate passed, failed, or was indeterminate, and on what exact scope?
4. Which provider/model was declared, requested, and served?
5. Is the run eligible to recover, and what authority was verified?
6. Is Smart Cauldron waiting, failing over, climbing, or requesting spec repair?
7. What operator action is safe now?

Recommended operator actions are deterministic mappings from reason codes. A model
may summarize them, but cannot invent the state.

## 15. Closure-day isolation

- No product repo is modified by design or kernel implementation work.
- No active product run is used as a test subject.
- No harness rebuild/restart is requested on a closure day.
- Phase 0 and kernel slices can pause without affecting product work.
- Product fires may continue through current approved lanes while development occurs.
- Any incident requiring immediate product work preempts this program.

## 16. Decisions requested from General

General should approve or amend these concrete defaults:

1. Approve Approach B and reject both indefinite point-patching and a rewrite.
2. Approve additive normalized tables for run authority, leases, attempts, outcomes,
   and scheduled waits, with existing events retained during migration.
3. Approve the existing codebase registry as base-branch authority. Lane YAML may
   request a base but cannot override the registered project contract.
4. Approve database-backed due-wait scheduling through existing server lifecycle,
   not long process sleeps and not a new external queue in v1.
5. Approve observe-only recovery before automatic lease claims.
6. Approve per-entry-point feature flags for conductor integration.
7. Approve the five outcome dimensions while retaining current status as a projection.
8. Approve the Phase 0 sequence before all kernel slices.
9. Confirm that WO-HARNESS-CAULDRON-PR-MANIFEST-AUTOFILL-01 will be implemented as
   the manifest slice or formally superseded, never duplicated.
10. Confirm that implementation planning may begin only after an explicit General
    approval record references this document revision.

If General rejects a default, the amended decision must name the replacement
authority and invariant. Implementation cannot resolve architecture by guessing.

## 17. General review packet checklist

- [ ] Approach and non-goals are explicit.
- [ ] Phase 0 is independent and first.
- [ ] Every major component maps to prior art.
- [ ] No existing worktree or dirty checkout is at risk.
- [ ] Provider outage and usage exhaustion are distinct from quality failure.
- [ ] Restart recovery is lease-based and worktree-preserving.
- [ ] Repo/base/diff authority is immutable.
- [ ] Manifests and PR truth are mechanical.
- [ ] Multi-stage remains a wrapper over the proven single-stage loop.
- [ ] Conductor integration is feature-flagged and reversible.
- [ ] Production fire, rebuild, restart, merge, and deploy remain separately gated.
- [ ] Closure-day work is not blocked.

## 18. Stop point

After this document is self-reviewed and committed locally, stop. Do not write the
implementation plan and do not modify runtime code until General explicitly approves
the document revision. The next artifact after approval is a file-by-file,
test-by-test implementation plan that refreshes prior art and splits the work into
the Phase 0 PRs and kernel slices above.
