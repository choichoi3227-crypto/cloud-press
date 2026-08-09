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
    // 2026-08: www.google.com/search를 Cloudflare Worker(공유 IP)에서 직접
    // fetch하면 Google이 이를 자동화 트래픽으로 탐지해 사실상 항상 429를
    // 반환한다. 이는 파싱 로직 문제가 아니라 요청 자체가 차단되는 것이라
    // User-Agent나 파서를 아무리 고쳐도 해결되지 않는다. 반면
    // news.google.com/rss/search는 공개 RSS 피드라 이런 차단이 거의 없고
    // 안정적으로 동작한다. 그래서 RSS를 1차(주력)로 승격하고, 일반 웹검색은
    // "되면 보너스"인 마지막 보조 시도로 순서를 내린다.
    endpoints: ({ q, start }) => [
      { type: "news-rss", url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko` },
      { type: "web", url: `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&start=${start}&hl=ko&gl=kr&pws=0` },
    ],
    // engine=google 응답에 안내 문구를 넣기 위한 메타 정보.
    notice: "Google 일반 웹검색(www.google.com)은 서버 환경에서 자동화 차단(HTTP 429)이 구조적으로 발생해 안정적으로 제공하기 어렵습니다. 이 대신 Google 뉴스 RSS(news.google.com)를 기본 소스로 사용하며, 이 경우 결과는 뉴스 기사로 한정됩니다.",
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
  // 2026-08: 네이버가 SERP를 "Fender" 컴포넌트 프레임워크로 교체하면서
  // total_tit/link_tit 등 옛 클래스명이 전부 사라지고, 대신 의미 없는 해시
  // 클래스(fender-ui_*, sds-comps-*)로 렌더링된다. 유일하게 버전을 넘어
  // 안정적으로 남아있는 앵커는 디자인시스템 타입 클래스인
  // sds-comps-text-type-headline1(제목)과 sds-comps-text-type-body1(본문)이므로
  // 이를 기준으로 파싱한다.
  const titleRe = /sds-comps-text-type-headline1[^"]*"[^>]*>([\s\S]*?)<\/span>/;
  const bodyRe = /sds-comps-text-type-body1[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span class="fender-ui_0cb57fb2">/;

  // 제목 앵커(headline1을 포함하는 <a>)를 우선 순서대로 훑고, 같은 문서 블록
  // 안에서 뒤따르는 body1 스니펫을 매칭시킨다.
  const anchorRe = /<a\b[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,2000}?)<\/a>/g;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const inner = match[2];
    if (!/sds-comps-text-type-headline1/.test(inner)) continue;
    const url = decodeHtml(match[1]);
    if (/^https?:\/\/(m\.)?search\.naver\.com/.test(url)) continue;
    if (/(^|\.)pstatic\.net$/.test((() => { try { return new URL(url).hostname; } catch { return ""; } })())) continue;
    const title = decodeHtml((inner.match(titleRe) || [])[1] || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    // 제목 뒤 최대 3000자 안에서 본문(body1) 스니펫을 찾는다.
    const tail = html.slice(match.index, match.index + 3000);
    const snippet = decodeHtml((tail.match(bodyRe) || [])[1] || "").replace(/\s+/g, " ").trim();
    results.push({ title, url, snippet });
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
  let bestType = null;
  for (const endpoint of provider.endpoints({ q, start })) {
    try {
      const response = await fetchWithTimeout(endpoint.url);
      const text = await response.text();
      const results = response.ok
        ? endpoint.type === "news-rss" ? parseGoogleNewsRss(text) : parser(text)
        : [];
      attempts.push({ type: endpoint.type, upstream_endpoint: endpoint.url, upstream_status: response.status, result_count: results.length });
      if (results.length > bestResults.length) {
        bestResults = results;
        bestType = endpoint.type;
      }
      if (bestResults.length >= 5) break;
    } catch (error) {
      attempts.push({ type: endpoint.type, upstream_endpoint: endpoint.url, upstream_status: 502, result_count: 0, error: String(error?.message || error) });
    }
  }
  return {
    engine,
    label: provider.label,
    source_type: bestType,
    ...(provider.notice ? { notice: provider.notice } : {}),
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

function docs() {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare Search Endpoint</title><style>body{font-family:system-ui,sans-serif;background:#050505;color:#fff;margin:0;padding:48px}.card{max-width:840px;margin:auto;border:1px solid #263044;border-radius:28px;padding:36px;background:#0d111a}code,pre{background:#000;border:1px solid #263044;border-radius:12px;padding:12px;display:block;overflow:auto}.warn{color:#fcd34d}</style></head><body><main class="card"><h1>Google + 네이버 무료 검색 엔드포인트</h1><p>Cloudflare Workers 무료 플랜에 바로 배포 가능한 API 키 없는 URL 요청 기반 엔드포인트입니다.</p><pre>GET /api/search?q=cloudpress&engine=all</pre><ul><li><code>engine=all</code> Google + 네이버</li><li><code>engine=google</code> Google (뉴스 RSS 기반, 일반 웹검색은 보조 시도)</li><li><code>engine=naver</code> 네이버</li><li><code>start=0</code> 시작 위치</li></ul><p class="warn">Google은 자동화 차단(429)으로 일반 웹검색이 제한적이라 뉴스 RSS를 기본 소스로 사용합니다. 그 외 외부 검색 사이트 정책과 차단에 따라 결과가 제한될 수 있습니다.</p></main></body></html>`, {
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
