"""
Nano-Tech Artist 단계 1 학습 스크립트.

로컬/Colab 겸용. GPU(cuda) · TPU(torch_xla) · CPU 모두 지원한다.
Colab에서 실행할 때는 CHECKPOINT_DIR을 Google Drive 마운트 경로로 지정하여
세션이 끊겨도 이어서 학습할 수 있도록 한다 (docs/02-training-pipeline.md 참조).

2단계 학습 흐름 (GPU 사전학습 → TPU 본학습):
    # 1) GPU 런타임: 소량 데이터로 사전학습
    python train.py --device cuda --data data/shapes_small --checkpoint-dir ckpt/gpu_pretrain --epochs 30
    # 2) TPU 런타임: 사전학습 가중치로 시작해 대량 데이터로 본학습 (optimizer/epoch는 새로 시작)
    python train.py --device tpu --data data/shapes_large --checkpoint-dir ckpt/tpu_main \
        --init-from ckpt/gpu_pretrain/generator_and_disc.pt --epochs 100
같은 --checkpoint-dir에 latest.pt가 있으면 --init-from보다 우선해 그 지점부터 재개한다.
체크포인트는 장치 독립(CPU 텐서)으로 읽으므로 GPU에서 저장한 것을 TPU에서 읽을 수 있다(반대도 가능).

사용법(단일 실행):
    python train.py --data data/shapes --checkpoint-dir checkpoints --epochs 50
"""
import argparse
import os
import random

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torch.utils.data.distributed import DistributedSampler

from dataset import ShapesDataset, condition_to_onehot  # noqa: F401
from model import NOISE_DIM, Discriminator, Generator, weights_init

SEED = 42


def set_seed(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)  # CUDA가 없으면 아무 일도 하지 않는다


def resolve_device_kind(arg: str) -> str:
    """auto는 cuda가 있으면 cuda, 아니면 cpu. TPU는 오사용 방지를 위해 --device tpu로 명시해야 한다."""
    if arg != "auto":
        return arg
    return "cuda" if torch.cuda.is_available() else "cpu"


def _save(obj, path: str, kind: str) -> None:
    if kind == "tpu":
        import torch_xla.core.xla_model as xm
        xm.save(obj, path)  # 모든 코어가 호출해야 하며, 실제 파일 쓰기는 마스터만 수행
    else:
        torch.save(obj, path)


def save_checkpoint(path: str, epoch: int, gen: Generator, disc: Discriminator,
                    opt_g: torch.optim.Optimizer, opt_d: torch.optim.Optimizer, kind: str = "cpu") -> None:
    _save(
        {
            "epoch": epoch,
            "generator_state": gen.state_dict(),
            "discriminator_state": disc.state_dict(),
            "opt_g_state": opt_g.state_dict(),
            "opt_d_state": opt_d.state_dict(),
        },
        path,
        kind,
    )


def load_checkpoint_if_exists(path: str, gen: Generator, disc: Discriminator,
                              opt_g: torch.optim.Optimizer, opt_d: torch.optim.Optimizer) -> int:
    """체크포인트가 있으면 로드하고 재개할 epoch 번호를 반환, 없으면 0. (항상 CPU로 읽어 장치 독립)"""
    if not os.path.exists(path):
        return 0
    ckpt = torch.load(path, map_location="cpu")
    gen.load_state_dict(ckpt["generator_state"])
    disc.load_state_dict(ckpt["discriminator_state"])
    opt_g.load_state_dict(ckpt["opt_g_state"])
    opt_d.load_state_dict(ckpt["opt_d_state"])
    start_epoch = ckpt["epoch"] + 1
    print(f"체크포인트에서 재개: epoch {start_epoch}")
    return start_epoch


def load_init_weights(path: str, gen: Generator, disc: Discriminator) -> None:
    """사전학습 체크포인트에서 G/D 가중치만 가져온다 (optimizer·epoch는 새로 시작)."""
    ckpt = torch.load(path, map_location="cpu")
    gen.load_state_dict(ckpt["generator_state"])
    disc.load_state_dict(ckpt["discriminator_state"])
    print(f"사전학습 가중치로 초기화: {path} (사전학습 epoch {ckpt.get('epoch', -1) + 1})")


