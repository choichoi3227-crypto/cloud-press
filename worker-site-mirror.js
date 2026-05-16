/**
 * CloudPress — worker-site-mirror.js
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker 미러링 코드 (진짜 WordPress 실행)
 *
 * 역할:
 *   1. 요청 수신
 *   2. 정적 자산 → GitHub 레포 또는 WordPress/WordPress 공식 CDN에서 서빙
 *   3. PHP 요청 → PHP_RUNNER(cloudpress-php) Service Binding으로 전달
 *   4. php-wasm이 GitHub 레포의 WordPress 파일을 실행
 *   5. 유지보수 모드 (설정 변경 중 접속 차단)
 *
 * 이 파일은 각 호스팅 생성 시 GitHub 레포에 worker.js 로 복사됩니다.
 * cf-pages-hosting.js의 buildWorkerSource()가 이 파일 내용을 기반으로
 * 사이트별 상수(SITE_ID, GH_OWNER, GH_REPO 등)를 치환하여 생성합니다.
 *
 * Worker 바인딩 (wrangler.toml / 프로비저닝 시 자동 설정):
 *   PHP_RUNNER  - cloudpress-php Worker (Service Binding) — php-wasm WordPress 실행
 *   DB          - Cloudflare D1 (WordPress 데이터베이스)
 *   CACHE       - Cloudflare KV (PHP 출력 캐시 + 정적 자산 캐시)
 *   SITE_ID     - 사이트 고유 ID (plain_text 환경변수)
 *   GH_OWNER    - GitHub 레포 소유자 (plain_text 환경변수)
 *   GH_REPO     - GitHub 레포 이름 (plain_text 환경변수)
 *   GITHUB_TOKEN - GitHub Personal Access Token (secret)
 *   DB_PASS     - WordPress DB 비밀번호 (secret, 자동 생성)
 *
 * 배포 전제 조건:
 *   cloudpress-php Worker가 먼저 배포되어 있어야 합니다.
 *   (npm run deploy:php 또는 wrangler deploy --config wrangler-php.toml)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ─── 사이트 상수 (cf-pages-hosting.js buildWorkerSource()에서 치환) ──────────
// 이 파일이 직접 배포될 때는 환경변수(env.*)를 우선 사용합니다.
const SITE_ID    = "%%SITE_ID%%";
const GH_OWNER   = "%%GH_OWNER%%";
const GH_REPO    = "%%GH_REPO%%";
const GH_BRANCH  = "main";
const WP_VERSION = "6.7.2";

// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm|gz|tar)$/i;

// 캐시 스킵 경로 (로그인 필요 / 동적 페이지)
const SKIP_CACHE_PATHS = [
  "/wp-admin", "/wp-login.php", "/cart", "/checkout",
  "/my-account", "/wp-cron.php", "/xmlrpc.php",
];

// ─── CORS 헤더 ───────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-WP-Nonce,X-Requested-With",
};

// ─── 보안 헤더 ───────────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
};

// ─── KV 헬퍼 ─────────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvSet(env, key, val, ttl = 3600) {
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

// ─── 사이트 상수 해석 (환경변수 우선) ────────────────────────────────────────
function getSiteId(env)   { return env.SITE_ID   || SITE_ID;   }
function getGhOwner(env)  { return env.GITHUB_OWNER || env.GH_OWNER  || GH_OWNER;  }
function getGhRepo(env)   { return env.GITHUB_REPO  || env.GH_REPO   || GH_REPO;   }
function getGhToken(env)  { return env.GITHUB_TOKEN || ""; }

// ─── GitHub Raw fetch (사용자 레포 파일) ─────────────────────────────────────
async function fetchFromGitHub(env, filePath, noCache = false) {
  const owner = getGhOwner(env);
  const repo  = getGhRepo(env);
  const token = getGhToken(env);
  if (!owner || !repo) return null;

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${GH_BRANCH}/${filePath}`;
  const headers = { "User-Agent": "CloudPress-SiteMirror/1.0" };
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

// ─── WordPress 코어 정적 자산 fetch (jsDelivr CDN → GitHub Raw 폴백) ─────────
async function fetchWpCore(filePath) {
  // jsDelivr CDN (빠른 글로벌 엣지)
  const cdnUrl = `https://cdn.jsdelivr.net/gh/WordPress/WordPress@${WP_VERSION}/${filePath}`;
  try {
    const res = await fetch(cdnUrl, {
      cf: { cacheEverything: true, cacheTtl: 86400 * 7 },
    });
    if (res.ok) return res;
  } catch {}

  // 폴백: 공식 GitHub Raw
  const rawUrl = `https://raw.githubusercontent.com/WordPress/WordPress/master/${filePath}`;
  try {
    const res = await fetch(rawUrl, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
    if (res.ok) return res;
  } catch {}

  return null;
}

// ─── 유지보수 모드 ────────────────────────────────────────────────────────────
async function isMaintenanceMode(env) {
  const siteId = getSiteId(env);
  const val = await kvGet(env, `cp:maintenance:${siteId}`);
  return val === "1";
}

function maintenancePage() {
  return new Response(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>유지보수 중 — CloudPress</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f0f0f1;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .box {
      text-align: center; padding: 48px 40px;
      background: #fff; border-radius: 8px;
      border: 1px solid #c3c4c7; max-width: 420px;
      box-shadow: 0 1px 3px rgba(0,0,0,.08);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: #1d2327; font-size: 22px; margin-bottom: 12px; }
    p  { color: #646970; line-height: 1.6; }
    .note { font-size: 12px; color: #a7aaad; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">🔧</div>
    <h1>유지보수 중</h1>
    <p>설정을 업데이트하고 있습니다.<br>잠시 후 자동으로 다시 접속됩니다.</p>
    <p class="note">10초 후 자동으로 새로고침됩니다.</p>
  </div>
</body>
</html>`, {
    status: 503,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Retry-After": "30",
      "Cache-Control": "no-store",
    },
  });
}

// ─── PHP 실행 (PHP_RUNNER Service Binding → cloudpress-php Worker) ────────────
async function runWordPress(request, env, ctx, phpFile) {
  // PHP_RUNNER 바인딩 확인
  if (!env.PHP_RUNNER) {
    return new Response(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>PHP Runner 필요</title>
<style>body{font-family:sans-serif;max-width:600px;margin:80px auto;padding:24px;background:#0a0a0a;color:#e5e5e5}
h1{color:#f87171}pre{background:#1c1c1c;padding:16px;border-radius:8px;font-size:13px;color:#86efac;overflow:auto}</style></head>
<body>
<h1>⚙️ PHP Runner 설정 필요</h1>
<p>진짜 WordPress 실행을 위해 <code>cloudpress-php</code> Worker가 필요합니다.</p>
<pre># 1단계: cloudpress-php Worker 배포 (php-wasm)
wrangler deploy --config wrangler-php.toml

# 2단계: 이 Worker 재배포
wrangler deploy</pre>
<p style="margin-top:16px;color:#94a3b8;">cloudpress-php가 배포된 후 이 사이트 Worker에
<code>PHP_RUNNER</code> Service Binding이 연결됩니다.</p>
</body></html>`, {
      status: 503,
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  }

  const url    = new URL(request.url);
  const method = request.method.toUpperCase();
  const token  = getGhToken(env);
  const owner  = getGhOwner(env);
  const repo   = getGhRepo(env);
  const siteId = getSiteId(env);

  // wp-config.php를 GitHub 레포에서 읽기 (캐시 우회 — 변경 즉시 반영)
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
    SERVER_SOFTWARE:      "CloudPress/1.0",
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
    // CloudPress 사이트 정보
    CP_SITE_ID:  siteId,
    CP_DB_NAME:  env.CP_DB_NAME  || "",
    CP_DB_USER:  env.CP_DB_USER  || "",
    CP_DB_PASS:  env.DB_PASS     || "",
    CP_DB_HOST:  "localhost",
  };

  // cloudpress-php에 전달할 payload
  const payload = {
    phpFile,
    phpEnv,
    stdin,
    siteConfig: {
      siteId,
      githubOwner:    owner,
      githubRepo:     repo,
      githubBranch:   GH_BRANCH,
      wpConfigContent,
      dbName:  env.CP_DB_NAME  || "",
      dbUser:  env.CP_DB_USER  || "",
      dbPass:  env.DB_PASS     || "",
      dbHost:  "localhost",
    },
    // 로그인 상태이거나 POST이면 캐시 스킵
    skipCache: method !== "GET" || (phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in"),
  };

  // PHP_RUNNER(cloudpress-php) Service Binding으로 WordPress 실행
  const phpReq = new Request("https://cloudpress-php/run-wordpress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const phpRes = await env.PHP_RUNNER.fetch(phpReq);

  // PHP 출력 캐싱 (GET + 비로그인 + HTML만)
  const isCacheable =
    method === "GET" &&
    !SKIP_CACHE_PATHS.some(p => url.pathname.startsWith(p)) &&
    !(phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in");

  if (isCacheable && phpRes.ok) {
    const ct = phpRes.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      const html = await phpRes.text();
      // 관리자바가 없는 공개 페이지만 캐시
      if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
        const cacheKey = `php:${siteId}:${url.pathname}${url.search}`;
        ctx.waitUntil(kvSet(env, cacheKey, html, 3600));
      }
      return new Response(html, {
        status: phpRes.status,
        headers: {
          ...Object.fromEntries(phpRes.headers),
          ...SECURITY_HEADERS,
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",
        },
      });
    }
  }

  // 헤더에 보안 헤더 추가
  const resHeaders = new Headers(phpRes.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    resHeaders.set(k, v);
  }

  return new Response(phpRes.body, {
    status: phpRes.status,
    headers: resHeaders,
  });
}

// ─── 메인 fetch 핸들러 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // ── CORS 프리플라이트 ─────────────────────────────────────────────────
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── 유지보수 모드 체크 (설정 변경 중 접속 차단) ───────────────────────
    // /wp-admin/, /wp-json/cloudpress/ 는 예외 (관리자 접근 허용)
    if (await isMaintenanceMode(env)) {
      if (!path.startsWith("/wp-admin/") && !path.startsWith("/wp-json/cloudpress/")) {
        return maintenancePage();
      }
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
            ...SECURITY_HEADERS,
          },
        });
      }
    }

    // ── 정적 자산 서빙 ────────────────────────────────────────────────────
    if (STATIC_EXT.test(path)) {
      const filePath = path.replace(/^\//, "");

      // 1. 사용자 wp-content (GitHub 레포에서)
      if (path.startsWith("/wp-content/")) {
        // KV 캐시 먼저
        const cacheKey = `static:${filePath}`;
        const cached = await kvGet(env, cacheKey);
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
          ctx.waitUntil(
            env.CACHE?.put(cacheKey, body, { expirationTtl: 3600 }).catch(() => {})
          );
          return new Response(body, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
              "X-Source":      "github-user-repo",
            },
          });
        }
      }

      // 2. WordPress 코어 자산 (wp-includes/, wp-admin/ 정적 파일)
      if (path.startsWith("/wp-includes/") || path.startsWith("/wp-admin/")) {
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

      return new Response("Not Found", { status: 404 });
    }

    // ── PHP 파일 경로 결정 ────────────────────────────────────────────────
    let phpFile = "/index.php";

    if (path === "/wp-login.php") {
      phpFile = "/wp-login.php";
    } else if (path.startsWith("/wp-admin/")) {
      phpFile = path.endsWith(".php")
        ? path
        : "/wp-admin/index.php";
    } else if (path.endsWith(".php")) {
      phpFile = path;
    } else {
      // 퍼머링크 — index.php가 REQUEST_URI를 보고 라우팅
      phpFile = "/index.php";
    }

    // ── WordPress 실행 (PHP_RUNNER → cloudpress-php → php-wasm) ──────────
    return runWordPress(request, env, ctx, phpFile);
  },
};
