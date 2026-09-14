# 배포 가이드

## 1. 사전 준비

- Cloudflare 계정 (Workers, Pages, D1, KV, R2 사용)
- Node.js 20+, npm
- Python 3.11+
- Hugging Face 계정 (모델 가중치 호스팅용)
- Google 계정 (Colab), Kaggle 계정
- 추론 서버 호스팅 계정 (Fly.io 또는 Railway 등 — 초기 무료/저가 티어로 충분)

## 2. 리포지토리 클론 및 초기 세팅

```bash
git clone https://github.com/choichoi3227-crypto/cloud-press.git
cd cloud-press
```

## 3. 학습 단계 (Colab)

1. `training/flash-texter/train_colab.ipynb`를 Google Colab에서 열기
2. Google Drive 마운트 → `data/prepared/`에 전처리된 데이터 업로드
3. 런타임 유형을 GPU로 설정 (런타임 → 런타임 유형 변경 → T4 GPU)
4. 전체 셀 실행. 체크포인트는 자동으로 Drive에 저장됨
5. 학습 완료 후 `huggingface_hub`로 최종 가중치 업로드 (`02-training-pipeline.md` 4절 참조)
6. `training/nano-tech-artist/train_colab.ipynb`도 동일한 절차로 진행

## 4. 추론 서버 배포 (예: Fly.io 기준)

```bash
cd inference-server
flyctl launch --no-deploy   # fly.toml 생성, 앱 이름 지정
flyctl secrets set INTERNAL_API_KEY=<Worker와 동일한 값>
flyctl secrets set HF_TOKEN=<huggingface 토큰>
flyctl deploy
```

배포 후 `https://<app-name>.fly.dev/v1/health`로 정상 기동 확인.

## 5. Cloudflare Worker 배포

```bash
cd workers/api-gateway
npm install
npx wrangler login

# D1 데이터베이스 생성
npx wrangler d1 create cloud-press-db
# → 출력된 database_id를 wrangler.toml에 반영
npx wrangler d1 execute cloud-press-db --file=./src/db/schema.sql

# KV 네임스페이스 생성
npx wrangler kv namespace create RATE_LIMIT_KV
npx wrangler kv namespace create CACHE_KV
# → 출력된 id들을 wrangler.toml에 반영

# 시크릿 설정
npx wrangler secret put INTERNAL_API_KEY
# (추론 서버에 설정한 것과 동일한 값 입력)

# 환경변수(vars)의 INFERENCE_SERVER_URL을 실제 추론 서버 주소로 수정 후:
npx wrangler deploy
```

**WordPress 연동 시 추가 시크릿**: WordPress(`wordpress/cloud-press-connector`, `wordpress/cloud-press-deploy`)를 함께 운영한다면 `ADMIN_SECRET`, `DEPLOY_PROXY_KEY`, `GITHUB_TOKEN`도 필요합니다. 하나씩 `wrangler secret put`을 치는 대신 아래 스크립트로 한 번에 처리할 수 있습니다.

```bash
cd workers/api-gateway
../../scripts/setup-worker-secrets.sh
```

이 스크립트는 각 시크릿에 대해 값을 직접 입력하거나(Enter만 누르면) 안전한 무작위 값을 자동 생성해 `wrangler secret put`으로 즉시 설정합니다. 자동 생성된 값은 화면에 한 번 출력되므로, 그 값을 그대로 `wp-config.php`의 대응 상수에 복사해야 합니다 (Worker와 WordPress가 같은 시크릿 값을 공유해야 인증이 성립합니다).

### 5.1 배포 전 로컬 통합 테스트 (권장)

실제 Cloudflare 계정 없이도 Worker + 추론 서버 전체 흐름을 로컬에서 검증할 수 있습니다. D1/KV는 `--local` 플래그로 로컬 SQLite/파일 기반으로 시뮬레이션됩니다.

