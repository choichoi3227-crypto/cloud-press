# Cloud Press

직접 학습한 두 개의 AI 모델(**Flash Texter** — 텍스트 생성, **Nano-Tech Artist** — 이미지 생성)을 API로 제공하는 서비스입니다.

- Cloudflare Workers는 API 게이트웨이(인증/rate limit/캐싱)만 담당하고, 실제 모델 추론은 Workers 바깥의 별도 서버(FastAPI)에서 수행합니다. (Workers는 GPU를 지원하지 않으므로 모델 연산 자체는 불가능합니다.)
- Cloudflare Workers AI는 사용하지 않습니다.
- WordPress는 사용하지 않습니다.
- 모델은 상용 API를 호출하는 것이 아니라 **직접 학습**하며, 처음엔 작은 규모(챗봇, 도형 생성)로 시작해 단계적으로 발전시킵니다.

## 문서

전체 아키텍처, 학습 파이프라인, 모델 스펙, 배포 절차는 [`docs/`](./docs/00-overview.md)를 참조하세요.

- [00. 전체 개요](./docs/00-overview.md)
- [01. 상세 아키텍처](./docs/01-architecture-detail.md)
- [02. 학습 파이프라인 (Colab/Kaggle)](./docs/02-training-pipeline.md)
- [03. Flash Texter 스펙](./docs/03-flash-texter-spec.md)
- [04. Nano-Tech Artist 스펙](./docs/04-nano-tech-artist-spec.md)
- [05. 추론 서버 스펙](./docs/05-inference-server-spec.md)
- [06. Cloudflare Worker 스펙](./docs/06-cloudflare-worker-spec.md)
- [07. 배포 가이드](./docs/07-deployment-guide.md)
- [08. 로드맵](./docs/08-roadmap.md)
- [09. GPU 없이 운영하기](./docs/09-running-without-gpu.md)
- [10. WordPress + Worker 통합 아키텍처](./docs/10-wordpress-architecture.md)
- [11. WordPress 테마 & 커넥터 플러그인 스펙](./docs/11-wordpress-theme-plugin-spec.md)
- [12. GitHub 자동 배포 플러그인 스펙](./docs/12-github-deploy-plugin-spec.md)
- [13. 장애 대응 및 이중화 설계](./docs/13-resilience-and-failover.md)

## 저장소 구조

```
cloud-press/
├── docs/                       # 설계 문서
├── frontend/src/                # 정적 데모 페이지 (참고용)
├── wordpress/
│   ├── cloud-press-theme/       # 서비스 전용 테마
│   ├── cloud-press-connector/   # 회원가입/로그인/마이페이지/Worker 연동 플러그인
│   └── cloud-press-deploy/      # GitHub 자동 배포(화이트리스트+다중승인) 플러그인
├── workers/api-gateway/         # Cloudflare Worker (Hono) — 100% API 담당
├── inference-server/            # FastAPI 추론 서버
├── training/
│   ├── flash-texter/            # 텍스트 모델 학습 코드
│   └── nano-tech-artist/        # 이미지 모델 학습 코드
└── scripts/
    ├── wp-config-check.php      # wp-config.php 필수 상수 검증
    └── setup-worker-secrets.sh  # Worker 시크릿 일괄 설정
```

## 역할 분담 요약

- **회원가입/로그인/마이페이지/일반 페이지/SEO**: WordPress (`wordpress/`)
- **모델 추론 API**: 100% Cloudflare Worker + 추론 서버 (`workers/`, `inference-server/`) — WordPress 도입과 무관하게 그대로 유지
- **GitHub 코드 자동 배포**: 화이트리스트 검사 + 관리자 최소 2인 다중 승인 후에만 반영 (`wordpress/cloud-press-deploy/`)

## 현재 상태

마일스톤 0 (인프라 뼈대) 진행 중 — [로드맵 참조](./docs/08-roadmap.md)
