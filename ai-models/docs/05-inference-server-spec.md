# 추론 서버 스펙 (FastAPI)

## 1. 역할

Cloudflare Worker로부터 내부 요청을 받아 실제 모델 추론(텍스트 생성, 이미지 생성)을 수행하고 결과를 반환하는 서버. **Cloudflare Workers 바깥**에서 별도로 호스팅됩니다 (GPU/CPU 텐서 연산이 필요하므로).

## 2. 디렉토리 구조

```
inference-server/
├── requirements.txt
├── main.py                  # FastAPI 앱 진입점
├── config.py                # 환경변수 로드 (모델 버전, 내부 인증키 등)
├── auth.py                  # Worker↔추론서버 내부 인증 미들웨어
├── models/
│   ├── flash_texter.py      # training/flash-texter/inference.py 래핑
│   └── nano_tech_artist.py  # training/nano-tech-artist/inference.py 래핑
├── routers/
│   ├── text.py              # /v1/text/* 엔드포인트
│   ├── image.py             # /v1/image/* 엔드포인트
│   └── health.py            # /v1/health
└── Dockerfile
```

## 3. 엔드포인트 정의

### `POST /v1/text/generate`
- Body: `{ prompt, max_tokens?, temperature? }`
- Response: `{ model, text, usage }`
- 내부적으로 `models/flash_texter.py`의 `generate_response()` 호출

### `POST /v1/image/generate`
- Body: `{ prompt_type: "condition", color, shape }`
- Response: `{ model, image_base64, format }`
- 내부적으로 `models/nano_tech_artist.py`의 `generate_image()` 호출

### `GET /v1/health`
- Response: `{ status: "ok", loaded_models: { flash_texter: "v0.1.0", nano_tech_artist: "v0.1.0" }, device: "cpu" | "cuda" }`
- Cloudflare Worker가 이 엔드포인트로 추론 서버 가동 여부를 주기적으로 확인 (헬스체크)

## 4. Worker ↔ 추론 서버 내부 인증

추론 서버는 공개 인터넷에 노출되더라도 **Worker를 거치지 않은 직접 요청은 거부**해야 합니다.

```python
# auth.py
from fastapi import Request, HTTPException
import os

INTERNAL_KEY = os.environ["INTERNAL_API_KEY"]  # Worker와 공유하는 비밀키

async def verify_internal_request(request: Request):
    key = request.headers.get("X-Internal-Key")
    if key != INTERNAL_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")
```

이 키는 Cloudflare Worker의 secret(`wrangler secret put INTERNAL_API_KEY`)과 추론 서버의 환경변수에 동일하게 설정합니다. 절대 프런트엔드나 공개 저장소에 노출하지 않습니다.

## 5. 모델 로딩 전략

**중요한 함정 (실제로 겪은 버그)**: `training/flash-texter/`와 `training/nano-tech-artist/`는 둘 다 `model.py`, `dataset.py`, `inference.py`처럼 동일한 파일명을 사용합니다. 각 폴더 안의 `inference.py`는 내부적으로 평범한 절대 import(`from model import ...`)를 쓰기 때문에, 두 폴더를 단순히 `sys.path`에 같이 넣고 `import inference`를 하면 **Python의 `sys.modules` 캐시가 충돌**해서 한쪽 모델이 다른 쪽의 `model.py`를 잘못 가져오는 문제가 발생합니다 (먼저 로드된 모델의 클래스가 나중 모델에도 쓰여서 `ImportError` 또는 조용한 오동작 발생).

해결책은 `inference-server/_model_loader_utils.py`의 `load_inference_module()`입니다. 각 모델의 로컬 모듈(`model`, `dataset`, `tokenizer`)을 고유 네임스페이스(`flash_texter_impl.model` 등)로 미리 로드한 뒤, `inference.py`를 실행하는 그 순간만 `sys.modules["model"]`을 해당 네임스페이스의 것으로 임시로 바꿔치기하고, 로드가 끝나면 즉시 원상복구합니다. `inference-server/models/flash_texter.py`와 `nano_tech_artist.py`는 이 유틸리티를 통해서만 학습 코드를 import해야 하며, 직접 `from model import ...` 같은 코드를 추가하지 않습니다.

