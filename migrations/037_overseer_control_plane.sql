-- M-42 Overseer control-plane substrate (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
-- Persistent, restart-safe shared-resource controls required before M-42 actions
-- can run concurrently: max-10 parent admission, one mutating lease per repository,
-- an independent verifier registry, and atomic Fusion budget accounting.
-- This migration creates coordination state only. It grants no provider, paid-call,
-- credential, or activation authority. Slice 8 owns all runtime mounting.
-- Frozen contract: docs/contracts/overseer-control-plane-v1.md (overseer-control-plane-v1).

-- 1. Parent commitments (max-10 admission with fencing + lease).
CREATE TABLE IF NOT EXISTS overseer_parent_commitments (
  parent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING',
    'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  correlation_id TEXT NOT NULL UNIQUE CHECK (length(correlation_id) > 0),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  admitted_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  terminal_reason TEXT,
  CHECK (length(parent_id) > 0),
  CHECK (lease_expires_at > heartbeat_at),
  CONSTRAINT overseer_parent_commitments_terminal_pair CHECK (
    (state IN ('BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING')
      AND released_at IS NULL AND terminal_reason IS NULL)
    OR
    (state IN ('COMPLETED', 'FAILED', 'CANCELLED')
      AND released_at IS NOT NULL AND terminal_reason IS NOT NULL
      AND length(terminal_reason) > 0)
  )
);
-- Active-parent accounting: a parent is active while state is nonterminal.
CREATE INDEX IF NOT EXISTS overseer_parent_commitments_active
  ON overseer_parent_commitments(state)
  WHERE state IN ('BUILDING', 'REVIEW', 'STAGING', 'RECOVERY', 'ACTION_PENDING');

-- 2. Parent children (globally unique, never count against the parent slot).
CREATE TABLE IF NOT EXISTS overseer_parent_children (
  parent_id TEXT NOT NULL REFERENCES overseer_parent_commitments(parent_id),
  child_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (parent_id, child_id),
  CHECK (length(child_id) > 0),
  CONSTRAINT overseer_parent_children_terminal_pair CHECK (
    (state IN ('PENDING', 'RUNNING') AND terminal_at IS NULL)
    OR
    (state IN ('COMPLETED', 'FAILED', 'CANCELLED') AND terminal_at IS NOT NULL)
  )
);

-- 3. Repository mutation leases (one live lease per repository with fencing).
CREATE TABLE IF NOT EXISTS overseer_repository_mutation_leases (
  repository TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  action_kind TEXT NOT NULL CHECK (length(action_kind) > 0),
  capability TEXT NOT NULL CHECK (length(capability) > 0),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'EXPIRED')),
  acquired_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (length(repository) > 0),
  CONSTRAINT overseer_repository_mutation_leases_state_pair CHECK (
    (state = 'ACTIVE' AND released_at IS NULL AND expires_at > heartbeat_at)
    OR
    (state IN ('RELEASED', 'EXPIRED') AND released_at IS NOT NULL)
  )
);

-- 4. Verifier registry headers (content-addressed, frozen).
CREATE TABLE IF NOT EXISTS overseer_verifier_registries (
  registry_digest TEXT PRIMARY KEY CHECK (registry_digest ~ '^[0-9a-f]{64}$'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'overseer-verifier-registry-v1'),
  frozen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  source_artifact_path TEXT NOT NULL CHECK (length(source_artifact_path) > 0),
  source_git_blob TEXT NOT NULL CHECK (length(source_git_blob) > 0)
);

-- 5. Verifier registry entries.
CREATE TABLE IF NOT EXISTS overseer_verifier_entries (
  registry_digest TEXT NOT NULL REFERENCES overseer_verifier_registries(registry_digest),
  verifier_id TEXT NOT NULL CHECK (verifier_id ~ '^[a-z0-9][a-z0-9._/-]*$'),
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._/-]*$'),
  model_family TEXT NOT NULL CHECK (model_family ~ '^[a-z0-9][a-z0-9._/-]*$'),
  roles_json JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (registry_digest, verifier_id),
  CONSTRAINT overseer_verifier_entries_roles_valid CHECK (
    jsonb_typeof(roles_json) = 'array'
    AND jsonb_array_length(roles_json) > 0
    AND roles_json <@ '["REVIEWER", "RED_TEAM", "FUSION", "MERGE_STEWARD"]'::jsonb
  )
);

