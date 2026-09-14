# 로드맵

## 마일스톤 0 — 인프라 뼈대 ✅ 완료

- [x] 문서 세트 작성
- [x] `workers/api-gateway` 초기 코드 (Hono, 인증/rate limit/프록시 뼈대)
- [x] `inference-server` 초기 코드 (FastAPI, 헬스체크 + 더미 응답)
- [x] Worker ↔ 추론 서버 연결 테스트 — `wrangler dev --local`로 Worker를 실제 기동하고, TypeScript 타입체크(`tsc --noEmit`) 통과 확인. Worker→D1 인증→KV rate limit→추론 서버 프록시까지 curl로 전체 체인 실제 검증 (401/200/429 응답 모두 정상), `docs/07-deployment-guide.md` 5.1절 참조

## 마일스톤 1 — Flash Texter 단계 1 + Nano-Tech Artist 단계 1 ✅ 핵심 파이프라인 완료

- [x] `generate_dataset.py`로 도형 합성 데이터셋 생성 — 라벨 100% 정확, 육안 확인 완료
- [x] cGAN 학습 (로컬 CPU로 파이프라인 검증, 실제 품질을 위한 충분한 epoch은 Colab GPU에서 진행 필요) → 학습 루프/체크포인트 저장·재개/추론 정상 작동 확인
- [x] 대화 데이터 준비 (템플릿 조합 280쌍, 7개 의도)
- [x] 의도 분류 인코더 학습 (실제 신경망, gradient descent로 수렴 확인) → 신규 표현에 대해 약 70% 정확한 일반화 확인 (10개 테스트 문장 중 7개 정답)
- [x] 두 모델을 추론 서버에 연결, 실제 학습된 가중치로 end-to-end 요청 성공 — 추론 서버 직접 호출뿐 아니라 **Cloudflare Worker를 경유한 전체 체인**(인증→rate limit→캐시→프록시→실제 모델)까지 curl로 검증 완료
- [x] 두 모델을 동시에 로드할 때 발생한 모듈 이름 충돌 버그 발견 및 수정 (`_model_loader_utils.py`, `05-inference-server-spec.md` 참조)
- [ ] Colab에서 실제 학습 규모(GAN 50~100+ epoch, 대화 데이터셋 확장)로 재학습 — 로컬 검증은 CPU 제약으로 소규모(3~30 epoch)만 실행함
- [ ] 정성 평가: 팀/본인 기준 "그럴듯함" 체크 (Colab 재학습 이후 진행)

**현재 상태**: 데이터 생성 → 학습 → 체크포인트 저장/재개 → 추론 서버 로딩 → API 응답까지 전체 파이프라인이 실제로 작동하는 것을 로컬에서 검증했습니다. 다만 로컬 환경은 GPU가 없어 학습 epoch 수를 적게(cGAN 3epoch, 의도 분류기 30epoch) 돌렸기 때문에, cGAN이 생성하는 이미지는 아직 도형 형태가 나오지 않는 노이즈 수준입니다. Colab GPU에서 동일 코드로 epoch 수를 늘리면 실제 서비스 가능한 품질에 도달할 것으로 예상됩니다.

**완료 기준**: 실제 배포된 API로 "빨간 원 그려줘" 요청 시 이미지가 반환되고, "안녕"이라고 하면 그럴듯한 인사 응답이 오는 것.

## 마일스톤 2 — 품질 확장

- [x] 정적 데모 프런트엔드 구축 (`frontend/src/`) — 두 모델을 브라우저에서 직접 테스트 가능, Worker와의 CORS 연동을 실제 브라우저 요청 조건(Origin 헤더, preflight)으로 검증 완료
- [x] GPU 없이 운영하는 전략 문서화 (`docs/09-running-without-gpu.md`) — 단계 1~2는 이미 CPU만으로 학습·추론이 검증되었으므로, 완전 무비용 배포 구성(Colab 학습 → HF Hub 저장 → Fly.io/Railway 무료 티어 추론 → Cloudflare 무료 티어) 정리
- [ ] Flash Texter: 소형 Transformer로 요약 태스크 추가
- [ ] Nano-Tech Artist: 해상도 128x128로 확장, 도형 조합 복잡도 증가
- [ ] 캐싱/rate limit 실사용 트래픽 기준으로 튜닝
- [ ] 유상 GPU(RunPod 등) 전환 시점 판단 — Colab 무료 자원으로 한계 도달 시

