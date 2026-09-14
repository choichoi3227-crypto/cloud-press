"""
Flash Texter 추론 래퍼 — 3단계 우선순위로 모델을 로드하고 서빙한다.

  1순위: 단계 2 (Qwen3.5-0.8B LoRA) — 실제 신경망이 프롬프트를 읽고 추론해서
         텍스트를 생성한다. 검색 grounding(docs/14)도 이 경로에서만 실질적으로
         동작한다 (검색 결과를 프롬프트에 주입해 모델이 이해하고 재구성).
  2순위: 단계 1 (의도 분류 GRU + 응답 검색) — 단계 2 로드/추론이 실패했을 때만
         호출되는 폴백. 검색 결과는 스니펫을 그대로 인용하는 수준으로만 활용한다.
  3순위: 더미 응답 — 개발 중 배관 검증용, 위 둘 다 없을 때만.

이 우선순위는 사용자와 명시적으로 합의된 사항이다: "단계 1은 폐기가 아니라
Qwen3.5 로드 실패 시의 안전망으로 유지"(docs/15-stage2-pretrained-finetuning.md
1절 "폴백 전략" 참조).

모듈 격리에 대해서는 inference-server/_model_loader_utils.py 참조 —
training/flash-texter 와 training/nano-tech-artist 가 model.py 등 동일한
파일명을 쓰기 때문에, 평범한 sys.path 조작만으로는 이름 충돌이 발생한다.
"""
import logging
import os
from typing import Optional

from config import (
    ALLOW_DUMMY_FALLBACK,
    FLASH_TEXTER_VERSION,
    HF_REPO_FLASH_TEXTER,
    LOCAL_FLASH_TEXTER_PATH,
)
from _model_loader_utils import load_inference_module

logger = logging.getLogger("flash_texter")

_TRAINING_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "training", "flash-texter")
_STAGE1_LOCAL_MODULES = ["model", "tokenizer", "dataset"]

# 단계 2(Qwen3.5) 관련 설정. 비어 있으면 단계 2 로드를 아예 시도하지 않고
# 곧바로 단계 1로 넘어간다 (환경변수 미설정 = 아직 파인튜닝을 안 돌린 상태와 동일하게 취급).
STAGE2_CHECKPOINT_DIR = os.environ.get("STAGE2_CHECKPOINT_DIR", "")
STAGE2_BASE_MODEL = os.environ.get("STAGE2_BASE_MODEL", "Qwen/Qwen3.5-0.8B-Base")

_active_stage: Optional[int] = None  # 2, 1, 또는 None(더미)
_load_error_stage2: Optional[str] = None
_load_error_stage1: Optional[str] = None
_stage1_inference_module = None
_stage2_inference_module = None


def load() -> None:
    """
    1순위(Qwen3.5)부터 시도하고, 실패하면 2순위(단계 1 GRU)로 넘어간다.
    둘 다 실패해도 예외를 던지지 않는다 — ALLOW_DUMMY_FALLBACK이 참이면
    서버는 정상 기동하고 generate_response가 더미 응답으로 처리한다.
    """
    global _active_stage

    if _try_load_stage2():
        _active_stage = 2
        logger.info("Flash Texter: 단계 2(Qwen3.5 LoRA) 로 서빙합니다.")
        return

    if _try_load_stage1():
        _active_stage = 1
        logger.warning(
            "Flash Texter: 단계 2 로드 실패(%s) -> 단계 1(GRU 폴백)로 서빙합니다.",
            _load_error_stage2,
        )
        return

    _active_stage = None
    logger.warning(
        "Flash Texter: 단계 1/2 모두 로드 실패 (stage2=%s, stage1=%s). 더미 폴백만 가능합니다.",
        _load_error_stage2,
        _load_error_stage1,
    )


def _try_load_stage2() -> bool:
    global _load_error_stage2, _stage2_inference_module

    if not STAGE2_CHECKPOINT_DIR:
        _load_error_stage2 = "STAGE2_CHECKPOINT_DIR not configured"
        return False

    try:
        inference_module = load_inference_module(
            _TRAINING_DIR, "flash_texter_stage2_impl", [], entry_filename="inference_stage2.py"
        )
        inference_module.load_model(STAGE2_CHECKPOINT_DIR, STAGE2_BASE_MODEL)
        _stage2_inference_module = inference_module
        return True
    except Exception as exc:  # noqa: BLE001
        _load_error_stage2 = str(exc)
        logger.warning("단계 2(Qwen3.5) 로드 실패: %s", exc)
        return False


