import logging

from fastapi import FastAPI

from models import flash_texter, nano_tech_artist
from routers import health, image, text

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Cloud Press Inference Server", version="0.1.0")

app.include_router(health.router, prefix="/v1/health", tags=["health"])
app.include_router(text.router, prefix="/v1/text", tags=["text"])
app.include_router(image.router, prefix="/v1/image", tags=["image"])


@app.on_event("startup")
def load_models() -> None:
    """
    서버 기동 시 모델을 미리 로드하여 첫 요청 지연을 없앤다.
    가중치가 아직 없는 개발 초기 단계에서는 로드가 실패해도 서버는 정상 기동하며,
    각 모델 모듈이 더미 응답으로 폴백한다 (config.ALLOW_DUMMY_FALLBACK).
    """
    flash_texter.load()
    nano_tech_artist.load()
