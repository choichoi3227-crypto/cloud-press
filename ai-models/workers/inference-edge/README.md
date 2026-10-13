# inference-edge — Cloudflare 위에서 도는 추론 서버 (무료 플랜 기준)

FastAPI 추론 서버(`inference-server/`)와 **같은 API**(`/v1/health`, `/v1/image/generate`, `/v1/text/generate`)를
Cloudflare Worker로 제공합니다. api-gateway는 코드 수정 없이 이 Worker를 추론 서버로 사용할 수 있습니다.

## 기능 (모두 무료 플랜에서 동작)

| 기능 | 처리 방식 | 무료 플랜 비용 |
|---|---|---|
| 이미지: 색·도형 조건 (`prompt_type=condition`) | 미리 만든 이미지 뱅크에서 선택 | CPU ≈ 0, Workers AI 사용 안 함 |
| 이미지: 자유 문장 (`prompt_type=text`) | **Workers AI — FLUX.1 schnell** (실제 AI 이미지 생성) | Workers AI 한도 사용 |
| 텍스트 생성 (`/v1/text/generate`, `stream` 지원) | **Workers AI — Llama 3.1 8B fast** | Workers AI 한도 사용 |

> Workers AI 모델은 **Cloudflare가 호스팅하는 범용 모델**입니다. 직접 학습한 모델(Nano-Tech Artist cGAN, Flash Texter)이 아니며,
> 직접 학습한 가중치를 Workers AI에 올릴 수는 없습니다. 직접 학습한 모델 서빙은 GPU/컨테이너가 필요합니다(아래 "직접 학습 모델" 참고).

### 무료 한도 (2026년 10월 기준 공식 문서, 변경될 수 있음)
- **Workers AI: 하루 10,000 Neurons** (모든 모델 합산, 매일 00:00 UTC 초기화). 초과하면 이 Worker는 **429 + Retry-After**로 응답합니다.
  - FLUX.1 schnell 단가는 512×512 타일당 4.80 Neurons + 스텝당 9.60 Neurons입니다. 512×512·4스텝이면 이미지 1장 약 43 Neurons로 **하루 200장 안팎**(추정). 해상도가 커지거나 스텝이 늘면 훨씬 줄어듭니다.
  - 정확한 사용량은 Cloudflare 대시보드 → Workers AI에서 확인하세요.
- Workers 요청 하루 10만 회, 요청당 CPU 10ms. KV 읽기 하루 10만 회, **KV 쓰기 하루 1,000회**.
- api-gateway는 같은 프롬프트의 이미지/텍스트(temperature 0)를 KV에 캐시해 Workers AI 한도를 아낍니다.
  KV 쓰기 한도(1,000회/일)를 넘으면 캐시·속도 제한이 **자동으로 건너뛰어지고**(fail-open) 요청 자체는 계속 성공합니다.
- 무료 플랜에서는 일부 리소스가 큰 모델의 접근이 제한될 수 있습니다. **배포 후 실제로 한 번 호출해 확인**하세요(아래 5번).

### 모델 교체
Workers AI 카탈로그는 자주 바뀝니다(구형 모델 폐기 예고 있음). 코드를 고치지 않고 `wrangler.toml`의 `[vars]`에서 바꿉니다.
```toml
IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"
TEXT_MODEL  = "@cf/meta/llama-3.1-8b-instruct-fast"
```
모델 목록: https://developers.cloudflare.com/workers-ai/models/ (한국어 품질이 더 좋은 모델이 있으면 `TEXT_MODEL`만 바꾸면 됩니다.)
`ENABLE_AI = "0"`으로 두면 Workers AI를 끄고(텍스트·자유 문장 이미지는 501) 뱅크 이미지만 제공합니다.

## 배포 (초보자용)

사전 조건: `ai-models/training/nano-tech-artist/`의 `build_edge_bank.py`로 만든 `edge-bank-bulk.json`을
`CACHE_KV`에 올려 둔 상태 (docs/13-edge-fallback-guide.md 2~3단계). 이 Worker는 api-gateway와 같은 `CACHE_KV`를 공유합니다.