```bash
# 1) 추론 서버를 먼저 기동 (터미널 1)
cd inference-server
export INTERNAL_API_KEY=<임의의-테스트-키>
export LOCAL_FLASH_TEXTER_PATH=<학습된 flash_texter_final.pt 경로>
export LOCAL_NANO_TECH_ARTIST_PATH=<학습된 generator_final.pt 경로>
python3 -m uvicorn main:app --host 127.0.0.1 --port 8000

# 2) 로컬 D1 스키마 적용 + 테스트 API 키 삽입 (터미널 2)
cd workers/api-gateway
npx wrangler d1 execute cloud-press-db --local --file=./src/db/schema.sql
python3 -c "import hashlib; print(hashlib.sha256(b'my-test-key').hexdigest())"
npx wrangler d1 execute cloud-press-db --local --command="INSERT INTO api_keys (id, key_hash, owner_email, plan, created_at, revoked) VALUES ('key1', '<위에서 나온 해시>', 'test@example.com', 'free', 1735689600, 0);"

# 3) Worker를 로컬로 기동 (INTERNAL_API_KEY는 .dev.vars에 추론 서버와 동일한 값으로)
echo "INTERNAL_API_KEY=<1번과 동일한 값>" > .dev.vars
npx wrangler dev --local --port 8787

# 4) 검증
curl http://127.0.0.1:8787/v1/health
curl -X POST http://127.0.0.1:8787/v1/text/generate \
  -H "Authorization: Bearer my-test-key" -H "Content-Type: application/json" \
  -d '{"prompt":"안녕하세요"}'
```

**실제 검증 결과 (2026년 기준)**: 이 절차로 Worker→D1 인증→KV rate limit→추론 서버 프록시→실제 학습된 모델까지 전체 체인이 정상 작동함을 확인했습니다. Free tier 요청 한도(분당 20건)를 초과하는 트래픽을 보냈을 때 429가 정확히 반환되는 것도 확인했습니다.

**알려진 이슈**: wrangler 3.x는 `compatibility_date`가 "2025-07-18" 이후인 값을 로컬 런타임이 지원하지 않아 자동으로 낮춰지는 경고가 발생합니다. `package.json`은 wrangler 4.x를 사용하도록 설정되어 있으니, `npm install` 시 최신 버전이 설치되는지 확인하세요 (`npx wrangler --version`).

## 6. 프런트엔드 배포 (Cloudflare Pages)

`frontend/src/`는 정적 HTML/CSS/JS로만 이루어진 데모 페이지입니다. 빌드 과정이 없어 그대로 배포합니다.

```bash
cd frontend/src
# config.js에서 API_BASE_URL을 실제 Worker 도메인으로, DEMO_API_KEY를
# 공개용으로 발급한 낮은 rate limit의 키로 교체한 뒤:
npx wrangler pages deploy . --project-name=cloud-press
```

**CORS**: Worker(`workers/api-gateway`)는 `hono/cors` 미들웨어로 모든 `/v1/*` 경로에 CORS를 허용하도록 구성되어 있습니다 (`src/index.ts`). 프런트엔드가 Worker와 다른 도메인(Pages 도메인과 Workers 도메인은 보통 다릅니다)에서 호출해도 정상 동작하며, 이는 로컬 통합 테스트에서 실제 브라우저 요청과 동일한 조건(Origin 헤더 포함, preflight OPTIONS 요청 포함)으로 검증했습니다.

**주의**: `config.js`에 들어가는 API 키는 브라우저에 그대로 노출됩니다. 반드시 관리자 키가 아닌, 낮은 rate limit의 공개 데모 전용 키를 발급해 사용하세요.

## 7. 배포 후 확인 체크리스트

- [ ] `GET https://<worker-domain>/v1/health` → 200, 추론 서버 상태 포함
- [ ] `POST /v1/text/generate` (유효 API 키) → 정상 응답
- [ ] `POST /v1/text/generate` (유효하지 않은 키) → 401
- [ ] Rate limit 초과 시 429 반환 확인
- [ ] 동일 요청 재전송 시 캐시 히트로 응답 시간 단축 확인
- [ ] 추론 서버를 의도적으로 내려본 뒤 Worker가 적절한 에러(503 등)를 반환하는지 확인

## 8. 도메인 연결

- Worker: `api.<yourdomain>.com` → Cloudflare DNS에서 CNAME/Worker 라우트 설정
- 추론 서버: 별도 서브도메인(`inference.<yourdomain>.com`) 연결 후, **가능하면 Cloudflare 앞단을 거치지 않고 직접 노출하지 말고, Cloudflare Tunnel 또는 방화벽 규칙으로 Worker의 IP 대역에서만 접근 가능하도록 제한** (내부 API 키만으로는 완전하지 않으므로 IP 화이트리스트 병행 권장)

## 9. WordPress 배포 (테마 + 플러그인)

전제: PHP+MySQL이 상시 구동 중인 호스팅이 이미 준비되어 있어야 합니다 (`docs/10-wordpress-architecture.md` 참조).

