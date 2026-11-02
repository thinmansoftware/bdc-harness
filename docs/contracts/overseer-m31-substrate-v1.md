# Overseer M-31 Substrate Contract v1

- Contract id: `overseer-m31-substrate-v1`
- Schema version constant: `m31-substrate-v1` (`M31_SCHEMA_VERSION`)
- Parent motion: M-42 (`M-20260714-42-overseer-operational-merge-steward`), Slice 2 of 8
- Binding behavior: M-31 (`M-20260712-31-m28-roster-snapshot-amendment`)
- Owner: Slice 2 (`WO-HARNESS-OVERSEER-M31-SUBSTRATE-01`) is the sole owner of this
  contract, of `migrations/033_overseer_m31_substrate.sql`, and of the shared
  SQLite schema integration for Wave 1.
- Consumers: Slices 1 and 3 consume this content-addressed contract digest and
  MUST NOT edit it. Slices 4 through 7 may not dispatch until this contract is
  content-addressed and independently reviewed.

This contract is frozen. Any change to a table, column, constraint, interface,
typed failure, capability mapping, digest shape, permit/receipt shape, clock
owner, or the 60-second validity rule requires a new versioned contract file
and a revision of the source schema audit; it may not be edited in place.

## 1. Activation boundary (non-negotiable)

Slice 2 completion activates nothing and exposes no provider mutation. This
substrate prepares a short-lived, single-use action permit ONLY after an exact
live-state revalidation. It performs no merge, close, reopen, branch, repair,
refire, deploy, staging mutation, production mutation, paid Fusion call, or any
other external effect. No provider client, GitHub client, or deploy call is
reachable from any function or route named below.

- `overseer_m31_snapshots.mutation_succeeded` is constrained to `0`.
- `overseer_m31_snapshots.fusion_calls_succeeded` is constrained to `0`.
- `overseer_m31_execution_receipts.provider_atomic_operation` is constrained to
  `NULL`.
- `overseer_m31_execution_receipts.compare_result` is constrained to
  `permit_issued`.

## 2. Append-only substrate (schema `m31-substrate-v1`)

Five append-only tables. UPDATE and DELETE are rejected on every table by a
`BEFORE UPDATE`/`BEFORE DELETE` trigger (PostgreSQL `RAISE EXCEPTION`, SQLite
`RAISE(ABORT, '<table> is append-only')`). PostgreSQL migration 033 and the
SQLite adapter (`packages/core/src/db/adapters/sqlite.ts`) exhibit equivalent
behavior. Booleans are stored as small integers (`0`/`1`) for dialect parity.

### 2.1 `overseer_m31_snapshots` (immutable snapshot header)

Columns: `snapshot_id` (PK), `schema_version`, `repository`,
`capture_started_at`, `capture_completed_at`, `operator_actor`,
`operator_model`, `read_only_query_method`, `base_branch`, `base_sha`,
`predecessor_snapshot_id`, `predecessor_evidence_git_blob`, `artifact_path`,
`git_object_format`, `evidence_git_blob` (UNIQUE), `mutation_attempted`,
`mutation_succeeded` (= 0), `fusion_calls_attempted`, `fusion_calls_succeeded`
(= 0), `created_at`.

`predecessor_snapshot_id` and `predecessor_evidence_git_blob` are present or
absent together. `git_object_format` is `sha1` or `sha256`. Git blob columns are
40-hex (sha1) or 64-hex (sha256).

### 2.2 `overseer_m31_snapshot_members` (explicit sorted membership)

Columns: `snapshot_id`, `ordinal`, `pr_number`, `head_sha`, `base_branch`,
`base_sha`, `state`, `checks_json`, `check_source_sha`, `checks_observed_at`,
`review_state`, `mergeability`, `merge_state_status`, `linked_work_evidence_json`,
`evidence_artifact_path`, `git_object_format`, `evidence_git_blob`,
`observed_at`.

Primary key `(snapshot_id, ordinal)`; `(snapshot_id, pr_number)` is UNIQUE.
Membership is explicit and sorted by `ordinal`. Membership never collapses and
never admits a successor between snapshots. `linked_work_evidence_json` and its
bound artifact name repository, predecessor PR and head SHA, successor PR and
head SHA, evidence timestamp, proof method/result, linked WO evidence, and an
independent reviewer; lineage evidence is retained as supporting evidence only
and is never operative.

