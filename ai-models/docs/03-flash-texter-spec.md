# Flash Texter — 텍스트 모델 스펙

## 1. 단계별 로드맵

### 단계 1 — 규칙 기반 + 소형 seq2seq 챗봇 (지금 여기서 시작) ✅ 구현 완료

**목표**: 정해진 범위 내에서 질문에 답하는 간단한 챗봇. 진짜 "학습된 모델"이 응답을 생성하는 구조를 처음부터 만드는 것이 목적이며, 성능보다 **파이프라인이 끝까지 작동하는 것**이 중요합니다.

**실제 설계 결정**: 순수 seq2seq(디코더가 토큰을 한 개씩 생성)는 수백 쌍 규모의 데이터에서는 문법이 깨진 출력이 나올 위험이 큽니다. 그래서 단계 1은 다음 구조로 구현했습니다.

- **인코더**: 임베딩(128차원) + 2층 bidirectional GRU(hidden 128) — 입력 문장을 벡터로 인코딩. **이 부분은 실제로 gradient descent로 학습되는 신경망**입니다.
- **"디코더"**: 별도의 생성 디코더 대신, 인코더가 분류한 의도(intent)에 대응하는 **검증된 응답 후보 중 하나를 선택**하는 방식으로 단순화했습니다.
- 이 방식은 완전한 자유 생성은 아니지만 (a) 실제 신경망이 학습되고 (b) 항상 문법적으로 올바른 한국어를 보장하며 (c) `generate_response()` 인터페이스는 단계 2/3과 동일하게 유지되어 나중에 진짜 디코더로 교체 가능합니다.

- 어휘: 어절 단위 토큰화 (형태소 분석기 없이 시작, 데이터가 늘면 교체 검토)
- 파라미터 규모: 대략 수십만~100만 개 (CPU로 수 분 내 학습 가능)

**데이터**: `generate_seed_data.py`로 생성한 7개 의도(인사/감사/날씨/안부/작별/정체성/도움) 템플릿 조합 시드 데이터(280쌍)로 시작. 실전에서는 AI Hub 등 공개 대화 데이터셋으로 확장 권장.

**평가 기준**: 학습/검증 셋 분리 후 의도 분류 정확도(accuracy)를 정량 지표로 사용. 정성 평가로는 실제 문장을 넣어보고 응답이 자연스러운지 확인.

### 단계 2 — 소형 Transformer 기반 요약/변환

**목표**: 입력 텍스트를 받아 요약하거나(예: 긴 글 → 3줄 요약), 형식을 변환(예: 반말 → 존댓말)하는 태스크 전용 모델.

**아키텍처**: 소형 Transformer encoder-decoder (예: 6-layer, d_model=256, 파라미터 약 2,000만~5,000만)

**데이터**: 요약 태스크 공개 데이터셋(예: AI Hub 문서요약 데이터) 활용

### 단계 3 — 자유 텍스트 생성 (GPT류, Flash 방향성)

**목표**: 프롬프트를 받아 자유형식 텍스트를 생성하는 decoder-only Transformer.

**아키텍처**: GPT-2 소형(nanoGPT 스타일) 구조부터 시작 — 파라미터 약 1억(125M) 규모를 1차 목표로 설정. 이후 데이터/자원이 허락하는 대로 확장.

**중요**: 이 단계는 최소 수백억 토큰 규모의 사전학습 데이터와 상당한 GPU 시간이 필요합니다. 무료 Colab GPU만으로는 도달하기 어렵고, 이 시점에는 유상 GPU 임대(RunPod, Vast.ai 등)로 전환하는 것을 전제로 합니다. (`08-roadmap.md` 참조)

## 2. 단계 1 상세 구현 계획

### 2.1 디렉토리 구조

```
training/flash-texter/
├── requirements.txt
├── data/
│   ├── raw/                 # 원본 대화 데이터 (seed_dialogues.jsonl)
│   └── prepared/            # 전처리된 (input, intent, response) 데이터
├── generate_seed_data.py    # 시드 대화 데이터 생성 (템플릿 조합)
├── tokenizer.py             # 어절 기반 토크나이저 (build/encode/decode)
├── model.py                 # IntentEncoder (임베딩+GRU 분류기) 정의
├── train.py                 # 학습 루프 (Colab에서 실행)
├── train_colab.ipynb        # Colab용 노트북 (Drive 마운트, 체크포인트 포함)
└── inference.py             # 학습된 모델로 단일 응답 생성 (추론 서버가 import)
```

### 2.2 모델 정의 (PyTorch, 실제 구현)

```python
import torch.nn as nn

class IntentEncoder(nn.Module):
    """입력 문장을 임베딩 + bidirectional GRU로 인코딩해 의도를 분류한다."""

    def __init__(self, vocab_size, num_intents, emb_dim=128, hidden_dim=128):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, emb_dim, padding_idx=0)
        self.gru = nn.GRU(emb_dim, hidden_dim, num_layers=2, batch_first=True,
                           bidirectional=True, dropout=0.2)
        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden_dim, num_intents),
        )

    def forward(self, input_ids):
        emb = self.embedding(input_ids)
        _, hidden = self.gru(emb)
        combined = torch.cat([hidden[-2], hidden[-1]], dim=1)
        return self.classifier(combined)
```

학습된 인코더가 입력 문장의 의도를 예측하면, 해당 의도에 미리 연결된 응답 후보 중 하나를(다양성을 위해 랜덤 선택) 반환합니다. 이 방식의 장단점은 위 1절의 "실제 설계 결정" 참조.

### 2.3 추론 인터페이스 (추론 서버가 호출하는 계약)

```python
# inference.py
def generate_response(prompt: str, max_length: int = 64) -> str:
    """
    학습된 Flash Texter 모델로 응답 생성.
    추론 서버(FastAPI)의 /v1/text/generate 핸들러가 이 함수를 호출한다.
    """
    ...
    return response_text
```

이 함수 시그니처는 단계가 올라가도(seq2seq → Transformer → GPT) 동일하게 유지하여, 추론 서버 코드를 바꾸지 않고 모델만 교체할 수 있도록 합니다.

## 3. API 계약 (최종 목표 형태, 단계 3까지 동일 인터페이스 유지)

```
POST /v1/text/generate
{
  "prompt": "오늘 날씨 어때?",
  "max_tokens": 128,
  "temperature": 0.8
}

응답:
{
  "model": "flash-texter-v0.1.0",
  "text": "...",
  "usage": { "prompt_tokens": 5, "completion_tokens": 12 }
}
```

단계 1(seq2seq)에서는 `temperature`, `max_tokens` 같은 파라미터를 받되 내부적으로 단순화해서 처리해도 무방합니다. API 계약을 먼저 고정해두면 이후 모델이 바뀌어도 프런트엔드/Worker 코드는 그대로 유지됩니다.
