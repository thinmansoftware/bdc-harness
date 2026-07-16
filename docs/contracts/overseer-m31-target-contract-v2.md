# Overseer M-31 Tagged Target Contract v2

- Contract id: `overseer-m31-target-contract-v2`
- Schema version: `m31-target-v2`
- Parent: M-42, Slice 2B
- Executable amendment: bdc-xo `6708d47a191dd8e195502e68f9cbd4b4d192e70c`
- Owner: `WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01`
- Migration: `migrations/036_overseer_m31_target_contract_v2.sql`
- Frozen v1 blob: `db368cbfc0209f1e96c90c5e7b6544f093d80cac`

This contract is independent of M-31 v1. V2 has separate snapshot headers,
members, discrepancy chain, proposals, receipt events, and chain tips. No v2
foreign key names a v1 table. No v2 operation reads or advances v1 state. V1
files, routes, interfaces, and behavior remain unchanged.

## Activation boundary

Slice 2B creates exact target evidence, short-lived permits, durable pre-effect
reservations, primary outcomes, and reconciliation evidence. It accepts no
provider, GitHub, Board, deploy, paid-call, or mutation dependency. It mounts no
route and enables no capability. A reservation is evidence, not an external
effect.

## Exact targets

`M31ActionTargetV2` is a closed tagged union:

- `workflow_run`: repository, run UUID, WO ID, workflow name, nullable codebase
  ID, status, event tip, and nullable head/base evidence.
- `issue`: repository, positive non-PR issue number, provider node ID, state,
  and updated time.
- `work_order`: repository, WO ID, spec path/revision/SHA-256, and a required
  bound non-PR tracker issue identity.
- `pull_request`: repository, positive PR number, provider node ID, exact
  head/base SHAs, base branch, state, and updated time.

Target keys and digests are derived internally. Canonical target JSON is UTF-8
JSON with recursively sorted object keys, stable array order, and integer-only
numeric target fields. `target_digest` is lower-case SHA-256 of those exact
bytes. Callers cannot supply either value.

Exact target-key vectors:

- `org/repo#workflow_run:123e4567-e89b-42d3-a456-426614174000`
- `org/repo#issue:8`
- `org/repo#work_order:WO-2`
- `org/repo#pull_request:10`

The matching SHA-256 golden digests for the four fixtures in
`m31-target-v2.test.ts` are, in that order:
`a5e03e898bb58677023725a4d03f48d0f33d758b895a063037599f0001dfc0a9`,
`f740bc35bc4a80c808e568fed0c1da68c9bbb7193f37bdb7ca33690f42439051`,
`6866253289065046d776438e2155ea5d1b25eb24598360f6bf9377acf54eb469`,
and `7acd08dc9956c3c21d187a29b4d72462bb465e4882cc64a4c31a5de56c0670fb`.
The test stores and asserts the exact canonical JSON bytes for each fixture.

## Action matrix

- `workflow_run`: `REPAIR`, `REFIRE`
- `issue`: `CLOSE`, `REOPEN`, `COMMENT`, `LABEL`, `ASSIGN`
- `work_order`: the same lifecycle actions, through the exact bound tracker
- `pull_request`: `MERGE`, `CLOSE`, `REOPEN`, `REFRESH`, `REBASE`, `REPAIR`,
  `COMMENT`, `LABEL`, `ASSIGN`

Every other pair fails as `action_target_mismatch` before a proposal or receipt
is written. `PUSH`, `RETARGET`, `REVIEW`, `STAGING_MUTATION`,
`PRODUCTION_MUTATION`, and `DEPLOY` are universally denied. V2 adds only
`target_invalid` and `action_target_mismatch` to the frozen v1 typed-failure
set.

## Five append-only tables

PostgreSQL migration 036 and the isolated SQLite installer define the same five
tables:

1. `overseer_m31_snapshots_v2`
2. `overseer_m31_target_members_v2`
3. `overseer_m31_discrepancies_v2`
4. `overseer_m31_action_proposals_v2`
5. `overseer_m31_execution_receipts_v2`

All reject UPDATE and DELETE. One-genesis and one-successor indexes make the
snapshot chain linear. Registration starts PostgreSQL at SERIALIZABLE and then
uses compare-and-swap; SQLite uses `BEGIN IMMEDIATE`. PostgreSQL also takes a
repository advisory lock for discrepancy appends.

Discrepancy resolution is a new row only. Its strict `resolution_json` is
`{resolves_discrepancy_id,resolution_code,evidence_digest}`. It must repeat the
open row's snapshot, affected-target JSON, and conflict JSON; name the current
repository discrepancy tip as predecessor; carry database-clock `resolved_at`
and a nonempty `resolved_by`; and may resolve an open row once. Cross-repository,
double, resolution-of-resolution, mismatched, or stale-predecessor appends are
rejected. Assessment anti-joins open IDs named by valid resolution rows.

## Receipt sequence

The append-only receipt stream is fixed:

1. `permit_issued`
2. `effect_reserved`
3. exactly one of `effect_succeeded`, `effect_failed`,
   `effect_indeterminate`
4. only after indeterminate, one of `effect_reconciled_succeeded`,
   `effect_reconciled_failed`

Sequence numbers are internal. Every row hashes its canonical payload and prior
event digest. A crash after reservation is indeterminate and is not blindly
retried; a retry requires a new proposal and execution ID.

## Frozen functions

Core persistence:

- `registerM31SnapshotV2(input)`
- `installM31TargetV2Sqlite(db)`
- `getM31SnapshotV2(snapshotId)`
- `appendM31DiscrepancyV2(input)`
- `resolveM31DiscrepancyV2(input)`
- `getM31ChainAssessmentV2(repository)`
- `createM31ActionProposalV2(input)`
- `getM31ActionProposalV2(proposalId)`
- `compareAndConsumeM31ProposalV2(input)`
- `reserveM31ExecutionEffectV2(input)`
- `appendM31ExecutionOutcomeV2(input)`
- `appendM31ExecutionReconciliationV2(input)`
- `listM31ExecutionReceiptEventsV2(executionId)`

Overseer contract:

- `prepareM31ActionPermitV2(input, deps)`
- `createFailClosedM31CapabilityGateV2()`
- `evaluateActionPolicyV2(input)`
- `authorizeOverseerActionV2(input, deps)`

Internal API contract:

- `registerM31TargetV2Routes(app, deps)`

The route registrar is unmounted. Authentication and every store function are
required injected dependencies. It has no defaults and no cross-package
runtime import of Overseer. Slice 8 alone owns mounting, exports, shared SQLite
installation, service/watch wiring, and runtime activation.

## Clock and replay invariants

The production clock is the database transaction clock. The 60-second boundary
passes at exactly 60 seconds and fails after it. Missing or invalid database
time fails closed. Explicit `test_clock_now` seams in core inputs are test-only
and are not present in route schemas. Proposal IDs, execution IDs, and receipt IDs use the
`m31v2-*` namespaces and cannot collide with v1.

## Acceptance commands

The binding commands are Stops 1-7 in
`WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01.md`. In addition, a disposable
PostgreSQL 17 container must apply migration 036 with `ON_ERROR_STOP=1` and
prove five-table creation, append-only rejection, linear discrepancy
resolution, and rollback. SQLite and application suites must prove the full
4-by-16 action matrix, target validation, replay prevention, receipt order,
canonical JSON golden vectors, and bidirectional v1/v2 isolation.

## Completion statement

Slice 2B completes target identity only; no M-42 capability is activated.