### 2.3 `overseer_m31_discrepancies` (append-only discrepancies)

Columns: `discrepancy_id` (PK), `snapshot_id`, `evidence_git_blob`,
`affected_rows_json`, `observed_conflict`, `recorder`, `recorded_at`,
`resolution`, `predecessor_discrepancy_id`. An unresolved discrepancy
(`resolution IS NULL`) blocks proposal creation.

### 2.4 `overseer_m31_action_proposals` (immutable expiring exact-state proposal)

Columns: `proposal_id` (PK), `repository`, `pr_number`, `head_sha`,
`base_branch`, `base_sha`, `snapshot_id`, `evidence_path`, `evidence_git_blob`,
`action_kind`, `action_parameters_json`, `actor`, `created_at`, `expires_at`,
`execution_id` (UNIQUE), `capability`, `policy_digest`,
`verifier_registry_digest`. `expires_at > created_at`.

### 2.5 `overseer_m31_execution_receipts` (single-use compare-and-consume)

Columns: `receipt_id` (PK), `proposal_id` (UNIQUE), `execution_id` (UNIQUE),
`snapshot_id`, `live_observation_json`, `live_observation_digest`,
`revalidated_at`, `valid_until`, `compare_result` (= `permit_issued`),
`provider_atomic_operation` (= NULL), `created_at`. `valid_until >
revalidated_at`. One receipt per proposal and per execution ID enforces exactly
one successful consumption.

## 3. Closed action-kind vocabulary

`MERGE`, `CLOSE`, `REOPEN`, `REFRESH`, `REBASE`, `PUSH`, `RETARGET`, `REPAIR`,
`REFIRE`, `COMMENT`, `LABEL`, `ASSIGN`, `REVIEW`, `STAGING_MUTATION`,
`PRODUCTION_MUTATION`, `DEPLOY`.

A disposition such as READY, DUPLICATE, SUPERSEDED, or HOLD is never an action
kind or authority.

## 4. Capability / action mapping and gate semantics

- Capability for an action kind: `overseer.m31.<action_kind lowercased>`
  (`capabilityForActionKind`). Example: `MERGE` -> `overseer.m31.merge`.
- The capability gate (`M31CapabilityGate`) is fail-closed. The default
  `createFailClosedM31CapabilityGate()` allows only when the proposal capability
  exactly equals the mapped capability and both digests are well-formed 64-hex.
  It grants no runtime capability and performs no side effect. Denial reasons:
  `capability_mismatch`, `policy_digest_malformed`,
  `verifier_registry_digest_malformed`.
- The gate is applied by `prepareM31ActionPermit` BEFORE compare-and-consume and
  produces only a decision, never an activation.

## 5. Digest shapes

- `policy_digest`, `verifier_registry_digest`, and `live_observation_digest` are
  lower-case 64-hex SHA-256 content addresses (`^[0-9a-f]{64}$`).
- Git blob columns are 40-hex (sha1) or 64-hex (sha256) content addresses.

## 6. Permit and receipt shapes

`M31ActionPermit`: `permit_id`, `proposal_id`, `execution_id`, `repository`,
`pr_number`, `head_sha`, `base_branch`, `base_sha`, `snapshot_id`,
`action_kind`, `capability`, `issued_at`, `valid_until`. The permit carries no
mutation callback and no provider handle.

`M31ExecutionReceipt`: `receipt_id`, `proposal_id`, `execution_id`,
`snapshot_id`, `live_observation`, `live_observation_digest`, `revalidated_at`,
`valid_until`, `compare_result` (= `permit_issued`), `provider_atomic_operation`
(= null), `created_at`.

`M31LiveObservation` (operator-supplied, read-only): `known`, `repository`,
`pr_number`, `head_sha`, `base_branch`, `base_sha`, `policy_digest`,
`verifier_registry_digest`, `observed_at`.

## 7. Clock ownership and the 60-second validity rule

