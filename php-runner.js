/**
 * CloudPress PHP Runner Worker v6.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 역할:
 *   - GitHub 레포의 WordPress 정적 캐시(_cache/)를 서빙
 *   - KV 캐시 레이어로 빠른 응답
 *   - 외부 PHP 서버가 설정된 경우 직접 프록시 (WP_PHP_PROXY_URL)
 *   - WordPress 코어 정적 파일 CDN 서빙
 *
 * 배포:
 *   wrangler deploy --config wrangler-php.toml
 *
 * 환경변수 (wrangler secret put):
 *   GITHUB_TOKEN       - GitHub Personal Access Token
 *
 * 선택적 환경변수:
 *   WP_PHP_PROXY_URL   - 외부 PHP 서버 URL (설정 시 직접 프록시)
 *   GH_OWNER / GH_REPO - GitHub 레포 정보
 *   GH_PAGES_URL       - GitHub Pages URL (폴백)
 */

const WP_VERSION = "latest";

// ─── KV 캐시 헬퍼 ────────────────────────────────────────────────────────────
async function kvGetText(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvGetBuf(env, key) {
  try { return await env.CACHE?.get(key, "arrayBuffer"); } catch { return null; }
}
async function kvSet(env, key, value, ttl) {
  try { await env.CACHE?.put(key, value, { expirationTtl: ttl || 3600 }); } catch {}
}

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mimeType(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const m = {
    css:"text/css; charset=utf-8", js:"application/javascript; charset=utf-8",
    mjs:"application/javascript; charset=utf-8", json:"application/json; charset=utf-8",
    xml:"application/xml; charset=utf-8", svg:"image/svg+xml",
    png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
    webp:"image/webp", avif:"image/avif", ico:"image/x-icon",
    woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf",
    eot:"application/vnd.ms-fontobject", otf:"font/otf",
    pdf:"application/pdf", zip:"application/zip",
    mp4:"video/mp4", webm:"video/webm", mp3:"audio/mpeg",
    ogg:"audio/ogg", wav:"audio/wav", txt:"text/plain; charset=utf-8",
    html:"text/html; charset=utf-8", htm:"text/html; charset=utf-8",
    php:"text/html; charset=utf-8",
  };
  return m[ext] || "application/octet-stream";
}

// ─── GitHub Raw 파일 fetch ────────────────────────────────────────────────────
async function ghFetch(owner, repo, branch, filePath, token, noCache) {
  if (!owner || !repo) return null;
  const url = "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/" + filePath;
  const headers = { "User-Agent": "CloudPress-PHP-Runner/6.0" };
  if (token) headers["Authorization"] = "Bearer " + token;
  try {
    const res = await fetch(url, {
      headers,
      cf: noCache ? { cacheEverything: false } : { cacheEverything: true, cacheTtl: 300 },
    });
    return res.ok ? res : null;
  } catch { return null; }
}

// ─── WordPress 코어 파일 fetch ────────────────────────────────────────────────
async function fetchCoreFile(filePath, env) {
  const cacheKey = "core:" + filePath;
  const cached = await kvGetBuf(env, cacheKey);
  if (cached) return { buffer: cached, ct: mimeType(filePath), fromCache: true };

  try {
    const res = await fetch("https://cdn.jsdelivr.net/gh/WordPress/WordPress@master/" + filePath, {
      cf: { cacheEverything: true, cacheTtl: 86400 * 7 },
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 5 * 1024 * 1024) await kvSet(env, cacheKey, buf, 86400 * 3);
      return { buffer: buf, ct: mimeType(filePath) };
    }
  } catch {}

  try {
    const res = await fetch("https://raw.githubusercontent.com/WordPress/WordPress/master/" + filePath, {
      headers: { "User-Agent": "CloudPress/6.0" },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 5 * 1024 * 1024) await kvSet(env, cacheKey, buf, 3600);
      return { buffer: buf, ct: mimeType(filePath) };
    }
  } catch {}

  return null;
}

// ─── _cache/ 정적 HTML 서빙 ──────────────────────────────────────────────────
async function serveStaticCache(path, owner, repo, branch, token, env, ctx) {
  if (!owner || !repo) return null;

  const cachePath = (path === "/" || path === "")
    ? "_cache/index.html"
    : "_cache" + (path.endsWith("/") ? path : path + "/") + "index.html";

  // KV 캐시
  const cacheKey = "static-cache:" + cachePath;
  const kvHit = await kvGetText(env, cacheKey);
  if (kvHit) {
    return new Response(kvHit, {
      headers: {
        "Content-Type":  "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=1800",
        "X-Cache":       "KV-HIT",
      },
    });
  }

  // GitHub _cache/
  const r = await ghFetch(owner, repo, branch, cachePath, token, false);
  if (!r) return null;

  const html = await r.text();
  if (ctx) ctx.waitUntil(kvSet(env, cacheKey, html, 1800));

  return new Response(html, {
    headers: {
      "Content-Type":  "text/html; charset=utf-8",
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=1800",
      "X-Cache":       "GH-STATIC",
    },
  });
}

// ─── 외부 PHP 프록시 ─────────────────────────────────────────────────────────
async function proxyToPhp(proxyUrl, payload) {
  try {
    const phpFile = payload.phpFile || "/index.php";
    const phpEnv  = payload.phpEnv  || {};
    const stdin   = payload.stdin   || "";
    const targetPath = phpFile === "/index.php" ? "/" : phpFile;
    const targetUrl  = proxyUrl.replace(/\/$/, "") + targetPath;
    const fullUrl    = phpEnv.QUERY_STRING
      ? targetUrl + "?" + phpEnv.QUERY_STRING
      : targetUrl;

    const headers = {};
    if (phpEnv.HTTP_COOKIE)          headers["Cookie"]          = phpEnv.HTTP_COOKIE;
    if (phpEnv.HTTP_USER_AGENT)      headers["User-Agent"]      = phpEnv.HTTP_USER_AGENT;
    if (phpEnv.HTTP_ACCEPT)          headers["Accept"]          = phpEnv.HTTP_ACCEPT;
    if (phpEnv.HTTP_ACCEPT_LANGUAGE) headers["Accept-Language"] = phpEnv.HTTP_ACCEPT_LANGUAGE;
    if (phpEnv.HTTP_AUTHORIZATION)   headers["Authorization"]   = phpEnv.HTTP_AUTHORIZATION;
    if (phpEnv.CONTENT_TYPE && stdin)headers["Content-Type"]    = phpEnv.CONTENT_TYPE;

    const res = await fetch(fullUrl, {
      method: phpEnv.REQUEST_METHOD || "GET",
      headers,
      body: stdin ? stdin : undefined,
      cf: { cacheEverything: false },
    });
    return res;
  } catch (e) {
    console.error("[php-proxy]", e.message);
    return null;
  }
}

// ─── run-wordpress 핵심 처리 ─────────────────────────────────────────────────
async function runWordpress(payload, env, ctx) {
  const phpFile   = payload.phpFile   || "/index.php";
  const phpEnv    = payload.phpEnv    || {};
  const skipCache = payload.skipCache || false;
  const siteConfig = payload.siteConfig || {};

  const owner  = siteConfig.githubOwner || phpEnv.GITHUB_OWNER || env.GH_OWNER || "";
  const repo   = siteConfig.githubRepo  || phpEnv.GITHUB_REPO  || env.GH_REPO  || "";
  const branch = "main";
  const token  = env.GITHUB_TOKEN || siteConfig.githubToken || phpEnv.GITHUB_TOKEN || "";
  const siteId = siteConfig.siteId || env.SITE_ID || "default";

  const path   = (phpEnv.REQUEST_URI || phpFile).split("?")[0] || "/";
  const method = phpEnv.REQUEST_METHOD || "GET";

  const isLoggedIn = (phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in");
  const skipPaths = ["/wp-admin", "/wp-login.php", "/cart", "/checkout", "/my-account", "/wp-cron.php"];
  const isCacheable = !skipCache
    && method === "GET"
    && !isLoggedIn
    && !skipPaths.some(p => path.startsWith(p));

  // 1. KV PHP 캐시
  if (isCacheable) {
    const ck = "php:" + siteId + ":" + (phpEnv.REQUEST_URI || phpFile);
    const cached = await kvGetText(env, ck);
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type":  "text/html; charset=utf-8",
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
          "X-Cache":       "HIT",
          "X-Powered-By":  "CloudPress/6.0",
        },
      });
    }
  }

  // 2. 외부 PHP 프록시 (WP_PHP_PROXY_URL 설정 시)
  const proxyUrl = env.WP_PHP_PROXY_URL || siteConfig.phpProxyUrl || "";
  if (proxyUrl) {
    const proxyRes = await proxyToPhp(proxyUrl, payload);
    if (proxyRes && proxyRes.ok) {
      if (isCacheable && (proxyRes.headers.get("Content-Type") || "").includes("text/html")) {
        const html = await proxyRes.clone().text();
        if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
          const ck = "php:" + siteId + ":" + (phpEnv.REQUEST_URI || phpFile);
          if (ctx) ctx.waitUntil(kvSet(env, ck, html, 3600));
        }
      }
      return proxyRes;
    }
  }

  // 3. _cache/ 정적 HTML
  if (isCacheable && owner && repo) {
    const staticRes = await serveStaticCache(path, owner, repo, branch, token, env, ctx);
    if (staticRes) return staticRes;
  }

  // 4. 정적 자산 (wp-content, wp-includes, wp-admin)
  const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;
  const filePath = phpFile.startsWith("/") ? phpFile.slice(1) : phpFile;
  if (STATIC_EXT.test(phpFile) && filePath) {
    if (phpFile.startsWith("/wp-content/") && owner && repo) {
      const r = await ghFetch(owner, repo, branch, "wordpress/" + filePath, token, false);
      if (r) {
        return new Response(await r.arrayBuffer(), {
          headers: { "Content-Type": mimeType(phpFile), "Cache-Control": "public, max-age=3600" },
        });
      }
    }
    if (phpFile.startsWith("/wp-includes/") || phpFile.startsWith("/wp-admin/")) {
      // 사용자 레포 wordpress/ 폴더 우선
      if (owner && repo) {
        const r = await ghFetch(owner, repo, branch, "wordpress/" + filePath, token, false);
        if (r) return new Response(await r.arrayBuffer(), {
          headers: { "Content-Type": mimeType(phpFile), "Cache-Control": "public, max-age=86400, immutable" },
        });
      }
      const coreFile = await fetchCoreFile(filePath, env);
      if (coreFile) {
        return new Response(coreFile.buffer, {
          headers: { "Content-Type": coreFile.ct, "Cache-Control": "public, max-age=86400, immutable" },
        });
      }
    }
  }

  // 5. GitHub Pages 폴백
  const ghPagesUrl = env.GH_PAGES_URL || siteConfig.ghPagesUrl || "";
  if (ghPagesUrl && isCacheable) {
    try {
      const r = await fetch(ghPagesUrl + path, {
        cf: { cacheEverything: true, cacheTtl: 300 },
        headers: { "User-Agent": "CloudPress-Fallback/6.0" },
      });
      if (r.ok) {
        const html = await r.text();
        if (ctx) ctx.waitUntil(kvSet(env, "php:" + siteId + ":" + (phpEnv.REQUEST_URI || phpFile), html, 900));
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", "X-Fallback": "github-pages" },
        });
      }
    } catch {}
  }

  // WordPress 서빙 — 어떤 상황에서도 WordPress를 즉시 서빙합니다
  // _cache, GH Pages, PHP proxy 모두 없을 경우 최소 404를 반환합니다
  // (준비 중, 설치 중 페이지는 절대 표시하지 않습니다)
  return new Response("<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>WordPress</title></head><body><p>WordPress is initializing. Please refresh the page.</p></body></html>", {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" },
  });
}
}

