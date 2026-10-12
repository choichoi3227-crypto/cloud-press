# inference-edge — Cloudflare 위에서 도는 추론 서버 (무료 플랜 안전 모드)

FastAPI 추론 서버(`inference-server/`)와 **같은 API**(`/v1/health`, `/v1/image/generate`, `/v1/text/generate`)를
Cloudflare Worker로 제공합니다. api-gateway는 코드 수정 없이 이 Worker를 추론 서버로 사용할 수 있습니다.

## 무엇을 하고, 무엇을 못 하나

| 기능 | 상태 | 이유 |
|---|---|---|
| 이미지 생성 (색·도형 조건) | ✅ 동작 (무료 플랜 OK) | 미리 만든 이미지 뱅크에서 한 장 선택 → CPU ≈ 0 |
| 이미지 생성 (실시간 GAN) | 유료 플랜 전용, 기본 꺼짐 | 약 0.2초 CPU → 무료 한도(10ms) 초과 |
| 텍스트 생성 (Flash Texter) | ❌ 501 반환 | 모델이 Worker 한도(메모리 128MB, CPU)보다 큼 |
| 텍스트→이미지 | 501 | 원래 미구현(마일스톤 3) |

텍스트까지 운영하려면 `inference-server/`(FastAPI)를 컨테이너/VM(Cloudflare Containers는 유료, 또는 HF Spaces·Fly.io·Tunnel)에 올려야 합니다.

## 배포 (초보자용)

사전 조건: `ai-models/training/nano-tech-artist/`의 `build_edge_bank.py`로 `edge-bank-bulk.json`을 만들어
`CACHE_KV`에 올려 둔 상태 (docs/13-edge-fallback-guide.md 2~3단계). 이 Worker는 api-gateway와 같은 `CACHE_KV`를 공유합니다.

```bash
cd ai-models/workers/inference-edge
npm install
npx wrangler login
npx wrangler secret put INTERNAL_API_KEY     # api-gateway의 INTERNAL_API_KEY와 같은 값을 입력
npx wrangler deploy
```

배포 후 확인:

```bash
curl https://cloud-press-inference-edge.<계정>.workers.dev/v1/health
```
`"nano_tech_artist": {"ready": true}` 이면 뱅크가 로드된 것입니다. `false`면 KV에 뱅크가 없는 것입니다.

## api-gateway와 연결 (둘 중 하나)

**방법 A — URL (가장 간단):** `api-gateway/wrangler.toml`의 `INFERENCE_SERVER_URL`을
`https://cloud-press-inference-edge.<계정>.workers.dev` 로 바꾸고 `npx wrangler deploy`.

**방법 B — 서비스 바인딩 (권장, 공개 URL 불필요):** `api-gateway/wrangler.toml` 맨 아래 `[[services]]` 3줄의 주석을 해제하고 `npx wrangler deploy`.
inference-edge를 **먼저** 배포해야 합니다(없는 Worker를 바인딩하면 deploy 실패). 바인딩이 있으면 `INFERENCE_SERVER_URL`보다 우선합니다.

> `INFERENCE_SERVER_URL`에 api-gateway 자신의 주소를 넣지 마세요 (자기 자신을 호출하는 순환이 생깁니다).

## 확인

```bash
curl -i -X POST https://<api-gateway 주소>/v1/image/generate \
  -H "Authorization: Bearer <API키>" -H "Content-Type: application/json" \
  -d '{"prompt_type":"condition","color":"red","shape":"circle"}'
```
`200`, 본문 `model`이 `nano-tech-artist-edge-bank`이면 정상입니다 (이 경로는 폴백이 아니라 정상 경로이므로 `X-Served-By` 헤더는 없습니다).

## 보안
- `/v1/image/*`, `/v1/text/*`는 `X-Internal-Key`가 `INTERNAL_API_KEY`와 일치해야 합니다(상수 시간 비교). 틀리면 403.
- `/v1/health`만 인증 없이 열려 있습니다(FastAPI 서버와 동일).
- 공개 workers.dev 주소를 쓰는 방법 A보다, 서비스 바인딩(방법 B)이 외부 직접 호출 면적을 줄입니다.

## 유료 플랜에서 실시간 생성 켜기
`wrangler.toml`의 `EDGE_LIVE = "1"` + KV에 `edge-weights:nta:v1`(export_edge_weights.py 결과) 업로드.
뱅크에 해당 클래스가 없을 때만 실시간 생성으로 넘어갑니다. 무료 플랜에서는 켜지 마세요.