- The authoritative clock is the database transaction clock (`txNow`): SQLite
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')` and PostgreSQL `clock_timestamp() AT
  TIME ZONE 'UTC'`. Callers may inject an explicit `now` only in tests. No
  client wall-clock is authoritative.
- `M31_OBSERVATION_VALIDITY_MS = 60000`. A bound observation is valid while
  `now <= observed_at + validity_window_ms`. An observation aged exactly 60
  seconds passes; an observation aged 61 seconds returns `observation_stale`.
- Default proposal TTL: `M31_DEFAULT_PROPOSAL_TTL_MS = 900000` (15 minutes),
  overridable per proposal via `ttl_ms`.

## 8. Typed failures (closed set)

`snapshot_invalid`, `snapshot_not_chain_tip`, `snapshot_forked`,
`predecessor_missing`, `predecessor_digest_mismatch`, `discrepancy_unresolved`,
`evidence_missing`, `evidence_conflicting`, `evidence_stale`, `proposal_expired`,
`proposal_replayed`, `execution_id_conflict`, `live_state_unknown`,
`live_state_mismatch`, `observation_stale`, `policy_digest_mismatch`,
`verifier_registry_mismatch`.

Every failure is returned before any receipt or permit is written and before any
external dependency could run.

## 9. Interfaces (frozen)

Core persistence (`@archon/core/db/merge-steward`):

- `registerM31Snapshot(input)`
- `getM31Snapshot(snapshotId)`
- `getM31ChainAssessment(repository)`
- `appendM31Discrepancy(input)`
- `createM31ActionProposal(input)`
- `getM31ActionProposal(proposalId)`
- `compareAndConsumeM31Proposal(input)`
- `capabilityForActionKind(kind)`
- constants `M31_SCHEMA_VERSION`, `M31_OBSERVATION_VALIDITY_MS`,
  `M31_DEFAULT_PROPOSAL_TTL_MS`

Overseer preparation (`@archon/overseer/m31-substrate`):

- interface `M31LiveStateReader.readBoundState(proposal)` (read-only; no default
  implementation is shipped in this slice)
- interface `M31CapabilityGate.authorize(request)` (fail-closed)
- `createFailClosedM31CapabilityGate()`
- `prepareM31ActionPermit(input, deps)` -> permit, typed failure, gate denial,
  or not-found; exposes no mutation callback and reaches no provider

Internal authenticated API (`packages/server/src/routes/api.ts`, operator auth
via `authenticateBoardPrincipal`; schemas in
`packages/server/src/routes/schemas/merge-steward.schemas.ts`):

- `POST /api/overseer/m31/snapshots`
- `GET /api/overseer/m31/snapshots/{snapshot_id}`
- `POST /api/overseer/m31/snapshots/{snapshot_id}/discrepancies`
- `POST /api/overseer/m31/proposals`
- `GET /api/overseer/m31/proposals/{proposal_id}`
- `POST /api/overseer/m31/proposals/{proposal_id}/compare-and-consume`

For compare-and-consume, the authenticated operator supplies the exact
read-only live observation in the request body; the route injects a reader that
returns that submitted observation and reaches no provider.

## 10. Exact acceptance commands

Focused tests:

- `bun test packages/core/src/db/merge-steward.test.ts`
- `bun test packages/overseer/src/__tests__/m31-substrate.test.ts`
- `bun test packages/server/src/routes/api.merge-steward.test.ts`

Package and repo gates:

- `bun --filter @archon/core test`
- `bun --filter @archon/overseer test`
- `bun --filter @archon/server test`
- `bun run type-check`
- `bun run lint --max-warnings 0`
- `bun run format:check`
- `bun run check:bundled`
- `bun run check:bundled-skill`

Migration and dialect parity:

- Apply `migrations/033_overseer_m31_substrate.sql` to an isolated PostgreSQL
  database and run the database tests against both PostgreSQL and SQLite.

Scope and ASCII integrity: `git diff --check origin/dev...HEAD`,
`git diff --quiet origin/dev...HEAD -- packages/overseer/src/service.ts
packages/overseer/src/actions/merge-ready.ts`, and a non-ASCII scan of changed
code/script files.

## 11. Immutable invariants (must never break)

Append-only evidence; exact action identity; fail-closed on unknown, stale,
conflicting, forked, discrepant, or non-chain-tip evidence; the 60-second final
comparison; single-use execution; PostgreSQL/SQLite parity; independent
fail-closed gate semantics; and the no-mutation / no-activation boundary.
