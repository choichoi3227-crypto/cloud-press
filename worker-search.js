/**
 * Cloudflare Worker deploy target for a keyless Google + Naver search endpoint,
 * a topic-research endpoint, and a thumbnail/poster image endpoint used by the
 * zorlinq32 WordPress plugin.
 *
 * Routes:
 *   GET  /api/search?q={query}&engine=all|google|naver&start=0
 *   POST /api/research   { query, max_results?, country? }  (X-AIBP-Secret optional)
 *   GET/POST /api/image   { prompt, topic?, subtitle?, style?, width?, height? }
 *   GET  / or /search    - minimal endpoint documentation
 *
 * Cloudflare Workers AI (recommended, see wrangler.toml [ai] binding):
 *   - /api/research works fully without the AI binding (rule-based). If bound,
 *     it makes at most ONE short AI call per request to lightly polish results.
 *   - /api/image tries flux-1-schnell once per request when the AI binding is
 *     present; on any failure (or when not bound) it falls back to a
 *     self-contained SVG "headless card" renderer that always succeeds.
 */

import { CORS_HEADERS, json, handleSearch, docsHtml } from "./search-core.js";
import { handleResearch } from "./research-handler.js";
import { handleImage } from "./image-core.js";

/**
 * ⚠️ 안정성 강화: 라우팅 로직 전체를 try/catch로 감싼다. 이전에는 각
 * 핸들러(handleSearch/handleResearch/handleImage) 내부에서 던져진 예외가
 * 여기까지 잡히지 않고 올라가면 Cloudflare가 "1101: Worker threw an
 * exception" 같은 원시 오류 페이지를 반환했고, 이 원시 오류 페이지는
 * WordPress 플러그인이 기대하는 JSON 형식이 아니라 HTML이라 플러그인 쪽
 * JSON 파싱이 깨지면서 관리자 화면에 아무 메시지 없이 실패하는 원인이
 * 되었다. 이제는 어떤 경로에서 예외가 나든 항상 JSON 형태의 500 응답을
 * 반환해, 호출하는 WordPress 플러그인이 최소한 오류 메시지를 파싱해
 * 사용자에게 보여줄 수 있게 한다.
 */
async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (url.pathname === "/api/search") {
    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
    return handleSearch(request);
  }

  if (url.pathname === "/api/research") {
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    return handleResearch(request, env);
  }

  if (url.pathname === "/api/image") {
    if (!["GET", "POST"].includes(request.method)) return json({ error: "Method Not Allowed" }, 405);
    return handleImage(request, env);
  }

  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  if (url.pathname === "/" || url.pathname === "/search") return docsHtml();
  return json({ error: "Not Found", endpoints: ["/api/search?q=cloudpress&engine=all", "/api/research", "/api/image?prompt=...&topic=...&style=poster"] }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      // 마지막 안전망: 어떤 핸들러에서도 잡히지 않은 예외가 여기까지 오면
      // 원시 오류 페이지 대신 항상 JSON을 반환한다.
      return json({
        error: "internal_worker_error",
        message: String((error && error.message) || error),
        success: false,
      }, 500);
    }
  },
};
