# CloudPress v3.0 — 완전한 서버리스 WordPress 호스팅

> Cloudflare Workers + php-wasm (WebAssembly PHP 8.2) + Supabase Storage + D1

## 아키텍처

```
사용자 요청
    ↓
Cloudflare Workers (worker.js / src/index.js)
    ↓
WordPressEngine (src/wp-engine.js)
    ├── 정적 파일 → Supabase Storage에서 직접 서빙
    ├── KV 페이지 캐시 HIT → 즉시 반환
    └── PHP 파일 → PHP Runner Worker (php-runner.js)
                        ↓
                  php-wasm (WebAssembly PHP 8.2)
                        ↓
                  WordPress 코어 실행
                        ↓
                  DB: Cloudflare D1 (SQLite)
                  파일: Supabase Storage
```

## 빠른 시작

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정 (필수)
```bash
# Supabase 프로젝트 URL (https://xxxx.supabase.co)
wrangler secret put SUPABASE_URL

# Supabase service_role key (Settings > API > service_role)
wrangler secret put SUPABASE_SERVICE_KEY

# JWT 서명 비밀키
wrangler secret put JWT_SECRET
```

### 3. 자동 설정 스크립트 실행
```bash
node scripts/setup.mjs
```

### 또는 수동 배포

```bash
# DB 스키마 초기화
npm run db:remote

# PHP Runner Worker 먼저 배포
npm run deploy:php

# wrangler.toml에서 PHP_RUNNER 서비스 바인딩 주석 해제:
# [[services]]
# binding = "PHP_RUNNER"
# service = "cloudpress-php"

# 메인 Worker 배포
npm run deploy:main
```

## 파일 구조

```
cloud-press/
├── worker.js              ← 메인 Worker (사이트 라우터)
├── php-runner.js          ← PHP Runner Worker (php-wasm 실행)
├── wrangler.toml          ← 메인 Worker 설정
├── wrangler-php.toml      ← PHP Runner Worker 설정
├── package.json
├── schema.sql             ← D1 데이터베이스 스키마
├── schema-migrate.sql     ← DB 마이그레이션
├── src/
│   ├── index.js           ← 플랫폼 API 라우터
│   ├── wp-engine.js       ← WordPress 실행 엔진 ★
│   ├── auth.js            ← JWT 인증
│   └── ...
├── functions/
│   └── api/
│       ├── sites.js       ← 사이트 생성/관리 API ★ (버킷 버그 수정)
│       ├── login.js
│       └── ...
├── wp-content/
│   ├── db.php             ← WordPress → D1 DB 브릿지 ★
│   └── (themes/plugins은 Supabase에 저장)
└── scripts/
    └── setup.mjs          ← 초기 설정 스크립트
```

## 버그 수정 내역 (v2 → v3)

### 🐛 "스토리지 버킷 미할당" 문제 수정

**원인**: `provisionSupabase()` 함수가 `SUPABASE_KEY` 환경변수를 먼저 조회했는데,  
실제로는 `SUPABASE_SERVICE_KEY`라는 이름으로 설정된 경우 `null` 반환 → DB에 `null` 저장

**수정 내용** (`functions/api/sites.js`):
1. `SUPABASE_SERVICE_KEY` 우선 조회, `SUPABASE_KEY` 폴백 추가
2. Supabase 없어도 사이트 생성 후 `status='provisioning'`으로 설정 (재시도 가능)
3. `/api/sites/:id/provision-bucket` 엔드포인트 추가 (수동 버킷 재생성)
4. `supabase_accounts` 기본 계정 자동 등록

**수정 내용** (`hosting-detail.html`):
- `미할당` → `⏳ 자동 생성 중...` (provisioning 상태)
- `provisioning` 상태일 때 4초마다 자동 폴링
- 상태 완료 시 알림 표시

## 환경변수 전체 목록

| 변수명 | 필수 | 설명 |
|--------|------|------|
| `SUPABASE_URL` | ✅ | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_KEY` | ✅ | service_role key |
| `JWT_SECRET` | ✅ | 플랫폼 JWT 서명키 |
| `SUPABASE_MANAGEMENT_TOKEN` | ⬜ | 새 프로젝트 자동 생성 |
| `SUPABASE_ORG_ID` | ⬜ | Supabase 조직 ID |
| `D1_ENDPOINT` | ⬜ | D1 HTTP API 엔드포인트 |
| `D1_TOKEN` | ⬜ | D1 API 토큰 |

## WordPress 파일 저장 위치

| 파일 유형 | 저장 위치 |
|-----------|-----------|
| WordPress 코어 (`wp-load.php` 등) | `supabase_bucket/wp-load.php` |
| 테마 | `supabase_bucket/wp-content/themes/` |
| 플러그인 | `supabase_bucket/wp-content/plugins/` |
| 미디어 업로드 | `supabase_bucket/wp-content/uploads/` |
| wp-config.php | `supabase_bucket/wp-config.php` |
| db.php (drop-in) | `supabase_bucket/wp-content/db.php` |

## 개발 서버

```bash
# 터미널 1: PHP Runner
npm run dev:php

# 터미널 2: 메인 Worker
npm run dev
```
