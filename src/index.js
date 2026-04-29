// src/index.js — CloudPress v20.0 메인 라우터
// 바인딩:
//   env.DB       → D1  (users, sites, domain_aliases 등 플랫폼 영속 데이터)
//   env.SESSIONS → KV  (플랫폼 로그인 세션)
//   env.CACHE    → KV  (페이지/옵션/미디어 캐시, rate-limit, ddos-ban)
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

// ── 바인딩 존재 확인 ───────────────────────────────────────────────────────────
function checkBindings(env) {
  const missing = [];
  if (!env.DB)       missing.push("DB (D1)");
  if (!env.SESSIONS) missing.push("SESSIONS (KV)");
  if (!env.CACHE)    missing.push("CACHE (KV)");
  return missing;
}

// ── 비밀번호 해시 (SHA-256) ────────────────────────────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────────
async function generateJWT(payload, secret) {
  const header  = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body    = btoa(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400, // 24h
  }));
  const data = `${header}.${body}`;
  const key  = await crypto.subtle.importKey(
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
    const [header, body, sig] = token.split(".");
    const data = `${header}.${body}`;
    const key  = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── 세션 헬퍼 (SESSIONS KV) ───────────────────────────────────────────────────
// 키: session:{token} → JSON { userId, email, role, createdAt }
// TTL: 24h (86400초)
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

// ── Rate Limit 헬퍼 (CACHE KV) ────────────────────────────────────────────────
// 키: rl:{ip}:{windowMinute} → 요청 횟수
async function rateLimit(cache, ip, maxPerMinute = 30) {
  const window = Math.floor(Date.now() / 60000);
  const key    = `rl:${ip}:${window}`;
  const count  = parseInt(await cache.get(key) || "0") + 1;
  await cache.put(key, String(count), { expirationTtl: 120 });
  return count > maxPerMinute;
}

// ── DDoS 밴 체크 (CACHE KV) ───────────────────────────────────────────────────
async function isDdosBanned(cache, ip) {
  return !!(await cache.get(`ddos_ban:${ip}`));
}

// ── 인증 미들웨어 ──────────────────────────────────────────────────────────────
async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  // JWT 우선 검증
  const secret = env.JWT_SECRET || "cp_dev_secret";
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
async function dbCreateUser(db, { id, email, passwordHash, role }) {
  await db.prepare(
    "INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, email, passwordHash, role, new Date().toISOString()).run();
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
      return new Response(null, { headers: CORS_HEADERS });
    }

    // API 요청에 한해 바인딩/DDoS/Rate-limit 체크
    if (url.pathname.startsWith("/api/")) {
      // 바인딩 누락 체크
      const missing = checkBindings(env);
      if (missing.length > 0) {
        return jsonErr(`서버 바인딩 누락: ${missing.join(", ")} — wrangler.toml을 확인하세요.`, 503);
      }
      // DDoS 밴
      if (await isDdosBanned(env.CACHE, ip)) {
        return jsonErr("접근이 차단되었습니다.", 403);
      }
      // Rate limit (인증 API는 더 엄격하게 10/min)
      const isAuthRoute = ["/api/signup", "/api/login"].includes(url.pathname);
      const limited = await rateLimit(env.CACHE, ip, isAuthRoute ? 10 : 60);
      if (limited) return jsonErr("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", 429);
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

        // 중복 체크 (D1)
        const existing = await dbGetUserByEmail(env.DB, email);
        if (existing) return jsonErr("이미 사용 중인 이메일입니다.", 409);

        // 저장 (D1)
        await dbCreateUser(env.DB, {
          id:           crypto.randomUUID(),
          email:        email.toLowerCase().trim(),
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

        // D1에서 유저 조회
        const user = await dbGetUserByEmail(env.DB, email);
        if (!user) return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

        // 비밀번호 검증
        const hash = await hashPassword(password);
        if (hash !== user.password_hash)
          return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

        // JWT 발급
        const secret = env.JWT_SECRET || "cp_dev_secret";
        const token  = await generateJWT(
          { id: user.id, email: user.email, role: user.role },
          secret
        );

        // SESSIONS KV에도 저장 (선택적 서버 사이드 세션)
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

    // ── GET /api/health ─────────────────────────────────────────────────────
    // 바인딩 상태 한눈에 확인
    if (url.pathname === "/api/health" && method === "GET") {
      return jsonOk({
        status:   "ok",
        bindings: {
          DB:       !!env.DB,
          SESSIONS: !!env.SESSIONS,
          CACHE:    !!env.CACHE,
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
