"""
학습된 Flash Texter(IntentEncoder)로 응답을 생성하는 추론 인터페이스.
inference-server/models/flash_texter.py 가 이 모듈을 로드하여 사용한다.

generate_response()의 시그니처는 로드맵 단계가 올라가도(seq2seq -> Transformer
-> GPT) 동일하게 유지하여, 추론 서버 코드를 바꾸지 않고 모델만 교체할 수 있게 한다.
"""
import random

import torch

from model import IntentEncoder
from tokenizer import Tokenizer

_model: IntentEncoder | None = None
_tokenizer: Tokenizer | None = None
_idx_to_intent: dict[int, str] = {}
_response_bank: dict[str, list[str]] = {}
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
_max_len = 24

_FALLBACK_RESPONSE = "죄송해요, 아직 그 말은 잘 이해하지 못했어요. 조금 다르게 말씀해 주시겠어요?"
_CONFIDENCE_THRESHOLD = 0.5  # softmax 확률이 이보다 낮으면 fallback 응답 사용


def load_model(checkpoint_path: str) -> None:
    global _model, _tokenizer, _idx_to_intent, _response_bank

    ckpt = torch.load(checkpoint_path, map_location=_device)
    _tokenizer = Tokenizer(ckpt["vocab"])
    intent_to_idx = ckpt["intent_to_idx"]
    _idx_to_intent = {v: k for k, v in intent_to_idx.items()}
    _response_bank = ckpt["response_bank"]

    cfg = ckpt["model_config"]
    model = IntentEncoder(cfg["vocab_size"], cfg["num_intents"])
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    model.to(_device)
    _model = model


def _oov_ratio(ids: list[int], unk_idx: int, pad_idx: int) -> float:
    content_ids = [i for i in ids if i != pad_idx]
    if not content_ids:
        return 1.0
    oov_count = sum(1 for i in content_ids if i == unk_idx)
    return oov_count / len(content_ids)


def _search_fallback_response(search_context: dict | None) -> str:
    """
    의도 분류에 실패했을 때(OOV 과다 또는 낮은 확신도), 검색 결과가 있으면
    검색 스니펫을 그대로 보여주는 보조 응답을 만든다. 모델이 내용을 "생성"하는 게
    아니라 검색 결과를 인용하는 것이므로 사실 왜곡 위험이 낮다 (docs/14 6.1절).
    """
    if search_context and search_context.get("results"):
        top = search_context["results"][0]
        title = top.get("title", "")
        snippet = top.get("snippet", "")
        if title or snippet:
            return f"직접 답변드리긴 어렵지만, 관련된 검색 결과를 찾았어요: {title} — {snippet}".strip(" —")
    return _FALLBACK_RESPONSE


def generate_response(
    prompt: str,
    max_tokens: int = 128,
    temperature: float = 0.8,
    search_context: dict | None = None,
) -> str:
    """
    학습된 Flash Texter 모델로 응답 생성.
    max_tokens, temperature는 API 계약(단계 3까지 동일 인터페이스)을 위해 받지만,
    단계 1(의도 분류+검색) 구조에서는 직접 사용하지 않는다.
    search_context는 검색 Worker(POST /api/research)의 응답을 그대로 받는다
    (docs/14-search-augmented-generation.md). 모델이 답할 수 없을 때만 보조적으로
    사용되며, 정상적으로 의도가 분류되는 경우에는 기존 응답 검색 로직을 그대로 따른다.
    """
    if _model is None or _tokenizer is None:
        raise RuntimeError("모델이 로드되지 않았습니다. load_model()을 먼저 호출하세요.")

    ids = _tokenizer.encode(prompt, max_len=_max_len)

    # 입력 대부분이 어휘에 없는 단어(OOV)라면, 분류기 확신도와 무관하게 모른다고 답한다.
    # (분류기는 짧은 <unk> 시퀀스에도 특정 클래스에 과확신하는 경향이 있어 별도 방어가 필요)
    unk_idx = _tokenizer.vocab.get("<unk>", 1)
    pad_idx = _tokenizer.vocab.get("<pad>", 0)
    if _oov_ratio(ids, unk_idx, pad_idx) >= 0.6:
        return _search_fallback_response(search_context)

    input_tensor = torch.tensor([ids], dtype=torch.long, device=_device)

    with torch.no_grad():
        logits = _model(input_tensor)
        probs = torch.softmax(logits, dim=1)[0]
        confidence, pred_idx = probs.max(dim=0)

    if confidence.item() < _CONFIDENCE_THRESHOLD:
        return _search_fallback_response(search_context)

    intent = _idx_to_intent[pred_idx.item()]
    candidates = _response_bank.get(intent, [_FALLBACK_RESPONSE])
    return random.choice(candidates)
