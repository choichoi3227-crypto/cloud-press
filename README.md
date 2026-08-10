# cloud-press

Cloudflare Workers / Pages Functions 무료 플랜에 배포 가능한, API 키 없는 **검색 스크래핑 + 주제 조사** 엔드포인트입니다.

- Google + 네이버 검색 결과를 URL 요청만으로 JSON으로 반환
- 검색 결과를 바탕으로 한 "주제 조사" JSON(`/api/research`) — WordPress 플러그인 등에서 기존 Groq 기반 워커를 대체
- 기본값은 **완전히 AI 바인딩 없이** 동작 (규칙 기반). Cloudflare Workers AI 바인딩은 선택 사항이며, 켜더라도 요청당 최대 1회만 짧게 호출하도록 설계되어 있습니다.

## 엔드포인트

### `GET /api/search?q={검색어}&engine=all|google|naver&start=0`
Google/네이버 검색 결과를 스크래핑해 JSON으로 반환합니다. 인증·API 키 불필요.

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

## (선택, 비추천) Cloudflare Workers AI 바인딩

`/api/research`는 AI 바인딩 없이도 100% 완전하게 동작합니다(색상/카테고리 사전 기반 규칙 로직). 정말 필요한 경우에만 `wrangler.toml`의 아래 주석을 해제하세요:

```toml
[ai]
binding = "AI"
```

바인딩이 있으면 검색 결과가 있을 때 한해 요청당 **최대 1회**, 짧은 프롬프트(≤ 약 300 토큰)로만 `@cf/meta/llama-3.1-8b-instruct`를 호출해 조사 결과를 살짝 다듬습니다. 호출이 실패하거나 시간이 걸리면 즉시 규칙 기반 결과로 폴백하므로 안정성에는 영향이 없습니다. 무료 플랜 사용량을 아끼려면 바인딩을 켜지 않는 것을 권장합니다.

## 구조

- `search-core.js` — 검색 스크래핑 공통 로직(파서, 엔진 정의, CORS 등). Worker와 Pages Functions가 공유합니다.
- `research-core.js` — 규칙 기반 주제 조사 로직 + 선택적 Workers AI 보강 로직.
- `research-handler.js` — `/api/research` 요청 처리(인증, 검증, 응답 조립).
- `worker-search.js` — Cloudflare Workers 진입점(`/api/search`, `/api/research`, 문서 페이지).
- `functions/api/search.js`, `functions/api/research.js` — Cloudflare Pages Functions 진입점.
- `search.html` — 사람이 보는 안내/데모 페이지.

## 주의사항

이 저장소는 Google/네이버의 공식 검색 API가 아닌 HTML/RSS 스크래핑 기반입니다. 각 사이트의 정책 변경이나 자동화 차단(특히 Google 일반 웹검색의 429)에 따라 결과가 제한될 수 있으며, 이 경우 Google은 뉴스 RSS를 기본 소스로 사용합니다.
