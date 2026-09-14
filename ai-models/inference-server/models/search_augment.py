"""
검색 증강 생성(RAG) 모듈. 저장소 루트의 검색/조사 API(POST /api/research)를
호출해 Flash Texter의 응답에 참고할 컨텍스트를 가져온다.
(docs/14-search-augmented-generation.md 참조)

설계 원칙:
  - 이 호출이 실패해도 Flash Texter 전체가 죽어서는 안 된다. 어떤 예외 상황에서도
    예외를 상위로 던지지 않고 빈 컨텍스트를 반환한다 (docs/14 7절).
  - SEARCH_WORKER_URL이 비어 있으면 즉시 빈 컨텍스트를 반환해 연동을 비활성화한다.
"""
import logging
from typing import TypedDict

import httpx

from config import (
    SEARCH_WORKER_MAX_RESULTS,
    SEARCH_WORKER_SECRET,
    SEARCH_WORKER_TIMEOUT_SECONDS,
    SEARCH_WORKER_URL,
)

logger = logging.getLogger("search_augment")


class SearchResult(TypedDict):
    title: str
    url: str
    snippet: str


class SearchContext(TypedDict):
    summary: str
    results: list[SearchResult]


EMPTY_CONTEXT: SearchContext = {"summary": "", "results": []}


async def fetch_search_context(query: str, max_results: int | None = None) -> SearchContext:
    """
    검색 Worker의 POST /api/research를 호출해 요약과 결과 목록을 가져온다.
    네트워크 오류, 타임아웃, 4xx/5xx 응답 등 어떤 이유로든 실패하면
    예외를 던지지 않고 EMPTY_CONTEXT를 반환한다.
    """
    if not SEARCH_WORKER_URL:
        return dict(EMPTY_CONTEXT)

    if not query or not query.strip():
        return dict(EMPTY_CONTEXT)

    limit = max_results or SEARCH_WORKER_MAX_RESULTS
    headers = {"Content-Type": "application/json"}
    if SEARCH_WORKER_SECRET:
        headers["X-AIBP-Secret"] = SEARCH_WORKER_SECRET

    try:
        async with httpx.AsyncClient(timeout=SEARCH_WORKER_TIMEOUT_SECONDS) as client:
            res = await client.post(
                f"{SEARCH_WORKER_URL.rstrip('/')}/api/research",
                json={"query": query, "max_results": limit},
                headers=headers,
            )
            res.raise_for_status()
            data = res.json()
    except httpx.TimeoutException:
        logger.warning("검색 Worker 호출 타임아웃 (query=%r)", query)
        return dict(EMPTY_CONTEXT)
    except httpx.HTTPStatusError as exc:
        logger.warning("검색 Worker가 오류 응답 반환: status=%s", exc.response.status_code)
        return dict(EMPTY_CONTEXT)
    except Exception as exc:  # noqa: BLE001 - 어떤 예외든 Flash Texter 전체를 죽이면 안 됨
        logger.warning("검색 Worker 호출 실패: %s", exc)
        return dict(EMPTY_CONTEXT)

    results = data.get("results", [])
    if not isinstance(results, list):
        results = []

    return {
        "summary": str(data.get("summary") or ""),
        "results": results[:limit],
    }
