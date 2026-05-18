/**
 * CloudPress — worker-site-mirror.js v13.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker — WordPress PHP CLI 미러링
 *
 * 역할:
 *   1. PHP Runner Service Binding으로 WordPress 동적 처리 (우선)
 *   2. wp-content 정적 자산 → GitHub 레포 wordpress/wp-content 미러링
 *   3. _cache/ 정적 HTML 폴백 (GitHub Actions 생성)
 *   4. GitHub Pages 폴백
 *
 * Worker 바인딩:
 *   CACHE        - Cloudflare KV (정적 자산 캐시)
 *   PHP_RUNNER   - PHP Runner Worker (Service Binding, 선택)
 *   SITE_ID      - 사이트 고유 ID (env var)
 *   GH_OWNER     - GitHub 레포 소유자 (env var)
 *   GH_REPO      - GitHub 레포 이름 (env var)
 *   GITHUB_TOKEN - GitHub Personal Access Token (secret)
 *   GH_PAGES_URL - GitHub Pages 폴백 URL (env var)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─── 사이트 상수 (cf-pages-hosting.js buildWorkerSource()에서 치환) ──────────
const SITE_ID      = "%%SITE_ID%%";
const GH_OWNER     = "%%GH_OWNER%%";
const GH_REPO      = "%%GH_REPO%%";
const GH_BRANCH    = "main";
const GH_PAGES_URL = "%%GH_PAGES_URL%%";

// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;

// ─── 보안 헤더 ───────────────────────────────────────────────────────────────
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
  "X-XSS-Protection":      "1; mode=block",
};

// ─── 환경변수 헬퍼 ───────────────────────────────────────────────────────────
const ghOwner  = (e) => e.GH_OWNER  || GH_OWNER;
const ghRepo   = (e) => e.GH_REPO   || GH_REPO;
const ghToken  = (e) => e.GITHUB_TOKEN || "";
const ghPages  = (e) => e.GH_PAGES_URL || GH_PAGES_URL || "";

// ─── KV 헬퍼 ─────────────────────────────────────────────────────────────────
const kvGetBuf = async (e, k)      => { try { return await e.CACHE?.get(k, "arrayBuffer"); } catch { return null; } };
const kvPut    = async (e, k, v, t = 86400) => { try { await e.CACHE?.put(k, v, { expirationTtl: t }); } catch {} };

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({
    css: "text/css;charset=utf-8",
    js:  "application/javascript;charset=utf-8",
    json:"application/json;charset=utf-8",
    xml: "application/xml;charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", eot: "application/vnd.ms-fontobject", otf: "font/otf",
    pdf: "application/pdf", zip: "application/zip",
    mp4: "video/mp4", mp3: "audio/mpeg",
    txt: "text/plain;charset=utf-8",
    html:"text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

// ─── GitHub raw 파일 fetch ───────────────────────────────────────────────────
async function ghRaw(env, filePath) {
  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);
  if (!o || !r) return null;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${o}/${r}/${GH_BRANCH}/${filePath}`,
      {
        headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), "User-Agent": "CloudPress/13" },
        cf: { cacheEverything: true, cacheTtl: 300 },
      }
    );
    return res.ok ? res : null;
  } catch { return null; }
}

// ─── GitHub Pages 폴백 ───────────────────────────────────────────────────────
async function ghPagesFallback(env, url) {
  const base = ghPages(env);
  if (!base) return null;
  try {
    const r = await fetch(base + url.pathname + url.search);
    return r.ok ? r : null;
  } catch { return null; }
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url      = new URL(req.url);
    const path     = url.pathname;
    const cacheKey = `wp-mirror:${ghOwner(env)}/${ghRepo(env)}:${path}${url.search}`;

    // ── 1차: PHP Runner Service Binding (동적 WordPress 처리) ────────────────
    if (env.PHP_RUNNER) {
      try {
        const phpRes = await env.PHP_RUNNER.fetch(req.clone());
        if (phpRes.ok || phpRes.status < 500) return phpRes;
      } catch {}
    }

    // ── 2차: KV 캐시 HIT (정적 자산) ────────────────────────────────────────
    if (req.method === "GET" && STATIC_EXT.test(path)) {
      const cached = await kvGetBuf(env, cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=86400", ...SEC },
        });
      }
    }

    // ── 3차: wordpress/wp-content 정적 자산 미러링 ───────────────────────────
    if (STATIC_EXT.test(path) && path.startsWith("/wp-content/")) {
      const wpPath = "wordpress" + path;
      const res = await ghRaw(env, wpPath);
      if (res) {
        const body = await res.arrayBuffer();
        ctx.waitUntil(kvPut(env, cacheKey, body));
        return new Response(body, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=86400", ...SEC },
        });
      }
    }

    // ── 4차: _cache/ 정적 HTML 폴백 (GitHub Actions 생성) ───────────────────
    let cachePath = "_cache" + path;
    if (cachePath.endsWith("/")) cachePath += "index.html";
    else if (!STATIC_EXT.test(path)) cachePath += "/index.html";

    let res = await ghRaw(env, cachePath);
    if (!res && !STATIC_EXT.test(path)) {
      res = await ghRaw(env, "_cache" + path + ".html");
    }

    // ── 5차: GitHub Pages 폴백 ───────────────────────────────────────────────
    if (!res) res = await ghPagesFallback(env, url);

    if (!res) {
      return new Response("Not Found", { status: 404, headers: { ...SEC, "Content-Type": "text/plain" } });
    }

    const ct   = res.headers.get("Content-Type") || mime(cachePath);
    const body = await res.arrayBuffer();

    if (req.method === "GET" && STATIC_EXT.test(path)) {
      ctx.waitUntil(kvPut(env, cacheKey, body));
    }

    return new Response(body, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": STATIC_EXT.test(path) ? "public,max-age=86400" : "public,max-age=60,s-maxage=300",
        ...SEC,
      },
    });
  },
};
