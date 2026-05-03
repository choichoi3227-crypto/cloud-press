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

async function handleWordPressRequest(request, env) {
  const url    = new URL(request.url);
  const userGh = (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO)
    ? new GitHubStorage(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO)
    : null;
  const coreGh = new WPCoreStorage();

  if (!userGh) {
    return new Response(setupPage("no_github"), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  const staticExt = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map)$/i;

  // 정적 파일: wp-content → 사용자 repo, 그 외 → 공식 코어
  if (staticExt.test(url.pathname)) {
    if (url.pathname.startsWith("/wp-content/")) {
      const f = await userGh.fetchRaw(url.pathname.slice(1));
      if (f) return f;
    }
    const coreFile = await coreGh.fetchRaw(url.pathname.replace(/^\//, ""));
    if (coreFile) return coreFile;
    return new Response("Not Found", { status: 404 });
  }

  // 미디어
  if (url.pathname.startsWith("/wp-content/uploads/")) {
    const f = await userGh.fetchRaw(url.pathname.slice(1));
    if (f) return f;
    return new Response("미디어 없음", { status: 404 });
  }

  const installed = await checkInstalled(env.DB, env.KV);
  if (!installed) {
    return new Response(setupPage("init"), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  // 공식 코어 접근 확인
  const coreReady = await coreGh.exists("wp-load.php");
  if (!coreReady) {
    return new Response(setupPage("db_ready"), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  // KV 페이지 캐시
  const cacheKey = `page:${url.pathname}${url.search}`;
  if (request.method === "GET" && env.CACHE) {
    const cached = await getCached(env.CACHE, cacheKey);
    if (cached) return new Response(cached, { headers: { "Content-Type": "text/html;charset=utf-8", "X-Cache": "HIT" } });
  }

  const siteUrl = `${url.protocol}//${url.host}`;
  const phpEnv  = buildPhpEnv(request, env, url, siteUrl);
  const wpConf  = buildWpConfig(env, siteUrl);

  // wp-login / wp-admin → 공식 코어
  if (url.pathname === "/wp-login.php" || url.pathname.startsWith("/wp-admin")) {
    const phpFile = url.pathname === "/wp-login.php" ? "wp-login.php" : url.pathname.slice(1);
    const phpRes  = await coreGh.getFile(phpFile);
    if (!phpRes) return new Response("WordPress 코어 파일 없음", { status: 503 });
    return runPhp(phpRes.text, env, { phpEnv, files: { "/wordpress/wp-config.php": wpConf } });
  }

  // 일반 PHP → 공식 코어
  let phpPath = url.pathname;
  if (!phpPath || phpPath === "/") phpPath = "/index.php";
  if (!phpPath.endsWith(".php")) phpPath = phpPath.replace(/\/$/, "") + "/index.php";

  const phpFile = phpPath.replace(/^\//, "");
  const phpRes  = (await coreGh.getFile(phpFile).catch(() => null)) || (await coreGh.getFile("index.php"));
  if (!phpRes) {
    return new Response(setupPage("almost"), { headers: { "Content-Type": "text/html;charset=utf-8" } });
  }

  const response = await runPhp(phpRes.text, env, { phpEnv, files: { "/wordpress/wp-config.php": wpConf } });

  // 성공 캐시
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

    // ── 헬스체크
    if (url.pathname === "/api/health") {
      const coreGh = new WPCoreStorage();
      const coreOk = await coreGh.exists("wp-load.php").catch(()=>false);
      return jsonOk({
        status: "ok", version: "4.0.0",
        wp_core: `${WP_CORE_OWNER}/${WP_CORE_REPO} (공식)`,
        wp_core_accessible: coreOk,
        user_repo: env.GITHUB_OWNER && env.GITHUB_REPO ? `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` : "미설정",
        bindings: { DB:!!env.DB, KV:!!env.KV, CACHE:!!env.CACHE, PHP_RUNNER:!!env.PHP_RUNNER },
        ts: new Date().toISOString(),
      });
    }

    // ── WordPress DB 초기화
    if (url.pathname === "/api/wp-init" && method === "POST") {
      const token = (request.headers.get("Authorization")||"").replace("Bearer ","");
      const secret = env.JWT_SECRET || env.CLOUDPRESS_SECRET || "";
      if (secret && !(await verifyJWT(token, secret))) return jsonErr("인증 필요", 401);
      let body = {};
      try { body = await request.json(); } catch {}
      if (!env.DB) return jsonErr("DB 바인딩 없음", 503);
      const ok = await initWordPressDB(
        env.DB,
        body.site_url    || `https://${url.host}`,
        body.admin_user  || env.WP_ADMIN_USER  || "admin",
        body.admin_pass  || "changeme",
        body.admin_email || env.WP_ADMIN_EMAIL || "admin@example.com"
      );
      if (ok) {
        await setCached(env.KV, "wp:installed", "1", 86400*365);
        return jsonOk({ success:true, message:"WordPress DB 초기화 완료" });
      }
      return jsonErr("DB 초기화 실패", 500);
    }

    // ── 캐시 퍼지
    if (url.pathname === "/api/cache-purge" && method === "POST") {
      await env.KV?.delete("wp:installed").catch(()=>{});
      return jsonOk({ success:true, message:"캐시 퍼지 완료" });
    }

    // ── GitHub 저장소 초기화 (호스팅 생성 시)
    if (url.pathname === "/api/github-init" && method === "POST") {
      const token = (request.headers.get("Authorization")||"").replace("Bearer ","");
      const secret = env.JWT_SECRET || env.CLOUDPRESS_SECRET || "";
      if (secret && !(await verifyJWT(token, secret))) return jsonErr("인증 필요", 401);
      let body = {};
      try { body = await request.json(); } catch {}
      const { repo_name, github_token, github_owner } = body;
      const ghToken = github_token || env.GITHUB_TOKEN;
      const ghOwner = github_owner || env.GITHUB_OWNER;
      if (!repo_name || !ghToken || !ghOwner) return jsonErr("repo_name, github_token, github_owner 필요", 400);

      const gh = new GitHubStorage(ghToken, ghOwner, repo_name);
      const created = await gh.createRepo(repo_name, true);
      if (!created) return jsonErr("GitHub 저장소 생성 실패", 500);

      // 저장소 초기화 대기 후 README 작성
      await new Promise(r => setTimeout(r, 2500));
      const gh2 = new GitHubStorage(ghToken, ghOwner, repo_name, "main");
      await gh2.putFile(
        "README.md",
        `# CloudPress: ${repo_name}\n\n이 저장소는 CloudPress WordPress 사이트의 사용자 데이터를 저장합니다.\n\n## 구조\n- \`wp-content/uploads/\` — 미디어 파일\n- \`wp-content/themes/\` — 커스텀 테마\n- \`wp-content/plugins/\` — 커스텀 플러그인\n\n## WordPress 코어\nWordPress 코어 파일은 [WordPress/WordPress](https://github.com/WordPress/WordPress) 공식 레포지토리에서 직접 제공됩니다.\n`,
        "Initialize CloudPress site repository",
        null
      );

      // wp-content 폴더 구조 초기화
      const folders = [
        ["wp-content/uploads/.gitkeep", ""],
        ["wp-content/themes/.gitkeep",  ""],
        ["wp-content/plugins/.gitkeep", ""],
      ];
      for (const [path, content] of folders) {
        await gh2.putFile(path, content, `Init ${path}`, null).catch(()=>{});
        await new Promise(r => setTimeout(r, 500));
      }

      return jsonOk({
        success: true,
        message: "GitHub 저장소가 생성되었습니다.",
        repo_url: created.html_url,
        repo_name: created.name,
        owner: created.owner?.login,
      });
    }

    // ── WordPress 사이트 서빙
    if (env.GITHUB_OWNER && env.GITHUB_REPO) {
      return handleWordPressRequest(request, env);
    }

    // ── 플랫폼 정적 파일
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("CloudPress WordPress Hosting Platform v4.0", {
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  },
};
