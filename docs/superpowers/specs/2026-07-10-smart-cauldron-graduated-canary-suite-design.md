# Smart Cauldron Graduated Canary Suite Design

Date: 2026-07-10
Status: design approved in chat; written specification pending John review
Target repositories: `bdc-harness` (runner and evidence) and `BDC_XO` (Duty Officer briefing input)
Base implementation: `fc052c682ea3ed5125ac22b9c2227f36093a2bce`

## 1. Objective

Provide one repeatable canary suite that can test every Smart Cauldron lane from
non-mutating contract checks through isolated production fault recovery, while
keeping customer systems, deployments, merges, credentials, and the Hetzner
container outside the canary blast radius.

## 2. Approved decisions

John approved these design choices in chat on 2026-07-10:

- Use a graduated difficulty suite rather than one ad hoc canary.
- The highest level is isolated production chaos: real provider/node failure and
  recovery behavior may be exercised, but no customer data or container restart.
- Use a hybrid schedule: low levels run nightly; higher levels require a recorded,
  current approval from the named authority in Section 11.1.
- Canary results feed the daily briefing owned by the Duty Officer.
- The Duty Officer summarizes results; mechanical evidence and gates determine the
  verdict.

## 3. Existing prior art and disposition

This design extends existing paths rather than creating a second harness.

| Existing artifact | Current truth | Disposition |
|---|---|---|
| `docs/architecture/smart-cauldron.md` | Defines cost-aware routing, role seats, three failure classes, input gating, and hard validation | Governing behavior source |
| `docs/superpowers/plans/2026-07-09-smart-cauldron-reliability-canary.md` | Defines one review-only, one-file canary and strict evidence/abort rules; explicitly did not create or fire its WO | Reuse evidence chain and abort rules |
| `packages/workflows/src/reliability/failure-injection.test.ts` | Offline coverage for failover, quota wait, cancellation race, recoverable interruption, false PR evidence, and stage blocking | Reuse classifiers and fixture vocabulary; do not treat as live proof |
| `docs/canary/zero-open-lane-canary-01.md`, `fusion-lane-canary-01.md`, and `qwen-lane-canary-01.md` | Historical result artifacts, not a reusable runner | Preserve as history; do not extend as execution code |
| `BDC_XO/docs/work-orders/WO-CAULDRON-RECOVERY-CANARY-01.md` | Prior approved design for a disposable canary command, but `fire-canary.ps1` and its target file do not exist | Reconcile or supersede through normal WO governance before implementation |
| `BDC_XO/docs/behavior-specs/CAPTAIN_CI_CANARY_SET_BEHAVIOR.md` | Established synthetic identity, cleanup, evidence, and side-effect containment rules | Reuse safety doctrine where applicable |
| `~/.claude/scheduled-tasks/morning-ops-brief/SKILL.md` | Existing morning brief task, currently written for XO and has no Cauldron canary section | Extend through the Command Restructuring plan so the Duty Officer consumes the new report |

Oracle search found older ShopOps canary-runner and protected-preview patterns but
no existing graduated Smart Cauldron lane suite. Oracle is incomplete, so repository
artifacts above remain the implementation authority.

## 4. Non-goals

The suite does not:

- merge a canary PR;
- deploy or rebuild any service;
- restart the Hetzner container or kill the Archon process;
- change credentials, auth configuration, branch protection, or provider quotas;
- access customer repositories, tenants, records, or communication channels;
- delete canary branches or worktrees automatically;
- make an LLM the authority for pass/fail;
- claim SMS or email alert fanout before the notification router exists;
- activate Sol or Fable workers merely by installing the suite.

## 5. Lane inventory

The suite discovers the live registry but requires these eight declared lanes at
the reviewed bundle revision:

1. `bdc-feature-development-zero-open`
2. `bdc-feature-development-zero`
3. `bdc-feature-development-fusion-cx-qwen`
4. `bdc-feature-development-codex-only`
5. `bdc-feature-development-codex`
6. `bdc-feature-development`
7. `bdc-feature-development-fable`
8. `bdc-multi-stage-development`