## 마일스톤 3 — WordPress 통합

- [x] 아키텍처 재설계: WordPress(콘텐츠/인증) + Worker(API, 100% 기존 유지) 역할 분담 확정 (`docs/10-wordpress-architecture.md`)
- [x] `cloud-press-connector` 플러그인: 회원가입/로그인(WordPress 기본 기능 활용), 사용자별 Worker API 키 자동 발급, 마이페이지 콘솔(서버사이드 프록시 방식), 자동 업데이트 노트 생성, SEO 메타 처리 — 전체 PHP 파일 문법 검증 통과
- [x] `cloud-press-deploy` 플러그인: GitHub 저장소 화이트리스트, 관리자 최소 2인 다중 승인, 원자적 배포(symlink swap)+롤백, 정적 검사(위험 패턴/실행파일 탐지) — 핵심 로직 33개 항목 유닛 테스트로 실제 검증 완료 (셀프 승인 금지, 중복 승인 방지, 승인 미달 시 미배포, 명령어 주입 브랜치명 차단, 실패한 배포 시도 후 서비스 안전 유지 등)
- [x] Worker에 `/internal/keys`(사용자 API 키 발급/폐기), `/internal/github-proxy/*`(화이트리스트+브랜치 제한 이중 방어) 엔드포인트 추가, 로컬에서 인증/화이트리스트 실제 동작 검증
- [x] 장애 대응 설계 문서화 (`docs/13-resilience-and-failover.md`) — 비용을 늘리지 않는 선에서 "서비스 완전 불가"를 막는 우선순위 정리
- [x] 배포 지원 도구 작성 및 검증: `scripts/wp-config-check.php`(wp-config.php 필수 상수 6종 검증, 3가지 케이스로 실제 테스트 — 정상/누락+형식오류/시크릿 중복 경고), `scripts/setup-worker-secrets.sh`(Worker 시크릿 4종 일괄 설정, mock wrangler로 자동생성·직접입력·비대화형 환경 안전 종료까지 검증)
- [ ] 실제 WordPress 환경(결제된 호스팅)에 테마/플러그인 설치 및 통합 테스트
- [ ] wp-config.php 상수 설정 (`CP_WORKER_PUBLIC_URL`, `CP_WORKER_ADMIN_SECRET` 등) — `scripts/wp-config-check.php`로 검증
- [ ] 실제 GitHub 토큰 발급 후 배포 파이프라인 종단 테스트

## 마일스톤 3.5 — 검색 증강 생성 (RAG)

- [x] 저장소 재구성: 기존 검색/조사 API(`POST /api/research`, 저장소 루트)와 이 프로젝트(`ai-models/`)를 하나의 저장소에서 함께 관리하도록 통합
- [x] 설계 문서화 (`docs/14-search-augmented-generation.md`) — Flash Texter가 Workers AI를 직접 쓰게 되는 것이 아니라, 외부 HTTP API 하나를 호출하는 것뿐임을 명확히 함
- [x] `inference-server/models/search_augment.py`: 검색 Worker 호출 모듈. 5초 타임아웃, 모든 실패 케이스(연결 불가/타임아웃/4xx/5xx)에서 예외 없이 빈 컨텍스트 반환 — 실제 연결 실패 상황으로 검증 완료
- [x] `training/flash-texter/inference.py`: 의도 분류 실패(OOV 과다 또는 낮은 확신도) 시에만 검색 결과를 보조적으로 인용하도록 반영. **정상적으로 의도가 분류되는 요청에는 검색 결과가 절대 끼어들지 않음을 실제 테스트로 확인** (인사 응답에 검색 결과가 섞이지 않는 것을 assert로 검증)
- [x] `inference-server/routers/text.py`: 모든 `/v1/text/generate` 요청마다 검색 컨텍스트를 먼저 가져오도록 연결 (async 전환)
- [x] 가짜 검색 Worker(FastAPI)로 엔드투엔드 검증: 검색 Worker 정상 동작 시 실제 검색 결과 인용, 검색 Worker OFF(`SEARCH_WORKER_URL` 미설정) 시 기존 fallback으로 완전히 동일하게 동작하는 것을 curl로 재현
- [ ] 실제 검색 Worker(저장소 루트, `research-handler.js`)와의 프로덕션 연동 테스트 (현재는 가짜 서버로만 검증됨)
- [ ] `AIBP_SHARED_SECRET` 실제 값 설정 및 `SEARCH_WORKER_SECRET`과 일치 확인

