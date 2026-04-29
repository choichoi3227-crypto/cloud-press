// functions/_shared.js
// 모든 API 핸들러가 공유하는 유틸리티

// ── CORS / 응답 헬퍼 ────────────────────────────────────────────────────────
export const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── 비밀번호 해시 (SHA-256) ─────────────────────────────────────────────────
export async function hashPassword(password) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── URL-safe base64 패딩 헬퍼 ───────────────────────────────────────────────
function padBase64(s) {
  return s + "=".repeat((4 - s.length % 4) % 4);
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
export async function generateJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const body = btoa(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400, // 24h
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${data}.${encodedSig}`;
}

export async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(padBase64(sig.replace(/-/g, "+").replace(/_/g, "/"))),
      c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(padBase64(body.replace(/-/g, "+").replace(/_/g, "/"))));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── 인증 미들웨어 ───────────────────────────────────────────────────────────
export async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token  = authHeader.slice(7);
  const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
  const payload = await verifyJWT(token, secret);
  if (payload) return payload;
  // JWT 실패 → SESSIONS KV fallback
  if (env.SESSIONS) {
    const raw = await env.SESSIONS.get(`session:${token}`);
    if (raw) { try { return JSON.parse(raw); } catch {} }
  }
  return null;
}

// ── SESSIONS KV ─────────────────────────────────────────────────────────────
export async function sessionCreate(sessions, userId, email, role) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await sessions.put(
    `session:${token}`,
    JSON.stringify({ userId, email, role, createdAt: Date.now() }),
    { expirationTtl: 86400 }
  );
  return token;
}

export async function sessionDelete(sessions, token) {
  await sessions.delete(`session:${token}`);
}

// ── D1 유저 CRUD ────────────────────────────────────────────────────────────
export async function dbGetUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase().trim()).first();
}

export async function dbGetUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}

export async function dbCreateUser(db, { id, email, passwordHash, role = "user" }) {
  await db.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, email.toLowerCase().trim(), passwordHash, role, new Date().toISOString()).run();
}

export async function dbUpdateUserCfKey(db, userId, cfApiKey) {
  await db.prepare("UPDATE users SET cf_global_api_key = ? WHERE id = ?")
    .bind(cfApiKey, userId).run();
}

// ── 바인딩 체크 (DB, SESSIONS 필수 / CACHE 선택) ────────────────────────────
// required 기본값에서 CACHE 제거 — CACHE 없어도 signup/login 동작해야 함
export function checkBindings(env, required = ["DB", "SESSIONS"]) {
  return required.filter(b => !env[b]);
}
