/**
 * CloudPress WordPress Worker v5.1
 *
 * 이 파일은 호스팅 생성 시 각 사이트 전용 Cloudflare Worker로 자동 배포됩니다.
 * sites.js의 createCfWorkerWithBindings() 함수가 이 파일을 읽어
 * SITE_ID / GITHUB_OWNER / GITHUB_REPO 플레이스홀더를 치환한 뒤 CF API로 업로드합니다.
 *
 * ── 아키텍처 ──────────────────────────────────────────────────────────────
 *  WordPress 코어 파일 (wp-*.php, wp-admin/, wp-includes/ 등)
 *    → WordPress/WordPress 공식 GitHub 레포 (raw.githubusercontent.com)
 *
 *  사용자 콘텐츠 (테마, 플러그인, 미디어 업로드, 기타 wp-content/)
 *    → 호스팅 생성 시 만들어진 개인 GitHub 레포 (GITHUB_OWNER/GITHUB_REPO)
 *
 * ── 바인딩 (sites.js에서 자동 연결) ────────────────────────────────────────
 *  DB          : D1 (WordPress SQLite DB)
 *  SITE_DB     : D1 (동일 DB, 별칭)
 *  CACHE       : KV (페이지 캐시)
 *  KV          : KV (설치 상태 플래그 등)
 *  SITE_ID     : plain_text
 *  GITHUB_OWNER: plain_text
 *  GITHUB_REPO : plain_text
 *  GITHUB_TOKEN: secret_text
 *  JWT_SECRET  : secret_text
 */

// ─── 플레이스홀더 (sites.js가 치환) ──────────────────────────────────────────
// 아래 세 값은 배포 전에 sites.js buildSiteWorkerScript()가 실제 값으로 교체합니다.
// 런타임에는 env.SITE_ID / env.GITHUB_OWNER / env.GITHUB_REPO 바인딩 값을 사용합니다.
const _INJECTED_SITE_ID      = "%%SITE_ID%%";
const _INJECTED_GITHUB_OWNER = "%%GITHUB_OWNER%%";
const _INJECTED_GITHUB_REPO  = "%%GITHUB_REPO%%";

// ─── WordPress 공식 코어 ───────────────────────────────────────────────────
const WP_CORE_OWNER  = "WordPress";
const WP_CORE_REPO   = "WordPress";
const WP_CORE_BRANCH = "master"; // 공식 WordPress/WordPress 최신 안정 브랜치

// ─── 정적 파일 확장자 패턴 ───────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip|pdf|mp4|mp3|ogg|wav|webm|avif)$/i;

// ─── CORS 헤더 ───────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With,X-WP-Nonce",
};

// ─── GitHub Raw URL 빌더 ─────────────────────────────────────────────────────

