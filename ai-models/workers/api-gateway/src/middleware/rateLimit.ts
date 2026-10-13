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

  // 무료 플랜 KV는 쓰기 하루 1,000회 제한이 있다. 한도를 넘으면 put이 예외를 던지는데,
  // 그 때문에 모든 요청이 500이 되면 안 되므로 KV 오류 시에는 제한을 건너뛴다(fail-open).
  // (유료 플랜이거나 트래픽이 크면 D1/Durable Objects 기반 카운터로 교체하는 것을 권장 — docs/13 참고)
  try {
    const currentRaw = await c.env.RATE_LIMIT_KV.get(windowKey);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;

    if (current >= limit) {
      return c.json({ error: "rate_limit_exceeded", limit, plan }, 429);
    }

    await c.env.RATE_LIMIT_KV.put(windowKey, String(current + 1), {
      expirationTtl: 60,
    });
  } catch (err) {
    console.warn("rate limit KV unavailable (free-plan write limit?) — skipping rate limit:", String(err));
  }

  await next();
}
