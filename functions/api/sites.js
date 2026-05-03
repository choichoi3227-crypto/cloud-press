// functions/api/sites.js
// POST   → 호스팅 생성 (CF API로 Worker/D1/KV 자동 생성 + 바인딩 + GitHub repo)
// GET    → 사이트 목록 / 상세
// PUT    → 설정 변경
// DELETE → 사이트 삭제

import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";
import {
  pickGithubToken,
  createGithubRepo,
  uploadFileToGithub,
  getRepoName,
  ghReq,
  uploadWordPressFilesBackground,
} from "./github-storage.js";

// ── Cloudflare API 헬퍼 ────────────────────────────────────────────────────

class CfApi {
  constructor(apiKey, email, accountId) {
    this.apiKey    = apiKey;
    this.email     = email;
    this.accountId = accountId;
    this.base      = "https://api.cloudflare.com/client/v4";
  }
  async req(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "X-Auth-Key":   this.apiKey,
        "X-Auth-Email": this.email,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }
  get(path)        { return this.req("GET",    path); }
  post(path, body) { return this.req("POST",   path, body); }
  put(path, body)  { return this.req("PUT",    path, body); }
  del(path)        { return this.req("DELETE", path); }
}

// ── CF 계정 ID 조회 ────────────────────────────────────────────────────────

async function getCfAccountId(cf) {
  const r = await cf.get("/accounts?per_page=1");
  return r.result?.[0]?.id || null;
}

// ── CF Worker 생성 + D1/KV 바인딩 포함 ────────────────────────────────────
//
// worker.js의 실제 코드를 업로드하고, D1/KV를 바인딩에 연결합니다.
// 변수로 치환할 부분: GITHUB_OWNER, GITHUB_REPO, SITE_ID
//
async function createCfWorkerWithBindings({
  cf,
  accountId,
  workerName,
  siteId,
  githubOwner,
  githubRepo,
  d1Id,
  kvId,
  jwtSecret,
  githubToken,
}) {
  // ── 실제 worker.js 코드 (worker.js와 동일한 로직, 사이트 변수만 주입) ──
  // CloudPress 플랫폼의 worker.js를 기반으로 각 사이트의 환경변수를 하드코딩
  const workerScript = buildSiteWorkerScript({
    siteId,
    githubOwner: githubOwner || "",
    githubRepo:  githubRepo  || "",
  });

  // 바인딩 설정
  const bindings = [];

  if (d1Id) {
    bindings.push({
      type:          "d1",
      name:          "DB",
      database_id:   d1Id,
    });
    // WordPress 캐시용 KV도 DB로 연결
    bindings.push({
      type:     "d1",
      name:     "SITE_DB",
      database_id: d1Id,
    });
  }

  if (kvId) {
    bindings.push({ type: "kv_namespace", name: "CACHE",  namespace_id: kvId });
    bindings.push({ type: "kv_namespace", name: "KV",     namespace_id: kvId });
  }

  // 환경변수 (plain_text secrets)
  const plainTextBindings = [
    { type: "plain_text", name: "SITE_ID",       text: siteId },
    { type: "plain_text", name: "GITHUB_OWNER",  text: githubOwner || "" },
    { type: "plain_text", name: "GITHUB_REPO",   text: githubRepo  || "" },
  ];

  // secret_text (민감 정보)
  const secretBindings = [];
  if (githubToken) {
    secretBindings.push({ type: "secret_text", name: "GITHUB_TOKEN", text: githubToken });
  }
  if (jwtSecret) {
    secretBindings.push({ type: "secret_text", name: "JWT_SECRET", text: jwtSecret });
  }

  const allBindings = [...bindings, ...plainTextBindings, ...secretBindings];

  const formData = new FormData();
  // metadata는 반드시 Blob(application/json)으로 감싸야 CF API가 인식함
  formData.append(
    "metadata",
    new Blob(
      [JSON.stringify({
        main_module:        "worker.js",
        compatibility_date: "2024-09-23",
        bindings:           allBindings,
      })],
      { type: "application/json" }
    ),
    "metadata.json"
  );
  formData.append(
    "worker.js",
    new Blob([workerScript], { type: "application/javascript+module" }),
    "worker.js"
  );

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method:  "PUT",
      headers: {
        "X-Auth-Key":   cf.apiKey,
        "X-Auth-Email": cf.email,
        // Content-Type은 FormData가 자동으로 multipart/form-data; boundary=... 설정
      },
      body: formData,
    }
  );
  const data = await res.json();
  if (!data.success) {
    console.error("[worker] CF API 오류:", JSON.stringify(data.errors || data));
  }
  return data.success === true;
}

// ── 사이트 Worker 스크립트 생성 ─────────────────────────────────────────────
// WordPress/WordPress 공식 GitHub 레포에서 직접 PHP 파일을 서빙합니다.
// 사용자 레포는 wp-content(uploads, themes, plugins)만 저장합니다.