The order is a default cost/complexity rotation, not a quality ranking. A missing,
renamed, duplicated, or unexpectedly registered lane fails Level 0 and blocks live
levels for that lane. The suite never substitutes a similarly named workflow.

## 6. Architecture decision

Use an external, manifest-driven runner rather than one script per lane or a
Cauldron workflow that judges itself.

```text
authorized executor or nightly scheduler
  -> independent canary runner
       -> validate suite manifest and reviewed bundle revision
       -> create durable canary plan
       -> call authenticated Archon API
       -> observe Archon run/authority/attempt/outcome evidence
       -> observe Git and GitHub deliverable evidence
       -> reduce one mechanical verdict
       -> write JSON + Markdown report
  -> Duty Officer daily briefing reader
```

The runner is independent in the sense that it does not execute inside the DAG it
is judging. It may ship from the same repository and host, but it calls public
service boundaries and reduces persisted evidence after the tested run completes.

### 6.1 Proposed code boundaries

- `packages/canary-suite/`: runner, manifest parser, scenario executors, evidence
  reducer, CLI, and report writers.
- `.archon/canaries/smart-cauldron.yaml`: reviewed lane/scenario catalog, schedules,
  budgets, standing WO references, and allowed paths.
- `packages/server/`: authenticated canary plan/status/report endpoints and narrow
  run-scoped fault hooks.
- `packages/core/`: durable canary plan, run, and one-shot fault-consumption records
  for SQLite and PostgreSQL.
- `packages/canary-fixture/`: inert fixture used only by Levels 3 and 4. It has no
  runtime dependency from Archon or customer systems.
- `harness-artifacts/canaries/<suite-run-id>/`: immutable JSON and Markdown evidence
  reports on the production host.
- `BDC_XO` Duty Officer briefing task: read-only ingestion of the daily report.

The implementation plan may adjust exact filenames after source inspection, but it
must preserve these ownership boundaries.

## 7. Difficulty model

### Level 0: contract

Purpose: prove the expected harness is loaded before spending a provider call.

Checks:

- all eight lane names are registered exactly once;
- live engine, image, workflow bundle, and workflow definition revisions are known;
- every provider/model declaration resolves;
- required execution capabilities are satisfied for every mutating node;
- standing canary WOs and allowed paths resolve;
- drain state, active work count, and GitHub auth status are readable;
- no provider call, branch, worktree, PR, or source mutation occurs.

Schedule: all lanes nightly and before any higher level.

### Level 1: route

Purpose: prove deterministic routing, authority, and idempotency without firing a
workflow provider.

Checks:

- conductor entry selection for the scenario;
- explicit direct-lane selection for each lane;
- complete dispatch identity and immutable authority preview;
- repeated identical dry run returns the same planned record;
- reused idempotency key with changed identity fails closed;
- no workflow run, provider attempt, branch, worktree, push, or PR appears.

Schedule: all lanes nightly and before any live level.

### Level 2: smoke

Purpose: prove a complete lane can plan, build, review, verify, push, and open a real
draft PR without changing product code.

Payload: one standing, lifecycle-approved canary WO that creates one exact ASCII
Markdown path under `docs/canary/runtime/`. The path is absent from `dev`, fixed in
the WO, and reused across fresh unmerged branches. Runs are strictly sequential.

Success requires:

- one dispatch, run authority, worktree, branch, provider attempt chain, and PR;
- exact one-file diff;
- correct frozen base ancestry;
- real requested, declared, and served model evidence;
- all required gates pass;
- outcome is execution `completed`, deliverable `pr_ready`, validation `passed`;
- lease released and no scheduled wait remains claimable;
- draft PR is labeled `canary` and closed only after evidence capture;
- branch and worktree remain available for a bounded retention window.

Schedule: one rotating lane nightly. All eight lanes receive a Level 2 run within
eight nights. Manual `--all-lanes` runs the sequence, never in parallel.

### Level 3: functional

Purpose: prove a lane can make a small multi-file change and satisfy deterministic
tests without touching the engine.

Payload: one standing, lifecycle-approved WO that modifies only the inert
`packages/canary-fixture/` input and test expectation. The fixture exposes a trivial,
fully specified transformation and exact test command.

Success adds these Level 2 requirements:

