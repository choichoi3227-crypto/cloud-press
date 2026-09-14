# Cloud Press — 전체 개요

> 저장소: https://github.com/choichoi3227-crypto/cloud-press (이 프로젝트는 저장소 내 `ai-models/` 디렉토리에 위치합니다. 저장소 루트에는 별개의 검색/이미지 API 프로젝트가 함께 있습니다 — 저장소 최상위 `README.md` 참조)

## 1. 프로젝트 목표

Cloud Press는 두 개의 **직접 학습한** AI 모델을 API 형태로 제공하는 서비스입니다.

| 모델 | 코드네임 | 최종 목표(장기) | 현재 시작점 |
|---|---|---|---|
| 텍스트 생성 모델 | **Flash Texter** | Gemini 3.5 Flash 방향성의 자유 텍스트 생성 | 규칙 기반 + 소형 seq2seq 챗봇 |
| 이미지 생성 모델 | **Nano-Tech Artist** | Nano Banana 2 방향성의 이미지 생성 | 조건부 도형/패턴 생성 (소형 GAN) |

**중요한 전제 (반드시 읽을 것):**

- 이 프로젝트는 **"작게 시작해서 단계적으로 발전시키는" 로드맵**입니다. 1단계 결과물은 Gemini/Nano Banana와 품질이 비교되지 않습니다. 그건 정상입니다.
- 두 모델은 **직접 학습(from scratch 또는 소규모 사전학습)** 합니다. 외부 상용 AI API(OpenAI, Anthropic, Google, Stability 등)를 내부 엔진으로 쓰지 않습니다.
- **Cloudflare Workers AI는 사용하지 않습니다.** Workers AI뿐 아니라 Workers 런타임 자체가 GPU를 지원하지 않으므로, 모델의 학습과 추론은 전부 Workers 바깥에서 이루어집니다.
- **모델 추론 API는 100% Cloudflare Worker + 별도 추론 서버로 처리합니다.** 이 부분은 WordPress 도입 이후에도 전혀 바뀌지 않습니다.
- **사용자 대면 웹사이트(회원가입/로그인/마이페이지/일반 페이지/SEO)는 WordPress로 운영합니다.** 초기에는 "WordPress 없이"로 검토했으나, 이미 PHP+MySQL 호스팅이 결제되어 상시 구동 중이라는 조건이 확정되면서, 콘텐츠/인증 계층은 WordPress가 담당하고 무거운 연산(모델 추론)은 여전히 GPU 없는 Worker/추론 서버가 담당하는 것으로 역할을 분담했습니다. 상세 설계는 `10-wordpress-architecture.md`부터 시작하는 문서군을 참조하세요.

## 2. 왜 이 구조인가 (설계 근거)

원래 요청하신 다이어그램은 다음과 같았습니다.

```
사용자 → 웹/REST API → FastAPI 서버 → (텍스트 이해 / 이미지 입력) → 모델 → GPU → 결과 → 사용자
```

이 흐름 자체는 정확합니다. 다만 중요한 제약이 하나 있습니다.

> **Cloudflare Workers는 V8 isolate 기반 엣지 런타임이라 GPU 연산을 실행할 수 없고, 신경망 학습/대형 모델 추론도 돌릴 수 없습니다.**

따라서 시스템은 물리적으로 두 개의 층으로 나뉠 수밖에 없습니다.

1. **Cloudflare 층** — GPU가 필요 없는 모든 것 (API 게이트웨이, 인증, rate limit, 캐싱, 정적 파일 서빙, 요청 라우팅, 로깅)
2. **GPU 필요 층** — 실제 모델 학습과 추론 (초기: Google Colab/Kaggle 무료 GPU, 이후: 유상 GPU 서버로 이전)

이 문서 세트는 이 두 층을 어떻게 나누고 연결하는지, 그리고 1단계 모델을 실제로 어떻게 학습시키는지를 다룹니다.

## 3. 최종 아키텍처

```
                              사용자
                                │
                    (브라우저 / REST API 클라이언트)
                                │
                                ▼
                ┌───────────────────────────────┐
                │   Cloudflare 층 (상시 가동)     │
                │                                │
                │  ① Pages/Workers 정적 프런트엔드 │
                │  ② api-gateway Worker (Hono)   │
                │     - 인증(API Key/JWT)         │
                │     - Rate Limiting (KV)        │
                │     - 요청 검증 & 라우팅          │
                │     - 응답 캐싱 (Cache API/KV)   │
                │     - 사용량 로깅 (D1)           │
                └───────────────┬────────────────┘
                                │  HTTPS (내부 API 키로 인증된 요청)
                                ▼
                ┌───────────────────────────────┐
                │   추론 서버 (GPU 층, 별도 호스팅)  │
                │                                │
                │  FastAPI                       │
                │   ├─ /v1/text/generate  →Flash Texter│
                │   └─ /v1/image/generate →Nano-Tech Artist│
                │                                │
                │  모델 가중치 로드 (PyTorch)        │
                │  GPU: 학습 초기엔 없음 → CPU 추론   │
                │        또는 저가 GPU 인스턴스로 전환 │
                └───────────────┬────────────────┘
                                │
                                ▼
                          결과 텍스트 / 이미지
                                │
                                ▼
                     Cloudflare 층을 거쳐 사용자에게 반환
```

### 학습 파이프라인 (서빙과 분리된 별도 흐름)

```
데이터셋 준비 → Colab/Kaggle 노트북에서 학습 → 체크포인트를 R2/HF Hub에 저장
     → 추론 서버가 체크포인트를 로드 → API로 서빙
```

