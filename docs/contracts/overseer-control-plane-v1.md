# Overseer Control Plane v1

Status: frozen

Schema version: `overseer-control-plane-v1`

## Purpose and authority boundary

This contract defines the persistent shared-resource controls required by M-42.
It is a prerequisite substrate, not an action capability. It does not mount a
route, enable an Overseer capability, invoke a provider, make a paid call, buy
or refill credits, or read or rotate a credential.

All mutations use the database clock. Public input never accepts a clock, UTC
bucket, lease duration, event identifier, event sequence, event digest,
previous event digest, generated identifier, or authenticated operator field.

## Constants

- Maximum active parent commitments: 10.
- Parent and repository lease duration: exactly 300 seconds.
- Fusion per-call cap: 3000000 microusd.
- Fusion UTC-day cap: 20000000 microusd.
- Fusion UTC-month cap: 100000000 microusd.
- Verifier registry schema: `overseer-verifier-registry-v1`.
- Control event digest domain: `overseer-control-event-v1` followed by one
  newline byte.
- Verifier registry digest domain: `overseer-verifier-registry-v1` followed by
  one newline byte.

## Persistence contract

PostgreSQL 17 uses `TIMESTAMPTZ`, `JSONB`, `BIGINT`, and `BOOLEAN`. SQLite uses
RFC3339 UTC text, JSON text validated with `json_valid`, `INTEGER`, and boolean
integers restricted to 0 or 1.

State, lease, and budget rows reject delete. Their update triggers freeze
identity and immutable fields and permit only the exact named transition shapes
below; store updates also compare the previously read identity, state, and
fence in the `WHERE` clause. All other direct updates are rejected.

### `overseer_parent_commitments`

- `parent_id` TEXT primary key.
- `state` is one of `BUILDING`, `REVIEW`, `STAGING`, `RECOVERY`,
  `ACTION_PENDING`, `COMPLETED`, `FAILED`, or `CANCELLED`.
- `owner_id` TEXT not null.
- `correlation_id` TEXT not null and unique.
- `fencing_token` positive BIGINT.
- `admitted_at`, `heartbeat_at`, and `lease_expires_at` are not null.
- `released_at` and `terminal_reason` are null for active states and non-null
  for terminal states.
- `lease_expires_at` is later than `heartbeat_at`.

### `overseer_parent_children`

