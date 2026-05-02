/**
 * CloudPress WordPress Worker v3.1
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * GitHub 스토리지 기반 WordPress 서버리스 실행
 *
 * 아키텍처:
 *   - 파일시스템: GitHub (WordPress 코어/테마/플러그인/미디어)
 *   - DB: Cloudflare D1 (SQLite) — WordPress MySQL → SQLite 브릿지
 *   - 세션/캐시: Cloudflare KV
 *   - PHP 실행: php-wasm (WebAssembly PHP 8.2) via PHP_RUNNER binding
 *
 * 환경변수 (wrangler secret put):
 *   GITHUB_TOKEN          - GitHub Personal Access Token (repo 접근)
 *   GITHUB_OWNER          - GitHub 유저명/org
 *   GITHUB_REPO           - 이 사이트의 GitHub repo 이름
 *   JWT_SECRET            - 플랫폼 JWT 서명키
 *
 * 바인딩 (wrangler.toml):
 *   DB                    - Cloudflare D1 (이 사이트 전용 WordPress DB)
 *   CACHE                 - Cloudflare KV (페이지 캐시)
 *   KV                    - Cloudflare KV (설치 상태 등)
 *   ASSETS                - 정적 파일 (선택)
 *   PHP_RUNNER            - PHP Worker 서비스 바인딩 (선택)
 */

// ─── GitHub Storage 헬퍼 ──────────────────────────────────────────────────

