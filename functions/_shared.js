// functions/_shared.js
// 모든 API 핸들러가 공유하는 유틸리티

// ── 입력값 검증 & SQL Injection 방어 ─────────────────────────────────────────
// DB 쿼리는 반드시 prepared statement(?)로만 실행 — 문자열 직접 삽입 금지
// 아래 함수들로 입력값을 미리 정제·검증하여 이중 방어

/** 이메일 형식 검증 (RFC 5322 간소화 + 위험 문자 차단) */
export function validateEmail(email) {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  // 길이 제한
  if (trimmed.length > 254) return false;
  // 허용 패턴: 영문/숫자/특수문자@도메인.TLD
  const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  return EMAIL_RE.test(trimmed);
}

/** 문자열 입력 정제: null바이트·제어문자 제거, 길이 제한 */
export function sanitizeString(val, maxLen = 500) {
  if (val === null || val === undefined) return "";
  return String(val)
    // null 바이트 및 제어문자 제거 (탭·줄바꿈 제외)
    .replace(/\x00/g, "")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .slice(0, maxLen)
    .trim();
}

/** 숫자 파라미터 검증 */
export function sanitizeInt(val, defaultVal = 0) {
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultVal : n;
}

// ── 어드민 이메일 목록 ────────────────────────────────────────────────────────
export const ADMIN_EMAILS = ["choichoi3227@gmail.com"];

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(email?.toLowerCase().trim());
}

// ── 플랜 한도 ─────────────────────────────────────────────────────────────────
// 호스팅 플랜: DB/스토리지는 기본 미포함 (외부 연결 또는 유료 상품 사용)
export const PLAN_LIMITS = {
  free: {
    sites:         1,
    storage_gb:    0,      // 기본 스토리지 미제공 (외부 연결 또는 CP3 사용)
    traffic_gb:    50,
    custom_domain: false,
    backups:       false,
    db_included:   false,  // DB 미포함 (자체 작성 or CloudPressDB 구독 필요)
    php_version:   "8.1",
  },
  starter: {
    sites:         3,
    storage_gb:    0,      // 기본 스토리지 미제공
    traffic_gb:    500,
    custom_domain: true,
    backups:       true,   // 일 1회 백업
    db_included:   false,
    php_version:   "8.2",
    team_members:  1,
  },
  pro: {
    sites:         10,
    storage_gb:    0,      // 기본 스토리지 미제공
    traffic_gb:    null,   // 무제한
    custom_domain: true,
    backups:       true,   // 시간별 백업
    db_included:   false,
    php_version:   "8.3",
    team_members:  5,
  },
  enterprise: {
    sites:         Infinity,
    storage_gb:    0,
    traffic_gb:    null,
    custom_domain: true,
    backups:       true,
    db_included:   false,
    php_version:   "8.3",
    team_members:  Infinity,
  },
  // 어드민 플랜: 결제 없이 무제한
  admin: {
    sites:         Infinity,
    storage_gb:    Infinity,
    traffic_gb:    null,
    custom_domain: true,
    backups:       true,
    db_included:   true,
    php_version:   "8.3",
  },
};

// ── 상품별 가격 정의 ──────────────────────────────────────────────────────────
export const PRODUCT_PRICES = {
  // 워드프레스 호스팅 (호스팅당)
  hosting: {
    starter: { monthly: 9900,  yearly: 7920  },  // 연간 20% 할인
    pro:     { monthly: 24900, yearly: 19920 },
    enterprise: { monthly: 59900, yearly: 47920 },
  },
  // CloudPressDB (계정 단위)
  cpdb: {
    basic:    { monthly: 5900,  yearly: 4720  },  // 5GB, 기본 기능
    standard: { monthly: 14900, yearly: 11920 },  // 30GB, 샤딩
    pro:      { monthly: 39900, yearly: 31920 },  // 100GB, 전용 샤드
  },
  // CP3 오브젝트 스토리지 (계정 단위)
  cp3: {
    basic:    { monthly: 3900,  yearly: 3120  },  // 10GB
    standard: { monthly: 9900,  yearly: 7920  },  // 100GB
    pro:      { monthly: 29900, yearly: 23920 },  // 1TB
  },
  // CacheCloud (계정 단위)
  cachecloud: {
    basic:    { monthly: 4900,  yearly: 3920  },  // 사이트 1개, KV 1GB
    standard: { monthly: 12900, yearly: 10320 },  // 사이트 5개, KV 10GB
    pro:      { monthly: 29900, yearly: 23920 },  // 무제한, 우선 캐시
  },
};

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

// ── 바인딩 체크 ─────────────────────────────────────────────────────────────
export function checkBindings(env, keys) {
  return keys.filter(k => !env[k]);
}

