# Overseer Control-Plane Contract v1

- **schema_version:** `overseer-control-plane-v1`
- **Work Order:** WO-HARNESS-OVERSEER-CONTROL-PLANE-01
- **Parent:** M-42 (Overseer operational merge steward), supporting prerequisite
- **Source of truth:** `bdc-xo` Wave 2 audit
  `docs/audits/2026-07-16-m42-wave2-schema-interface-audit.md`, Section 7.1
- **Migration:** `migrations/037_overseer_control_plane.sql` (PostgreSQL 17) mirrored by
  `packages/core/src/db/overseer-control-plane-sqlite.ts` (file-backed SQLite)

This substrate is NOT a ninth capability and grants NO provider, paid-call,
credential, or activation authority. All providers remain fakes; every capability
stays off. Slice 8 owns all runtime mounting. No production input accepts a caller
clock, UTC bucket, event sequence, event digest, generated identifier, or lease
duration.

## 1. Tables (closed vocabularies)

### 1.1 `overseer_parent_commitments`
At most 10 active parents; children reuse the parent slot.

- `parent_id` TEXT PRIMARY KEY
- `state` TEXT NOT NULL in `BUILDING`, `REVIEW`, `STAGING`, `RECOVERY`,
  `ACTION_PENDING` (active) or `COMPLETED`, `FAILED`, `CANCELLED` (terminal)
- `owner_id` TEXT NOT NULL; `correlation_id` TEXT NOT NULL UNIQUE
- `fencing_token` BIGINT NOT NULL > 0
- `admitted_at`, `heartbeat_at`, `lease_expires_at` NOT NULL (database clock)
- `released_at`, `terminal_reason` NULL for active; both non-NULL for terminal
- CHECK `lease_expires_at > heartbeat_at`

### 1.2 `overseer_parent_children`
- `parent_id` TEXT NOT NULL REFERENCES `overseer_parent_commitments`
- `child_id` TEXT NOT NULL UNIQUE; PK `(parent_id, child_id)`
- `state` in `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`
- `created_at` NOT NULL; `terminal_at` NULL for nonterminal, non-NULL for terminal
- Children never enter the parent admission count.

### 1.3 `overseer_repository_mutation_leases`
One live mutating lease per repository.

- `repository` TEXT PRIMARY KEY; `lease_id` TEXT NOT NULL UNIQUE
- `owner_id`, `execution_id`, `action_kind`, `capability` TEXT NOT NULL
- `fencing_token` BIGINT NOT NULL > 0
- `state` in `ACTIVE`, `RELEASED`, `EXPIRED`
- `acquired_at`, `heartbeat_at`, `expires_at` NOT NULL; `released_at` NULL when ACTIVE
- Acquire and heartbeat set `expires_at = db_now + 300 seconds` exactly; callers
  cannot choose the duration. Takeover replaces identity only after database-clock
  expiry and increments the fencing token. Initial fence 1.

### 1.4 `overseer_verifier_registries`
- `registry_digest` TEXT PRIMARY KEY, lower-case 64-hex SHA-256
- `schema_version` TEXT NOT NULL exactly `overseer-verifier-registry-v1`
- `frozen_at`, `created_at` NOT NULL
- `source_artifact_path`, `source_git_blob` TEXT NOT NULL

### 1.5 `overseer_verifier_entries`
- `registry_digest` TEXT NOT NULL REFERENCES `overseer_verifier_registries`
- `verifier_id`, `provider`, `model_family` TEXT NOT NULL, canonical lower-case ASCII
  `[a-z0-9][a-z0-9._/-]*`
- `roles_json` JSON NOT NULL, nonempty unique subset of `REVIEWER`, `RED_TEAM`,
  `FUSION`, `MERGE_STEWARD`
- `enabled` BOOLEAN NOT NULL; PK `(registry_digest, verifier_id)`

### 1.6 `overseer_fusion_budget_reservations`
Integer microusd; caps: per-call 3000000, per-UTC-day 20000000, per-UTC-month
100000000.

- `reservation_id` TEXT PRIMARY KEY; `call_id` TEXT NOT NULL UNIQUE
- `proposal_id`, `execution_id`, `provider`, `model`, `call_kind` TEXT NOT NULL
- `call_kind` in `PRIMARY`, `RETRY`, `FALLBACK`, `INDIRECT`
- `utc_day` TEXT `YYYY-MM-DD`; `utc_month` TEXT `YYYY-MM` (database-derived)
- `requested_microusd` BIGINT NOT NULL between 1 and 3000000
- `actual_microusd` BIGINT NULL >= 0 (recorded honestly even when it exceeds the
  reservation; requested cost is the pre-call authority ceiling)
- `status` in `RESERVED`, `IN_FLIGHT`, `RECONCILED`, `RELEASED`
- `reserved_at` NOT NULL; `call_started_at`, `reconciled_at`, `released_at` NULL per
  status. Only `RESERVED -> IN_FLIGHT -> RECONCILED` or `RESERVED -> RELEASED` is valid.

