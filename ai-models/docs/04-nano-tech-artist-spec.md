# Nano-Tech Artist — 이미지 모델 스펙

## 1. 단계별 로드맵

### 단계 1 — 조건부 도형/패턴 생성 (지금 여기서 시작)

**목표**: "빨간 원", "파란 삼각형 3개" 같은 간단한 조건(색상 + 도형 + 개수)을 입력받아 32x32 또는 64x64 크기의 이미지를 생성. 실제 신경망이 조건에 따라 다른 이미지를 "생성"하는 전체 파이프라인을 완성하는 것이 목표입니다.

**아키텍처**: Conditional GAN (cGAN) — 조건 벡터(색상 원-핫 + 도형 원-핫)를 노이즈와 함께 Generator에 입력.

- 입력 노이즈 차원: 100
- 조건 벡터: 색상 6종 + 도형 3종 = 9차원 원-핫
- Generator: ConvTranspose2d 기반, 64x64x3 출력
- Discriminator: Conv2d 기반, 진짜/가짜 + 조건 일치 여부 판별

**데이터**: 실제 이미지 데이터셋 불필요. `generate_dataset.py`로 도형을 프로그래밍적으로 그려서 (이미지, 조건 라벨) 쌍을 무한정 생성.

### 단계 2 — 해상도/복잡도 확장

- 해상도 64x64 → 128x128
- 도형 조합 복잡도 증가(여러 도형 동시 배치, 배경 패턴)
- 아키텍처를 DCGAN → StyleGAN 계열 경량화 버전으로 발전 검토

### 단계 3 — 텍스트 프롬프트 기반 생성으로 확장

- 자유 텍스트 프롬프트 → 이미지 (Nano Banana 방향성)
- 이 단계는 CLIP류 텍스트 인코더 + diffusion 모델이 필요하며, 대규모 이미지-텍스트 페어 데이터와 상당한 GPU 자원이 필요합니다. 유상 GPU 전환 이후 단계입니다.

## 2. 단계 1 상세 구현 계획

### 2.1 디렉토리 구조

```
training/nano-tech-artist/
├── requirements.txt
├── generate_dataset.py     # 도형 이미지 합성 데이터 생성기
├── dataset.py              # PyTorch Dataset/DataLoader 래퍼
├── model.py                # Generator/Discriminator 정의
├── train.py                # cGAN 학습 루프
├── train_colab.ipynb       # Colab용 노트북
└── inference.py            # 조건 → 이미지 생성 (추론 서버가 import)
```

### 2.2 합성 데이터셋 생성 (개요)

```python
# generate_dataset.py
from PIL import Image, ImageDraw
import random

COLORS = {"red": (220,50,50), "blue": (50,90,220), "green": (50,180,80),
          "yellow": (230,200,40), "purple": (150,60,180), "black": (30,30,30)}
SHAPES = ["circle", "square", "triangle"]

def draw_sample(color_name: str, shape: str, size=64) -> Image.Image:
    img = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    color = COLORS[color_name]
    margin = size // 6
    box = [margin, margin, size - margin, size - margin]
    if shape == "circle":
        draw.ellipse(box, fill=color)
    elif shape == "square":
        draw.rectangle(box, fill=color)
    elif shape == "triangle":
        draw.polygon([(size/2, margin), (margin, size-margin), (size-margin, size-margin)], fill=color)
    return img

# 조건(color, shape) 조합마다 위치/크기를 랜덤화하여 수천 장 생성
```

이 방식이면 라벨이 100% 정확한 데이터셋을 무료로, 무제한에 가깝게 만들 수 있습니다.

### 2.3 추론 인터페이스

```python
# inference.py
def generate_image(color: str, shape: str, seed: int | None = None) -> bytes:
    """
    조건(color, shape)에 맞는 이미지를 생성해 PNG 바이트로 반환.
    추론 서버의 /v1/image/generate 핸들러가 이 함수를 호출한다.
    """
    ...
    return png_bytes
```

## 3. API 계약

```
POST /v1/image/generate
{
  "prompt_type": "condition",       // 단계1: 구조화된 조건, 단계3부터: "text"
  "color": "red",
  "shape": "circle"
}

응답:
{
  "model": "nano-tech-artist-v0.1.0",
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "format": "png"
}
```

단계 3에서 텍스트 프롬프트 입력으로 확장할 때는 `prompt_type: "text", "prompt": "..."` 필드를 추가하는 방식으로 하위 호환을 유지합니다.

## 4. 평가 기준 (단계 1)

- 정성 평가: 생성된 이미지가 요청한 색상/도형과 실제로 일치하는가 (사람이 육안 확인)
- 정량 보조 지표: 별도로 학습한 간단한 분류기로 생성 이미지의 색상/도형을 예측 → 조건과 일치율(%) 측정
