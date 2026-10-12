export type Plan = "free" | "pro";

export interface Env {
  DB: D1Database;
  RATE_LIMIT_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  INFERENCE_SERVER_URL: string;
  // 선택: inference-edge Worker(Cloudflare 위 추론 서버)에 대한 서비스 바인딩. 바인딩이 있으면
  // INFERENCE_SERVER_URL 대신 이 바인딩으로 호출한다 (wrangler.toml의 [[services]] 참고).
  INFERENCE_EDGE?: Fetcher;
  INTERNAL_API_KEY: string;
  // WordPress(cloud-press-connector)가 사용자 가입 시 API 키를 발급받기 위해 호출하는
  // POST /v1/keys 관리자 엔드포인트를 보호하는 시크릿. 텍스트/이미지 생성용 API 키
  // 인증(D1 api_keys 조회)과는 완전히 별개의 인증 체계다.
  ADMIN_SECRET: string;
  // WordPress(cloud-press-deploy)가 GitHub 저장소 정보를 조회할 때 경유하는
  // /internal/github-proxy/* 를 보호하는 시크릿. 마찬가지로 별개의 인증 체계.
  DEPLOY_PROXY_KEY: string;
  GITHUB_TOKEN: string;
  // GitHub 배포 프록시가 조회를 허용할 owner/repo 화이트리스트 (쉼표 구분 문자열).
  // 실제 배포 승인 자체는 WordPress cloud-press-deploy 플러그인의 다중 승인 로직이
  // 담당하며, 이 화이트리스트는 그 앞단의 2차 방어선이다 (docs/12 5절 참조).
  DEPLOY_REPO_WHITELIST: string;
  // 엣지 폴백 연산 백엔드: "vgpu"(vgpu ISA 커널) | 그 외 "native"(직접 루프). 기본 native.
  EDGE_BACKEND?: string;
  // "1"이면 뱅크가 비었을 때 Worker에서 cGAN을 실시간 생성(약 0.2초 CPU → 유료 플랜 전용, 무료 플랜 금지).
  EDGE_LIVE?: string;
}

export interface AuthVars {
  apiKeyId: string;
  plan: Plan;
}

/** Hono 인스턴스 생성 시 공통으로 사용하는 제네릭. `new Hono<HonoBindings>()` 형태로 사용. */
export interface HonoBindings {
  Bindings: Env;
  Variables: AuthVars;
}
