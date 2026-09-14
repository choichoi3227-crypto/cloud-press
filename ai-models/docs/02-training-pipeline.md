# 학습 파이프라인 (Colab/Kaggle 기반)

## 1. 왜 학습과 서빙을 분리하는가

Google Colab/Kaggle 무료 GPU는 다음과 같은 제약이 있습니다.

- 세션 시간 제한 (Colab 무료: 대략 연속 12시간 내외, 유휴 시 조기 종료)
- 세션 종료 시 로컬 파일 시스템 초기화 (연결 끊기면 저장 안 한 것은 소실)
- 상시 가동 불가 → **API 서버로 직접 쓸 수 없음** (사용자가 요청했는데 노트북이 꺼져 있으면 응답 불가)

따라서 Colab/Kaggle은 **오직 학습(training)에만** 사용하고, 학습이 끝난 가중치를 외부 저장소(R2, Hugging Face Hub)로 내보낸 뒤, 별도의 상시 추론 서버가 그 가중치를 로드해서 서빙합니다.

## 2. 필수 원칙: 체크포인트 저장/재개

세션이 언제 끊겨도 학습을 이어갈 수 있어야 합니다.

```python
# 학습 루프 의사코드
import os
CHECKPOINT_DIR = "/content/drive/MyDrive/cloud-press/checkpoints"  # Google Drive 마운트 필수
os.makedirs(CHECKPOINT_DIR, exist_ok=True)

start_epoch = 0
ckpt_path = f"{CHECKPOINT_DIR}/latest.pt"
if os.path.exists(ckpt_path):
    checkpoint = torch.load(ckpt_path, map_location=device)
    model.load_state_dict(checkpoint["model_state"])
    optimizer.load_state_dict(checkpoint["optimizer_state"])
    start_epoch = checkpoint["epoch"] + 1
    print(f"체크포인트에서 재개: epoch {start_epoch}")

for epoch in range(start_epoch, TOTAL_EPOCHS):
    train_one_epoch(...)
    torch.save({
        "epoch": epoch,
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
    }, ckpt_path)
    # N 에폭마다 별도 버전으로도 백업
    if epoch % 5 == 0:
        torch.save(model.state_dict(), f"{CHECKPOINT_DIR}/epoch_{epoch}.pt")
```

**반드시 Google Drive를 마운트**해서 체크포인트를 저장하세요. Colab 로컬 디스크에만 저장하면 세션 종료 시 사라집니다.

```python
from google.colab import drive
drive.mount('/content/drive')
```

## 3. 학습 완료 후 배포 절차

1. 최종 체크포인트를 로컬(Drive)에서 다운로드
2. Hugging Face Hub에 모델 저장소 생성 후 업로드 (권장 — 버전 관리와 다운로드가 쉬움)
   ```python
   from huggingface_hub import HfApi
   api = HfApi()
   api.upload_file(
       path_or_fileobj="epoch_20.pt",
       path_in_repo="flash-texter-v0.1.0.pt",
       repo_id="<your-username>/flash-texter",
       repo_type="model",
   )
   ```
3. 추론 서버의 환경변수(`MODEL_VERSION`, `HF_REPO_ID`)를 갱신하고 재시작 → 서버가 새 가중치를 자동 다운로드

## 4. Kaggle Notebooks 사용 시 참고

- Kaggle은 세션당 GPU 사용 시간 쿼터(주 단위)가 있으므로, Colab과 번갈아 쓰는 것을 권장합니다.
- Kaggle Datasets 기능을 체크포인트 저장소로 활용 가능 (비공개 데이터셋으로 업로드 → 다음 세션에서 입력으로 마운트)

## 5. 데이터셋 준비 원칙

- **Flash Texter (단계 1, 챗봇)**: 공개 대화 데이터셋(예: 오픈소스 한국어 대화 코퍼스) + 직접 작성한 소규모 seed 데이터. 저작권이 명확한 데이터만 사용.
- **Nano-Tech Artist (단계 1, 도형)**: 실제 이미지 데이터셋이 필요 없습니다. 코드로 직접 도형(원/사각형/삼각형 등)을 다양한 색상·크기·위치로 그려 **합성 데이터셋을 프로그래밍적으로 생성**합니다. 이러면 데이터 수급 문제가 없고, 라벨(정답 조건)도 자동으로 정확하게 붙습니다.

`training/nano-tech-artist/generate_dataset.py`에 합성 데이터 생성 스크립트를 포함합니다 (문서 `04-nano-tech-artist-spec.md` 참조).

## 6. 학습 환경 재현성

각 학습 노트북 상단에 다음을 고정합니다.

```python
SEED = 42
import random, numpy as np, torch
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
torch.cuda.manual_seed_all(SEED)
```

라이브러리 버전은 `training/*/requirements.txt`에 고정 버전으로 명시합니다.