function buildSiteWorkerScript({ siteId, githubOwner, githubRepo }) {
  return `/**
 * CloudPress WordPress Worker v5.0
 * Core: WordPress/WordPress (github.com/WordPress/WordPress) - 100% Official
 * User Data: ${githubOwner}/${githubRepo} (uploads, themes, plugins only)
 * Site: ${siteId}
 */

// ─── Constants ────────────────────────────────────────────────────────────
const WP_CORE_OWNER  = "WordPress";
const WP_CORE_REPO   = "WordPress";
const WP_CORE_BRANCH = "master"; // 공식 WordPress/WordPress 최신 안정 브랜치

// ─── GitHub Raw CDN ────────────────────────────────────────────────────────
function ghRaw(owner, repo, branch, path) {
  return \`https://raw.githubusercontent.com/\${owner}/\${repo}/\${branch}/\${path}\`;
}

function wpCoreRaw(path) {
  return ghRaw(WP_CORE_OWNER, WP_CORE_REPO, WP_CORE_BRANCH, path);
}

function userRepoRaw(env, path) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return null;
  return ghRaw(env.GITHUB_OWNER, env.GITHUB_REPO, "main", path);
}

// ─── GitHub API helper ─────────────────────────────────────────────────────
function ghApiHeaders(token) {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "CloudPress-Worker/5.0",
  };
  if (token) h.Authorization = \`Bearer \${token}\`;
  return h;
}

// ─── KV Cache helpers ──────────────────────────────────────────────────────
async function kvGet(kv, key) {
  if (!kv) return null;
  try { return await kv.get(key); } catch { return null; }
}
async function kvSet(kv, key, val, ttl = 3600) {
  if (!kv) return;
  try { await kv.put(key, val, { expirationTtl: ttl }); } catch {}
}

// ─── Static file extensions ────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip)$/i;

// ─── CORS headers ──────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
};

function ok(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...headers, ...CORS } });
}

// ─── Setup / loading page (shown while provisioning) ──────────────────────
function setupPage(msg = "WordPress 초기화 중...") {
  return \`<!DOCTYPE html>
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
    <p>\${msg}</p>
    <div class="bar-wrap"><div class="bar"></div></div>
    <small>CloudPress v5.0 · WordPress/WordPress 공식 코어 · 5초 후 자동 새로고침</small>
  </div>
</body>
</html>\`;
}

// ─── wp-config.php generator ───────────────────────────────────────────────
function buildWpConfig(env, siteUrl) {
  const uid = () => crypto.randomUUID().replace(/-/g, "");
  // SQLite Integration (db.php drop-in) 사용을 위한 설정
  return \`<?php
/**
 * WordPress Configuration - CloudPress v5.0
 * Core from WordPress/WordPress (github.com/WordPress/WordPress)
 */
// Database - SQLite via D1 (wp-content/db.php drop-in)
define( 'DB_NAME',     'cloudpress' );
define( 'DB_USER',     'cloudpress' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST',     'localhost' );
define( 'DB_CHARSET',  'utf8mb4' );
define( 'DB_COLLATE',  '' );

// Security keys & salts
define( 'AUTH_KEY',         '\${uid()}' );
define( 'SECURE_AUTH_KEY',  '\${uid()}' );
define( 'LOGGED_IN_KEY',    '\${uid()}' );
define( 'NONCE_KEY',        '\${uid()}' );
define( 'AUTH_SALT',        '\${uid()}' );
define( 'SECURE_AUTH_SALT', '\${uid()}' );
define( 'LOGGED_IN_SALT',   '\${uid()}' );
define( 'NONCE_SALT',       '\${uid()}' );

\\\$table_prefix = 'wp_';

// Site URLs
define( 'WP_HOME',    '\${siteUrl}' );
define( 'WP_SITEURL', '\${siteUrl}' );

// CloudPress environment
define( 'CLOUDPRESS_SITE_ID',       '\${siteId}' );
define( 'CLOUDPRESS_GITHUB_OWNER',  '\${env.GITHUB_OWNER || ""}' );
define( 'CLOUDPRESS_GITHUB_REPO',   '\${env.GITHUB_REPO  || ""}' );
define( 'CLOUDPRESS_GITHUB_TOKEN',  '\${env.GITHUB_TOKEN || ""}' );

// Paths
define( 'WP_CONTENT_DIR', '/var/task/wp-content' );
define( 'WP_CONTENT_URL', '\${siteUrl}/wp-content' );

// Performance & Security
define( 'WP_DEBUG',                   false );
define( 'DISALLOW_FILE_EDIT',         true );
define( 'DISALLOW_FILE_MODS',         false ); // 플러그인/테마 설치 허용
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_POST_REVISIONS',          5 );
define( 'EMPTY_TRASH_DAYS',           7 );

// D1/SQLite 경로
define( 'SQLITE_DB_REALPATH', '/tmp/cloudpress_\${siteId.replace(/-/g,"_")}.db' );

if ( ! defined( 'ABSPATH' ) ) {
  define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
\`;
}

// ─── PHP env for php-wasm runner ──────────────────────────────────────────
function buildPhpEnv(request, env, url, siteUrl) {
  return {
    WP_HOME:             siteUrl,
    WP_SITEURL:          siteUrl,
    GITHUB_OWNER:        env.GITHUB_OWNER || "",
    GITHUB_REPO:         env.GITHUB_REPO  || "",
    GITHUB_TOKEN:        env.GITHUB_TOKEN || "",
    WP_CORE_OWNER:       WP_CORE_OWNER,
    WP_CORE_REPO:        WP_CORE_REPO,
    REQUEST_URI:         url.pathname + url.search,
    REQUEST_METHOD:      request.method,
    HTTP_HOST:           url.host,
    SERVER_NAME:         url.host,
    SERVER_PORT:         url.protocol === "https:" ? "443" : "80",
    HTTPS:               url.protocol === "https:" ? "on" : "off",
    CONTENT_TYPE:        request.headers.get("Content-Type") || "",
    HTTP_COOKIE:         request.headers.get("Cookie") || "",
    HTTP_AUTHORIZATION:  request.headers.get("Authorization") || "",
    HTTP_ACCEPT:         request.headers.get("Accept") || "",
    HTTP_ACCEPT_LANGUAGE:request.headers.get("Accept-Language") || "",
    HTTP_USER_AGENT:     request.headers.get("User-Agent") || "",
    HTTP_REFERER:        request.headers.get("Referer") || "",
    SCRIPT_FILENAME:     url.pathname,
    PHP_SELF:            url.pathname,
    REMOTE_ADDR:         request.headers.get("CF-Connecting-IP") || "127.0.0.1",
    HTTP_CF_IPCOUNTRY:   request.headers.get("CF-IPCountry") || "",
  };
}

// ─── Fetch a file from WordPress/WordPress core (official repo) ────────────
async function fetchWpCore(path, cache) {
  const cacheKey = \`wpc:\${path}\`;
  const cached = await kvGet(cache, cacheKey);
  if (cached !== null) return cached;

  const url = wpCoreRaw(path);
  const res = await fetch(url, {
    headers: { "User-Agent": "CloudPress-Worker/5.0" },
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!res.ok) return null;

  const text = await res.text();
  // PHP files cached for 1 hour, static for 24 hours
  const ttl = path.endsWith(".php") ? 3600 : 86400;
  await kvSet(cache, cacheKey, text, ttl);
  return text;
}

// ─── Serve static files from official WP core ─────────────────────────────
async function serveStaticFromCore(path, env) {
  const rawUrl = wpCoreRaw(path);
  const res = await fetch(rawUrl, {
    headers: { "User-Agent": "CloudPress-Worker/5.0" },
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!res.ok) return null;

  // Preserve content-type from GitHub raw
  const ct = res.headers.get("Content-Type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=86400",
      "X-Source": "WordPress/WordPress",
    },
  });
}

// ─── Serve from user repo (wp-content) ────────────────────────────────────
async function serveFromUserRepo(env, repoPath) {
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return null;
  const rawUrl = userRepoRaw(env, repoPath);
  if (!rawUrl) return null;

  const headers = ghApiHeaders(env.GITHUB_TOKEN || null);
  const res = await fetch(rawUrl, {
    headers,
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  if (!res.ok) return null;

  const ct = res.headers.get("Content-Type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=3600",
      "X-Source": "user-repo",
    },
  });
}

// ─── Check WordPress is installed (D1 has wp_options) ─────────────────────
async function isWpInstalled(db, kv) {
  const cached = await kvGet(kv, "wp:installed");
  if (cached === "1") return true;
  if (!db) return false;
  try {
    const r = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wp_options' LIMIT 1"
    ).all();
    if (r.results?.length > 0) {
      await kvSet(kv, "wp:installed", "1", 86400);
      return true;
    }
  } catch {}
  return false;
}

// ─── Run PHP via php-wasm Service Binding ─────────────────────────────────
async function runPhp(phpCode, env, phpEnv, extraFiles = {}) {
  if (!env.PHP_RUNNER) {
    return new Response(
      "<?php echo 'PHP_RUNNER 서비스 바인딩이 필요합니다.'; ?>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  return env.PHP_RUNNER.fetch(
    new Request("https://php-runner/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code:  phpCode,
        env:   phpEnv,
        files: extraFiles,
      }),
    })
  );
}

// ─── Main fetch handler ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health check
    if (url.pathname === "/api/health") {
      return ok(JSON.stringify({
        status:  "ok",
        version: "5.0.0",
        core:    "WordPress/WordPress (official)",
        site:    env.SITE_ID || "${siteId}",
        ts:      new Date().toISOString(),
      }), 200, { "Content-Type": "application/json" });
    }

    const siteUrl  = \`\${url.protocol}//\${url.host}\`;
    const wpConf   = buildWpConfig(env, siteUrl);
    const phpEnv   = buildPhpEnv(request, env, url, siteUrl);
    const hasGithub = !!(env.GITHUB_OWNER && env.GITHUB_REPO);

    // ── Static assets from wp-content (user repo) ──────────────────────────
    if (url.pathname.startsWith("/wp-content/uploads/") ||
        url.pathname.startsWith("/wp-content/themes/")  ||
        url.pathname.startsWith("/wp-content/plugins/")) {
      if (hasGithub) {
        const repoPath = url.pathname.slice(1); // remove leading /
        const res = await serveFromUserRepo(env, repoPath);
        if (res) return res;
      }
      // Fallback: try WP core (for bundled default themes)
      if (STATIC_EXT.test(url.pathname)) {
        const corePath = url.pathname.slice(1);
        const res = await serveStaticFromCore(corePath, env);
        if (res) return res;
      }
      return new Response("Not Found", { status: 404, headers: CORS });
    }

    // ── Static assets from WP core (css, js, images etc.) ─────────────────
    if (STATIC_EXT.test(url.pathname)) {
      const corePath = url.pathname.replace(/^\//, "");
      const res = await serveStaticFromCore(corePath, env);
      if (res) return res;
      return new Response("Not Found", { status: 404, headers: CORS });
    }

    // ── Check GitHub is configured ─────────────────────────────────────────
    if (!hasGithub) {
      return new Response(
        setupPage("GitHub 저장소가 설정되지 않았습니다. CloudPress 대시보드에서 GitHub 연동을 확인해주세요."),
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // ── Check WordPress installed ──────────────────────────────────────────
    const installed = await isWpInstalled(env.DB, env.CACHE);
    if (!installed) {
      return new Response(
        setupPage("WordPress 데이터베이스를 초기화하고 있습니다..."),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // ── Resolve PHP file from official WordPress/WordPress ─────────────────
    let phpPath = url.pathname;
    if (!phpPath || phpPath === "/") phpPath = "/index.php";
    // Ensure .php extension
    if (!phpPath.endsWith(".php")) {
      // Try as directory index
      phpPath = phpPath.replace(/\\/+$/, "") + "/index.php";
    }

    // Strip leading slash for GitHub raw path
    const corePath = phpPath.replace(/^\\//, "");

    // Fetch from official WordPress/WordPress repo
    const phpCode = await fetchWpCore(corePath, env.CACHE);
    if (!phpCode) {
      // File not found in core — try index.php (WordPress routing)
      const indexCode = await fetchWpCore("index.php", env.CACHE);
      if (!indexCode) {
        return new Response(
          setupPage("WordPress 코어 파일을 가져오는 중입니다. 잠시 후 새로고침해주세요."),
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return runPhp(indexCode, env, phpEnv, {
        "/wordpress/wp-config.php": wpConf,
      });
    }

    // Page cache for GET requests (non-admin, non-login)
    const isAdminOrLogin = url.pathname.startsWith("/wp-admin") ||
                           url.pathname === "/wp-login.php" ||
                           url.pathname === "/wp-cron.php";

    if (request.method === "GET" && !isAdminOrLogin && env.CACHE) {
      const cacheKey = \`page:\${url.pathname}\${url.search}\`;
      const cached = await kvGet(env.CACHE, cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Cache": "HIT",
            "Cache-Control": "public, max-age=60",
          },
        });
      }

      const resp = await runPhp(phpCode, env, phpEnv, {
        "/wordpress/wp-config.php": wpConf,
      });

      if (resp.status === 200) {
        const ct = resp.headers.get("Content-Type") || "";
        if (ct.includes("text/html")) {
          const html = await resp.clone().text();
          // Don't cache logged-in pages
          if (!html.includes("logged-in") && !html.includes("is-logged-in")) {
            await kvSet(env.CACHE, cacheKey, html, 300);
          }
        }
      }
      return resp;
    }

    return runPhp(phpCode, env, phpEnv, {
      "/wordpress/wp-config.php": wpConf,
    });
  },
};
`;
}