// ─── 메인 fetch 핸들러 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204 });

    // 헬스체크
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return new Response(JSON.stringify({
        status:  "ok",
        version: "6.0",
        engine:  env.WP_PHP_PROXY_URL ? "php-proxy" : "static-cache",
        wp:      WP_VERSION,
        github:  !!(env.GH_OWNER && env.GH_REPO),
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 정적 파일 직접 서빙
    if (url.pathname === "/serve-static" && method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      const ghOwner  = url.searchParams.get("github_owner") || env.GH_OWNER || "";
      const ghRepo   = url.searchParams.get("github_repo")  || env.GH_REPO  || "";
      const token    = env.GITHUB_TOKEN || "";

      if (filePath.startsWith("wp-content/") && ghOwner && ghRepo) {
        const r = await ghFetch(ghOwner, ghRepo, "main", "wordpress/" + filePath, token, false);
        if (r) return new Response(await r.arrayBuffer(), {
          headers: { "Content-Type": mimeType(filePath), "Cache-Control": "public, max-age=3600" },
        });
      }
      const coreFile = await fetchCoreFile(filePath, env);
      if (coreFile) return new Response(coreFile.buffer, {
        headers: { "Content-Type": coreFile.ct, "Cache-Control": "public, max-age=86400, immutable" },
      });
      return new Response("Not Found", { status: 404 });
    }

    // KV 캐시 무효화
    if (url.pathname === "/invalidate-cache" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { siteId, pattern } = body;
      if (env.CACHE) {
        try {
          if (siteId) {
            const list = await env.CACHE.list({ prefix: "php:" + siteId + ":" });
            for (const k of (list.keys || [])) await env.CACHE.delete(k.name).catch(() => {});
          }
          if (pattern) {
            const list = await env.CACHE.list({ prefix: "static-cache:_cache/" + pattern });
            for (const k of (list.keys || [])) await env.CACHE.delete(k.name).catch(() => {});
          }
        } catch {}
      }
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    // WordPress 실행 (메인 엔드포인트)
    if (url.pathname === "/run-wordpress" && method === "POST") {
      let payload;
      try { payload = await request.json(); }
      catch { return new Response("Invalid JSON", { status: 400 }); }
      return runWordpress(payload, env, ctx);
    }

    // 이 Worker는 Service Binding 내부 호출 전용입니다.
    // 직접 HTTP 접근 시 404를 반환합니다.
    return new Response(JSON.stringify({ error: "Not found", version: "6.0" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
