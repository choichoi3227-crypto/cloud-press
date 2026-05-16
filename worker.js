/**
 * CloudPress WordPress Worker v4.0
 * WordPress 코어: WordPress/WordPress 공식 GitHub 레포지토리
 * 사용자 데이터: 호스팅 생성 시 만들어진 개인 GitHub 레포지토리
 */

const WP_CORE_OWNER  = "WordPress";
const WP_CORE_REPO   = "WordPress";
const WP_CORE_BRANCH = "master";

// ─── GitHub Storage ────────────────────────────────────────────────────────

class GitHubStorage {
  constructor(token, owner, repo, branch = "main") {
    this.token  = token;
    this.owner  = owner;
    this.repo   = repo;
    this.branch = branch;
    this.base   = "https://api.github.com";
  }

  _headers(extra = {}) {
    const h = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "CloudPress-Worker/4.0",
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
  }

  async fetchRaw(path) {
    const res = await fetch(this.rawUrl(path), { headers: this._headers() });
    if (!res.ok) return null;
    return res;
  }

  async getFile(path) {
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`,
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

  async putFile(path, content, message, sha) {
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const body = { message, content: encoded, branch: this.branch };
    if (sha) body.sha = sha;
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}`,
      {
        method: "PUT",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      }
    );
    return res.ok;
  }

  async exists(path) {
    const res = await fetch(
      `${this.base}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${this.branch}`,
      { method: "HEAD", headers: this._headers() }
    );
    return res.ok;
  }

  async createRepo(name, isPrivate = true) {
    const res = await fetch(`${this.base}/user/repos`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        name,
        private: isPrivate,
        description: "CloudPress WordPress site data",
        auto_init: true,
      }),
    });
    return res.ok ? await res.json() : null;
  }
}

class WPCoreStorage extends GitHubStorage {
  constructor() {
    super(null, WP_CORE_OWNER, WP_CORE_REPO, WP_CORE_BRANCH);
  }
}

// ─── 유틸리티 ──────────────────────────────────────────────────────────────

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
function jsonErr(msg, status = 400) { return jsonOk({ error: msg }, status); }

// ─── D1 헬퍼 ──────────────────────────────────────────────────────────────