학습은 상시 서비스가 아니라 **주기적 배치 작업**입니다. Colab/Kaggle은 세션이 끊기므로, 학습 코드는 반드시 체크포인트 저장/재개가 가능해야 합니다. (`02-training-pipeline.md` 참조)

## 4. Cloudflare Workers vs 추론 서버 — 역할 분담표

| 역할 | 담당 | 이유 |
|---|---|---|
| 정적 프런트엔드(HTML/CSS/JS) 서빙 | Cloudflare Pages | 무료, 전세계 엣지 배포 |
| 사용자 인증/API 키 발급 | Workers + D1 | 가볍고 GPU 불필요 |
| Rate limiting / 쿼터 관리 | Workers + KV | 엣지에서 즉시 차단 가능, 추론 서버 부하 방지 |
| 요청 유효성 검사 (입력 길이, 금칙어 등 1차 필터) | Workers | 추론 서버까지 가기 전에 걸러서 GPU 자원 절약 |
| 응답 캐싱 (동일 프롬프트 재요청) | Workers Cache API / KV | GPU 서버가 없거나 느릴 때 특히 중요 |
| 사용량/로그 집계 | Workers + D1 | 과금·모니터링 기반 |
| **실제 모델 추론 (텍스트/이미지 생성)** | **추론 서버 (FastAPI, Workers 바깥)** | GPU/CPU 텐서 연산은 Workers에서 불가능 |
| **모델 학습** | **Colab/Kaggle 노트북 (Workers/추론서버와 완전 분리)** | 장시간 GPU 점유가 필요, 상시 서버와 다른 라이프사이클 |
| 모델 가중치 저장 | Cloudflare R2 (또는 Hugging Face Hub) | Workers가 직접 서빙하진 않지만, 저장소로만 활용 |

**핵심 원칙: Workers는 "문지기"이고, 추론 서버가 "일꾼"입니다.** 이 둘을 절대 하나로 합치지 않습니다 (합치는 것이 애초에 기술적으로 불가능하기도 합니다).

## 5. 저장소 구조

```
cloud-press/
├── docs/                        # 이 문서들
│   ├── 00-overview.md
│   ├── 01-architecture-detail.md
│   ├── 02-training-pipeline.md
│   ├── 03-flash-texter-spec.md
│   ├── 04-nano-tech-artist-spec.md
│   ├── 05-inference-server-spec.md
│   ├── 06-cloudflare-worker-spec.md
│   ├── 07-deployment-guide.md
│   ├── 08-roadmap.md
│   ├── 09-running-without-gpu.md
│   ├── 10-wordpress-architecture.md
│   ├── 11-wordpress-theme-plugin-spec.md
│   ├── 12-github-deploy-plugin-spec.md
│   └── 13-resilience-and-failover.md
├── frontend/
│   └── src/                     # 정적 데모 페이지 (참고용, 실 서비스 UI는 WordPress가 담당)
├── wordpress/
│   ├── cloud-press-theme/       # 전용 테마
│   ├── cloud-press-connector/   # 회원가입/로그인/마이페이지/Worker 연동 플러그인
│   └── cloud-press-deploy/      # GitHub 자동 배포(화이트리스트+다중승인) 플러그인
├── workers/
│   └── api-gateway/             # Cloudflare Worker (Hono + TypeScript) — 100% 기존 유지
├── training/
│   ├── flash-texter/            # 텍스트 모델 학습 노트북 & 스크립트
│   └── nano-tech-artist/        # 이미지 모델 학습 노트북 & 스크립트
├── inference-server/             # FastAPI 추론 서버
└── scripts/                     # 배포/유틸 스크립트
```

## 6. 단계별 로드맵 요약 (상세는 `08-roadmap.md`)

**Flash Texter**
1. 단계 1: 규칙 기반 의도 분류 + 소형 seq2seq 챗봇
2. 단계 2: 소형 Transformer 기반 요약/변환 태스크
3. 단계 3: 파라미터 확장, 자유 텍스트 생성 (GPT류 아키텍처)

**Nano-Tech Artist**
1. 단계 1: 조건부 도형/패턴 생성 (소형 GAN, 예: "빨간 원" → 이미지)
2. 단계 2: 해상도/색상/복잡도 확장
3. 단계 3: 텍스트 프롬프트 기반 이미지 생성으로 확장

## 7. 읽는 순서

1. `01-architecture-detail.md` — 컴포넌트별 상세 아키텍처, 데이터 흐름
2. `02-training-pipeline.md` — Colab/Kaggle 학습 환경, 체크포인트 전략
3. `03-flash-texter-spec.md`, `04-nano-tech-artist-spec.md` — 모델별 상세 스펙
4. `05-inference-server-spec.md` — FastAPI 서버 설계
5. `06-cloudflare-worker-spec.md` — Worker 설계
6. `07-deployment-guide.md` — 실제 배포 절차
7. `08-roadmap.md` — 단계별 마일스톤
8. `09-running-without-gpu.md` — GPU 서버 비용 없이 운영하는 방법 (단계 1~2는 완전 무료 구성 가능)
9. `10-wordpress-architecture.md` — WordPress와 Worker의 역할 분담 (신규)
10. `11-wordpress-theme-plugin-spec.md` — 테마 + 회원가입/마이페이지 플러그인 (신규)
11. `12-github-deploy-plugin-spec.md` — GitHub 자동 배포 플러그인, 화이트리스트+다중승인 (신규)
12. `13-resilience-and-failover.md` — 장애 시 서비스 완전 불가 방지 설계 (신규)

프런트엔드(`frontend/src/`)는 두 모델을 브라우저에서 직접 테스트할 수 있는 정적 데모 페이지로, 참고용으로 남겨둡니다. 실제 서비스의 회원가입/로그인/마이페이지 UI는 WordPress(`wordpress/`)가 담당합니다.
