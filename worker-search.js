/**
 * Cloudflare Worker deploy target for a keyless Google + Naver search endpoint.
 *
 * Routes:
 *   GET /api/search?q={query}&engine=all|google|naver&start=0
 *   GET / or /search  - minimal endpoint documentation
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ENGINES = {
  google: {
    label: "Google",
    buildUrl: ({ q, start }) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&start=${start}&hl=ko&gl=kr&pws=0`,
  },
  naver: {
    label: "Naver",
    buildUrl: ({ q, start }) => `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(q)}&start=${start + 1}`,
  },
};

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapGoogleUrl(rawUrl = "") {
  try {
    const absolute = rawUrl.startsWith("http") ? rawUrl : `https://www.google.com${rawUrl}`;
    const parsed = new URL(absolute);
    if (parsed.pathname === "/url" && parsed.searchParams.get("q")) return parsed.searchParams.get("q");
    return absolute;
  } catch {
    return rawUrl;
  }
}

function parseGoogle(html) {
  const results = [];
  const blocks = html.match(/<a href="(?:\/url\?q=|https?:\/\/)[\s\S]*?<\/a>/g) || [];
  for (const block of blocks) {
    if (!block.includes("<h3")) continue;
    const href = block.match(/href="([^"]+)"/)?.[1];
    const title = decodeHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]);
    const url = unwrapGoogleUrl(decodeHtml(href));
    if (title && url.startsWith("http") && !url.includes("google.com/search")) {
      results.push({ title, url, snippet: "" });
    }
  }
  return dedupe(results);
}

function parseNaver(html) {
  const results = [];
  const linkRe = /<a[^>]+class="[^"]*(?:total_tit|link_tit|title_link)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = decodeHtml(match[1]);
    const title = decodeHtml(match[2]);
    if (title && url.startsWith("http")) results.push({ title, url, snippet: "" });
  }
  return dedupe(results);
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((item) => {
    const key = item.url.split("#")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function fetchEngine(engine, q, start) {
  const provider = ENGINES[engine];
  const endpoint = provider.buildUrl({ q, start });
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    headers: FETCH_HEADERS,
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const html = await response.text();
  const parser = engine === "google" ? parseGoogle : parseNaver;
  return {
    engine,
    label: provider.label,
    upstream_endpoint: endpoint,
    upstream_status: response.status,
    latency_ms: Date.now() - startedAt,
    results: response.ok ? parser(html) : [],
  };
}

async function handleSearch(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  const engine = (url.searchParams.get("engine") || "all").toLowerCase().trim();
  const start = Math.max(0, parseInt(url.searchParams.get("start") || "0", 10) || 0);

  if (!q) return json({ error: "q 파라미터가 필요합니다.", endpoint: "/api/search?q=cloudpress&engine=all" }, 400);
  if (!["all", ...Object.keys(ENGINES)].includes(engine)) return json({ error: "engine은 all, google, naver 중 하나여야 합니다." }, 400);

  const selectedEngines = engine === "all" ? Object.keys(ENGINES) : [engine];
  const settled = await Promise.allSettled(selectedEngines.map((name) => fetchEngine(name, q, start)));
  const providers = settled.map((item, index) => item.status === "fulfilled"
    ? item.value
    : { engine: selectedEngines[index], label: ENGINES[selectedEngines[index]].label, upstream_status: 502, latency_ms: 0, results: [], error: "검색 공급자 응답을 가져오지 못했습니다." });

  return json({
    query: q,
    engine,
    start,
    endpoint: "/api/search?q={검색어}&engine=all|google|naver&start=0",
    auth_required: false,
    api_key_required: false,
    cache: "disabled; every request fetches upstream search pages at call time",
    cloudflare_ready: true,
    notice: "Cloudflare 무료 Worker에 배포할 수 있지만, 외부 검색 사이트의 자동화 차단·약관·HTML 변경으로 영구 무료/100% 실시간/항상 성공은 보장할 수 없습니다.",
    providers,
  });
}

function docs() {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare Search Endpoint</title><style>body{font-family:system-ui,sans-serif;background:#050505;color:#fff;margin:0;padding:48px}.card{max-width:840px;margin:auto;border:1px solid #263044;border-radius:28px;padding:36px;background:#0d111a}code,pre{background:#000;border:1px solid #263044;border-radius:12px;padding:12px;display:block;overflow:auto}.warn{color:#fcd34d}</style></head><body><main class="card"><h1>Google + 네이버 무료 검색 엔드포인트</h1><p>Cloudflare Workers 무료 플랜에 바로 배포 가능한 API 키 없는 URL 요청 기반 엔드포인트입니다.</p><pre>GET /api/search?q=cloudpress&engine=all</pre><ul><li><code>engine=all</code> Google + 네이버</li><li><code>engine=google</code> Google</li><li><code>engine=naver</code> 네이버</li><li><code>start=0</code> 시작 위치</li></ul><p class="warn">외부 검색 사이트 정책과 차단에 따라 결과가 제한될 수 있습니다.</p></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
    if (url.pathname === "/api/search") return handleSearch(request);
    if (url.pathname === "/" || url.pathname === "/search") return docs();
    return json({ error: "Not Found", endpoint: "/api/search?q=cloudpress&engine=all" }, 404);
  },
};