async function d1Run(db, sql, params = []) {
  try {
    const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
    await stmt.run();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function d1Query(db, sql, params = []) {
  try {
    const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
    const r = await stmt.all();
    return { ok: true, results: r.results || [] };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ─── KV ────────────────────────────────────────────────────────────────────

async function getCached(kv, key) {
  if (!kv) return null;
  try { return await kv.get(key); } catch { return null; }
}
async function setCached(kv, key, value, ttl = 3600) {
  if (!kv) return;
  try { await kv.put(key, value, { expirationTtl: ttl }); } catch {}
}

// ─── WordPress 설치 확인 ───────────────────────────────────────────────────

async function checkInstalled(db, kv) {
  if (await getCached(kv, "wp:installed") === "1") return true;
  if (db) {
    const r = await d1Query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='wp_options' LIMIT 1");
    if (r.ok && r.results.length > 0) {
      await setCached(kv, "wp:installed", "1", 86400);
      return true;
    }
  }
  return false;
}

// ─── WordPress DB 초기화 ───────────────────────────────────────────────────

async function initWordPressDB(db, siteUrl, adminUser, adminPass, adminEmail) {
  if (!db) return false;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const sqls = [
    `CREATE TABLE IF NOT EXISTS wp_options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT UNIQUE NOT NULL, option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes')`,
    `CREATE TABLE IF NOT EXISTS wp_users (ID INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT NOT NULL DEFAULT '', user_pass TEXT NOT NULL DEFAULT '', user_nicename TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL DEFAULT '', user_url TEXT NOT NULL DEFAULT '', user_registered TEXT NOT NULL DEFAULT '', user_status INTEGER NOT NULL DEFAULT 0, display_name TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS wp_usermeta (umeta_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT, meta_value TEXT)`,
    `CREATE TABLE IF NOT EXISTS wp_posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_author INTEGER NOT NULL DEFAULT 0, post_date TEXT NOT NULL DEFAULT '', post_content TEXT NOT NULL DEFAULT '', post_title TEXT NOT NULL DEFAULT '', post_excerpt TEXT NOT NULL DEFAULT '', post_status TEXT NOT NULL DEFAULT 'publish', comment_status TEXT NOT NULL DEFAULT 'open', ping_status TEXT NOT NULL DEFAULT 'open', post_name TEXT NOT NULL DEFAULT '', post_type TEXT NOT NULL DEFAULT 'post', post_modified TEXT NOT NULL DEFAULT '', guid TEXT NOT NULL DEFAULT '', menu_order INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wp_postmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT, meta_value TEXT)`,
    `CREATE TABLE IF NOT EXISTS wp_terms (term_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', term_group INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL DEFAULT 0, taxonomy TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', parent INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wp_term_relationships (object_id INTEGER NOT NULL DEFAULT 0, term_taxonomy_id INTEGER NOT NULL DEFAULT 0, term_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (object_id, term_taxonomy_id))`,
    `CREATE TABLE IF NOT EXISTS wp_comments (comment_ID INTEGER PRIMARY KEY AUTOINCREMENT, comment_post_ID INTEGER NOT NULL DEFAULT 0, comment_author TEXT NOT NULL DEFAULT '', comment_author_email TEXT NOT NULL DEFAULT '', comment_author_url TEXT NOT NULL DEFAULT '', comment_author_IP TEXT NOT NULL DEFAULT '', comment_date TEXT NOT NULL DEFAULT '', comment_content TEXT NOT NULL DEFAULT '', comment_approved TEXT NOT NULL DEFAULT '1', comment_type TEXT NOT NULL DEFAULT 'comment', comment_parent INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wp_commentmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT, meta_value TEXT)`,
    `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('siteurl','${siteUrl}','yes'),('home','${siteUrl}','yes'),('blogname','CloudPress Site','yes'),('blogdescription','WordPress on Cloudflare','yes'),('admin_email','${adminEmail}','yes'),('permalink_structure','/%postname%/','yes'),('template','twentytwentyfour','yes'),('stylesheet','twentytwentyfour','yes'),('active_plugins','','yes'),('blogpublic','1','yes'),('wp_cloudpress_version','4.0','no')`,
    `INSERT OR IGNORE INTO wp_users (user_login,user_pass,user_nicename,user_email,user_url,user_registered,display_name) VALUES ('${adminUser}','${adminPass}','${adminUser}','${adminEmail}','${siteUrl}','${now}','${adminUser}')`,
    `INSERT OR IGNORE INTO wp_usermeta (user_id,meta_key,meta_value) VALUES (1,'wp_capabilities','a:1:{s:13:"administrator";b:1;}')`,
    `INSERT OR IGNORE INTO wp_usermeta (user_id,meta_key,meta_value) VALUES (1,'wp_user_level','10')`,
    `INSERT OR IGNORE INTO wp_posts (post_author,post_date,post_content,post_title,post_status,post_name,post_type,post_modified,guid) VALUES (1,'${now}','CloudPress에 오신 것을 환영합니다!','안녕하세요!','publish','hello-world','post','${now}','${siteUrl}/?p=1')`,
  ];
  for (const sql of sqls) {
    const r = await d1Run(db, sql);
    if (!r.ok) console.warn("[d1-init]", r.error, sql.slice(0, 60));
  }
  return true;
}

// ─── wp-config.php 생성 ────────────────────────────────────────────────────

function buildWpConfig(env, siteUrl) {
  const s = () => crypto.randomUUID().replace(/-/g, "");
  return `<?php
define('DB_NAME','cloudpress');define('DB_USER','cloudpress');define('DB_PASSWORD','');define('DB_HOST','localhost');define('DB_CHARSET','utf8mb4');define('DB_COLLATE','');
define('AUTH_KEY','${s()}');define('SECURE_AUTH_KEY','${s()}');define('LOGGED_IN_KEY','${s()}');define('NONCE_KEY','${s()}');
define('AUTH_SALT','${s()}');define('SECURE_AUTH_SALT','${s()}');define('LOGGED_IN_SALT','${s()}');define('NONCE_SALT','${s()}');
$table_prefix='wp_';
define('WP_DEBUG',false);
define('CLOUDPRESS_WP_CORE_OWNER','WordPress');
define('CLOUDPRESS_WP_CORE_REPO','WordPress');
define('CLOUDPRESS_GITHUB_OWNER','${env.GITHUB_OWNER||""}');
define('CLOUDPRESS_GITHUB_REPO','${env.GITHUB_REPO||""}');
define('CLOUDPRESS_GITHUB_TOKEN','${env.GITHUB_TOKEN||""}');
define('WP_SITEURL','${siteUrl}');define('WP_HOME','${siteUrl}');
define('SQLITE_DB_REALPATH','/tmp/cloudpress.db');
define('DISALLOW_FILE_EDIT',true);define('AUTOMATIC_UPDATER_DISABLED',true);
if(!defined('ABSPATH'))define('ABSPATH',__DIR__.'/');
require_once ABSPATH.'wp-settings.php';
`;
}

// ─── 준비 중 페이지 ─────────────────────────────────────────────────────────

function setupPage(stage = "init") {
  const stageMap = {
    init:      { title: "WordPress 초기화 중", desc: "환경을 구성하고 있습니다.", steps: [1,0,0,0,0] },
    db_ready:  { title: "DB 준비 완료", desc: "WordPress 코어를 확인하는 중...", steps: [1,1,0,0,0] },
    no_github: { title: "GitHub 설정 필요", desc: "GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO 환경변수를 설정해주세요.", steps: [1,1,1,0,0] },
    almost:    { title: "거의 완료!", desc: "WordPress 최초 실행을 준비 중입니다.", steps: [1,1,1,1,0] },
  };
  const info  = stageMap[stage] || stageMap.init;
  const labels = ["환경 구성", "데이터베이스 초기화", "WordPress 코어 연결", "콘텐츠 저장소 연결", "서비스 준비 완료"];
  const stepsHtml = labels.map((label, i) => {
    const done   = info.steps[i] === 1;
    const active = !done && info.steps.slice(0, i).every(s => s === 1) && info.steps[i] === 0 && (i === 0 || info.steps[i-1] === 1);
    const cls    = done ? "done" : active ? "active" : "wait";
    return `<div class="step ${cls}"><div class="dot"></div><span>${label}</span>${done ? '<span class="check">✓</span>' : ''}</div>`;
  }).join("");

  const ghWarn = stage === "no_github"
    ? `<div class="warn">⚠️ GitHub 환경변수 미설정<br><code>GITHUB_TOKEN · GITHUB_OWNER · GITHUB_REPO</code><br>Cloudflare Worker 대시보드에서 설정해주세요.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CloudPress — WordPress 준비 중</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%);
  min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:rgba(255,255,255,.06);backdrop-filter:blur(20px);
  border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:44px 40px;
  max-width:420px;width:90%;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.logo{width:68px;height:68px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);
  border-radius:18px;margin:0 auto 22px;display:flex;align-items:center;
  justify-content:center;font-size:34px;box-shadow:0 8px 32px rgba(99,102,241,.4)}
h1{font-size:20px;font-weight:800;color:#fff;margin-bottom:6px}
.desc{color:rgba(255,255,255,.45);font-size:13px;line-height:1.6;margin-bottom:24px}
.progress{background:rgba(255,255,255,.1);border-radius:100px;height:5px;margin-bottom:24px;overflow:hidden}
.bar{height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:100px;
  animation:bar 2.5s ease-in-out infinite}
@keyframes bar{0%{width:10%;margin-left:0}50%{width:55%;margin-left:25%}100%{width:10%;margin-left:85%}}
.steps{text-align:left;display:flex;flex-direction:column;gap:8px}
.step{display:flex;align-items:center;gap:10px;font-size:13px;color:rgba(255,255,255,.25);padding:8px 12px;border-radius:10px;transition:all .3s}
.step.done{color:rgba(52,211,153,.9);background:rgba(52,211,153,.06)}
.step.active{color:#60a5fa;font-weight:600;background:rgba(59,130,246,.1)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.step.active .dot{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.6)}}
.check{margin-left:auto;font-size:11px}
.warn{margin-top:16px;padding:12px 14px;background:rgba(239,68,68,.1);
  border:1px solid rgba(239,68,68,.25);border-radius:12px;font-size:12px;
  color:#fca5a5;text-align:left;line-height:1.7}
.warn code{font-size:11px;opacity:.8}
.version{position:fixed;bottom:16px;right:20px;font-size:11px;color:rgba(255,255,255,.18)}
</style>
<script>setTimeout(()=>location.reload(),5000)</script>
</head>
<body>
<div class="card">
  <div class="logo">☁️</div>
  <h1>${info.title}</h1>
  <p class="desc">${info.desc}</p>
  <div class="progress"><div class="bar"></div></div>
  <div class="steps">${stepsHtml}</div>
  ${ghWarn}
</div>
<span class="version">CloudPress v4.0 · WordPress/WordPress 공식 코어</span>
</body>
</html>`;
}

// ─── PHP 실행 ────────────────────────────────────────────────────────────────

async function runPhp(phpCode, env, options = {}) {
  try {
    if (env.PHP_RUNNER) {
      return await env.PHP_RUNNER.fetch(new Request("https://php/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: phpCode, env: options.phpEnv || {}, files: options.files || {} }),
      }));
    }
    return new Response("PHP_RUNNER 바인딩이 필요합니다.", { status: 503 });
  } catch (e) {
    return new Response(`PHP 오류: ${e.message}`, { status: 500 });
  }
}

function buildPhpEnv(request, env, url, siteUrl) {
  return {
    WP_HOME: siteUrl, WP_SITEURL: siteUrl,
    GITHUB_OWNER: env.GITHUB_OWNER || "", GITHUB_REPO: env.GITHUB_REPO || "", GITHUB_TOKEN: env.GITHUB_TOKEN || "",
    WP_CORE_OWNER: WP_CORE_OWNER, WP_CORE_REPO: WP_CORE_REPO,
    REQUEST_URI: url.pathname + url.search, REQUEST_METHOD: request.method,
    HTTP_HOST: url.host, SERVER_NAME: url.host, SERVER_PORT: url.port || "443",
    HTTPS: url.protocol === "https:" ? "on" : "off",
    CONTENT_TYPE: request.headers.get("Content-Type") || "",
    HTTP_COOKIE: request.headers.get("Cookie") || "",
    HTTP_AUTHORIZATION: request.headers.get("Authorization") || "",
    HTTP_REFERER: request.headers.get("Referer") || "",
    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language") || "ko",
  };
}

// ─── WordPress 요청 처리 ───────────────────────────────────────────────────

/**
 * WordPress 요청 처리 — php-wasm 기반 진짜 WordPress 실행
 *
 * 아키텍처:
 *   정적 자산: GitHub 미러 or WordPress/WordPress 공식 CDN (immutable 캐시)
 *   PHP 실행:  PHP_RUNNER Service Binding → php-wasm Worker
 *   캐시 전략: L1 Edge Cache → L2 KV Cache → stale-while-revalidate
 *   미러링:    업로드 파일을 GitHub 레포에 실시간 미러링
 */
async function handleWordPressRequest(request, env, ctx) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method.toUpperCase();

  // STATIC 파일 확장자
  const STATIC_EXT = /\.(css|js|mjs|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;

  // ── GitHub 미러 인스턴스 ────────────────────────────────────────────────
  const mirror = {
    token:  env.GITHUB_TOKEN  || "",
    owner:  env.GITHUB_OWNER  || "",
    repo:   env.GITHUB_REPO   || "",
    branch: "main",
    enabled: !!(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO),

    rawUrl(filePath) {
      return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${filePath}`;
    },
    async get(filePath) {
      if (!this.enabled) return null;
      const res = await fetch(this.rawUrl(filePath), {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "CloudPress-Worker/4.0",
        },
        cf: { cacheEverything: true, cacheTtl: 3600 },
      }).catch(() => null);
      return res?.ok ? res : null;
    },
    // 파일을 GitHub 레포에 미러링
    async put(filePath, content, message) {
      if (!this.enabled) return false;
      let b64;
      if (typeof content === "string") {
        const bytes = new TextEncoder().encode(content);
        let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
        b64 = btoa(bin);
      } else {
        const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content;
        let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
        b64 = btoa(bin);
      }
      // 기존 SHA 조회
      let sha;
      const checkRes = await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${filePath}?ref=${this.branch}`,
        { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "CloudPress-Worker/4.0" } }
      ).catch(() => null);
      if (checkRes?.ok) { const d = await checkRes.json(); sha = d.sha; }

      const body = { message: message || `upload: ${filePath}`, content: b64, branch: this.branch };
      if (sha) body.sha = sha;
      const res = await fetch(
        `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${filePath}`,
        { method: "PUT", headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "CloudPress-Worker/4.0" }, body: JSON.stringify(body) }
      ).catch(() => null);
      return res?.ok || false;
    },
  };

  // GitHub 미러 미설정 시 안내
  if (!mirror.enabled) {
    return new Response(setupPage("no_github"), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  // ── KV 캐시 헬퍼 ─────────────────────────────────────────────────────────
  const kv = env.CACHE || env.KV;
  const kvGet = async (key) => { try { return await kv?.get(key); } catch { return null; } };
  const kvSet = async (key, val, ttl = 3600) => { try { await kv?.put(key, val, { expirationTtl: ttl }); } catch {} };
  const kvGetMeta = async (key) => { try { return await kv?.getWithMetadata(key); } catch { return null; } };

  // ── 정적 파일 서빙 ────────────────────────────────────────────────────────
  if (STATIC_EXT.test(path)) {
    const filePath = path.replace(/^\//, "");

    // KV 캐시 확인 (핵심 자산)
    const cacheKey = `static:${filePath}`;
    const cached = await kvGetMeta(cacheKey);
    if (cached?.value) {
      return new Response(cached.value, {
        headers: {
          "Content-Type":  cached.metadata?.ct || mimeByExt(path),
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Cache":       "HIT",
          "ETag":          cached.metadata?.etag || "",
        },
      });
    }

    // wp-content → GitHub 미러 우선
    let res = null;
    if (path.startsWith("/wp-content/")) {
      res = await mirror.get(filePath);
    }

    // WordPress 코어 → jsDelivr CDN → WordPress/WordPress GitHub
    if (!res) {
      for (const base of [
        `https://cdn.jsdelivr.net/npm/wordpress-static@6.7.2`,
        `https://raw.githubusercontent.com/WordPress/WordPress/master`,
      ]) {
        try {
          const r = await fetch(`${base}/${filePath}`, { cf: { cacheEverything: true, cacheTtl: 86400 } });
          if (r.ok) { res = r; break; }
        } catch {}
      }
    }

    if (!res) return new Response("Not Found", { status: 404 });

    const body    = await res.arrayBuffer();
    const ct      = mimeByExt(path);
    const etag    = `"${Date.now().toString(36)}"`;
    const isUploads = path.startsWith("/wp-content/uploads/");

    // 텍스트 파일 KV 저장 (<=2MB)
    if (!isUploads && body.byteLength < 2 * 1024 * 1024 && /\.(css|js|svg|json|xml|txt)$/.test(path)) {
      if (ctx) ctx.waitUntil(
        kv?.put(cacheKey, new TextDecoder().decode(body), {
          expirationTtl: 86400,
          metadata: { ct, etag },
        }).catch(() => {})
      );
    }

    return new Response(body, {
      headers: {
        "Content-Type":  ct,
        "Cache-Control": isUploads
          ? "public, max-age=86400, stale-while-revalidate=604800"
          : "public, max-age=31536000, immutable",
        "ETag":          etag,
        "Vary":          "Accept-Encoding",
        "X-Cache":       "MISS",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // ── PHP 캐시 스킵 조건 ───────────────────────────────────────────────────
  const SKIP_CACHE = ["/wp-admin", "/wp-login.php", "/cart", "/checkout", "/my-account", "/wp-cron.php"];
  const isCacheable = method === "GET"
    && !SKIP_CACHE.some(s => path.startsWith(s))
    && !(request.headers.get("Cookie") || "").includes("wordpress_logged_in");

  // ── KV PHP 캐시 조회 (PHP_RUNNER 유무 관계없이 항상 확인) ─────────────────
  if (isCacheable) {
    const cached = await kvGet(`php:${url.pathname}${url.search}`);
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type":  "text/html; charset=utf-8",
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",
          "X-Cache":       "HIT",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  }

  // ── GitHub _cache/ 정적 HTML 서빙 헬퍼 (PHP Runner 없어도 동작) ──────────
  const serveStaticCache = async () => {
    if (!mirror.enabled) return null;
    const cachePath = (path === "/" || path === "")
      ? "_cache/index.html"
      : `_cache${path.endsWith("/") ? path : path + "/"}index.html`;
    const r = await mirror.get(cachePath);
    if (!r) return null;
    const html = await r.text();
    if (ctx && isCacheable) {
      ctx.waitUntil(kvSet(`php:${url.pathname}${url.search}`, html, 1800));
    }
    return new Response(html, {
      headers: {
        "Content-Type":  "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=1800",
        "X-Cache":       "GH-STATIC",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };

  // ── GitHub Pages 폴백 서빙 헬퍼 ─────────────────────────────────────────
  const serveGhPages = async () => {
    const ghPagesUrl = env.GH_PAGES_URL || "";
    if (!ghPagesUrl) return null;
    try {
      const r = await fetch(`${ghPagesUrl}${path}`, {
        cf: { cacheEverything: true, cacheTtl: 300 },
        headers: { "User-Agent": "CloudPress-Fallback/5.0" },
      });
      if (!r.ok) return null;
      const html = await r.text();
      return new Response(html, {
        headers: {
          "Content-Type":  "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=60",
          "X-Fallback":    "github-pages",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch { return null; }
  };

  // ── PHP_RUNNER가 없는 경우: 정적 캐시 → GitHub Pages 순으로 폴백 ─────────
  if (!env.PHP_RUNNER) {
    const staticRes = await serveStaticCache();
    if (staticRes) return staticRes;

    const ghRes = await serveGhPages();
    if (ghRes) return ghRes;

    // 정적 캐시도 없으면 WordPress 설치 안내 (GitHub Actions 실행 유도)
    const repoUrl = mirror.enabled
      ? `https://github.com/${mirror.owner}/${mirror.repo}`
      : "";
    const actionsUrl = repoUrl
      ? `${repoUrl}/actions/workflows/install-wordpress.yml`
      : "";
    return new Response(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30">
<title>WordPress 준비 중</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Malgun Gothic,sans-serif;
  background:#f0f0f1;display:flex;align-items:center;justify-content:center;
  min-height:100vh;margin:0;padding:20px}
.card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;
  max-width:520px;width:100%;padding:40px;text-align:center}
.icon{font-size:48px;margin-bottom:16px}
h1{color:#1d2327;font-size:20px;font-weight:600;margin:0 0 10px}
p{color:#646970;line-height:1.6;margin:0 0 16px;font-size:14px}
.badge{display:inline-block;background:#f0b849;color:#fff;font-size:11px;
  font-weight:700;padding:3px 10px;border-radius:3px;margin-bottom:14px;letter-spacing:.5px}
a.btn{display:inline-block;background:#2271b1;color:#fff;text-decoration:none;
  padding:8px 18px;border-radius:3px;font-size:13px;font-weight:600;margin:4px}
.steps{text-align:left;background:#f6f7f7;border-radius:4px;padding:16px 20px;
  margin:16px 0;font-size:13px;color:#3c434a;line-height:2}
.steps li{margin:0}
</style></head>
<body><div class="card">
<div class="icon">⚙️</div>
<div class="badge">WORDPRESS INITIALIZING</div>
<h1>WordPress 설치를 완료하는 중입니다</h1>
<p>GitHub Actions 워크플로우가 WordPress를 자동으로 설치합니다.<br>
완료 후 이 페이지가 자동으로 갱신됩니다. (30초마다)</p>
<ol class="steps">
  <li>✅ GitHub 레포지토리 생성 완료</li>
  <li>⏳ GitHub Actions: WordPress 6.7.2 설치 중...</li>
  <li>⏳ GitHub Actions: 정적 캐시 생성 중...</li>
</ol>
${actionsUrl ? `<a class="btn" href="${actionsUrl}" target="_blank">🔄 Actions 진행상황 보기</a>` : ""}
${repoUrl ? `<a class="btn" style="background:#6e7d88" href="${repoUrl}" target="_blank">📁 GitHub 레포 보기</a>` : ""}
<p style="margin-top:16px;font-size:12px;color:#a7aaad">
  CloudPress · 페이지는 30초 후 자동 새로고침됩니다
</p>
</div></body></html>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  // ── PHP 환경변수 구성 ────────────────────────────────────────────────────
  const siteUrl = `${url.protocol}//${url.host}`;
  let postBody  = "";
  if (["POST", "PUT", "PATCH"].includes(method)) {
    postBody = await request.text().catch(() => "");
  }

  // wp-config.php + db.php를 GitHub에서 직접 가져오기
  const [wpConfigRes, dbPhpRes] = await Promise.all([
    mirror.get("wp-config.php"),
    mirror.get("wp-content/db.php"),
  ]);
  const wpConfig = wpConfigRes ? await wpConfigRes.text() : "";
  const dbPhp    = dbPhpRes    ? await dbPhpRes.text()    : "";

  // PHP 파일 경로 결정
  let phpFile = path;
  if (!phpFile || phpFile === "/") phpFile = "/index.php";
  else if (!phpFile.endsWith(".php")) {
    if (phpFile === "/wp-admin" || phpFile === "/wp-admin/") phpFile = "/wp-admin/index.php";
    else if (phpFile.startsWith("/wp-admin/")) phpFile = phpFile.replace(/\/$/, "");
    else phpFile = "/index.php";
  }

  const payload = {
    phpFile,
    phpEnv: {
      WP_HOME:    siteUrl, WP_SITEURL: siteUrl,
      REQUEST_URI:    path + url.search,
      REQUEST_METHOD: method,
      HTTP_HOST:      url.host, SERVER_NAME: url.host,
      SERVER_PORT:    url.port || (url.protocol === "https:" ? "443" : "80"),
      HTTPS:          url.protocol === "https:" ? "on" : "",
      DOCUMENT_ROOT:  "/wordpress",
      SCRIPT_FILENAME: `/wordpress${phpFile}`,
      SCRIPT_NAME:    phpFile,
      PHP_SELF:       phpFile,
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL:   "HTTP/1.1",
      SERVER_SOFTWARE:   "CloudPress/5.0",
      HTTP_COOKIE:          request.headers.get("Cookie")            || "",
      HTTP_USER_AGENT:      request.headers.get("User-Agent")        || "CloudPress",
      HTTP_ACCEPT:          request.headers.get("Accept")            || "*/*",
      HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language")   || "ko-KR,ko;q=0.9",
      HTTP_ACCEPT_ENCODING: request.headers.get("Accept-Encoding")   || "gzip",
      HTTP_REFERER:         request.headers.get("Referer")           || "",
      HTTP_X_FORWARDED_FOR: request.headers.get("CF-Connecting-IP")  || "",
      CONTENT_TYPE:         request.headers.get("Content-Type")      || "",
      CONTENT_LENGTH:       String(postBody.length),
      QUERY_STRING:         url.search.replace(/^\?/, ""),
      GITHUB_OWNER: mirror.owner,
      GITHUB_REPO:  mirror.repo,
      GITHUB_TOKEN: mirror.token,
      CLOUDPRESS_SITE_ID: env.SITE_ID || "",
    },
    stdin:  postBody,
    files: {
      "/wordpress/wp-config.php":     wpConfig,
      "/wordpress/wp-content/db.php": dbPhp,
    },
    siteId:    env.SITE_ID || "",
    skipCache: !isCacheable,
  };

  // ── PHP Runner 호출 (Service Binding) ────────────────────────────────────
  let phpRes = null;
  try {
    phpRes = await env.PHP_RUNNER.fetch(
      new Request("https://php/run-wordpress", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      })
    );
  } catch (e) {
    console.error("[PHP_RUNNER] 호출 실패:", e.message);
  }

  // PHP Runner 실패(5xx, 예외) → _cache/ 정적 HTML 폴백
  if (!phpRes || phpRes.status >= 500) {
    const staticRes = await serveStaticCache();
    if (staticRes) return staticRes;

    const ghRes = await serveGhPages();
    if (ghRes) return ghRes;

    // 모든 폴백 실패: KV stale 캐시 최후 시도
    const stale = await kvGet(`php:${url.pathname}${url.search}`);
    if (stale) {
      return new Response(stale, {
        headers: {
          "Content-Type":  "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=30",
          "X-Fallback":    "kv-stale",
        },
      });
    }

    return new Response(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="15">
<title>일시적 오류</title>
<style>body{font-family:sans-serif;background:#f0f0f1;display:flex;align-items:center;
  justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #c3c4c7;
  border-radius:4px;max-width:440px;padding:40px;text-align:center}
.badge{background:#d63638;color:#fff;font-size:11px;font-weight:700;
  padding:3px 10px;border-radius:3px;display:inline-block;margin-bottom:14px}
h1{color:#1d2327;font-size:20px;margin:0 0 10px}
p{color:#646970;font-size:14px;line-height:1.6;margin:0}</style>
</head><body><div class="card">
<div class="badge">ERROR</div>
<h1>⚠️ 일시적 오류</h1>
<p>WordPress 실행 중 오류가 발생했습니다.<br>15초 후 자동으로 다시 시도합니다.</p>
</div></body></html>`,
      { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  // ── 미디어 업로드 미러링 (POST /wp-json/wp/v2/media) ────────────────────
  if (path === "/wp-json/wp/v2/media" && method === "POST" && phpRes.status === 201 && ctx) {
    ctx.waitUntil((async () => {
      try {
        const body = await phpRes.clone().json();
        const sourceUrl = body?.source_url;
        if (sourceUrl && mirror.enabled) {
          const fileRes = await fetch(sourceUrl).catch(() => null);
          if (fileRes?.ok) {
            const buf  = await fileRes.arrayBuffer();
            const now  = new Date();
            const y    = now.getFullYear();
            const m    = String(now.getMonth() + 1).padStart(2, "0");
            const name = sourceUrl.split("/").pop() || "upload";
            await mirror.put(`wp-content/uploads/${y}/${m}/${name}`, buf, `upload: ${name}`);
          }
        }
      } catch (e) { console.error("[mirror-upload]", e.message); }
    })());
  }

  // ── PHP 출력 KV 캐시 저장 ────────────────────────────────────────────────
  if (phpRes.status === 200 && isCacheable && ctx) {
    const ct = phpRes.headers.get("Content-Type") || "";
    if (ct.includes("text/html")) {
      ctx.waitUntil((async () => {
        const html = await phpRes.clone().text();
        if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
          await kvSet(`php:${url.pathname}${url.search}`, html, 3600);
        }
      })());
    }
  }

  return phpRes;
}

// ─── MIME 타입 (worker.js 내부용) ───────────────────────────────────────────
function mimeByExt(path) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return ({
    css:"text/css;charset=utf-8", js:"application/javascript;charset=utf-8",
    mjs:"application/javascript;charset=utf-8", json:"application/json;charset=utf-8",
    xml:"application/xml;charset=utf-8", svg:"image/svg+xml",
    png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
    webp:"image/webp", avif:"image/avif", ico:"image/x-icon",
    woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf",
    eot:"application/vnd.ms-fontobject", otf:"font/otf",
    pdf:"application/pdf", zip:"application/zip",
    mp4:"video/mp4", webm:"video/webm", mp3:"audio/mpeg",
    ogg:"audio/ogg", wav:"audio/wav", txt:"text/plain;charset=utf-8",
  })[ext] || "application/octet-stream";
}

// ─── JWT 인증 ───────────────────────────────────────────────────────────────

async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, b, sig] = parts;
    const pad = s => s + "=".repeat((4 - s.length % 4) % 4);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = Uint8Array.from(atob(pad(sig.replace(/-/g,"+").replace(/_/g,"/"))), c=>c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${h}.${b}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(pad(b.replace(/-/g,"+").replace(/_/g,"/"))));
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

// ─── API 라우터 (functions/ 핸들러를 worker.js에서 직접 import) ────────────
// Cloudflare Workers(worker.js)는 Pages Functions(functions/)를 자동 실행하지 않으므로
// /api/* 요청을 여기서 직접 라우팅한다.

import { onRequestPost as loginHandler }  from "./functions/api/login.js";
import { onRequestPost as signupHandler, onRequestGet as signupGet } from "./functions/api/signup.js";
import { onRequestPost as logoutHandler } from "./functions/api/logout.js";
import { onRequestGet  as meHandler }     from "./functions/api/me.js";
import { onRequestGet  as healthHandler } from "./functions/api/health.js";
import {
  onRequestGet    as sitesGet,
  onRequestPost   as sitesPost,
  onRequestPut    as sitesPut,
  onRequestDelete as sitesDelete,
} from "./functions/api/sites.js";
import {
  onRequestGet    as accountGet,
  onRequestPut    as accountPut,
} from "./functions/api/account.js";
import {
  onRequestGet    as adminGet,
  onRequestPut    as adminPut,
  onRequestDelete as adminDelete,
} from "./functions/api/admin.js";
import {
  onRequestGet    as cacheGet,
  onRequestPut    as cachePut,
  onRequestDelete as cacheDelete,
} from "./functions/api/cache.js";
import {
  onRequestGet    as domainsGet,
  onRequestPost   as domainsPost,
  onRequestDelete as domainsDelete,
} from "./functions/api/domains.js";
import {
  onRequestGet    as dnsGet,
  onRequestPost   as dnsPost,
  onRequestDelete as dnsDelete,
} from "./functions/api/dns.js";
import {
  onRequestGet    as logsGet,
  onRequestPost   as logsPost,
  onRequestDelete as logsDelete,
} from "./functions/api/logs.js";
import {
  onRequestGet    as sshGet,
  onRequestPost   as sshPost,
  onRequestDelete as sshDelete,
} from "./functions/api/ssh-keys.js";
import {
  onRequestGet as phpVerGet,
  onRequestPut as phpVerPut,
} from "./functions/api/php-versions.js";
import {
  onRequestGet    as backupsGet,
  onRequestPost   as backupsPost,
  onRequestDelete as backupsDelete,
} from "./functions/api/backups.js";
import {
  onRequestGet    as notifyGet,
  onRequestPost   as notifyPost,
} from "./functions/api/notify.js";
import {
  onRequestPost as chatPost,
} from "./functions/api/chat.js";
import {
  onRequestGet    as paymentGet,
  onRequestPost   as paymentPost,
} from "./functions/api/payment.js";
import {
  onRequestGet    as cardsGet,
  onRequestPost   as cardsPost,
  onRequestPatch  as cardsPatch,
  onRequestDelete as cardsDelete,
} from "./functions/api/payment/cards.js";
import { onRequestGet as tossKeyGet } from "./functions/api/payment/toss-key.js";
import {
  onRequestGet    as githubStorageGet,
  onRequestPost   as githubStoragePost,
  onRequestDelete as githubStorageDelete,
} from "./functions/api/github-storage.js";
import {
  onRequestGet    as accountDomainsGet,
  onRequestPost   as accountDomainsPost,
  onRequestPut    as accountDomainsPut,
  onRequestDelete as accountDomainsDelete,
} from "./functions/api/account-domains.js";
import {
  onRequestPost as accountPost,
} from "./functions/api/account.js";
import {
  onRequestGet    as adminInquiriesGet,
  onRequestPut    as adminInquiriesPut,
  onRequestDelete as adminInquiriesDelete,
} from "./functions/api/admin/inquiries.js";
import {
  onRequestGet    as adminAiGet,
  onRequestPost   as adminAiPost,
  onRequestPut    as adminAiPut,
  onRequestDelete as adminAiDelete,
} from "./functions/api/admin/ai-settings.js";
import {
  onRequestGet  as adminCmsGet,
  onRequestPost as adminCmsPost,
} from "./functions/api/admin/cms-settings.js";
import {
  onRequestGet    as editorGet,
  onRequestPost   as editorPost,
} from "./functions/api/editor.js";
import { onRequest as middlewareHandler } from "./functions/_middleware.js";

// Pages-Functions 스타일의 context 객체 생성
function makeContext(request, env, params = {}, workerCtx = null) {
  return {
    request,
    env,
    params,
    _workerCtx: workerCtx, // 실제 Workers ctx (waitUntil용)
    next: async () => new Response("not found", { status: 404 }),
    waitUntil: workerCtx
      ? workerCtx.waitUntil.bind(workerCtx)
      : () => {},
  };
}

// /api/* 라우터
async function handleApiRequest(request, env, _workerCtx = null) {
  const url    = new URL(request.url);
  const path   = url.pathname.replace(/\/$/, ""); // trailing slash 제거
  const method = request.method.toUpperCase();
  // 미들웨어 적용 (CORS, Rate Limit 등)
  // next()가 실제 핸들러를 실행하도록 래핑
  const runWithMiddleware = async (handler) => {
    const ctxWithNext = makeContext(request, env, {}, _workerCtx);
    ctxWithNext.next = async () => {
      try { return await handler(ctxWithNext); }
      catch (e) {
        console.error("[api error]", e);
        return new Response(JSON.stringify({ error: "내부 서버 오류: " + e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    };
    return middlewareHandler(ctxWithNext);
  };

  // ── 인증
  if (path === "/api/login")  return runWithMiddleware(method === "POST" ? loginHandler  : () => jsonErr("Method Not Allowed", 405));
  if (path === "/api/signup") return runWithMiddleware(method === "POST" ? signupHandler : () => jsonErr("Method Not Allowed", 405));
  if (path === "/api/logout") return runWithMiddleware(method === "POST" ? logoutHandler : () => jsonErr("Method Not Allowed", 405));
  if (path === "/api/me")     return runWithMiddleware(method === "GET"  ? meHandler     : () => jsonErr("Method Not Allowed", 405));

  // ── 헬스체크
  if (path === "/api/health") return runWithMiddleware(healthHandler);

  // ── 사이트 관리
  if (path === "/api/sites") {
    if (method === "GET")    return runWithMiddleware(sitesGet);
    if (method === "POST")   return runWithMiddleware(sitesPost);
    if (method === "PUT")    return runWithMiddleware(sitesPut);
    if (method === "DELETE") return runWithMiddleware(sitesDelete);
  }

  // ── 계정
  if (path === "/api/account") {
    if (method === "GET") return runWithMiddleware(accountGet);
    if (method === "PUT") return runWithMiddleware(accountPut);
  }

  // ── 관리자 서브경로 (구체적인 경로 먼저, startsWith보다 앞에 위치해야 함)
  if (path === "/api/admin/inquiries" || path.startsWith("/api/admin/inquiries/")) {
    if (method === "GET")    return runWithMiddleware(adminInquiriesGet);
    if (method === "PUT")    return runWithMiddleware(adminInquiriesPut);
    if (method === "DELETE") return runWithMiddleware(adminInquiriesDelete);
  }
  if (path === "/api/admin/ai-settings") {
    if (method === "GET")    return runWithMiddleware(adminAiGet);
    if (method === "POST")   return runWithMiddleware(adminAiPost);
    if (method === "PUT")    return runWithMiddleware(adminAiPut);
    if (method === "DELETE") return runWithMiddleware(adminAiDelete);
  }
  if (path === "/api/admin/cms-settings") {
    if (method === "GET")  return runWithMiddleware(adminCmsGet);
    if (method === "POST") return runWithMiddleware(adminCmsPost);
  }

  // ── 관리자 (stats, users, sites, settings, quota-stats)
  if (path.startsWith("/api/admin")) {
    if (method === "GET")    return runWithMiddleware(adminGet);
    if (method === "PUT")    return runWithMiddleware(adminPut);
    if (method === "DELETE") return runWithMiddleware(adminDelete);
  }

  // ── 캐시
  if (path === "/api/cache") {
    if (method === "GET")    return runWithMiddleware(cacheGet);
    if (method === "PUT")    return runWithMiddleware(cachePut);
    if (method === "DELETE") return runWithMiddleware(cacheDelete);
  }

  // ── 도메인
  if (path === "/api/domains") {
    if (method === "GET")    return runWithMiddleware(domainsGet);
    if (method === "POST")   return runWithMiddleware(domainsPost);
    if (method === "DELETE") return runWithMiddleware(domainsDelete);
  }

  // ── DNS
  if (path === "/api/dns") {
    if (method === "GET")    return runWithMiddleware(dnsGet);
    if (method === "POST")   return runWithMiddleware(dnsPost);
    if (method === "DELETE") return runWithMiddleware(dnsDelete);
  }

  // ── 로그
  if (path === "/api/logs") {
    if (method === "GET")    return runWithMiddleware(logsGet);
    if (method === "POST")   return runWithMiddleware(logsPost);
    if (method === "DELETE") return runWithMiddleware(logsDelete);
  }

  // ── SSH 키
  if (path === "/api/ssh-keys" || path.startsWith("/api/ssh-keys/")) {
    if (method === "GET")    return runWithMiddleware(sshGet);
    if (method === "POST")   return runWithMiddleware(sshPost);
    if (method === "DELETE") return runWithMiddleware(sshDelete);
  }

  // ── PHP 버전
  if (path === "/api/php-versions") {
    if (method === "GET") return runWithMiddleware(phpVerGet);
    if (method === "PUT") return runWithMiddleware(phpVerPut);
  }

  // ── 백업
  if (path === "/api/backups" || path.startsWith("/api/backups/")) {
    if (method === "GET")    return runWithMiddleware(backupsGet);
    if (method === "POST")   return runWithMiddleware(backupsPost);
    if (method === "DELETE") return runWithMiddleware(backupsDelete);
  }

  // ── 알림
  if (path === "/api/notify" || path.startsWith("/api/notify/")) {
    if (method === "GET")  return runWithMiddleware(notifyGet);
    if (method === "POST") return runWithMiddleware(notifyPost);
  }

  // ── 챗봇
  if (path === "/api/chat" || path.startsWith("/api/chat/")) {
    if (method === "POST") return runWithMiddleware(chatPost);
  }

  // ── 결제
  if (path === "/api/payment" || path.startsWith("/api/payment/")) {
    // cards 서브경로
    if (path === "/api/payment/cards") {
      if (method === "GET")    return runWithMiddleware(cardsGet);
      if (method === "POST")   return runWithMiddleware(cardsPost);
      if (method === "PATCH")  return runWithMiddleware(cardsPatch);
      if (method === "DELETE") return runWithMiddleware(cardsDelete);
    }
    // toss-key
    if (path === "/api/payment/toss-key") {
      if (method === "GET") return runWithMiddleware(tossKeyGet);
    }
    // 나머지 결제 (history, site-plan, client-key, request, confirm)
    if (method === "GET")  return runWithMiddleware(paymentGet);
    if (method === "POST") return runWithMiddleware(paymentPost);
  }

  // ── GitHub 스토리지
  if (path === "/api/github-storage" || path.startsWith("/api/github-storage/")) {
    if (method === "GET")    return runWithMiddleware(githubStorageGet);
    if (method === "POST")   return runWithMiddleware(githubStoragePost);
    if (method === "DELETE") return runWithMiddleware(githubStorageDelete);
  }

  // ── 계정 도메인
  if (path === "/api/account-domains" || path.startsWith("/api/account-domains/")) {
    if (method === "GET")    return runWithMiddleware(accountDomainsGet);
    if (method === "POST")   return runWithMiddleware(accountDomainsPost);
    if (method === "PUT")    return runWithMiddleware(accountDomainsPut);
    if (method === "DELETE") return runWithMiddleware(accountDomainsDelete);
  }

  // ── 계정 비밀번호 변경 (POST)
  if (path === "/api/account/password" || (path === "/api/account" && method === "POST")) {
    return runWithMiddleware(accountPost);
  }

  // ── 코드 에디터
  if (path.startsWith("/api/editor/")) {
    if (method === "GET")  return runWithMiddleware(editorGet);
    if (method === "POST") return runWithMiddleware(editorPost);
  }

  return jsonErr("API 경로를 찾을 수 없습니다.", 404);
}

// ─── 메인 핸들러 ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      }});
    }

    // ── /api/* 는 항상 API 라우터로 (WordPress/ASSETS보다 우선)
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, ctx);
    }

    // ── 플랫폼 정적 파일 (대시보드 HTML/CSS/JS) — WordPress보다 우선
    const platformPages = [
      '/dashboard', '/hosting', '/hosting-create', '/hosting-detail',
      '/domains', '/dns', '/traffic', '/storage', '/editor',
      '/account', '/payment', '/payment-success', '/pricing',
      '/login', '/signup', '/admin', '/admin-users', '/admin-sites',
      '/admin-inquiries', '/admin-settings', '/about', '/contact',
      '/features', '/faq',
    ];
    // .html/.css/.js/정적파일은 그대로 ASSETS
    const isStaticAsset =
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js') ||
      url.pathname.startsWith('/src/') ||
      url.pathname.startsWith('/favicon') ||
      url.pathname === '/';
    if (isStaticAsset && env.ASSETS) return env.ASSETS.fetch(request);

    // .html 없는 플랫폼 경로 → .html 붙여서 ASSETS로 서빙 (리디렉션 없이)
    if (platformPages.includes(url.pathname) && env.ASSETS) {
      const htmlUrl = new URL(request.url);
      htmlUrl.pathname = url.pathname + '.html';
      return env.ASSETS.fetch(new Request(htmlUrl.toString(), request));
    }

    // ── WordPress 사이트 서빙 (php-wasm + GitHub 미러링)
    if (env.GITHUB_OWNER && env.GITHUB_REPO) {
      return handleWordPressRequest(request, env, ctx);
    }

    // ── 플랫폼 정적 파일 (폴백)
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("CloudPress WordPress Hosting Platform v4.0", {
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  },
};