```python
# models/flash_texter.py, models/nano_tech_artist.py 공통 패턴
from _model_loader_utils import load_inference_module

inference_module = load_inference_module(
    training_dir="../../training/flash-texter",
    namespace="flash_texter_impl",
    local_module_names=["model", "tokenizer", "dataset"],
)
inference_module.load_model(weights_path)
```

두 모델을 어떤 순서로 로드해도(먼저/나중에 상관없이) 서로 영향을 주지 않는다는 것을 로컬에서 검증했습니다.

### 실제 가중치 로딩

```python
# models/flash_texter.py (개요)
import os
from _model_loader_utils import load_inference_module

MODEL_VERSION = os.environ.get("FLASH_TEXTER_VERSION", "v0.1.0")
_inference_module = None

def load():
    global _inference_module
    weights_path = os.environ.get("LOCAL_FLASH_TEXTER_PATH") or hf_hub_download(...)
    _inference_module = load_inference_module(TRAINING_DIR, "flash_texter_impl", ["model", "tokenizer", "dataset"])
    _inference_module.load_model(weights_path)
```

- 서버 시작 시(`@app.on_event("startup")`) 두 모델을 미리 로드해 첫 요청 지연을 없앱니다.
- GPU가 있으면 자동 사용, 없으면 CPU 폴백 (`torch.cuda.is_available()` 체크).
- 로컬 개발/HF Hub 업로드 전 테스트 시에는 `LOCAL_FLASH_TEXTER_PATH`, `LOCAL_NANO_TECH_ARTIST_PATH` 환경변수로 로컬 체크포인트 파일을 직접 가리킬 수 있습니다 (`HF_REPO_*`보다 우선 적용).

### 5.1 검색 증강 생성(RAG) 환경변수

Flash Texter의 검색 연동(`docs/14-search-augmented-generation.md`)을 위한 환경변수입니다.

| 변수 | 설명 | 기본값 |
|---|---|---|
| `SEARCH_WORKER_URL` | 저장소 루트 검색/조사 API의 배포 URL. 비어 있으면 검색 연동 비활성화 | (빈 문자열) |
| `SEARCH_WORKER_SECRET` | `research-handler.js`의 `AIBP_SHARED_SECRET`과 동일한 값 (설정한 경우에만) | (빈 문자열) |
| `SEARCH_WORKER_TIMEOUT_SECONDS` | 검색 Worker 호출 타임아웃 | `5.0` |
| `SEARCH_WORKER_MAX_RESULTS` | 가져올 검색 결과 최대 개수 | `5` |

## 6. 배포 옵션 비교 (GPU 없이 시작 → 점진적 확장)

| 단계 | 호스팅 | 비용 | 비고 |
|---|---|---|---|
| 초기 (단계 1 모델, CPU 추론으로 충분) | Fly.io / Railway 무료~저가 티어 | 무료~월 몇 달러 | 소형 모델이라 CPU 추론도 수백ms~1-2초대 |
| 확장 (단계 2~3, GPU 필요) | RunPod / Vast.ai (시간당 과금 GPU) | 사용한 만큼 | 상시 가동 대신 요청 시 spin-up하는 서버리스 GPU 옵션도 검토 |
| 장기 | 자체 GPU 서버 또는 예약형 클라우드 GPU | 고정비 | 트래픽이 늘어난 이후 고려 |

## 7. requirements.txt (초안)

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
torch==2.4.1
pillow==10.4.0
huggingface_hub==0.25.1
python-multipart==0.0.9
pydantic==2.9.2
```

(버전은 실제 배포 시점에 최신 안정 버전으로 재확인)
