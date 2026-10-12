/**
 * Cloud Press 추론 서버 — Cloudflare Worker 버전 (무료 플랜 안전 모드).
 *
 * FastAPI 추론 서버(inference-server/)와 같은 API 계약을 제공한다:
 *   GET  /v1/health            — 상태 (인증 없음)
 *   POST /v1/image/generate    — 색·도형 조건 이미지 (X-Internal-Key 필요)
 *   POST /v1/text/generate     — 501 (Flash Texter는 Workers에서 실행 불가, README 참고)
 *
 * 이미지는 사전 생성 뱅크(edgeBank)에서 한 장을 골라 반환하므로 CPU가 거의 들지 않는다.
 * EDGE_LIVE=1(유료 플랜)이면 뱅크가 비었을 때 cGAN을 Worker에서 직접 생성한다.
 */
import { Hono } from "hono";
import { bankPick, BANK_KEY } from "../../api-gateway/src/lib/edgeBank";
import { edgeGenerate } from "../../api-gateway/src/lib/edgeGenerator";

interface Env {
  CACHE_KV: KVNamespace;
  INTERNAL_API_KEY: string;
  EDGE_LIVE?: string;
  EDGE_BACKEND?: string;
}

const VALID_COLORS = new Set(["red", "blue", "green", "yellow", "purple", "black"]);
const VALID_SHAPES = new Set(["circle", "square", "triangle"]);
const VERSION = "edge-0.1.0";

const app = new Hono<{ Bindings: Env }>();

/** 길이와 무관하게 항상 전체를 비교하는 상수 시간 문자열 비교. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// 인증: health를 제외한 모든 /v1/* 는 X-Internal-Key 필요 (FastAPI의 verify_internal_request와 동일 동작)
app.use("/v1/image/*", requireKey);
app.use("/v1/text/*", requireKey);

async function requireKey(c: any, next: () => Promise<void>) {
  const secret: string | undefined = c.env.INTERNAL_API_KEY;
  const key = c.req.header("X-Internal-Key") ?? "";
  if (!secret || !safeEqual(key, secret)) {
    return c.json({ detail: "forbidden" }, 403);
  }
  await next();
}

app.get("/v1/health", async (c) => {
  const bankReady = (await c.env.CACHE_KV.get(BANK_KEY("red", "circle"), { cacheTtl: 60 })) !== null;
  return c.json({
    status: "ok",
    device: "cloudflare-worker",
    mode: c.env.EDGE_LIVE === "1" ? "bank+live" : "bank",
    loaded_models: {
      flash_texter: { version: VERSION, ready: false },
      nano_tech_artist: { version: VERSION, ready: bankReady },
    },
  });
});

app.post("/v1/image/generate", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || (body.prompt_type !== "condition" && body.prompt_type !== "text")) {
    return c.json({ detail: "prompt_type must be 'condition' or 'text'" }, 422);
  }
  if (body.prompt_type === "text") {
    return c.json({ detail: "text-to-image not yet implemented (roadmap milestone 3)" }, 501);
  }
  if (!VALID_COLORS.has(body.color) || !VALID_SHAPES.has(body.shape)) {
    return c.json({ detail: "invalid color or shape" }, 400);
  }

  let out = await bankPick(c.env, body.color, body.shape);
  if (!out && c.env.EDGE_LIVE === "1") {
    try {
      out = await edgeGenerate(c.env, body.color, body.shape);
    } catch (err) {
      console.error("live generation failed", err);
    }
  }
  if (!out) {
    return c.json({ detail: "edge image bank not loaded (kv bulk put 필요)" }, 503);
  }
  return c.json(out);
});

app.post("/v1/text/generate", (c) =>
  c.json(
    {
      detail:
        "flash-texter cannot run on Cloudflare Workers (model too large for 128MB / CPU limits). " +
        "Run inference-server (FastAPI) on a container/VM and point api-gateway to it for text.",
    },
    501
  )
);

app.notFound((c) => c.json({ detail: "not found" }, 404));

export default app;
