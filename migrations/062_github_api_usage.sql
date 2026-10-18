CREATE TABLE IF NOT EXISTS github_api_usage (
  hour_bucket TIMESTAMPTZ NOT NULL,
  service TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  permission_fallbacks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, service, pool_id, resource)
);

CREATE TABLE IF NOT EXISTS github_api_pool_state (
  pool_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  "limit" INTEGER,
  remaining INTEGER,
  reset_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pool_id, resource)
);