### 1.7 `overseer_control_events`
Append-only, per-resource hash chain.

- `event_id` TEXT PRIMARY KEY, namespace `ocp-event-<uuid>`
- `resource_kind` in `PARENT`, `CHILD`, `REPOSITORY_LEASE`, `VERIFIER_REGISTRY`,
  `FUSION_BUDGET`
- `resource_key`, `event_kind`, `actor` TEXT NOT NULL
- `event_kind` in `ADMITTED`, `HEARTBEAT`, `STATE_CHANGED`, `CHILD_LINKED`,
  `CRASH_RECONCILED`, `LEASE_ACQUIRED`, `LEASE_TAKEN_OVER`, `LEASE_RELEASED`,
  `REGISTRY_FROZEN`, `BUDGET_RESERVED`, `BUDGET_CALL_STARTED`, `BUDGET_RECONCILED`,
  `BUDGET_OVERAGE_RECORDED`, `BUDGET_RELEASED`
- `event_sequence` BIGINT NOT NULL > 0; genesis 1 with NULL `previous_event_digest`
- `evidence_json` JSON NOT NULL; `event_digest` lower-case 64-hex UNIQUE
- UNIQUE `(resource_kind, resource_key, event_sequence)`

Registry headers/entries and control events reject UPDATE and DELETE.
State/lease/budget rows reject DELETE and identity/regression updates; only named
compare-and-swap transitions are allowed.

## 2. Digests (content addressing)

- **Verifier registry.** Content bytes are RFC 8785 canonical JSON of
  `{ "schema_version": "overseer-verifier-registry-v1", "entries": [ ... ] }` where
  each entry object holds sorted keys `enabled`, `model_family`, `provider`, sorted
  unique `roles`, `verifier_id`; entries sort by `verifier_id`. `registry_digest` is
  lower-case SHA-256 of the ASCII domain `overseer-verifier-registry-v1\n` followed
  by those canonical bytes. `source_artifact_path`, `source_git_blob`, and database
  times are receipt fields excluded from the digest.
- **Control event.** Canonical payload is an RFC 8785 object with `event_id`,
  `resource_kind`, `resource_key`, `event_kind`, `actor`, `event_sequence`,
  `evidence_json`, `previous_event_digest`, `created_at` (`created_at` normalized to
  RFC3339 milliseconds `YYYY-MM-DDTHH:mm:ss.SSSZ` before hashing). `event_digest` is
  lower-case SHA-256 of the ASCII domain `overseer-control-event-v1\n` followed by
  the canonical payload bytes.

## 3. Frozen core interfaces and failures

Each mutation returns `{ ok: true, value }` or `{ ok: false, code }`; contract
denials do NOT throw. Unexpected database failures throw and roll back.

- `admitOverseerParent(input)` -> parent or `parent_capacity_reached`; exact replay
  returns the existing row without a second event; identity drift ->
  `parent_identity_conflict`.
- `heartbeatOverseerParent(input)` -> current-token CAS extending expiry exactly 300
  seconds and appending `HEARTBEAT`; stale/wrong/terminal/expired -> `parent_lease_stale`;
  absent -> `parent_not_found`.
- `transitionOverseerParentState(input)` -> any active state to another active state
  with `STATE_CHANGED`; owner/fence mismatch -> `parent_lease_stale`; terminal or
  bad target -> `parent_transition_invalid`; absent -> `parent_not_found`.
- `linkOverseerChild(input)` -> one globally unique `PENDING` child; missing parent ->
  `child_orphaned`; exact replay idempotent; cross-parent -> `child_identity_conflict`;
  stale owner/fence -> `parent_lease_stale`.
- `transitionOverseerChildState(input)` -> `PENDING`->`RUNNING`/terminal or
  `RUNNING`->terminal; wrong owner/fence -> `parent_lease_stale`; absent child ->
  `child_not_found`; invalid edge -> `child_transition_invalid`.
- `releaseOverseerParent(input)` -> terminal parent with nonempty `terminal_reason`;
  COMPLETED requires all children terminal or `parent_children_active`; FAILED and
  CANCELLED atomically fail nonterminal children; increments the parent fence; exact
  terminal replay idempotent; drift -> `parent_transition_invalid`; absent ->
  `parent_not_found`; stale owner/fence -> `parent_lease_stale`.
- `reconcileExpiredParentCommitments()` accepts no clock; reads the database clock in
  its serialized transaction and performs the crash transition exactly once: stale
  active parents -> `FAILED` reason `owner_lease_expired`, `released_at = db_now`,
  `fencing_token + 1`; nonterminal children -> `FAILED`; one `CRASH_RECONCILED` event.
- `acquireRepositoryMutationLease(input)`, `heartbeatRepositoryMutationLease(input)`,
  `releaseRepositoryMutationLease(input)` -> live-owner CAS; contention ->
  `lease_conflict`; wrong/stale/released/expired identity -> `lease_stale`; exact
  release replay idempotent; absent -> `lease_not_found`; initial fence 1, every
  reacquire/takeover increments it.
