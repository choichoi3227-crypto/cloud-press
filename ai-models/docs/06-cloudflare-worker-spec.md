# Cloudflare Worker 스펙 (api-gateway)

## 1. 역할 (다시 한번 명확히)

이 Worker는 **모델 추론을 절대 수행하지 않습니다.** 오직 다음만 담당합니다.

- 인증 (API 키 검증)
- Rate limiting / 쿼터 관리
- 요청 유효성 검사 (1차 필터)
- 캐싱
- 추론 서버로 요청 프록시
- 사용량 로깅

## 2. 기술 스택

- 프레임워크: [Hono](https://hono.dev/) (경량, Workers에 최적화된 TypeScript 웹 프레임워크)
- 언어: TypeScript
- 저장소: Cloudflare D1 (사용자/API키/사용량 로그), Cloudflare KV (rate limit 카운터, 응답 캐시)

## 3. 디렉토리 구조

```
workers/api-gateway/
├── wrangler.toml
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Hono 앱 진입점, 라우트 등록
    ├── middleware/
    │   ├── auth.ts           # API 키 검증
    │   └── rateLimit.ts      # KV 기반 rate limit
    ├── routes/
    │   ├── text.ts           # /v1/text/generate
    │   ├── image.ts          # /v1/image/generate
    │   └── health.ts         # /v1/health
    ├── lib/
    │   ├── cache.ts          # 캐시 키 생성 및 조회/저장
    │   └── inferenceClient.ts # 추론 서버 호출 래퍼
    └── db/
        └── schema.sql        # D1 스키마
```

## 4. D1 스키마 (초안)

```sql
-- schema.sql
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    owner_email TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);
```

## 5. Rate Limit 미들웨어 (개요)

```typescript
// middleware/rateLimit.ts
import { Context, Next } from "hono";

export async function rateLimit(c: Context, next: Next) {
  const apiKeyId = c.get("apiKeyId");
  const plan = c.get("plan"); // 'free' | 'pro' 등
  const limits: Record<string, number> = { free: 20, pro: 500 }; // 분당 요청 수
  const windowKey = `rl:${apiKeyId}:${Math.floor(Date.now() / 60000)}`;

  const current = parseInt((await c.env.RATE_LIMIT_KV.get(windowKey)) ?? "0", 10);
  if (current >= limits[plan]) {
    return c.json({ error: "rate_limit_exceeded" }, 429);
  }
  await c.env.RATE_LIMIT_KV.put(windowKey, String(current + 1), { expirationTtl: 60 });
  await next();
}
```

## 6. 추론 서버 호출 래퍼

```typescript
// lib/inferenceClient.ts
export async function callInferenceServer(
  env: Env,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`${env.INFERENCE_SERVER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": env.INTERNAL_API_KEY,
    },
    body: JSON.stringify(body),
  });
}
```

## 7. 캐싱 전략

```typescript
// lib/cache.ts
export async function getCacheKey(endpoint: string, body: unknown): Promise<string> {
  const data = new TextEncoder().encode(endpoint + JSON.stringify(body));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "cache:" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

동일한 prompt/조건으로 재요청이 오면 KV에서 즉시 반환하여 추론 서버 부하를 줄입니다. 텍스트 생성은 `temperature > 0`일 때 매번 다른 결과가 기대되므로, 캐싱은 주로 `temperature: 0` 또는 이미지 조건부 생성(단계 1, 결정적이지 않지만 자주 반복되는 조합)에 유효합니다.

## 8. wrangler.toml (초안)

```toml
name = "cloud-press-api-gateway"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "cloud-press-db"
database_id = "<실제-배포-시-생성되는-id>"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<실제-배포-시-생성되는-id>"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "<실제-배포-시-생성되는-id>"

[vars]
INFERENCE_SERVER_URL = "https://inference.yourdomain.com"

# secrets (wrangler secret put 으로 별도 설정, 파일에 직접 쓰지 않음)
# INTERNAL_API_KEY
```

## 9. CORS

프런트엔드(`frontend/src/`)가 Worker와 다른 origin에서 호출하므로, `hono/cors` 미들웨어를 `/v1/*` 전체에 적용합니다. 이 미들웨어는 인증(`requireApiKey`)보다 먼저 등록되어야 합니다 — 그래야 브라우저가 실제 요청 전에 보내는 `OPTIONS` preflight 요청이 인증 없이도 통과되어 204를 받을 수 있습니다 (미들웨어 순서를 반대로 하면 preflight가 401로 막혀 브라우저에서 모든 요청이 실패합니다 — 실제로 로컬 통합 테스트 중 이 문제를 발견하고 수정했습니다).

```typescript
// index.ts
app.use(
  "/v1/*",
  cors({
    origin: "*", // 프로덕션에서 특정 도메인만 허용하려면 배열로 교체 가능
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })
);

// CORS 다음에 인증 미들웨어 등록
app.use("/v1/text/*", requireApiKey, rateLimit);
app.use("/v1/image/*", requireApiKey, rateLimit);
```

## 10. 라우트 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/v1/text/generate` | Flash Texter 호출 (인증+ratelimit+캐시 후 프록시) |
| POST | `/v1/image/generate` | Nano-Tech Artist 호출 |
| GET | `/v1/health` | Worker 자체 상태 + 추론 서버 health 프록시 |
| POST | `/internal/keys` | (WordPress 서버 전용, X-Admin-Secret 인증) 사용자 가입 시 API 키 발급 |
| POST | `/internal/keys/revoke` | (WordPress 서버 전용) 사용자 탈퇴 시 API 키 폐기 |
| GET | `/internal/github-proxy/repo-info/:owner/:repo` | (WordPress 배포 플러그인 전용, X-Deploy-Proxy-Key 인증 + 화이트리스트) 저장소 정보 조회 |
| GET | `/internal/github-proxy/latest-commit/:owner/:repo/:branch` | (WordPress 배포 플러그인 전용) 최신 커밋 조회, 브랜치도 화이트리스트 적용 |

`/internal/*` 경로는 브라우저가 아니라 WordPress 서버가 server-to-server로 호출하는 용도이며, `/v1/*`의 사용자 API 키 인증과는 완전히 다른 시크릿(`ADMIN_SECRET`, `DEPLOY_PROXY_KEY`)으로 보호됩니다. 상세는 `docs/11-wordpress-theme-plugin-spec.md`, `docs/12-github-deploy-plugin-spec.md` 참조.