- exact two-file allowlist;
- test fails against the unimplemented fixture state and passes after the change;
- no package outside the fixture changes;
- test evidence contains command, exit code, and captured output reference.

Schedule: manual only.

### Level 4: adversarial repair

Purpose: prove rejection and repair loops, not merely first-pass completion.

The runner attaches a durable one-shot `gate_reject_once` profile to the authorized
canary run. After the initial build, the canary gate returns a synthetic, clearly
labeled finding exactly once. The repair node must execute, produce new evidence,
and converge on the next real gate evaluation.

The injected rejection tests workflow control flow; it is never represented as a
real code defect. The final verdict reports both `injected_gate_rejection` and the
actual post-repair gate evidence.

Schedule: manual only.

### Level 5: isolated production chaos

Purpose: prove real recovery decisions through production executor paths without
restarting the service or affecting a non-canary run.

Approved profiles:

- `availability_once`: inject one typed availability failure before one provider
  call and prove eligible sideways failover.
- `quota_once`: inject one typed quota outcome and prove independent capable
  failover or durable `waiting_provider` behavior.
- `progress_timeout_once`: apply a canary-only bounded progress timeout to one node,
  cancel that attempt, and prove failover or climb.
- `run_task_interrupt_once`: interrupt only the canary run task, preserve its
  worktree, and prove reconciliation/resume without process exit.
- `repair_lease_expiry_once`: suppress only the canary repair owner's heartbeat and
  prove a higher fencing token takeover.

`repair_lease_expiry_once` is BLOCKED, not simulated, unless two real supervisor
workers are registered and healthy. It must prove actual Sol/Fable observations,
lease ownership, takeover, stale-token rejection, and one finalized action.

Schedule: manual only, one profile and one lane per explicit execution.

## 8. Standing WO strategy

Levels 2 through 5 require frozen, approved instructions. The implementation must
not manufacture a new WO every night.

Use three standing canary WOs:

1. Level 2 one-file smoke contract.
2. Level 3 two-file functional fixture contract.
3. Level 4 repair-loop contract; Level 5 reuses Level 2 or 3 based on the profile.

Each WO is authored through `WO-Lifecycle`, validated against all 12 gates, recorded
in Notion, and materialized as a GitHub issue whose body is the exact authority
fallback. The manifest records both identifiers and the expected body hash. A drift
between Notion, GitHub, and the configured hash blocks live execution.

No canary WO may authorize deployment, merge, branch deletion, credential access,
customer data, arbitrary file selection, or a path outside the canary allowlists.

## 9. Manifest contract

The suite manifest is versioned and schema-validated. Each scenario declares:

| Field | Constraint |
|---|---|
| `schema_version` | Exact supported integer; initial version is `1` |
| `scenario_id` | Unique stable ASCII identifier |
| `level` | Integer from `0` through `5` |
| `allowed_environment` | Exact environment identity; production value is `hetzner-production` |
| `project` | Exact codebase registry key `bdc-harness` for live levels |
| `canonical_remote` | Exact `bluedevilcollectibles/bdc-harness` |
| `base_branch` | Exact `dev` |
| `workflow_names` | Non-empty exact lane allowlist |
| `wo_issue`, `wo_id`, `wo_body_hash` | Required for Levels 2 through 5; must match approved authority |
| `allowed_paths` | Non-empty exact allowlist for every mutating level |
| `expected_deliverable` | `none` or `pr_ready` as fixed by level |
| `max_runtime_seconds` | Positive and no greater than the global 7,200-second ceiling |
| `max_provider_attempts` | Positive for live levels and no greater than the global 50-attempt ceiling |
| `fault_profile` | `none` below Level 4; one approved profile at Levels 4 or 5 |
| `schedule` | `nightly`, `rotating-nightly`, or `manual` as fixed by level |

Exact WO identifiers and lower per-scenario budgets are written only after WO
approval and deterministic timing evidence. Missing values never inherit defaults
for a live scenario.

## 10. Durable canary authority and fault safety

Add durable records for the canary plan/run and one-shot fault consumption. The
record must bind:

