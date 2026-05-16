-- schema-migrate-cf-pages.sql
-- Cloudflare Pages 호스팅 전환을 위한 마이그레이션
-- 실행: wrangler d1 execute cloudpress-db --file=schema-migrate-cf-pages.sql

-- ── users 테이블에 Cloudflare API 토큰/계정 ID 컬럼 추가 ─────────────────
ALTER TABLE users ADD COLUMN cf_api_token  TEXT;
ALTER TABLE users ADD COLUMN cf_account_id   TEXT;
ALTER TABLE users ADD COLUMN cf_account_name TEXT;

-- ── sites 테이블에 Cloudflare Pages 정보 컬럼 추가 ───────────────────────
ALTER TABLE sites ADD COLUMN cf_pages_url     TEXT;
ALTER TABLE sites ADD COLUMN cf_pages_project TEXT;
ALTER TABLE sites ADD COLUMN cf_worker_name   TEXT;
ALTER TABLE sites ADD COLUMN cf_d1_id         TEXT;
ALTER TABLE sites ADD COLUMN cf_kv_id         TEXT;

-- ── payment_cards 테이블 생성 (없으면) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_cards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    billing_key TEXT NOT NULL,
    card_name   TEXT NOT NULL DEFAULT '카드',
    brand       TEXT NOT NULL DEFAULT '',
    last4       TEXT NOT NULL DEFAULT '',
    exp_month   TEXT NOT NULL DEFAULT '',
    exp_year    TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── 기존 GitHub Pages 상태를 Cloudflare Pages로 업데이트 ─────────────────
-- (pending_domain 상태 사이트는 그대로 유지)
UPDATE sites SET status = 'active' WHERE status = 'pending_domain';

-- ── php_logs 테이블 누락 컬럼 추가 ──────────────────────────────────────────
ALTER TABLE php_logs ADD COLUMN level   TEXT DEFAULT 'info';
ALTER TABLE php_logs ADD COLUMN is_read INTEGER DEFAULT 0;

-- ── file_snapshots 테이블 추가 (백업 기능) ────────────────────────────────
CREATE TABLE IF NOT EXISTS file_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id       TEXT NOT NULL,
    backup_path   TEXT,
    snapshot_type TEXT DEFAULT 'manual',
    label         TEXT,
    size          INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_site ON file_snapshots(site_id);

-- ── notices 테이블 추가 (공지사항) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    type       TEXT DEFAULT 'info',
    is_active  INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
