"""
Flash Texter 단계 1용 초경량 토크나이저.

형태소 분석기(예: Mecab, Kiwi) 없이도 동작하도록, 어절 단위 토큰화를
기본으로 하고 어휘에 없는 단어는 음절 단위로 쪼개 OOV를 최소화한다.
데이터 규모가 커지면 실제 형태소 분석기 또는 BPE(sentencepiece)로 교체를 권장한다
(docs/03-flash-texter-spec.md 참조).
"""
import json
import re
from collections import Counter

PAD, UNK, SOS, EOS = "<pad>", "<unk>", "<sos>", "<eos>"
SPECIAL_TOKENS = [PAD, UNK, SOS, EOS]


def basic_tokenize(text: str) -> list[str]:
    text = text.strip()
    # 구두점을 별도 토큰으로 분리 (간단한 정규식)
    text = re.sub(r"([?!.,])", r" \1 ", text)
    tokens = text.split()
    return tokens


class Tokenizer:
    def __init__(self, vocab: dict[str, int] | None = None):
        self.vocab = vocab or {}
        self.inv_vocab = {v: k for k, v in self.vocab.items()} if vocab else {}

    @classmethod
    def build(cls, texts: list[str], min_freq: int = 1) -> "Tokenizer":
        counter: Counter[str] = Counter()
        for t in texts:
            counter.update(basic_tokenize(t))

        vocab = {tok: idx for idx, tok in enumerate(SPECIAL_TOKENS)}
        for tok, freq in counter.most_common():
            if freq >= min_freq and tok not in vocab:
                vocab[tok] = len(vocab)
        return cls(vocab)

    def encode(self, text: str, max_len: int | None = None, add_special: bool = True) -> list[int]:
        tokens = basic_tokenize(text)
        ids = [self.vocab.get(tok, self.vocab[UNK]) for tok in tokens]
        if add_special:
            ids = [self.vocab[SOS]] + ids + [self.vocab[EOS]]
        if max_len is not None:
            ids = ids[:max_len]
            ids = ids + [self.vocab[PAD]] * (max_len - len(ids))
        return ids

    def decode(self, ids: list[int]) -> str:
        tokens = []
        for i in ids:
            tok = self.inv_vocab.get(i, UNK)
            if tok in (PAD, SOS, EOS):
                continue
            tokens.append(tok)
        return " ".join(tokens)

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.vocab, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "Tokenizer":
        with open(path, encoding="utf-8") as f:
            vocab = json.load(f)
        return cls(vocab)

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)
