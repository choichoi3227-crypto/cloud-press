"""
Nano-Tech Artist 단계 2 — Sana-0.6B 파인튜닝용 캡션 데이터셋 준비.

generate_dataset.py가 만드는 (이미지, {color, shape}) 라벨을, Sana/diffusers의
표준 text-to-image 파인튜닝이 기대하는 (이미지, 텍스트 캡션) 형식으로 변환한다.
HuggingFace의 imagefolder 데이터셋 포맷(metadata.jsonl + 이미지 파일들)을 따른다.

원칙 (docs/15-stage2-pretrained-finetuning.md 3.2절 옵션 A):
  - 캡션은 100% 프로그래밍적으로 생성한다 (외부 캡셔닝 모델이나 서비스에 의존하지 않음).
  - 도형 합성 이미지 자체도 generate_dataset.py로 직접 만든 것이므로, 학습 데이터
    전체가 외부 의존성 없이 재현 가능하다.

사용법:
    python prepare_sana_captions.py --shapes-dir data/shapes --out data/sana_finetune
"""
import argparse
import json
import os
import shutil

# 영어 캡션을 사용한다 — Sana의 사전학습 텍스트 인코더가 영어 위주로 학습되어 있어
# (모델 카드/논문에서 영어+중국어 캡션을 사용), 파인튜닝 시에도 같은 언어로 맞추는 것이
# 사전학습 지식을 최대한 활용하는 데 유리하다.
COLOR_NAMES_EN = {
    "red": "red",
    "blue": "blue",
    "green": "green",
    "yellow": "yellow",
    "purple": "purple",
    "black": "black",
}
SHAPE_NAMES_EN = {
    "circle": "circle",
    "square": "square",
    "triangle": "triangle",
}

CAPTION_TEMPLATES = [
    "a {color} {shape} on a white background",
    "a simple {color} {shape}, minimalist icon style",
    "flat design icon of a {color} {shape}",
    "a {color} colored {shape} shape, clean vector style",
]


def build_caption(color: str, shape: str, template_idx: int) -> str:
    template = CAPTION_TEMPLATES[template_idx % len(CAPTION_TEMPLATES)]
    return template.format(color=COLOR_NAMES_EN[color], shape=SHAPE_NAMES_EN[shape])


def prepare(shapes_dir: str, out_dir: str) -> None:
    with open(os.path.join(shapes_dir, "labels.json"), encoding="utf-8") as f:
        meta = json.load(f)

    os.makedirs(out_dir, exist_ok=True)
    metadata_path = os.path.join(out_dir, "metadata.jsonl")

    with open(metadata_path, "w", encoding="utf-8") as out_f:
        for idx, sample in enumerate(meta["samples"]):
            src = os.path.join(shapes_dir, "images", sample["file"])
            dst = os.path.join(out_dir, sample["file"])
            shutil.copy(src, dst)

            caption = build_caption(sample["color"], sample["shape"], idx)
            out_f.write(json.dumps({"file_name": sample["file"], "text": caption}, ensure_ascii=False) + "\n")

    print(f"변환 완료: {len(meta['samples'])}장 -> {out_dir}")
    print(f"metadata.jsonl 생성됨 (HuggingFace imagefolder 포맷)")
    print("샘플 캡션 3개:")
    with open(metadata_path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            row = json.loads(line)
            print(f"  {row['file_name']}: \"{row['text']}\"")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shapes-dir", type=str, default="data/shapes",
                         help="generate_dataset.py로 만든 도형 데이터셋 경로")
    parser.add_argument("--out", type=str, default="data/sana_finetune")
    args = parser.parse_args()
    prepare(args.shapes_dir, args.out)


if __name__ == "__main__":
    main()
