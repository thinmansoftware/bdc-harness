CREATE TABLE IF NOT EXISTS known_bad_bindings (
  id                    TEXT PRIMARY KEY,
  binding_key           TEXT NOT NULL UNIQUE,
  provider_id           TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  auth_context_id       TEXT NOT NULL,
  assistant_config_hash TEXT NOT NULL,
  node_override_hash    TEXT NOT NULL DEFAULT '',
  error_class           TEXT NOT NULL,
  http_status           INTEGER,
  error_body_excerpt    TEXT NOT NULL,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  hit_count             INTEGER NOT NULL DEFAULT 1,
  source                TEXT NOT NULL,
  cleared_at            TEXT,
  clear_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_known_bad_bindings_provider_model
  ON known_bad_bindings (provider_id, model_id);

CREATE INDEX IF NOT EXISTS idx_known_bad_bindings_active
  ON known_bad_bindings (binding_key) WHERE cleared_at IS NULL;
