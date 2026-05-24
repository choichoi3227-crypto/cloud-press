// functions/_middleware.js
// 모든 /api/* 요청에 적용되는 전역 미들웨어
// - CORS 처리
// - DDoS 밴 체크 (CACHE 있을 때만)
// - Rate Limit (CACHE 있을 때만)
// - SQL Injection / XSS 패턴 조기 차단
// - 필수 바인딩 누락 조기 감지

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonErr(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ── 위험 패턴 목록 (SQL Injection / XSS / Path Traversal) ───────────────────
const DANGEROUS_PATTERNS = [
  /union\s+(all\s+)?select/i,
  /;\s*(drop|truncate|delete|insert|update)\s/i,
  /\bor\b\s*['"]?\w+['"]?\s*=\s*['"]?\w+/i,
  /\/etc\/passwd/i,
  /\.\.\//,
  /base64_decode\s*\(/i,
  /eval\s*\(/i,
  /<\s*(script|iframe|img\s+src\s*=)/i,
  /javascript\s*:/i,
];

/** URL과 Content-Type이 JSON인 바디에서 위험 패턴 감지 */
async function detectInjection(request) {
  const url = new URL(request.url);
  // 쿼리스트링 검사
  const qs = decodeURIComponent(url.search);
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(qs)) return true;
  }
  // JSON 바디 검사 (로그인/회원가입 등 POST)
  const ct = request.headers.get("Content-Type") || "";
  if (request.method === "POST" && ct.includes("application/json")) {
    try {
      const clone = request.clone();
      const text  = await clone.text();
      if (text.length < 65536) { // 64KB 이하만 검사
        for (const re of DANGEROUS_PATTERNS) {
          if (re.test(decodeURIComponent(text))) return true;
        }
      }
    } catch { /* 파싱 실패는 무시 — 개별 핸들러가 처리 */ }
  }
  return false;
}

// ── 악성 User-Agent 목록 ────────────────────────────────────────────────────
const BLOCKED_UA = [
  "sqlmap", "nikto", "nmap", "masscan", "zgrab",
  "dirbuster", "dirb", "wfuzz", "acunetix", "nessus",
  "havij", "pangolin",
];

export async function onRequest(context) {
  const { request, next, env } = context;
  const method = request.method;

  // CORS 프리플라이트
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const ip  = request.headers.get("CF-Connecting-IP") || "unknown";

  // ── 악성 User-Agent 차단 ──────────────────────────────────────────────────
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  for (const bad of BLOCKED_UA) {
    if (ua.includes(bad)) return jsonErr("접근이 차단되었습니다.", 403);
  }

  // ── DDoS 밴 체크 ──────────────────────────────────────────────────────────
  if (env.CACHE) {
    const banned = await env.CACHE.get(`ddos_ban:${ip}`);
    if (banned) return jsonErr("접근이 차단되었습니다.", 403);
  }

  // ── SQL Injection / XSS 패턴 조기 차단 ────────────────────────────────────
  const isInjection = await detectInjection(request);
  if (isInjection) {
    // IP를 단기 밴 (5분)
    if (env.CACHE) {
      await env.CACHE.put(`ddos_ban:${ip}`, "injection", { expirationTtl: 300 }).catch(() => {});
    }
    console.warn(`[security] Injection attempt blocked from ${ip} — ${url.pathname}`);
    return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);
  }

  // ── Rate Limit ─────────────────────────────────────────────────────────────
  if (env.CACHE) {
    const isAuthRoute = ["/api/signup", "/api/login"].some(p => url.pathname.endsWith(p));
    const maxPerMin   = isAuthRoute ? 10 : 60;
    const window      = Math.floor(Date.now() / 60000);
    const rlKey       = `rl:${ip}:${window}`;
    const count       = parseInt(await env.CACHE.get(rlKey) || "0") + 1;
    await env.CACHE.put(rlKey, String(count), { expirationTtl: 120 });
    if (count > maxPerMin) {
      // Rate limit 초과 시 짧은 밴
      if (count > maxPerMin * 3 && env.CACHE) {
        await env.CACHE.put(`ddos_ban:${ip}`, "ratelimit", { expirationTtl: 600 }).catch(() => {});
      }
      return jsonErr("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", 429);
    }
  }

  // ── 다음 핸들러로 ──────────────────────────────────────────────────────────
  const response = await next();

  // 모든 응답에 CORS + 보안 헤더 추가
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) newHeaders.set(k, v);
  newHeaders.set("X-Content-Type-Options", "nosniff");
  newHeaders.set("X-Frame-Options", "DENY");
  newHeaders.set("Referrer-Policy", "strict-origin");
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
