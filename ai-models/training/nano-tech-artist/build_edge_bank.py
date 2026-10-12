"""
Cloudflare 무료 플랜용 '사전 생성 이미지 뱅크'를 만든다. (numpy만 필요, torch 불필요)

무료 플랜은 요청당 CPU 10ms라 Worker에서 cGAN을 직접 돌릴 수 없다.
대신 오프라인(Colab/로컬)에서 클래스(색×도형)마다 N장을 미리 생성해 KV에 올리고,
Worker는 KV에서 한 줄(base64 PNG)을 골라 반환만 한다. (CPU 거의 0)

입력: (선택) export_edge_weights.py 가 만든 nta-edge-v1.bin — 없으면 학습 없이 도형 렌더러로 생성
출력: edge-bank-bulk.json  (wrangler kv bulk put 형식)

    python build_edge_bank.py                       # 학습 없이 즉시 (초보자 권장)
    python build_edge_bank.py --weights nta-edge-v1.bin   # GAN 결과로 생성
    npx wrangler kv bulk put edge-bank-bulk.json --binding CACHE_KV --remote
"""
import argparse, base64, json, struct, zlib
import numpy as np

COLORS = ["red", "blue", "green", "yellow", "purple", "black"]
SHAPES = ["circle", "square", "triangle"]
KEY_FMT = "edge-bank:nta:v1:{color}:{shape}"


def load(path):
    b = open(path, "rb").read()
    n, = struct.unpack("<I", b[:4])
    hdr = json.loads(b[4:4 + n])
    data = np.frombuffer(b[4 + n:], dtype="<f2").astype(np.float32)
    layers = []
    for m in hdr["layers"]:
        w = data[m["w_off"]:m["w_off"] + m["cin"] * m["cout"] * m["k"] ** 2].reshape(m["cin"], m["cout"], m["k"], m["k"])
        bb = data[m["b_off"]:m["b_off"] + m["cout"]]
        layers.append((w, bb, m["stride"], m["pad"], m["act"]))
    return hdr, layers


def conv_t(x, w, b, s, p):
    """x: (B,cin,h,w) → (B,cout,oh,ow), ConvTranspose2d + bias."""
    B, cin, h, wd = x.shape
    _, cout, k, _ = w.shape
    oh = (h - 1) * s - 2 * p + k
    full = np.zeros((B, cout, (h - 1) * s + k, (wd - 1) * s + k), np.float32)
    for iy in range(h):
        for ix in range(wd):
            full[:, :, iy * s:iy * s + k, ix * s:ix * s + k] += np.einsum("bi,ijkl->bjkl", x[:, :, iy, ix], w)
    return full[:, :, p:p + oh, p:p + oh] + b[None, :, None, None]


def generate(layers, noise, cond):
    x = np.concatenate([noise, cond], axis=1)[:, :, None, None].astype(np.float32)
    for w, b, s, p, act in layers:
        x = conv_t(x, w, b, s, p)
        x = np.maximum(x, 0) if act == "relu" else np.tanh(x)
    return x


def png(rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))
    def ch(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b"")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=None, help="없으면 학습 데이터와 같은 방식의 도형 렌더러(generate_dataset.py)로 뱅크 생성 — 학습 불필요")
    ap.add_argument("--per-class", type=int, default=24)
    ap.add_argument("--out", default="edge-bank-bulk.json")
    ap.add_argument("--seed", type=int, default=1234)
    a = ap.parse_args()
    if a.weights:
        hdr, layers = load(a.weights)
    rng = np.random.default_rng(a.seed)
    entries, total = [], 0
    for ci, color in enumerate(COLORS):
        for si, shape in enumerate(SHAPES):
            lines = []
            if a.weights:
                cond = np.zeros((a.per_class, hdr["cond_dim"]), np.float32)
                cond[:, ci] = 1
                cond[:, len(COLORS) + si] = 1
                noise = rng.standard_normal((a.per_class, hdr["noise_dim"])).astype(np.float32)
                imgs = generate(layers, noise, cond)
                for im in imgs:
                    rgb = np.round((np.clip(im, -1, 1) + 1) / 2 * 255).astype(np.uint8).transpose(1, 2, 0)
                    lines.append(base64.b64encode(png(rgb)).decode())
            else:
                # 학습 없이: 학습 데이터셋과 같은 분포의 도형 이미지를 직접 렌더링
                from generate_dataset import draw_sample
                for n in range(a.per_class):
                    img = draw_sample(color, shape, size=64, seed=a.seed * 1000003 + (ci * 3 + si) * 10007 + n)
                    lines.append(base64.b64encode(png(np.asarray(img, dtype=np.uint8))).decode())
            value = "\n".join(lines)
            total += len(value)
            entries.append({"key": KEY_FMT.format(color=color, shape=shape), "value": value})
            print(f"{color}/{shape}: {len(lines)} images, {len(value)//1024} KB")
    json.dump(entries, open(a.out, "w"))
    print(f"wrote {a.out}: {len(entries)} keys, {total//1024} KB total (KV 무료: 값 25MB·저장 1GB 이내)")


if __name__ == "__main__":
    main()
