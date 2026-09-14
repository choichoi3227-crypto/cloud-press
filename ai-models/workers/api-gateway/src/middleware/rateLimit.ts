import { Context, Next } from "hono";
import { HonoBindings } from "../env";

// 분당 요청 허용치 (plan별)
const LIMITS: Record<string, number> = { free: 20, pro: 500 };

/**
 * 분 단위 슬라이딩 윈도우 대신, 구현 단순화를 위해
 * "현재 분(minute epoch)"을 키에 포함한 고정 윈도우 방식을 사용한다.
 * 트래픽이 커지면 슬라이딩 윈도우 또는 토큰 버킷으로 교체 검토.
 */
export async function rateLimit(c: Context<HonoBindings>, next: Next) {
  const apiKeyId = c.get("apiKeyId");
  const plan = c.get("plan") ?? "free";
  const limit = LIMITS[plan] ?? LIMITS.free;

  const minuteEpoch = Math.floor(Date.now() / 60000);
  const windowKey = `rl:${apiKeyId}:${minuteEpoch}`;

  const currentRaw = await c.env.RATE_LIMIT_KV.get(windowKey);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= limit) {
    return c.json({ error: "rate_limit_exceeded", limit, plan }, 429);
  }

  await c.env.RATE_LIMIT_KV.put(windowKey, String(current + 1), {
    expirationTtl: 60,
  });

  await next();
}
