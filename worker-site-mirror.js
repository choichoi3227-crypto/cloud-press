/**
 * CloudPress — worker-site-mirror.js v6.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker 미러링 코드 (순수 미러링만)
 *
 * 역할:
 *   1. 요청 수신
 *   2. 정적 자산 → GitHub 레포 또는 WordPress 공식 CDN에서 서빙
 *   3. PHP 요청 → PHP_RUNNER(cloudpress-php) Service Binding으로 전달
 *      (php-wasm이 GitHub 레포의 WordPress 파일 + _db/wordpress.db 실행)
 *   4. Cloudflare 장애 시 → GitHub Pages 폴백으로 자동 전환
 *   5. SEO·성능·접근성 최적화 (캐시 전략, 메타 헤더, 사전 렌더링)
 *
 * ※ Worker 코드에는 미러링 로직만 포함합니다.
 *    WordPress PHP/DB 로직은 GitHub 레포 + cloudpress-php에 있습니다.
 *
 * Worker 바인딩:
 *   PHP_RUNNER  - cloudpress-php Worker (Service Binding)
 *   CACHE       - Cloudflare KV (PHP 출력 캐시 + 정적 자산 캐시)
 *   SITE_ID     - 사이트 고유 ID (env var)
 *   GH_OWNER    - GitHub 레포 소유자 (env var)
 *   GH_REPO     - GitHub 레포 이름 (env var)
 *   GITHUB_TOKEN - GitHub Personal Access Token (secret)
 *   GH_PAGES_URL - GitHub Pages 폴백 URL (env var)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─── 사이트 상수 (cf-pages-hosting.js buildWorkerSource()에서 치환) ──────────
const SITE_ID      = "%%SITE_ID%%";
const GH_OWNER     = "%%GH_OWNER%%";
const GH_REPO      = "%%GH_REPO%%";
const GH_BRANCH    = "main";
const GH_PAGES_URL = "%%GH_PAGES_URL%%"; // GitHub Pages 폴백 URL
const WP_VERSION   = "latest";

// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm|gz|tar)$/i;

// 캐시 스킵 경로 (로그인 필요 / 동적 페이지)
const SKIP_CACHE_PATHS = [
  "/wp-admin", "/wp-login.php", "/cart", "/checkout",
  "/my-account", "/wp-cron.php", "/xmlrpc.php",
];

// 봇/크롤러 User-Agent (사전 렌더링 캐시 우선 적용)
const BOT_RE = /googlebot|bingbot|yandex|baiduspider|facebookexternalhit|twitterbot|slurp|duckduckbot|linkedinbot|whatsapp|telegram/i;

// ─── 보안·성능 헤더 ──────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
  "X-XSS-Protection":      "1; mode=block",
  "Permissions-Policy":    "camera=(), microphone=(), geolocation=()",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-WP-Nonce,X-Requested-With",
};

// ─── KV 헬퍼 ─────────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvSet(env, key, val, ttl = 3600) {
  try { await env.CACHE?.put(key, val, { expirationTtl: ttl }); } catch {}
}
async function kvGetBuf(env, key) {
  try { return await env.CACHE?.get(key, "arrayBuffer"); } catch { return null; }
}
async function kvSetBuf(env, key, val, ttl = 86400) {
  try { await env.CACHE?.put(key, val, { expirationTtl: ttl }); } catch {}
}

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mime(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return ({
    css: "text/css;charset=utf-8",
    js: "application/javascript;charset=utf-8",
    mjs: "application/javascript;charset=utf-8",
    json: "application/json;charset=utf-8",
    xml: "application/xml;charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", eot: "application/vnd.ms-fontobject", otf: "font/otf",
    pdf: "application/pdf", zip: "application/zip",
    mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    txt: "text/plain;charset=utf-8",
    html: "text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

// ─── 환경변수 헬퍼 ───────────────────────────────────────────────────────────
function getSiteId(env)    { return env.SITE_ID    || SITE_ID;    }
function getGhOwner(env)   { return env.GH_OWNER   || GH_OWNER;   }
function getGhRepo(env)    { return env.GH_REPO    || GH_REPO;    }
function getGhToken(env)   { return env.GITHUB_TOKEN || "";       }
function getGhPagesUrl(env){ return env.GH_PAGES_URL || GH_PAGES_URL || ""; }

// ─── GitHub Raw fetch ─────────────────────────────────────────────────────────
async function fetchFromGitHub(env, filePath, noCache = false) {
  const owner = getGhOwner(env);
  const repo  = getGhRepo(env);
  const token = getGhToken(env);
  if (!owner || !repo) return null;

  const url     = `https://raw.githubusercontent.com/${owner}/${repo}/${GH_BRANCH}/${filePath}`;
  const headers = { "User-Agent": "CloudPress-Mirror/6.0" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      headers,
      cf: noCache
        ? { cacheEverything: false }
        : { cacheEverything: true, cacheTtl: 300 },
    });
    if (res.ok) return res;
  } catch {}
  return null;
}

// ─── WordPress 코어 정적 자산 fetch (jsDelivr CDN → GitHub Raw → 공식) ───────
async function fetchWpCore(filePath) {
  // 1. jsDelivr CDN (빠른 글로벌 엣지)
  const cdnUrl = `https://cdn.jsdelivr.net/gh/WordPress/WordPress@master/${filePath}`;
  try {
    const res = await fetch(cdnUrl, { cf: { cacheEverything: true, cacheTtl: 86400 * 7 } });
    if (res.ok) return res;
  } catch {}

  // 2. 공식 GitHub Raw
  const rawUrl = `https://raw.githubusercontent.com/WordPress/WordPress/master/${filePath}`;
  try {
    const res = await fetch(rawUrl, { cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (res.ok) return res;
  } catch {}

  return null;
}

// ─── Cloudflare 장애 감지 & GitHub Pages 폴백 ────────────────────────────────
// Cloudflare Worker 자체가 살아있으므로 여기서 감지하는 것은
// PHP_RUNNER 바인딩(cloudpress-php Worker) 장애 또는 GitHub 연결 실패입니다.
async function tryGithubPagesFallback(env, path, originalError) {
  const ghPagesUrl = getGhPagesUrl(env);
  if (!ghPagesUrl) return null;

  // GitHub Pages에서 정적 캐시된 페이지 시도
  const fallbackUrl = `${ghPagesUrl}${path}`.replace(/\/+$/, "/") || `${ghPagesUrl}/`;
  try {
    const res = await fetch(fallbackUrl, {
      cf: { cacheEverything: true, cacheTtl: 300 },
      headers: { "User-Agent": "CloudPress-Fallback/1.0" },
    });
    if (res.ok) {
      const html = await res.text();
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type":  "text/html;charset=utf-8",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
          "X-Fallback":    "github-pages",
          "X-Cache":       "FALLBACK",
          ...SECURITY_HEADERS,
        },
      });
    }
  } catch {}
  return null;
}

// ─── Cloudflare 장애 시 정적 페이지 (KV 캐시에서 서빙) ──────────────────────
async function serveSavedCache(env, path, search) {
  const key = `php:${getSiteId(env)}:${path}${search}`;
  const html = await kvGet(env, key);
  if (!html) return null;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type":  "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      "X-Cache":       "STALE",
      "X-Fallback":    "kv-cache",
      ...SECURITY_HEADERS,
    },
  });
}

// ─── 유지보수 모드 ────────────────────────────────────────────────────────────
async function isMaintenanceMode(env) {
  const val = await kvGet(env, `cp:maintenance:${getSiteId(env)}`);
  return val === "1";
}

function maintenancePage() {
  return new Response(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <meta name="robots" content="noindex,nofollow">
  <title>유지보수 중 — CloudPress</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#f0f0f1;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{text-align:center;padding:48px 40px;background:#fff;border-radius:8px;
         border:1px solid #c3c4c7;max-width:420px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .icon{font-size:48px;margin-bottom:16px}
    h1{color:#1d2327;font-size:22px;margin-bottom:12px}
    p{color:#646970;line-height:1.6}
    .note{font-size:12px;color:#a7aaad;margin-top:20px}
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔧</div>
    <h1>유지보수 중</h1>
    <p>설정을 업데이트하고 있습니다.<br>잠시 후 자동으로 다시 접속됩니다.</p>
    <p class="note">15초 후 자동으로 새로고침됩니다.</p>
  </div>
</body>
</html>`, {
    status: 503,
    headers: {
      "Content-Type":  "text/html;charset=utf-8",
      "Retry-After":   "30",
      "Cache-Control": "no-store",
    },
  });
}

// ─── 오류 페이지 ──────────────────────────────────────────────────────────────
function errorPage(status, title, desc) {
  return new Response(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e5e5e5;
         display:flex;align-items:center;justify-content:center;min-height:100vh}
    .box{text-align:center;padding:40px;max-width:500px}
    h1{font-size:72px;font-weight:900;color:#374151;margin-bottom:16px}
    h2{font-size:20px;margin-bottom:12px;color:#fff}
    p{color:#9ca3af;line-height:1.7}
    a{color:#60a5fa}
  </style>
</head>
<body>
  <div class="box">
    <h1>${status}</h1>
    <h2>${title}</h2>
    <p>${desc}</p>
  </div>
</body>
</html>`, {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8", ...SECURITY_HEADERS },
  });
}

// ─── PHP-WASM SEO 보조: 사전 렌더링 캐시 (봇 전용) ─────────────────────────
// 봇이 접근하면 KV 캐시의 HTML을 즉시 반환 (php-wasm 실행 없이)
// 이로 인해 Googlebot 등의 크롤링 속도·신뢰성 극대화
async function serveBotPrerender(env, path, search, isBot) {
  if (!isBot) return null;
  const key  = `prerender:${getSiteId(env)}:${path}${search}`;
  const html = await kvGet(env, key);
  if (!html) return null;
  return new Response(html, {
    headers: {
      "Content-Type":  "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "X-Cache":       "PRERENDER",
      "X-Robots-Tag":  "all",
      ...SECURITY_HEADERS,
    },
  });
}

// ─── PHP 실행 (PHP_RUNNER Service Binding → cloudpress-php → php-wasm) ────────
async function runWordPress(request, env, ctx, phpFile) {
  const url    = new URL(request.url);
  const method = request.method.toUpperCase();
  const siteId = getSiteId(env);
  const owner  = getGhOwner(env);
  const repo   = getGhRepo(env);
  const token  = getGhToken(env);

  // ── PHP_RUNNER 바인딩이 없는 경우: _cache/ 정적 HTML → GitHub Pages → KV 순 폴백 ──
  if (!env.PHP_RUNNER) {
    // 1. KV PHP 캐시 (빠른 응답)
    const kvSaved = await serveSavedCache(env, url.pathname, url.search);
    if (kvSaved) return kvSaved;

    // 2. GitHub _cache/ 정적 HTML (GitHub Actions가 생성)
    const isCacheablePath = method === "GET"
      && !SKIP_CACHE_PATHS.some(p => url.pathname.startsWith(p))
      && !(request.headers.get("Cookie") || "").includes("wordpress_logged_in");

    if (isCacheablePath && owner && repo) {
      const cachePath = (url.pathname === "/" || url.pathname === "")
        ? "_cache/index.html"
        : `_cache${url.pathname.endsWith("/") ? url.pathname : url.pathname + "/"}index.html`;
      const ghCacheRes = await fetchFromGitHub(env, cachePath);
      if (ghCacheRes) {
        const html = await ghCacheRes.text();
        if (ctx) ctx.waitUntil(kvSet(env, `php:${siteId}:${url.pathname}${url.search}`, html, 1800));
        return new Response(html, {
          headers: {
            "Content-Type":  "text/html; charset=utf-8",
            "Cache-Control": "public, s-maxage=30, stale-while-revalidate=1800",
            "X-Cache":       "GH-STATIC",
            ...SECURITY_HEADERS,
          },
        });
      }
    }

    // 3. GitHub Pages 폴백
    const ghFallback = await tryGithubPagesFallback(env, url.pathname, "PHP_RUNNER 없음");
    if (ghFallback) return ghFallback;

    // 4. 설치 완료 여부 체크
    // wp-config.php 또는 index.php(WP 코어) 중 하나라도 있으면 설치 완료로 판단
    // (GitHub Actions 완료 후 _db/wordpress.db는 LFS/캐시 문제로 감지 실패 가능)
    const repoUrl    = owner && repo ? `https://github.com/${owner}/${repo}` : "";
    const actionsUrl = repoUrl ? `${repoUrl}/actions/workflows/install-wordpress.yml` : "";
    const ghPagesActionsUrl = repoUrl ? `${repoUrl}/actions/workflows/gh-pages-fallback.yml` : "";
    let wpInstalled = false;
    try {
      // wp-config.php 먼저 확인 (Actions가 생성, 항상 레포에 존재)
      const cfgCheck = await fetchFromGitHub(env, "wp-config.php", true);
      if (cfgCheck) {
        wpInstalled = true;
      } else {
        // 폴백: wp-includes/version.php (WP 코어 설치 확인)
        const versionCheck = await fetchFromGitHub(env, "wp-includes/version.php", true);
        if (versionCheck) {
          wpInstalled = true;
        } else {
          // 최종 폴백: _db/wordpress.db (캐시 우회)
          const dbCheck = await fetchFromGitHub(env, "_db/wordpress.db", true);
          wpInstalled = !!dbCheck;
        }
      }
    } catch {}
    // 설치 완료 여부에 따라 다른 화면 표시
    const commonStyle = `*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Malgun Gothic,sans-serif;
  background:#f0f0f1;display:flex;align-items:center;justify-content:center;
  min-height:100vh;margin:0;padding:20px}
.card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;
  max-width:520px;width:100%;padding:40px;text-align:center}
.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;display:inline-block;margin-bottom:14px}
h1{color:#1d2327;font-size:20px;font-weight:600;margin:0 0 10px}
p{color:#646970;font-size:14px;line-height:1.6;margin:0 0 14px}
a.btn{display:inline-block;background:#2271b1;color:#fff;text-decoration:none;
  padding:8px 18px;border-radius:3px;font-size:13px;font-weight:600;margin:4px}
.steps{text-align:left;background:#f6f7f7;border-radius:4px;padding:14px 18px;
  margin:14px 0;font-size:13px;color:#3c434a;line-height:2}
.note{font-size:12px;color:#a7aaad;margin-top:14px}`;

    let statusHtml;
    if (wpInstalled) {
      // 설치 완료, 캐시 생성 대기 중
      statusHtml = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="20">
<title>캐시 생성 중</title>
<style>${commonStyle}</style></head>
<body><div class="card">
<div class="badge" style="background:#00a32a;color:#fff">ALMOST READY</div>
<h1>🎉 WordPress 설치 완료!</h1>
<p>정적 캐시를 생성하고 있습니다. 잠시 후 사이트가 열립니다.<br>
완료 후 이 페이지가 자동으로 갱신됩니다.</p>
<ol class="steps">
  <li>✅ GitHub 레포지토리 생성</li>
  <li>✅ WordPress 최신버전 설치 완료</li>
  <li>✅ 데이터베이스 초기화 완료</li>
  <li>⏳ 정적 캐시 생성 중 (gh-pages-fallback.yml)...</li>
</ol>
\${ghPagesActionsUrl ? \`<a class="btn" href="\${ghPagesActionsUrl}" target="_blank">🔄 캐시 생성 진행상황 보기</a>\` : ""}
\${repoUrl ? \` <a class="btn" style="background:#6e7d88" href="\${repoUrl}" target="_blank">📁 GitHub 레포 보기</a>\` : ""}
<p class="note">20초마다 자동 새로고침됩니다</p>
</div></body></html>`;
    } else {
      // 설치 진행 중
      statusHtml = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30">
<title>WordPress 준비 중</title>
<style>${commonStyle}</style></head>
<body><div class="card">
<div class="badge" style="background:#f0b849;color:#fff">WORDPRESS INSTALLING</div>
<h1>⚙️ WordPress 설치 진행 중</h1>
<p>GitHub Actions가 WordPress 최신버전을 자동으로 설치하고 있습니다.<br>
완료 후 이 페이지가 자동으로 갱신됩니다.</p>
<ol class="steps">
  <li>✅ GitHub 레포지토리 생성</li>
  <li>⏳ WordPress 최신버전 전체 파일 설치 중...</li>
  <li>⏳ 데이터베이스 초기화 중...</li>
  <li>⏳ 정적 캐시 생성 중...</li>
</ol>
\${actionsUrl ? \`<a class="btn" href="\${actionsUrl}" target="_blank">🔄 설치 진행상황 보기</a>\` : ""}
\${repoUrl ? \` <a class="btn" style="background:#6e7d88" href="\${repoUrl}" target="_blank">📁 GitHub 레포 보기</a>\` : ""}
<p class="note">30초마다 자동 새로고침됩니다</p>
</div></body></html>`;
    }

    return new Response(statusHtml,
      {
        status: 503,
        headers: {
          "Content-Type":  "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After":   "30",
        },
      }
    );
  }

  // wp-config.php를 GitHub 레포에서 읽기 (캐시 우회)
  let wpConfigContent = null;
  try {
    const cfgRes = await fetchFromGitHub(env, "wp-config.php", true);
    if (cfgRes) wpConfigContent = await cfgRes.text();
  } catch {}

  // 요청 body
  let stdin = "";
  if (["POST", "PUT", "PATCH"].includes(method)) {
    try { stdin = await request.text(); } catch {}
  }

  // PHP 환경변수
  const phpEnv = {
    REQUEST_METHOD:       method,
    REQUEST_URI:          url.pathname + url.search,
    QUERY_STRING:         url.search.slice(1),
    HTTP_HOST:            url.hostname,
    SERVER_NAME:          url.hostname,
    SERVER_PORT:          url.port || (url.protocol === "https:" ? "443" : "80"),
    HTTPS:                url.protocol === "https:" ? "on" : "off",
    SCRIPT_FILENAME:      `/var/www/wordpress${phpFile}`,
    SCRIPT_NAME:          phpFile,
    PHP_SELF:             phpFile,
    DOCUMENT_ROOT:        "/var/www/wordpress",
    GATEWAY_INTERFACE:    "CGI/1.1",
    SERVER_PROTOCOL:      "HTTP/1.1",
    SERVER_SOFTWARE:      "CloudPress/6.0 (php-wasm)",
    HTTP_COOKIE:          request.headers.get("Cookie")           || "",
    HTTP_USER_AGENT:      request.headers.get("User-Agent")       || "",
    HTTP_ACCEPT:          request.headers.get("Accept")           || "*/*",
    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language")  || "ko-KR,ko;q=0.9",
    HTTP_ACCEPT_ENCODING: request.headers.get("Accept-Encoding")  || "gzip",
    HTTP_REFERER:         request.headers.get("Referer")          || "",
    HTTP_X_FORWARDED_FOR: request.headers.get("CF-Connecting-IP") || "127.0.0.1",
    REMOTE_ADDR:          request.headers.get("CF-Connecting-IP") || "127.0.0.1",
    CONTENT_TYPE:         request.headers.get("Content-Type")     || "",
    CONTENT_LENGTH:       request.headers.get("Content-Length")   || String(stdin.length),
    CP_SITE_ID:           siteId,
    // SQLite DB 경로 (GitHub 레포 내 _db/wordpress.db)
    CP_SQLITE_DB_PATH:    "_db/wordpress.db",
    CP_GITHUB_OWNER:      owner,
    CP_GITHUB_REPO:       repo,
    CP_GITHUB_TOKEN:      token,
    CP_GITHUB_BRANCH:     GH_BRANCH,
  };

  const payload = {
    phpFile,
    phpEnv,
    stdin,
    siteConfig: {
      siteId,
      githubOwner:   owner,
      githubRepo:    repo,
      githubBranch:  GH_BRANCH,
      githubToken:   token,
      wpConfigContent,
      // SQLite DB: GitHub 레포에서 읽기
      sqliteDbPath:  "_db/wordpress.db",
      dbEngine:      "sqlite",
    },
    skipCache: method !== "GET" || (phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in"),
  };

  let phpRes;
  try {
    const phpReq = new Request("https://cloudpress-php/run-wordpress", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    phpRes = await env.PHP_RUNNER.fetch(phpReq);
  } catch (err) {
    console.error("[PHP_RUNNER] 호출 실패:", String(err?.message || err));

    // 1. KV PHP 캐시 (stale)
    const kvFallback = await serveSavedCache(env, url.pathname, url.search);
    if (kvFallback) return kvFallback;

    // 2. GitHub _cache/ 정적 HTML
    if (method === "GET" && !SKIP_CACHE_PATHS.some(p => url.pathname.startsWith(p)) && owner && repo) {
      const cachePath = (url.pathname === "/" || url.pathname === "")
        ? "_cache/index.html"
        : "_cache" + (url.pathname.endsWith("/") ? url.pathname : url.pathname + "/") + "index.html";
      const ghCacheRes = await fetchFromGitHub(env, cachePath);
      if (ghCacheRes) {
        const html = await ghCacheRes.text();
        return new Response(html, {
          headers: {
            "Content-Type":  "text/html; charset=utf-8",
            "Cache-Control": "public, s-maxage=30, stale-while-revalidate=900",
            "X-Cache":       "GH-STATIC-FALLBACK",
            ...SECURITY_HEADERS,
          },
        });
      }
    }

    // 3. GitHub Pages 폴백
    const ghFallback = await tryGithubPagesFallback(env, url.pathname, err);
    if (ghFallback) return ghFallback;

    return errorPage(502, "서비스 일시 중단", "잠시 후 다시 시도해주세요.");
  }

  // 캐시 가능 여부 판단
  const isCacheable =
    method === "GET" &&
    !SKIP_CACHE_PATHS.some(p => url.pathname.startsWith(p)) &&
    !(phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in");

  if (isCacheable && phpRes.ok) {
    const ct = phpRes.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      const html = await phpRes.text();

      // 관리자바 없는 공개 페이지만 캐시
      if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
        const cacheKey     = `php:${siteId}:${url.pathname}${url.search}`;
        const prerenderKey = `prerender:${siteId}:${url.pathname}${url.search}`;
        ctx.waitUntil(
          Promise.all([
            kvSet(env, cacheKey, html, 3600),        // 일반 캐시 1시간
            kvSet(env, prerenderKey, html, 86400),   // 봇 사전렌더링 캐시 24시간
          ])
        );
      }

      return new Response(html, {
        status: phpRes.status,
        headers: {
          ...Object.fromEntries(phpRes.headers),
          ...SECURITY_HEADERS,
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",
          "Link":          `<${url.pathname}>; rel="canonical"`,
        },
      });
    }
  }

  // 그 외 응답
  const resHeaders = new Headers(phpRes.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) resHeaders.set(k, v);

  return new Response(phpRes.body, {
    status:  phpRes.status,
    headers: resHeaders,
  });
}

