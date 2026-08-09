// functions/api/search.js → GET /api/search
// Pages Functions-compatible handler for the Cloudflare search API.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ENGINES = {
  google: {
    label: "Google",
    endpoints: ({ q, start }) => [
      { type: "web", url: `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&start=${start}&hl=ko&gl=kr&pws=0` },
      { type: "news-rss", url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko` },
    ],
  },
  naver: {
    label: "Naver",
    endpoints: ({ q, start }) => [
      { type: "web", url: `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(q)}&start=${start + 1}` },
      { type: "mobile", url: `https://m.search.naver.com/search.naver?query=${encodeURIComponent(q)}&where=m` },
      { type: "news", url: `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(q)}` },
    ],
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

function extractGenericLinks(html, { engine }) {
  const results = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = decodeHtml(match[1]);
    const url = engine === "google" ? unwrapGoogleUrl(rawHref) : rawHref;
    if (!url.startsWith("http")) continue;
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    if (!host) continue;
    if (engine === "google" && /(^|\.)(accounts|support|policies|maps)\.google\./.test(host)) continue;
    if (engine === "naver" && /^(search|m\.search)\.naver\.com$/.test(host)) continue;
    if (/(^|\.)gstatic\.com$|(^|\.)pstatic\.net$/.test(host)) continue;
    const title = decodeHtml(match[2]);
    if (title.length < 4 || title.length > 140) continue;
    if (/^(더보기|보기|이미지|동영상|뉴스|지도|쇼핑|로그인|캐시됨)$/i.test(title)) continue;
    const tail = html.slice(match.index, match.index + 1600);
    const snippet = decodeHtml(tail.match(/<(?:div|p|span)[^>]*(?:class=["'][^"']*(?:snippet|dsc|desc|api_txt_lines|total_dsc|sub_txt|detail)[^"']*["'])?[^>]*>([\s\S]{20,500}?)<\/(?:div|p|span)>/i)?.[1] || "");
    results.push({ title, url, snippet });
  }
  return dedupe(results);
}

function parseGoogle(html) {
  const results = [];
  const blocks = html.match(/<div class="g[\s\S]*?(?=<div class="g|<\/body>)/g) || [];
  for (const block of blocks) {
    const href = block.match(/href="([^"]+)"/)?.[1];
    const title = decodeHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]);
    const snippet = decodeHtml(block.match(/<div[^>]+(?:VwiC3b|yXK7lf|kb0PBd)[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
    const url = unwrapGoogleUrl(decodeHtml(href));
    if (title && url.startsWith("http") && !url.includes("google.com/search")) results.push({ title, url, snippet });
  }
  if (results.length) return dedupe(results);
  const linkBlocks = html.match(/<a href="(?:\/url\?q=|https?:\/\/)[\s\S]*?<\/a>/g) || [];
  for (const block of linkBlocks) {
    if (!block.includes("<h3")) continue;
    const href = block.match(/href="([^"]+)"/)?.[1];
    const title = decodeHtml(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]);
    const url = unwrapGoogleUrl(decodeHtml(href));
    if (title && url.startsWith("http") && !url.includes("google.com/search")) results.push({ title, url, snippet: "" });
  }
  const deduped = dedupe(results);
  return deduped.length ? deduped : extractGenericLinks(html, { engine: "google" });
}

function parseNaver(html) {
  const results = [];
  const linkRe = /<a[^>]+class="[^"]*(?:total_tit|link_tit|title_link|name_link|api_txt_lines)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = decodeHtml(match[1]);
    const title = decodeHtml(match[2]);
    const tail = html.slice(match.index, match.index + 1200);
    const snippet = decodeHtml(tail.match(/<(?:div|p|span)[^>]+class="[^"]*(?:dsc|desc|api_txt_lines|total_dsc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/)?.[1] || "");
    if (title && url.startsWith("http")) results.push({ title, url, snippet });
  }
  const deduped = dedupe(results);
  return deduped.length ? deduped : extractGenericLinks(html, { engine: "naver" });
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

function parseGoogleNewsRss(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return dedupe(items.map((item) => ({
    title: decodeHtml(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
    url: decodeHtml(item.match(/<link>([\s\S]*?)<\/link>/)?.[1]),
    snippet: decodeHtml(item.match(/<description>([\s\S]*?)<\/description>/)?.[1]),
  })).filter((item) => item.title && item.url));
}

function scoreResults(results) {
  const withSnippet = results.filter((item) => item.snippet).length;
  return Math.min(1, Number(((results.length / 10) * 0.7 + (withSnippet / Math.max(results.length, 1)) * 0.3).toFixed(2)));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("upstream_timeout"), 8000);
  try {
    return await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal, cf: { cacheTtl: 0, cacheEverything: false } });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEngine(engine, q, start) {
  const provider = ENGINES[engine];
  const parser = engine === "google" ? parseGoogle : parseNaver;
  const attempts = [];
  const startedAt = Date.now();
  let bestResults = [];
  for (const endpoint of provider.endpoints({ q, start })) {
    try {
      const response = await fetchWithTimeout(endpoint.url);
      const text = await response.text();
      const results = response.ok
        ? endpoint.type === "news-rss" ? parseGoogleNewsRss(text) : parser(text)
        : [];
      attempts.push({ type: endpoint.type, upstream_endpoint: endpoint.url, upstream_status: response.status, result_count: results.length });
      if (results.length > bestResults.length) bestResults = results;
      if (bestResults.length >= 5) break;
    } catch (error) {
      attempts.push({ type: endpoint.type, upstream_endpoint: endpoint.url, upstream_status: 502, result_count: 0, error: String(error?.message || error) });
    }
  }
  return {
    engine,
    label: provider.label,
    latency_ms: Date.now() - startedAt,
    grounding_score: scoreResults(bestResults),
    attempts,
    results: bestResults,
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
    grounding_target: "Gemini Search grounding에 가까운 검색 근거 품질을 목표로 provider별 다중 upstream, snippet 추출, latency/status/grounding_score를 제공합니다.",
    notice: "공식 Google/Naver API 또는 Gemini grounding API가 아니므로 외부 검색 사이트의 자동화 차단·약관·HTML 변경 시 동일 품질을 보장할 수 없습니다.",
    providers,
  });
}


export async function onRequestGet({ request }) {
  return handleSearch(request);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
