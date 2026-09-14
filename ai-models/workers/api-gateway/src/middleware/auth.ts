import { Context, Next } from "hono";
import { HonoBindings } from "../env";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * API 키 검증 미들웨어.
 * 클라이언트는 `Authorization: Bearer <key>` 헤더로 API 키를 전달한다.
 * D1의 api_keys 테이블에서 해시로 조회하여 유효성/plan을 확인한다.
 */
export async function requireApiKey(c: Context<HonoBindings>, next: Next) {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "missing_api_key" }, 401);
  }
  const rawKey = match[1];
  const keyHash = await sha256Hex(rawKey);

  const row = await c.env.DB.prepare(
    "SELECT id, plan, revoked FROM api_keys WHERE key_hash = ?"
  )
    .bind(keyHash)
    .first<{ id: string; plan: string; revoked: number }>();

  if (!row || row.revoked) {
    return c.json({ error: "invalid_api_key" }, 401);
  }

  c.set("apiKeyId", row.id);
  c.set("plan", row.plan as "free" | "pro");
  await next();
}
