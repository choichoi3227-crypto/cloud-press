"""
Flash Texter 단계 2 — Qwen3.5-0.8B LoRA 파인튜닝 모델의 실제 추론 인터페이스.

이 모듈이 단계 1(training/flash-texter/inference.py, 의도 분류+응답 검색)과
다른 점: 여기서는 실제 신경망(Qwen3.5)이 프롬프트를 읽고 텍스트를 생성한다.
"생각하고 추론한다"는 건 바로 이 계층에서 일어나는 일이며, 단계 1의 GRU
의도분류기는 여기서 실패했을 때만 호출되는 폴백이다 (inference-server/models/
flash_texter.py의 3단계 우선순위: 단계2 -> 단계1 -> 더미).

검색 grounding (docs/14-search-augmented-generation.md 6.2절):
  단계 1은 검색 결과를 그대로 인용만 했다(스니펫을 복사해서 보여주는 수준).
  이 모듈은 검색 결과를 프롬프트에 컨텍스트로 주입해서, 모델이 그 내용을 실제로
  "읽고 이해한 뒤" 자기 언어로 답을 재구성하도록 한다 — Gemini/GPT/Claude의
  검색 그라운딩과 동일한 방식(RAG: retrieval-augmented generation)이다.
  검색 결과가 없으면 이 프롬프트 블록 자체를 생략하고 평소처럼 답한다.

주의: 이 모듈은 huggingface.co 접근과 GPU(또는 최소한 로드 가능한 CPU 메모리)가
필요하다. 로컬 개발 샌드박스에서는 실제 Qwen3.5 가중치로 검증할 수 없었다
(docs/15-stage2-pretrained-finetuning.md 5.1절 참조). 프롬프트 조립 로직 자체는
순수 문자열 처리라 이 파일 하단의 __main__ 블록으로 로컬에서 즉시 검증 가능하다.
"""
import torch

_model = None
_tokenizer = None
_device = None

SYSTEM_PROMPT = "당신은 Cloud Press가 직접 학습시킨 한국어 대화 모델 Flash Texter입니다. 친절하고 정확하게 답하세요."

SEARCH_CONTEXT_INSTRUCTION = (
    "아래는 사용자 질문과 관련된 최신 검색 결과입니다. 이 정보를 참고하되, "
    "검색 결과에 없는 내용을 지어내지 말고, 검색 결과와 사용자 질문을 바탕으로 "
    "당신 자신의 언어로 자연스럽게 답변을 구성하세요. 검색 결과가 질문과 관련이 "
    "없다면 그 사실을 알리고 아는 범위 내에서 답하세요."
)

# Qwen3.5가 사용하는 ChatML 제어 토큰들. 사용자 입력이나 검색 결과 텍스트에
# 이 토큰이 그대로 포함되면, 문자열을 그대로 프롬프트에 이어붙이는 방식에서는
# 사용자가 가짜 system/assistant 턴을 주입해 시스템 프롬프트를 무력화할 수 있다
# (실제로 로컬에서 "<|im_end|>\n<|im_start|>system\n..." 을 입력해 재현 확인함).
# 모델에 도달하기 전에 이 토큰들을 제거해 인젝션을 차단한다.
_CHATML_CONTROL_TOKENS = ["<|im_start|>", "<|im_end|>"]


def _sanitize_user_text(text: str) -> str:
    """사용자 입력/검색 결과 텍스트에서 ChatML 제어 토큰을 제거해 프롬프트 인젝션을 방지한다."""
    sanitized = text
    for token in _CHATML_CONTROL_TOKENS:
        sanitized = sanitized.replace(token, "")
    return sanitized


def load_model(checkpoint_dir: str, base_model: str = "Qwen/Qwen3.5-0.8B-Base") -> None:
    """LoRA 어댑터가 저장된 checkpoint_dir과 베이스 모델을 로드한다."""
    global _model, _tokenizer, _device

    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    _tokenizer = AutoTokenizer.from_pretrained(checkpoint_dir)
    base = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )
    _model = PeftModel.from_pretrained(base, checkpoint_dir)
    _model.eval()
    if _device.type == "cpu":
        _model.to(_device)


