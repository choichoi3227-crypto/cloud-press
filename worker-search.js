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

export default {
  async fetch(request, env) {
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
  },
};