- suite run ID and scenario ID;
- environment, engine SHA, image revision, and bundle revision;
- lane, dispatch ID, workflow run ID, WO ID, issue revision, and body hash;
- canonical repository, base branch/SHA, worktree, branch, and allowed paths;
- difficulty, fault profile, expiry, attempt budget, and runtime budget;
- executor identity and approval record available from the authenticated request;
- planned, running, passed, failed, aborted, or blocked state;
- evidence references and report paths.

Fault injection is disabled by default. A fault hook may activate only when all of
these are true:

1. `ARCHON_CANARY_CONTROL_ENABLED` is exactly `true`.
2. The request used the authenticated canary administration endpoint.
3. A non-expired canary plan exists and is bound to the exact dispatch/run.
4. Repository is `bluedevilcollectibles/bdc-harness` and base is `dev`.
5. WO and allowed paths match the reviewed manifest.
6. The fault profile is valid for the requested level.
7. The one-shot fault has not already been consumed.

The check and consumption are one database transaction using database time on both
SQLite and PostgreSQL. Failure to prove any predicate fails closed without injecting
a fault. A normal workflow cannot opt itself into canary mode through prompt text,
branch name, labels, or model output.

## 11. Execution and approval flow

Levels 0 through 2 scheduled runs use pre-approved manifest entries and the service
scheduler. Levels 3 through 5 require an approval-scoped executor plan.

For Level 5:

1. `canary plan` performs only read-only checks and returns a plan ID.
2. The plan displays exact lane, provider boundary, fault, budgets, WO, repository,
   base SHA, and abort behavior.
3. Execution requires the current phrase `PROCEED CANARY CHAOS <plan-id>` through
   the authenticated canary command after the required approval is recorded.
4. The approval expires and cannot be reused for another plan, lane, or profile.
5. The runner acquires a global canary lock and verifies zero other active canary.
6. Every abort leaves evidence intact and blocks the next live scenario.

Canary plans expire after ten minutes if execution has not started. A Level 5
approval expires after fifteen minutes. Once a run starts, its manifest runtime and
attempt budgets apply, subject to the 7,200-second and 50-attempt global ceilings.

No approval for one level, lane, or plan authorizes another.

### 11.1 Named approval authorities

`Operator` is not an approval role. The executor carries an already authorized
action and records evidence. Approval authority is one of these named sources:

| Action | Required authority |
|---|---|
| Author and implement the suite through the normal WO/PR pipeline | Current board/work-order governance |
| Activate the bounded nightly Level 0 through Level 2 schedule | Recorded 2/3 board motion with John veto/freeze retained |
| Execute a manual Level 3 or Level 4 production canary | Recorded 2/3 board REWORK or PRIORITY motion naming level, lane, scenario, and plan ID |
| Execute a Level 5 production-chaos plan | Recorded 2/3 board REWORK motion naming lane, profile, plan ID, budgets, and rollback; if any seat flags it as a major change, John Ranson must approve under Reserved Power 2 |
| Delete retained branches, worktrees, artifacts, database records, volumes, or containers | John Ranson only under Reserved Power 1 |
| Change credentials, perform a deploy/restart/merge, spend money, or send to a real customer | Outside this suite; abort and use the separately governing John/board process |

During the active 48-hour POC, the authority source is
`BDC_XO/docs/board/CHARTER.md`. John retains veto and freeze throughout. After the
POC expires, the runner must resolve and record the then-current ratified governance
artifact. If no current artifact unambiguously authorizes the action, approval
defaults to John Ranson rather than inferring standing authority.

One carried motion may authorize the precisely bounded nightly schedule; it does
not authorize manual Levels 3 through 5. Each Level 5 plan always requires its own
current motion and phrase.

## 12. Evidence reducer and verdicts

The runner consumes existing authoritative records:

- run authority;
- run lease and heartbeats;
- provider attempts, declared/requested/served model, and reason codes;
- scheduled waits;
- multidimensional outcome;
- supervisor incidents, observations, leases, actions, and fencing tokens;
- workflow events;
- Git branch, worktree, diff, and ancestry;
- GitHub PR identity, files, state, checks, and labels.

Verdicts are `passed`, `failed`, `aborted`, or `blocked`.

