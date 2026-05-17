/**
 * CloudPress — worker-site-mirror.js v12.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker — 순수 dist/ 미러링
 *
 * 역할:
 *   GitHub 레포의 dist/ 폴더(Astro SSR 빌드 결과물)를 100% 미러링
 *   하드코딩 없음 — GitHub 레포에 나타나는 내용만 서빙
 *   동적 기능은 Astro SSR API Routes가 SQLite DB(_db/wordpress.db)로 처리
 *
 * 처리 순서:
 *   1. KV 캐시 HIT (정적 자산)
 *   2. GitHub 레포 dist/ 경로 fetch (미러링)
 *   3. GitHub Pages 폴백
 *   4. 404
 *
 * Worker 바인딩:
 *   CACHE        - Cloudflare KV (정적 자산 캐시)
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
const STATIC_EXT = /\.(css|js|mjs|ts|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm|gz|br)$/i;

// ─── 보안 헤더 ───────────────────────────────────────────────────────────────
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
  "X-XSS-Protection":      "1; mode=block",
  "Permissions-Policy":    "camera=(), microphone=(), geolocation=()",
};

// ─── 환경변수 헬퍼 ───────────────────────────────────────────────────────────
const ghOwner = (e) => e.GH_OWNER  || GH_OWNER;
const ghRepo  = (e) => e.GH_REPO   || GH_REPO;
const ghToken = (e) => e.GITHUB_TOKEN || "";
const ghPages = (e) => e.GH_PAGES_URL || GH_PAGES_URL || "";

// ─── KV 헬퍼 ─────────────────────────────────────────────────────────────────
const kvGetBuf = async (e, k) => { try { return await e.CACHE?.get(k, "arrayBuffer"); } catch { return null; } };
const kvPut    = async (e, k, v, t = 86400) => { try { await e.CACHE?.put(k, v, { expirationTtl: t }); } catch {} };

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({
    css:  "text/css;charset=utf-8",
    js:   "application/javascript;charset=utf-8",
    mjs:  "application/javascript;charset=utf-8",
    ts:   "application/javascript;charset=utf-8",
    json: "application/json;charset=utf-8",
    xml:  "application/xml;charset=utf-8",
    svg:  "image/svg+xml",
    png:  "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif:  "image/gif", webp: "image/webp", avif: "image/avif",
    ico:  "image/x-icon",
    woff: "font/woff", woff2: "font/woff2",
    ttf:  "font/ttf", eot: "application/vnd.ms-fontobject", otf: "font/otf",
    pdf:  "application/pdf", zip: "application/zip",
    mp4:  "video/mp4", webm: "video/webm",
    mp3:  "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    txt:  "text/plain;charset=utf-8",
    html: "text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

// ─── GitHub 레포 raw 파일 fetch ───────────────────────────────────────────────
async function ghRaw(env, filePath) {
  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);
  if (!o || !r) return null;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${o}/${r}/${GH_BRANCH}/${filePath}`,
      {
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          "User-Agent": "CloudPress/12",
        },
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
    const r = await fetch(base + url.pathname + url.search, {
      cf: { cacheEverything: true, cacheTtl: 60 },
    });
    return r.ok ? r : null;
  } catch { return null; }
}

// ─── 메인 핸들러 ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url      = new URL(req.url);
    const path     = url.pathname;
    const method   = req.method.toUpperCase();
    const isStatic = STATIC_EXT.test(path);
    const cacheKey = `mirror:${ghOwner(env)}/${ghRepo(env)}:${path}${url.search}`;

    // ── 1. KV 캐시 HIT (정적 자산만) ─────────────────────────────────────
    if (method === "GET" && isStatic) {
      const cached = await kvGetBuf(env, cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type":  mime(path),
            "Cache-Control": "public,max-age=86400",
            ...SEC,
          },
        });
      }
    }

    // ── 2. dist/ 경로 결정 및 GitHub 레포 fetch (순수 미러링) ────────────
    // Astro SSR 빌드 결과물 → dist/ 폴더에 존재
    // 정적 자산: dist/_astro/... 또는 dist/...
    // 페이지:   dist/page.html 또는 dist/page/index.html
    let res = null;
    let distPath = "dist" + path;
    if (distPath.endsWith("/")) distPath += "index.html";

    // 2a. dist/path 직접 시도
    res = await ghRaw(env, distPath);

    // 2b. dist/path/index.html
    if (!res && !isStatic) {
      const alt = "dist" + (path.endsWith("/") ? path : path + "/") + "index.html";
      res = await ghRaw(env, alt);
    }

    // 2c. dist/path.html
    if (!res && !isStatic && path !== "/") {
      res = await ghRaw(env, "dist" + path + ".html");
    }

    // ── 3. GitHub Pages 폴백 ─────────────────────────────────────────────
    if (!res) res = await ghPagesFallback(env, url);

    // ── 4. 404 ───────────────────────────────────────────────────────────
    if (!res) return new Response("Not Found", { status: 404, headers: SEC });

    // ── 5. 응답 반환 ─────────────────────────────────────────────────────
    const ct   = res.headers.get("Content-Type") || mime(distPath);
    const body = await res.arrayBuffer();

    // KV 캐시 저장 (정적 자산)
    if (method === "GET" && isStatic) {
      ctx.waitUntil(kvPut(env, cacheKey, body, 86400));
    }

    return new Response(body, {
      headers: {
        "Content-Type":  ct,
        "Cache-Control": isStatic
          ? "public,max-age=86400"
          : "public,max-age=60,s-maxage=300",
        ...SEC,
      },
    });
  },
};