### 9.1 파일 업로드

```bash
# 로컬에서 WordPress 서버로 (예: rsync, 또는 호스팅사가 제공하는 배포 도구 사용)
rsync -avz wordpress/cloud-press-theme/     user@server:/var/www/html/wp-content/themes/cloud-press-theme/
rsync -avz wordpress/cloud-press-connector/ user@server:/var/www/html/wp-content/plugins/cloud-press-connector/
rsync -avz wordpress/cloud-press-deploy/    user@server:/var/www/html/wp-content/plugins/cloud-press-deploy/
```

이후 `wp-admin` → 외모(테마)에서 "Cloud Press Theme" 활성화, 플러그인 메뉴에서 "Cloud Press Connector"와 "Cloud Press Deploy" 활성화.

### 9.2 wp-config.php 상수 설정

`wp-config.php`(WordPress 설치 루트)에 다음을 추가합니다.

```php
define('CP_WORKER_PUBLIC_URL', 'https://api.yourdomain.com');
define('CP_WORKER_ADMIN_URL', 'https://api.yourdomain.com');
define('CP_WORKER_ADMIN_SECRET', '<setup-worker-secrets.sh 실행 시 나온 ADMIN_SECRET 값>');
define('CP_DEPLOY_PROXY_KEY', '<동일 스크립트에서 나온 DEPLOY_PROXY_KEY 값>');
define('CP_DEPLOY_RELEASES_DIR', '/var/www/cloud-press/releases');
define('CP_DEPLOY_LIVE_LINK', '/var/www/cloud-press/live');
```

`CP_DEPLOY_RELEASES_DIR`, `CP_DEPLOY_LIVE_LINK`는 WordPress 설치 경로 바깥에 별도로 마련하는 것을 권장합니다 (배포 스테이징이 WordPress 코어 파일과 섞이지 않도록). 두 경로 모두 PHP 프로세스가 쓰기 가능한 권한이어야 합니다.

### 9.3 설정 검증

상수를 다 채운 뒤, 실제로 빠진 게 없는지 스크립트로 확인합니다.

```bash
php scripts/wp-config-check.php
# 또는 wp-config.php 경로가 다르면:
CP_WP_CONFIG_PATH=/path/to/wp-config.php php scripts/wp-config-check.php
```

누락되거나 형식이 잘못된 상수가 있으면 구체적으로 어떤 값이 문제인지, 어떻게 고쳐야 하는지 출력됩니다. 모든 항목이 `[정상]`으로 나오고 exit code가 0이어야 다음 단계로 넘어갑니다.

### 9.4 화이트리스트 최초 설정

`wrangler.toml`의 `DEPLOY_REPO_WHITELIST`와 WordPress의 화이트리스트(`cloud-press-deploy` 관리자 화면에 표시됨, 최초 활성화 시 자동으로 `choichoi3227-crypto/cloud-press`로 초기화됨)가 일치하는지 확인합니다. 배포 대상 저장소를 추가/변경해야 한다면, `docs/12-github-deploy-plugin-spec.md` 3절에 설명한 대로 이 변경 자체도 다중 승인 대상입니다.

### 9.5 배포 후 확인 체크리스트 (WordPress)

- [ ] 회원가입 폼(`[cp_register_form]` 숏코드가 삽입된 페이지)에서 실제 가입 시도 → 계정 생성 확인
- [ ] 가입 직후 Worker의 D1 `api_keys` 테이블에 해당 사용자 키가 실제로 등록되었는지 확인 (`wrangler d1 execute cloud-press-db --command="SELECT owner_email FROM api_keys;"`)
- [ ] 로그인 후 `/mypage/`에서 마이페이지 콘솔이 정상 렌더링되는지 확인
- [ ] 마이페이지 콘솔에서 텍스트/이미지 생성 요청 → 실제 Worker 응답이 오는지 확인
- [ ] 관리자 화면 → Cloud Press 배포 메뉴에서 새 배포 요청 등록 → 스테이징 다운로드까지는 되지만 아직 반영되지 않았는지 확인
- [ ] 관리자 계정 1개로 승인 시도 → 아직 배포되지 않음(추가 승인 필요 메시지) 확인
- [ ] 서로 다른 관리자 계정 2개로 승인 → 이 시점에 실제로 `live` 심볼릭 링크가 갱신되는지 확인
- [ ] 배포 완료 후 "업데이트 노트" 포스트가 자동 생성되었는지 확인
