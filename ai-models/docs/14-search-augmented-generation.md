# Flash Texter 검색 증강 생성 (RAG)

## 1. 배경

이 저장소에는 `ai-models/`의 Cloud Press AI 모델 프로젝트와 별개로, 루트에 이미 운영 중인 **검색 스크래핑 + 주제 조사 API**(`POST /api/research`, 이하 "검색 Worker")가 있습니다. 확정된 방향에 따라, Flash Texter는 텍스트 생성 요청이 올 때마다 이 검색 Worker를 호출해 최신 정보를 컨텍스트로 활용합니다.

**중요한 원칙**: 이 연동은 Flash Texter가 Cloudflare Workers AI를 직접 사용하게 되는 것이 아닙니다. 검색 Worker 내부적으로 Workers AI(선택적 보강)를 쓰고 있을 수 있지만, Flash Texter 입장에서는 그저 하나의 외부 HTTP API를 호출하는 것뿐이며, **Flash Texter 자체의 텍스트 생성(의도 분류+응답 선택, 이후 자유 생성 모델)은 여전히 100% 직접 학습한 모델**입니다. 검색 결과는 어디까지나 "참고 자료"이지, 검색 Worker가 답을 대신 생성해주는 것이 아닙니다.

## 2. 왜 이게 필요한가

기존 Flash Texter 단계 1(의도 분류 + 검증된 응답 검색, `docs/03-flash-texter-spec.md`)은 정해진 7개 의도 범위 밖의 질문에는 전부 "모르겠다"고 답합니다. 예를 들어 "오늘 환율 얼마야", "최근에 나온 영화 뭐 있어" 같은 질문에는 원래 응답할 방법이 없습니다.

검색 결과를 컨텍스트로 참고하게 하면, 최소한 **관련 검색 스니펫을 사용자에게 보여주는 형태**로는 실질적인 답변이 가능해집니다. 이는 Flash Texter의 생성 능력 자체를 확장하는 게 아니라, 모델이 답할 수 없는 영역에서도 유용한 정보를 제공하는 보완 경로입니다.

## 3. 흐름

```
사용자 → Worker(/v1/text/generate) → 추론 서버
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                                ▼
                  검색 Worker 호출                  Flash Texter 모델 추론
                  POST /api/research                (의도 분류 + 응답 선택,
                  { query: <사용자 prompt> }          이후 단계에서는 자유 생성)
                          │                                │
                          └───────────────┬────────────────┘
                                          ▼
                         검색 결과 + 모델 응답을 함께 반영해
                         최종 응답 조립
                                          │
                                          ▼
                                     사용자에게 반환
```

**"요청 시 항상" 호출**(사용자 확정 사항): 모든 `/v1/text/generate` 요청마다 검색 Worker를 호출합니다. 사용자가 "검색해줘"라고 명시할 때만 호출하는 방식이 아닙니다.

## 4. 어디에 구현하는가: 추론 서버 (FastAPI)

검색 Worker 호출은 Cloudflare Worker(`ai-models/workers/api-gateway`)가 아니라 **추론 서버**(`ai-models/inference-server`)에서 수행합니다. 이유:

- 검색 결과를 모델 입력에 섞는 로직은 "추론"의 일부이지 "API 게이트웨이"의 역할이 아닙니다 (`ai-models/docs/01-architecture-detail.md`의 역할 분담 원칙과 일치).
- 추론 서버가 이미 Flash Texter 모델을 로드해서 실행하는 곳이므로, 검색 결과와 모델 응답을 조합하는 지점도 여기가 자연스럽습니다.
- Cloudflare Worker(api-gateway)는 여전히 "문지기" 역할(인증/rate limit/캐싱)만 유지합니다 — 이 원칙은 변경되지 않습니다.

## 5. 검색 Worker 호출 계약

추론 서버는 검색 Worker의 `POST /api/research`를 다음과 같이 호출합니다.

```python
# inference-server/models/search_augment.py (신규)
import httpx

SEARCH_WORKER_URL = os.environ.get("SEARCH_WORKER_URL", "")  # 예: https://cloudpress-search-endpoint.<subdomain>.workers.dev
SEARCH_WORKER_SECRET = os.environ.get("SEARCH_WORKER_SECRET", "")  # research-handler.js의 AIBP_SHARED_SECRET과 동일한 값 (설정된 경우)

async def fetch_search_context(query: str, max_results: int = 5) -> dict:
    """
    검색 Worker의 /api/research를 호출해 요약과 결과 목록을 가져온다.
    실패(네트워크 오류, 타임아웃, 4xx/5xx)해도 예외를 던지지 않고 빈 컨텍스트를 반환한다 —
    검색 Worker 장애가 Flash Texter 전체를 죽여서는 안 된다 (아래 7절 참조).
    """
    if not SEARCH_WORKER_URL:
        return {"summary": "", "results": []}

    headers = {"Content-Type": "application/json"}
    if SEARCH_WORKER_SECRET:
        headers["X-AIBP-Secret"] = SEARCH_WORKER_SECRET

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.post(
                f"{SEARCH_WORKER_URL}/api/research",
                json={"query": query, "max_results": max_results},
                headers=headers,
            )
            res.raise_for_status()
            data = res.json()
            return {
                "summary": data.get("summary", ""),
                "results": data.get("results", [])[:max_results],
            }
    except Exception:
        return {"summary": "", "results": []}
```

