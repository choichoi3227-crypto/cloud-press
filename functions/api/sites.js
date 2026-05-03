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
  formData.append(
    "metadata",
    JSON.stringify({
      main_module:         "worker.js",
      compatibility_date:  "2025-04-01",
      compatibility_flags: ["nodejs_compat"],
      bindings:            allBindings,
    })
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
      },
      body: formData,
    }
  );
  const data = await res.json();
  return data.success === true;
}

// ── 사이트 Worker 스크립트 생성 ─────────────────────────────────────────────
// 플랫폼 worker.js의 핵심 로직을 각 사이트에 맞게 빌드
// (GITHUB_OWNER, GITHUB_REPO, SITE_ID는 wrangler 바인딩으로도 주입되지만
//  fallback으로 하드코딩도 포함)

function buildSiteWorkerScript({ siteId, githubOwner, githubRepo }) {
  // CloudPress v4.0: WordPress 공식 레포 코어 + 사용자 개인 레포 데이터
  return `/**
 * CloudPress WordPress Worker v4.0
 * Site: ${siteId}
 * WP Core: WordPress/WordPress (공식)
 * User Data: ${githubOwner}/${githubRepo}
 */
const WP_CORE_OWNER = "WordPress";
const WP_CORE_REPO  = "WordPress";
const WP_CORE_BRANCH = "master";

class GitHubStorage {
  constructor(token, owner, repo, branch = "main") {
    this.token = token; this.owner = owner; this.repo = repo; this.branch = branch;
    this.base = "https://api.github.com";
  }
  _headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "CloudPress-Worker/4.0", ...extra };
    if (this.token) h.Authorization = \`Bearer \${this.token}\`;
    return h;
  }
  rawUrl(path) { return \`https://raw.githubusercontent.com/\${this.owner}/\${this.repo}/\${this.branch}/\${path}\`; }
  async fetchRaw(path) { const r = await fetch(this.rawUrl(path), { headers: this._headers() }); return r.ok ? r : null; }
  async getFile(path) {
    const r = await fetch(\`\${this.base}/repos/\${this.owner}/\${this.repo}/contents/\${path}?ref=\${this.branch}\`, { headers: this._headers() });
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.content) return { text: atob(d.content.replace(/\\n/g, "")), sha: d.sha };
    return null;
  }
  async exists(path) {
    const r = await fetch(\`\${this.base}/repos/\${this.owner}/\${this.repo}/contents/\${path}?ref=\${this.branch}\`, { method: "HEAD", headers: this._headers() });
    return r.ok;
  }
}
class WPCoreStorage extends GitHubStorage { constructor() { super(null, WP_CORE_OWNER, WP_CORE_REPO, WP_CORE_BRANCH); } }

function jsonOk(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
async function getCached(kv, k) { if (!kv) return null; try { return await kv.get(k); } catch { return null; } }
async function setCached(kv, k, v, t = 3600) { if (!kv) return; try { await kv.put(k, v, { expirationTtl: t }); } catch {} }

async function checkInstalled(db, kv) {
  if (await getCached(kv, "wp:installed") === "1") return true;
  if (db) { const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wp_options' LIMIT 1").all(); if (r.results?.length) { await setCached(kv, "wp:installed", "1", 86400); return true; } }
  return false;
}

function setupPage(stage = "init") {
  const titles = { init: "WordPress 초기화 중", db_ready: "DB 준비 완료 — 코어 확인 중", no_github: "GitHub 설정 필요", almost: "거의 완료!" };
  const t = titles[stage] || titles.init;
  const isNoGh = stage === "no_github";
  return \`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CloudPress — \${t}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:44px 40px;max-width:400px;width:90%;text-align:center}.logo{width:64px;height:64px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border-radius:16px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:32px}h1{color:#fff;font-size:20px;font-weight:800;margin-bottom:8px}.desc{color:rgba(255,255,255,.45);font-size:13px;margin-bottom:24px}.prog{background:rgba(255,255,255,.1);border-radius:100px;height:5px;overflow:hidden;margin-bottom:8px}.bar{height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:100px;animation:b 2.5s ease-in-out infinite}@keyframes b{0%{width:10%;margin-left:0}50%{width:55%;margin-left:25%}100%{width:10%;margin-left:85%}}.note{font-size:12px;color:rgba(255,255,255,.25);margin-top:16px}\${isNoGh?\`.warn{margin-top:16px;padding:12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:12px;font-size:12px;color:#fca5a5;text-align:left;line-height:1.7}\`:\"\"}</style>
<script>setTimeout(()=>location.reload(),5000)</script></head>
<body><div class="card"><div class="logo">☁️</div><h1>\${t}</h1>
<p class="desc">\${isNoGh?"GITHUB_TOKEN · GITHUB_OWNER · GITHUB_REPO 환경변수를 설정해주세요.":"WordPress를 준비하고 있습니다. 잠시만 기다려주세요."}</p>
<div class="prog"><div class="bar"></div></div>
<p class="note">CloudPress v4.0 · WordPress/WordPress 공식 코어</p>
\${isNoGh?\`<div class="warn">⚠️ GitHub 환경변수 미설정<br><code>GITHUB_TOKEN · GITHUB_OWNER · GITHUB_REPO</code><br>Cloudflare Worker 대시보드 → Settings → Variables</div>\`:\"\"}</div></body></html>\`;
}

async function runPhp(code, env, opts = {}) {
  if (env.PHP_RUNNER) return env.PHP_RUNNER.fetch(new Request("https://php/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, env: opts.phpEnv || {}, files: opts.files || {} }) }));
  return new Response("PHP_RUNNER 바인딩 필요", { status: 503 });
}

function buildWpConf(env, siteUrl) {
  const s = () => crypto.randomUUID().replace(/-/g,"");
  return \`<?php define('DB_NAME','cloudpress');define('DB_USER','cloudpress');define('DB_PASSWORD','');define('DB_HOST','localhost');define('DB_CHARSET','utf8mb4');define('DB_COLLATE','');define('AUTH_KEY','\${s()}');define('SECURE_AUTH_KEY','\${s()}');define('LOGGED_IN_KEY','\${s()}');define('NONCE_KEY','\${s()}');define('AUTH_SALT','\${s()}');define('SECURE_AUTH_SALT','\${s()}');define('LOGGED_IN_SALT','\${s()}');define('NONCE_SALT','\${s()}');$table_prefix='wp_';define('WP_DEBUG',false);define('CLOUDPRESS_WP_CORE_OWNER','WordPress');define('CLOUDPRESS_WP_CORE_REPO','WordPress');define('CLOUDPRESS_GITHUB_OWNER','\${env.GITHUB_OWNER||""}');define('CLOUDPRESS_GITHUB_REPO','\${env.GITHUB_REPO||""}');define('CLOUDPRESS_GITHUB_TOKEN','\${env.GITHUB_TOKEN||""}');define('WP_SITEURL','\${siteUrl}');define('WP_HOME','\${siteUrl}');define('SQLITE_DB_REALPATH','/tmp/cloudpress.db');define('DISALLOW_FILE_EDIT',true);define('AUTOMATIC_UPDATER_DISABLED',true);if(!defined('ABSPATH'))define('ABSPATH',__DIR__.'/');require_once ABSPATH.'wp-settings.php';\`;
}

function buildPhpEnv(req, env, url, siteUrl) {
  return { WP_HOME:siteUrl,WP_SITEURL:siteUrl,GITHUB_OWNER:env.GITHUB_OWNER||"",GITHUB_REPO:env.GITHUB_REPO||"",GITHUB_TOKEN:env.GITHUB_TOKEN||"",WP_CORE_OWNER:"WordPress",WP_CORE_REPO:"WordPress",REQUEST_URI:url.pathname+url.search,REQUEST_METHOD:req.method,HTTP_HOST:url.host,SERVER_NAME:url.host,HTTPS:url.protocol==="https:"?"on":"off",CONTENT_TYPE:req.headers.get("Content-Type")||"",HTTP_COOKIE:req.headers.get("Cookie")||"",HTTP_AUTHORIZATION:req.headers.get("Authorization")||"" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization" } });

    if (url.pathname === "/api/health") return jsonOk({ status:"ok",version:"4.0.0",wp_core:"WordPress/WordPress (공식)",ts:new Date().toISOString() });

    const userGh = (env.GITHUB_TOKEN&&env.GITHUB_OWNER&&env.GITHUB_REPO) ? new GitHubStorage(env.GITHUB_TOKEN,env.GITHUB_OWNER,env.GITHUB_REPO) : null;
    const coreGh = new WPCoreStorage();

    if (!userGh) return new Response(setupPage("no_github"), { headers:{"Content-Type":"text/html;charset=utf-8"} });

    const staticExt = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map)$/i;
    if (staticExt.test(url.pathname)) {
      if (url.pathname.startsWith("/wp-content/")) { const f = await userGh.fetchRaw(url.pathname.slice(1)); if (f) return f; }
      const f = await coreGh.fetchRaw(url.pathname.replace(/^\//,"")); if (f) return f;
      return new Response("Not Found",{status:404});
    }
    if (url.pathname.startsWith("/wp-content/uploads/")) { const f = await userGh.fetchRaw(url.pathname.slice(1)); if (f) return f; return new Response("미디어 없음",{status:404}); }

    const installed = await checkInstalled(env.DB, env.KV);
    if (!installed) return new Response(setupPage("init"),{headers:{"Content-Type":"text/html;charset=utf-8"}});
    const coreReady = await coreGh.exists("wp-load.php");
    if (!coreReady) return new Response(setupPage("db_ready"),{headers:{"Content-Type":"text/html;charset=utf-8"}});

    const siteUrl = \`\${url.protocol}//\${url.host}\`;
    const phpEnv = buildPhpEnv(request,env,url,siteUrl);
    const wpConf = buildWpConf(env,siteUrl);

    const cacheKey = \`page:\${url.pathname}\${url.search}\`;
    if (request.method==="GET"&&env.CACHE) { const c = await getCached(env.CACHE,cacheKey); if (c) return new Response(c,{headers:{"Content-Type":"text/html;charset=utf-8","X-Cache":"HIT"}}); }

    if (url.pathname==="/wp-login.php"||url.pathname.startsWith("/wp-admin")) {
      const pf = url.pathname==="/wp-login.php"?"wp-login.php":url.pathname.slice(1);
      const pr = await coreGh.getFile(pf); if (!pr) return new Response("WordPress 코어 파일 없음",{status:503});
      return runPhp(pr.text,env,{phpEnv,files:{"/wordpress/wp-config.php":wpConf}});
    }

    let pp = url.pathname;
    if (!pp||pp==="/") pp="/index.php";
    if (!pp.endsWith(".php")) pp=pp.replace(/\/$/,"")+"/index.php";
    const pr = (await coreGh.getFile(pp.replace(/^\/\/,"")).catch(()=>null))||(await coreGh.getFile("index.php"));
    if (!pr) return new Response(setupPage("almost"),{headers:{"Content-Type":"text/html;charset=utf-8"}});

    const resp = await runPhp(pr.text,env,{phpEnv,files:{"/wordpress/wp-config.php":wpConf}});
    if (request.method==="GET"&&resp.status===200&&env.CACHE) {
      const ct=resp.headers.get("Content-Type")||"";
      if (ct.includes("text/html")) { const h=await resp.clone().text(); if (!h.includes("logged-in")&&!url.pathname.startsWith("/wp-admin")) await setCached(env.CACHE,cacheKey,h,3600); }
    }
    return resp;
  }
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

  // 기본 디렉터리 구조 초기화
  const initFiles = [
    { path: "uploads/.gitkeep",               content: "" },
    { path: "wp-content/themes/.gitkeep",     content: "" },
    { path: "wp-content/plugins/.gitkeep",    content: "" },
    { path: "wp-core/.gitkeep",               content: "" },
    { path: "README.md",
      content: `# CloudPress Site: ${siteName}\n\nSite ID: ${siteId}\nCreated: ${new Date().toISOString()}\n\n## Directory Structure\n- \`uploads/\` - WordPress media uploads\n- \`wp-content/themes/\` - WordPress themes\n- \`wp-content/plugins/\` - WordPress plugins\n- \`wp-core/\` - WordPress core files\n` },
  ];

  for (const file of initFiles) {
    await uploadFileToGithub(token, owner, repoName, file.path, file.content, `init: ${file.path}`)
      .catch(e => console.warn(`[github] init file failed: ${file.path}`, e.message));
    await new Promise(r => setTimeout(r, 200));
  }

  return { owner, repoName, token };
}