// ── CF D1 DB 생성 ──────────────────────────────────────────────────────────

async function createCfD1(cf, accountId, dbName) {
  const r = await cf.post(`/accounts/${accountId}/d1/database`, { name: dbName });
  if (r.success) return { id: r.result.uuid, name: r.result.name };
  // 이미 존재하면 목록에서 찾기
  const list = await cf.get(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const existing = list.result?.find(d => d.name === dbName);
  if (existing) return { id: existing.uuid, name: existing.name };
  return null;
}

// ── CF KV 네임스페이스 생성 ────────────────────────────────────────────────

async function createCfKV(cf, accountId, kvName) {
  const r = await cf.post(`/accounts/${accountId}/storage/kv/namespaces`, { title: kvName });
  if (r.success) return { id: r.result.id, name: kvName };
  const list = await cf.get(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = list.result?.find(k => k.title === kvName);
  if (existing) return { id: existing.id, name: existing.title };
  return null;
}

// ── Workers.dev 서브도메인 활성화 ─────────────────────────────────────────

async function enableWorkersDevSubdomain(cf, accountId, workerName) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          "X-Auth-Key":   cf.apiKey,
          "X-Auth-Email": cf.email,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }
    );
    const data = await res.json();
    return data.success;
  } catch (e) {
    console.warn("[workers.dev] subdomain 활성화 실패:", e.message);
    return false;
  }
}

// ── GitHub repo 프로비저닝 ─────────────────────────────────────────────────

