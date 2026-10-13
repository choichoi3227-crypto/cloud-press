# 13. 엣지 폴백 가이드 (초보자용, Cloudflare 무료 플랜 기준)

추론 서버가 꺼지거나 오류(5xx)가 나도 이미지 생성 API(`/v1/image/generate`, 색·도형 조건)가
**계속 이미지를 돌려주게** 하는 기능입니다. 미리 만들어 둔 이미지에서 한 장을 골라 반환하므로
Cloudflare **무료 플랜(요청당 CPU 10ms)** 에서도 동작합니다. (측정: 선택 로직 CPU ≈ 0.01ms)

> GAN 학습은 필요 없습니다. 학습 데이터와 같은 방식으로 도형을 그려서 뱅크를 만듭니다.
> 나중에 GAN을 학습하면 같은 명령에 `--weights`만 붙여 교체할 수 있습니다.

## 준비물
- Node.js 18+ , Python 3.10+ (`pip install pillow numpy`)
- Cloudflare 계정, 이미 배포된 `api-gateway` Worker (docs/07 참고)

## 1단계 — 패치 적용 (최초 1회)
저장소 최상위(`cloud-press-main/`)에서:
```bash
git apply 0002-edge-fallback-cgan.patch
```

## 2단계 — 이미지 뱅크 만들기
```bash
cd ai-models/training/nano-tech-artist
python build_edge_bank.py --per-class 48 --out edge-bank-bulk.json
```
`18 keys` 라고 나오면 성공입니다. (이미 받은 `edge-bank-bulk.json`이 있으면 이 단계는 건너뛰어도 됩니다.)

## 3단계 — Cloudflare KV에 올리기
```bash
cd ../../workers/api-gateway
npm install
npx wrangler login
npx wrangler kv bulk put ../../training/nano-tech-artist/edge-bank-bulk.json --binding CACHE_KV --remote
```

## 4단계 — 배포
```bash
npx wrangler deploy
```

## 5단계 — 동작 확인
추론 서버가 꺼져 있거나 `INFERENCE_SERVER_URL`이 틀린 상태에서:
```bash
curl -i -X POST https://<워커주소>/v1/image/generate \
  -H "Authorization: Bearer <API키>" -H "Content-Type: application/json" \
  -d '{"prompt_type":"condition","color":"red","shape":"circle"}'
```
`200 OK`, 응답 헤더 `X-Served-By: edge-fallback`, 본문의 `model`이 `nano-tech-artist-edge-bank` 이면 정상입니다.
추론 서버가 정상일 때는 이 헤더가 붙지 않습니다.

## 자주 묻는 것
- **무료 플랜 한도**: KV 읽기 일 10만 회 · 쓰기 일 1천 회 · 저장 1GB. 뱅크는 18개 키(약 0.2MB)라 쓰기 1회로 충분합니다.
- **실시간 생성(`EDGE_LIVE=1`, `EDGE_BACKEND=vgpu`)은 켜지 마세요.** 유료 플랜 전용입니다(CPU 0.2초 / 7초).
- **폴백 대상**: 색·도형 조건 요청(`prompt_type=condition`)만. 텍스트 요청은 폴백 없이 원래 오류를 반환합니다.
- **GAN 결과로 교체**: `export_edge_weights.py`(torch 필요) → `build_edge_bank.py --weights nta-edge-v1.bin` → 3단계 반복. Colab 노트북 6-1~6-3 참고.

## 추론 서버를 Cloudflare Worker로 (선택)
추론 서버 주소 자리에 Cloudflare Worker를 쓰고 싶다면 `ai-models/workers/inference-edge/`를 배포하세요.
이미지 생성은 무료 플랜에서 동작하고, 텍스트 생성은 501을 반환합니다. 자세한 내용은 `workers/inference-edge/README.md`.

## 무료 플랜 한도 요약 (KV 쓰기 주의)
- KV **쓰기 하루 1,000회**: api-gateway의 속도 제한(요청마다 1회)과 응답 캐시가 여기에 쓰입니다. 한도를 넘으면 캐시·속도 제한이 자동으로 꺼지고(fail-open) API는 계속 응답합니다. 요청이 하루 1,000회를 넘을 규모면 Workers Paid($5/월) 또는 D1 기반 카운터로 교체하세요.
- Workers AI **하루 10,000 Neurons**(이미지·텍스트 합산). 자세한 내용과 모델 교체법은 `workers/inference-edge/README.md`.

## 텍스트 모델 LoRA 파인튜닝 (선택)
Workers AI의 LoRA 지원 모델 3종(Gemma 7B / Mistral 7B / Gemma 2B)을 직접 파인튜닝해 쓰려면 `ai-models/training/text-lora/README.md`와 `train_text_lora_colab.ipynb`를 따르세요.
