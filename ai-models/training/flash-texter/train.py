"""
Flash Texter 단계 1 학습 스크립트 — 의도 분류 인코더 학습.

사용법:
    python train.py --data data/raw/seed_dialogues.jsonl --checkpoint-dir checkpoints --epochs 30
"""
import argparse
import json
import os
import random

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, random_split

from dataset import DialogueDataset, build_intent_maps, build_response_bank
from model import IntentEncoder
from tokenizer import Tokenizer

SEED = 42


def set_seed(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def save_checkpoint(path: str, epoch: int, model: IntentEncoder, optimizer: torch.optim.Optimizer,
                     tokenizer: Tokenizer, intent_to_idx: dict, response_bank: dict) -> None:
    torch.save(
        {
            "epoch": epoch,
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "vocab": tokenizer.vocab,
            "intent_to_idx": intent_to_idx,
            "response_bank": response_bank,
            "model_config": {
                "vocab_size": tokenizer.vocab_size,
                "num_intents": len(intent_to_idx),
            },
        },
        path,
    )


def evaluate(model: IntentEncoder, loader: DataLoader, device: torch.device) -> float:
    model.eval()
    correct, total = 0, 0
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            logits = model(x)
            preds = logits.argmax(dim=1)
            correct += (preds == y).sum().item()
            total += y.size(0)
    model.train()
    return correct / total if total > 0 else 0.0


def train(args: argparse.Namespace) -> None:
    set_seed(SEED)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    os.makedirs(args.checkpoint_dir, exist_ok=True)
    ckpt_path = os.path.join(args.checkpoint_dir, "latest.pt")

    # 토크나이저: 체크포인트가 있으면 거기서 vocab 복원 (재현성/일관성 유지), 없으면 새로 빌드
    intent_to_idx, idx_to_intent = build_intent_maps(args.data)
    response_bank = build_response_bank(args.data)

    all_texts = []
    with open(args.data, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                all_texts.append(json.loads(line)["input"])

    start_epoch = 0
    if os.path.exists(ckpt_path):
        ckpt = torch.load(ckpt_path, map_location=device)
        tokenizer = Tokenizer(ckpt["vocab"])
        intent_to_idx = ckpt["intent_to_idx"]
        response_bank = ckpt["response_bank"]
        cfg = ckpt["model_config"]
        model = IntentEncoder(cfg["vocab_size"], cfg["num_intents"]).to(device)
        model.load_state_dict(ckpt["model_state"])
        optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
        optimizer.load_state_dict(ckpt["optimizer_state"])
        start_epoch = ckpt["epoch"] + 1
        print(f"체크포인트에서 재개: epoch {start_epoch}")
    else:
        tokenizer = Tokenizer.build(all_texts, min_freq=1)
        model = IntentEncoder(tokenizer.vocab_size, len(intent_to_idx)).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    print(f"vocab_size={tokenizer.vocab_size}, num_intents={len(intent_to_idx)}")

    dataset = DialogueDataset(args.data, tokenizer, intent_to_idx, max_len=args.max_len)
    val_size = max(1, int(len(dataset) * 0.15))
    train_size = len(dataset) - val_size
    train_set, val_set = random_split(
        dataset, [train_size, val_size], generator=torch.Generator().manual_seed(SEED)
    )
    train_loader = DataLoader(train_set, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_set, batch_size=args.batch_size, shuffle=False)

    criterion = nn.CrossEntropyLoss()

    for epoch in range(start_epoch, args.epochs):
        total_loss = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad()
            logits = model(x)
            loss = criterion(logits, y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        avg_loss = total_loss / len(train_loader)
        val_acc = evaluate(model, val_loader, device)
        print(f"[epoch {epoch+1}/{args.epochs}] loss={avg_loss:.4f} val_acc={val_acc:.4f}")

        save_checkpoint(ckpt_path, epoch, model, optimizer, tokenizer, intent_to_idx, response_bank)

    final_acc = evaluate(model, val_loader, device)
    print(f"학습 완료. 최종 검증 정확도: {final_acc:.4f}")

    final_path = os.path.join(args.checkpoint_dir, "flash_texter_final.pt")
    save_checkpoint(final_path, args.epochs - 1, model, optimizer, tokenizer, intent_to_idx, response_bank)
    print(f"최종 체크포인트 저장: {final_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="data/raw/seed_dialogues.jsonl")
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--max-len", type=int, default=24)
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
