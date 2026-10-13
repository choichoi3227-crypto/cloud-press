/**
 * Cloud Press 추론 서버 — Cloudflare Worker 버전 (무료 플랜 안전 모드).
 *
 * FastAPI 추론 서버(inference-server/)와 같은 API 계약을 제공한다:
 *   GET  /v1/health            — 상태 (인증 없음)
 *   POST /v1/image/generate    — X-Internal-Key 필요
 *       prompt_type=condition : 색·도형 → 사전 생성 뱅크(CPU≈0). 뱅크가 비면 (유료) 실시간 cGAN
 *       prompt_type=text      : 자유 문장 → Workers AI(FLUX.1 schnell) 실제 AI 이미지 생성
 *   POST /v1/text/generate     — Workers AI LLM (stream 지원). 바인딩이 없으면 501
 *
 * Workers AI는 Cloudflare가 호스팅하는 모델(직접 학습한 모델이 아님)이며, 무료 플랜은 하루 10,000 Neurons.
 * 한도를 넘으면 429(Retry-After)로 응답한다.
 */
import { Hono } from "hono";
import { bankPick, BANK_KEY } from "../../api-gateway/src/lib/edgeBank";
import { edgeGenerate } from "../../api-gateway/src/lib/edgeGenerator";
import { AiUnavailableError, generateImage, generateText, streamText, imageModel, textModel, AiEnv } from "./ai";

interface Env extends AiEnv {
  CACHE_KV: KVNamespace;
  INTERNAL_API_KEY: string;
  EDGE_LIVE?: string;
  EDGE_BACKEND?: string;
  /** "0"이면 Workers AI를 쓰지 않는다 (기본: AI 바인딩이 있으면 사용). */
  ENABLE_AI?: string;
}

const aiEnabled = (env: Env) => !!env.AI && env.ENABLE_AI !== "0";

/** Workers AI 오류 → HTTP 응답. 한도 초과는 UTC 자정 초기화이므로 429 + Retry-After. */
function aiErrorResponse(c: any, err: unknown) {
  const e = err instanceof AiUnavailableError ? err : new AiUnavailableError("other", String(err));
  console.error("workers-ai error:", e.kind, e.message);
  if (e.kind === "quota") {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    c.header("Retry-After", String(Math.max(60, Math.ceil((next - now.getTime()) / 1000))));
    return c.json({ detail: "Workers AI daily free quota exhausted; retry after 00:00 UTC" }, 429);
  }
  if (e.kind === "model") {
    return c.json({ detail: "configured Workers AI model is unavailable; update IMAGE_MODEL/TEXT_MODEL" }, 503);
  }
  return c.json({ detail: "workers ai error" }, 502);
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
      flash_texter: { version: VERSION, ready: aiEnabled(c.env) },
      nano_tech_artist: { version: VERSION, ready: bankReady },
    },
    workers_ai: aiEnabled(c.env)
      ? { enabled: true, image_model: imageModel(c.env), text_model: textModel(c.env) }
      : { enabled: false },
  });
});

app.post("/v1/image/generate", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || (body.prompt_type !== "condition" && body.prompt_type !== "text")) {
    return c.json({ detail: "prompt_type must be 'condition' or 'text'" }, 422);
  }
  if (body.prompt_type === "text") {
    if (!aiEnabled(c.env)) {
      return c.json({ detail: "text-to-image needs the Workers AI binding (wrangler.toml [ai])" }, 501);
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return c.json({ detail: "prompt is required" }, 422);
    try {
      return c.json(await generateImage(c.env, prompt));
    } catch (err) {
      return aiErrorResponse(c, err);
    }
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

app.post("/v1/text/generate", async (c) => {
  if (!aiEnabled(c.env)) {
    return c.json(
      {
        detail:
          "text generation needs the Workers AI binding (wrangler.toml [ai]); " +
          "flash-texter itself cannot run on Workers. Run inference-server (FastAPI) on a container/VM for it.",
      },
      501
    );
  }
  const body = await c.req.json().catch(() => null);
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  if (!prompt || prompt.length > 2000) {
    return c.json({ detail: "prompt is required (max 2000 chars)" }, 422);
  }
  const max_tokens = Math.min(1024, Math.max(1, Number.isFinite(body.max_tokens) ? Math.floor(body.max_tokens) : 128));
  const temperature = Math.min(2, Math.max(0, Number.isFinite(body.temperature) ? body.temperature : 0.8));
  const params = { prompt, max_tokens, temperature };

  try {
    if (body.stream === true) {
      const stream = await streamText(c.env, params);
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }
    return c.json(await generateText(c.env, params));
  } catch (err) {
    return aiErrorResponse(c, err);
  }
});

app.notFound((c) => c.json({ detail: "not found" }, 404));

export default app;
