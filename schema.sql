-- 핵심 테이블 스키마
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, two_factor_secret TEXT, cf_global_api_key TEXT);
CREATE TABLE sites (
    id TEXT PRIMARY KEY, user_id TEXT, site_name TEXT, primary_domain TEXT, 
    php_version TEXT DEFAULT '8.2', status TEXT DEFAULT 'active', 
    is_throttled BOOLEAN DEFAULT 0, infrastructure_json TEXT, backup_infra_json TEXT
);
CREATE TABLE domain_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT,
  domain TEXT UNIQUE,
  is_primary BOOLEAN,
  cf_custom_hostname_id TEXT, -- Cloudflare Custom Hostname ID
  cf_ssl_status TEXT,         -- pending, active, failed
  cf_cname_target TEXT,       -- CNAME target for verification
  cf_cname_name TEXT,         -- CNAME name for verification
  FOREIGN KEY(site_id) REFERENCES sites(id)
);
CREATE TABLE site_files (
    id INTEGER PRIMARY KEY, site_id TEXT, path TEXT, hash TEXT, size INTEGER, 
    bucket_idx INTEGER, tier TEXT DEFAULT 'MAIN', last_accessed DATETIME
);
CREATE TABLE file_snapshots (
    id INTEGER PRIMARY KEY, site_id TEXT, path TEXT, backup_path TEXT, 
    bucket_idx INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE php_logs (id INTEGER PRIMARY KEY, site_id TEXT, message TEXT, is_read BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, two_factor_secret TEXT, cf_global_api_key TEXT, role TEXT DEFAULT 'user');
-- ... 기존 스키마 ...
