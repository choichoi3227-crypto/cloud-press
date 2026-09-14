# WordPress + Cloudflare Worker 통합 아키텍처

## 1. 방향 전환 기록 (왜 이 문서가 존재하는가)

`00-overview.md`에서는 "WordPress는 최대한 배제한다"는 전제로 시작했습니다. 이후 실제 운영 계획이 구체화되면서 다음과 같이 역할을 나누는 것으로 **확정**되었습니다.

| 계층 | 담당 | 유지/변경 |
|---|---|---|
| 모델 추론 (텍스트/이미지 생성) | Cloudflare Worker + 추론 서버 | **100% 기존 유지, 변경 없음** |
| 회원가입/로그인/마이페이지 | WordPress (기본 회원가입 기능) | 신규 |
| 일반 페이지(소개, 문서, 블로그 등) | WordPress | 신규 |
| SEO | WordPress (전용 테마/플러그인에서 처리) | 신규 |
| 관리자의 GitHub 배포 관리 | WordPress 전용 플러그인 | 신규 |
| 로그인한 사용자가 실제로 모델을 사용하는 화면(마이페이지 내 콘솔) | WordPress 플러그인이 Worker API를 호출 | 신규 (WordPress→Worker 연동) |

**API 계층(`docs/00~09`에서 다룬 모든 것)은 이 결정으로 전혀 바뀌지 않습니다.** Worker는 여전히 GPU 없는 CPU 추론 서버와 통신하는 유일한 창구이고, WordPress는 이 Worker API를 호출하는 "클라이언트"일 뿐입니다 — `frontend/src/`의 정적 데모 페이지가 Worker를 호출했던 것과 정확히 같은 방식입니다. 다만 이제 그 프런트엔드 역할을 정적 페이지 대신 WordPress가 맡습니다. (`frontend/src/`는 참고용 데모로 남겨두거나 제거해도 무방합니다 — 결정은 운영 단계에서.)

## 2. 전체 그림

```
                                사용자
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │  WordPress (PHP+MySQL,   │
                    │  자체 상시 호스팅)          │
                    │                          │
                    │  - 회원가입/로그인          │
                    │    (wp_users 테이블 그대로)│
                    │  - 마이페이지               │
                    │  - 일반 페이지 (자동 생성)   │
                    │  - SEO 메타 처리           │
                    │  - 전용 테마               │
                    │  - cloud-press-connector  │
                    │    플러그인 (Worker 호출)   │
                    │  - cloud-press-deploy     │
                    │    플러그인 (GitHub 배포)  │
                    └───────────┬──────────────┘
                                │ HTTPS (공개 API 키 또는
                                │ 사용자별 발급 키)
                                ▼
                    ┌─────────────────────────┐
                    │  Cloudflare Worker        │
                    │  (기존 api-gateway,       │
                    │   변경 없음)               │
                    └───────────┬──────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │  추론 서버 (FastAPI, CPU)  │
                    │  Flash Texter /           │
                    │  Nano-Tech Artist         │
                    └───────────────────────────┘

     [별도 흐름, 관리자 전용]
     GitHub 저장소 ──(관리자가 URL 등록)──▶ cloud-press-deploy 플러그인
                                              │
                                    스테이징 영역에 다운로드
                                              │
                                    화이트리스트 검사
                                              │
                                    관리자 N명 다중 승인 대기
                                              │
                                        (승인 완료)
                                              │
                                    실제 배포 경로에 반영
```

## 3. WordPress와 Worker의 경계선 (다시 한번 명확히)

- WordPress 서버(PHP)는 **모델 추론을 절대 직접 수행하지 않습니다.** 항상 Worker의 `/v1/text/generate`, `/v1/image/generate`를 HTTP로 호출합니다.
- WordPress는 사용자 인증(로그인 여부, 권한)을 자체적으로 처리하고, Worker에는 별도의 API 키(사용자별 또는 사이트 전체 공용)로 인증합니다. **WordPress 로그인 세션과 Worker의 API 키 인증은 서로 다른 두 개의 인증 체계**이며, `cloud-press-connector` 플러그인이 그 사이를 연결하는 역할만 합니다.
- 이렇게 분리해야 Worker/추론 서버 쪽 장애가 WordPress 로그인이나 일반 페이지 열람에 영향을 주지 않고, 반대로 WordPress 장애가 나도(이론상) API 자체는 살아있을 수 있습니다 (사용자 대면 화면은 당연히 WordPress가 죽으면 같이 죽지만, "서비스 완전 불가"까지는 아니도록 아래 6절에서 다룹니다).

## 4. 새로 추가되는 구성요소

```
wordpress/
├── cloud-press-theme/           # 전용 테마 (SEO 친화 마크업, 마이페이지 템플릿 포함)
├── cloud-press-connector/       # Worker API 연동 플러그인 (회원가입 후킹, 마이페이지 콘솔, 자동 페이지 생성)
└── cloud-press-deploy/          # 관리자용 GitHub 자동 배포 플러그인 (화이트리스트 + 다중 승인)
```

각각의 상세 설계는 다음 문서에서 다룹니다.

- `11-wordpress-theme-plugin-spec.md` — 테마 + `cloud-press-connector` 플러그인 (회원가입/로그인/마이페이지/자동 페이지/SEO)
- `12-github-deploy-plugin-spec.md` — `cloud-press-deploy` 플러그인 (화이트리스트 + 다중 승인 배포 파이프라인)
- `13-resilience-and-failover.md` — 장애 시 서비스 완전 불가 방지 설계

## 5. 확정된 운영 조건

- 호스팅: 이미 결제된 자체 PHP+MySQL 상시 서버 (WordPress 상시 구동)
- 인증: 순수 WordPress 기본 회원가입 (`wp_users`) — 소셜 로그인 없음, WordPress 계정이 곧 서비스 계정
- GitHub 자동 배포 승인: 관리자 다중 승인제 (최소 2인, `12-github-deploy-plugin-spec.md`에서 상세)