## 마일스톤 3.6 — 사전학습 베이스 모델 파인튜닝 (Flash/Nano Banana 방향성, 현실적 재정의)

방향 전환 배경: "Flash/Nano Banana 수준" 목표를 "학습은 무료 GPU, 실제 서비스 추론은 GPU 없이(CPU)"라는 제약과 함께 실행 가능하게 재정의했습니다. From-scratch 사전학습은 이 제약 안에서 물리적으로 불가능하므로, 검증된 오픈소스 사전학습 가중치를 베이스로 삼아 직접 작성한 데이터로 파인튜닝하는 경로로 전환했습니다. 상세 근거는 `docs/15-stage2-pretrained-finetuning.md` 참조.

- [x] 베이스 모델 실제 조사 및 확정: 텍스트 Qwen3.5-0.8B(Apache 2.0, 200개 이상 언어, thinking/non-thinking 모드), 이미지 Sana-0.6B(Apache 2.0, Flux-12B급 품질을 20배 작은 크기로, NVIDIA/MIT 공동 개발) — 처음 제안했던 Llama 3.2 1B, BK-SDM보다 실제 벤치마크 근거로 상향. **재조사로 중요 정정**: Qwen3.5-0.8B는 순수 텍스트 모델이 아니라 비전-언어 멀티모달 모델임을 확인 (`docs/15` 2.1절)
- [x] `generate_finetune_data.py`: 10개 카테고리, 슬롯 기반 조합 데이터 생성기. 템플릿 조합의 중복 문제를 실제로 발견(반복 샘플링 시 74% 중복)하고, 전량 고유 조합만 생성하도록 수정 — 현재 913개 확보, "수천 쌍" 목표에는 미달(구체적 확장 경로는 문서 3.1절)
- [x] `prepare_sana_captions.py`: 도형 이미지를 Sana 표준 imagefolder(이미지+캡션) 형식으로 변환, HuggingFace `datasets`의 `imagefolder` 로더로 실제 로드 검증(60장)
- [x] `run_sana_lora_finetune.py`: 학습 루프를 재구현하지 않고 diffusers 공식 `train_dreambooth_lora_sana.py`를 우리 데이터로 호출하는 래퍼로 설계 — `--dataset_name`+`--caption_column=text`로 다중 캡션 파인튜닝이 가능함을 공식 이슈로 확인
- [x] `train_lora.py`: **재검토에서 실제 문제 2건 발견 및 수정.** (1) transformers 최소 버전이 문서에 잘못 기재되어 있었음 — 재조사로 Qwen3.5는 `>=5.2.0` 필요함을 확인하고 버전 검증 함수 추가, 낮은 버전 실패 케이스까지 시뮬레이션 검증. (2) **비전 인코더 오염 문제** — Qwen3.5-0.8B가 멀티모달이라는 사실을 놓치면 `LoraConfig(target_modules=["q_proj",...])`가 이름만으로 매칭되어 비전 인코더의 동명 레이어에도 LoRA가 잘못 적용될 수 있음을 로컬 더미 멀티모달 모델로 실제 재현. `peft`의 `exclude_modules`로 막으려 했으나 처음 시도(`["vision_encoder.*"]`, 리스트+와일드카드)가 peft 소스상 리터럴 매칭만 지원해 작동하지 않는 것도 실제로 확인 — 정규식 문자열 하나로 넘겨야 한다는 정확한 사용법을 검증 후 반영, 최종적으로 텍스트 백본만 LoRA 적용되고 비전은 완전 제외됨을 엔드투엔드 검증
- [x] `train_colab_lora.ipynb`, `train_colab_sana_lora.ipynb`: 클론(diffusers 소스 설치 포함)→데이터 생성→파인튜닝→정성 평가→**CPU 추론 속도 실측**(dtype 무시 버그 우회 로직 포함)→HF Hub 업로드 전체 흐름
- [x] 추론 서버 스트리밍(SSE) 지원 + Worker 프록시 — `flash_texter.py`의 `generate_response_stream()`, `text.ts`의 `stream:true` 프록시 경로. Worker를 실제로 기동해 인증/스트림 전달/하위 호환을 curl로 엔드투엔드 검증 완료 (상세는 마일스톤 3.7)
- [ ] **Colab에서 실제 파인튜닝 실행** — 로컬 개발 환경은 `huggingface.co`가 네트워크 화이트리스트에 없어 실제 가중치 다운로드가 불가능했음. 파이프라인 구조(데이터 로딩, LoRA 부착, Trainer 루프, **비전/텍스트 분리 로직**)는 더미 모델로 철저히 검증했으나 실제 Qwen3.5/Sana 가중치로는 미검증. **이게 다음 세션의 최우선 작업.**
- [ ] Sana CPU 추론 속도 실측 (공식 자료는 GPU 기준만 존재, CPU 수치는 우리가 직접 측정해야 함)
- [ ] Qwen3.5-0.8B의 text-only 추출 체크포인트가 커뮤니티에 존재하는지 확인 — 있으면 그쪽을 베이스로 쓰는 것이 비전 인코더를 아예 안 지고 가는 더 깨끗한 방법

