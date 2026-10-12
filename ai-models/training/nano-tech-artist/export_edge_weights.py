"""
학습된 Generator(generator_final.pt)를 Cloudflare Worker용 단일 바이너리로 내보낸다.

- eval 모드 BatchNorm(running_mean/var, gamma, beta)을 ConvTranspose2d 가중치/편향에 접어 넣는다(fold).
  => Worker 쪽은 conv + bias + ReLU/Tanh 만 하면 된다.
- 가중치는 float16으로 저장 (약 7.4MB, KV 25MB 제한 이내).

포맷: [u32 LE: 헤더 JSON 길이][헤더 JSON(utf-8)][float16 데이터...]
헤더: {"version":1,"noise_dim":100,"cond_dim":9,"layers":[{"cin","cout","k","stride","pad","act","w_off","b_off"}...]}
오프셋은 float16 원소 단위(데이터 영역 시작 기준).

사용:
    python export_edge_weights.py --weights checkpoints/generator_final.pt --out nta-edge-v1.bin
    npx wrangler kv key put "edge-weights:nta:v1" --path nta-edge-v1.bin --binding CACHE_KV --remote
"""
import argparse
import json
import struct

import numpy as np
import torch

from model import Generator, NOISE_DIM, COND_DIM


def export(weights_path: str, out_path: str) -> None:
    gen = Generator()
    gen.load_state_dict(torch.load(weights_path, map_location="cpu"))
    gen.eval()

    mods = list(gen.net)
    layers, chunks, cursor = [], [], 0

    def push(arr: np.ndarray) -> int:
        nonlocal cursor
        off = cursor
        flat = arr.astype(np.float16).ravel()
        chunks.append(flat)
        cursor += flat.size
        return off

    i = 0
    while i < len(mods):
        conv = mods[i]
        assert isinstance(conv, torch.nn.ConvTranspose2d), type(conv)
        w = conv.weight.detach().double().numpy()  # (cin, cout, k, k)
        b = np.zeros(w.shape[1], dtype=np.float64)
        j = i + 1
        if isinstance(mods[j], torch.nn.BatchNorm2d):
            bn = mods[j]
            scale = bn.weight.detach().double().numpy() / np.sqrt(bn.running_var.detach().double().numpy() + bn.eps)
            w = w * scale[None, :, None, None]
            b = bn.bias.detach().double().numpy() - bn.running_mean.detach().double().numpy() * scale
            j += 1
        act = "relu" if isinstance(mods[j], torch.nn.ReLU) else "tanh"
        layers.append({
            "cin": w.shape[0], "cout": w.shape[1], "k": conv.kernel_size[0],
            "stride": conv.stride[0], "pad": conv.padding[0], "act": act,
            "w_off": push(w), "b_off": push(b),
        })
        i = j + 1

    header = json.dumps({"version": 1, "noise_dim": NOISE_DIM, "cond_dim": COND_DIM, "layers": layers}).encode()
    data = np.concatenate(chunks).astype("<f2").tobytes()
    with open(out_path, "wb") as f:
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        f.write(data)
    print(f"saved {out_path}: {len(header) + len(data) + 4} bytes, {len(layers)} layers")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--weights", required=True)
    p.add_argument("--out", default="nta-edge-v1.bin")
    a = p.parse_args()
    export(a.weights, a.out)
