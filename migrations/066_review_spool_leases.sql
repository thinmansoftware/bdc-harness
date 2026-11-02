-- Review spool single-writer lease (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01).
-- One row per review spool. Acquired by one conditional UPSERT (insert, or take
-- over only when expires_at is before the database clock, incrementing
-- fencing_token); renewed and released only by the matching holder and token.
-- Release expires the row instead of deleting it so fencing_token stays monotonic.
CREATE TABLE IF NOT EXISTS review_spool_leases (
  spool_key TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