## 마일스톤 3.7 — 목표 재정의, 벤치마크 인프라, 대규모 데이터 확장

방향 전환 배경: "Gemini 3.5 Flash/Pro, Nano Banana 2~2 Pro 수준"이라는 목표가 제시되었으나, 0.8B/0.6B 베이스 모델로는 물리적으로 도달 불가능함을 설명하고 논의 끝에 "현재 베이스를 극한까지 파고들어 도달 가능한 최고 품질(공식 비교는 하지 않음)"로 재정의했습니다. "완성"을 사람이 판단할 구체적 프로세스(벤치마크 1차 필터링 + 사람 정성 평가 + 반복 루프)로 정의하고, 이 대화에서는 코드만 만들 수 있고 실제 GPU 실행은 Colab에서 해야 한다는 한계를 명시했습니다. 폴백 전략도 확정: 단계 1(의도분류+검색)은 폐기하지 않고 Qwen3.5 로드 실패 시 안전망으로 유지.

- [x] `docs/15` 5절 "완성의 정의" 신설 — held-out loss, IFEval, KoBEST 기준 자동 벤치마크 + `eval_prompts.jsonl` 기반 사람 정성 평가 + 반복 루프 설계
- [x] `training/flash-texter/eval_prompts.jsonl` — 15개 고정 평가 프롬프트, 6개 카테고리(일반/새표현/신규주제/멀티턴/모호함/hallucination 유도)로 분산
- [x] `training/flash-texter/run_benchmarks.py` — held-out loss 비교, IFEval 실행(lm-evaluation-harness 공식 CLI 형식 확인 후 작성), 정성평가 응답 생성, JSON/TXT 리포트 저장. **핵심 함수 3개(`compute_holdout_loss`, `generate_qualitative_samples`, `main`)를 로컬에서 실제로 구성한 GPT2+PEFT 모델로 엔드투엔드 검증** — 이 과정에서 환경의 캐시된 GPT2 토크나이저가 손상(vocab_size=0)되어 있다는 것도 우연히 발견하고 완전히 로컬 자체 구성 토크나이저로 우회 검증
- [x] `training/flash-texter/generate_finetune_data.py` 대규모 확장 — 카테고리 10개→28개(+멀티턴 8개), `--per-category-cap` 옵션으로 거대 카테고리(explain_concept 최대 16,128 조합)가 데이터셋을 지배하지 않도록 균형 조정. 최종 4,741개 전량 고유 조합 확보(이전 913개 대비 5.2배)
- [x] **데이터 품질 버그 발견 및 수정**: 확장된 데이터를 육안 검토하다가 "복리은(는)", "이사 준비을(를)" 같은 한국어 조사 오류를 대량 발견. `training/flash-texter/korean_josa.py` 신규 작성(받침 유무를 한글 유니코드 구조로 직접 계산, 괄호 예외 처리 포함) 후 실제 버그 사례 6건 + 조사 판별 11건으로 검증, 전체 데이터셋 재생성 후 이중조사 표기 0건 확인
- [x] 추론 서버 스트리밍(SSE) — `models/flash_texter.py`에 `generate_response_stream()` 제너레이터 추가(단계 1은 완성 응답을 단어 단위로 방출하는 의사 스트리밍, 단계 2 교체 시 내부 구현만 바뀌도록 설계). 스트리밍 청크 재조립 결과가 비스트리밍 응답과 정확히 일치함을 검증. `routers/text.py`에 `stream`/`mode` 파라미터 추가, `stream=false`(기본)는 완전한 하위 호환
- [x] Worker(`text.ts`) SSE 프록시 — `stream:true`일 때 캐싱을 우회하고 추론 서버의 `ReadableStream`을 그대로 중계하는 `proxyStreamingResponse()` 추가. Worker를 실제로 기동해 엔드투엔드 검증: 미인증 401, 유효 키로 스트리밍 청크 순서대로 도착, `Content-Type: text/event-stream` 정확, 기존 비스트리밍 요청 무영향 확인
- [ ] "수만 개" 데이터 규모 목표에는 4,741개로 아직 미달 — 카테고리를 더 추가하거나 짧은 카테고리 표현을 계속 늘려야 함 (반복 작업, 다음 세션에서 계속)
- [ ] Nano-Tech Artist 쪽도 동일한 강도로 데이터/파이프라인 재검토 필요 (다음 순서)