```bash
cd ai-models/workers/inference-edge
npm install
npx wrangler login
npx wrangler secret put INTERNAL_API_KEY     # api-gateway의 INTERNAL_API_KEY와 같은 값을 입력
npx wrangler deploy
```

> `wrangler dev`(로컬 실행)에서는 Workers AI 바인딩이 Cloudflare 계정에 원격 접속하므로 `wrangler login`이 필요하고 사용량이 차감됩니다.

## api-gateway와 연결 (둘 중 하나)

**방법 A — URL (가장 간단):** `api-gateway/wrangler.toml`의 `INFERENCE_SERVER_URL`을
`https://cloud-press-inference-edge.<계정>.workers.dev` 로 바꾸고 `npx wrangler deploy`.

**방법 B — 서비스 바인딩 (권장, 공개 URL 불필요):** `api-gateway/wrangler.toml` 맨 아래 `[[services]]` 3줄의 주석을 해제하고 `npx wrangler deploy`.
inference-edge를 **먼저** 배포해야 합니다(없는 Worker를 바인딩하면 deploy 실패). 바인딩이 있으면 `INFERENCE_SERVER_URL`보다 우선합니다.

> `INFERENCE_SERVER_URL`에 api-gateway 자신의 주소를 넣지 마세요 (자기 자신을 호출하는 순환이 생깁니다).

## 동작 확인 (배포 후 순서대로)

```bash
GW=https://<api-gateway 주소>; KEY=<API키>

# 1) 상태: workers_ai.enabled 와 nano_tech_artist.ready 가 true 인지
curl $GW/v1/health

# 2) 조건 이미지 (뱅크)
curl -s -X POST $GW/v1/image/generate -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt_type":"condition","color":"red","shape":"circle"}' | head -c 200

# 3) 자유 문장 이미지 (Workers AI) — 응답 model 이 flux-1-schnell, format 이 jpeg
curl -s -X POST $GW/v1/image/generate -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt_type":"text","prompt":"a cozy desk with a laptop, blog thumbnail, flat illustration"}' | head -c 200

# 4) 텍스트
curl -s -X POST $GW/v1/text/generate -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"블로그 글 제목 5개 추천해줘","max_tokens":200}'

# 5) 3·4번이 502/503이면: 대시보드 → Workers AI 에서 모델 접근/한도를 확인하고 wrangler.toml의 IMAGE_MODEL/TEXT_MODEL 교체
```
`response.image_base64`를 `data:image/jpeg;base64,...`로 붙이면 브라우저에서 바로 볼 수 있습니다.

## 오류 코드
| 코드 | 의미 |
|---|---|
| 403 | `X-Internal-Key`(= `INTERNAL_API_KEY`) 불일치 |
| 422 | 요청 형식 오류(빈 prompt 등) |
| 429 | Workers AI 일일 무료 한도 소진 (`Retry-After`초 뒤 재시도, 00:00 UTC에 초기화) |
| 501 | Workers AI가 꺼져 있음(`[ai]` 바인딩 없음 또는 `ENABLE_AI=0`) |
| 502/503 | Workers AI 호출 오류 / 설정한 모델이 없음 → 모델 ID 교체 |

## 보안
- `/v1/image/*`, `/v1/text/*`는 `X-Internal-Key`가 `INTERNAL_API_KEY`와 일치해야 합니다(상수 시간 비교).
- `/v1/health`만 인증 없이 열려 있습니다(FastAPI 서버와 동일).
- 방법 B(서비스 바인딩)가 공개 workers.dev 주소를 쓰는 방법 A보다 외부 직접 호출 면적이 작습니다.

## 직접 학습한 모델을 쓰려면 (유료/외부 필요)
- Nano-Tech Artist(cGAN) 실시간 생성: `EDGE_LIVE=1` + `edge-weights:nta:v1` — CPU 0.2초라 **유료 플랜 전용**.
- 직접 학습/파인튜닝한 이미지 모델(LoRA 등)이나 Flash Texter: GPU가 있는 곳(Cloudflare Containers=유료, Hugging Face Spaces, 자체 서버)에서
  `inference-server/`를 돌리고 api-gateway의 `INFERENCE_SERVER_URL`을 그쪽으로 지정하세요.
