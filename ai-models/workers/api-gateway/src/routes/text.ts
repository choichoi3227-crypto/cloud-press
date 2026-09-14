import { Context, Hono } from "hono";
import { Env, HonoBindings } from "../env";
import { callInferenceServer } from "../lib/inferenceClient";
import { makeCacheKey } from "../lib/cache";

const text = new Hono<HonoBindings>();

text.post("/generate", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    max_tokens?: number;
    temperature?: number;
    mode?: string;
    stream?: boolean;
  }>();

  if (!body.prompt || typeof body.prompt !== "string") {
    return c.json({ error: "invalid_request", detail: "prompt is required" }, 400);
  }
  if (body.prompt.length > 2000) {
    return c.json({ error: "invalid_request", detail: "prompt too long" }, 400);
  }

  // 스트리밍 요청은 캐싱/JSON 파싱 없이 추론 서버의 SSE 응답을 그대로 통과시킨다.
  // (docs/15-stage2-pretrained-finetuning.md 4절 — Worker는 문지기 역할만 유지하고,
  // 스트림 내용 자체를 들여다보거나 가공하지 않는다. 캐싱은 스트리밍 응답에는
  // 적용하지 않는다 — 매 요청 응답이 토큰 단위로 오는 상황에서 캐시 재생은
  // "스트리밍처럼 보이지만 실제로는 저장된 것을 다시 흘려보내는" 방식이 되어야 하는데,
  // 이는 추가 복잡도 대비 이득이 크지 않아 1차 구현에서는 다루지 않는다.)
  if (body.stream) {
    return proxyStreamingResponse(c, body);
  }

  // temperature 0(결정적 생성)일 때만 캐시를 사용한다.
  const cacheable = !body.temperature || body.temperature === 0;
  const cacheKey = cacheable ? await makeCacheKey("/v1/text/generate", body) : null;

  if (cacheKey) {
    const cached = await c.env.CACHE_KV.get(cacheKey, "json");
    if (cached) {
      return c.json(cached);
    }
  }

  const result = await callInferenceServer(c.env, "/v1/text/generate", body);
  if (!result.ok) {
    return c.json(result.data ?? { error: "inference_error" }, result.status as any);
  }

  if (cacheKey) {
    await c.env.CACHE_KV.put(cacheKey, JSON.stringify(result.data), {
      expirationTtl: 3600,
    });
  }

  return c.json(result.data);
});

/**
 * 추론 서버의 SSE 스트림을 그대로 클라이언트에 중계한다.
 * fetch()가 반환하는 ReadableStream을 파싱/버퍼링 없이 그대로 넘기므로,
 * Worker는 청크 내용을 알 필요가 없다 — 단순 파이프 역할만 한다.
 */
async function proxyStreamingResponse(
  c: Context<HonoBindings>,
  body: { prompt: string; max_tokens?: number; temperature?: number; mode?: string; stream?: boolean }
) {
  const upstreamUrl = `${c.env.INFERENCE_SERVER_URL}/v1/text/generate`;
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": c.env.INTERNAL_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return c.json({ error: "inference_server_unreachable" }, 503);
  }

  if (!upstream.ok || !upstream.body) {
    return c.json({ error: "inference_error" }, (upstream.status || 502) as any);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export default text;
