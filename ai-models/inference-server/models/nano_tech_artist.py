"""
training/nano-tech-artist/inference.py 의 학습된 cGAN을 로드하고 서빙하는 래퍼.
Flash Texter와 동일하게, 가중치가 없으면 더미 이미지로 폴백한다 (마일스톤 0).

모듈 격리에 대해서는 inference-server/_model_loader_utils.py 참조.
"""
import base64
import io
import logging
import os
from typing import Optional

from PIL import Image, ImageDraw

from config import (
    ALLOW_DUMMY_FALLBACK,
    HF_REPO_NANO_TECH_ARTIST,
    LOCAL_NANO_TECH_ARTIST_PATH,
    NANO_TECH_ARTIST_VERSION,
)
from _model_loader_utils import load_inference_module

logger = logging.getLogger("nano_tech_artist")

_TRAINING_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "training", "nano-tech-artist")
_LOCAL_MODULES = ["model", "dataset"]

_model = None
_load_error: Optional[str] = None
_inference_module = None

_DUMMY_COLORS = {
    "red": (220, 50, 50),
    "blue": (50, 90, 220),
    "green": (50, 180, 80),
    "yellow": (230, 200, 40),
    "purple": (150, 60, 180),
    "black": (30, 30, 30),
}


def load() -> None:
    global _model, _load_error, _inference_module

    weights_path = None
    if LOCAL_NANO_TECH_ARTIST_PATH and os.path.exists(LOCAL_NANO_TECH_ARTIST_PATH):
        weights_path = LOCAL_NANO_TECH_ARTIST_PATH
    elif HF_REPO_NANO_TECH_ARTIST:
        try:
            from huggingface_hub import hf_hub_download

            weights_path = hf_hub_download(
                repo_id=HF_REPO_NANO_TECH_ARTIST,
                filename=f"nano-tech-artist-{NANO_TECH_ARTIST_VERSION}.pt",
            )
        except Exception as exc:  # noqa: BLE001
            _load_error = f"HF Hub download failed: {exc}"
            logger.warning(_load_error)
            return
    else:
        _load_error = "LOCAL_NANO_TECH_ARTIST_PATH / HF_REPO_NANO_TECH_ARTIST not configured"
        logger.warning(_load_error)
        return

    try:
        inference_module = load_inference_module(_TRAINING_DIR, "nano_tech_artist_impl", _LOCAL_MODULES)
        inference_module.load_generator(weights_path)
        _inference_module = inference_module
        _model = True  # 실제 가중치는 inference 모듈 내부 전역에 보관됨
        logger.info("Nano-Tech Artist 모델 로드 완료: %s", weights_path)
    except Exception as exc:  # noqa: BLE001
        _load_error = str(exc)
        logger.warning("Nano-Tech Artist 모델 로드 실패, 더미 폴백 사용: %s", exc)


def is_ready() -> bool:
    return _model is not None


def _draw_dummy(color: str, shape: str, size: int = 64) -> bytes:
    img = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    rgb = _DUMMY_COLORS.get(color, (100, 100, 100))
    margin = size // 6
    box = [margin, margin, size - margin, size - margin]
    if shape == "circle":
        draw.ellipse(box, fill=rgb)
    elif shape == "square":
        draw.rectangle(box, fill=rgb)
    elif shape == "triangle":
        draw.polygon(
            [(size / 2, margin), (margin, size - margin), (size - margin, size - margin)],
            fill=rgb,
        )
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def generate_image(color: str, shape: str) -> str:
    """base64로 인코딩된 PNG 문자열을 반환한다."""
    if _model is not None and _inference_module is not None:
        return _inference_module.generate_image_base64(color, shape)

    if not ALLOW_DUMMY_FALLBACK:
        raise RuntimeError(f"Nano-Tech Artist model not loaded: {_load_error}")

    # 마일스톤 0용 더미 이미지 (실제 cGAN 학습 전 배관 검증용).
    # 학습 완료 후에는 training/nano-tech-artist/inference.py의 generate_image()로 교체.
    png_bytes = _draw_dummy(color, shape)
    return base64.b64encode(png_bytes).decode("ascii")
