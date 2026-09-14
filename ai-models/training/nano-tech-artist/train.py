"""
Nano-Tech Artist 단계 1 학습 스크립트.

로컬/Colab 겸용. Colab에서 실행할 때는 CHECKPOINT_DIR을 Google Drive 마운트
경로로 지정하여 세션이 끊겨도 이어서 학습할 수 있도록 한다 (docs/02-training-pipeline.md 참조).

사용법:
    python train.py --data data/shapes --checkpoint-dir checkpoints --epochs 50
"""
import argparse
import os
import random

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

from dataset import ShapesDataset, condition_to_onehot
from model import NOISE_DIM, Discriminator, Generator, weights_init

SEED = 42


def set_seed(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def save_checkpoint(path: str, epoch: int, gen: Generator, disc: Discriminator,
                     opt_g: torch.optim.Optimizer, opt_d: torch.optim.Optimizer) -> None:
    torch.save(
        {
            "epoch": epoch,
            "generator_state": gen.state_dict(),
            "discriminator_state": disc.state_dict(),
            "opt_g_state": opt_g.state_dict(),
            "opt_d_state": opt_d.state_dict(),
        },
        path,
    )


def load_checkpoint_if_exists(path: str, gen: Generator, disc: Discriminator,
                               opt_g: torch.optim.Optimizer, opt_d: torch.optim.Optimizer,
                               device: torch.device) -> int:
    """체크포인트가 있으면 로드하고 재개할 epoch 번호를 반환, 없으면 0."""
    if not os.path.exists(path):
        return 0
    ckpt = torch.load(path, map_location=device)
    gen.load_state_dict(ckpt["generator_state"])
    disc.load_state_dict(ckpt["discriminator_state"])
    opt_g.load_state_dict(ckpt["opt_g_state"])
    opt_d.load_state_dict(ckpt["opt_d_state"])
    start_epoch = ckpt["epoch"] + 1
    print(f"체크포인트에서 재개: epoch {start_epoch}")
    return start_epoch


def train(args: argparse.Namespace) -> None:
    set_seed(SEED)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device}")

    os.makedirs(args.checkpoint_dir, exist_ok=True)
    ckpt_path = os.path.join(args.checkpoint_dir, "latest.pt")

    dataset = ShapesDataset(args.data, image_size=args.image_size)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, drop_last=True)
    print(f"데이터셋 크기: {len(dataset)}장, 배치 수/epoch: {len(loader)}")

    gen = Generator().to(device)
    disc = Discriminator().to(device)
    gen.apply(weights_init)
    disc.apply(weights_init)

    criterion = nn.BCELoss()
    opt_g = torch.optim.Adam(gen.parameters(), lr=args.lr, betas=(0.5, 0.999))
    opt_d = torch.optim.Adam(disc.parameters(), lr=args.lr, betas=(0.5, 0.999))

    start_epoch = load_checkpoint_if_exists(ckpt_path, gen, disc, opt_g, opt_d, device)

    real_label, fake_label = 1.0, 0.0

    for epoch in range(start_epoch, args.epochs):
        d_loss_sum, g_loss_sum = 0.0, 0.0
        for real_imgs, cond in loader:
            real_imgs = real_imgs.to(device)
            cond = cond.to(device)
            batch_size = real_imgs.size(0)

            # --- Discriminator 학습 ---
            opt_d.zero_grad()
            labels_real = torch.full((batch_size,), real_label, device=device)
            out_real = disc(real_imgs, cond)
            loss_d_real = criterion(out_real, labels_real)

            noise = torch.randn(batch_size, NOISE_DIM, device=device)
            fake_imgs = gen(noise, cond)
            labels_fake = torch.full((batch_size,), fake_label, device=device)
            out_fake = disc(fake_imgs.detach(), cond)
            loss_d_fake = criterion(out_fake, labels_fake)

            loss_d = loss_d_real + loss_d_fake
            loss_d.backward()
            opt_d.step()

            # --- Generator 학습 ---
            opt_g.zero_grad()
            out_fake_for_g = disc(fake_imgs, cond)
            loss_g = criterion(out_fake_for_g, labels_real)  # generator는 discriminator를 속이려 함
            loss_g.backward()
            opt_g.step()

            d_loss_sum += loss_d.item()
            g_loss_sum += loss_g.item()

        avg_d = d_loss_sum / len(loader)
        avg_g = g_loss_sum / len(loader)
        print(f"[epoch {epoch+1}/{args.epochs}] D_loss={avg_d:.4f} G_loss={avg_g:.4f}")

        save_checkpoint(ckpt_path, epoch, gen, disc, opt_g, opt_d)
        if (epoch + 1) % args.checkpoint_every == 0:
            save_checkpoint(os.path.join(args.checkpoint_dir, f"epoch_{epoch+1}.pt"), epoch, gen, disc, opt_g, opt_d)

    # 최종 추론용 Generator만 별도 저장 (배포용 경량 파일)
    final_path = os.path.join(args.checkpoint_dir, "generator_final.pt")
    torch.save(gen.state_dict(), final_path)
    print(f"학습 완료. 최종 Generator 저장: {final_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="data/shapes")
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--image-size", type=int, default=64)
    parser.add_argument("--checkpoint-every", type=int, default=5)
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()
