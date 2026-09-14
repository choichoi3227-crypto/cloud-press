import { Hono } from "hono";
import { cors } from "hono/cors";
import { Env, HonoBindings } from "./env";
import { requireApiKey } from "./middleware/auth";
import { rateLimit } from "./middleware/rateLimit";
import text from "./routes/text";
import image from "./routes/image";
import health from "./routes/health";
import keys from "./routes/keys";
import githubProxy from "./routes/githubProxy";

const app = new Hono<HonoBindings>();

// CORS: 브라우저 프런트엔드(frontend/)가 다른 origin에서 이 API를 호출하므로 반드시 필요하다.
// 이 미들웨어가 인증/rate-limit보다 먼저 실행되어야, 브라우저가 실제 요청 전에 보내는
// OPTIONS preflight 요청이 401로 막히지 않는다 (Hono의 cors()는 OPTIONS를 자동으로 가로채
// 다음 미들웨어로 넘기지 않고 바로 204를 반환한다).
//
// 주의: /internal/* (keys, githubProxy)는 브라우저가 아니라 WordPress 서버가
// server-to-server로 호출하는 경로이므로 이 CORS 설정 대상에 포함하지 않는다.
app.use(
  "/v1/*",
  cors({
    origin: "*", // 데모 공개 API이므로 전체 허용. 특정 도메인만 허용하려면 배열로 교체.
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  })
);

// 인증/rate-limit이 필요 없는 공개 라우트
app.route("/v1/health", health);

// 인증 + rate limit이 필요한 모델 라우트
app.use("/v1/text/*", requireApiKey, rateLimit);
app.use("/v1/image/*", requireApiKey, rateLimit);

app.route("/v1/text", text);
app.route("/v1/image", image);

// WordPress 서버 전용 내부 엔드포인트. 각 라우트 파일 내부에서 자체 시크릿으로 인증하며
// (X-Admin-Secret, X-Deploy-Proxy-Key), 사용자용 API 키 인증과는 완전히 분리되어 있다.
// docs/11-wordpress-theme-plugin-spec.md 3절, docs/12-github-deploy-plugin-spec.md 5절 참조.
app.route("/internal/keys", keys);
app.route("/internal/github-proxy", githubProxy);

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