- `failed`: the tested behavior ran and contradicted an expectation.
- `aborted`: safety or authority was lost during execution.
- `blocked`: a prerequisite was unavailable before mutation, including missing
  supervisor activation for takeover tests.

Models may add a summary but cannot alter the verdict, evidence list, or safe next
action mapping.

## 13. Scheduling and concurrency

Nightly schedule:

- Level 0: all eight lanes.
- Level 1: all eight lanes.
- Level 2: one lane selected by oldest successful coverage timestamp.

Level 2 coverage age is measured from the last mechanically successful Level 2 run;
a skipped or failed night does not reset it. The expected maximum is eight calendar
days. Age nine or ten days is `coverage_warning`. Age greater than ten days is a red
`lane_coverage_starved` row that leads the Duty Officer canary section and recommends
a manual run at the next safe window. Red status does not bypass any skip or safety
gate. When more than one lane is red, the oldest successful coverage timestamp wins.

The scheduler skips rather than queues a live Level 2 when:

- Cauldron is draining;
- any non-canary production workflow is active;
- another canary is active;
- GitHub auth is unhealthy;
- the previous canary left an unresolved safety abort;
- the reviewed engine or bundle revision changed after planning.

Only one live canary may exist at a time. Levels 0 and 1 may inspect lanes in
parallel only if their implementation remains read-only; the first implementation
should stay sequential for simpler evidence.

## 14. Pull request and retention policy

- Canary PRs are always draft, target `dev`, and carry a `canary` label.
- The suite captures PR identity and checks before closure.
- A passing canary PR is closed, never merged.
- A failed or aborted PR remains open for executor and approver inspection.
- Branches, worktrees, and reports remain for a configured retention window.
- Cleanup reports candidates but does not delete branches or worktrees automatically.
- Retention cleanup is a separately approved John Ranson action because it deletes
  retained evidence.

## 15. Duty Officer briefing contract

The canary runner writes one machine-readable daily summary. The Duty Officer reads
that summary and adds a `Smart Cauldron Canary Health` section to the daily briefing.

Required fields:

- report date and observation window;
- engine/image/bundle revisions;
- Level 0 and Level 1 results for every lane;
- rotating Level 2 lane, run ID, PR, and verdict;
- last successful Level 2 date and coverage age for every lane;
- declared/requested/served provider and model;
- failover, wait, interruption, repair, or takeover events;
- unresolved failed, aborted, or blocked scenarios;
- deterministic safe next action and evidence references.

Presentation rules:

- all green: one compact line plus coverage age;
- any red/aborted: lead the canary section with the affected lane and safe action;
- blocked: distinguish missing prerequisite from product failure;
- no report or stale report: state `CANARY VISIBILITY STALE`; never assume green;
- the Duty Officer does not rewrite or override the mechanical verdict.

The existing `morning-ops-brief` task is currently an XO task and has no canary
input. The Command Restructuring implementation must transfer or expose this section
to the Duty Officer. Until that happens, the report exists but daily delivery is not
claimed complete.

Duty Officer ingestion is part of the suite, not an optional follow-up. Manual
shadow runs may prove Levels 0 through 2 before ingestion lands, but the hybrid
nightly schedule cannot be activated until the Duty Officer parser is installed,
its missing/stale behavior passes, and two consecutive report fixtures appear
correctly in briefing previews.

Immediate SMS/email/Telegram fanout is outside this suite. It becomes a consumer of
the same report/incident records when the notification router is implemented.

## 16. Abort rules

Abort before mutation when:

- authority, spec hash, base SHA, engine, image, bundle, or lane identity is unknown;
- a path is outside the scenario allowlist;
- a provider lacks required execution capabilities;
- another live canary or conflicting workflow exists;
- the plan or approval expired;
- the run target is not the canonical bdc-harness repository;
- the environment does not equal the manifest environment.

Abort during execution when:

- a fault affects or references a non-canary run;
- duplicate dispatch, attempt number, mutation, branch, or PR appears;
- the stale lease holder performs a side effect;
- the diff contains an unexpected path;
- PR identity disagrees with run authority;
- an indeterminate or failed gate projects completion;
- runtime or provider-attempt budget is exceeded;
- a deploy, restart, merge, credential operation, customer access, or destructive
  cleanup is attempted.

