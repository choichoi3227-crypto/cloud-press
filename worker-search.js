/**
 * Cloudflare Worker deploy target for a keyless Google + Naver search endpoint,
 * plus an optional topic-research endpoint used by the zorlinq32 WordPress plugin
 * in place of the old Groq-based worker.
 *
 * Routes:
 *   GET  /api/search?q={query}&engine=all|google|naver&start=0
 *   POST /api/research   { query, max_results?, country? }  (X-AIBP-Secret optional)
 *   GET  / or /search    - minimal endpoint documentation
 *
 * Optional Cloudflare Workers AI:
 *   /api/research works fully without any AI binding (rule-based). If you bind
 *   Workers AI as `AI` in wrangler.toml, /api/research will additionally make at
 *   most ONE short AI call per request to lightly polish the research fields.
 *   This is entirely optional and off by default (no binding = no AI usage).
 */

import { CORS_HEADERS, json, handleSearch, docsHtml } from "./search-core.js";
import { handleResearch } from "./research-handler.js";

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

    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/" || url.pathname === "/search") return docsHtml();
    return json({ error: "Not Found", endpoint: "/api/search?q=cloudpress&engine=all" }, 404);
  },
};