async function provisionGithubRepo(env, siteId, siteName) {
  const token = await pickGithubToken(env);
  if (!token) {
    console.warn("[github] 사용 가능한 GitHub 토큰 없음");
    return null;
  }

  const repoName = getRepoName(siteId);
  const result   = await createGithubRepo(token, repoName, `CloudPress: ${siteName}`);

  if (result.error) {
    console.warn("[github] repo 생성 실패:", result.error);
    return null;
  }

  const owner = result.owner;

  // ── 기본 디렉터리 구조 + GitHub Actions 워크플로우 초기화 ────────────────

  // 파일 관리자 GitHub Actions workflow
  // push 이벤트 및 수동 트리거(workflow_dispatch)로 실행
  const fileManagerWorkflow = `name: CloudPress File Manager Sync

on:
  push:
    branches: [ main ]
    paths:
      - 'wp-content/**'
      - 'uploads/**'
  workflow_dispatch:
    inputs:
      action:
        description: '실행할 작업 (sync, cleanup, validate)'
        required: false
        default: 'sync'
        type: choice
        options:
          - sync
          - cleanup
          - validate

jobs:
  sync:
    runs-on: ubuntu-latest
    name: WordPress 파일 동기화
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: List changed files
        id: changed
        run: |
          git diff --name-only HEAD~1 HEAD || echo "Initial commit"
          echo "changed_files=$(git diff --name-only HEAD~1 HEAD | tr '\n' ',')" >> $GITHUB_OUTPUT

      - name: Validate WordPress file structure
        run: |
          echo "📁 저장소 구조 검증 중..."
          # wp-content 구조 확인
          for dir in wp-content/themes wp-content/plugins uploads; do
            if [ ! -d "\$dir" ]; then
              mkdir -p "\$dir"
              echo "Created: \$dir"
            fi
          done
          echo "✅ 구조 검증 완료"

      - name: Check file sizes
        run: |
          echo "📊 파일 크기 확인..."
          find . -type f -size +50M 2>/dev/null | while read f; do
            echo "⚠️ 대용량 파일: \$f (GitHub 100MB 제한 주의)"
          done
          TOTAL=$(du -sh . 2>/dev/null | cut -f1)
          echo "총 저장소 크기: \$TOTAL"

      - name: Notify CloudPress (webhook)
        if: always()
        env:
          CLOUDPRESS_WEBHOOK: \${{ secrets.CLOUDPRESS_WEBHOOK_URL }}
          SITE_ID: ${siteId}
        run: |
          if [ -n "\$CLOUDPRESS_WEBHOOK" ]; then
            curl -s -X POST "\$CLOUDPRESS_WEBHOOK" \
              -H "Content-Type: application/json" \
              -d "{\"site_id\":\"${siteId}\",\"event\":\"file_sync\",\"ref\":\"\$GITHUB_REF\",\"actor\":\"\$GITHUB_ACTOR\"}" || true
          fi

  validate-theme:
    runs-on: ubuntu-latest
    name: 테마 검증
    if: contains(github.event.head_commit.modified, 'wp-content/themes/')
    steps:
      - uses: actions/checkout@v4
      - name: Validate theme files
        run: |
          echo "🎨 테마 파일 검증..."
          for theme_dir in wp-content/themes/*/; do
            if [ -d "\$theme_dir" ]; then
              theme_name=$(basename "\$theme_dir")
              if [ ! -f "\$theme_dir/style.css" ]; then
                echo "⚠️ \$theme_name: style.css 없음"
              else
                echo "✅ \$theme_name: 유효한 테마"
              fi
            fi
          done

  validate-plugin:
    runs-on: ubuntu-latest
    name: 플러그인 검증
    if: contains(github.event.head_commit.modified, 'wp-content/plugins/')
    steps:
      - uses: actions/checkout@v4
      - name: Validate plugin files
        run: |
          echo "🔌 플러그인 파일 검증..."
          for plugin_dir in wp-content/plugins/*/; do
            if [ -d "\$plugin_dir" ]; then
              plugin_name=$(basename "\$plugin_dir")
              main_php=$(find "\$plugin_dir" -maxdepth 1 -name "*.php" | head -1)
              if [ -z "\$main_php" ]; then
                echo "⚠️ \$plugin_name: 메인 PHP 파일 없음"
              else
                echo "✅ \$plugin_name: \$main_php"
              fi
            fi
          done
`;

  const initFiles = [
    { path: "wp-content/themes/.gitkeep",  content: "" },
    { path: "wp-content/plugins/.gitkeep", content: "" },
    { path: "uploads/.gitkeep",            content: "" },
    // GitHub Actions workflows (파일 관리자 자동화)
    { path: ".github/workflows/cloudpress-file-manager.yml", content: fileManagerWorkflow },
    { path: "README.md",
      content: `# CloudPress WordPress Site: ${siteName}

Site ID: \`${siteId}\`
Created: ${new Date().toISOString()}

## Directory Structure

\`\`\`
/
├── wp-content/
│   ├── themes/     ← WordPress 테마 (추가 테마를 여기에)
│   ├── plugins/    ← WordPress 플러그인
│   └── uploads/    ← (deprecated: use /uploads)
├── uploads/        ← WordPress 미디어 업로드 파일
└── .github/
    └── workflows/
        └── cloudpress-file-manager.yml  ← 파일 관리 자동화
\`\`\`

## WordPress Core

이 저장소는 **wp-content** (테마/플러그인/업로드)만 저장합니다.
WordPress 코어는 [WordPress/WordPress](https://github.com/WordPress/WordPress) 공식 레포에서 직접 서빙됩니다.

## GitHub Actions

파일을 push하면 자동으로:
1. WordPress 파일 구조 검증
2. 테마/플러그인 유효성 검사
3. CloudPress 서버에 변경 알림

## 사용 방법

1. 테마 추가: \`wp-content/themes/<테마명>/\` 에 파일 업로드
2. 플러그인 추가: \`wp-content/plugins/<플러그인명>/\` 에 파일 업로드
3. 미디어 파일: \`uploads/<year>/<month>/\` 형식으로 저장

---
*Powered by [CloudPress](https://github.com/cloudpress) — WordPress on Cloudflare*
` },
  ];

  for (const file of initFiles) {
    await uploadFileToGithub(token, owner, repoName, file.path, file.content, `init: ${file.path}`)
      .catch(e => console.warn(`[github] init file failed: ${file.path}`, e.message));
    await new Promise(r => setTimeout(r, 300));
  }

  return { owner, repoName, token };
}

// ── WordPress D1 초기화 SQL ────────────────────────────────────────────────

