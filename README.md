# cloud-press

이 저장소는 두 개의 독립적인 프로젝트를 함께 관리합니다.

## 1. 검색/이미지 API (저장소 루트)

Cloudflare Workers / Pages Functions 무료 플랜에 배포 가능한, API 키 없는 **검색 스크래핑 + 주제 조사 + 자체 이미지 생성** 엔드포인트입니다.

- `GET /api/search` — Google + 네이버 검색 결과를 JSON으로 반환
- `POST /api/research` — 검색 결과 기반 주제 조사 JSON
- `GET/POST /api/image` — 전달된 프롬프트를 그대로 그린 SVG 썸네일 생성. 1순위는 LLM이 프롬프트를 읽고 직접 그리는 방식(`image-core.js`), 실패 시 주제에 맞는 오브젝트 씬 합성(`svg-scene.js`, `svg-objects.js`)으로 폴백하며 결과는 `svg-safe.js`로 검증·복구 후 가능하면 PNG로 변환합니다. `provider`: `svg-scene`(LLM 생략) / `ai-model`(FLUX 등 이미지 모델 우선).

`/api/image` 요청 필드와 스타일:

- `topic` — 이미지에 제목으로 그려지는 유일한 문구. `subtitle` — 오브젝트·색을 고르는 **참고용 장면 설명**(화면에 그리지 않음). `display_subtitle` — 화면에 실제로 그릴 부제(선택).
- 응답의 `text_included`가 `true`면 제목이 이미지 안에 이미 그려져 있으니 호출자는 제목을 다시 합성하면 안 됩니다(SVG→PNG 변환 후에도 유지).
- `style` 기본 5종: `poster` `minimal` `photo_realistic` `typography` `branding`
- `style` 디자인 6종 (`svg-styles.js`, 같은 주제라도 배경·구도·텍스트 처리가 완전히 다름): `gradient`(오로라 메시 + 글래스 카드) · `infographic`(헤더 + 번호 카드 + 미니 차트) · `isometric`(등각 3D 플랫폼) · `neon`(발광 링 + 원근 그리드) · `papercut`(종이 레이어 + 종이 라벨) · `blueprint`(청사진 도면 + 치수선). 이 6종은 기본적으로 LLM 자유 작화 없이 스타일 전용 합성기가 직접 그리며(`provider:"svg-llm"`으로 명시할 때만 LLM 시도), 주제 매칭(오브젝트 선택)은 기존과 같은 `planScene`을 씁니다.

상세 내용은 이 디렉토리의 각 소스 파일(`search-core.js`, `research-core.js`, `image-core.js`, `worker-search.js`, `functions/`)과 `search.html`을 참조하세요. 배포는 루트의 `wrangler.toml`(Worker 이름: `cloudpress-search-endpoint`) 또는 `wrangler-search.toml`을 사용합니다.

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