-- 6. Fusion budget reservations (RESERVED -> IN_FLIGHT -> RECONCILED | RELEASED).
CREATE TABLE IF NOT EXISTS overseer_fusion_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL CHECK (length(proposal_id) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  model TEXT NOT NULL CHECK (length(model) > 0),
  call_kind TEXT NOT NULL CHECK (call_kind IN ('PRIMARY', 'RETRY', 'FALLBACK', 'INDIRECT')),
  utc_day TEXT NOT NULL CHECK (utc_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  utc_month TEXT NOT NULL CHECK (utc_month ~ '^[0-9]{4}-[0-9]{2}$'),
  requested_microusd BIGINT NOT NULL CHECK (requested_microusd BETWEEN 1 AND 3000000),
  actual_microusd BIGINT CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'IN_FLIGHT', 'RECONCILED', 'RELEASED')),
  reserved_at TIMESTAMPTZ NOT NULL,
  call_started_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CHECK (length(reservation_id) > 0),
  CHECK (length(call_id) > 0),
  CONSTRAINT overseer_fusion_budget_status_fields CHECK (
    (status = 'RESERVED' AND call_started_at IS NULL AND actual_microusd IS NULL
      AND reconciled_at IS NULL AND released_at IS NULL)
    OR
    (status = 'IN_FLIGHT' AND call_started_at IS NOT NULL AND actual_microusd IS NULL
      AND reconciled_at IS NULL AND released_at IS NULL)
    OR
    (status = 'RECONCILED' AND call_started_at IS NOT NULL AND actual_microusd IS NOT NULL
      AND reconciled_at IS NOT NULL AND released_at IS NULL)
    OR
    (status = 'RELEASED' AND call_started_at IS NULL AND actual_microusd IS NULL
      AND reconciled_at IS NULL AND released_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS overseer_fusion_budget_day
  ON overseer_fusion_budget_reservations(utc_day);
CREATE INDEX IF NOT EXISTS overseer_fusion_budget_month
  ON overseer_fusion_budget_reservations(utc_month);

-- 7. Append-only, per-resource hash-chained control events.
CREATE TABLE IF NOT EXISTS overseer_control_events (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^ocp-event-[0-9a-f-]{36}$'),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'PARENT', 'CHILD', 'REPOSITORY_LEASE', 'VERIFIER_REGISTRY', 'FUSION_BUDGET'
  )),
  resource_key TEXT NOT NULL CHECK (length(resource_key) > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'ADMITTED', 'HEARTBEAT', 'STATE_CHANGED', 'CHILD_LINKED', 'CRASH_RECONCILED',
    'LEASE_ACQUIRED', 'LEASE_TAKEN_OVER', 'LEASE_RELEASED', 'REGISTRY_FROZEN',
    'BUDGET_RESERVED', 'BUDGET_CALL_STARTED', 'BUDGET_RECONCILED',
    'BUDGET_OVERAGE_RECORDED', 'BUDGET_RELEASED'
  )),
  actor TEXT NOT NULL CHECK (length(actor) > 0),
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  evidence_json JSONB NOT NULL,
  previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR previous_event_digest ~ '^[0-9a-f]{64}$'),
  event_digest TEXT NOT NULL UNIQUE CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (resource_kind, resource_key, event_sequence),
  CONSTRAINT overseer_control_events_genesis CHECK (
    (event_sequence = 1 AND previous_event_digest IS NULL)
    OR
    (event_sequence > 1 AND previous_event_digest IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS overseer_control_events_stream
  ON overseer_control_events(resource_kind, resource_key, event_sequence);

-- Mutation guards.
-- Append-only tables reject UPDATE and DELETE.
CREATE OR REPLACE FUNCTION reject_overseer_control_plane_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER overseer_verifier_registries_append_only
  BEFORE UPDATE OR DELETE ON overseer_verifier_registries
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_mutation();
CREATE OR REPLACE TRIGGER overseer_verifier_entries_append_only
  BEFORE UPDATE OR DELETE ON overseer_verifier_entries
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_mutation();
CREATE OR REPLACE TRIGGER overseer_control_events_append_only
  BEFORE UPDATE OR DELETE ON overseer_control_events
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_mutation();

-- State/lease/budget tables reject DELETE and reject identity/regression updates.
CREATE OR REPLACE FUNCTION reject_overseer_control_plane_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_overseer_parent_commitment_update() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id <> OLD.parent_id OR NEW.correlation_id <> OLD.correlation_id
     OR NEW.admitted_at <> OLD.admitted_at THEN
    RAISE EXCEPTION 'overseer_parent_commitments identity is immutable';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'overseer_parent_commitments fencing token cannot decrease';
  END IF;
  IF OLD.state IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'overseer_parent_commitments terminal rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_overseer_repository_lease_update() RETURNS trigger AS $$
BEGIN
  IF NEW.repository <> OLD.repository THEN
    RAISE EXCEPTION 'overseer_repository_mutation_leases repository is immutable';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'overseer_repository_mutation_leases fencing token cannot decrease';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_overseer_fusion_budget_update() RETURNS trigger AS $$
BEGIN
  IF NEW.reservation_id <> OLD.reservation_id OR NEW.call_id <> OLD.call_id
     OR NEW.requested_microusd <> OLD.requested_microusd
     OR NEW.utc_day <> OLD.utc_day OR NEW.utc_month <> OLD.utc_month
     OR NEW.reserved_at <> OLD.reserved_at THEN
    RAISE EXCEPTION 'overseer_fusion_budget_reservations identity is immutable';
  END IF;
  IF OLD.status IN ('RECONCILED', 'RELEASED') THEN
    RAISE EXCEPTION 'overseer_fusion_budget_reservations terminal rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_overseer_parent_child_update() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id <> OLD.parent_id OR NEW.child_id <> OLD.child_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'overseer_parent_children identity is immutable';
  END IF;
  IF OLD.state IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'overseer_parent_children terminal rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER overseer_parent_commitments_no_delete
  BEFORE DELETE ON overseer_parent_commitments
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_delete();
CREATE OR REPLACE TRIGGER overseer_parent_commitments_guard_update
  BEFORE UPDATE ON overseer_parent_commitments
  FOR EACH ROW EXECUTE FUNCTION guard_overseer_parent_commitment_update();

CREATE OR REPLACE TRIGGER overseer_parent_children_no_delete
  BEFORE DELETE ON overseer_parent_children
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_delete();
CREATE OR REPLACE TRIGGER overseer_parent_children_guard_update
  BEFORE UPDATE ON overseer_parent_children
  FOR EACH ROW EXECUTE FUNCTION guard_overseer_parent_child_update();

CREATE OR REPLACE TRIGGER overseer_repository_mutation_leases_no_delete
  BEFORE DELETE ON overseer_repository_mutation_leases
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_delete();
CREATE OR REPLACE TRIGGER overseer_repository_mutation_leases_guard_update
  BEFORE UPDATE ON overseer_repository_mutation_leases
  FOR EACH ROW EXECUTE FUNCTION guard_overseer_repository_lease_update();

CREATE OR REPLACE TRIGGER overseer_fusion_budget_reservations_no_delete
  BEFORE DELETE ON overseer_fusion_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_overseer_control_plane_delete();
CREATE OR REPLACE TRIGGER overseer_fusion_budget_reservations_guard_update
  BEFORE UPDATE ON overseer_fusion_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_overseer_fusion_budget_update();
