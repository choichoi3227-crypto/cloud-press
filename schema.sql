-- CloudPress 핵심 테이블 스키마 (최신)

-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    email            TEXT UNIQUE NOT NULL,
    password_hash    TEXT NOT NULL,
    two_factor_secret TEXT,
    cf_global_api_key TEXT,
    cf_email         TEXT,           -- Cloudflare 계정 이메일 (API 키와 함께 저장)
    role             TEXT DEFAULT 'user',
    plan             TEXT DEFAULT 'free',
    created_at       TEXT
);

-- 사이트(호스팅) 테이블
CREATE TABLE IF NOT EXISTS sites (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    site_name        TEXT NOT NULL,
    primary_domain   TEXT NOT NULL,
    php_version      TEXT DEFAULT '8.2',
    status           TEXT DEFAULT 'provisioning',  -- provisioning, active, suspended, error
    is_throttled     BOOLEAN DEFAULT 0,
    cache_enabled    BOOLEAN DEFAULT 1,
    cache_ttl        INTEGER DEFAULT 3600,

    -- Supabase 스토리지 (옵션 — 미연결 시 NULL)
    supabase_bucket  TEXT,
    supabase_account INTEGER,

    -- SSH / SFTP 접속 정보
    ssh_port         INTEGER,
    sftp_port        INTEGER,

    -- WordPress 관리자 계정
    wp_admin_user    TEXT,
    wp_admin_pass    TEXT,
    wp_admin_email   TEXT,

    -- DB 접속 정보 (WP-CLI 설치 시 활용)
    db_name          TEXT,
    db_user          TEXT,
    db_pass          TEXT,
    db_host          TEXT DEFAULT 'localhost',

    -- WP-CLI 자동 설치 스크립트
    wp_install_script TEXT,

    -- 기타 인프라 정보
    infrastructure_json TEXT,
    backup_infra_json   TEXT,

    created_at       TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- 도메인 별칭
CREATE TABLE IF NOT EXISTS domain_aliases (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id               TEXT NOT NULL,
    domain                TEXT UNIQUE NOT NULL,
    is_primary            BOOLEAN DEFAULT 0,
    cf_custom_hostname_id TEXT,
    cf_ssl_status         TEXT,
    cf_cname_target       TEXT,
    cf_cname_name         TEXT,
    FOREIGN KEY(site_id) REFERENCES sites(id)
);

-- SSH 키
CREATE TABLE IF NOT EXISTS site_ssh_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id    TEXT NOT NULL,
    key_name   TEXT,
    public_key TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(site_id) REFERENCES sites(id)
);

-- 파일 목록
CREATE TABLE IF NOT EXISTS site_files (
    id           INTEGER PRIMARY KEY,
    site_id      TEXT,
    path         TEXT,
    hash         TEXT,
    size         INTEGER,
    bucket_idx   INTEGER,
    tier         TEXT DEFAULT 'MAIN',
    last_accessed DATETIME
);

-- 파일 스냅샷 (백업)
CREATE TABLE IF NOT EXISTS file_snapshots (
    id          INTEGER PRIMARY KEY,
    site_id     TEXT,
    path        TEXT,
    backup_path TEXT,
    bucket_idx  INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- PHP 변경 로그
CREATE TABLE IF NOT EXISTS php_logs (
    id         INTEGER PRIMARY KEY,
    site_id    TEXT,
    message    TEXT,
    level      TEXT DEFAULT 'info',
    is_read    BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Supabase 계정 풀
CREATE TABLE IF NOT EXISTS supabase_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_no   INTEGER,
    project_no   INTEGER,
    supabase_url TEXT,   -- env var 이름 (예: SUPABASE_URL_1)
    supabase_key TEXT,   -- env var 이름 (예: SUPABASE_KEY_1)
    used_gb      REAL DEFAULT 0,
    max_gb       REAL DEFAULT 450
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_aliases_site ON domain_aliases(site_id);
CREATE INDEX IF NOT EXISTS idx_php_logs_site ON php_logs(site_id);