// ── DB 헬퍼 ─────────────────────────────────────────────────────────────────
export async function dbGetUserByEmail(db, email) {
  // 입력 정제 후 prepared statement 사용 (SQL Injection 이중 방어)
  const safe = sanitizeString(email, 254).toLowerCase();
  if (!safe) return null;
  return db.prepare("SELECT * FROM users WHERE email = ?")
    .bind(safe)
    .first();
}

export async function dbGetUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id)
    .first();
}

export async function dbCreateUser(db, { id, email, passwordHash }) {
  const normalizedEmail = sanitizeString(email, 254).toLowerCase();
  if (!normalizedEmail) throw new Error("유효하지 않은 이메일");
  const role = isAdminEmail(normalizedEmail) ? "admin" : "user";
  const plan = role === "admin" ? "admin" : "free";
  await db.prepare(
    "INSERT INTO users (id, email, password_hash, role, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, normalizedEmail, passwordHash, role, plan, new Date().toISOString()).run();
}

export async function dbUpdateUserCfKey(db, userId, cfApiKey, cfEmail, cfAccountId, cfAccountName) {
  await db.prepare(
    "UPDATE users SET cf_global_api_key = ?, cf_email = ?, cf_account_id = ?, cf_account_name = ? WHERE id = ?"
  ).bind(cfApiKey, cfEmail || null, cfAccountId || null, cfAccountName || null, userId).run();
}

// ── Cloudflare API 키 검증 + 계정 정보 자동 수집 ────────────────────────────
// 반환값: { valid, accountId, accountName, userEmail, authType }
export async function fetchCfAccountInfo(apiKey, cfEmail) {
  try {
    // 1) API Token 방식 (Bearer) 우선 시도
    const tokenVerify = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    const tokenData = await tokenVerify.json();

    if (tokenData.success) {
      const [accRes, userRes] = await Promise.all([
        fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        }),
        fetch("https://api.cloudflare.com/client/v4/user", {
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        }),
      ]);
      const accData  = await accRes.json();
      const userData = await userRes.json();
      const account  = accData.result?.[0];
      if (!account) return { valid: false };
      return {
        valid:       true,
        accountId:   account.id,
        accountName: account.name,
        userEmail:   userData.result?.email || cfEmail || "",
        authType:    "token",
      };
    }

    // 2) Global API Key 방식 (X-Auth-Key + X-Auth-Email) fallback
    if (!cfEmail) return { valid: false };
    const globalHeaders = {
      "X-Auth-Email": cfEmail,
      "X-Auth-Key":   apiKey,
      "Content-Type": "application/json",
    };
    const [userRes, accRes] = await Promise.all([
      fetch("https://api.cloudflare.com/client/v4/user",             { headers: globalHeaders }),
      fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", { headers: globalHeaders }),
    ]);
    const userData = await userRes.json();
    const accData  = await accRes.json();
    if (!userData.success) return { valid: false };
    const account = accData.result?.[0];
    if (!account) return { valid: false };
    return {
      valid:       true,
      accountId:   account.id,
      accountName: account.name,
      userEmail:   userData.result?.email || cfEmail,
      authType:    "global_key",
    };
  } catch {
    return { valid: false };
  }
}

// 하위 호환성
export async function validateCfApiKey(apiKey, cfEmail) {
  const info = await fetchCfAccountInfo(apiKey, cfEmail);
  return info.valid;
}

// ── 세션 헬퍼 (KV) ─────────────────────────────────────────────────────────
export async function sessionCreate(sessionsKV, userId, email, role) {
  const sessionId = crypto.randomUUID();
  const value = JSON.stringify({ id: userId, email, role });
  // 24시간 TTL
  await sessionsKV.put(`session:${sessionId}`, value, { expirationTtl: 86400 });
  return sessionId;
}

export async function sessionDelete(sessionsKV, token) {
  await sessionsKV.delete(`session:${token}`);
}

// ── 관리자 CF API 키 조회 (cms_settings 테이블에서) ─────────────────────────
// 도메인 추가 등 플랫폼 차원의 CF 작업에 사용
export async function getAdminCfCredentials(db) {
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM cms_settings WHERE key IN ('admin_cf_api_key', 'admin_cf_email', 'admin_cf_account_id')"
    ).all().catch(() => ({ results: [] }));
    const map = {};
    for (const r of (rows?.results || [])) map[r.key] = r.value;
    return {
      apiKey:    map["admin_cf_api_key"]    || null,
      email:     map["admin_cf_email"]      || null,
      accountId: map["admin_cf_account_id"] || null,
    };
  } catch {
    return { apiKey: null, email: null, accountId: null };
  }
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
