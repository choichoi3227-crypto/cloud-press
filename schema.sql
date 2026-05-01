-- CloudPress D1 스키마 (최종)
-- 초기화: wrangler d1 execute cloudpress-db --file=schema.sql

-- ── 사용자 ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    email             TEXT UNIQUE NOT NULL,
    password_hash     TEXT NOT NULL,
    two_factor_secret TEXT,
    cf_global_api_key TEXT,
    cf_email          TEXT,
    role              TEXT DEFAULT 'user',   -- user | admin
    plan              TEXT DEFAULT 'free',   -- free | starter | pro
    created_at        TEXT
);

-- ── 사이트(호스팅) ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    site_name         TEXT NOT NULL,
    primary_domain    TEXT NOT NULL,        -- 내부 임시 도메인 (*.sites.cloudpress.app)
    php_version       TEXT DEFAULT '8.2',
    status            TEXT DEFAULT 'provisioning', -- provisioning|active|suspended|error
    is_throttled      INTEGER DEFAULT 0,
    cache_enabled     INTEGER DEFAULT 1,
    cache_ttl         INTEGER DEFAULT 3600,

    -- Supabase 스토리지 (옵션 — NULL이면 미연결)
    supabase_bucket   TEXT,
    supabase_account  INTEGER,

    -- WordPress 관리자
    wp_admin_user     TEXT,
    wp_admin_pass     TEXT,
    wp_admin_email    TEXT,

    -- MariaDB/MySQL 접속 정보 (WP-CLI 설치용)
    db_name           TEXT,
    db_user           TEXT,
    db_pass           TEXT,
    db_host           TEXT DEFAULT '127.0.0.1',

    -- WP-CLI 설치 스크립트 (서버 에이전트가 실행)
    wp_install_script TEXT,

    created_at        TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ── 도메인 별칭 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT NOT NULL,
    domain        TEXT UNIQUE NOT NULL,
    is_primary    INTEGER DEFAULT 0,
    cf_ssl_status TEXT DEFAULT 'pending',   -- pending | active
    server_ip     TEXT,                     -- 이 도메인이 가리켜야 할 서버 IP
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(site_id) REFERENCES sites(id)
);

-- ── SSH 공개키 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_ssh_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    TEXT NOT NULL,
    key_name   TEXT,
    public_key TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(site_id) REFERENCES sites(id)
);

-- ── PHP 변경 로그 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS php_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    TEXT,
    message    TEXT,
    level      TEXT DEFAULT 'info',
    is_read    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── Supabase 계정 풀 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supabase_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_no   INTEGER UNIQUE,
    supabase_url TEXT,   -- env var 이름 (예: SUPABASE_URL)
    supabase_key TEXT,   -- env var 이름 (예: SUPABASE_KEY)
    used_gb      REAL DEFAULT 0,
    max_gb       REAL DEFAULT 450
);

-- 기본 Supabase 계정 등록 (없으면 insert)
INSERT OR IGNORE INTO supabase_accounts (account_no, supabase_url, supabase_key, max_gb)
VALUES (1, 'SUPABASE_URL', 'SUPABASE_KEY', 450);

-- ── 인덱스 ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sites_user      ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_site     ON domain_aliases(site_id);
CREATE INDEX IF NOT EXISTS idx_domain_domain   ON domain_aliases(domain);
CREATE INDEX IF NOT EXISTS idx_php_logs_site   ON php_logs(site_id);
