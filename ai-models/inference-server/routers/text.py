import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from auth import verify_internal_request
from config import FLASH_TEXTER_VERSION
from models import flash_texter, search_augment

router = APIRouter(dependencies=[Depends(verify_internal_request)])


class TextGenerateRequest(BaseModel):
    prompt: str = Field(..., max_length=2000)
    max_tokens: int = Field(default=128, ge=1, le=1024)
    temperature: float = Field(default=0.8, ge=0.0, le=2.0)
    # docs/15-stage2-pretrained-finetuning.md 4.2절 — 하위 호환을 위해 둘 다 기본값을
    # 유지한다. stream=false(기본)면 기존 클라이언트(WordPress 마이페이지 콘솔,
    # 정적 데모 프런트엔드)는 코드 변경 없이 그대로 동작한다.
    mode: str = Field(default="fast", pattern="^(fast|thinking)$")
    stream: bool = Field(default=False)


class TextGenerateResponse(BaseModel):
    model: str
    text: str
    usage: dict


@router.post("/generate")
async def generate(req: TextGenerateRequest):
    # 모든 텍스트 생성 요청마다 검색 Worker를 호출해 컨텍스트를 가져온다
    # (docs/14-search-augmented-generation.md — "요청 시 항상" 호출).
    # SEARCH_WORKER_URL이 설정되지 않았거나 호출이 실패하면 빈 컨텍스트가
    # 반환되므로, 이 호출 자체가 요청을 실패시키는 일은 없다.
    search_context = await search_augment.fetch_search_context(req.prompt)

    if req.stream:
        return StreamingResponse(
            _sse_event_stream(req, search_context),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",  # 리버스 프록시가 버퍼링해서 스트리밍을 죽이지 않도록
            },
        )

    text = flash_texter.generate_response(
        prompt=req.prompt,
        max_tokens=req.max_tokens,
        temperature=req.temperature,
        search_context=search_context,
    )
    return TextGenerateResponse(
        model=f"flash-texter-{FLASH_TEXTER_VERSION}",
        text=text,
        usage={
            "prompt_tokens": len(req.prompt.split()),
            "completion_tokens": len(text.split()),
        },
    )


def _sse_event_stream(req: TextGenerateRequest, search_context: dict):
    """
    Server-Sent Events 형식으로 청크를 순차 방출한다.
    각 이벤트는 `data: <json>\n\n` 형식이며, 스트림 종료는 `data: [DONE]\n\n`로 표시한다
    (OpenAI/Anthropic 스트리밍 API와 동일한 관례를 따라 클라이언트 구현 부담을 줄인다).
    """
    full_text_parts = []
    try:
        for chunk in flash_texter.generate_response_stream(
            prompt=req.prompt,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            mode=req.mode,
            search_context=search_context,
        ):
            full_text_parts.append(chunk)
            payload = {"type": "chunk", "text": chunk}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        usage = {
            "prompt_tokens": len(req.prompt.split()),
            "completion_tokens": len("".join(full_text_parts).split()),
        }
        final_payload = {
            "type": "done",
            "model": f"flash-texter-{FLASH_TEXTER_VERSION}",
            "usage": usage,
        }
        yield f"data: {json.dumps(final_payload, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
    except Exception as exc:  # noqa: BLE001
        # 스트림 도중 오류가 나도 SSE 연결 자체는 정상 종료해야 클라이언트가 멈추지 않는다.
        error_payload = {"type": "error", "message": str(exc)}
        yield f"data: {json.dumps(error_payload, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