- `(parent_id, child_id)` is the primary key and `child_id` is globally unique.
- `parent_id` references `overseer_parent_commitments`.
- `state` is one of `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, or `CANCELLED`.
- `created_at` is not null.
- `terminal_at` is null for `PENDING` and `RUNNING` and non-null for terminal
  states.
- Child rows do not consume parent admission capacity.

### `overseer_repository_mutation_leases`

- `repository` is the primary key and `lease_id` is unique.
- `owner_id`, `execution_id`, `action_kind`, and `capability` are not null.
- `fencing_token` is a positive BIGINT.
- `state` is `ACTIVE`, `RELEASED`, or `EXPIRED`.
- `acquired_at`, `heartbeat_at`, and `expires_at` are not null.
- An active row has no `released_at`; a terminal row has one.
- Every acquisition or heartbeat sets expiry to database time plus exactly 300
  seconds. A takeover increments the prior fencing token.

### `overseer_verifier_registries`

- `registry_digest` is a lower-case 64-hex SHA-256 primary key.
- `schema_version` is exactly `overseer-verifier-registry-v1`.
- `frozen_at` and `created_at` use the database clock.
- `source_artifact_path` and `source_git_blob` are not null.
- Headers and entries reject update and delete.

### `overseer_verifier_entries`

- `(registry_digest, verifier_id)` is the primary key.
- `registry_digest` references the registry header.
- `verifier_id`, `provider`, and `model_family` are lower-case canonical ASCII
  tokens matching `[a-z0-9][a-z0-9._/-]*`.
- `roles_json` is a sorted, unique array containing only `REVIEWER`,
  `RED_TEAM`, `FUSION`, and `MERGE_STEWARD`.
- `enabled` is boolean.

### `overseer_fusion_budget_reservations`

- `reservation_id` is the primary key and `call_id` is unique.
- `proposal_id`, `execution_id`, `provider`, `model`, and `call_kind` are not
  null.
- `call_kind` is `PRIMARY`, `RETRY`, `FALLBACK`, or `INDIRECT`.
- `utc_day` and `utc_month` are derived from database UTC.
- `requested_microusd` is an integer from 1 through 3000000.
- `actual_microusd` is null until reconciliation and is then nonnegative.
- `status` is `RESERVED`, `IN_FLIGHT`, `RECONCILED`, or `RELEASED`.
- `RESERVED` has only `reserved_at`.
- `IN_FLIGHT` also has `call_started_at`.
- `RECONCILED` also has `actual_microusd` and `reconciled_at`.
- `RELEASED` has no call-start, actual, or reconciliation fields and has
  `released_at` plus an allowed release reason.
- Valid transitions are `RESERVED -> IN_FLIGHT -> RECONCILED` and
  `RESERVED -> RELEASED` only.

### `overseer_control_events`

- `event_id` is a primary key in namespace `ocp-event-<uuid>`.
- `resource_kind` is `PARENT`, `CHILD`, `REPOSITORY_LEASE`,
  `VERIFIER_REGISTRY`, or `FUSION_BUDGET`.
- `event_kind` is one of `ADMITTED`, `HEARTBEAT`, `STATE_CHANGED`,
  `CHILD_LINKED`, `CRASH_RECONCILED`, `LEASE_ACQUIRED`,
  `LEASE_TAKEN_OVER`, `LEASE_RELEASED`, `REGISTRY_FROZEN`,
  `BUDGET_RESERVED`, `BUDGET_CALL_STARTED`, `BUDGET_RECONCILED`,
  `BUDGET_OVERAGE_RECORDED`, or `BUDGET_RELEASED`.
- `event_sequence` is positive and unique per resource stream.
- Genesis is sequence 1 with null `previous_event_digest`.
- Every later event names the exact preceding event digest.
- `event_digest` is unique lower-case 64-hex SHA-256.
- Events reject update and delete.

## Function contract

Every mutation returns `{ ok: true, value }` or `{ ok: false, code }`.
`admitOverseerParent`, `linkOverseerChild`, `registerVerifierRegistry`, and
`reserveFusionBudget` additionally return `created: true` for the first insert
and `created: false` for an exact idempotent replay.
Contract denials do not throw. Unexpected database failures throw and roll back.

### Parent commitment functions

`admitOverseerParent(input)` accepts only `parent_id`, `owner_id`,
`correlation_id`, and an active initial `state`. It reconciles expired parents,
then atomically admits below the max-10 cap. Exact replay is idempotent.
Denials are `unknown_field`, `parent_capacity_reached`,
`parent_identity_conflict`, or `parent_transition_invalid`.

`heartbeatOverseerParent(input)` accepts only `parent_id`, `owner_id`, and
`fencing_token`. Current, active, unexpired identity extends the lease exactly
300 seconds and appends `HEARTBEAT`. Denials are `unknown_field`,
`parent_not_found`, and `parent_lease_stale`.

`transitionOverseerParentState(input)` adds active `state` to the heartbeat
identity. Active-to-active change appends `STATE_CHANGED`. Terminal states are
reachable only through release.

`linkOverseerChild(input)` accepts `parent_id`, `child_id`, `owner_id`, and
`fencing_token`. It requires a current active parent and creates a globally
unique `PENDING` child. Denials include `child_orphaned`,
`child_identity_conflict`, and `parent_lease_stale`.

`transitionOverseerChildState(input)` permits `PENDING -> RUNNING`, `PENDING ->
terminal`, and `RUNNING -> terminal`. Terminal children are immutable. Denials
include `child_not_found`, `child_identity_conflict`,
`child_transition_invalid`, and `parent_lease_stale`.

`releaseOverseerParent(input)` accepts a current parent identity, terminal
`state`, and nonempty `terminal_reason`. `COMPLETED` requires all children
terminal. `FAILED` and `CANCELLED` atomically move nonterminal children to the
same state. Success increments the parent fence. Exact terminal replay is
idempotent. Denials include `parent_children_active`, `parent_lease_stale`, and
`parent_transition_invalid`.

`reconcileExpiredParentCommitments()` accepts no clock. In one serialized
transaction it changes each expired active parent to `FAILED`, sets reason
`owner_lease_expired`, fails nonterminal children, increments the parent fence,
and appends `CRASH_RECONCILED` exactly once.

### Repository lease functions

`acquireRepositoryMutationLease(input)` accepts `repository`, `lease_id`,
`owner_id`, `execution_id`, `action_kind`, and `capability`. A current live
lease causes `lease_conflict`. Expired or terminal takeover replaces identity
and increments the previous fence. Exact active replay is idempotent.

`heartbeatRepositoryMutationLease(input)` and
`releaseRepositoryMutationLease(input)` accept exact repository, lease, owner,
execution, and fence identity. Stale identity returns `lease_stale` and writes
nothing. Missing identity returns `lease_not_found`. Exact release replay is
idempotent.

### Verifier registry functions

`registerVerifierRegistry(input)` accepts `schema_version`, caller-asserted
`registry_digest`, strict `entries`, `source_artifact_path`, and
`source_git_blob`. It computes the digest, freezes header and entries, and
appends `REGISTRY_FROZEN` atomically. Exact content and provenance replay is
idempotent. Failures are `registry_invalid`, `registry_digest_mismatch`, and
`registry_digest_conflict`.

Registry content is RFC 8785 canonical JSON of exactly:

```json
{"entries":[],"schema_version":"overseer-verifier-registry-v1"}
```

Entries sort by `verifier_id`; roles sort and are unique. Provenance and times
are excluded from the digest. SHA-256 covers the domain with one newline byte
followed by canonical bytes. The empty registry vector digest is:

```text
92db4bf943bc3b2e32d79c216b8638750864216a1d943aa3d4c763372ae9d56c
```

`assertIndependentVerifier(input)` accepts authenticated operator provider and
model family plus registry digest, verifier ID, and required role. It permits
only an enabled verifier with the role and both a different provider and a
different model family. Failures are `verifier_registry_missing`,
`verifier_unknown`, `verifier_disabled`, `verifier_role_mismatch`, and
`verifier_not_independent`.

### Fusion budget functions

`reserveFusionBudget(input)` accepts `reservation_id`, `call_id`,
`proposal_id`, `execution_id`, canonical provider and model, `call_kind`, and
`requested_microusd`. It derives time buckets inside the global serialized
budget transaction. `RESERVED` and `IN_FLIGHT` count requested cost,
`RECONCILED` counts actual cost, and `RELEASED` counts zero. Retry, fallback,
and indirect calls each require their own reservation.

`markFusionBudgetCallStarted(input)` is the persistent CAS immediately before
call invocation. An `IN_FLIGHT` crash remains charged and cannot release.

`reconcileFusionBudget(input)` records nonnegative actual cost honestly. An
actual amount above reservation commits the row and
`BUDGET_OVERAGE_RECORDED`, then returns `budget_overage_recorded`. Later
reservations fail closed while day or month totals exceed a cap.

`releaseFusionBudgetReservation(input)` permits only a `RESERVED` row and one
of `call_cancelled_before_start`, `authorization_revoked_before_start`, or
`provider_unavailable_before_start`.

Budget failures are `budget_cap_exceeded`, `budget_reservation_stale`,
`budget_transition_invalid`, `budget_reservation_not_found`, and
`budget_overage_recorded`.

`listOverseerControlEvents(filter)` is read-only. Its only optional filters are
exact `resource_kind` and `resource_key`; output orders by resource and
sequence.

## Event canonicalization and transactions

The canonical event object contains exactly `event_id`, `resource_kind`,
`resource_key`, `event_kind`, `actor`, `event_sequence`, `evidence_json`,
`previous_event_digest`, and `created_at`. Database UTC is normalized to
RFC3339 milliseconds before hashing. SHA-256 covers the event domain with one
newline byte followed by RFC 8785 canonical bytes.

PostgreSQL uses `SERIALIZABLE` transactions plus advisory transaction locks.
Parent admission uses `overseer-control:parent-admission`; repository leases
lock the exact repository; registries lock the exact digest; Fusion uses
`overseer-control:fusion-budget`.

SQLite mutations use only
`withOverseerControlPlaneImmediateTransaction(database, fn)`. The helper
requires SQLite, rejects nested use, serializes in-process control-plane
writers, issues `BEGIN IMMEDIATE`, commits success, and rolls back thrown
failure. The shared deferred transaction helper is forbidden for this module.

Resource mutation, sequence allocation, predecessor comparison, and event
append occur in the same transaction.

## Authenticated unmounted route contract

`registerOverseerControlPlaneRoutes(app, deps)` requires all dependencies and
has no defaults. Authentication runs before request validation or any store
call. It returns strict principal `actor`, `provider`, and `model_family`;
those fields are absent from request bodies.

The unmounted routes are:

- `POST /internal/overseer/control-plane/parents/admit`
- `POST /internal/overseer/control-plane/parents/heartbeat`
- `POST /internal/overseer/control-plane/parents/transition`
- `POST /internal/overseer/control-plane/parents/children/link`
- `POST /internal/overseer/control-plane/parents/children/transition`
- `POST /internal/overseer/control-plane/parents/release`
- `POST /internal/overseer/control-plane/parents/reconcile-expired`
- `POST /internal/overseer/control-plane/repository-leases/acquire`
- `POST /internal/overseer/control-plane/repository-leases/heartbeat`
- `POST /internal/overseer/control-plane/repository-leases/release`
- `POST /internal/overseer/control-plane/verifier-registries/register`
- `POST /internal/overseer/control-plane/verifiers/assert-independent`
- `POST /internal/overseer/control-plane/fusion/reserve`
- `POST /internal/overseer/control-plane/fusion/mark-started`
- `POST /internal/overseer/control-plane/fusion/reconcile`
- `POST /internal/overseer/control-plane/fusion/release`
- `GET /internal/overseer/control-plane/events`

Success is `{ "ok": true, "data": <record> }`. Failure is
`{ "ok": false, "error": { "code": <code> } }`. Authentication failure is
401. Unknown fields are 400 `unknown_field`. Missing addressed resources are
404. Typed denials and CAS conflicts are 409. Unexpected failures are 500 and
do not expose dependency messages. First create, admit, reserve, or register is
201; read, heartbeat, transition, release, replay, reconciliation, and verifier
assertion is 200.

The route and service modules contain no provider, network, child-process,
credential, credit purchase/refill, key rotation, paid-call, activation, or
central runtime dependency. Slice 8 exclusively owns mounting and activation.
