-- CloudPress 유료 상품 (CloudPressDB, CP3, CacheCloud)
-- wrangler d1 execute cloudpress-db --file=schema-migrate-products.sql

CREATE TABLE IF NOT EXISTS product_pool_servers (
  id                TEXT PRIMARY KEY,
  product_type      TEXT NOT NULL,
  name              TEXT NOT NULL,
  github_owner      TEXT NOT NULL,
  github_repo       TEXT NOT NULL,
  github_token      TEXT,
  weight            INTEGER NOT NULL DEFAULT 100,
  enabled           INTEGER NOT NULL DEFAULT 1,
  health_status     TEXT NOT NULL DEFAULT 'unknown',
  health_message    TEXT,
  health_checked_at TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_dns_plans (
  id           TEXT PRIMARY KEY,
  product_type TEXT NOT NULL,
  plan_json    TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_product_assignments (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  product_type  TEXT NOT NULL,
  server_id     TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id, product_type)
);

CREATE TABLE IF NOT EXISTS user_product_subscriptions (
  user_id       TEXT NOT NULL,
  product_type  TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',
  status        TEXT NOT NULL DEFAULT 'inactive',
  expires_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_type)
);

CREATE TABLE IF NOT EXISTS cachecloud_sites (
  site_id       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  worker_name   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pool_servers_type ON product_pool_servers(product_type);
CREATE INDEX IF NOT EXISTS idx_assignments_user ON site_product_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_assignments_site ON site_product_assignments(site_id);
