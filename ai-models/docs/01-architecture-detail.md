# 상세 아키텍처

## 1. 컴포넌트 목록

| 컴포넌트 | 기술 | 배포 위치 |
|---|---|---|
| 프런트엔드 | 정적 SPA (React/Vite 또는 Astro) | Cloudflare Pages |
| API 게이트웨이 | Hono (TypeScript), Cloudflare Worker | Cloudflare |
| 인증/세션 저장 | Cloudflare D1 (SQLite) | Cloudflare |
| Rate limit/캐시 | Cloudflare KV | Cloudflare |
| 모델 가중치 저장소 | Cloudflare R2 또는 Hugging Face Hub | Cloudflare / HF |
| 추론 서버 | FastAPI (Python) | 별도 VM/컨테이너 호스팅 (Fly.io, Railway, 자체 서버 등) |
| 학습 파이프라인 | Jupyter 노트북 | Google Colab / Kaggle |

## 2. 요청 처리 흐름 (텍스트 생성 예시)

```
1. 사용자가 웹 UI 또는 REST API로 POST /v1/text/generate 요청
        { "prompt": "...", "max_tokens": 128 }
2. Cloudflare Worker(api-gateway)가 요청 수신
   a. API 키 검증 (D1 조회)
   b. Rate limit 체크 (KV: 분당/일당 요청 수)
   c. 입력 검증 (프롬프트 길이, 금칙어 1차 필터)
   d. 캐시 확인 (동일 prompt+params 해시 → KV/Cache API)
      → 캐시 히트 시 즉시 반환, 추론 서버 호출 생략
3. 캐시 미스 시, Worker가 추론 서버로 내부 요청 전달
   POST https://inference.internal/v1/text/generate
   Header: X-Internal-Key: <워커-추론서버 간 공유 비밀키>
4. 추론 서버(FastAPI)가 Flash Texter 모델로 추론 수행
5. 결과를 Worker에 반환
6. Worker가 결과를 캐시에 저장, 사용량 로그를 D1에 기록
7. 사용자에게 최종 응답 반환
```

이미지 생성(`/v1/image/generate`)도 동일한 흐름이며, 응답 payload가 이미지(base64 또는 R2 URL)라는 점만 다릅니다.

## 3. 인증 및 요청 검증을 Worker에서 하는 이유

GPU/CPU 자원은 비싸고 느립니다. 유효하지 않은 요청(키 없음, 쿼터 초과, 비정상 입력)을 추론 서버까지 보내면 자원 낭비입니다. Worker가 **엣지에서 최대한 걸러내고**, 정말 처리해야 할 요청만 추론 서버로 넘기는 것이 이 아키텍처의 핵심입니다.

특히 초기 단계(Colab 무료 GPU, 상시 서버 없음)에서는 추론 서버 자체가 항상 켜져 있지 않을 수 있습니다. 이 경우 Worker는:
- 추론 서버가 꺼져 있으면 202/503과 함께 "잠시 후 다시 시도" 응답
- 또는 요청을 큐(Cloudflare Queues)에 적재하고, 추론 서버가 깨어났을 때 처리하는 비동기 모델로 전환 가능 (단계 2 이후 고려)

## 4. 모델 가중치 배포 흐름

```
Colab에서 학습 완료
   → 체크포인트(.pt / .safetensors)를 Hugging Face Hub 또는 R2에 업로드
   → 추론 서버 재시작 시 최신 체크포인트를 자동 다운로드하여 로드
   → (선택) Worker의 KV에 "현재 서빙 중인 모델 버전" 기록 → /v1/health에서 노출
```

모델 버전 관리는 간단한 시맨틱 버저닝(`flash-texter-v0.1.0`)을 사용합니다.

## 5. 로컬 개발 환경

- Worker: `wrangler dev`로 로컬 실행, D1/KV는 `--local` 플래그로 에뮬레이션
- 추론 서버: 로컬에서 `uvicorn main:app --reload`, GPU 없으면 CPU 모드로 자동 폴백
- 둘을 연결할 때는 `.dev.vars`에 `INFERENCE_SERVER_URL=http://localhost:8000` 설정

## 6. 왜 WordPress를 쓰지 않는가

- 이 프로젝트는 콘텐츠 관리(CMS)가 핵심이 아니라 **API 서비스**입니다. WordPress의 강점(콘텐츠 편집, 플러그인 생태계)이 여기서는 발휘될 자리가 없습니다.
- WordPress는 PHP 런타임과 DB(MySQL)를 상시 구동해야 해서, 순수 API 서비스 대비 서버 비용이 늘어납니다.
- 정적 프런트엔드(Cloudflare Pages, 무료) + Worker API만으로 사용자 인터페이스와 API를 모두 커버할 수 있습니다.
- 향후 블로그/랜딩페이지 등 콘텐츠성 페이지가 필요해지면, 그때는 WordPress 대신 정적 마크다운 기반(Astro content collections 등)으로 대체하는 것을 권장합니다.
