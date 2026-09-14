export type Plan = "free" | "pro";

export interface Env {
  DB: D1Database;
  RATE_LIMIT_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  INFERENCE_SERVER_URL: string;
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
