-- CloudPress D1 스키마 (최종 v2)
-- 초기화: wrangler d1 execute cloudpress-db --file=schema.sql
-- 기존 DB 마이그레이션: schema-migrate.sql 참고

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
    primary_domain    TEXT,                  -- 커스텀 도메인 연결 전까지 NULL 가능
    php_version       TEXT DEFAULT '8.2',
    status            TEXT DEFAULT 'provisioning', -- provisioning|active|suspended|error
    is_throttled      INTEGER DEFAULT 0,
    cache_enabled     INTEGER DEFAULT 1,
    cache_ttl         INTEGER DEFAULT 3600,

    -- Supabase 스토리지 (자동 프로비저닝)
    supabase_bucket   TEXT,
    supabase_account  TEXT,                  -- account_no 또는 프로젝트 ID

    -- WordPress 관리자
    wp_admin_user     TEXT,
    wp_admin_pass     TEXT,
    wp_admin_email    TEXT,

    -- DB 접속 정보 (D1 사용 시 참고용)
    db_name           TEXT,
    db_user           TEXT,
    db_pass           TEXT,
    db_host           TEXT DEFAULT '127.0.0.1',

    -- Cloudflare 자동 생성 리소스
    cf_worker_name    TEXT,                  -- Workers 스크립트 이름
    cf_d1_id          TEXT,                  -- D1 데이터베이스 UUID
    cf_kv_id          TEXT,                  -- KV 네임스페이스 ID

    -- GitHub 저장소 (wp-content 전용)
    github_repo_owner TEXT,
    github_repo_name  TEXT,

    -- WP-CLI 설치 스크립트 (레거시 서버 에이전트용)
    wp_install_script TEXT,

    created_at        TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ── 도메인 별칭 ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_aliases (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id          TEXT NOT NULL,
    domain           TEXT UNIQUE NOT NULL,
    is_primary       INTEGER DEFAULT 0,
    cf_ssl_status    TEXT DEFAULT 'pending',   -- pending | active
    cf_zone_id       TEXT,                     -- Cloudflare Zone ID
    cf_nameservers   TEXT,                     -- 쉼표 구분 CF 네임서버 목록
    server_ip        TEXT,                     -- 레거시 A레코드 방식 (미사용)
    created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
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

-- ── PHP / 시스템 로그 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS php_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    TEXT,
    message    TEXT,
    level      TEXT DEFAULT 'info',   -- info | warning | error
    is_read    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── Supabase 계정 풀 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supabase_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_no   TEXT UNIQUE,          -- account_no 또는 Supabase 프로젝트 ID
    supabase_url TEXT,                 -- 직접 URL 또는 env var 이름
    supabase_key TEXT,                 -- 직접 KEY 또는 env var 이름
    used_gb      REAL DEFAULT 0,
    max_gb       REAL DEFAULT 450
);

-- 기본 Supabase 계정 등록 (없으면 insert)
INSERT OR IGNORE INTO supabase_accounts (account_no, supabase_url, supabase_key, max_gb)
VALUES ('1', 'SUPABASE_URL', 'SUPABASE_KEY', 450);

-- ── 인덱스 ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sites_user      ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_status    ON sites(status);
CREATE INDEX IF NOT EXISTS idx_domain_site     ON domain_aliases(site_id);
CREATE INDEX IF NOT EXISTS idx_domain_domain   ON domain_aliases(domain);
CREATE INDEX IF NOT EXISTS idx_php_logs_site   ON php_logs(site_id);
CREATE INDEX IF NOT EXISTS idx_php_logs_read   ON php_logs(site_id, is_read);

-- ── 기존 DB 마이그레이션 (ALTER TABLE) ─────────────────────────────────────
-- 이미 DB가 있는 경우 아래 구문을 wrangler d1 execute 로 별도 실행
-- (CREATE TABLE IF NOT EXISTS는 이미 있으면 무시하므로 안전)
--
-- ALTER TABLE sites ADD COLUMN cf_worker_name TEXT;
-- ALTER TABLE sites ADD COLUMN cf_d1_id TEXT;
-- ALTER TABLE sites ADD COLUMN cf_kv_id TEXT;
-- ALTER TABLE domain_aliases ADD COLUMN cf_zone_id TEXT;
-- ALTER TABLE domain_aliases ADD COLUMN cf_nameservers TEXT;

-- ── GitHub 토큰 풀 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS github_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL,
  masked_token TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT DEFAULT CURRENT_TIMESTAMP
);