// ─── 메인 fetch 핸들러 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();
    const ua     = request.headers.get("User-Agent") || "";
    const isBot  = BOT_RE.test(ua);

    // ── CORS 프리플라이트 ─────────────────────────────────────────────────
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── 헬스체크 ─────────────────────────────────────────────────────────
    if (path === "/_health" || path === "/_cf/health") {
      return new Response(JSON.stringify({ ok: true, site: getSiteId(env) }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── 유지보수 모드 (관리자 경로 제외) ─────────────────────────────────
    if (await isMaintenanceMode(env)) {
      if (!path.startsWith("/wp-admin/") && !path.startsWith("/wp-json/cloudpress/")) {
        return maintenancePage();
      }
    }

    // ── 봇 사전렌더링 캐시 (SEO 최적화: 봇에게 즉시 HTML 반환) ──────────
    if (isBot && method === "GET" && !STATIC_EXT.test(path)) {
      const prerendered = await serveBotPrerender(env, path, url.search, isBot);
      if (prerendered) return prerendered;
    }

    // ── KV PHP 캐시 조회 (GET + 비로그인) ────────────────────────────────
    const isCacheable =
      method === "GET" &&
      !SKIP_CACHE_PATHS.some(p => path.startsWith(p)) &&
      !(request.headers.get("Cookie") || "").includes("wordpress_logged_in") &&
      !STATIC_EXT.test(path);

    if (isCacheable) {
      const cached = await kvGet(env, `php:${getSiteId(env)}:${path}${url.search}`);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type":  "text/html;charset=utf-8",
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",
            "X-Cache":       "HIT",
            "Link":          `<${path}>; rel="canonical"`,
            ...SECURITY_HEADERS,
          },
        });
      }
    }

    // ── 정적 자산 서빙 ────────────────────────────────────────────────────
    if (STATIC_EXT.test(path)) {
      const filePath = path.replace(/^\//, "");

      // 1. wp-content (사용자 레포 GitHub에서)
      if (path.startsWith("/wp-content/")) {
        const cacheKey = `static:${getSiteId(env)}:${filePath}`;
        const cached   = await kvGetBuf(env, cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
              "X-Cache":       "HIT",
            },
          });
        }
        const ghRes = await fetchFromGitHub(env, filePath);
        if (ghRes) {
          const body = await ghRes.arrayBuffer();
          ctx.waitUntil(kvSetBuf(env, cacheKey, body, 3600));
          return new Response(body, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
              "X-Source":      "github-repo",
            },
          });
        }
      }

      // 2. WordPress 코어 (wp-includes, wp-admin 정적 파일)
      if (path.startsWith("/wp-includes/") || path.startsWith("/wp-admin/")) {
        // 먼저 GitHub 레포에서 시도 (설치 후 모든 WP 파일이 레포에 있음)
        const ghRes = await fetchFromGitHub(env, filePath);
        if (ghRes) {
          const body = await ghRes.arrayBuffer();
          return new Response(body, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
              "X-Source":      "github-repo",
            },
          });
        }
        // 폴백: jsDelivr CDN (WP 코어)
        const coreRes = await fetchWpCore(filePath);
        if (coreRes) {
          const body = await coreRes.arrayBuffer();
          return new Response(body, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=86400, immutable",
              "X-Source":      "wp-core-cdn",
            },
          });
        }
      }

      // robots.txt, sitemap.xml 처리
      if (path === "/robots.txt") {
        const ghRes = await fetchFromGitHub(env, "public/robots.txt");
        if (ghRes) {
          const txt = await ghRes.text();
          return new Response(txt, {
            headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "public, max-age=3600" },
          });
        }
      }

      return new Response("Not Found", { status: 404 });
    }

    // ── PHP 파일 경로 결정 ────────────────────────────────────────────────
    let phpFile = "/index.php";
    if (path === "/wp-login.php") {
      phpFile = "/wp-login.php";
    } else if (path.startsWith("/wp-admin/")) {
      phpFile = path.endsWith(".php") ? path : "/wp-admin/index.php";
    } else if (path.endsWith(".php")) {
      phpFile = path;
    }

    // ── WordPress 실행 (PHP_RUNNER → cloudpress-php → php-wasm) ──────────
    return runWordPress(request, env, ctx, phpFile);
  },

  // ─── Cloudflare Cron (캐시 갱신·헬스체크) ─────────────────────────────
  async scheduled(event, env, ctx) {
    // 홈페이지·주요 페이지 사전 렌더링 갱신
    const pages = ["/", "/blog", "/contact", "/about"];
    for (const p of pages) {
      try {
        const res = await fetch(`https://${env.WORKER_DOMAIN || "localhost"}${p}`, {
          headers: { "User-Agent": "CloudPress-Prerender/1.0" },
          cf: { cacheEverything: false },
        });
        if (res.ok) {
          const html = await res.text();
          const key  = `prerender:${getSiteId(env)}:${p}`;
          await kvSet(env, key, html, 86400);
        }
      } catch {}
    }
  },
};
