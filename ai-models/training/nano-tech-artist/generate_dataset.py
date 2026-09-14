"""
Nano-Tech Artist 단계 1을 위한 합성 데이터셋 생성기.

실제 이미지 데이터셋을 수집할 필요 없이, 코드로 도형(원/사각형/삼각형)을
다양한 색상·크기·위치로 그려서 (이미지, 조건 라벨) 쌍을 만든다.
라벨이 100% 정확하고 무제한으로 생성 가능하다는 것이 핵심 장점이다.

사용법:
    python generate_dataset.py --out data/shapes --count 6000 --size 64
"""
import argparse
import json
import os
import random

from PIL import Image, ImageDraw

COLORS = {
    "red": (220, 50, 50),
    "blue": (50, 90, 220),
    "green": (50, 180, 80),
    "yellow": (230, 200, 40),
    "purple": (150, 60, 180),
    "black": (30, 30, 30),
}
SHAPES = ["circle", "square", "triangle"]

COLOR_NAMES = list(COLORS.keys())


def draw_sample(color_name: str, shape: str, size: int = 64, seed: int | None = None) -> Image.Image:
    """조건(color, shape)에 맞는 도형 이미지 한 장을 생성한다.

    위치와 크기를 약간 랜덤화하여 같은 조건이라도 매번 조금씩 다른 이미지가
    나오게 한다 (모델이 "정확히 한 장만 외우는" 것을 방지).
    """
    rng = random.Random(seed)
    img = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    color = COLORS[color_name]

    # 크기: 전체의 55%~80% 사이에서 랜덤화
    scale = rng.uniform(0.55, 0.8)
    shape_size = size * scale
    max_offset = size - shape_size
    x0 = rng.uniform(0, max_offset)
    y0 = rng.uniform(0, max_offset)
    x1 = x0 + shape_size
    y1 = y0 + shape_size
    box = [x0, y0, x1, y1]

    if shape == "circle":
        draw.ellipse(box, fill=color)
    elif shape == "square":
        draw.rectangle(box, fill=color)
    elif shape == "triangle":
        draw.polygon([((x0 + x1) / 2, y0), (x0, y1), (x1, y1)], fill=color)
    else:
        raise ValueError(f"unknown shape: {shape}")

    return img


def generate_dataset(out_dir: str, count: int, size: int, seed: int = 42) -> None:
    os.makedirs(out_dir, exist_ok=True)
    images_dir = os.path.join(out_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    rng = random.Random(seed)
    labels = []

    # 조건 조합(색상 x 도형)이 균등하게 분포하도록 미리 조합 리스트를 만들고 셔플
    combos = [(c, s) for c in COLOR_NAMES for s in SHAPES]
    per_combo = count // len(combos)
    remainder = count % len(combos)

    plan = []
    for combo in combos:
        plan.extend([combo] * per_combo)
    # 나머지는 랜덤 조합으로 채움
    plan.extend(rng.choices(combos, k=remainder))
    rng.shuffle(plan)

    for idx, (color_name, shape) in enumerate(plan):
        img_seed = seed * 1000003 + idx
        img = draw_sample(color_name, shape, size=size, seed=img_seed)
        filename = f"{idx:06d}.png"
        img.save(os.path.join(images_dir, filename))
        labels.append({"file": filename, "color": color_name, "shape": shape})

    with open(os.path.join(out_dir, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "colors": COLOR_NAMES,
                "shapes": SHAPES,
                "size": size,
                "samples": labels,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"생성 완료: {len(labels)}장, 저장 위치: {out_dir}")
    # 조건별 개수 요약
    from collections import Counter

    counter = Counter((s["color"], s["shape"]) for s in labels)
    for combo in combos:
        print(f"  {combo[0]:>7} / {combo[1]:>8}: {counter[combo]}장")


def main():
    parser = argparse.ArgumentParser(description="Nano-Tech Artist 합성 도형 데이터셋 생성기")
    parser.add_argument("--out", type=str, default="data/shapes", help="출력 디렉토리")
    parser.add_argument("--count", type=int, default=6000, help="생성할 이미지 총 개수")
    parser.add_argument("--size", type=int, default=64, help="이미지 한 변 크기(px)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    generate_dataset(args.out, args.count, args.size, args.seed)


if __name__ == "__main__":
    main()
