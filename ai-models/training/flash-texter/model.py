"""
Flash Texter 단계 1 모델.

설계 결정: 순수 seq2seq(디코더가 토큰을 한 개씩 생성)는 이 정도 데이터 규모
(수백 쌍)에서는 문법이 깨진 출력이 나올 위험이 커서, 인코더는 실제 신경망으로
학습시키고 디코더 역할은 "학습된 의도 분류 결과에 따라 검증된 응답 후보 중
하나를 선택"하는 방식으로 단순화한다 (docs/03-flash-texter-spec.md의
"의도 분류 + 템플릿 응답" 경로).

이 구조는 완전한 자유 생성은 아니지만:
  1) 실제 임베딩+GRU가 gradient descent로 학습된다 (더미/규칙 기반이 아님)
  2) 항상 문법적으로 올바른 한국어 응답을 보장한다
  3) 단계 2(Transformer 요약/변환), 단계 3(자유 생성 GPT류)로 넘어갈 인터페이스를
     그대로 유지한다 (generate_response 시그니처 불변)
"""
import torch
import torch.nn as nn

PAD_IDX = 0


class IntentEncoder(nn.Module):
    """입력 문장을 임베딩 + bidirectional GRU로 인코딩해 의도를 분류한다."""

    def __init__(self, vocab_size: int, num_intents: int, emb_dim: int = 128, hidden_dim: int = 128):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, emb_dim, padding_idx=PAD_IDX)
        self.gru = nn.GRU(
            emb_dim, hidden_dim, num_layers=2, batch_first=True, bidirectional=True, dropout=0.2
        )
        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden_dim, num_intents),
        )

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        # input_ids: (batch, seq_len)
        emb = self.embedding(input_ids)
        _, hidden = self.gru(emb)  # hidden: (num_layers*2, batch, hidden_dim)
        # 마지막 레이어의 forward/backward hidden state를 concat
        last_fwd = hidden[-2]
        last_bwd = hidden[-1]
        combined = torch.cat([last_fwd, last_bwd], dim=1)  # (batch, hidden_dim*2)
        logits = self.classifier(combined)
        return logits
