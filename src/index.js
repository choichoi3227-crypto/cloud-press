// src/index.js — CloudPress v20.1 메인 라우터
// 바인딩:
//   env.DB       → D1  (users, sites, domain_aliases 등 플랫폼 영속 데이터)
//   env.SESSIONS → KV  (플랫폼 로그인 세션)
//   env.CACHE    → KV  (페이지/옵션/미디어 캐시, rate-limit, ddos-ban) [선택적]
//   env.ASSETS   → Workers Assets (정적 HTML/CSS/JS 서빙)
// Secrets (wrangler secret put):
//   JWT_SECRET, SUPABASE_URL, SUPABASE_KEY, SUPABASE_URL2, SUPABASE_KEY2
//   PURGE_KEY, ENCRYPTION_KEY, CF_API_TOKEN

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── 응답 헬퍼 ──────────────────────────────────────────────────────────────────
function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── 필수 바인딩 체크 (DB, SESSIONS만 필수 / CACHE는 선택적) ────────────────────
function checkCoreBindings(env) {
  const missing = [];
  if (!env.DB)       missing.push("DB (D1)");
  if (!env.SESSIONS) missing.push("SESSIONS (KV)");
  return missing;
}

// ── 비밀번호 해시 (SHA-256) ────────────────────────────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────────
async function generateJWT(payload, secret) {
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

async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    // URL-safe base64 → standard base64 → binary
    const pad = s => s + "=".repeat((4 - s.length % 4) % 4);
    const sigBytes = Uint8Array.from(
      atob(pad(sig.replace(/-/g, "+").replace(/_/g, "/"))),
      c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(pad(body.replace(/-/g, "+").replace(/_/g, "/"))));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── 세션 헬퍼 (SESSIONS KV) ───────────────────────────────────────────────────
async function sessionCreate(sessions, userId, email, role) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await sessions.put(
    `session:${token}`,
    JSON.stringify({ userId, email, role, createdAt: Date.now() }),
    { expirationTtl: 86400 }
  );
  return token;
}
async function sessionGet(sessions, token) {
  const raw = await sessions.get(`session:${token}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function sessionDelete(sessions, token) {
  await sessions.delete(`session:${token}`);
}

// ── Rate Limit 헬퍼 (CACHE KV, 없으면 skip) ───────────────────────────────────
async function rateLimit(cache, ip, maxPerMinute = 60) {
  if (!cache) return false; // CACHE 바인딩 없으면 제한 없음
  const window = Math.floor(Date.now() / 60000);
  const key    = `rl:${ip}:${window}`;
  const count  = parseInt(await cache.get(key) || "0") + 1;
  await cache.put(key, String(count), { expirationTtl: 120 });
  return count > maxPerMinute;
}

// ── DDoS 밴 체크 (CACHE KV, 없으면 skip) ──────────────────────────────────────
async function isDdosBanned(cache, ip) {
  if (!cache) return false;
  return !!(await cache.get(`ddos_ban:${ip}`));
}

// ── 인증 미들웨어 ──────────────────────────────────────────────────────────────
async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
  // JWT 우선 검증
  const payload = await verifyJWT(token, secret);
  if (payload) return payload;
  // JWT 실패 시 SESSIONS KV fallback
  if (env.SESSIONS) return await sessionGet(env.SESSIONS, token);
  return null;
}

// ── D1 유저 헬퍼 ──────────────────────────────────────────────────────────────
async function dbGetUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase().trim()).first();
}
async function dbGetUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}
async function dbCreateUser(db, { id, email, passwordHash, role = "user" }) {
  await db.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, email.toLowerCase().trim(), passwordHash, role, new Date().toISOString()).run();
}

// ══════════════════════════════════════════════════════════════════════════════
// 메인 핸들러
// ══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const ip     = request.headers.get("CF-Connecting-IP") || "unknown";

    // CORS 프리플라이트
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // API 요청 전처리
    if (url.pathname.startsWith("/api/")) {
      // 필수 바인딩 누락 체크 (DB, SESSIONS)
      const missing = checkCoreBindings(env);
      if (missing.length > 0) {
        return jsonErr(`서버 바인딩 누락: ${missing.join(", ")} — wrangler.toml을 확인하세요.`, 503);
      }
      // DDoS 밴 (CACHE 있을 때만)
      if (await isDdosBanned(env.CACHE, ip)) {
        return jsonErr("접근이 차단되었습니다.", 403);
      }
      // Rate limit (인증 API 10/min, 나머지 60/min)
      const isAuthRoute = ["/api/signup", "/api/login"].includes(url.pathname);
      if (await rateLimit(env.CACHE, ip, isAuthRoute ? 10 : 60)) {
        return jsonErr("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", 429);
      }
    }

    // ── POST /api/signup ────────────────────────────────────────────────────
    if (url.pathname === "/api/signup" && method === "POST") {
      try {
        let body;
        try { body = await request.json(); }
        catch { return jsonErr("요청 형식이 올바르지 않습니다 (JSON 파싱 실패).", 400); }

        const { email, password } = body;
        if (!email || !password)
          return jsonErr("이메일과 비밀번호를 입력해주세요.", 400);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return jsonErr("올바른 이메일 형식이 아닙니다.", 400);
        if (password.length < 8)
          return jsonErr("비밀번호는 8자 이상이어야 합니다.", 400);

        const existing = await dbGetUserByEmail(env.DB, email);
        if (existing) return jsonErr("이미 사용 중인 이메일입니다.", 409);

        await dbCreateUser(env.DB, {
          id:           crypto.randomUUID(),
          email,
          passwordHash: await hashPassword(password),
          role:         "user",
        });

        return jsonOk({ success: true, message: "회원가입이 완료되었습니다." });
      } catch (e) {
        console.error("[signup]", e);
        return jsonErr("회원가입 오류: " + e.message, 500);
      }
    }

    // ── POST /api/login ─────────────────────────────────────────────────────
    if (url.pathname === "/api/login" && method === "POST") {
      try {
        let body;
        try { body = await request.json(); }
        catch { return jsonErr("요청 형식이 올바르지 않습니다 (JSON 파싱 실패).", 400); }

        const { email, password } = body;
        if (!email || !password)
          return jsonErr("이메일과 비밀번호를 입력해주세요.", 400);

        const user = await dbGetUserByEmail(env.DB, email);
        if (!user) return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

        const hash = await hashPassword(password);
        if (hash !== user.password_hash)
          return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

        const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
        const token  = await generateJWT(
          { id: user.id, email: user.email, role: user.role },
          secret
        );

        await sessionCreate(env.SESSIONS, user.id, user.email, user.role);

        return jsonOk({ success: true, token });
      } catch (e) {
        console.error("[login]", e);
        return jsonErr("로그인 오류: " + e.message, 500);
      }
    }

    // ── POST /api/logout ────────────────────────────────────────────────────
    if (url.pathname === "/api/logout" && method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ") && env.SESSIONS) {
        await sessionDelete(env.SESSIONS, authHeader.slice(7));
      }
      return jsonOk({ success: true });
    }

    // ── GET /api/me ─────────────────────────────────────────────────────────
    if (url.pathname === "/api/me" && method === "GET") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      return jsonOk({ id: payload.id, email: payload.email, role: payload.role });
    }

    // ── GET /api/account ────────────────────────────────────────────────────
    if (url.pathname === "/api/account" && method === "GET") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      try {
        const user = await dbGetUserById(env.DB, payload.id);
        if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);
        return jsonOk({
          id:       user.id,
          email:    user.email,
          role:     user.role,
          hasCfKey: !!user.cf_global_api_key,
        });
      } catch (e) {
        return jsonErr("계정 조회 오류: " + e.message, 500);
      }
    }

    // ── PUT /api/account ────────────────────────────────────────────────────
    if (url.pathname === "/api/account" && method === "PUT") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      let body;
      try { body = await request.json(); }
      catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }
      const { cf_api_key } = body;
      if (!cf_api_key) return jsonErr("저장할 값이 없습니다.", 400);
      try {
        await env.DB.prepare("UPDATE users SET cf_global_api_key = ? WHERE id = ?")
          .bind(cf_api_key, payload.id).run();
        return jsonOk({ success: true, message: "설정이 저장되었습니다." });
      } catch (e) {
        return jsonErr("저장 오류: " + e.message, 500);
      }
    }

    // ── GET /api/sites ──────────────────────────────────────────────────────
    if (url.pathname === "/api/sites" && method === "GET") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, site_name, primary_domain, php_version, status, is_throttled, created_at FROM sites WHERE user_id = ? ORDER BY rowid DESC"
        ).bind(payload.id).all();
        return jsonOk({ success: true, sites: results });
      } catch (e) {
        return jsonErr("사이트 목록 조회 오류: " + e.message, 500);
      }
    }

    // ── POST /api/sites ─────────────────────────────────────────────────────
    if (url.pathname === "/api/sites" && method === "POST") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      let body;
      try { body = await request.json(); }
      catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }
      const { site_name, primary_domain, php_version = "8.2" } = body;
      if (!site_name || !primary_domain) return jsonErr("사이트 이름과 도메인을 입력해주세요.", 400);
      try {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO sites (id, user_id, site_name, primary_domain, php_version, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(id, payload.id, site_name, primary_domain, php_version).run();
        return jsonOk({ success: true, id, message: "사이트가 생성되었습니다." });
      } catch (e) {
        return jsonErr("사이트 생성 오류: " + e.message, 500);
      }
    }

    // ── DELETE /api/sites ───────────────────────────────────────────────────
    if (url.pathname === "/api/sites" && method === "DELETE") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);
      try {
        const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?")
          .bind(id, payload.id).first();
        if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
        await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
        return jsonOk({ success: true, message: "사이트가 삭제되었습니다." });
      } catch (e) {
        return jsonErr("사이트 삭제 오류: " + e.message, 500);
      }
    }

    // ── GET /api/health ─────────────────────────────────────────────────────
    if (url.pathname === "/api/health" && method === "GET") {
      return jsonOk({
        status: "ok",
        bindings: {
          DB:       !!env.DB,
          SESSIONS: !!env.SESSIONS,
          CACHE:    !!env.CACHE,   // 선택적
          ASSETS:   !!env.ASSETS,
        },
        supabase: {
          primary:   !!env.SUPABASE_URL,
          secondary: !!env.SUPABASE_URL2,
        },
        ts: new Date().toISOString(),
      });
    }

    // ── 정적 파일 서빙 (Workers Assets) ────────────────────────────────────
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("찾을 수 없습니다.", { status: 404 });
  },
};
