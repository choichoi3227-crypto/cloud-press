# cloud-press

Cloudflare Workers / Pages Functions 무료 플랜에 배포 가능한, API 키 없는 **검색 스크래핑 + 주제 조사 + 자체 이미지 생성** 엔드포인트입니다.

- Google + 네이버 검색 결과를 URL 요청만으로 JSON으로 반환
- 검색 결과를 바탕으로 한 "주제 조사" JSON(`/api/research`) — WordPress 플러그인 등에서 기존 Groq 기반 워커를 대체
- `/api/image`는 외부 API·Cloudflare AI 바인딩·유료 모델 없이 프롬프트를 자율형 neural-field가 직접 샘플링한 실제 BMP 비트맵 이미지로 변환합니다. 한국어를 포함해 10개 이상의 언어 키워드를 처리하며 플랫폼 비용은 0원입니다.
- 기본값은 **완전히 AI 바인딩 없이** 동작 (규칙 기반). Cloudflare Workers AI 바인딩은 선택 사항이며, 켜더라도 요청당 최대 1회만 짧게 호출하도록 설계되어 있습니다.

## 엔드포인트

### `GET /api/search?q={검색어}&engine=all|google|naver&start=0`
Google/네이버 검색 결과를 스크래핑해 JSON으로 반환합니다. 인증·API 키 불필요.


### `GET/POST /api/image`
```json
{ "prompt": "네온빛 서울 야경과 고양이 로봇", "image_url": "https://example.com/reference.jpg", "negative_prompt": "흐림", "quality": "ultra", "steps": 8, "bitmap_width": 768, "bitmap_height": 768 }
```
- 응답은 `format: "bmp"`, 원본 `image`/`image_base64` 문자열, 브라우저에서 바로 표시 가능한 `data:image/bmp;base64,...` 형식의 `data_url`, `template_used: false`, `generation_mode`, `prompt_adherence`, `url_conditioning_used` 메타데이터를 포함합니다.
- 외부/Cloudflare AI 바인딩을 전혀 쓰지 않는 자체 템플릿 없는 자율형 소형 neural-field 비트맵 생성기(`self_contained_autonomous_neural_bitmap_v3`)라 개발자 관리 비용과 호출 비용이 없습니다.
- 한국어, 영어, 일본어, 중국어, 스페인어, 프랑스어, 독일어, 포르투갈어, 베트남어, 태국어, 인도네시아어, 아랍어, 힌디어, 러시아어 키워드를 인식합니다. `image_url`/`source_url`을 넘기면 REST API가 URL 이미지를 가져와 해시·평균색으로 조건부 생성을 수행하고, `quality`(`speed`/`balanced`/`detail`/`ultra`), `negative_prompt`, `steps`로 사진감·세밀도·속도 우선순위를 조정하며, `training_examples`를 넘기면 요청 내부 latent vector를 가볍게 적응시킵니다.
- `ultra` 품질은 최대 1024px 비트맵, 더 많은 refinement step, micro-texture 보강을 제공합니다. 단, 무료 엣지 런타임의 자체 소형 neural-field만으로 대형 학습형 이미지 모델 대비 절대적 우월성을 검증·보장할 수는 없습니다.

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
- `image-core.js` — 외부 의존성 없이 프롬프트를 자율형 neural-field BMP 비트맵 이미지로 생성하는 자체 이미지 엔진.
- `research-handler.js` — `/api/research` 요청 처리(인증, 검증, 응답 조립).
- `worker-search.js` — Cloudflare Workers 진입점(`/api/search`, `/api/research`, 문서 페이지).
- `functions/api/search.js`, `functions/api/research.js`, `functions/api/image.js` — Cloudflare Pages Functions 진입점.
- `search.html` — 사람이 보는 안내/데모 페이지.

## 주의사항

이 저장소는 Google/네이버의 공식 검색 API가 아닌 HTML/RSS 스크래핑 기반입니다. 각 사이트의 정책 변경이나 자동화 차단(특히 Google 일반 웹검색의 429)에 따라 결과가 제한될 수 있으며, 이 경우 Google은 뉴스 RSS를 기본 소스로 사용합니다.