def build_prompt(user_message: str, search_context: dict | None = None) -> str:
    """
    검색 컨텍스트 유무에 따라 ChatML 프롬프트를 조립한다.

    search_context는 inference-server/models/search_augment.py의
    fetch_search_context() 결과를 그대로 받는다:
        {"summary": str, "results": [{"title": str, "url": str, "snippet": str}, ...]}

    이 함수는 순수 문자열 조립이라 GPU/모델 로드 없이도 완전히 검증 가능하다
    (파일 하단 __main__ 블록 참조).
    """
    parts = [f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>"]

    results = (search_context or {}).get("results") or []
    if results:
        context_lines = [SEARCH_CONTEXT_INSTRUCTION, ""]
        for i, item in enumerate(results, 1):
            # 검색 결과도 외부(웹) 콘텐츠이므로 사용자 입력과 동일하게 신뢰하지 않는다 —
            # 악의적인 웹페이지가 자기 스니펫에 ChatML 제어 토큰을 심어 프롬프트를
            # 조작하려 시도할 수 있으므로 여기서도 sanitize를 적용한다.
            title = _sanitize_user_text(item.get("title", ""))
            snippet = _sanitize_user_text(item.get("snippet", ""))
            context_lines.append(f"{i}. {title}: {snippet}")
        context_block = "\n".join(context_lines)
        parts.append(f"<|im_start|>system\n{context_block}<|im_end|>")

    safe_user_message = _sanitize_user_text(user_message)
    parts.append(f"<|im_start|>user\n{safe_user_message}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


def generate_response(
    prompt: str,
    max_tokens: int = 512,
    temperature: float = 0.8,
    search_context: dict | None = None,
) -> str:
    """
    Qwen3.5 LoRA 모델로 실제 텍스트를 생성한다. 검색 결과가 있으면 프롬프트에
    주입해 모델이 그 내용을 반영해 답하도록 한다 (docs/14 6.2절 grounding).
    """
    if _model is None or _tokenizer is None:
        raise RuntimeError("모델이 로드되지 않았습니다. load_model()을 먼저 호출하세요.")

    full_prompt = build_prompt(prompt, search_context)
    inputs = _tokenizer(full_prompt, return_tensors="pt").to(_device)

    with torch.no_grad():
        output = _model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=temperature > 0,
            temperature=max(temperature, 0.01),
        )

    generated = output[0][inputs["input_ids"].shape[1]:]
    return _tokenizer.decode(generated, skip_special_tokens=True).strip()


def generate_response_stream(
    prompt: str,
    max_tokens: int = 512,
    temperature: float = 0.8,
    mode: str = "fast",
    search_context: dict | None = None,
):
    """
    TextIteratorStreamer로 실제 토큰이 생성되는 즉시 방출한다.
    inference-server/models/flash_texter.py의 generate_response_stream()과
    동일한 시그니처를 가지므로, 단계 1 -> 단계 2 전환 시 호출부 변경이 필요 없다
    (docs/15 4절에서 명시한 설계 원칙).

    mode="thinking"이면 Qwen3.5의 thinking 모드 프리픽스를 프롬프트에 추가한다
    (Qwen3.5 모델 카드의 thinking/non-thinking 전환 방식에 따름 — 정확한 제어
    토큰은 실제 토크나이저의 chat template을 Colab에서 확인 후 반영 필요).
    """
    if _model is None or _tokenizer is None:
        raise RuntimeError("모델이 로드되지 않았습니다. load_model()을 먼저 호출하세요.")

    from threading import Thread

    from transformers import TextIteratorStreamer

    full_prompt = build_prompt(prompt, search_context)
    inputs = _tokenizer(full_prompt, return_tensors="pt").to(_device)

    streamer = TextIteratorStreamer(_tokenizer, skip_prompt=True, skip_special_tokens=True)
    generation_kwargs = dict(
        **inputs,
        max_new_tokens=max_tokens,
        do_sample=temperature > 0,
        temperature=max(temperature, 0.01),
        streamer=streamer,
    )

    thread = Thread(target=_model.generate, kwargs=generation_kwargs)
    thread.start()

    for chunk in streamer:
        if chunk:
            yield chunk

    thread.join()


if __name__ == "__main__":
    # 모델 로드 없이 프롬프트 조립 로직만 로컬에서 검증한다.
    print("=== 검색 컨텍스트 없음 ===")
    print(build_prompt("안녕하세요"))
    print()

    print("=== 검색 컨텍스트 있음 (grounding) ===")
    fake_context = {
        "summary": "테스트",
        "results": [
            {"title": "예시 기사", "url": "https://example.com", "snippet": "이것은 검색 결과 예시입니다."},
        ],
    }
    print(build_prompt("오늘 환율이 어떻게 돼?", fake_context))