On abort, stop new canary dispatch, preserve all evidence, close no PR, delete
nothing, and surface the deterministic safe next action.

## 17. Testing strategy

Implementation requires:

- manifest schema and invalid-config tests;
- runner unit tests with fake API/Git/GitHub adapters;
- reducer table tests for every expected verdict;
- SQLite and PostgreSQL transaction tests for one-shot fault consumption;
- authentication and cross-run/cross-repo rejection tests;
- property tests showing normal runs can never activate a fault hook;
- dry-run integration proving no workflow/provider/branch/PR mutation;
- Level 2 hermetic end-to-end using a local Git remote and fake GitHub adapter;
- Level 3 exact-scope and test-evidence integration;
- Level 4 one-shot rejection and repair convergence integration;
- Level 5 controlled fixtures for each profile before any production canary;
- Duty Officer report parser tests for green, red, blocked, missing, and stale input;
- changed code/script ASCII scan, type-check, lint, formatting, bundled checks, and
  full workspace tests.

No live production Level 5 run is a substitute for deterministic tests.

## 18. Delivery slices

1. Contracts, manifest schema, reducer, and CLI plan output; no live mutation.
2. Level 0 and Level 1 read-only execution for all lanes.
3. Standing WO reconciliation plus Level 2 runner and draft-PR evidence.
4. Inert fixture plus Level 3 functional scenario.
5. Durable canary authority and one-shot fault controls, default disabled.
6. Level 4 adversarial repair scenario.
7. Level 5 profiles except supervisor takeover.
8. Real supervisor takeover after Sol and Fable workers are independently active.
9. Nightly scheduler, retention reporting, and completion-critical Duty Officer
   briefing ingestion.
10. Shadow period, controlled production canaries, and separate activation review.

Each slice is independently reviewable and defaults live mutation off.

## 19. Rollout and rollback

Rollout:

1. Merge code with scheduling and fault control disabled.
2. Run all deterministic tests.
3. Enable Level 0 only and observe two nights.
4. Enable Level 1 and observe two nights.
5. Approve one Level 2 run on the first configured rotation lane, initially
   `bdc-feature-development-zero-open`.
6. Rotate Level 2 through all lanes.
7. Run Levels 3 and 4 manually.
8. Enable one Level 5 profile at a time after explicit plan approval.
9. Activate the nightly hybrid schedule through the named board authority only after
   the shadow record is clean and two Duty Officer briefing previews consume the
   report correctly.

Rollback:

- disable the scheduler;
- set `ARCHON_CANARY_CONTROL_ENABLED` to a value other than exact `true`;
- reject new canary plans while retaining all records and artifacts;
- do not delete existing worktrees, branches, PRs, or evidence;
- direct workflow fires and existing Smart Cauldron behavior remain unchanged.

## 20. Completion bar

The suite is complete only when:

- all eight lanes pass Levels 0 and 1;
- all eight lanes have a mechanically verified Level 2 run;
- Levels 3 and 4 pass at least once on a representative non-frontier lane and one
  frontier lane;
- every enabled Level 5 profile has deterministic tests and one approved live proof;
- no fault hook can activate for a normal run;
- the daily report is generated and the Duty Officer briefing parser reproduces its
  verdict without alteration;
- Level 2 coverage warnings and the greater-than-ten-day starvation state appear in
  the briefing exactly as reduced;
- missing/stale reporting fails visible, not green;
- rollback disables scheduling and injection without deleting evidence;
- no customer, deployment, merge, restart, credential, or destructive action occurs.

## 21. Known dependency gates

- Real `repair_lease_expiry_once` requires two active supervisor workers; PR #390
  supplies coordination primitives but does not start those workers.
- Immediate multi-channel alerting requires the separate notification router.
- The existing run-lease database-clock follow-up remains required before claiming
  full dual-execution resistance below the supervisor layer.
- Standing canary WOs require separate WO-Lifecycle validation and board/issue setup.
- Production activation, scheduling, cleanup, and each Level 5 execution require the
  named authorities in Section 11.1 after implementation review.
