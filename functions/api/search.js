// functions/api/search.js → GET /api/search
import { jsonOk, jsonErr, sanitizeString, sanitizeInt } from "../_shared.js";

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
  const response = await fetch(endpoint, { headers: FETCH_HEADERS, cf: { cacheTtl: 0, cacheEverything: false } });
  const html = await response.text();
  const parser = engine === "google" ? parseGoogle : parseNaver;
  return {
    engine,
    label: provider.label,
    endpoint,
    status: response.status,
    latency_ms: Date.now() - startedAt,
    results: response.ok ? parser(html) : [],
  };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const q = sanitizeString(url.searchParams.get("q"), 200);
  const engine = sanitizeString(url.searchParams.get("engine") || "all", 20).toLowerCase();
  const start = Math.max(0, sanitizeInt(url.searchParams.get("start"), 0));

  if (!q) return jsonErr("q 파라미터가 필요합니다. 예: /api/search?q=cloudpress&engine=all", 400);
  if (!["all", ...Object.keys(ENGINES)].includes(engine)) return jsonErr("engine은 all, google, naver 중 하나여야 합니다.", 400);

  const engines = engine === "all" ? Object.keys(ENGINES) : [engine];
  const settled = await Promise.allSettled(engines.map((name) => fetchEngine(name, q, start)));
  const providers = settled.map((item, index) => item.status === "fulfilled"
    ? item.value
    : { engine: engines[index], label: ENGINES[engines[index]].label, status: 502, latency_ms: 0, results: [], error: "검색 공급자 응답을 가져오지 못했습니다." });

  return jsonOk({
    query: q,
    engine,
    start,
    endpoint: "/api/search?q={검색어}&engine=all|google|naver&start=0",
    auth_required: false,
    api_key_required: false,
    cache: "disabled; upstream search pages are requested at call time",
    notice: "외부 검색 결과 페이지의 구조 변경, 자동화 차단, 약관 또는 네트워크 정책에 따라 결과 수와 실시간성이 달라질 수 있습니다.",
    providers,
  });
}