def train(args: argparse.Namespace, kind: str) -> None:
    set_seed(SEED)

    rank, world, master = 0, 1, True
    if kind == "tpu":
        import torch_xla
        import torch_xla.core.xla_model as xm
        import torch_xla.distributed.parallel_loader as pl
        import torch_xla.runtime as xr

        device = torch_xla.device() if hasattr(torch_xla, "device") else xm.xla_device()
        rank, world = xr.global_ordinal(), xr.world_size()
        master = rank == 0
    else:
        device = torch.device(kind)
    if master:
        print(f"device: {device} (kind={kind}, world_size={world})")

    os.makedirs(args.checkpoint_dir, exist_ok=True)
    ckpt_path = os.path.join(args.checkpoint_dir, "latest.pt")

    dataset = ShapesDataset(args.data, image_size=args.image_size)
    if kind == "tpu":
        # 코어마다 서로 다른 데이터 조각을 본다. --batch-size는 코어당 크기(전체 = batch_size × world_size).
        sampler = DistributedSampler(dataset, num_replicas=world, rank=rank, shuffle=True, drop_last=True)
        raw_loader = DataLoader(dataset, batch_size=args.batch_size, sampler=sampler,
                                drop_last=True, num_workers=args.num_workers)
        loader = pl.MpDeviceLoader(raw_loader, device)  # 배치를 TPU로 미리 올려주고 step 경계를 표시
        n_batches = len(raw_loader)
    else:
        sampler = None
        loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, drop_last=True,
                            num_workers=args.num_workers)
        n_batches = len(loader)
    if master:
        print(f"데이터셋 크기: {len(dataset)}장, 배치 수/epoch(코어당): {n_batches}")

    # 모든 코어가 같은 초기 가중치를 갖도록 같은 시드로 초기화
    gen = Generator()
    disc = Discriminator()
    gen.apply(weights_init)
    disc.apply(weights_init)
    gen, disc = gen.to(device), disc.to(device)

    criterion = nn.BCELoss()
    opt_g = torch.optim.Adam(gen.parameters(), lr=args.lr, betas=(0.5, 0.999))
    opt_d = torch.optim.Adam(disc.parameters(), lr=args.lr, betas=(0.5, 0.999))

    start_epoch = load_checkpoint_if_exists(ckpt_path, gen, disc, opt_g, opt_d)
    if start_epoch == 0 and args.init_from:
        load_init_weights(args.init_from, gen, disc)

    # 코어마다 서로 다른 노이즈를 쓰도록 초기화 이후에 시드를 다르게 설정
    torch.manual_seed(SEED + rank)

    real_label, fake_label = 1.0, 0.0

    for epoch in range(start_epoch, args.epochs):
        if sampler is not None:
            sampler.set_epoch(epoch)
        d_loss_sum = torch.zeros((), device=device)
        g_loss_sum = torch.zeros((), device=device)
        for real_imgs, cond in loader:
            if kind != "tpu":  # MpDeviceLoader는 이미 장치 위에 올려서 준다
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
            if kind == "tpu":
                xm.optimizer_step(opt_d)  # 코어 간 gradient 평균 + step
            else:
                opt_d.step()

            # --- Generator 학습 ---
            opt_g.zero_grad()
            out_fake_for_g = disc(fake_imgs, cond)
            loss_g = criterion(out_fake_for_g, labels_real)  # generator는 discriminator를 속이려 함
            loss_g.backward()
            if kind == "tpu":
                xm.optimizer_step(opt_g)
            else:
                opt_g.step()

            # .item() 호출은 TPU에서 매 step 동기화를 일으켜 느려지므로 장치 위에서 누적한다
            d_loss_sum += loss_d.detach()
            g_loss_sum += loss_g.detach()

        avg_d = d_loss_sum.item() / n_batches
        avg_g = g_loss_sum.item() / n_batches
        if kind == "tpu":
            avg_d = xm.mesh_reduce("d_loss", avg_d, lambda v: sum(v) / len(v))
            avg_g = xm.mesh_reduce("g_loss", avg_g, lambda v: sum(v) / len(v))
        if master:
            print(f"[epoch {epoch+1}/{args.epochs}] D_loss={avg_d:.4f} G_loss={avg_g:.4f}")

        save_checkpoint(ckpt_path, epoch, gen, disc, opt_g, opt_d, kind)
        if (epoch + 1) % args.checkpoint_every == 0:
            save_checkpoint(os.path.join(args.checkpoint_dir, f"epoch_{epoch+1}.pt"), epoch, gen, disc, opt_g, opt_d, kind)

    # 2단계 학습의 --init-from 용(G+D 가중치, optimizer 제외)과 배포용 Generator를 저장
    _save({"epoch": args.epochs - 1, "generator_state": gen.state_dict(),
           "discriminator_state": disc.state_dict()},
          os.path.join(args.checkpoint_dir, "generator_and_disc.pt"), kind)
    final_path = os.path.join(args.checkpoint_dir, "generator_final.pt")
    _save(gen.state_dict(), final_path, kind)
    if master:
        print(f"학습 완료. 최종 Generator 저장: {final_path}")


def _tpu_entry(index: int, args: argparse.Namespace) -> None:
    train(args, "tpu")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="data/shapes")
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=64, help="TPU에서는 코어당 배치 크기")
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--image-size", type=int, default=64)
    parser.add_argument("--checkpoint-every", type=int, default=5)
    parser.add_argument("--device", choices=["auto", "cuda", "tpu", "cpu"], default="auto")
    parser.add_argument("--init-from", type=str, default=None,
                        help="사전학습 체크포인트(generator_and_disc.pt 또는 latest.pt)에서 G/D 가중치만 가져와 시작")
    parser.add_argument("--num-workers", type=int, default=2, help="DataLoader 워커 수 (이미지 디코딩용)")
    args = parser.parse_args()

    kind = resolve_device_kind(args.device)
    if kind == "tpu":
        import torch_xla
        torch_xla.launch(_tpu_entry, args=(args,))  # TPU 코어마다 프로세스를 띄워 train()을 실행
    else:
        train(args, kind)


if __name__ == "__main__":
    main()
