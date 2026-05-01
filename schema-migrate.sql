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