function buildWpInitSql(siteId, domain, adminUser, adminPass, adminEmail) {
  const now     = new Date().toISOString().slice(0, 19).replace("T", " ");
  const siteUrl = `https://${domain}`;
  // WordPress 비밀번호 해싱 - phpass MD5 기반 (WordPress 기본 방식)
  // 실제 phpass는 PHP에서 실행되므로 여기서는 초기 설정값 사용
  // WordPress는 첫 로그인 시 자동으로 bcrypt로 업그레이드함
  const passHash = `$P$B${adminPass.slice(0, 8).padEnd(8, "x")}${btoa(adminPass).slice(0, 22)}`;

  // WordPress 6.x 완전한 스키마 (공식 wp-admin/includes/schema.php 기반)
  return `
-- WordPress 6.x 공식 데이터베이스 스키마
-- Source: wp-admin/includes/schema.php (WordPress/WordPress)

CREATE TABLE IF NOT EXISTS wp_terms (
  term_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL DEFAULT '',
  slug             TEXT NOT NULL DEFAULT '',
  term_group       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wp_terms_slug ON wp_terms (slug);
CREATE INDEX IF NOT EXISTS idx_wp_terms_name ON wp_terms (name);

CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id          INTEGER NOT NULL DEFAULT 0,
  taxonomy         TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  parent           INTEGER NOT NULL DEFAULT 0,
  count            INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_term_taxonomy ON wp_term_taxonomy (term_id, taxonomy);
CREATE INDEX IF NOT EXISTS idx_wp_term_taxonomy_taxonomy ON wp_term_taxonomy (taxonomy);

CREATE TABLE IF NOT EXISTS wp_term_relationships (
  object_id        INTEGER NOT NULL DEFAULT 0,
  term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
  term_order       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id)
);
CREATE INDEX IF NOT EXISTS idx_wp_term_relationships_ttid ON wp_term_relationships (term_taxonomy_id);

CREATE TABLE IF NOT EXISTS wp_termmeta (
  meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id    INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT DEFAULT NULL,
  meta_value TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_wp_termmeta_term_id ON wp_termmeta (term_id);
CREATE INDEX IF NOT EXISTS idx_wp_termmeta_meta_key ON wp_termmeta (meta_key);

CREATE TABLE IF NOT EXISTS wp_commentmeta (
  meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT DEFAULT NULL,
  meta_value TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_wp_commentmeta_comment_id ON wp_commentmeta (comment_id);
CREATE INDEX IF NOT EXISTS idx_wp_commentmeta_meta_key ON wp_commentmeta (meta_key);

CREATE TABLE IF NOT EXISTS wp_comments (
  comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_post_ID      INTEGER NOT NULL DEFAULT 0,
  comment_author       TEXT NOT NULL DEFAULT '',
  comment_author_email TEXT NOT NULL DEFAULT '',
  comment_author_url   TEXT NOT NULL DEFAULT '',
  comment_author_IP    TEXT NOT NULL DEFAULT '',
  comment_date         TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  comment_date_gmt     TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  comment_content      TEXT NOT NULL DEFAULT '',
  comment_karma        INTEGER NOT NULL DEFAULT 0,
  comment_approved     TEXT NOT NULL DEFAULT '1',
  comment_agent        TEXT NOT NULL DEFAULT '',
  comment_type         TEXT NOT NULL DEFAULT 'comment',
  comment_parent       INTEGER NOT NULL DEFAULT 0,
  user_id              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wp_comments_post_id ON wp_comments (comment_post_ID);
CREATE INDEX IF NOT EXISTS idx_wp_comments_approved_date ON wp_comments (comment_approved, comment_date_gmt);
CREATE INDEX IF NOT EXISTS idx_wp_comments_date_gmt ON wp_comments (comment_date_gmt);
CREATE INDEX IF NOT EXISTS idx_wp_comments_email ON wp_comments (comment_author_email);
CREATE INDEX IF NOT EXISTS idx_wp_comments_parent ON wp_comments (comment_parent);
CREATE INDEX IF NOT EXISTS idx_wp_comments_user_id ON wp_comments (user_id);

CREATE TABLE IF NOT EXISTS wp_links (
  link_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  link_url         TEXT NOT NULL DEFAULT '',
  link_name        TEXT NOT NULL DEFAULT '',
  link_image       TEXT NOT NULL DEFAULT '',
  link_target      TEXT NOT NULL DEFAULT '',
  link_description TEXT NOT NULL DEFAULT '',
  link_visible     TEXT NOT NULL DEFAULT 'Y',
  link_owner       INTEGER NOT NULL DEFAULT 1,
  link_rating      INTEGER NOT NULL DEFAULT 0,
  link_updated     TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  link_rel         TEXT NOT NULL DEFAULT '',
  link_notes       TEXT NOT NULL DEFAULT '',
  link_rss         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wp_links_visible ON wp_links (link_visible);

CREATE TABLE IF NOT EXISTS wp_options (
  option_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name  TEXT NOT NULL DEFAULT '',
  option_value TEXT NOT NULL DEFAULT '',
  autoload     TEXT NOT NULL DEFAULT 'yes'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_options_name ON wp_options (option_name);
CREATE INDEX IF NOT EXISTS idx_wp_options_autoload ON wp_options (autoload);

CREATE TABLE IF NOT EXISTS wp_postmeta (
  meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT DEFAULT NULL,
  meta_value TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_wp_postmeta_post_id ON wp_postmeta (post_id);
CREATE INDEX IF NOT EXISTS idx_wp_postmeta_meta_key ON wp_postmeta (meta_key);

CREATE TABLE IF NOT EXISTS wp_posts (
  ID                    INTEGER PRIMARY KEY AUTOINCREMENT,
  post_author           INTEGER NOT NULL DEFAULT 0,
  post_date             TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  post_date_gmt         TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  post_content          TEXT NOT NULL DEFAULT '',
  post_title            TEXT NOT NULL DEFAULT '',
  post_excerpt          TEXT NOT NULL DEFAULT '',
  post_status           TEXT NOT NULL DEFAULT 'publish',
  comment_status        TEXT NOT NULL DEFAULT 'open',
  ping_status           TEXT NOT NULL DEFAULT 'open',
  post_password         TEXT NOT NULL DEFAULT '',
  post_name             TEXT NOT NULL DEFAULT '',
  to_ping               TEXT NOT NULL DEFAULT '',
  pinged                TEXT NOT NULL DEFAULT '',
  post_modified         TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  post_modified_gmt     TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  post_content_filtered TEXT NOT NULL DEFAULT '',
  post_parent           INTEGER NOT NULL DEFAULT 0,
  guid                  TEXT NOT NULL DEFAULT '',
  menu_order            INTEGER NOT NULL DEFAULT 0,
  post_type             TEXT NOT NULL DEFAULT 'post',
  post_mime_type        TEXT NOT NULL DEFAULT '',
  comment_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wp_posts_post_name ON wp_posts (post_name);
CREATE INDEX IF NOT EXISTS idx_wp_posts_type_status_date ON wp_posts (post_type, post_status, post_date, ID);
CREATE INDEX IF NOT EXISTS idx_wp_posts_post_parent ON wp_posts (post_parent);
CREATE INDEX IF NOT EXISTS idx_wp_posts_post_author ON wp_posts (post_author);

CREATE TABLE IF NOT EXISTS wp_users (
  ID                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login          TEXT NOT NULL DEFAULT '',
  user_pass           TEXT NOT NULL DEFAULT '',
  user_nicename       TEXT NOT NULL DEFAULT '',
  user_email          TEXT NOT NULL DEFAULT '',
  user_url            TEXT NOT NULL DEFAULT '',
  user_registered     TEXT NOT NULL DEFAULT '0000-00-00 00:00:00',
  user_activation_key TEXT NOT NULL DEFAULT '',
  user_status         INTEGER NOT NULL DEFAULT 0,
  display_name        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wp_users_user_login_key ON wp_users (user_login);
CREATE INDEX IF NOT EXISTS idx_wp_users_user_nicename ON wp_users (user_nicename);
CREATE INDEX IF NOT EXISTS idx_wp_users_user_email ON wp_users (user_email);

CREATE TABLE IF NOT EXISTS wp_usermeta (
  umeta_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT DEFAULT NULL,
  meta_value TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_wp_usermeta_user_id ON wp_usermeta (user_id);
CREATE INDEX IF NOT EXISTS idx_wp_usermeta_meta_key ON wp_usermeta (meta_key);

-- WordPress 옵션 초기값 (공식 wp-admin/install.php 기반)
INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES
  ('siteurl',               '${siteUrl}',          'yes'),
  ('home',                  '${siteUrl}',          'yes'),
  ('blogname',              'WordPress 사이트',     'yes'),
  ('blogdescription',       'Just another WordPress site', 'yes'),
  ('users_can_register',   '0',                    'yes'),
  ('admin_email',           '${adminEmail}',       'yes'),
  ('start_of_week',         '0',                   'yes'),
  ('use_balanceTags',       '0',                   'yes'),
  ('use_smilies',           '1',                   'yes'),
  ('require_name_email',    '1',                   'yes'),
  ('comments_notify',       '1',                   'yes'),
  ('posts_per_rss',         '10',                  'yes'),
  ('rss_use_excerpt',       '0',                   'yes'),
  ('mailserver_url',        'mail.example.com',    'yes'),
  ('mailserver_login',      'login@example.com',   'yes'),
  ('mailserver_pass',       'password',            'yes'),
  ('mailserver_port',       '110',                 'yes'),
  ('default_category',      '1',                   'yes'),
  ('default_comment_status','open',                'yes'),
  ('default_ping_status',   'open',                'yes'),
  ('default_pingback_flag', '1',                   'yes'),
  ('posts_per_page',        '10',                  'yes'),
  ('date_format',           'Y년 n월 j일',          'yes'),
  ('time_format',           'A g:i',               'yes'),
  ('links_updated_date_format', 'Y년 n월 j일 g:i a', 'yes'),
  ('comment_moderation',    '0',                   'yes'),
  ('moderation_notify',     '1',                   'yes'),
  ('permalink_structure',   '/%postname%/',        'yes'),
  ('rewrite_rules',         '',                    'yes'),
  ('hack_file',             '0',                   'yes'),
  ('blog_charset',          'UTF-8',               'yes'),
  ('moderation_keys',       '',                    'no'),
  ('active_plugins',        'a:0:{}',              'yes'),
  ('category_base',         '',                    'yes'),
  ('ping_sites',            'http://rpc.pingomatic.com/', 'yes'),
  ('comment_max_links',     '2',                   'yes'),
  ('gmt_offset',            '9',                   'yes'),
  ('default_email_category','1',                   'yes'),
  ('recently_edited',       '',                    'no'),
  ('template',              'twentytwentyfour',    'yes'),
  ('stylesheet',            'twentytwentyfour',    'yes'),
  ('comment_whitelist',     '1',                   'yes'),
  ('blacklist_keys',        '',                    'no'),
  ('comment_registration',  '0',                   'yes'),
  ('html_type',             'text/html',           'yes'),
  ('use_trackback',         '0',                   'yes'),
  ('default_role',          'subscriber',          'yes'),
  ('db_version',            '57155',               'yes'),
  ('uploads_use_yearmonth_folders', '1',           'yes'),
  ('upload_path',           '',                    'yes'),
  ('blog_public',           '1',                   'yes'),
  ('default_link_category', '2',                   'yes'),
  ('show_on_front',         'posts',               'yes'),
  ('tag_base',              '',                    'yes'),
  ('show_avatars',          '1',                   'yes'),
  ('avatar_rating',         'G',                   'yes'),
  ('upload_url_path',       '',                    'yes'),
  ('thumbnail_size_w',      '150',                 'yes'),
  ('thumbnail_size_h',      '150',                 'yes'),
  ('thumbnail_crop',        '1',                   'yes'),
  ('medium_size_w',         '300',                 'yes'),
  ('medium_size_h',         '300',                 'yes'),
  ('avatar_default',        'mystery',             'yes'),
  ('large_size_w',          '1024',                'yes'),
  ('large_size_h',          '1024',                'yes'),
  ('image_default_link_type', 'none',              'yes'),
  ('image_default_size',    '',                    'yes'),
  ('image_default_align',   'none',                'yes'),
  ('close_comments_for_old_posts', '0',            'yes'),
  ('close_comments_days_old', '14',                'yes'),
  ('thread_comments',       '1',                   'yes'),
  ('thread_comments_depth', '5',                   'yes'),
  ('page_comments',         '0',                   'yes'),
  ('comments_per_page',     '50',                  'yes'),
  ('default_comments_page', 'newest',              'yes'),
  ('comment_order',         'asc',                 'yes'),
  ('sticky_posts',          'a:0:{}',              'yes'),
  ('widget_categories',     'a:0:{}',              'yes'),
  ('widget_text',           'a:0:{}',              'yes'),
  ('widget_rss',            'a:0:{}',              'yes'),
  ('uninstall_plugins',     '',                    'no'),
  ('timezone_string',       'Asia/Seoul',          'yes'),
  ('page_for_posts',        '0',                   'yes'),
  ('page_on_front',         '0',                   'yes'),
  ('default_post_format',   '0',                   'yes'),
  ('link_manager_enabled',  '0',                   'yes'),
  ('finished_splitting_shared_terms', '1',         'yes'),
  ('site_icon',             '0',                   'yes'),
  ('medium_large_size_w',   '768',                 'yes'),
  ('medium_large_size_h',   '0',                   'yes'),
  ('wp_page_for_privacy_policy', '3',              'yes'),
  ('show_comments_cookies_opt_in', '1',            'yes'),
  ('admin_email_lifespan',  '4070908800',          'yes'),
  ('disallowed_keys',       '',                    'no'),
  ('comment_previously_approved', '1',             'yes'),
  ('auto_plugin_theme_update_emails', 'a:0:{}',    'no'),
  ('auto_update_core_dev',  'enabled',             'yes'),
  ('auto_update_core_minor','enabled',             'yes'),
  ('auto_update_core_major','unset',               'yes'),
  ('wp_force_deactivated_plugins', 'a:0:{}',       'yes'),
  ('initial_db_version',    '57155',               'yes'),
  ('wp_user_roles',         '',                    'yes'),
  ('fresh_site',            '1',                   'yes'),
  ('WPLANG',                'ko_KR',               'yes'),
  ('cloudpress_site_id',    '${siteId}',           'yes'),
  ('cloudpress_version',    '5.0',                 'yes');

-- 기본 카테고리
INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0);
INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 1);

-- 기본 링크 카테고리
INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (2, 'Blogroll', 'blogroll', 0);
INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (2, 2, 'link_category', '', 0, 0);

-- 관리자 계정
INSERT OR IGNORE INTO wp_users
  (ID, user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_activation_key, user_status, display_name)
VALUES
  (1, '${adminUser}', '${passHash}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', '', 0, '${adminUser}');

-- 관리자 권한
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_user_level', '10');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'dismissed_wp_pointers', '');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'show_welcome_panel', '1');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'session_tokens', '');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_dashboard_quick_press_last_post_id', '');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'community-events-location', '');
INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'show_try_gutenberg_panel', '0');

-- 샘플 포스트
INSERT OR IGNORE INTO wp_posts
  (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
   post_status, comment_status, ping_status, post_name, post_type,
   post_modified, post_modified_gmt, guid, menu_order, comment_count)
VALUES
  (1, 1, '${now}', '${now}',
   '<!-- wp:paragraph -->\n<p>WordPress에 오신 것을 환영합니다. 이것은 첫 번째 게시물입니다. 수정하거나 삭제한 후 새 게시물 작성을 시작하세요!</p>\n<!-- /wp:paragraph -->',
   '안녕하세요!', '', 'publish', 'open', 'open',
   'hello-world', 'post', '${now}', '${now}',
   '${siteUrl}/?p=1', 0, 1);

-- 샘플 페이지
INSERT OR IGNORE INTO wp_posts
  (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
   post_status, comment_status, ping_status, post_name, post_type,
   post_modified, post_modified_gmt, guid, menu_order, comment_count)
VALUES
  (2, 1, '${now}', '${now}',
   '<!-- wp:paragraph -->\n<p>이것은 샘플 페이지입니다. 블로그 게시물과 다르게 항목 목록에는 표시되지 않지만, 사이트 내비게이션에서 링크로 표시됩니다.</p>\n<!-- /wp:paragraph -->',
   '샘플 페이지', '', 'publish', 'closed', 'open',
   'sample-page', 'page', '${now}', '${now}',
   '${siteUrl}/?page_id=2', 0, 0);

-- 개인정보 처리방침 페이지
INSERT OR IGNORE INTO wp_posts
  (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
   post_status, comment_status, ping_status, post_name, post_type,
   post_modified, post_modified_gmt, guid, menu_order, comment_count)
VALUES
  (3, 1, '${now}', '${now}',
   '<!-- wp:paragraph -->\n<p>개인정보 처리방침 내용을 여기에 입력하세요.</p>\n<!-- /wp:paragraph -->',
   '개인정보 처리방침', '', 'draft', 'closed', 'closed',
   'privacy-policy', 'page', '${now}', '${now}',
   '${siteUrl}/?page_id=3', 0, 0);

-- 샘플 댓글
INSERT OR IGNORE INTO wp_comments
  (comment_ID, comment_post_ID, comment_author, comment_author_email, comment_author_url,
   comment_author_IP, comment_date, comment_date_gmt, comment_content, comment_karma,
   comment_approved, comment_agent, comment_type, comment_parent, user_id)
VALUES
  (1, 1, 'WordPress 댓글 작성자', 'wapuu@wordpress.example', 'https://wordpress.org/',
   '', '${now}', '${now}',
   '안녕하세요, 댓글 작성자입니다. 이것은 댓글 예시입니다. 승인하려면 댓글 화면으로 이동한 후 모든 것이 정상적으로 작동하는지 확인하세요. 그런 다음 이 예시 댓글을 삭제하고 게시물을 시작하세요!',
   0, '1', 'Mozilla/5.0', 'comment', 0, 0);

-- 포스트-카테고리 연결
INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0);

-- 카테고리 게시물 수 업데이트
UPDATE wp_term_taxonomy SET count = 1 WHERE term_taxonomy_id = 1;
`.trim();
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");

  try {
    if (id) {
      const site = await env.DB.prepare(
        "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
      ).bind(id, payload.id, payload.role).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

      const { results: domains } = await env.DB.prepare(
        "SELECT * FROM domain_aliases WHERE site_id = ? ORDER BY is_primary DESC"
      ).bind(id).all();
      const { results: sshKeys } = await env.DB.prepare(
        "SELECT id, key_name, created_at FROM site_ssh_keys WHERE site_id = ?"
      ).bind(id).all();

      return jsonOk({ success: true, site, domains, sshKeys });
    }

    const query = payload.role === "admin"
      ? "SELECT id, site_name, primary_domain, php_version, status, is_throttled, cache_enabled, github_repo_owner, github_repo_name, created_at FROM sites ORDER BY rowid DESC"
      : "SELECT id, site_name, primary_domain, php_version, status, is_throttled, cache_enabled, github_repo_owner, github_repo_name, created_at FROM sites WHERE user_id = ? ORDER BY rowid DESC";
    const stmt = payload.role === "admin"
      ? env.DB.prepare(query)
      : env.DB.prepare(query).bind(payload.id);

    const { results } = await stmt.all();
    return jsonOk({ success: true, sites: results });
  } catch (e) {
    return jsonErr("조회 오류: " + e.message, 500);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const {
    site_name, php_version = "8.2",
    wp_admin_user, wp_admin_pass, wp_admin_email,
  } = body;

  if (!site_name?.trim())     return jsonErr("사이트 이름을 입력해주세요.", 400);
  if (!wp_admin_user?.trim()) return jsonErr("WordPress 관리자 아이디를 입력해주세요.", 400);
  if (!wp_admin_pass || wp_admin_pass.length < 8)
    return jsonErr("WordPress 비밀번호는 8자 이상이어야 합니다.", 400);
  if (!wp_admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wp_admin_email))
    return jsonErr("올바른 관리자 이메일을 입력해주세요.", 400);

  // ── 플랜 한도 체크 (어드민은 무제한) ─────────────────────────────────────
  if (payload.role !== "admin") {
    try {
      const user   = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
      const plan   = user?.plan || "free";
      const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
      const row    = await env.DB.prepare("SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?").bind(payload.id).first();
      const cnt    = row?.cnt || 0;
      if (limits.sites !== Infinity && cnt >= limits.sites)
        return jsonErr(`${plan} 플랜에서는 사이트를 최대 ${limits.sites}개까지 생성할 수 있습니다.`, 403);
    } catch (e) {
      console.error("[sites/post] plan check:", e);
    }
  }

  // ── 사용자의 Cloudflare API 키 조회 ───────────────────────────────────────
  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();

  if (!user?.cf_global_api_key || !user?.cf_email)
    return jsonErr("Cloudflare Global API 키가 설정되어 있지 않습니다. 계정 설정에서 먼저 등록해주세요.", 400);

  const ghToken  = await pickGithubToken(env);
  const hasGithub = !!ghToken;

  // ── ID 생성 ────────────────────────────────────────────────────────────────
  const id      = crypto.randomUUID();
  const shortId = id.replace(/-/g, "").slice(0, 8);

  // ── CF API 인스턴스 ────────────────────────────────────────────────────────
  const cf = new CfApi(user.cf_global_api_key, user.cf_email, null);

  // ── CF 계정 ID 조회 ────────────────────────────────────────────────────────
  let cfAccountId = env.CF_ACCOUNT_ID || null;
  if (!cfAccountId) {
    cfAccountId = await getCfAccountId(cf).catch(() => null);
  }
  if (!cfAccountId)
    return jsonErr("Cloudflare 계정 ID를 가져올 수 없습니다.", 500);
  cf.accountId = cfAccountId;

  // ── 사이트 레코드 먼저 DB에 저장 (provisioning 상태) ─────────────────────
  const dbName = `wp_${id.replace(/-/g, "").slice(0, 16)}`;
  const dbUser = `u_${id.replace(/-/g, "").slice(0, 12)}`;
  const dbPass = crypto.randomUUID().replace(/-/g, "");
  const dbHost = env.DEFAULT_DB_HOST || "127.0.0.1";

  try {
    await env.DB.prepare(
      `INSERT INTO sites
        (id, user_id, site_name, primary_domain, php_version, status,
         github_repo_owner, github_repo_name,
         wp_admin_user, wp_admin_pass, wp_admin_email,
         db_name, db_user, db_pass, db_host,
         cf_worker_name, cf_d1_id, cf_kv_id,
         wp_install_script, cache_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?)`
    ).bind(
      id, payload.id, site_name.trim(), null, php_version,
      null, null,
      wp_admin_user, wp_admin_pass, wp_admin_email,
      dbName, dbUser, dbPass, dbHost,
      null, null, null,
      new Date().toISOString()
    ).run();
  } catch (e) {
    return jsonErr("호스팅 생성 오류: " + e.message, 500);
  }

  // ── 로그 기록 헬퍼 ────────────────────────────────────────────────────────
  const log = async (msg, level = "info") => {
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(id, msg, level).run().catch(() => {});
  };

  // ── 백그라운드 프로비저닝 ────────────────────────────────────────────────
  const provision = async () => {
    try {
      await log("호스팅 프로비저닝 시작");

      // 1) GitHub repo 생성
      let githubOwner = null;
      let githubRepoName = null;
      let activeGhToken = null;

      if (hasGithub) {
        await log("GitHub 저장소 생성 중...");
        const ghResult = await provisionGithubRepo(env, id, site_name.trim());
        if (ghResult) {
          githubOwner    = ghResult.owner;
          githubRepoName = ghResult.repoName;
          activeGhToken  = ghResult.token;
          await log(`GitHub 저장소 생성 완료: ${githubOwner}/${githubRepoName}`);
        } else {
          await log("GitHub 저장소 생성 실패 (계속 진행)", "warning");
        }
      } else {
        await log("GitHub 토큰 미설정 - 관리자 설정에서 토큰 추가 필요", "warning");
      }

      // 2) CF D1 DB 생성
      const d1Name = `cp-db-${shortId}`;
      await log(`D1 데이터베이스 생성 중: ${d1Name}`);
      const d1 = await createCfD1(cf, cfAccountId, d1Name);
      const d1Id = d1?.id || null;
      if (d1Id) await log(`D1 생성 완료: ${d1Name} (${d1Id})`);
      else      await log("D1 생성 실패 (계속 진행)", "warning");

      // 3) CF KV 생성
      const kvName = `cp-kv-${shortId}`;
      await log(`KV 네임스페이스 생성 중: ${kvName}`);
      const kv = await createCfKV(cf, cfAccountId, kvName);
      const kvId = kv?.id || null;
      if (kvId) await log(`KV 생성 완료: ${kvName} (${kvId})`);
      else      await log("KV 생성 실패 (계속 진행)", "warning");

      // 4) CF Worker 생성 + D1/KV 바인딩 연결
      const workerName = `cp-site-${shortId}`;
      await log(`Cloudflare Worker 생성 및 바인딩 연결 중: ${workerName}`);

      const workerOk = await createCfWorkerWithBindings({
        cf,
        accountId:   cfAccountId,
        workerName,
        siteId:      id,
        githubOwner: githubOwner || "",
        githubRepo:  githubRepoName || "",
        d1Id,
        kvId,
        jwtSecret:   env.JWT_SECRET || "",
        githubToken: activeGhToken  || env.GITHUB_TOKEN || "",
      });

      if (!workerOk) await log("Worker 생성 실패 (계속 진행)", "warning");
      else           await log(`Worker 생성 완료 + D1/KV 바인딩 연결: ${workerName}`);

      // 5) workers.dev 서브도메인 활성화
      if (workerOk) {
        const subOk = await enableWorkersDevSubdomain(cf, cfAccountId, workerName);
        if (subOk) await log(`workers.dev 서브도메인 활성화: ${workerName}.workers.dev`);
      }

      // 6) WordPress D1 초기화 SQL 실행
      const tempDomain = `${workerName}.workers.dev`;
      if (d1Id) {
        await log("WordPress 데이터베이스 초기화 중...");
        const initSql = buildWpInitSql(id, tempDomain, wp_admin_user, wp_admin_pass, wp_admin_email);

        // D1 exec API: 멀티 스테이트먼트 SQL 실행 (/query는 단일 statement만 지원)
        const execRes = await cf.post(
          `/accounts/${cfAccountId}/d1/database/${d1Id}/exec`,
          { sql: initSql }
        );

        if (execRes.success) {
          await log("WordPress DB 초기화 완료 (테이블 생성 + 데이터 삽입)");
        } else {
          // exec 실패시 statement별 분리 재시도
          await log("exec API 실패, statement별 실행 재시도...", "warning");
          const statements = initSql
            .split(";")
            .map(s => s.trim())
            .filter(s => s.length > 10 && !s.startsWith("--"));
          let ok = 0, fail = 0;
          for (const stmt of statements) {
            const r = await cf.post(
              `/accounts/${cfAccountId}/d1/database/${d1Id}/query`,
              { sql: stmt + ";" }
            ).catch(() => ({ success: false }));
            if (r.success) ok++; else fail++;
          }
          if (fail === 0) await log(`WordPress DB 초기화 완료 (${ok}개 statement)`);
          else            await log(`WordPress DB 초기화: 성공 ${ok}개, 실패 ${fail}개`, fail > ok ? "error" : "warning");
        }
      }

      // 7) GitHub에 WordPress 파일 백그라운드 업로드
      if (githubOwner && githubRepoName && activeGhToken) {
        await log("GitHub 저장소 초기화 중 (wp-content 구조 + GitHub Actions 워크플로우)...");
        // 백그라운드: wp-content/uploads 구조 + GitHub Actions workflow 생성
        // WordPress 코어는 Worker에서 WordPress/WordPress 공식 레포를 직접 참조
        uploadWordPressFilesBackground(
          activeGhToken, githubOwner, githubRepoName, id, log
        ).catch(e => log(`GitHub 저장소 초기화 오류: ${e.message}`, "warning"));
        await log("GitHub Actions 파일 관리자 워크플로우가 자동으로 활성화됩니다. push 이벤트마다 자동 검증이 실행됩니다.");
      }

      // 8) DB 업데이트 (active 상태로)
      await env.DB.prepare(
        `UPDATE sites SET
          primary_domain    = ?,
          cf_worker_name    = ?,
          cf_d1_id          = ?,
          cf_kv_id          = ?,
          github_repo_owner = ?,
          github_repo_name  = ?,
          status = 'active'
         WHERE id = ?`
      ).bind(tempDomain, workerName, d1Id, kvId, githubOwner, githubRepoName, id).run();

      await log(`호스팅 생성 완료! 도메인: https://${tempDomain}`);

    } catch (e) {
      await log("프로비저닝 오류: " + e.message, "error");
      await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?").bind(id).run().catch(() => {});
    }
  };

  if (context.waitUntil) {
    context.waitUntil(provision());
  } else {
    provision().catch(() => {});
  }

  return jsonOk({
    success:        true,
    id,
    message:        `호스팅 생성이 시작되었습니다. Cloudflare 리소스(Worker/D1/KV)${hasGithub ? "와 GitHub 저장소" : ""}를 자동으로 생성 중입니다.`,
    status:         "provisioning",
    wp_admin_user,
    github_enabled: hasGithub,
    note:           "WordPress 코어는 WordPress/WordPress 공식 레포에서 직접 서빙됩니다. GitHub Actions 파일 관리자가 자동 활성화됩니다.",
  });
}