**5초 타임아웃**을 명시적으로 둡니다. 검색 Worker가 느리거나 응답이 없어도 Flash Texter 응답 전체가 무한정 지연되지 않도록 합니다.

## 6. 검색 결과를 Flash Texter에 반영하는 방법 (단계별로 다름)

Flash Texter의 로드맵 단계에 따라 검색 결과를 반영하는 방식이 달라집니다. `generate_response()`의 시그니처(`docs/03-flash-texter-spec.md`)는 유지하되, 내부적으로 검색 컨텍스트를 받는 새 선택적 인자를 추가합니다.

### 6.1 단계 1 (의도 분류 + 응답 검색) — 현재 구현

검색 결과를 "직접 생성"에 섞을 수 없으므로(자유 생성 모델이 아직 아님), 의도 분류가 낮은 확신도(fallback)로 떨어졌을 때 검색 요약을 보조적으로 붙이는 방식으로 시작합니다.

```python
# inference.py (training/flash-texter/) 의 generate_response 확장
def generate_response(prompt: str, max_tokens: int = 128, temperature: float = 0.8,
                       search_context: dict | None = None) -> str:
    # ... 기존 의도 분류 로직 ...

    if confidence.item() < _CONFIDENCE_THRESHOLD:
        if search_context and search_context.get("results"):
            top = search_context["results"][0]
            return f"직접 답변드리긴 어렵지만, 관련된 검색 결과를 찾았어요: {top['title']} — {top.get('snippet', '')}"
        return _FALLBACK_RESPONSE

    # ... 기존 의도 매칭 응답 ...
```

이 방식은 모델이 "생성"하는 게 아니라 검색 스니펫을 그대로 보여주는 것이므로 사실 왜곡 위험이 낮고, 지금 모델 구조로도 바로 구현 가능합니다.

### 6.2 단계 2~3 (요약/자유 생성 모델) — 향후 확장

디코더가 실제로 자유 텍스트를 생성하게 되면, 검색 결과를 프롬프트에 컨텍스트로 주입하는 일반적인 RAG 패턴을 사용합니다.

```
[검색 결과]
1. {title1}: {snippet1}
2. {title2}: {snippet2}

[사용자 질문]
{prompt}

[답변]
```

이 형식의 프롬프트를 인코더-디코더 또는 GPT류 모델에 입력합니다. 이 단계에서는 검색 결과에 없는 내용을 모델이 지어내지 않도록(hallucination 방지) 학습 데이터에 "모르면 모른다고 답하기" 패턴을 포함시키는 것을 권장합니다 — 이는 향후 해당 단계 착수 시 `docs/03-flash-texter-spec.md`에 별도로 상세화합니다.

## 7. 장애 격리 (검색 Worker가 죽어도 Flash Texter는 죽지 않는다)

`docs/13-resilience-and-failover.md`의 원칙을 그대로 따릅니다. 검색 Worker 호출이 실패하면:

- 추론 서버는 예외를 던지지 않고 빈 컨텍스트(`{"summary": "", "results": []}`)로 처리합니다 (5절 코드 참조).
- Flash Texter는 검색 컨텍스트가 없을 때와 동일하게 동작합니다 — 즉 **검색 Worker 장애가 Flash Texter API 전체를 502/503으로 만들지 않습니다.** 최악의 경우에도 "검색 보강 없이 평소처럼 응답"하는 수준으로 저하될 뿐입니다.
- 검색 Worker 호출 성공/실패 여부는 로그로 남기되(모니터링용), 사용자에게 노출되는 에러 메시지에는 포함하지 않습니다.

## 8. 설정

추론 서버 환경변수에 다음을 추가합니다 (`docs/05-inference-server-spec.md`의 환경변수 목록에 병기).

```
SEARCH_WORKER_URL=https://cloudpress-search-endpoint.<subdomain>.workers.dev
SEARCH_WORKER_SECRET=<research-handler.js의 AIBP_SHARED_SECRET과 동일한 값, 설정한 경우에만>
```

`SEARCH_WORKER_URL`이 비어 있으면 검색 연동은 자동으로 비활성화되고(5절의 `fetch_search_context`가 즉시 빈 컨텍스트 반환), 기존처럼 검색 없이 동작합니다 — 로컬 개발이나 검색 Worker 없이 AI 모델만 테스트할 때 유용합니다.

## 9. 비용/성능 참고

- 검색 Worker의 `/api/research`는 Google/네이버 스크래핑과(선택적으로) Workers AI 보강을 포함해 응답에 1~3초 정도 걸릴 수 있습니다. 모든 텍스트 생성 요청마다 이 호출을 기다리므로, Flash Texter의 전체 응답 시간이 그만큼 늘어납니다.
- 트래픽이 늘어나면 검색 Worker 쪽 스크래핑 빈도도 함께 늘어나므로, `docs/09-running-without-gpu.md`에서 다룬 무료 티어 한도(Cloudflare Workers 무료 티어의 일일 요청 수)를 검색 Worker 쪽도 함께 모니터링해야 합니다.
- 동일한 질문이 반복되는 경우를 대비해, Cloudflare Worker(api-gateway)의 기존 캐싱 레이어(`ai-models/docs/06-cloudflare-worker-spec.md` 7절)가 검색 결과를 포함한 최종 응답까지 캐싱하므로 추가 조치 없이도 반복 요청에 대한 검색 Worker 호출 자체가 캐시로 걸러집니다.
