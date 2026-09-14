import os

# Worker가 이 서버를 호출할 때 함께 보내는 내부 인증 헤더 값.
# Worker 쪽 wrangler secret과 반드시 동일해야 한다.
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "dev-only-change-me")

FLASH_TEXTER_VERSION = os.environ.get("FLASH_TEXTER_VERSION", "v0.1.0")
NANO_TECH_ARTIST_VERSION = os.environ.get("NANO_TECH_ARTIST_VERSION", "v0.1.0")

HF_REPO_FLASH_TEXTER = os.environ.get("HF_REPO_FLASH_TEXTER", "")
HF_REPO_NANO_TECH_ARTIST = os.environ.get("HF_REPO_NANO_TECH_ARTIST", "")

# HF Hub 업로드 전 로컬에서 검증할 때 사용하는 직접 경로.
# 설정되어 있으면 HF_REPO_* 보다 우선한다.
LOCAL_FLASH_TEXTER_PATH = os.environ.get("LOCAL_FLASH_TEXTER_PATH", "")
LOCAL_NANO_TECH_ARTIST_PATH = os.environ.get("LOCAL_NANO_TECH_ARTIST_PATH", "")

# 로컬 개발/모델 미학습 상태에서도 서버가 뜨도록, 가중치가 없으면
# 더미(echo/placeholder) 응답으로 폴백한다. (마일스톤 0 배관 검증용)
ALLOW_DUMMY_FALLBACK = os.environ.get("ALLOW_DUMMY_FALLBACK", "true").lower() == "true"

# 검색 증강 생성(RAG, docs/14-search-augmented-generation.md 참조).
# 저장소 루트의 검색/조사 API(research-handler.js, POST /api/research)를 호출한다.
# 비어 있으면 검색 연동이 자동으로 비활성화되고 기존처럼 검색 없이 동작한다.
SEARCH_WORKER_URL = os.environ.get("SEARCH_WORKER_URL", "")
SEARCH_WORKER_SECRET = os.environ.get("SEARCH_WORKER_SECRET", "")
SEARCH_WORKER_TIMEOUT_SECONDS = float(os.environ.get("SEARCH_WORKER_TIMEOUT_SECONDS", "5.0"))
SEARCH_WORKER_MAX_RESULTS = int(os.environ.get("SEARCH_WORKER_MAX_RESULTS", "5"))