## 마일스톤 3.8 — 검색 grounding 실제 연결, 프롬프트 인젝션 방어, 3단계 폴백

배경: "템플릿 기반이 아니라 직접 검색·생각·추론해야 진정한 AI"라는 지적을 받고, 검색 연동 자체는 이미 있었지만 "검색 결과를 실제로 읽고 이해해서 답을 재구성"하는 진짜 grounding 연결이 빠져 있었다는 걸 확인하고 채웠습니다.

- [x] `training/flash-texter/inference_stage2.py` — Qwen3.5 LoRA 실제 추론 인터페이스, 검색 결과를 프롬프트에 주입하는 `build_prompt()`
- [x] **프롬프트 인젝션 취약점 발견 및 수정**: `<|im_end|><|im_start|>system` 같은 ChatML 제어 토큰을 사용자 입력/검색 결과에 심어 가짜 시스템 메시지를 주입하는 공격을 로컬에서 실제로 재현하고, sanitize 로직으로 차단 후 재검증
- [x] `models/flash_texter.py`를 단계2(Qwen3.5)→단계1(GRU)→더미 3단계 우선순위로 재작성, 3가지 실패 시나리오 전부 실제 검증
- [x] **`_model_loader_utils.py`의 하드코딩 버그 발견**: 진입 파일명이 `"inference.py"`로 고정되어 있어 단계2의 `inference_stage2.py`를 로드하지 못하던 것을 `entry_filename` 파라미터화로 수정 (기존 호출은 하위 호환 유지)
- [ ] Colab에서 실제 Qwen3.5로 grounding이 실제로 작동하는지 검증 (프롬프트 조립/인젝션 방어 로직만 검증됐고, 진짜 신경망 추론 결과는 미확인)

## 마일스톤 4 — 장기: 완전 자체 사전학습 (예산 확보 시)

- [ ] Flash Texter: decoder-only Transformer(nanoGPT 스타일), 대규모 텍스트 코퍼스로 사전학습 착수
- [ ] Nano-Tech Artist: 텍스트 프롬프트 기반 생성으로 전환 (CLIP 인코더 + diffusion)
- [ ] 이 시점부터는 무료 GPU로 불가능 — 예산 계획 수립 필요 (RunPod/Vast.ai 시간당 비용 견적을 별도로 산정)

## 진행 원칙

1. **각 마일스톤은 이전 단계가 "실제로 작동"해야 다음으로 넘어갑니다.** 문서상으로만 완료 처리하지 않습니다.
2. **API 계약(요청/응답 스키마)은 마일스톤이 올라가도 하위 호환을 유지**합니다. 모델이 바뀌어도 Worker/프런트엔드 코드가 깨지지 않도록.
3. 마일스톤 4(모델 자유생성/diffusion 확장) 진입 시점에 GPU 비용이 발생하기 시작하므로, 이 시점에 실제 예산과 트래픽 예측을 재점검합니다.