class GitHubStorage {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo  = repo;
    this.base  = "https://api.github.com";
  }

  _headers() {
    return {
      Authorization:         `Bearer ${this.token}`,
      Accept:                "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type":        "application/json",
      "User-Agent":          "CloudPress-Worker/3.1",
    };
  }

  /** 파일 raw URL로 직접 가져오기 (빠름) */
  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/main/${path}`;
  }

  async fetchRaw(path) {
    const res = await fetch(this.rawUrl(path), {
      headers: this.token
        ? { Authorization: `Bearer ${this.token}` }
        : {},
    });
    if (!res.ok) return null;
    return res;
  }

  async getFile(path) {
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { headers: this._headers() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.content) {
      const decoded = atob(data.content.replace(/\n/g, ""));
      return { text: decoded, sha: data.sha };
    }
    return null;
  }

  async exists(path) {
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: "HEAD", headers: this._headers() }
    );
    return res.ok;
  }
}

// ─── 유틸리티 ──────────────────────────────────────────────────────────────

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}

function jsonErr(msg, status = 400) {
  return jsonOk({ error: msg }, status);
}

// ─── D1 쿼리 헬퍼 ─────────────────────────────────────────────────────────

async function d1Query(db, sql, params = []) {
  try {
    const stmt = params.length
      ? db.prepare(sql).bind(...params)
      : db.prepare(sql);
    const result = await stmt.all();
    return { ok: true, results: result.results || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function d1Run(db, sql, params = []) {
  try {
    const stmt = params.length
      ? db.prepare(sql).bind(...params)
      : db.prepare(sql);
    await stmt.run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── KV 캐시 ───────────────────────────────────────────────────────────────

async function getCached(kv, key) {
  if (!kv) return null;
  try { return await kv.get(key); } catch { return null; }
}

async function setCached(kv, key, value, ttl = 3600) {
  if (!kv) return;
  try { await kv.put(key, value, { expirationTtl: ttl }); } catch {}
}

// ─── WordPress 설치 상태 확인 ──────────────────────────────────────────────

async function checkInstalled(db, kv) {
  // KV에서 빠르게 확인
  const kvFlag = await getCached(kv, "wp:installed");
  if (kvFlag === "1") return true;

  // D1에서 wp_options 테이블 존재 여부 확인
  if (db) {
    const r = await d1Query(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wp_options' LIMIT 1"
    );
    if (r.ok && r.results.length > 0) {
      await setCached(kv, "wp:installed", "1", 86400);
      return true;
    }
  }
  return false;
}

// ─── WordPress 초기 테이블 생성 (D1) ──────────────────────────────────────

async function initWordPressDB(db, siteUrl, adminUser, adminPass, adminEmail) {
  if (!db) return false;

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const sqls = [
    `CREATE TABLE IF NOT EXISTS wp_options (
      option_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      option_name  TEXT UNIQUE NOT NULL,
      option_value TEXT NOT NULL DEFAULT '',
      autoload     TEXT NOT NULL DEFAULT 'yes'
    )`,
    `CREATE TABLE IF NOT EXISTS wp_users (
      ID              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_login      TEXT NOT NULL DEFAULT '',
      user_pass       TEXT NOT NULL DEFAULT '',
      user_nicename   TEXT NOT NULL DEFAULT '',
      user_email      TEXT NOT NULL DEFAULT '',
      user_url        TEXT NOT NULL DEFAULT '',
      user_registered TEXT NOT NULL DEFAULT '',
      user_status     INTEGER NOT NULL DEFAULT 0,
      display_name    TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS wp_usermeta (
      umeta_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      meta_key   TEXT,
      meta_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wp_posts (
      ID                    INTEGER PRIMARY KEY AUTOINCREMENT,
      post_author           INTEGER NOT NULL DEFAULT 0,
      post_date             TEXT NOT NULL DEFAULT '',
      post_content          TEXT NOT NULL DEFAULT '',
      post_title            TEXT NOT NULL DEFAULT '',
      post_excerpt          TEXT NOT NULL DEFAULT '',
      post_status           TEXT NOT NULL DEFAULT 'publish',
      comment_status        TEXT NOT NULL DEFAULT 'open',
      ping_status           TEXT NOT NULL DEFAULT 'open',
      post_name             TEXT NOT NULL DEFAULT '',
      post_type             TEXT NOT NULL DEFAULT 'post',
      post_modified         TEXT NOT NULL DEFAULT '',
      guid                  TEXT NOT NULL DEFAULT '',
      menu_order            INTEGER NOT NULL DEFAULT 0,
      comment_count         INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_postmeta (
      meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL DEFAULT 0,
      meta_key   TEXT,
      meta_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wp_terms (
      term_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL DEFAULT '',
      slug       TEXT NOT NULL DEFAULT '',
      term_group INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
      term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id          INTEGER NOT NULL DEFAULT 0,
      taxonomy         TEXT NOT NULL DEFAULT '',
      description      TEXT NOT NULL DEFAULT '',
      parent           INTEGER NOT NULL DEFAULT 0,
      count            INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_term_relationships (
      object_id        INTEGER NOT NULL DEFAULT 0,
      term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
      term_order       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (object_id, term_taxonomy_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wp_comments (
      comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_post_ID      INTEGER NOT NULL DEFAULT 0,
      comment_author       TEXT NOT NULL DEFAULT '',
      comment_author_email TEXT NOT NULL DEFAULT '',
      comment_author_url   TEXT NOT NULL DEFAULT '',
      comment_author_IP    TEXT NOT NULL DEFAULT '',
      comment_date         TEXT NOT NULL DEFAULT '',
      comment_content      TEXT NOT NULL DEFAULT '',
      comment_approved     TEXT NOT NULL DEFAULT '1',
      comment_type         TEXT NOT NULL DEFAULT 'comment',
      comment_parent       INTEGER NOT NULL DEFAULT 0,
      user_id              INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_commentmeta (
      meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL DEFAULT 0,
      meta_key   TEXT,
      meta_value TEXT
    )`,
    // 기본 옵션 삽입
    `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES
      ('siteurl',               '${siteUrl}',          'yes'),
      ('home',                  '${siteUrl}',          'yes'),
      ('blogname',              'CloudPress Site',      'yes'),
      ('blogdescription',       'WordPress on Cloudflare', 'yes'),
      ('admin_email',           '${adminEmail}',       'yes'),
      ('permalink_structure',   '/%postname%/',         'yes'),
      ('template',              'twentytwentyfour',     'yes'),
      ('stylesheet',            'twentytwentyfour',     'yes'),
      ('active_plugins',        '',                     'yes'),
      ('wp_user_roles',         '',                     'yes'),
      ('blogpublic',            '1',                    'yes'),
      ('default_comment_status','open',                 'yes'),
      ('wp_cloudpress_version', '3.1',                  'no')`,
    // 관리자 계정 생성
    `INSERT OR IGNORE INTO wp_users
      (user_login, user_pass, user_nicename, user_email, user_url, user_registered, display_name)
     VALUES
      ('${adminUser}', '${adminPass}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', '${adminUser}')`,
    // 관리자 권한 메타
    `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value)
     VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
    `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value)
     VALUES (1, 'wp_user_level', '10')`,
    // 기본 샘플 포스트
    `INSERT OR IGNORE INTO wp_posts
      (post_author, post_date, post_content, post_title, post_status, post_name, post_type, post_modified, guid)
     VALUES
      (1, '${now}', 'CloudPress에 오신 것을 환영합니다! 이 포스트는 자동으로 생성된 샘플입니다.', '안녕하세요!', 'publish', 'hello-world', 'post', '${now}', '${siteUrl}/?p=1')`,
  ];

  for (const sql of sqls) {
    const r = await d1Run(db, sql);
    if (!r.ok) console.warn("[d1-init] SQL 오류:", r.error, sql.slice(0, 60));
  }
  return true;
}

// ─── wp-config.php 생성 ────────────────────────────────────────────────────

function buildWpConfig(env, siteUrl) {
  const secret = () => crypto.randomUUID().replace(/-/g, "");
  const ghOwner = env.GITHUB_OWNER || "";
  const ghRepo  = env.GITHUB_REPO  || "";
  const ghToken = env.GITHUB_TOKEN || "";

  return `<?php
/**
 * CloudPress WordPress 설정 (v3.1)
 * GitHub Storage + Cloudflare D1
 */

// ── 데이터베이스 (D1 SQLite) ─────────────────────────────────────────
define('DB_NAME',     'cloudpress');
define('DB_USER',     'cloudpress');
define('DB_PASSWORD', '');
define('DB_HOST',     'localhost');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  '');

// ── 인증 키 ───────────────────────────────────────────────────────────
define('AUTH_KEY',         '${secret()}');
define('SECURE_AUTH_KEY',  '${secret()}');
define('LOGGED_IN_KEY',    '${secret()}');
define('NONCE_KEY',        '${secret()}');
define('AUTH_SALT',        '${secret()}');
define('SECURE_AUTH_SALT', '${secret()}');
define('LOGGED_IN_SALT',   '${secret()}');
define('NONCE_SALT',       '${secret()}');

// ── 테이블 접두사 ─────────────────────────────────────────────────────
$table_prefix = 'wp_';

// ── 디버그 ────────────────────────────────────────────────────────────
define('WP_DEBUG', false);

// ── GitHub Storage ────────────────────────────────────────────────────
define('CLOUDPRESS_GITHUB_OWNER', '${ghOwner}');
define('CLOUDPRESS_GITHUB_REPO',  '${ghRepo}');
define('CLOUDPRESS_GITHUB_TOKEN', '${ghToken}');

// ── 사이트 URL ────────────────────────────────────────────────────────
define('WP_SITEURL', '${siteUrl}');
define('WP_HOME',    '${siteUrl}');

// ── SQLite DB 경로 (php-wasm /tmp) ────────────────────────────────────
define('SQLITE_DB_REALPATH', '/tmp/cloudpress.db');

// ── 서버리스 환경 설정 ────────────────────────────────────────────────
define('DISALLOW_FILE_EDIT',          true);
define('AUTOMATIC_UPDATER_DISABLED',  true);

if (!defined('ABSPATH')) {
  define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── 설치 중 페이지 ────────────────────────────────────────────────────────

function setupPage() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CloudPress - WordPress 설치 중</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);
      min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fff;border-radius:20px;padding:48px;max-width:480px;
      width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.2)}
    .logo{width:64px;height:64px;background:linear-gradient(135deg,#667eea,#764ba2);
      border-radius:16px;margin:0 auto 24px;display:flex;align-items:center;
      justify-content:center;font-size:32px}
    h1{font-size:24px;font-weight:700;margin-bottom:12px;color:#1a1a2e}
    p{color:#666;line-height:1.6;margin-bottom:24px}
    .progress{background:#f0f0f0;border-radius:100px;height:8px;overflow:hidden}
    .bar{height:100%;background:linear-gradient(90deg,#667eea,#764ba2);
      border-radius:100px;animation:prog 2s ease-in-out infinite}
    @keyframes prog{0%{width:20%}50%{width:80%}100%{width:20%}}
    .steps{text-align:left;margin-top:24px;display:flex;flex-direction:column;gap:8px}
    .step{display:flex;align-items:center;gap:12px;font-size:14px;color:#aaa}
    .step.done{color:#22c55e}.step.active{color:#667eea;font-weight:600}
    .dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex-shrink:0}
  </style>
  <script>setTimeout(()=>location.reload(),6000)</script>
</head>
<body>
  <div class="card">
    <div class="logo">🚀</div>
    <h1>WordPress 설치 중</h1>
    <p>CloudPress가 WordPress를 GitHub 저장소와 Cloudflare D1에<br>자동으로 설치하고 있습니다. 잠시만 기다려주세요.</p>
    <div class="progress"><div class="bar"></div></div>
    <div class="steps">
      <div class="step done"><div class="dot"></div> Cloudflare Worker 생성 완료</div>
      <div class="step done"><div class="dot"></div> D1 데이터베이스 생성 완료</div>
      <div class="step done"><div class="dot"></div> KV 네임스페이스 생성 완료</div>
      <div class="step active"><div class="dot"></div> GitHub에 WordPress 파일 업로드 중...</div>
      <div class="step"><div class="dot"></div> WordPress 초기 설정</div>
    </div>
  </div>
</body>
</html>`;
}

// ─── PHP 실행 ────────────────────────────────────────────────────────────────

async function runPhp(phpCode, env, options = {}) {
  try {
    if (env.PHP_RUNNER) {
      const res = await env.PHP_RUNNER.fetch(
        new Request("https://php/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code:  phpCode,
            env:   options.phpEnv  || {},
            files: options.files   || {},
          }),
        })
      );
      return res;
    }
    // PHP Runner 없음 → 안내 페이지
    return new Response(
      "<?xml version='1.0'?><error>PHP_RUNNER 바인딩이 필요합니다.</error>",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (e) {
    return new Response(`PHP 실행 오류: ${e.message}`, { status: 500 });
  }
}

// ─── WordPress 요청 처리 ────────────────────────────────────────────────────

async function handleWordPressRequest(request, env) {
  const url = new URL(request.url);

  const gh = (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO)
    ? new GitHubStorage(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO)
    : null;

  // GitHub 설정 미완료 → 설정 안내
  if (!gh) {
    return new Response(
      "⚠️ GitHub 환경변수(GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)가 설정되지 않았습니다.\n" +
      "CloudPress 관리자 설정에서 GitHub 저장소를 연결해주세요.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // 정적 파일 확장자 → GitHub Raw 직서빙
  const staticExt = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|json)$/i;
  if (staticExt.test(url.pathname)) {
    // wp-includes / wp-admin / wp-content 정적 파일
    const ghPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    const file = await gh.fetchRaw(`wp-core/${ghPath}`);
    if (file) return file;
    // wp-content (테마/플러그인/업로드)
    if (url.pathname.startsWith("/wp-content/")) {
      const contentPath = url.pathname.slice("/wp-content/".length);
      const contentFile = await gh.fetchRaw(`wp-content/${contentPath}`);
      if (contentFile) return contentFile;
    }
    return new Response("Not Found", { status: 404 });
  }

  // wp-content/uploads 미디어 → GitHub Raw
  if (url.pathname.startsWith("/wp-content/uploads/")) {
    const mediaPath = url.pathname.slice("/wp-content/uploads/".length);
    const media = await gh.fetchRaw(`uploads/${mediaPath}`);
    if (media) return media;
    return new Response("미디어를 찾을 수 없습니다.", { status: 404 });
  }

  // wp-content (테마/플러그인) → GitHub Raw
  if (url.pathname.startsWith("/wp-content/")) {
    const contentPath = url.pathname.slice("/wp-content/".length);
    const file = await gh.fetchRaw(`wp-content/${contentPath}`);
    if (file) return file;
    return new Response("Not Found", { status: 404 });
  }

  // 설치 상태 확인
  const installed = await checkInstalled(env.DB, env.KV);

  // GitHub에 wp-core 존재 여부 확인
  const coreReady = gh ? await gh.exists("wp-core/wp-load.php") : false;

  if (!installed || !coreReady) {
    // wp-admin 경로는 대기 페이지 표시
    return new Response(setupPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // KV 페이지 캐시 (GET만)
  const cacheKey = `page:${url.pathname}${url.search}`;
  if (request.method === "GET" && env.CACHE) {
    const cached = await getCached(env.CACHE, cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Cache":      "HIT",
        },
      });
    }
  }

  // wp-admin 경로 처리 — wp-login.php
  if (url.pathname === "/wp-login.php" || url.pathname.startsWith("/wp-admin")) {
    // GitHub에서 wp-login.php 가져와서 PHP 실행
    const siteUrl  = `${url.protocol}//${url.host}`;
    const phpEnv   = buildPhpEnv(request, env, url, siteUrl);
    const wpConfig = buildWpConfig(env, siteUrl);

    const phpFile  = url.pathname === "/wp-login.php" ? "wp-login.php" : url.pathname.slice(1);
    const phpRes   = await gh.getFile(`wp-core/${phpFile}`);
    if (!phpRes) {
      return new Response("WordPress 파일을 찾을 수 없습니다. 파일이 GitHub에 업로드되었는지 확인해주세요.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const response = await runPhp(phpRes.text, env, {
      phpEnv,
      files: { "/wordpress/wp-config.php": wpConfig },
    });
    return response;
  }

  // 일반 PHP 요청
  let phpPath = url.pathname;
  if (phpPath === "/" || phpPath === "") phpPath = "index.php";
  if (!phpPath.endsWith(".php")) phpPath = phpPath.replace(/\/$/, "") + "/index.php";

  const siteUrl = `${url.protocol}//${url.host}`;
  const phpEnv  = buildPhpEnv(request, env, url, siteUrl);

  // GitHub에서 PHP 파일 로드
  const phpFile = phpPath.startsWith("/") ? phpPath.slice(1) : phpPath;
  const phpRes  = await gh.getFile(`wp-core/${phpFile}`).catch(() => null)
    || await gh.getFile(`wp-core/index.php`);

  if (!phpRes) {
    return new Response("WordPress가 준비되지 않았습니다.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const wpConfig = buildWpConfig(env, siteUrl);
  const response = await runPhp(phpRes.text, env, {
    phpEnv,
    files: { "/wordpress/wp-config.php": wpConfig },
  });

  // 성공적인 HTML 응답 캐시
  if (request.method === "GET" && response.status === 200 && env.CACHE) {
    const ct = response.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      const html = await response.clone().text();
      if (!html.includes("logged-in") && !url.pathname.startsWith("/wp-admin")) {
        await setCached(env.CACHE, cacheKey, html, 3600);
      }
    }
  }

  return response;
}

function buildPhpEnv(request, env, url, siteUrl) {
  return {
    WP_HOME:           siteUrl,
    WP_SITEURL:        siteUrl,
    GITHUB_OWNER:      env.GITHUB_OWNER || "",
    GITHUB_REPO:       env.GITHUB_REPO  || "",
    GITHUB_TOKEN:      env.GITHUB_TOKEN || "",
    REQUEST_URI:       url.pathname + url.search,
    REQUEST_METHOD:    request.method,
    HTTP_HOST:         url.host,
    SERVER_NAME:       url.host,
    SERVER_PORT:       url.port || "443",
    HTTPS:             url.protocol === "https:" ? "on" : "off",
    CONTENT_TYPE:      request.headers.get("Content-Type")  || "",
    HTTP_COOKIE:       request.headers.get("Cookie")        || "",
    HTTP_AUTHORIZATION:request.headers.get("Authorization") || "",
    HTTP_REFERER:      request.headers.get("Referer")       || "",
    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language") || "ko",
  };
}

// ─── JWT 인증 ───────────────────────────────────────────────────────────────

async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
    const sigBytes = Uint8Array.from(
      atob(pad(sig.replace(/-/g, "+").replace(/_/g, "/"))),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(data)
    );
    if (!valid) return null;
    const payload = JSON.parse(
      atob(pad(body.replace(/-/g, "+").replace(/_/g, "/")))
    );
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── 메인 Fetch 핸들러 ─────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    // ── CloudPress 관리 API ──────────────────────────────────────────────

    // 건강 체크
    if (url.pathname === "/api/health") {
      return jsonOk({
        status:  "ok",
        version: "3.1.0",
        storage: "GitHub",
        db:      "Cloudflare D1",
        cache:   "Cloudflare KV",
        bindings: {
          DB:         !!env.DB,
          KV:         !!env.KV,
          CACHE:      !!env.CACHE,
          PHP_RUNNER: !!env.PHP_RUNNER,
        },
        github: {
          configured: !!(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO),
          owner:      env.GITHUB_OWNER || null,
          repo:       env.GITHUB_REPO  || null,
        },
        ts: new Date().toISOString(),
      });
    }

    // WordPress DB 초기화 API (프로비저닝 시 호출)
    if (url.pathname === "/api/wp-init" && method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const token      = authHeader.replace("Bearer ", "");
      const secret     = env.JWT_SECRET || env.CLOUDPRESS_SECRET || "";
      if (secret) {
        const payload = await verifyJWT(token, secret);
        if (!payload) return jsonErr("인증이 필요합니다.", 401);
      }

      let body = {};
      try { body = await request.json(); } catch {}

      const siteUrl    = body.site_url    || `https://${url.host}`;
      const adminUser  = body.admin_user  || "admin";
      const adminPass  = body.admin_pass  || "changeme";
      const adminEmail = body.admin_email || "admin@example.com";

      if (!env.DB) return jsonErr("DB 바인딩이 없습니다.", 503);

      const ok = await initWordPressDB(env.DB, siteUrl, adminUser, adminPass, adminEmail);
      if (ok) {
        await setCached(env.KV, "wp:installed", "1", 86400 * 365);
        return jsonOk({ success: true, message: "WordPress DB 초기화 완료" });
      }
      return jsonErr("DB 초기화 실패", 500);
    }

    // 캐시 퍼지 API
    if (url.pathname === "/api/cache-purge" && method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      const token      = authHeader.replace("Bearer ", "");
      const secret     = env.JWT_SECRET || env.CLOUDPRESS_SECRET || "";
      if (secret) {
        const payload = await verifyJWT(token, secret);
        if (!payload) return jsonErr("인증이 필요합니다.", 401);
      }
      // KV 캐시는 개별 삭제가 필요하므로 설치 플래그만 리셋
      await env.KV?.delete("wp:installed").catch(() => {});
      return jsonOk({ success: true, message: "캐시 퍼지 완료" });
    }

    // ── 사이트 라우팅 ──────────────────────────────────────────────────

    // 이 Worker 자체가 하나의 WordPress 사이트를 서빙
    // (CloudPress 플랫폼에서 각 사이트마다 별도 Worker를 배포)
    if (env.GITHUB_OWNER && env.GITHUB_REPO) {
      return handleWordPressRequest(request, env);
    }

    // ── CloudPress 플랫폼 대시보드 (정적 파일) ──────────────────────────
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("CloudPress WordPress Hosting Platform v3.1", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