function ghRaw(owner, repo, branch, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/** WordPress/WordPress 공식 코어에서 파일 URL 반환 */
function wpCoreRawUrl(filePath) {
  return ghRaw(WP_CORE_OWNER, WP_CORE_REPO, WP_CORE_BRANCH, filePath);
}

/** 사용자 개인 레포에서 파일 URL 반환 (wp-content 이하 사용자 데이터) */
function userRepoRawUrl(env, filePath) {
  const owner = env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER;
  const repo  = env.GITHUB_REPO  || _INJECTED_GITHUB_REPO;
  if (!owner || !repo) return null;
  return ghRaw(owner, repo, "main", filePath);
}

// ─── GitHub API 헤더 ─────────────────────────────────────────────────────────

function ghApiHeaders(token) {
  const h = {
    "Accept":              "application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28",
    "User-Agent":          "CloudPress-Worker/5.1",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ─── KV 캐시 헬퍼 ────────────────────────────────────────────────────────────

async function kvGet(kv, key) {
  if (!kv) return null;
  try { return await kv.get(key); } catch { return null; }
}

async function kvSet(kv, key, value, ttlSeconds = 3600) {
  if (!kv) return;
  try { await kv.put(key, value, { expirationTtl: ttlSeconds }); } catch {}
}

// ─── 응답 헬퍼 ───────────────────────────────────────────────────────────────

function respond(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

function respondJson(data, status = 200) {
  return respond(JSON.stringify(data), status, { "Content-Type": "application/json" });
}

// ─── 준비 중 페이지 ──────────────────────────────────────────────────────────

function buildSetupPage(message = "WordPress 초기화 중...") {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>CloudPress — WordPress 준비 중</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
    min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);
    border-radius:24px;padding:48px 40px;max-width:420px;width:92%;text-align:center}
  .logo{width:72px;height:72px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);
    border-radius:20px;margin:0 auto 24px;display:flex;align-items:center;
    justify-content:center;font-size:36px}
  h1{color:#fff;font-size:20px;font-weight:800;margin-bottom:10px}
  p{color:rgba(255,255,255,.5);font-size:13px;line-height:1.6;margin-bottom:24px}
  .bar-wrap{background:rgba(255,255,255,.1);border-radius:100px;height:6px;overflow:hidden}
  .bar{height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:100px;
    animation:slide 2s ease-in-out infinite}
  @keyframes slide{0%{width:10%;margin-left:0}50%{width:55%;margin-left:20%}100%{width:10%;margin-left:85%}}
  small{display:block;margin-top:14px;color:rgba(255,255,255,.22);font-size:11px}
</style>
</head>
<body>
  <div class="card">
    <div class="logo">☁️</div>
    <h1>WordPress 준비 중</h1>
    <p>${message}</p>
    <div class="bar-wrap"><div class="bar"></div></div>
    <small>CloudPress v5.1 · WordPress/WordPress 공식 코어 · 5초 후 자동 새로고침</small>
  </div>
</body>
</html>`;
}

// ─── wp-config.php 생성 ───────────────────────────────────────────────────────

function buildWpConfig(env, siteUrl) {
  const siteId     = env.SITE_ID     || _INJECTED_SITE_ID;
  const ghOwner    = env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER;
  const ghRepo     = env.GITHUB_REPO  || _INJECTED_GITHUB_REPO;
  const ghToken    = env.GITHUB_TOKEN || "";
  const uid        = () => crypto.randomUUID().replace(/-/g, "");

  return `<?php
/**
 * WordPress Configuration - CloudPress v5.1
 * Core: WordPress/WordPress (github.com/WordPress/WordPress)
 * User data: ${ghOwner}/${ghRepo}
 */

// Database (SQLite via D1 / db.php drop-in)
define( 'DB_NAME',     'cloudpress' );
define( 'DB_USER',     'cloudpress' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST',     'localhost' );
define( 'DB_CHARSET',  'utf8mb4' );
define( 'DB_COLLATE',  '' );

// Security keys & salts
define( 'AUTH_KEY',         '${uid()}' );
define( 'SECURE_AUTH_KEY',  '${uid()}' );
define( 'LOGGED_IN_KEY',    '${uid()}' );
define( 'NONCE_KEY',        '${uid()}' );
define( 'AUTH_SALT',        '${uid()}' );
define( 'SECURE_AUTH_SALT', '${uid()}' );
define( 'LOGGED_IN_SALT',   '${uid()}' );
define( 'NONCE_SALT',       '${uid()}' );

$table_prefix = 'wp_';

// Site URLs
define( 'WP_HOME',    '${siteUrl}' );
define( 'WP_SITEURL', '${siteUrl}' );

// CloudPress environment
define( 'CLOUDPRESS_SITE_ID',       '${siteId}' );
define( 'CLOUDPRESS_GITHUB_OWNER',  '${ghOwner}' );
define( 'CLOUDPRESS_GITHUB_REPO',   '${ghRepo}' );
define( 'CLOUDPRESS_GITHUB_TOKEN',  '${ghToken}' );
define( 'CLOUDPRESS_WP_CORE_OWNER', '${WP_CORE_OWNER}' );
define( 'CLOUDPRESS_WP_CORE_REPO',  '${WP_CORE_REPO}' );

// Paths
define( 'WP_CONTENT_DIR', '/var/task/wp-content' );
define( 'WP_CONTENT_URL', '${siteUrl}/wp-content' );

// SQLite D1 경로
define( 'SQLITE_DB_REALPATH', '/tmp/cloudpress_${siteId.replace(/-/g, "_")}.db' );

// Performance & Security
define( 'WP_DEBUG',                   false );
define( 'DISALLOW_FILE_EDIT',         true );
define( 'DISALLOW_FILE_MODS',         false );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_POST_REVISIONS',          5 );
define( 'EMPTY_TRASH_DAYS',           7 );

if ( ! defined( 'ABSPATH' ) ) {
  define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── PHP 환경 변수 ────────────────────────────────────────────────────────────

function buildPhpEnv(request, env, url, siteUrl) {
  const ghOwner = env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER;
  const ghRepo  = env.GITHUB_REPO  || _INJECTED_GITHUB_REPO;

  return {
    WP_HOME:              siteUrl,
    WP_SITEURL:           siteUrl,
    GITHUB_OWNER:         ghOwner,
    GITHUB_REPO:          ghRepo,
    GITHUB_TOKEN:         env.GITHUB_TOKEN || "",
    WP_CORE_OWNER:        WP_CORE_OWNER,
    WP_CORE_REPO:         WP_CORE_REPO,
    REQUEST_URI:          url.pathname + url.search,
    REQUEST_METHOD:       request.method,
    HTTP_HOST:            url.host,
    SERVER_NAME:          url.host,
    SERVER_PORT:          url.protocol === "https:" ? "443" : "80",
    HTTPS:                url.protocol === "https:" ? "on" : "off",
    CONTENT_TYPE:         request.headers.get("Content-Type")      || "",
    HTTP_COOKIE:          request.headers.get("Cookie")            || "",
    HTTP_AUTHORIZATION:   request.headers.get("Authorization")     || "",
    HTTP_ACCEPT:          request.headers.get("Accept")            || "",
    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language")   || "ko",
    HTTP_USER_AGENT:      request.headers.get("User-Agent")        || "",
    HTTP_REFERER:         request.headers.get("Referer")           || "",
    SCRIPT_FILENAME:      url.pathname,
    PHP_SELF:             url.pathname,
    REMOTE_ADDR:          request.headers.get("CF-Connecting-IP")  || "127.0.0.1",
    HTTP_CF_IPCOUNTRY:    request.headers.get("CF-IPCountry")      || "",
  };
}

// ─── WordPress 설치 여부 확인 ─────────────────────────────────────────────────

async function isWpInstalled(db, kv) {
  const flag = await kvGet(kv, "wp:installed");
  if (flag === "1") return true;
  if (!db) return false;
  try {
    const r = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wp_options' LIMIT 1")
      .all();
    if (r.results?.length > 0) {
      await kvSet(kv, "wp:installed", "1", 86400);
      return true;
    }
  } catch {}
  return false;
}

// ─── WordPress 코어에서 파일 가져오기 (KV 캐시 적용) ──────────────────────────

async function fetchWpCoreFile(filePath, kv) {
  const cacheKey = `wpc:${filePath}`;
  const cached = await kvGet(kv, cacheKey);
  if (cached !== null) return cached;

  const url = wpCoreRawUrl(filePath);
  const res = await fetch(url, {
    headers: { "User-Agent": "CloudPress-Worker/5.1" },
    cf:      { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!res.ok) return null;

  const text = await res.text();
  const ttl  = filePath.endsWith(".php") ? 3600 : 86400;
  await kvSet(kv, cacheKey, text, ttl);
  return text;
}

// ─── 공식 코어에서 정적 파일 서빙 ────────────────────────────────────────────

async function serveFromWpCore(filePath) {
  const url = wpCoreRawUrl(filePath);
  const res = await fetch(url, {
    headers: { "User-Agent": "CloudPress-Worker/5.1" },
    cf:      { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!res.ok) return null;

  const ct   = res.headers.get("Content-Type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type":  ct,
      "Cache-Control": "public, max-age=86400",
      "X-Source":      "WordPress/WordPress",
    },
  });
}

// ─── 사용자 개인 레포에서 콘텐츠 서빙 ───────────────────────────────────────
// wp-content/themes/, wp-content/plugins/, wp-content/uploads/ 등
// 코어 파일을 제외한 모든 사용자 데이터를 개인 레포에서 가져옵니다.

async function serveFromUserRepo(env, filePath) {
  const rawUrl = userRepoRawUrl(env, filePath);
  if (!rawUrl) return null;

  const res = await fetch(rawUrl, {
    headers: ghApiHeaders(env.GITHUB_TOKEN || null),
    cf:      { cacheEverything: true, cacheTtl: 3600 },
  });
  if (!res.ok) return null;

  const ct   = res.headers.get("Content-Type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type":  ct,
      "Cache-Control": "public, max-age=3600",
      "X-Source":      "user-repo",
    },
  });
}

// ─── PHP 실행 (php-wasm Service Binding) ─────────────────────────────────────

async function runPhp(phpCode, env, phpEnv, extraFiles = {}) {
  if (!env.PHP_RUNNER) {
    return new Response(
      buildSetupPage("PHP 실행 환경을 구성 중입니다. (PHP_RUNNER 바인딩 필요)"),
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  return env.PHP_RUNNER.fetch(
    new Request("https://php-runner/run", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code: phpCode, env: phpEnv, files: extraFiles }),
    })
  );
}

// ─── 메인 fetch 핸들러 ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS 프리플라이트
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 헬스체크
    if (url.pathname === "/api/health" || url.pathname === "/_health") {
      const siteId  = env.SITE_ID     || _INJECTED_SITE_ID;
      const ghOwner = env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER;
      const ghRepo  = env.GITHUB_REPO  || _INJECTED_GITHUB_REPO;
      return respondJson({
        status:   "ok",
        version:  "5.1.0",
        core:     `${WP_CORE_OWNER}/${WP_CORE_REPO}@${WP_CORE_BRANCH}`,
        userRepo: `${ghOwner}/${ghRepo}`,
        siteId,
        ts:       new Date().toISOString(),
      });
    }

    const siteUrl   = `${url.protocol}//${url.host}`;
    const hasGithub = !!(env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER) &&
                      !!(env.GITHUB_REPO  || _INJECTED_GITHUB_REPO);

    // ── wp-content/ → 사용자 개인 레포 ────────────────────────────────────
    // 테마, 플러그인, 미디어 업로드, 기타 사용자 파일은 전부 개인 레포에서 서빙
    if (url.pathname.startsWith("/wp-content/")) {
      const repoPath = url.pathname.slice(1); // 앞의 / 제거

      if (hasGithub) {
        const res = await serveFromUserRepo(env, repoPath);
        if (res) return res;
      }

      // 폴백: 공식 코어에서 기본 테마 등 번들 파일 시도
      if (STATIC_EXT.test(url.pathname)) {
        const res = await serveFromWpCore(repoPath);
        if (res) return res;
      }

      return respond("Not Found", 404);
    }

    // ── uploads/ (구 경로 호환) → 사용자 개인 레포 ────────────────────────
    if (url.pathname.startsWith("/uploads/")) {
      const repoPath = url.pathname.slice(1);
      if (hasGithub) {
        const res = await serveFromUserRepo(env, repoPath);
        if (res) return res;
      }
      return respond("Not Found", 404);
    }

    // ── 공식 코어 정적 자산 (wp-includes/, wp-admin/css|js|images 등) ──────
    if (STATIC_EXT.test(url.pathname)) {
      const corePath = url.pathname.replace(/^\//, "");
      const res = await serveFromWpCore(corePath);
      if (res) return res;
      return respond("Not Found", 404);
    }

    // ── GitHub 레포 미설정 시 안내 페이지 ─────────────────────────────────
    if (!hasGithub) {
      return new Response(
        buildSetupPage("GitHub 저장소가 설정되지 않았습니다. CloudPress 대시보드에서 GitHub 연동을 확인해주세요."),
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // ── WordPress 설치 여부 확인 ───────────────────────────────────────────
    const installed = await isWpInstalled(env.DB || env.SITE_DB, env.CACHE || env.KV);
    if (!installed) {
      return new Response(
        buildSetupPage("WordPress 데이터베이스를 초기화하고 있습니다..."),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // ── PHP 파일 경로 결정 (공식 코어에서 가져옴) ──────────────────────────
    let phpPath = url.pathname;
    if (!phpPath || phpPath === "/") phpPath = "/index.php";
    if (!phpPath.endsWith(".php"))   phpPath = phpPath.replace(/\/+$/, "") + "/index.php";

    const corePath = phpPath.replace(/^\//, "");
    const phpEnv   = buildPhpEnv(request, env, url, siteUrl);
    const wpConf   = buildWpConfig(env, siteUrl);

    // 공식 WordPress/WordPress 코어에서 PHP 파일 취득
    let phpCode = await fetchWpCoreFile(corePath, env.CACHE || env.KV);
    if (!phpCode) {
      // 파일 없으면 WordPress 라우터(index.php)로 처리
      phpCode = await fetchWpCoreFile("index.php", env.CACHE || env.KV);
      if (!phpCode) {
        return new Response(
          buildSetupPage("WordPress 코어 파일을 가져오는 중입니다. 잠시 후 새로고침해주세요."),
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // ── GET 페이지 캐시 (wp-admin, wp-login 제외) ──────────────────────────
    const isAdmin = url.pathname.startsWith("/wp-admin") ||
                    url.pathname === "/wp-login.php"     ||
                    url.pathname === "/wp-cron.php";

    if (method === "GET" && !isAdmin && (env.CACHE || env.KV)) {
      const kvStore  = env.CACHE || env.KV;
      const cacheKey = `page:${url.pathname}${url.search}`;
      const cached   = await kvGet(kvStore, cacheKey);

      if (cached) {
        return new Response(cached, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/html; charset=utf-8",
            "X-Cache":      "HIT",
            "Cache-Control":"public, max-age=60",
          },
        });
      }

      const resp = await runPhp(phpCode, env, phpEnv, { "/wordpress/wp-config.php": wpConf });

      if (resp.status === 200) {
        const ct = resp.headers.get("Content-Type") || "";
        if (ct.includes("text/html")) {
          const html = await resp.clone().text();
          if (!html.includes("logged-in") && !html.includes("is-logged-in")) {
            await kvSet(kvStore, cacheKey, html, 300);
          }
        }
      }
      return resp;
    }

    // ── PHP 실행 ───────────────────────────────────────────────────────────
    return runPhp(phpCode, env, phpEnv, { "/wordpress/wp-config.php": wpConf });
  },
};