// ── WordPress D1 초기화 SQL ────────────────────────────────────────────────

function buildWpInitSql(siteId, domain, adminUser, adminPass, adminEmail) {
  const now     = new Date().toISOString().slice(0, 19).replace("T", " ");
  const siteUrl = `https://${domain}`;
  return `
CREATE TABLE IF NOT EXISTS wp_options (
  option_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name  TEXT UNIQUE NOT NULL,
  option_value TEXT NOT NULL DEFAULT '',
  autoload     TEXT NOT NULL DEFAULT 'yes'
);
CREATE TABLE IF NOT EXISTS wp_users (
  ID              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login      TEXT NOT NULL DEFAULT '',
  user_pass       TEXT NOT NULL DEFAULT '',
  user_nicename   TEXT NOT NULL DEFAULT '',
  user_email      TEXT NOT NULL DEFAULT '',
  user_url        TEXT NOT NULL DEFAULT '',
  user_registered TEXT NOT NULL DEFAULT '',
  user_status     INTEGER NOT NULL DEFAULT 0,
  display_name    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS wp_usermeta (
  umeta_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT,
  meta_value TEXT
);
CREATE TABLE IF NOT EXISTS wp_posts (
  ID                INTEGER PRIMARY KEY AUTOINCREMENT,
  post_author       INTEGER NOT NULL DEFAULT 0,
  post_date         TEXT NOT NULL DEFAULT '',
  post_content      TEXT NOT NULL DEFAULT '',
  post_title        TEXT NOT NULL DEFAULT '',
  post_status       TEXT NOT NULL DEFAULT 'publish',
  post_name         TEXT NOT NULL DEFAULT '',
  post_type         TEXT NOT NULL DEFAULT 'post',
  post_modified     TEXT NOT NULL DEFAULT '',
  guid              TEXT NOT NULL DEFAULT '',
  menu_order        INTEGER NOT NULL DEFAULT 0,
  comment_count     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_postmeta (
  meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT,
  meta_value TEXT
);
CREATE TABLE IF NOT EXISTS wp_terms (
  term_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  slug       TEXT NOT NULL DEFAULT '',
  term_group INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
  term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id          INTEGER NOT NULL DEFAULT 0,
  taxonomy         TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  parent           INTEGER NOT NULL DEFAULT 0,
  count            INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_term_relationships (
  object_id        INTEGER NOT NULL DEFAULT 0,
  term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
  term_order       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, term_taxonomy_id)
);
CREATE TABLE IF NOT EXISTS wp_comments (
  comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_post_ID      INTEGER NOT NULL DEFAULT 0,
  comment_author       TEXT NOT NULL DEFAULT '',
  comment_author_email TEXT NOT NULL DEFAULT '',
  comment_date         TEXT NOT NULL DEFAULT '',
  comment_content      TEXT NOT NULL DEFAULT '',
  comment_approved     TEXT NOT NULL DEFAULT '1',
  comment_type         TEXT NOT NULL DEFAULT 'comment',
  comment_parent       INTEGER NOT NULL DEFAULT 0,
  user_id              INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_commentmeta (
  meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL DEFAULT 0,
  meta_key   TEXT,
  meta_value TEXT
);

INSERT OR IGNORE INTO wp_options (option_name, option_value) VALUES
  ('siteurl',               '${siteUrl}'),
  ('home',                  '${siteUrl}'),
  ('blogname',              '${domain}'),
  ('blogdescription',       'WordPress on Cloudflare'),
  ('admin_email',           '${adminEmail}'),
  ('permalink_structure',   '/%postname%/'),
  ('template',              'twentytwentyfour'),
  ('stylesheet',            'twentytwentyfour'),
  ('active_plugins',        ''),
  ('wp_user_roles',         ''),
  ('blogpublic',            '1'),
  ('wp_cloudpress_version', '3.1'),
  ('site_id',               '${siteId}');

INSERT OR IGNORE INTO wp_users
  (user_login, user_pass, user_nicename, user_email, user_url, user_registered, display_name)
VALUES
  ('${adminUser}', '${adminPass}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', '${adminUser}');

INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value)
VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}');

INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value)
VALUES (1, 'wp_user_level', '10');

INSERT OR IGNORE INTO wp_posts
  (post_author, post_date, post_content, post_title, post_status, post_name, post_type, post_modified, guid)
VALUES
  (1, '${now}', 'CloudPress에 오신 것을 환영합니다!', '안녕하세요!', 'publish', 'hello-world', 'post', '${now}', '${siteUrl}/?p=1');
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

        // D1 batch API로 SQL 실행
        const sqlRes = await cf.post(
          `/accounts/${cfAccountId}/d1/database/${d1Id}/query`,
          { sql: initSql }
        );
        if (sqlRes.success) await log("WordPress DB 초기화 완료");
        else                await log("WordPress DB 초기화 실패: " + JSON.stringify(sqlRes.errors), "warning");
      }

      // 7) GitHub에 WordPress 파일 백그라운드 업로드
      if (githubOwner && githubRepoName && activeGhToken) {
        await log("GitHub에 WordPress 파일 업로드 예약...");
        // 백그라운드에서 실제 WordPress 코어 파일 업로드
        // (타임아웃 방지 - github-storage.js의 배치 업로드 활용)
        uploadWordPressFilesBackground(
          activeGhToken, githubOwner, githubRepoName, id, log
        ).catch(e => log(`WordPress 파일 업로드 오류: ${e.message}`, "warning"));
        await log("WordPress 파일 업로드가 백그라운드에서 진행됩니다. 완료까지 10~15분 소요됩니다.");
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
    note:           "D1/KV가 Worker에 자동으로 바인딩됩니다. WordPress 파일 업로드는 백그라운드에서 진행됩니다.",
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