def _try_load_stage1() -> bool:
    global _load_error_stage1, _stage1_inference_module

    weights_path = None
    if LOCAL_FLASH_TEXTER_PATH and os.path.exists(LOCAL_FLASH_TEXTER_PATH):
        weights_path = LOCAL_FLASH_TEXTER_PATH
    elif HF_REPO_FLASH_TEXTER:
        try:
            from huggingface_hub import hf_hub_download

            weights_path = hf_hub_download(
                repo_id=HF_REPO_FLASH_TEXTER,
                filename=f"flash-texter-{FLASH_TEXTER_VERSION}.pt",
            )
        except Exception as exc:  # noqa: BLE001
            _load_error_stage1 = f"HF Hub download failed: {exc}"
            return False
    else:
        _load_error_stage1 = "LOCAL_FLASH_TEXTER_PATH / HF_REPO_FLASH_TEXTER not configured"
        return False

    try:
        inference_module = load_inference_module(_TRAINING_DIR, "flash_texter_impl", _STAGE1_LOCAL_MODULES)
        inference_module.load_model(weights_path)
        _stage1_inference_module = inference_module
        return True
    except Exception as exc:  # noqa: BLE001
        _load_error_stage1 = str(exc)
        return False


def is_ready() -> bool:
    return _active_stage is not None


def active_stage() -> Optional[int]:
    """헬스체크 등에서 현재 어떤 단계로 서빙 중인지 노출하기 위한 접근자."""
    return _active_stage


def generate_response(
    prompt: str,
    max_tokens: int = 128,
    temperature: float = 0.8,
    search_context: Optional[dict] = None,
) -> str:
    if _active_stage == 2 and _stage2_inference_module is not None:
        return _stage2_inference_module.generate_response(
            prompt, max_tokens=max_tokens, temperature=temperature, search_context=search_context
        )

    if _active_stage == 1 and _stage1_inference_module is not None:
        return _stage1_inference_module.generate_response(
            prompt, max_tokens=max_tokens, temperature=temperature, search_context=search_context
        )

    if not ALLOW_DUMMY_FALLBACK:
        raise RuntimeError(
            f"Flash Texter model not loaded (stage2={_load_error_stage2}, stage1={_load_error_stage1})"
        )

    # 마일스톤 0용 더미 응답 (배관 검증 전용, 실제 서비스 응답 아님)
    return f"[dummy-flash-texter {FLASH_TEXTER_VERSION}] 입력을 받았습니다: {prompt[:50]}"


def generate_response_stream(
    prompt: str,
    max_tokens: int = 128,
    temperature: float = 0.8,
    mode: str = "fast",
    search_context: Optional[dict] = None,
):
    """
    응답을 토큰(또는 단어) 단위로 순차 반환하는 제너레이터.
    (docs/15-stage2-pretrained-finetuning.md 4절 — Claude 스타일 스트리밍 설계)

    단계 2(Qwen3.5)가 활성화되어 있으면 실제 TextIteratorStreamer로 토큰이
    생성되는 즉시 방출한다(진짜 스트리밍). 단계 1로 폴백된 경우에는 완성된
    응답을 단어 단위로 잘라 순차 방출하는 "의사 스트리밍"으로 동작한다 —
    거짓으로 실제 생성 과정을 흉내내는 것이 아니라, 단계 1 자체가 토큰을
    하나씩 생성하는 구조가 아니기 때문이다. 호출부(routers/text.py)는 어느
    단계가 활성화되어 있는지 알 필요 없이 동일한 방식으로 이 함수를 쓴다.
    """
    if _active_stage == 2 and _stage2_inference_module is not None:
        yield from _stage2_inference_module.generate_response_stream(
            prompt, max_tokens=max_tokens, temperature=temperature, mode=mode, search_context=search_context
        )
        return

    if _active_stage == 1 and _stage1_inference_module is not None:
        full_text = _stage1_inference_module.generate_response(
            prompt, max_tokens=max_tokens, temperature=temperature, search_context=search_context
        )
    elif not ALLOW_DUMMY_FALLBACK:
        raise RuntimeError(
            f"Flash Texter model not loaded (stage2={_load_error_stage2}, stage1={_load_error_stage1})"
        )
    else:
        full_text = f"[dummy-flash-texter {FLASH_TEXTER_VERSION}] 입력을 받았습니다: {prompt[:50]}"

    words = full_text.split(" ")
    for i, word in enumerate(words):
        chunk = word if i == 0 else " " + word
        yield chunk
