from fastapi import Request, HTTPException

from config import INTERNAL_API_KEY


async def verify_internal_request(request: Request) -> None:
    """
    Cloudflare Worker(api-gateway)에서 온 요청만 허용한다.
    Worker를 거치지 않은 직접 요청(공개 인터넷)은 여기서 차단된다.
    """
    key = request.headers.get("X-Internal-Key")
    if key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="forbidden")
