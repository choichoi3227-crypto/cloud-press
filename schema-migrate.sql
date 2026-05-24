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
    path          TEXT NOT NULL DEFAULT '',
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

-- ── file_snapshots.path 컬럼 추가 (기존 DB 마이그레이션) ──────────────────
-- 이미 테이블이 있고 path 컬럼이 없는 경우 실행
-- ALTER TABLE file_snapshots ADD COLUMN path TEXT NOT NULL DEFAULT '';

-- ── sites 테이블에 플랜/사용량 컬럼 추가 (없으면) ────────────────────────────
-- 이미 있을 경우 오류가 나도 무시
-- wrangler d1 execute cloudpress-db --command="ALTER TABLE sites ADD COLUMN plan TEXT DEFAULT 'free'"
-- wrangler d1 execute cloudpress-db --command="ALTER TABLE sites ADD COLUMN storage_used_mb REAL DEFAULT 0"
-- wrangler d1 execute cloudpress-db --command="ALTER TABLE sites ADD COLUMN traffic_used_mb REAL DEFAULT 0"

-- ── payments 테이블 생성 / site_id NOT NULL 에러 수정 ─────────────────────
-- 기존 테이블에 site_id가 NOT NULL로 설정된 경우를 위해 재생성
CREATE TABLE IF NOT EXISTS payments (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    site_id          TEXT,
    product_type     TEXT NOT NULL DEFAULT 'hosting',
    plan             TEXT NOT NULL,
    billing_cycle    TEXT NOT NULL DEFAULT 'monthly',
    amount           INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    toss_order_id    TEXT UNIQUE,
    toss_payment_key TEXT,
    toss_receipt_url TEXT,
    expires_at       TEXT,
    created_at       TEXT DEFAULT CURRENT_TIMESTAMP
);

-- user_product_subscriptions 테이블 생성 (없으면)
CREATE TABLE IF NOT EXISTS user_product_subscriptions (
    user_id      TEXT NOT NULL,
    product_type TEXT NOT NULL,
    plan         TEXT NOT NULL DEFAULT 'basic',
    status       TEXT NOT NULL DEFAULT 'inactive',
    expires_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, product_type)
);