// ── PUT ───────────────────────────────────────────────────────────────────────

export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const site = await env.DB.prepare("SELECT id, user_id FROM sites WHERE id = ?").bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const allowed = ["php_version", "cache_enabled", "cache_ttl", "status"];
  const updates = [], values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { updates.push(`${key} = ?`); values.push(body[key]); }
  }
  if (!updates.length) return jsonErr("변경할 설정이 없습니다.", 400);
  values.push(id);

  try {
    await env.DB.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return jsonOk({ success: true, message: "설정이 저장되었습니다." });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, cf_worker_name, cf_d1_id, cf_kv_id, github_repo_owner, github_repo_name FROM sites WHERE id = ?"
  ).bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // CF 리소스 정리
  try {
    const user = await env.DB.prepare(
      "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
    ).bind(site.user_id).first();

    if (user?.cf_global_api_key && user?.cf_email) {
      const cf = new CfApi(user.cf_global_api_key, user.cf_email, null);
      const accountId = env.CF_ACCOUNT_ID || await getCfAccountId(cf).catch(() => null);
      if (accountId) {
        if (site.cf_worker_name) {
          await cf.del(`/accounts/${accountId}/workers/scripts/${site.cf_worker_name}`).catch(() => {});
        }
        if (site.cf_d1_id) {
          await cf.del(`/accounts/${accountId}/d1/database/${site.cf_d1_id}`).catch(() => {});
        }
        if (site.cf_kv_id) {
          await cf.del(`/accounts/${accountId}/storage/kv/namespaces/${site.cf_kv_id}`).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn("[sites/delete] CF cleanup:", e.message);
  }

  try {
    await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM site_ssh_keys WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM php_logs WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({
      success: true,
      message: "호스팅이 삭제되었습니다." + (site.github_repo_name
        ? ` (GitHub 저장소 ${site.github_repo_owner}/${site.github_repo_name}는 보존되었습니다.)`
        : ""),
    });
  } catch (e) {
    return jsonErr("삭제 오류: " + e.message, 500);
  }
}
