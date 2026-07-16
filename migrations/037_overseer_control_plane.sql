BEGIN;

CREATE TABLE IF NOT EXISTS overseer_parent_commitments (
  parent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING','COMPLETED','FAILED','CANCELLED')),
  owner_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  admitted_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  terminal_reason TEXT,
  CHECK (lease_expires_at > heartbeat_at),
  CHECK (
    (state IN ('BUILDING','REVIEW','STAGING','RECOVERY','ACTION_PENDING') AND released_at IS NULL AND terminal_reason IS NULL) OR
    (state IN ('COMPLETED','FAILED','CANCELLED') AND released_at IS NOT NULL AND length(trim(terminal_reason)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS overseer_parent_children (
  parent_id TEXT NOT NULL REFERENCES overseer_parent_commitments(parent_id),
  child_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (parent_id, child_id),
  CHECK (
    (state IN ('PENDING','RUNNING') AND terminal_at IS NULL) OR
    (state IN ('COMPLETED','FAILED','CANCELLED') AND terminal_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS overseer_repository_mutation_leases (
  repository TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  capability TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
  acquired_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (expires_at > heartbeat_at),
  CHECK (
    (state = 'ACTIVE' AND released_at IS NULL) OR
    (state IN ('RELEASED','EXPIRED') AND released_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS overseer_verifier_registries (
  registry_digest TEXT PRIMARY KEY CHECK (registry_digest ~ '^[0-9a-f]{64}$'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'overseer-verifier-registry-v1'),
  frozen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  source_artifact_path TEXT NOT NULL,
  source_git_blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overseer_verifier_entries (
  registry_digest TEXT NOT NULL REFERENCES overseer_verifier_registries(registry_digest),
  verifier_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_family TEXT NOT NULL,
  roles_json JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (registry_digest, verifier_id),
  CHECK (jsonb_typeof(roles_json) = 'array' AND jsonb_array_length(roles_json) > 0)
);

CREATE TABLE IF NOT EXISTS overseer_fusion_budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  call_kind TEXT NOT NULL CHECK (call_kind IN ('PRIMARY','RETRY','FALLBACK','INDIRECT')),
  utc_day TEXT NOT NULL CHECK (utc_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  utc_month TEXT NOT NULL CHECK (utc_month ~ '^[0-9]{4}-[0-9]{2}$'),
  requested_microusd BIGINT NOT NULL CHECK (requested_microusd BETWEEN 1 AND 3000000),
  actual_microusd BIGINT CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('RESERVED','IN_FLIGHT','RECONCILED','RELEASED')),
  reserved_at TIMESTAMPTZ NOT NULL,
  call_started_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  CHECK (
    (status = 'RESERVED' AND call_started_at IS NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (status = 'IN_FLIGHT' AND call_started_at IS NOT NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (status = 'RECONCILED' AND call_started_at IS NOT NULL AND actual_microusd IS NOT NULL AND reconciled_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (status = 'RELEASED' AND call_started_at IS NULL AND actual_microusd IS NULL AND reconciled_at IS NULL AND released_at IS NOT NULL AND length(trim(release_reason)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS overseer_control_events (
  event_id TEXT PRIMARY KEY CHECK (event_id LIKE 'ocp-event-%'),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('PARENT','CHILD','REPOSITORY_LEASE','VERIFIER_REGISTRY','FUSION_BUDGET')),
  resource_key TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('ADMITTED','HEARTBEAT','STATE_CHANGED','CHILD_LINKED','CRASH_RECONCILED','LEASE_ACQUIRED','LEASE_TAKEN_OVER','LEASE_RELEASED','REGISTRY_FROZEN','BUDGET_RESERVED','BUDGET_CALL_STARTED','BUDGET_RECONCILED','BUDGET_OVERAGE_RECORDED','BUDGET_RELEASED')),
  actor TEXT NOT NULL,
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  evidence_json JSONB NOT NULL,
  previous_event_digest TEXT CHECK (previous_event_digest IS NULL OR previous_event_digest ~ '^[0-9a-f]{64}$'),
  event_digest TEXT NOT NULL UNIQUE CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (resource_kind, resource_key, event_sequence),
  CHECK ((event_sequence = 1 AND previous_event_digest IS NULL) OR event_sequence > 1)
);

CREATE OR REPLACE FUNCTION overseer_control_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rejects delete', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION overseer_control_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION overseer_control_validate_event_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_sequence = 1 THEN
    IF EXISTS (
      SELECT 1 FROM overseer_control_events
      WHERE resource_kind = NEW.resource_kind AND resource_key = NEW.resource_key
    ) THEN
      RAISE EXCEPTION 'overseer control event duplicate genesis';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM overseer_control_events previous
    WHERE previous.resource_kind = NEW.resource_kind
      AND previous.resource_key = NEW.resource_key
      AND previous.event_sequence = NEW.event_sequence - 1
      AND previous.event_digest = NEW.previous_event_digest
  ) THEN
    RAISE EXCEPTION 'overseer control event predecessor mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS overseer_control_events_validate_chain ON overseer_control_events;
CREATE TRIGGER overseer_control_events_validate_chain
BEFORE INSERT ON overseer_control_events
FOR EACH ROW EXECUTE FUNCTION overseer_control_validate_event_chain();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'overseer_parent_commitments',
    'overseer_parent_children',
    'overseer_repository_mutation_leases',
    'overseer_verifier_registries',
    'overseer_verifier_entries',
    'overseer_fusion_budget_reservations',
    'overseer_control_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_reject_delete ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_reject_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION overseer_control_reject_delete()',
      table_name,
      table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'overseer_verifier_registries',
    'overseer_verifier_entries',
    'overseer_control_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_reject_update ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_reject_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION overseer_control_reject_update()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
