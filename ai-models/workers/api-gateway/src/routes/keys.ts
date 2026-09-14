import { Hono } from "hono";
import { HonoBindings } from "../env";

const keys = new Hono<HonoBindings>();

/**
 * 관리자 전용 API 키 발급 엔드포인트.
 *
 * WordPress의 cloud-press-connector 플러그인이 사용자 가입 시점에 이 엔드포인트를
 * 호출해, 그 사용자 전용 Worker API 키를 D1에 등록한다 (docs/11 3절 참조).
 * 이 엔드포인트는 텍스트/이미지 생성 API의 사용자 인증(Authorization: Bearer)과는
 * 완전히 별개로, X-Admin-Secret 헤더로만 인증한다 — 두 인증 체계를 절대 섞지 않는다.
 */
keys.post("/", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== c.env.ADMIN_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }

  const body = await c.req.json<{
    key_hash: string;
    owner_email: string;
    plan?: "free" | "pro";
  }>();

  if (!body.key_hash || !body.owner_email) {
    return c.json({ error: "invalid_request", detail: "key_hash and owner_email are required" }, 400);
  }

  const id = crypto.randomUUID();
  const plan = body.plan ?? "free";

  try {
    await c.env.DB.prepare(
      "INSERT INTO api_keys (id, key_hash, owner_email, plan, created_at, revoked) VALUES (?, ?, ?, ?, ?, 0)"
    )
      .bind(id, body.key_hash, body.owner_email, plan, Math.floor(Date.now() / 1000))
      .run();
  } catch (err) {
    // key_hash UNIQUE 제약 위반 등 (이미 등록된 경우)
    return c.json({ error: "key_registration_failed" }, 409);
  }

  return c.json({ id, plan }, 201);
});

/**
 * 사용자 탈퇴/휴면 시 WordPress가 호출해 키를 폐기하는 엔드포인트.
 * 실제 row를 삭제하지 않고 revoked 플래그만 세워, 사용량 로그(usage_logs)와의
 * 외래키 무결성 및 감사 기록을 보존한다.
 */
keys.post("/revoke", async (c) => {
  const adminSecret = c.req.header("X-Admin-Secret");
  if (!adminSecret || adminSecret !== c.env.ADMIN_SECRET) {
    return c.json({ error: "forbidden" }, 403);
  }

  const body = await c.req.json<{ key_hash: string }>();
  if (!body.key_hash) {
    return c.json({ error: "invalid_request", detail: "key_hash is required" }, 400);
  }

  await c.env.DB.prepare("UPDATE api_keys SET revoked = 1 WHERE key_hash = ?")
    .bind(body.key_hash)
    .run();

  return c.json({ revoked: true });
});

export default keys;
