import { Hono } from "hono";
import { HonoBindings } from "../env";
import { callInferenceServer } from "../lib/inferenceClient";
import { makeCacheKey } from "../lib/cache";
import { edgeGenerate } from "../lib/edgeGenerator";
import { bankPick } from "../lib/edgeBank";

const image = new Hono<HonoBindings>();

const VALID_COLORS = ["red", "blue", "green", "yellow", "purple", "black"];
const VALID_SHAPES = ["circle", "square", "triangle"];

image.post("/generate", async (c) => {
  const body = await c.req.json<{
    prompt_type: "condition" | "text";
    color?: string;
    shape?: string;
    prompt?: string;
  }>();

  if (body.prompt_type === "condition") {
    if (!body.color || !VALID_COLORS.includes(body.color)) {
      return c.json({ error: "invalid_request", detail: "invalid color" }, 400);
    }
    if (!body.shape || !VALID_SHAPES.includes(body.shape)) {
      return c.json({ error: "invalid_request", detail: "invalid shape" }, 400);
    }
  } else if (body.prompt_type === "text") {
    // 단계 3(텍스트 프롬프트 기반)용 예약 분기. 현재 추론 서버는 미지원일 수 있음.
    if (!body.prompt) {
      return c.json({ error: "invalid_request", detail: "prompt is required" }, 400);
    }
  } else {
    return c.json({ error: "invalid_request", detail: "invalid prompt_type" }, 400);
  }

  const cacheKey = await makeCacheKey("/v1/image/generate", body);
  const cached = await c.env.CACHE_KV.get(cacheKey, "json");
  if (cached) {
    return c.json(cached);
  }

  const result = await callInferenceServer(c.env, "/v1/image/generate", body);
  if (!result.ok) {
    // 추론 서버 불가(연결 실패/5xx)일 때만 엣지 폴백. 4xx(잘못된 요청)·501(미구현)은 그대로 반환.
    if (body.prompt_type === "condition" && (result.status === 503 || result.status >= 500) && result.status !== 501) {
      try {
        // 1순위: 사전 생성 뱅크(무료 플랜 안전). 2순위: 실시간 생성(유료 플랜에서만, EDGE_LIVE=1).
        let edge = await bankPick(c.env, body.color!, body.shape!);
        if (!edge && c.env.EDGE_LIVE === "1") edge = await edgeGenerate(c.env, body.color!, body.shape!);
        if (edge) {
          // 폴백 결과는 캐시하지 않는다 (서버 복구 후 정식 모델 결과로 돌아가도록).
          c.header("X-Served-By", "edge-fallback");
          return c.json(edge);
        }
      } catch (err) {
        console.error("edge fallback failed", err);
      }
    }
    return c.json(result.data ?? { error: "inference_error" }, result.status as any);
  }

  await c.env.CACHE_KV.put(cacheKey, JSON.stringify(result.data), {
    expirationTtl: 3600,
  });

  return c.json(result.data);
});

export default image;
