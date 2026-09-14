"""JSONL 형식(intent, input, response)의 대화 데이터를 PyTorch Dataset으로 로드한다."""
import json

import torch
from torch.utils.data import Dataset

from tokenizer import Tokenizer


class DialogueDataset(Dataset):
    def __init__(self, jsonl_path: str, tokenizer: Tokenizer, intent_to_idx: dict[str, int], max_len: int = 24):
        self.rows = []
        with open(jsonl_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.rows.append(json.loads(line))
        self.tokenizer = tokenizer
        self.intent_to_idx = intent_to_idx
        self.max_len = max_len

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int):
        row = self.rows[idx]
        ids = self.tokenizer.encode(row["input"], max_len=self.max_len)
        label = self.intent_to_idx[row["intent"]]
        return torch.tensor(ids, dtype=torch.long), torch.tensor(label, dtype=torch.long)


def build_intent_maps(jsonl_path: str) -> tuple[dict[str, int], dict[int, str]]:
    intents = set()
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                intents.add(json.loads(line)["intent"])
    intent_list = sorted(intents)
    intent_to_idx = {name: i for i, name in enumerate(intent_list)}
    idx_to_intent = {i: name for name, i in intent_to_idx.items()}
    return intent_to_idx, idx_to_intent


def build_response_bank(jsonl_path: str) -> dict[str, list[str]]:
    """의도별 응답 후보 목록. 추론 시 여기서 하나를 골라 반환한다."""
    bank: dict[str, set[str]] = {}
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            bank.setdefault(row["intent"], set()).add(row["response"])
    return {k: sorted(v) for k, v in bank.items()}
