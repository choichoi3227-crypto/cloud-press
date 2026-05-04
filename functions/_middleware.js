// functions/_middleware.js
// 모든 /api/* 요청에 적용되는 전역 미들웨어
// - CORS 처리
// - DDoS 밴 체크 (CACHE 있을 때만)
// - Rate Limit (CACHE 있을 때만)
// - 필수 바인딩 누락 조기 감지 (DB, SESSIONS만 필수)

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

export async function onRequest(context) {
  const { request, next, env } = context;
  const method = request.method;

  // CORS 프리플라이트
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const url = new URL(request.url);
  const ip  = request.headers.get("CF-Connecting-IP") || "unknown";

  // DDoS 밴 체크 (CACHE 바인딩 있을 때만)
  if (env.CACHE) {
    const banned = await env.CACHE.get(`ddos_ban:${ip}`);
    if (banned) return jsonErr("접근이 차단되었습니다.", 403);
  }

  // Rate Limit (CACHE 바인딩 있을 때만)
  if (env.CACHE) {
    const isAuthRoute = ["/api/signup", "/api/login"].some(p => url.pathname.endsWith(p));
    const maxPerMin   = isAuthRoute ? 10 : 60;
    const window      = Math.floor(Date.now() / 60000);
    const rlKey       = `rl:${ip}:${window}`;
    const count       = parseInt(await env.CACHE.get(rlKey) || "0") + 1;
    await env.CACHE.put(rlKey, String(count), { expirationTtl: 120 });
    if (count > maxPerMin) return jsonErr("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.", 429);
  }

  // 다음 핸들러로
  const response = await next();

  // 모든 응답에 CORS 헤더 추가
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) newHeaders.set(k, v);
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
