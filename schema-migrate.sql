-- CloudPress 마이그레이션 스크립트 (기존 DB → v2)
-- 실행: wrangler d1 execute cloudpress-db --file=schema-migrate.sql
-- ⚠️ 이미 컬럼이 있으면 오류가 발생할 수 있습니다. 오류는 무시해도 됩니다.

-- sites 테이블에 CF 리소스 컬럼 추가
ALTER TABLE sites ADD COLUMN cf_worker_name TEXT;
ALTER TABLE sites ADD COLUMN cf_d1_id TEXT;
ALTER TABLE sites ADD COLUMN cf_kv_id TEXT;

-- primary_domain을 NULL 허용으로 (서브도메인 없이 생성 시)
-- D1은 NOT NULL 제약 변경을 직접 지원하지 않으므로, 새 사이트는 빈 문자열로 처리됨

-- domain_aliases에 CF Zone/NS 컬럼 추가
ALTER TABLE domain_aliases ADD COLUMN cf_zone_id TEXT;
ALTER TABLE domain_aliases ADD COLUMN cf_nameservers TEXT;

-- supabase_accounts.account_no를 TEXT로 변환 (프로젝트 ID가 문자열일 수 있음)
-- D1은 타입 변경을 지원하지 않으므로 기존 데이터는 그대로 유지

-- 로그 인덱스 추가 (없으면)
CREATE INDEX IF NOT EXISTS idx_php_logs_read ON php_logs(site_id, is_read);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);

-- ── v3 마이그레이션 (admin_settings 테이블 추가) ────────────────────────────
-- 실행: wrangler d1 execute cloudpress-db --remote --file=schema-migrate.sql
CREATE TABLE IF NOT EXISTS admin_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- admin_settings 기본값 삽입 (없는 경우만)
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('platform_domain', 'cloudpress.app');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('smtp_from', 'noreply@cloudpress.app');

-- ── v4 마이그레이션 (payments 테이블 + sites 플랜 컬럼) ─────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  site_id          TEXT NOT NULL,
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

ALTER TABLE sites ADD COLUMN site_plan TEXT DEFAULT 'free';
ALTER TABLE sites ADD COLUMN plan_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_user   ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_site   ON payments(site_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ── v5 마이그레이션 (GitHub repo 컬럼 + github_tokens 테이블) ─────────────
-- sites 테이블에 GitHub repo 컬럼 추가
ALTER TABLE sites ADD COLUMN github_repo_owner TEXT;
ALTER TABLE sites ADD COLUMN github_repo_name  TEXT;

-- GitHub 토큰 풀 테이블 (관리자가 여러 토큰 등록 가능)
CREATE TABLE IF NOT EXISTS github_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL,
  masked_token TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── v6 마이그레이션 (CMS 배포 지원) ─────────────────────────────────────────
-- sites 테이블에 CMS Worker 이름 컬럼 추가
ALTER TABLE sites ADD COLUMN cms_worker_name TEXT;

-- CMS 설정 테이블 (관리자 설정 페이지에서 관리)
CREATE TABLE IF NOT EXISTS cms_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- CMS zip 청크 저장 테이블 (D1 blob 한도 ~1MB → 청크 분할 저장)
CREATE TABLE IF NOT EXISTS cms_zip_chunks (
  chunk_index INTEGER NOT NULL,
  data        TEXT    NOT NULL,
  PRIMARY KEY (chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_sites_cms_worker ON sites(cms_worker_name);
