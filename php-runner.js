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
      const r = await ghFetch(owner, repo, branch, filePath, token, false);
      if (r) {
        return new Response(await r.arrayBuffer(), {
          headers: { "Content-Type": mimeType(phpFile), "Cache-Control": "public, max-age=3600" },
        });
      }
    }
    if (phpFile.startsWith("/wp-includes/") || phpFile.startsWith("/wp-admin/")) {
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

  // 6. 설치 완료 여부 확인 (wp-config.php 또는 wp-includes/version.php 기준)
  const repoUrl    = owner && repo ? "https://github.com/" + owner + "/" + repo : "";
  const actionsUrl = repoUrl ? repoUrl + "/actions/workflows/install-wordpress.yml" : "";

  // wp-config.php 존재 시 설치 완료로 판단 (Actions 완료 후 항상 존재)
  let wpInstalled = false;
  if (owner && repo) {
    try {
      const cfgRes = await ghFetch(owner, repo, branch, "wp-config.php", token, true);
      if (cfgRes) {
        wpInstalled = true;
      } else {
        const verRes = await ghFetch(owner, repo, branch, "wp-includes/version.php", token, true);
        wpInstalled = !!verRes;
      }
    } catch {}
  }

  // 설치 완료인데 여기까지 온 경우: 캐시 아직 없음 → 사이트 준비 중 안내
  if (wpInstalled) {
    const siteHost = (payload.phpEnv?.HTTP_HOST) || "이 사이트";
    return new Response(
      `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>준비 중 — ${siteHost}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Malgun Gothic,sans-serif;
  background:#fff;display:flex;flex-direction:column;min-height:100vh}
header{background:#1d2327;padding:18px 32px}
header span{color:#fff;font-size:18px;font-weight:700}
.hero{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:60px 24px;text-align:center}
.emoji{font-size:64px;margin-bottom:24px}
h1{font-size:34px;font-weight:800;color:#1d2327;margin-bottom:12px}
.sub{font-size:16px;color:#646970;max-width:400px;line-height:1.6;margin-bottom:32px}
.bar{width:220px;height:4px;background:#f0f0f1;border-radius:4px;overflow:hidden;margin-bottom:12px}
.fill{height:100%;background:#2271b1;animation:p 2s ease-in-out infinite alternate}
@keyframes p{from{width:25%}to{width:75%}}
.note{font-size:13px;color:#a7aaad}
footer{padding:20px;text-align:center;font-size:12px;color:#a7aaad;border-top:1px solid #f0f0f1}
</style></head>
<body>
<header><span>${siteHost}</span></header>
<div class="hero">
  <div class="emoji">🚀</div>
  <h1>사이트 준비 중입니다</h1>
  <p class="sub">WordPress 설치가 완료되었습니다. 첫 페이지를 생성하는 동안 잠시만 기다려 주세요.</p>
  <div class="bar"><div class="fill"></div></div>
  <p class="note">15초마다 자동 새로고침됩니다</p>
</div>
<footer>Powered by CloudPress · WordPress Hosting</footer>
</body></html>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "15" } }
    );
  }

  if (path.startsWith("/wp-admin") || path.startsWith("/wp-login")) {
    return new Response(
      "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>WordPress 관리자</title>" +
      "<style>body{font-family:sans-serif;background:#f0f0f1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}" +
      ".card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;max-width:440px;padding:40px;text-align:center}" +
      "h1{color:#1d2327;font-size:20px}p{color:#646970;font-size:14px;line-height:1.6}" +
      "a{color:#2271b1;font-weight:600}</style></head>" +
      "<body><div class=\"card\"><h1>🔐 WordPress 관리자</h1>" +
      "<p>WordPress 설치가 아직 완료되지 않았습니다.<br>" +
      (actionsUrl ? "<a href=\"" + actionsUrl + "\" target=\"_blank\">GitHub Actions에서 설치 진행상황 확인</a>" : "") +
      "</p></div></body></html>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  return new Response(
    "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><meta http-equiv=\"refresh\" content=\"30\">" +
    "<title>WordPress 설치 중</title>" +
    "<style>*{box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#f0f0f1;" +
    "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}" +
    ".card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;max-width:500px;width:100%;padding:40px;text-align:center}" +
    ".badge{background:#f0b849;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;display:inline-block;margin-bottom:14px}" +
    "h1{color:#1d2327;font-size:20px;margin:0 0 10px}p{color:#646970;font-size:14px;line-height:1.6;margin:0 0 14px}" +
    "a.btn{display:inline-block;background:#2271b1;color:#fff;text-decoration:none;padding:8px 18px;border-radius:3px;font-size:13px;margin:4px}" +
    ".steps{text-align:left;background:#f6f7f7;border-radius:4px;padding:14px 18px;margin:14px 0;font-size:13px;line-height:2;color:#3c434a}" +
    ".note{font-size:12px;color:#a7aaad;margin-top:14px}</style></head>" +
    "<body><div class=\"card\">" +
    "<div class=\"badge\">WORDPRESS INSTALLING</div>" +
    "<h1>⚙️ WordPress 설치 진행 중</h1>" +
    "<p>GitHub Actions가 WordPress 최신버전을 자동으로 설치하고 있습니다.</p>" +
    "<ol class=\"steps\"><li>✅ GitHub 레포지토리 생성</li>" +
    "<li>⏳ WordPress 최신버전 파일 설치 중...</li>" +
    "<li>⏳ 데이터베이스 초기화 중...</li>" +
    "<li>⏳ 정적 캐시 생성 중...</li></ol>" +
    (actionsUrl ? "<a class=\"btn\" href=\"" + actionsUrl + "\" target=\"_blank\">🔄 설치 진행상황 보기</a>" : "") +
    (repoUrl ? " <a class=\"btn\" style=\"background:#6e7d88\" href=\"" + repoUrl + "\" target=\"_blank\">📁 GitHub 레포 보기</a>" : "") +
    "<p class=\"note\">30초마다 자동 새로고침됩니다</p>" +
    "</div></body></html>",
    {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" },
    }
  );
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
        const r = await ghFetch(ghOwner, ghRepo, "main", filePath, token, false);
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
