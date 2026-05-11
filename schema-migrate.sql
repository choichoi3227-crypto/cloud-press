-- schema-migrate-cf-pages.sql
-- Cloudflare Pages 호스팅 전환을 위한 마이그레이션
-- 실행: wrangler d1 execute cloudpress-db --file=schema-migrate-cf-pages.sql

-- ── users 테이블에 Cloudflare API 토큰/계정 ID 컬럼 추가 ─────────────────
ALTER TABLE users ADD COLUMN cf_api_token  TEXT;
ALTER TABLE users ADD COLUMN cf_account_id TEXT;

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