- `registerVerifierRegistry(input)` computes rather than trusts the digest; structure
  failure -> `registry_invalid`; claimed digest wrong -> `registry_digest_mismatch`;
  divergent re-registration -> `registry_digest_conflict`.
- `assertIndependentVerifier(input)` writes no state; missing registry ->
  `verifier_registry_missing`; unknown -> `verifier_unknown`; disabled ->
  `verifier_disabled`; role missing -> `verifier_role_mismatch`; shared provider or
  model family (including Grok on Grok) -> `verifier_not_independent`.
- `reserveFusionBudget(input)`, `markFusionBudgetCallStarted(input)`,
  `reconcileFusionBudget(input)`, `releaseFusionBudgetReservation(input)` enforce the
  transition graph; exact replay idempotent; cap denial -> `budget_cap_exceeded`;
  wrong identity/state -> `budget_reservation_stale` or `budget_transition_invalid`;
  absent -> `budget_reservation_not_found`; reported actual over the reservation is
  recorded honestly, appends `BUDGET_OVERAGE_RECORDED`, and returns
  `budget_overage_recorded` (a hard stop, not authority to spend more). Release is
  allowed only from `RESERVED` with reason `call_cancelled_before_start`,
  `authorization_revoked_before_start`, or `provider_unavailable_before_start`.
- `listOverseerControlEvents(filter)` is read-only, ordered by resource then
  sequence; filters are optional `resource_kind` and exact `resource_key` only.

## 4. Transactions and locking

Every mutation reads the database clock inside a serialized transaction, allocates
the next per-resource sequence, compares the prior digest, and appends the event in
the same transaction. PostgreSQL uses SERIALIZABLE plus `pg_advisory_xact_lock`;
SQLite uses the isolated `withOverseerControlPlaneImmediateTransaction()`
(`BEGIN IMMEDIATE`) helper, the only place that issues BEGIN IMMEDIATE. The shared
SQLite adapter (deferred BEGIN) is forbidden here. Advisory lock keys:
`overseer-control:parent-admission` (all admissions), the exact repository, the
registry digest, and `overseer-control:fusion-budget` (global UTC aggregates).

## 5. Authenticated unmounted routes

`registerOverseerControlPlaneRoutes(app, deps)` requires an explicit
`OverseerControlPlaneRouteDeps` object with no defaults. `authenticatePrincipal`
returns strict `actor`, `provider`, `model_family` (absent from request bodies).
Every handler authenticates BEFORE parsing or invoking a dependency. Base path
`/internal/overseer/control-plane`:

- `POST /parents/admit` | `/parents/heartbeat` | `/parents/transition`
- `POST /parents/children/link` | `/parents/children/transition`
- `POST /parents/release` | `/parents/reconcile-expired` (body `{}`)
- `POST /repository-leases/acquire` | `/repository-leases/heartbeat` | `/repository-leases/release`
- `POST /verifier-registries/register`
- `POST /verifiers/assert-independent`
- `POST /fusion/reserve` | `/fusion/mark-started` | `/fusion/reconcile` | `/fusion/release`
- `GET /events` (optional `resource_kind`, `resource_key`)

All request objects are strict. Unknown fields (including caller time, bucket,
duration, generated digest, sequence, event ID, and authenticated operator identity)
return HTTP 400 with code `unknown_field`. Authentication failure is 401 before any
other dependency call. First successful create/admit/reserve/register is 201; read,
heartbeat, transition, release, idempotent replay, reconciliation, and assertion are
200. `parent_not_found`, `child_not_found`, `lease_not_found`,
`verifier_registry_missing`, `budget_reservation_not_found` are 404. Every other typed
denial or CAS conflict is 409 (including `budget_overage_recorded` after the honest
row/event commit). Unexpected dependency failure is 500. Success JSON is
`{ "ok": true, "data": <record> }`; error JSON is `{ "ok": false, "error": { "code": <code> } }`.
The route module imports no provider, network, credential, child-process, or central
runtime module and remains unmounted until Slice 8.

## 6. Exact 13-file allowlist

```
docs/contracts/overseer-control-plane-v1.md
migrations/037_overseer_control_plane.sql
packages/core/package.json
packages/core/src/db/overseer-control-plane-sqlite.ts
packages/core/src/db/overseer-control-plane.postgres.test.ts
packages/core/src/db/overseer-control-plane.test.ts
packages/core/src/db/overseer-control-plane.ts
packages/overseer/src/__tests__/control-plane.test.ts
packages/overseer/src/control-plane.ts
packages/server/package.json
packages/server/src/routes/overseer-control-plane.routes.test.ts
packages/server/src/routes/overseer-control-plane.routes.ts
packages/server/src/routes/schemas/overseer-control-plane.schemas.ts
```

The two `package.json` files change only by appending focused test invocations to
`scripts.test`. Slice 8 owns all integration (mounting, service wiring, shared-adapter
registration).
