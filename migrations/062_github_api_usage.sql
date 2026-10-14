CREATE TABLE IF NOT EXISTS github_api_usage (
  hour_bucket TIMESTAMPTZ NOT NULL,
  service TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  rate_limited INTEGER NOT NULL DEFAULT 0 CHECK (rate_limited >= 0),
  permission_fallbacks INTEGER NOT NULL DEFAULT 0 CHECK (permission_fallbacks >= 0),
  PRIMARY KEY (hour_bucket, service, pool_id, resource)
);
CREATE INDEX IF NOT EXISTS idx_github_api_usage_recent ON github_api_usage(hour_bucket DESC);

CREATE TABLE IF NOT EXISTS github_api_pool_state (
  pool_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  "limit" INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (pool_id, resource)
);
