# cloud-press

Cloudflare Workers / Pages Functions 무료 플랜에 배포 가능한, API 키 없는 **검색 스크래핑 + 주제 조사 + 자체 이미지 생성** 엔드포인트입니다.

- Google + 네이버 검색 결과를 URL 요청만으로 JSON으로 반환
- 검색 결과를 바탕으로 한 "주제 조사" JSON(`/api/research`) — WordPress 플러그인 등에서 기존 Groq 기반 워커를 대체
- `/api/image`는 썸네일/포스터 이미지를 2단계로 생성합니다:
  1. **AI 이용** — Cloudflare Workers AI 바인딩(`env.AI`)이 있으면 `@cf/black-forest-labs/flux-1-schnell`을 요청당 **딱 1회만** 호출해 실제 텍스트→이미지 생성을 시도합니다(재시도 없음, 뉴런 남용 방지).
  2. **헤드리스 브라우저 방식** — AI 호출이 실패하거나 바인딩이 없으면, 워드프레스 플러그인이 로컬 Chrome으로 HTML/CSS 카드를 스크린샷 찍던 것과 동일한 레이아웃(그라디언트 배경·블러 도형·유리질 패널·제목/부제목 타이포그래피)을 워커 안에서 SVG로 직접 합성합니다. 외부 의존성이 전혀 없어 **항상 성공**합니다.
- 이전 버전(v3~v5)의 "절차적 노이즈 BMP 비트맵" 생성기는 완전히 제거되었습니다 — 텍스트/레이아웃 없는 추상 패턴만 나와 실사용 목적(제목이 있는 썸네일 카드)에 맞지 않았기 때문입니다.

## 엔드포인트

### `GET /api/search?q={검색어}&engine=all|google|naver&start=0`
Google/네이버 검색 결과를 스크래핑해 JSON으로 반환합니다. 인증·API 키 불필요.


### `GET/POST /api/image`
```json
{ "prompt": "네온빛 서울 야경과 고양이 로봇", "topic": "서울 야경 여행", "subtitle": "핵심 장면 요약", "style": "poster", "width": 1600, "height": 900 }
```
- `provider: "workers-ai-flux"` — AI 바인딩이 있고 flux 호출이 성공한 경우. `format: "jpeg"`.
- `provider: "headless-card"` — AI 호출이 실패했거나 바인딩이 없는 경우(기본값 없이 배포하면 사실상 항상 이 경로). `format: "svg"`. `topic`/`subtitle`/`style`을 반영한 제목·부제목이 있는 카드가 만들어집니다.
- `style`은 `poster` / `minimal` / `typography` / `branding` / `photo_realistic` 중 하나이며, 각 스타일마다 배경·강조색 테마가 다릅니다.
- 응답에는 항상 `data_url`(브라우저에 바로 표시 가능), `image`/`image_base64`(순수 base64), `mime_type`이 포함됩니다.
- AI 이미지 생성을 쓰려면 `wrangler.toml`의 `[ai] binding = "AI"`가 활성화되어 있어야 합니다(레포 기본값은 활성화되어 있음). 비활성화하면 항상 헤드리스 카드만 반환합니다.

### `POST /api/research`
```json
{ "query": "다이어트 식단", "max_results": 8 }
```
- 헤더 `X-AIBP-Secret`: `wrangler secret put AIBP_SHARED_SECRET`으로 시크릿을 등록한 경우에만 검증합니다(등록하지 않으면 인증 없이 동작).
- 응답에는 검색 원본(`providers`, `summary`, `results`)과 함께, 아래 필드를 가진 `research` 객체가 포함됩니다:
  - `actual_meaning`, `visual_context`, `hero_shot`, `color_mood`, `key_visuals`, `category`, `wrong_interpretation`, `emotional_tone`, `text_color_hex`, `accent_color_hex`

## 배포

```bash
npm install
npx wrangler deploy                       # wrangler.toml 사용
npx wrangler deploy -c wrangler-search.toml  # 독립 배포용 설정
```

Cloudflare Pages(Functions)로 배포하는 경우 `functions/api/search.js`, `functions/api/research.js`가 자동으로 라우팅됩니다.

## Cloudflare Workers AI 바인딩

`wrangler.toml`에 기본으로 `[ai] binding = "AI"`가 활성화되어 있습니다. 이 바인딩은 두 곳에서 쓰입니다:

- `/api/research` — 검색 결과가 있을 때 한해 요청당 **최대 1회**, 짧은 프롬프트(≤ 약 300 토큰)로만 `@cf/meta/llama-3.1-8b-instruct`를 호출해 조사 결과를 살짝 다듬습니다. 호출이 실패하거나 시간이 걸리면 즉시 규칙 기반 결과로 폴백합니다. 바인딩이 없어도 100% 동작합니다.
- `/api/image` — 요청당 **최대 1회**, `@cf/black-forest-labs/flux-1-schnell`을 호출해 실제 이미지를 생성합니다. 실패하거나 바인딩이 없으면 즉시 항상 성공하는 헤드리스 카드(SVG) 렌더링으로 폴백합니다.

두 기능 모두 재시도 없이 요청당 최대 1회만 호출하도록 설계되어 있어 무료 플랜의 일일 뉴런 한도를 과도하게 소모하지 않습니다. AI 바인딩을 아예 쓰고 싶지 않다면 `wrangler.toml`의 `[ai]` 블록을 다시 주석 처리하세요 — `/api/image`는 이 경우 항상 헤드리스 카드만 반환합니다.

## 구조

- `search-core.js` — 검색 스크래핑 공통 로직(파서, 엔진 정의, CORS 등). Worker와 Pages Functions가 공유합니다.
- `research-core.js` — 규칙 기반 주제 조사 로직 + 선택적 Workers AI 보강 로직.
- `image-core.js` — 외부 의존성 없이 프롬프트를 자율형 neural-field BMP 비트맵 이미지로 생성하는 자체 이미지 엔진.
- `research-handler.js` — `/api/research` 요청 처리(인증, 검증, 응답 조립).
- `worker-search.js` — Cloudflare Workers 진입점(`/api/search`, `/api/research`, 문서 페이지).
- `functions/api/search.js`, `functions/api/research.js`, `functions/api/image.js` — Cloudflare Pages Functions 진입점.
- `search.html` — 사람이 보는 안내/데모 페이지.

## 주의사항

이 저장소는 Google/네이버의 공식 검색 API가 아닌 HTML/RSS 스크래핑 기반입니다. 각 사이트의 정책 변경이나 자동화 차단(특히 Google 일반 웹검색의 429)에 따라 결과가 제한될 수 있으며, 이 경우 Google은 뉴스 RSS를 기본 소스로 사용합니다.
