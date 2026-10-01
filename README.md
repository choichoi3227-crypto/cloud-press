# cloud-press

이 저장소는 두 개의 독립적인 프로젝트를 함께 관리합니다.

## 1. 검색/이미지 API (저장소 루트)

Cloudflare Workers / Pages Functions 무료 플랜에 배포 가능한, API 키 없는 **검색 스크래핑 + 주제 조사 + 자체 이미지 생성** 엔드포인트입니다.

- `GET /api/search` — Google + 네이버 검색 결과를 JSON으로 반환
- `POST /api/research` — 검색 결과 기반 주제 조사 JSON
- `GET/POST /api/image` — **스타일별 AI 아트 디렉터**가 주제에 맞는 이미지를 디자인합니다(`image-core.js` + `image-styles.js`). Workers AI 바인딩(`[ai]`)이 필수입니다.

### `/api/image`

요청: `{ topic, style?, research?, prompt?, custom_direction?, width?, height? }`

- `topic` — 이미지에 **제목으로 그려지는 유일한 문구**입니다. 없으면 글자 없는 이미지를 만듭니다.
- `research` — `/api/research` 결과(`actual_meaning` `visual_context` `emotional_tone` `key_visuals` …). AI가 주제 의미를 읽어 색·소재·구도를 정하는 근거입니다.
- `style` — 11종, **스타일마다 지시서의 형식 자체가 다릅니다**(`image-styles.js`).

| style | AI에게 주는 지시서 형식 | 시각 언어(색·오브젝트는 지정하지 않음) |
|---|---|---|
| `poster` | 번호 매긴 ZONE 스펙시트 | 거대한 제목 + 틀 장치 + 가장자리 도형(실제 인쇄 포스터) |
| `minimal` | 규칙집(계율) | 65% 이상 여백, 도형 5개 이하 |
| `typography` | 활자 견본 브리프(기법 T1~T6) | 글자가 곧 그림 |
| `branding` | 캠페인 브리프(포지셔닝/위계/CTA) | 키비주얼 + 카피 + CTA |
| `gradient` | 7단계 레시피 | 메시 그라디언트 + 유리 패널 |
| `infographic` | ASCII 와이어프레임 + 슬롯 | 헤더·번호 카드·형태만 있는 미니 차트 |
| `isometric` | 기하 스펙(투영 수식) | 정확한 30° 등각, 3톤 면 |
| `neon` | 라이트 레시피 | 겹쳐 그린 3겹 발광 선, 어두운 바탕 |
| `papercut` | 레이어 스택 표 | 겹겹의 종이 + 그림자 복제 규칙 |
| `blueprint` | 제도 규격(DS-01) | 방안지·치수선·지시선·표제란 |
| `photo_realistic` | LLM이 영문 사진 프롬프트 작성 → FLUX/SDXL | 글자 없는 사진 |

- **색상·오브젝트는 코드나 스타일이 정하지 않습니다.** 과거의 오브젝트 라이브러리, 스타일별 고정 팔레트, 조립식 폴백 카드는 제거되었습니다.
- **제목은 이미지 안에 정확히 한 번만** 그려집니다(`text_included: true`). 호출자는 canvas 등으로 다시 합성하면 안 됩니다. `svg-audit.js`가 결과를 검수해 제목 누락·오타·중복이면 사유를 알려 재시도하고, 글자가 캔버스를 넘으면 크기를 줄입니다.
- 시도 순서: 1순위 LLM → 같은 LLM(거절 사유 전달) → 2순위 LLM(`SVG_MODELS`로 변경 가능). 모두 실패하면 **기본 카드로 얼버무리지 않고** HTTP 502(`design_failed`)를 돌려줍니다. AI 바인딩이 없으면 503(`ai_binding_missing`).
- 환경 변수(선택): `SVG_MODELS`(쉼표 구분 LLM ID), `IMAGE_BUDGET_MS`(기본 110000), `FORCE_SVG_ONLY`(`true`면 PNG 변환 생략).
- 응답: `{ data_url, mime_type, format, width, height, provider, model_used, style, text_included, fallback_used, attempts }`

상세 내용은 이 디렉토리의 각 소스 파일(`search-core.js`, `research-core.js`, `image-core.js`, `image-styles.js`, `svg-audit.js`, `worker-search.js`, `functions/`)과 `search.html`을 참조하세요. 배포는 루트의 `wrangler.toml`(Worker 이름: `cloudpress-search-endpoint`) 또는 `wrangler-search.toml`을 사용합니다.

```bash
npm install
npx wrangler deploy                          # wrangler.toml 사용
npx wrangler deploy -c wrangler-search.toml  # 독립 배포용 설정
```

## 2. Cloud Press AI 모델 (`ai-models/`)

직접 학습한 두 개의 AI 모델(**Flash Texter** — 텍스트 생성, **Nano-Tech Artist** — 이미지 생성)을 API로 제공하는 별도 프로젝트입니다. Cloudflare Worker(`ai-models/workers/api-gateway`, Worker 이름: `cloud-press-api-gateway`)를 API 게이트웨이로, WordPress를 사용자 대면 사이트(회원가입/로그인/마이페이지)로 사용합니다.

**연동**: Flash Texter는 텍스트 생성 요청이 올 때마다 위 검색/이미지 API 프로젝트의 `/api/research`를 내부적으로 호출해, 검색 기반 최신 정보를 답변의 컨텍스트로 활용합니다 (RAG 방식). 상세 설계는 [`ai-models/docs/14-search-augmented-generation.md`](./ai-models/docs/14-search-augmented-generation.md)를 참조하세요.

자세한 문서는 [`ai-models/README.md`](./ai-models/README.md)를 참조하세요.

```bash
cd ai-models/workers/api-gateway
npm install
npx wrangler deploy
```

## 두 프로젝트의 관계

이름(`cloud-press`)과 검색/조사 기능은 두 프로젝트가 공유하지만, 배포 단위(Worker 이름, `wrangler.toml`)는 완전히 분리되어 있어 서로 독립적으로 배포·운영됩니다. AI 모델 프로젝트가 검색 API를 호출하는 것은 일반적인 HTTP 요청이며, 두 Worker가 하나로 합쳐지지 않습니다.
