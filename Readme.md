# CloudPress v5.0 — WordPress → Astro SSR 자동 변환 + 순수 미러링

> WordPress PHP/JS → Astro SSR(.astro)/TypeScript 자동 변환  
> GitHub 레포 내 SQLite DB + Cloudflare Workers 순수 dist/ 미러링

## 아키텍처

```
GitHub Actions (WordPress 설치 시)
      ↓
1. WordPress 다운로드 + SQLite DB 초기화 (_db/wordpress.db)
2. WordPress PHP → Astro SSR (.astro) 변환  ← 자동
   JavaScript   → TypeScript (.ts) 변환     ← 자동
   (레이아웃·동적기능·색상·스타일 100% 유지)
3. Astro build (Cloudflare adapter) → dist/ 생성
4. dist/ + _db/wordpress.db → GitHub 레포에 커밋
      ↓
Cloudflare Worker = dist/ 파일 100% 미러링
(동적: Astro SSR API Routes가 SQLite DB 직접 처리)
```

## 변환 규칙

| 원본 | 변환 결과 | 보존 항목 |
|------|-----------|-----------|
| `.php` | `.astro` | 레이아웃, 동적 기능, 색상, 스타일, 기능 전부 |
| `.js` (서버) | `.ts` | 타입 추가만, 로직/기능 동일 유지 |
| `DB: D1` | `_db/wordpress.db (SQLite)` | 스키마 동일 |
| `Worker: 복잡한 라우팅` | `Worker: dist/ 순수 미러링` | 기능 동일 |

## 파일 구조

```
cloud-press/
├── worker.js              ← 플랫폼 메인 Worker (대시보드 API)
├── worker-site-mirror.js  ← 사이트별 Worker 템플릿 (dist/ 순수 미러링)
├── wrangler.toml          ← 플랫폼 Worker 설정 (PHP Runner 없음)
├── package.json
├── schema.sql             ← D1 플랫폼 메타데이터 스키마
├── functions/
│   └── api/
│       ├── cf-pages-hosting.js  ← 핵심: WP→Astro 변환 + 프로비저닝
│       ├── github-storage.js    ← GitHub API 헬퍼
│       └── ...
└── src/
    └── index.js           ← 플랫폼 API 라우터
```

## 사이트별 GitHub 레포 구조 (자동 생성)

```
cp-{id}-{site}/
├── astro-site/            ← Astro SSR 프로젝트 (PHP→Astro, JS→TS 변환)
│   ├── src/
│   │   ├── pages/         ← .astro 페이지
│   │   │   ├── index.astro
│   │   │   ├── posts/[slug].astro
│   │   │   └── api/       ← TypeScript API Routes
│   │   ├── layouts/       ← Base.astro 레이아웃
│   │   └── lib/
│   │       └── db.ts      ← SQLite 접근 유틸 (TypeScript)
│   ├── public/            ← 정적 자산 (스타일/이미지)
│   └── astro.config.mjs
├── dist/                  ← Astro 빌드 결과물 (Worker가 미러링)
├── _db/
│   └── wordpress.db       ← SQLite DB (GitHub 레포에 저장)
├── wp-content/            ← WordPress 원본 파일
├── worker.js              ← 순수 미러링 Worker 코드
├── wrangler.toml          ← Worker 배포 설정
└── .github/workflows/
    ├── install-wordpress.yml  ← WP 설치 + Astro 변환 + 빌드
    └── astro-rebuild.yml      ← Astro 재빌드 (콘텐츠 변경 시)
```

## 빠른 시작

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정 (필수)
```bash
# JWT 서명 비밀키
wrangler secret put JWT_SECRET

# GitHub Personal Access Token (repo, workflow 권한)
wrangler secret put GITHUB_TOKEN

# Cloudflare API (선택 — Worker 자동 배포용)
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
```

### 3. DB 초기화 + 배포
```bash
npm run db:remote
wrangler deploy
```

## 환경변수 목록

| 변수명 | 필수 | 설명 |
|--------|------|------|
| `JWT_SECRET` | ✅ | 플랫폼 JWT 서명키 |
| `GITHUB_TOKEN` | ✅ | GitHub PAT (repo+workflow 권한) |
| `CF_API_TOKEN` | ⬜ | Cloudflare API Token (Worker 자동 배포) |
| `CF_ACCOUNT_ID` | ⬜ | Cloudflare 계정 ID |
