/**
 * CloudPress WordPress Worker v6.1
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * PHP-FREE WordPress SaaS Engine
 * - D1(SQLite) 기반 완전한 WordPress REST API 구현
 * - WordPress 코어 정적 자산 → WordPress/WordPress 공식 GitHub CDN
 * - 사용자 테마/플러그인 → 개인 GitHub 레포 or jsDelivr CDN
 * - 관리자 UI → WordPress 공식 관리자 UI와 100% 동일한 레이아웃
 * - 모든 플러그인/테마 설치 가능 (GitHub 레포 연동)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 바인딩 (sites.js createCfWorkerWithBindings에서 자동 연결):
 *   DB          : D1  - WordPress 데이터베이스
 *   SITE_DB     : D1  - 동일 DB 별칭
 *   CACHE       : KV  - 페이지/자산 캐시
 *   KV          : KV  - 설치 상태 / 세션
 *   SITE_ID     : plain_text
 *   GITHUB_OWNER: plain_text
 *   GITHUB_REPO : plain_text
 *   GITHUB_TOKEN: secret_text
 *   JWT_SECRET  : secret_text
 */

// ─── 플레이스홀더 (sites.js가 치환) ─────────────────────────────────────────
const _INJECTED_SITE_ID      = "%%SITE_ID%%";
const _INJECTED_GITHUB_OWNER = "%%GITHUB_OWNER%%";
const _INJECTED_GITHUB_REPO  = "%%GITHUB_REPO%%";

// ─── WordPress 공식 코어 소스 ────────────────────────────────────────────────
const WP_VER        = "6.7.2";
const WP_CORE_CDN   = `https://cdn.jsdelivr.net/npm/wordpress-static@${WP_VER}`;
const WP_GITHUB_RAW = "https://raw.githubusercontent.com/WordPress/WordPress/master";

// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip|pdf|mp4|mp3|ogg|wav|webm|avif)$/i;

// ─── CORS 헤더 ───────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With,X-WP-Nonce,X-WP-Nonce-Preview",
};

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function siteId(env) { return env.SITE_ID || _INJECTED_SITE_ID; }
function ghOwner(env) { return env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER; }
function ghRepo(env)  { return env.GITHUB_REPO  || _INJECTED_GITHUB_REPO; }
function db(env)      { return env.DB || env.SITE_DB; }
function kv(env)      { return env.CACHE || env.KV; }

async function kvGet(env, key) {
  try { return await kv(env)?.get(key); } catch { return null; }
}
async function kvSet(env, key, val, ttl = 3600) {
  try { await kv(env)?.put(key, val, { expirationTtl: ttl }); } catch {}
}
async function kvDel(env, key) {
  try { await kv(env)?.delete(key); } catch {}
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}
function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", ...extra },
  });
}

// ─── 간단한 JWT (HS256) ──────────────────────────────────────────────────────
async function jwtSign(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const body   = btoa(JSON.stringify(payload)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig    = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  return `${data}.${sigB64}`;
}

async function jwtVerify(token, secret) {
  try {
    const [h, b, s] = token.split(".");
    const data = `${h}.${b}`;
    const key  = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const sig  = Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
    const ok   = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
    if (!ok) return null;
    const payload = JSON.parse(atob(b.replace(/-/g,"+").replace(/_/g,"/")));
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

function getJwtSecret(env) {
  return env.JWT_SECRET || "cloudpress-fallback-secret-change-me";
}

async function getAuthUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    const cookie = request.headers.get("Cookie") || "";
    const m = cookie.match(/(?:^|;\s*)wp_token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) return null;
  return jwtVerify(token, getJwtSecret(env));
}

// ─── MD5 pure-JS (Cloudflare Workers는 crypto.subtle.digest("MD5") 미지원) ──
function md5Hash(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const msgLen = bytes.length;
  const bitLen = msgLen * 8;
  const padLen = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);
  const padded = new Uint8Array(msgLen + padLen + 8);
  padded.set(bytes);
  padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(msgLen + padLen,     bitLen >>> 0,        true);
  view.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(i + j * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if      (j < 16) { f = (b & c) | (~b & d);  g = j; }
      else if (j < 32) { f = (d & b) | (~d & c);  g = (5*j+1)%16; }
      else if (j < 48) { f = b ^ c ^ d;             g = (3*j+5)%16; }
      else             { f = c ^ (b | ~d);           g = (7*j)%16; }
      f = (f + a + T[j] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << S[j]) | (f >>> (32 - S[j])))) >>> 0;
    }
    a0=(a0+a)>>>0; b0=(b0+b)>>>0; c0=(c0+c)>>>0; d0=(d0+d)>>>0;
  }
  const out = new Uint8Array(16);
  const ov  = new DataView(out.buffer);
  ov.setUint32(0,  a0, true); ov.setUint32(4,  b0, true);
  ov.setUint32(8,  c0, true); ov.setUint32(12, d0, true);
  return out;
}

// ─── phpass 호환 비밀번호 검증/생성 ─────────────────────────────────────────
const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function encode64(src, count) {
  let output = "";
  let i = 0;
  while (i < count) {
    let value = src[i++];
    output += ITOA64[value & 0x3f];
    if (i < count) value |= src[i] << 8;
    output += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= count) break;
    if (i < count) value |= src[i] << 16;
    output += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= count) break;
    output += ITOA64[(value >> 18) & 0x3f];
  }
  return output;
}

function phpassCheck(password, hash) {
  if (hash.startsWith("$P$") || hash.startsWith("$H$")) {
    const countLog2 = ITOA64.indexOf(hash[3]);
    const salt      = hash.slice(4, 12);
    let count       = 1 << countLog2;
    const passBytes = new TextEncoder().encode(password);
    let h = md5Hash(salt + password);
    while (count--) {
      const c = new Uint8Array(h.length + passBytes.length);
      c.set(h); c.set(passBytes, h.length);
      h = md5Hash(c);
    }
    return (hash.slice(0, 12) + encode64(h, 16)) === hash;
  }
  if (hash.length === 32 && /^[0-9a-f]{32}$/.test(hash)) {
    const h = md5Hash(password);
    return Array.from(h).map(b => b.toString(16).padStart(2,"0")).join("") === hash;
  }
  return false;
}

function phpassCreate(password) {
  const countLog2 = 8;
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./";
  const rnd   = new Uint8Array(8);
  crypto.getRandomValues(rnd);
  let salt = "";
  for (const b of rnd) salt += chars[b % chars.length];
  const prefix    = `$P$${ITOA64[countLog2]}${salt}`;
  let count       = 1 << countLog2;
  const passBytes = new TextEncoder().encode(password);
  let h = md5Hash(salt + password);
  while (count--) {
    const c = new Uint8Array(h.length + passBytes.length);
    c.set(h); c.set(passBytes, h.length);
    h = md5Hash(c);
  }
  return prefix + encode64(h, 16);
}

// ─── WordPress 설치 확인 ──────────────────────────────────────────────────────
async function isWpInstalled(env) {
  const flag = await kvGet(env, `wp:installed:${siteId(env)}`);
  if (flag === "1") return true;
  const d = db(env);
  if (!d) return false;
  try {
    const r = await d.prepare("SELECT option_value FROM wp_options WHERE option_name='siteurl' LIMIT 1").first();
    if (r?.option_value) {
      await kvSet(env, `wp:installed:${siteId(env)}`, "1", 86400);
      return true;
    }
  } catch {}
  return false;
}

// ─── WordPress DB 자동 초기화 ────────────────────────────────────────────────
async function autoInstallWordPress(env, url) {
  const d = db(env);
  if (!d) return false;

  const siteUrl    = `${url.protocol}//${url.host}`;
  const sid        = siteId(env);
  const now        = new Date().toISOString().replace("T", " ").slice(0, 19);
  const adminUser  = env.WP_ADMIN_USER  || "admin";
  const adminPass  = env.WP_ADMIN_PASS  || crypto.randomUUID().slice(0, 12);
  const adminEmail = env.WP_ADMIN_EMAIL || `admin@${url.host}`;

  try {
    const schema = [
      `CREATE TABLE IF NOT EXISTS wp_options (
        option_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        option_name TEXT UNIQUE NOT NULL,
        option_value TEXT NOT NULL DEFAULT '',
        autoload    TEXT NOT NULL DEFAULT 'yes'
      )`,
      `CREATE TABLE IF NOT EXISTS wp_users (
        ID            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_login    TEXT NOT NULL DEFAULT '',
        user_pass     TEXT NOT NULL DEFAULT '',
        user_nicename TEXT NOT NULL DEFAULT '',
        user_email    TEXT NOT NULL DEFAULT '',
        user_url      TEXT NOT NULL DEFAULT '',
        user_registered TEXT NOT NULL DEFAULT '',
        user_activation_key TEXT NOT NULL DEFAULT '',
        user_status   INTEGER NOT NULL DEFAULT 0,
        display_name  TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS wp_usermeta (
        umeta_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id   INTEGER NOT NULL DEFAULT 0,
        meta_key  TEXT,
        meta_value TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS wp_posts (
        ID                    INTEGER PRIMARY KEY AUTOINCREMENT,
        post_author           INTEGER NOT NULL DEFAULT 0,
        post_date             TEXT NOT NULL DEFAULT '',
        post_date_gmt         TEXT NOT NULL DEFAULT '',
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
        post_modified         TEXT NOT NULL DEFAULT '',
        post_modified_gmt     TEXT NOT NULL DEFAULT '',
        post_content_filtered TEXT NOT NULL DEFAULT '',
        post_parent           INTEGER NOT NULL DEFAULT 0,
        guid                  TEXT NOT NULL DEFAULT '',
        menu_order            INTEGER NOT NULL DEFAULT 0,
        post_type             TEXT NOT NULL DEFAULT 'post',
        post_mime_type        TEXT NOT NULL DEFAULT '',
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
        comment_date_gmt     TEXT NOT NULL DEFAULT '',
        comment_content      TEXT NOT NULL DEFAULT '',
        comment_karma        INTEGER NOT NULL DEFAULT 0,
        comment_approved     TEXT NOT NULL DEFAULT '1',
        comment_agent        TEXT NOT NULL DEFAULT '',
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
    ];

    for (const sql of schema) {
      await d.prepare(sql).run();
    }

    const hashedPass = phpassCreate(adminPass);
    await d.prepare(
      `INSERT OR IGNORE INTO wp_users
        (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name)
       VALUES (?,?,?,?,?,?,0,?)`
    ).bind(adminUser, hashedPass, adminUser, adminEmail, siteUrl, now, adminUser).run();

    const adminRow = await d.prepare("SELECT ID FROM wp_users WHERE user_login=? LIMIT 1").bind(adminUser).first();
    const adminId  = adminRow?.ID || 1;

    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, "wp_capabilities", `a:1:{s:13:"administrator";b:1;}`).run();
    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, "wp_user_level", "10").run();
    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, "admin_color", "fresh").run();

    const options = [
      ["siteurl",          siteUrl],
      ["home",             siteUrl],
      ["blogname",         "내 WordPress 사이트"],
      ["blogdescription",  "CloudPress로 만든 WordPress"],
      ["admin_email",      adminEmail],
      ["blogpublic",       "1"],
      ["blog_charset",     "UTF-8"],
      ["date_format",      "Y년 n월 j일"],
      ["time_format",      "A g:i"],
      ["start_of_week",    "0"],
      ["timezone_string",  "Asia/Seoul"],
      ["permalink_structure", "/%postname%/"],
      ["template",         "twentytwentyfour"],
      ["stylesheet",       "twentytwentyfour"],
      ["current_theme",    "Twenty Twenty-Four"],
      ["active_plugins",   "a:0:{}"],
      ["wp_user_roles",    `a:1:{s:13:"administrator";a:2:{s:4:"name";s:13:"Administrator";s:12:"capabilities";a:1:{s:13:"administrator";b:1;}}}`],
      ["wp_installed_version", "6.7.2"],
      ["db_version",       "57155"],
      ["initial_db_version", "57155"],
      ["cp_auto_installed", "1"],
      ["cp_installed_at",  now],
      ["cp_admin_pass",    adminPass],
      ["cp_admin_user",    adminUser],
      ["cp_admin_email",   adminEmail],
    ];

    for (const [k, v] of options) {
      await d.prepare(
        `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES (?,?,'yes')`
      ).bind(k, v).run();
    }

    await d.prepare(
      `INSERT OR IGNORE INTO wp_posts
        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,
         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      adminId, now, now,
      "WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.",
      "안녕하세요!", "publish", "hello-world", now, now, "post",
      `${siteUrl}/?p=1`, "open", "open"
    ).run();

    await d.prepare(
      `INSERT OR IGNORE INTO wp_posts
        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,
         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      adminId, now, now,
      "이 페이지는 샘플 페이지입니다. CloudPress 관리자 패널에서 자유롭게 수정하세요.",
      "샘플 페이지", "publish", "sample-page", now, now, "page",
      `${siteUrl}/?page_id=2`, "closed", "open"
    ).run();

    await d.prepare(`INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1,'미분류','uncategorized',0)`).run();
    await d.prepare(`INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1,1,'category','',0,1)`).run();
    await d.prepare(`INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id) VALUES (1,1)`).run();

    await d.prepare(
      `INSERT OR IGNORE INTO wp_comments
        (comment_post_ID, comment_author, comment_author_email, comment_author_url,
         comment_content, comment_date, comment_date_gmt, comment_approved, comment_type, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      1, "CloudPress", "support@cloudpress.com", "https://cloudpress.com",
      "WordPress 사이트가 성공적으로 생성되었습니다. 이 댓글을 삭제하고 새 글을 작성해보세요!",
      now, now, "1", "comment", 0
    ).run();

    await kvSet(env, `wp:installed:${sid}`, "1", 86400 * 30);
    console.log(`[CloudPress] WordPress 자동 설치 완료 (site: ${sid}, url: ${siteUrl})`);
    return true;

  } catch (e) {
    console.error("[CloudPress] 자동 설치 실패:", e.message);
    return false;
  }
}

// ─── WP Option 헬퍼 ──────────────────────────────────────────────────────────
async function getOption(env, name) {
  try {
    const r = await db(env).prepare("SELECT option_value FROM wp_options WHERE option_name=? LIMIT 1").bind(name).first();
    return r?.option_value ?? null;
  } catch { return null; }
}

async function setOption(env, name, value) {
  try {
    await db(env).prepare("INSERT INTO wp_options(option_name,option_value,autoload) VALUES(?,?,'yes') ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value").bind(name, value).run();
    await kvDel(env, `opt:${name}`);
  } catch {}
}

// ─── Content-Type 결정 ───────────────────────────────────────────────────────
function mimeByExt(path) {
  if (path.endsWith(".css"))   return "text/css; charset=utf-8";
  if (path.endsWith(".js"))    return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg"))   return "image/svg+xml";
  if (path.endsWith(".png"))   return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif"))   return "image/gif";
  if (path.endsWith(".webp"))  return "image/webp";
  if (path.endsWith(".ico"))   return "image/x-icon";
  if (path.endsWith(".woff"))  return "font/woff";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ttf"))   return "font/ttf";
  if (path.endsWith(".json"))  return "application/json; charset=utf-8";
  if (path.endsWith(".xml"))   return "application/xml; charset=utf-8";
  return null;
}

// ─── GitHub 자산 서빙 (테마/플러그인 from 개인 레포) ─────────────────────────
async function serveGithubAsset(env, repoPath) {
  const owner = ghOwner(env);
  const repo  = ghRepo(env);
  if (!owner || !repo) return null;
  const token = env.GITHUB_TOKEN || "";
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;
  const headers = { "User-Agent": "CloudPress/6.1" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers, cf: { cacheEverything: true, cacheTtl: 3600 } });
    if (!res.ok) return null;
    const ct   = mimeByExt(repoPath) || res.headers.get("Content-Type") || "application/octet-stream";
    const body = await res.arrayBuffer();
    return new Response(body, {
      headers: { ...CORS, "Content-Type": ct, "Cache-Control": "public, max-age=3600", "X-Source": "github-user-repo" },
    });
  } catch { return null; }
}

// ─── WordPress 코어 정적 자산 서빙 ──────────────────────────────────────────
async function serveCoreAsset(filePath) {
  const urls = [
    `${WP_CORE_CDN}/${filePath}`,
    `${WP_GITHUB_RAW}/${filePath}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });
      if (res.ok) {
        const body = await res.arrayBuffer();
        const ct = mimeByExt(filePath) || res.headers.get("Content-Type") || "application/octet-stream";
        return new Response(body, {
          headers: {
            ...CORS, "Content-Type": ct,
            "Cache-Control": "public, max-age=86400, immutable",
            "X-Source": "wp-core-cdn",
          },
        });
      }
    } catch {}
  }
  return null;
}

// ─── WordPress REST API v2 구현 ───────────────────────────────────────────────
class WpRestApi {
  constructor(env, user) {
    this.env  = env;
    this.user = user;
    this.d    = db(env);
  }

  async getPosts(params = {}) {
    const {
      per_page = 10, page = 1, status = "publish",
      type = "post", search = "", author = 0,
      orderby = "date", order = "desc", slug = "",
    } = params;

    const offset = (parseInt(page)-1) * parseInt(per_page);
    const conditions = [];
    const binds = [];

    if (status === "any") {
      conditions.push("post_status NOT IN ('auto-draft','trash')");
    } else {
      const statuses = status.split(",").map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push("post_status=?"); binds.push(statuses[0]);
      } else {
        conditions.push(`post_status IN (${statuses.map(()=>"?").join(",")})`);
        binds.push(...statuses);
      }
    }
    conditions.push("post_type=?"); binds.push(type);
    if (slug)   { conditions.push("post_name=?"); binds.push(slug); }
    if (search) { conditions.push("(post_title LIKE ? OR post_content LIKE ?)"); binds.push(`%${search}%`, `%${search}%`); }
    if (author) { conditions.push("post_author=?"); binds.push(parseInt(author)); }

    const where    = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const orderSql = `ORDER BY ${orderby === "title" ? "post_title" : "post_date"} ${order.toUpperCase() === "ASC" ? "ASC" : "DESC"}`;

    const countRow = await this.d.prepare(`SELECT COUNT(*) as cnt FROM wp_posts ${where}`).bind(...binds).first();
    const total    = countRow?.cnt || 0;
    const rows     = await this.d.prepare(`SELECT * FROM wp_posts ${where} ${orderSql} LIMIT ? OFFSET ?`).bind(...binds, parseInt(per_page), offset).all();

    const posts = await Promise.all((rows.results || []).map(p => this._formatPost(p)));
    return { posts, total, pages: Math.ceil(total / parseInt(per_page)) };
  }

  async getPost(id) {
    const isSlug = isNaN(parseInt(id));
    const row = isSlug
      ? await this.d.prepare("SELECT * FROM wp_posts WHERE post_name=? LIMIT 1").bind(id).first()
      : await this.d.prepare("SELECT * FROM wp_posts WHERE ID=? LIMIT 1").bind(parseInt(id)).first();
    if (!row) return null;
    return this._formatPost(row);
  }

  async createPost(data) {
    if (!this.user) throw new Error("Unauthorized");
    const now = new Date().toISOString().slice(0,19).replace("T"," ");
    const {
      title = "", content = "", excerpt = "", status = "draft",
      type = "post", slug = "", comment_status = "open",
      ping_status = "open", categories = [1], tags = [], meta = {},
      parent = 0, menu_order = 0, date = now,
    } = data;

    const postName = slug || this._slugify(title || "post");
    const res = await this.d.prepare(
      `INSERT INTO wp_posts
        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
         post_status, comment_status, ping_status, post_name, post_type,
         post_modified, post_modified_gmt, guid, menu_order, post_parent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      this.user.id || 1, date, date, content, title, excerpt,
      status, comment_status, ping_status, postName, type,
      now, now, "", menu_order, parent
    ).run();

    const postId  = res.meta?.last_row_id;
    if (!postId) throw new Error("Insert failed");
    const siteUrl = await getOption(this.env, "siteurl") || "";
    await this.d.prepare("UPDATE wp_posts SET guid=? WHERE ID=?").bind(`${siteUrl}/?p=${postId}`, postId).run();

    for (const catId of (Array.isArray(categories) ? categories : [1])) {
      const tt = await this.d.prepare("SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy='category'").bind(catId).first();
      if (tt) {
        await this.d.prepare("INSERT OR IGNORE INTO wp_term_relationships(object_id,term_taxonomy_id) VALUES(?,?)").bind(postId, tt.term_taxonomy_id).run();
        await this.d.prepare("UPDATE wp_term_taxonomy SET count=count+1 WHERE term_taxonomy_id=?").bind(tt.term_taxonomy_id).run();
      }
    }
    for (const [k, v] of Object.entries(meta)) {
      await this.d.prepare("INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)").bind(postId, k, String(v)).run();
    }
    await this._invalidateCache();
    return this.getPost(postId);
  }

  async updatePost(id, data) {
    if (!this.user) throw new Error("Unauthorized");
    const existing = await this.d.prepare("SELECT * FROM wp_posts WHERE ID=?").bind(parseInt(id)).first();
    if (!existing) throw new Error("Not Found");

    const now = new Date().toISOString().slice(0,19).replace("T"," ");
    const updates = {};
    if (data.title   !== undefined) updates.post_title   = data.title;
    if (data.content !== undefined) updates.post_content = data.content;
    if (data.excerpt !== undefined) updates.post_excerpt = data.excerpt;
    if (data.status  !== undefined) updates.post_status  = data.status;
    if (data.slug    !== undefined) updates.post_name    = data.slug || this._slugify(data.title || existing.post_title);
    if (data.date    !== undefined) updates.post_date    = data.date;
    if (data.comment_status !== undefined) updates.comment_status = data.comment_status;
    updates.post_modified     = now;
    updates.post_modified_gmt = now;

    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    await this.d.prepare(`UPDATE wp_posts SET ${keys.map(k=>`${k}=?`).join(",")} WHERE ID=?`).bind(...vals, parseInt(id)).run();

    if (data.meta) {
      for (const [k, v] of Object.entries(data.meta)) {
        await this.d.prepare("INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(parseInt(id), k, String(v)).run();
      }
    }
    await this._invalidateCache();
    return this.getPost(id);
  }

  async deletePost(id, force = false) {
    if (!this.user) throw new Error("Unauthorized");
    if (force) {
      await this.d.prepare("DELETE FROM wp_posts WHERE ID=?").bind(parseInt(id)).run();
      await this.d.prepare("DELETE FROM wp_postmeta WHERE post_id=?").bind(parseInt(id)).run();
      await this.d.prepare("DELETE FROM wp_term_relationships WHERE object_id=?").bind(parseInt(id)).run();
    } else {
      await this.d.prepare("UPDATE wp_posts SET post_status='trash' WHERE ID=?").bind(parseInt(id)).run();
    }
    await this._invalidateCache();
    return { deleted: true, id: parseInt(id) };
  }

  async _formatPost(row) {
    if (!row) return null;
    const siteUrl = await getOption(this.env, "siteurl") || "";
    const metaRows = await this.d.prepare("SELECT meta_key,meta_value FROM wp_postmeta WHERE post_id=?").bind(row.ID).all();
    const meta = {};
    for (const m of (metaRows.results || [])) meta[m.meta_key] = m.meta_value;

    const catRows = await this.d.prepare(
      `SELECT t.term_id, t.name, t.slug FROM wp_terms t
       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id
       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id
       WHERE tr.object_id=? AND tt.taxonomy='category'`
    ).bind(row.ID).all();

    const tagRows = await this.d.prepare(
      `SELECT t.term_id, t.name, t.slug FROM wp_terms t
       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id
       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id
       WHERE tr.object_id=? AND tt.taxonomy='post_tag'`
    ).bind(row.ID).all();

    const author  = await this.d.prepare("SELECT * FROM wp_users WHERE ID=?").bind(row.post_author).first();
    const slug    = row.post_name || String(row.ID);
    const postLink = `${siteUrl}/${slug}/`;

    return {
      id: row.ID, date: row.post_date, date_gmt: row.post_date_gmt,
      modified: row.post_modified, modified_gmt: row.post_modified_gmt,
      slug, status: row.post_status, type: row.post_type, link: postLink,
      title:   { rendered: row.post_title || "" },
      content: { rendered: this._renderBlocks(row.post_content || ""), raw: row.post_content || "", protected: false },
      excerpt: { rendered: row.post_excerpt || "", protected: false },
      author: row.post_author,
      featured_media: parseInt(meta._thumbnail_id || 0),
      comment_status: row.comment_status, ping_status: row.ping_status,
      format: "standard", meta, sticky: false,
      template: meta._wp_page_template || "",
      categories: (catRows.results || []).map(c => c.term_id),
      tags:       (tagRows.results || []).map(t => t.term_id),
      _embedded: {
        author: author ? [this._formatUser(author)] : [],
        "wp:term": [
          (catRows.results || []).map(c => ({ id: c.term_id, name: c.name, slug: c.slug, taxonomy: "category" })),
          (tagRows.results || []).map(t => ({ id: t.term_id, name: t.name, slug: t.slug, taxonomy: "post_tag" })),
        ],
      },
    };
  }

  _renderBlocks(content) {
    if (!content) return "";
    return content
      .replace(/<!-- wp:[^>]+ \/-->/g, "")
      .replace(/<!-- wp:[^\n]* -->/g, "")
      .replace(/<!-- \/wp:[^\n]* -->/g, "")
      .trim();
  }

  _slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 200) || `post-${Date.now()}`;
  }

  _formatUser(row) {
    return {
      id: row.ID, name: row.display_name || row.user_login,
      url: row.user_url || "", description: "", link: "",
      slug: row.user_nicename || row.user_login,
      avatar_urls: { 96: `https://www.gravatar.com/avatar/${(row.user_email||"").trim().toLowerCase()}?s=96&d=mm` },
    };
  }

  async getUsers(params = {}) {
    const { per_page = 10, page = 1 } = params;
    const offset = (parseInt(page)-1)*parseInt(per_page);
    const rows = await this.d.prepare("SELECT * FROM wp_users ORDER BY ID LIMIT ? OFFSET ?").bind(parseInt(per_page), offset).all();
    return (rows.results || []).map(u => this._formatUser(u));
  }

  async getUser(id) {
    const row = id === "me"
      ? (this.user ? await this.d.prepare("SELECT * FROM wp_users WHERE ID=?").bind(this.user.id).first() : null)
      : await this.d.prepare("SELECT * FROM wp_users WHERE ID=?").bind(parseInt(id)).first();
    if (!row) return null;
    const caps  = await this.d.prepare("SELECT meta_value FROM wp_usermeta WHERE user_id=? AND meta_key='wp_capabilities'").bind(row.ID).first();
    const roles = caps?.meta_value?.includes("administrator") ? ["administrator"] : ["subscriber"];
    return { ...this._formatUser(row), roles, capabilities: Object.fromEntries(roles.map(r=>[r,true])) };
  }

  async updateUser(id, data) {
    if (!this.user) throw new Error("Unauthorized");
    const userId = id === "me" ? this.user.id : parseInt(id);
    if (this.user.id !== userId && this.user.role !== "administrator") throw new Error("Forbidden");

    const updates = {};
    if (data.name)     updates.display_name = data.name;
    if (data.email)    updates.user_email   = data.email;
    if (data.url)      updates.user_url     = data.url;
    if (data.password) {
      updates.user_pass = phpassCreate(data.password);
      await this.d.prepare("DELETE FROM wp_usermeta WHERE user_id=? AND meta_key='session_tokens'").bind(userId).run();
    }
    if (Object.keys(updates).length) {
      const keys = Object.keys(updates);
      await this.d.prepare(`UPDATE wp_users SET ${keys.map(k=>`${k}=?`).join(",")} WHERE ID=?`).bind(...Object.values(updates), userId).run();
    }
    if (data.description !== undefined) {
      await this.d.prepare("INSERT INTO wp_usermeta(user_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(userId, "description", data.description).run();
    }
    return this.getUser(id);
  }

  async getTerms(taxonomy, params = {}) {
    const { per_page = 100, page = 1, hide_empty = false, orderby = "name", order = "asc" } = params;
    const offset = (parseInt(page)-1)*parseInt(per_page);
    const cond = hide_empty ? "WHERE tt.taxonomy=? AND tt.count>0" : "WHERE tt.taxonomy=?";
    const rows = await this.d.prepare(
      `SELECT t.*, tt.term_taxonomy_id, tt.count, tt.parent, tt.description
       FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id
       ${cond}
       ORDER BY t.${orderby==="id"?"term_id":"name"} ${order.toUpperCase()==="ASC"?"ASC":"DESC"}
       LIMIT ? OFFSET ?`
    ).bind(taxonomy, parseInt(per_page), offset).all();
    return (rows.results || []).map(t => ({
      id: t.term_id, count: t.count, description: t.description || "",
      link: "", name: t.name, slug: t.slug, taxonomy,
      parent: t.parent || 0, meta: [],
    }));
  }

  async createTerm(taxonomy, data) {
    if (!this.user) throw new Error("Unauthorized");
    const { name, slug = "", description = "", parent = 0 } = data;
    const termSlug = slug || this._slugify(name);
    const existing = await this.d.prepare("SELECT term_id FROM wp_terms WHERE slug=?").bind(termSlug).first();
    if (existing) {
      const tt = await this.d.prepare("SELECT * FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?").bind(existing.term_id, taxonomy).first();
      if (tt) return { id: existing.term_id, name, slug: termSlug, taxonomy, count: tt.count, description: tt.description || "", parent: tt.parent || 0 };
    }
    const termRes = existing
      ? { meta: { last_row_id: existing.term_id } }
      : await this.d.prepare("INSERT INTO wp_terms(name,slug,term_group) VALUES(?,?,0)").bind(name, termSlug).run();
    const termId = existing?.term_id || termRes.meta?.last_row_id;
    await this.d.prepare("INSERT INTO wp_term_taxonomy(term_id,taxonomy,description,parent,count) VALUES(?,?,?,?,0)").bind(termId, taxonomy, description, parseInt(parent)).run();
    return { id: termId, name, slug: termSlug, taxonomy, count: 0, description, parent: parseInt(parent) };
  }

  async updateTerm(taxonomy, id, data) {
    if (!this.user) throw new Error("Unauthorized");
    const { name, slug, description, parent } = data;
    if (name || slug) await this.d.prepare("UPDATE wp_terms SET name=COALESCE(?,name), slug=COALESCE(?,slug) WHERE term_id=?").bind(name||null, slug||null, parseInt(id)).run();
    if (description !== undefined || parent !== undefined) {
      await this.d.prepare("UPDATE wp_term_taxonomy SET description=COALESCE(?,description), parent=COALESCE(?,parent) WHERE term_id=? AND taxonomy=?")
        .bind(description??null, parent??null, parseInt(id), taxonomy).run();
    }
    const t = await this.d.prepare("SELECT t.*, tt.count, tt.description, tt.parent FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE t.term_id=? AND tt.taxonomy=?").bind(parseInt(id), taxonomy).first();
    return t ? { id: t.term_id, name: t.name, slug: t.slug, taxonomy, count: t.count, description: t.description||"", parent: t.parent||0 } : null;
  }

  async deleteTerm(taxonomy, id) {
    if (!this.user) throw new Error("Unauthorized");
    await this.d.prepare("DELETE FROM wp_term_relationships WHERE term_taxonomy_id IN (SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?)").bind(parseInt(id), taxonomy).run();
    await this.d.prepare("DELETE FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?").bind(parseInt(id), taxonomy).run();
    await this.d.prepare("DELETE FROM wp_terms WHERE term_id=? AND NOT EXISTS (SELECT 1 FROM wp_term_taxonomy WHERE term_id=?)").bind(parseInt(id), parseInt(id)).run();
    return { deleted: true, previous: { id: parseInt(id) } };
  }

  async getMedia(params = {}) {
    const { per_page = 10, page = 1, media_type = "" } = params;
    const offset = (parseInt(page)-1)*parseInt(per_page);
    const cond  = media_type ? "AND post_mime_type LIKE ?" : "";
    const binds = media_type ? [`${media_type}%`] : [];
    const rows  = await this.d.prepare(
      `SELECT * FROM wp_posts WHERE post_type='attachment' ${cond} ORDER BY post_date DESC LIMIT ? OFFSET ?`
    ).bind(...binds, parseInt(per_page), offset).all();
    return (rows.results || []).map(m => this._formatMedia(m));
  }

  async uploadMedia(env, request) {
    if (!this.user) throw new Error("Unauthorized");
    const ct  = request.headers.get("Content-Type") || "";
    const cd  = request.headers.get("Content-Disposition") || "";
    const fnm = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    const filename = fnm ? fnm[1].replace(/['"]/g, "") : `upload-${Date.now()}`;

    const body     = await request.arrayBuffer();
    const owner    = ghOwner(env);
    const repo     = ghRepo(env);
    const token    = env.GITHUB_TOKEN;
    const now      = new Date();
    const year     = now.getFullYear();
    const month    = String(now.getMonth()+1).padStart(2,"0");
    const repoPath = `wp-content/uploads/${year}/${month}/${filename}`;
    let fileUrl    = "";

    if (owner && repo && token) {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(body)));
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "CloudPress/6.1" },
        body: JSON.stringify({ message: `Upload ${filename}`, content: b64 }),
      });
      if (res.ok) {
        const data = await res.json();
        fileUrl = data.content?.download_url || `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;
      }
    }

    const siteUrl = await getOption(env, "siteurl") || "";
    const now2    = new Date().toISOString().slice(0,19).replace("T"," ");
    const res = await this.d.prepare(
      `INSERT INTO wp_posts
        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
         post_status, comment_status, ping_status, post_name, post_type, post_mime_type,
         post_modified, post_modified_gmt, guid, menu_order)
       VALUES (?,?,?,?,?,?,'inherit','open','open',?,'attachment',?,?,?,?,0)`
    ).bind(this.user.id||1, now2, now2, "", filename, "", filename, ct.split(";")[0].trim()||"application/octet-stream", now2, now2, fileUrl||`${siteUrl}/${repoPath}`).run();

    const mediaId = res.meta?.last_row_id;
    await this.d.prepare("INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)").bind(mediaId, "_wp_attached_file", repoPath).run();
    await this.d.prepare("INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)").bind(mediaId, "_wp_attachment_metadata", JSON.stringify({ file: repoPath })).run();
    const row = await this.d.prepare("SELECT * FROM wp_posts WHERE ID=?").bind(mediaId).first();
    return this._formatMedia(row);
  }

  _formatMedia(row) {
    if (!row) return null;
    return {
      id: row.ID, date: row.post_date, slug: row.post_name,
      status: row.post_status, type: "attachment", link: row.guid,
      title: { rendered: row.post_title },
      author: row.post_author,
      caption: { rendered: row.post_excerpt || "" },
      alt_text: "",
      media_type: (row.post_mime_type || "").startsWith("image") ? "image" : "file",
      mime_type: row.post_mime_type || "application/octet-stream",
      media_details: {}, source_url: row.guid || "",
    };
  }

  async getComments(params = {}) {
    const { post = 0, per_page = 10, page = 1, status = "approve" } = params;
    const offset = (parseInt(page)-1)*parseInt(per_page);
    const cond  = post ? "WHERE comment_post_ID=? AND comment_approved=?" : "WHERE comment_approved=?";
    const binds = post ? [parseInt(post), status === "approve" ? "1" : status] : [status === "approve" ? "1" : status];
    const rows  = await this.d.prepare(`SELECT * FROM wp_comments ${cond} ORDER BY comment_date DESC LIMIT ? OFFSET ?`).bind(...binds, parseInt(per_page), offset).all();
    return (rows.results || []).map(c => this._formatComment(c));
  }

  async createComment(data) {
    const { post, content, author_name = "Anonymous", author_email = "", author_url = "", parent = 0 } = data;
    const now = new Date().toISOString().slice(0,19).replace("T"," ");
    const res = await this.d.prepare(
      `INSERT INTO wp_comments
        (comment_post_ID, comment_author, comment_author_email, comment_author_url,
         comment_content, comment_date, comment_date_gmt, comment_approved, comment_parent, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(parseInt(post), author_name, author_email, author_url, content, now, now, "1", parseInt(parent), this.user?.id||0).run();
    const id = res.meta?.last_row_id;
    await this.d.prepare("UPDATE wp_posts SET comment_count=comment_count+1 WHERE ID=?").bind(parseInt(post)).run();
    const row = await this.d.prepare("SELECT * FROM wp_comments WHERE comment_ID=?").bind(id).first();
    return this._formatComment(row);
  }

  _formatComment(row) {
    return {
      id: row.comment_ID, post: row.comment_post_ID, parent: row.comment_parent,
      author: row.user_id || 0, author_name: row.comment_author,
      author_email: row.comment_author_email, author_url: row.comment_author_url,
      date: row.comment_date, content: { rendered: row.comment_content },
      status: row.comment_approved === "1" ? "approved" : "hold",
    };
  }

  async getSettings() {
    if (!this.user) throw new Error("Unauthorized");
    const opts = await this.d.prepare(
      "SELECT option_name,option_value FROM wp_options WHERE option_name IN (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind("siteurl","home","blogname","blogdescription","admin_email","posts_per_page",
      "permalink_structure","timezone_string","date_format","time_format",
      "default_category","template","stylesheet").all();
    const s = {};
    for (const r of (opts.results||[])) s[r.option_name] = r.option_value;
    return {
      title:              s.blogname || "",
      description:        s.blogdescription || "",
      url:                s.siteurl || "",
      email:              s.admin_email || "",
      timezone:           s.timezone_string || "Asia/Seoul",
      date_format:        s.date_format || "Y년 n월 j일",
      time_format:        s.time_format || "A g:i",
      posts_per_page:     parseInt(s.posts_per_page) || 10,
      default_category:   parseInt(s.default_category) || 1,
      default_post_format:"standard",
      language:           "ko_KR",
      use_smilies:        true,
      template:           s.template || "twentytwentyfour",
      stylesheet:         s.stylesheet || "twentytwentyfour",
      permalink_structure: s.permalink_structure || "/%postname%/",
    };
  }

  async updateSettings(data) {
    if (!this.user) throw new Error("Unauthorized");
    const map = {
      title:"blogname", description:"blogdescription", email:"admin_email",
      timezone:"timezone_string", date_format:"date_format", time_format:"time_format",
      posts_per_page:"posts_per_page", default_category:"default_category",
      permalink_structure:"permalink_structure",
    };
    for (const [k,v] of Object.entries(data)) {
      if (map[k]) await setOption(this.env, map[k], String(v));
    }
    return this.getSettings();
  }

  async getPlugins() {
    if (!this.user) throw new Error("Unauthorized");
    const raw = await getOption(this.env, "active_plugins") || "a:0:{}";
    const m   = raw.match(/s:\d+:"([^"]+)"/g) || [];
    const active = m.map(x => x.match(/s:\d+:"([^"]+)"/)?.[1]).filter(Boolean);
    const plugins = [];
    const owner = ghOwner(this.env);
    const repo  = ghRepo(this.env);
    if (owner && repo) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/plugins`, {
          headers: { "Authorization": `Bearer ${this.env.GITHUB_TOKEN}`, "User-Agent": "CloudPress/6.1" },
        });
        if (res.ok) {
          const items = await res.json();
          for (const item of (Array.isArray(items) ? items : [])) {
            if (item.type === "dir") {
              plugins.push({
                plugin: `${item.name}/${item.name}.php`,
                status: active.includes(`${item.name}/${item.name}.php`) ? "active" : "inactive",
                name: item.name, plugin_uri: "", author: "", author_uri: "",
                description: { rendered: "" }, version: "", network_only: false,
                requires_wp: "6.0", requires_php: "8.0", textdomain: item.name,
              });
            }
          }
        }
      } catch {}
    }
    for (const p of active) {
      if (!plugins.find(x => x.plugin === p)) {
        plugins.push({ plugin: p, status: "active", name: p.split("/")[0], description: { rendered: "" }, version: "" });
      }
    }
    return plugins;
  }

  async activatePlugin(plugin) {
    if (!this.user) throw new Error("Unauthorized");
    const raw = await getOption(this.env, "active_plugins") || "a:0:{}";
    const m   = raw.match(/s:\d+:"[^"]+"/g) || [];
    const current = m.map(x => x.match(/s:\d+:"([^"]+)"/)?.[1]).filter(Boolean);
    if (!current.includes(plugin)) {
      current.push(plugin);
      const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:"${p}";`).join("")}}`;
      await setOption(this.env, "active_plugins", serialized);
    }
    return { plugin, status: "active" };
  }

  async deactivatePlugin(plugin) {
    if (!this.user) throw new Error("Unauthorized");
    const raw = await getOption(this.env, "active_plugins") || "a:0:{}";
    const m   = raw.match(/s:\d+:"[^"]+"/g) || [];
    const current = m.map(x => x.match(/s:\d+:"([^"]+)"/)?.[1]).filter(Boolean).filter(p => p !== plugin);
    const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:"${p}";`).join("")}}`;
    await setOption(this.env, "active_plugins", serialized);
    return { plugin, status: "inactive" };
  }

  async getThemes() {
    if (!this.user) throw new Error("Unauthorized");
    const activeTemplate   = await getOption(this.env, "template")   || "twentytwentyfour";
    const activeStylesheet = await getOption(this.env, "stylesheet") || "twentytwentyfour";
    const themes = [];
    const owner = ghOwner(this.env);
    const repo  = ghRepo(this.env);
    if (owner && repo) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/themes`, {
          headers: { "Authorization": `Bearer ${this.env.GITHUB_TOKEN}`, "User-Agent": "CloudPress/6.1" },
        });
        if (res.ok) {
          const items = await res.json();
          for (const item of (Array.isArray(items) ? items : [])) {
            if (item.type === "dir") {
              themes.push({
                stylesheet: item.name, template: item.name,
                name: { rendered: item.name }, description: { rendered: "" },
                author: { rendered: "" }, screenshot: "",
                status: item.name === activeStylesheet ? "active" : "inactive",
                is_block_theme: false, textdomain: item.name,
              });
            }
          }
        }
      } catch {}
    }
    if (!themes.find(t => t.stylesheet === activeStylesheet)) {
      themes.unshift({
        stylesheet: activeStylesheet, template: activeTemplate,
        name: { rendered: activeStylesheet }, description: { rendered: "" },
        author: { rendered: "" }, screenshot: "", status: "active",
        is_block_theme: false, textdomain: activeStylesheet,
      });
    }
    return themes;
  }

  async activateTheme(stylesheet) {
    if (!this.user) throw new Error("Unauthorized");
    await setOption(this.env, "stylesheet", stylesheet);
    await setOption(this.env, "template", stylesheet);
    await this._invalidateCache();
    return { stylesheet, template: stylesheet, status: "active" };
  }

  async _invalidateCache() {
    try {
      const cache = kv(this.env);
      if (!cache) return;
      const list = await cache.list({ prefix: "page:" });
      for (const key of (list.keys||[])) await cache.delete(key.name);
    } catch {}
  }
}

// ─── REST API 라우팅 ─────────────────────────────────────────────────────────
async function handleRestApi(request, env, url) {
  const method = request.method.toUpperCase();
  const path   = url.pathname.replace(/^\/wp-json\/wp\/v2/, "").replace(/\/$/, "") || "/";
  const params = Object.fromEntries(url.searchParams.entries());
  const user   = await getAuthUser(request, env);
  const api    = new WpRestApi(env, user);

  let body = {};
  if (["POST","PUT","PATCH"].includes(method)) {
    try {
      const ct = request.headers.get("Content-Type") || "";
      if (ct.includes("application/json")) {
        body = await request.json();
      } else if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
        const fd = await request.formData();
        for (const [k,v] of fd.entries()) body[k] = v;
      }
    } catch {}
  }

  try {
    // /posts
    if (path === "/posts" || path === "") {
      if (method === "GET") {
        const { posts, total, pages } = await api.getPosts({ ...params, type: params.type || "post" });
        return json(posts, 200, { "X-WP-Total": String(total), "X-WP-TotalPages": String(pages) });
      }
      if (method === "POST") {
        if (!user) return json({ code: "rest_not_logged_in", message: "Sorry, you are not allowed to create posts." }, 401);
        return json(await api.createPost({ ...body, type: "post" }), 201);
      }
    }
    const postMatch = path.match(/^\/posts\/(\d+)$/);
    if (postMatch) {
      const id = postMatch[1];
      if (method === "GET") return json(await api.getPost(id));
      if (["POST","PUT","PATCH"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.updatePost(id, body));
      }
      if (method === "DELETE") {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.deletePost(id, params.force === "true"));
      }
    }

    // /pages
    if (path === "/pages") {
      if (method === "GET") {
        const { posts, total, pages } = await api.getPosts({ ...params, type: "page" });
        return json(posts, 200, { "X-WP-Total": String(total), "X-WP-TotalPages": String(pages) });
      }
      if (method === "POST") {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.createPost({ ...body, type: "page" }), 201);
      }
    }
    const pageMatch = path.match(/^\/pages\/(\d+)$/);
    if (pageMatch) {
      const id = pageMatch[1];
      if (method === "GET") return json(await api.getPost(id));
      if (["POST","PUT","PATCH"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.updatePost(id, body));
      }
      if (method === "DELETE") {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.deletePost(id, params.force === "true"));
      }
    }

    // /media
    if (path === "/media") {
      if (method === "GET") return json(await api.getMedia(params));
      if (method === "POST") {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.uploadMedia(env, request), 201);
      }
    }

    // /comments
    if (path === "/comments") {
      if (method === "GET")  return json(await api.getComments(params));
      if (method === "POST") return json(await api.createComment(body), 201);
    }

    // /users
    if (path === "/users") {
      if (method === "GET") return json(await api.getUsers(params));
    }
    const userMatch = path.match(/^\/users\/(me|\d+)$/);
    if (userMatch) {
      if (method === "GET") return json(await api.getUser(userMatch[1]));
      if (["POST","PUT","PATCH"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.updateUser(userMatch[1], body));
      }
    }

    // /categories /tags
    for (const [endpoint, taxonomy] of [["categories","category"],["tags","post_tag"]]) {
      if (path === `/${endpoint}`) {
        if (method === "GET")  return json(await api.getTerms(taxonomy, params));
        if (method === "POST") {
          if (!user) return json({ code: "rest_not_logged_in" }, 401);
          return json(await api.createTerm(taxonomy, body), 201);
        }
      }
      const termMatch = path.match(new RegExp(`^\\/${endpoint}\\/(\\d+)$`));
      if (termMatch) {
        if (method === "GET") return json((await api.getTerms(taxonomy, { per_page: 1 }))[0] || null);
        if (["POST","PUT","PATCH"].includes(method)) {
          if (!user) return json({ code: "rest_not_logged_in" }, 401);
          return json(await api.updateTerm(taxonomy, termMatch[1], body));
        }
        if (method === "DELETE") {
          if (!user) return json({ code: "rest_not_logged_in" }, 401);
          return json(await api.deleteTerm(taxonomy, termMatch[1]));
        }
      }
    }

    // /settings
    if (path === "/settings") {
      if (method === "GET") return json(await api.getSettings());
      if (["POST","PUT","PATCH"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        return json(await api.updateSettings(body));
      }
    }

    // /plugins
    if (path === "/plugins") {
      if (method === "GET") return json(await api.getPlugins());
    }
    const pluginMatch = path.match(/^\/plugins\/(.+)$/);
    if (pluginMatch) {
      const pluginFile = decodeURIComponent(pluginMatch[1]);
      if (["PUT","POST"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        if (body.status === "active")   return json(await api.activatePlugin(pluginFile));
        if (body.status === "inactive") return json(await api.deactivatePlugin(pluginFile));
      }
    }

    // /themes
    if (path === "/themes") {
      if (method === "GET") return json(await api.getThemes());
    }
    const themeMatch = path.match(/^\/themes\/(.+)$/);
    if (themeMatch) {
      if (["POST","PUT","PATCH"].includes(method)) {
        if (!user) return json({ code: "rest_not_logged_in" }, 401);
        if (body.status === "active") return json(await api.activateTheme(decodeURIComponent(themeMatch[1])));
      }
    }

    // /types /taxonomies /statuses
    if (path === "/types") return json({ post:{slug:"post",name:"Posts",rest_base:"posts"}, page:{slug:"page",name:"Pages",rest_base:"pages"}, attachment:{slug:"attachment",name:"Media",rest_base:"media"} });
    if (path === "/taxonomies") return json({ category:{slug:"category",name:"Categories",rest_base:"categories"}, post_tag:{slug:"post_tag",name:"Tags",rest_base:"tags"} });
    if (path === "/statuses") return json({ publish:{name:"Published",public:true,queryable:true,slug:"publish"}, draft:{name:"Draft",public:false,queryable:false,slug:"draft"}, private:{name:"Private",public:false,queryable:false,slug:"private"}, trash:{name:"Trash",public:false,queryable:false,slug:"trash"} });

    // /wp-json root
    const siteUrl = await getOption(env, "siteurl") || `${url.protocol}//${url.host}`;
    if (url.pathname === "/wp-json" || url.pathname === "/wp-json/") {
      return json({
        name: await getOption(env, "blogname") || "WordPress 사이트",
        description: await getOption(env, "blogdescription") || "",
        url: siteUrl, home: siteUrl, gmt_offset: 9,
        timezone_string: await getOption(env, "timezone_string") || "Asia/Seoul",
        namespaces: ["wp/v2", "cloudpress/v1"],
        authentication: {},
        routes: {
          "/wp/v2/posts":      { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/pages":      { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/media":      { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/users":      { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/settings":   { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/plugins":    { namespace: "wp/v2", methods: ["GET","POST","PUT","DELETE"] },
          "/wp/v2/themes":     { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/categories": { namespace: "wp/v2", methods: ["GET","POST"] },
          "/wp/v2/tags":       { namespace: "wp/v2", methods: ["GET","POST"] },
        },
      });
    }

    // CloudPress 전용 API
    if (url.pathname.startsWith("/wp-json/cloudpress/v1/")) {
      return handleCloudPressApi(request, env, url, user, body, params);
    }

    return json({ code: "rest_no_route", message: "No route found matching the URL and request method.", data: { status: 404 } }, 404);

  } catch(e) {
    console.error("[rest-api]", e);
    const isAuth = e.message === "Unauthorized" || e.message === "Forbidden";
    return json({ code: isAuth ? "rest_forbidden" : "rest_error", message: e.message }, isAuth ? 403 : 500);
  }
}

// ─── CloudPress 전용 REST API ────────────────────────────────────────────────
async function handleCloudPressApi(request, env, url, user, body, params) {
  const path = url.pathname.replace(/^\/wp-json\/cloudpress\/v1/, "").replace(/\/$/, "");

  if (path === "/token" && request.method === "POST") {
    const { username, password } = body;
    if (!username || !password) return json({ code: "missing_credentials", message: "아이디와 비밀번호를 입력하세요." }, 400);
    const d = db(env);
    const u = await d.prepare("SELECT * FROM wp_users WHERE user_login=? OR user_email=? LIMIT 1").bind(username, username).first();
    if (!u) return json({ code: "invalid_username", message: "존재하지 않는 사용자입니다." }, 401);
    const ok = phpassCheck(password, u.user_pass);
    if (!ok) return json({ code: "incorrect_password", message: "비밀번호가 올바르지 않습니다." }, 401);

    const capsRow = await d.prepare("SELECT meta_value FROM wp_usermeta WHERE user_id=? AND meta_key='wp_capabilities'").bind(u.ID).first();
    const role    = capsRow?.meta_value?.includes("administrator") ? "administrator" : "subscriber";
    const exp     = Math.floor(Date.now()/1000) + 86400 * 30;
    const token   = await jwtSign({ id: u.ID, login: u.user_login, email: u.user_email, role, exp }, getJwtSecret(env));

    return json({
      token, user_email: u.user_email,
      user_nicename: u.user_nicename || u.user_login,
      user_display_name: u.display_name || u.user_login,
      roles: [role],
    }, 200, { "Set-Cookie": `wp_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
  }

  if (path === "/token/logout" && ["POST","DELETE"].includes(request.method)) {
    return json({ message: "로그아웃 완료" }, 200, { "Set-Cookie": "wp_token=; Path=/; HttpOnly; Max-Age=0" });
  }

  if (path === "/token/validate" && request.method === "POST") {
    if (!user) return json({ code: "jwt_auth_invalid_token", message: "유효하지 않은 토큰입니다." }, 401);
    return json({ code: "jwt_auth_valid_token", data: { status: 200 } });
  }

  if (path === "/github-upload" && request.method === "POST") {
    if (!user || user.role !== "administrator") return json({ code: "rest_forbidden" }, 403);
    const { file_path, content_base64, commit_message = "Upload via CloudPress" } = body;
    if (!file_path || !content_base64) return json({ code: "missing_params" }, 400);
    const owner = ghOwner(env);
    const repo  = ghRepo(env);
    const token = env.GITHUB_TOKEN;
    if (!owner || !repo || !token) return json({ code: "github_not_configured", message: "GitHub 저장소가 설정되지 않았습니다." }, 503);
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file_path}`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "CloudPress/6.1" },
      body: JSON.stringify({ message: commit_message, content: content_base64 }),
    });
    if (!res.ok) {
      const e = await res.json();
      return json({ code: "github_error", message: e.message }, 500);
    }
    return json({ success: true, file_path });
  }

  return json({ code: "not_found" }, 404);
}

// ─── WordPress 관리자 UI 렌더링 ──────────────────────────────────────────────
async function buildAdminPage(env, url, user) {
  const siteUrl  = await getOption(env, "siteurl") || `${url.protocol}//${url.host}`;
  const blogname = await getOption(env, "blogname") || "WordPress 사이트";

  return `<!DOCTYPE html>
<html lang="ko" class="wp-toolbar">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${blogname} — WordPress</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="/wp-admin/css/wp-admin.min.css">
<link rel="stylesheet" href="/wp-admin/css/colors/fresh/colors.min.css">
<link rel="stylesheet" href="/wp-admin/css/common.min.css">
<style>
:root { --wp-admin-theme-color: #2271b1; --wp-admin-theme-color--rgb: 34,113,177; }
#wpadminbar { position:fixed; top:0; left:0; right:0; z-index:99999; }
#adminmenuwrap { position:fixed; top:32px; bottom:0; width:160px; }
#wpcontent, #wpfooter { margin-left:160px; }
@media screen and (max-width:782px) {
  #adminmenuwrap { position:static; width:100%; }
  #wpcontent { margin-left:0; }
}
.notice { background:#fff; border-left:4px solid #2271b1; padding:12px; margin:20px 0; }
.notice-success { border-left-color:#00a32a; }
.notice-error   { border-left-color:#d63638; }
#wp-auth-check-wrap { display:none; }
#cp-loading { position:fixed; inset:0; background:rgba(255,255,255,.8); z-index:999998; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; font-size:14px; color:#1d2327; }
#cp-loading.hidden { display:none; }
</style>
</head>
<body class="wp-core-ui js auto-fold branch-6-7 version-6-7-2 locale-ko_KR">
<div id="cp-loading">
  <div style="width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#2271b1;border-radius:50%;animation:spin .7s linear infinite;"></div>
  <span>WordPress 불러오는 중...</span>
</div>
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>

<div id="wpadminbar" style="height:32px;background:#1d2327;color:#fff;display:flex;align-items:center;padding:0 16px;gap:16px;font-size:13px;">
  <a href="${siteUrl}" target="_blank" style="color:#a7aaad;text-decoration:none;">🏠 사이트 보기</a>
  <span style="color:#a7aaad;">|</span>
  <span style="color:#fff;font-weight:600;">${blogname}</span>
  <span style="flex:1"></span>
  <a href="#" id="wp-logout-btn" style="color:#a7aaad;text-decoration:none;font-size:12px;">로그아웃</a>
</div>

<div id="adminmenuwrap" style="background:#1d2327;padding-top:8px;overflow-y:auto;">
  <ul id="adminmenu" style="list-style:none;margin:0;padding:0;">
    ${[
      ["index.php","📊","알림판"],
      ["edit.php","📝","글"],
      ["edit.php?post_type=page","📄","페이지"],
      ["upload.php","🖼","미디어"],
      ["edit-comments.php","💬","댓글"],
      ["themes.php","🎨","외모"],
      ["plugins.php","🔌","플러그인"],
      ["users.php","👥","사용자"],
      ["options-general.php","⚙️","설정"],
    ].map(([href, icon, label]) =>
      `<li><a href="/wp-admin/${href}" style="display:flex;align-items:center;gap:10px;padding:8px 16px;color:#a7aaad;text-decoration:none;font-size:13px;">${icon} ${label}</a></li>`
    ).join("")}
  </ul>
</div>

<div id="wpcontent" style="padding-top:32px;">
  <div id="wpbody">
    <div id="wpbody-content" style="padding:20px;">
      <div id="cp-admin-app"></div>
    </div>
  </div>
</div>

<script>
const WP_API = '/wp-json';
const CP_API = '/wp-json/cloudpress/v1';
const siteUrl = '${siteUrl}';

// 인증 토큰 가져오기
function getToken() {
  return document.cookie.match(/(?:^|;\\s*)wp_token=([^;]+)/)?.[1];
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + decodeURIComponent(token) } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
  return res.json();
}

// 현재 페이지 감지
const page = location.pathname.replace(/^\\/wp-admin\\//, '') || 'index.php';
const searchP = new URLSearchParams(location.search);

async function renderPage() {
  const app = document.getElementById('cp-admin-app');
  document.getElementById('cp-loading').classList.add('hidden');

  if (page === 'index.php' || page === '') {
    const [posts, pages, comments] = await Promise.all([
      apiFetch(WP_API + '/wp/v2/posts?per_page=5').catch(() => []),
      apiFetch(WP_API + '/wp/v2/pages?per_page=5').catch(() => []),
      apiFetch(WP_API + '/wp/v2/comments?per_page=5').catch(() => []),
    ]);
    app.innerHTML = \`
      <div class="wrap">
        <h1>알림판</h1>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:20px 0;">
          <div style="background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;">
            <div style="font-size:2rem;font-weight:700;color:#2271b1;">\${posts.length}</div>
            <div style="color:#646970;">최근 글</div>
          </div>
          <div style="background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;">
            <div style="font-size:2rem;font-weight:700;color:#2271b1;">\${pages.length}</div>
            <div style="color:#646970;">페이지</div>
          </div>
          <div style="background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;">
            <div style="font-size:2rem;font-weight:700;color:#2271b1;">\${comments.length}</div>
            <div style="color:#646970;">댓글</div>
          </div>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;margin-top:16px;">
          <h2 style="font-size:14px;margin:0 0 12px;">최근 글</h2>
          \${posts.map(p => \`<div style="padding:8px 0;border-bottom:1px solid #f0f0f1;"><a href="\${p.link}" target="_blank">\${p.title.rendered}</a> — <span style="color:#646970;font-size:12px;">\${p.date?.slice(0,10)}</span></div>\`).join('') || '<p style="color:#646970;">글이 없습니다.</p>'}
        </div>
      </div>\`;
  }
  else if (page === 'edit.php' || page.startsWith('edit.php')) {
    const postType = searchP.get('post_type') || 'post';
    const endpoint = postType === 'page' ? 'pages' : 'posts';
    const items = await apiFetch(\`\${WP_API}/wp/v2/\${endpoint}?per_page=20&status=any\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>\${postType === 'page' ? '페이지 목록' : '글 목록'}
          <a href="/wp-admin/post-new.php\${postType === 'page' ? '?post_type=page' : ''}" style="margin-left:12px;font-size:13px;background:#2271b1;color:#fff;padding:4px 12px;border-radius:3px;text-decoration:none;">새로 추가</a>
        </h1>
        <table style="width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#f6f7f7;"><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">제목</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">상태</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">날짜</th><th style="padding:8px 12px;border-bottom:1px solid #c3c4c7;">작업</th></tr></thead>
          <tbody>
            \${items.map(p => \`<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;"><a href="/wp-admin/post.php?post=\${p.id}&action=edit">\${p.title.rendered || '(제목 없음)'}</a></td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${p.status}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${(p.date||'').slice(0,10)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">
                <a href="/wp-admin/post.php?post=\${p.id}&action=edit" style="margin-right:8px;">수정</a>
                <a href="\${p.link}" target="_blank">보기</a>
              </td>
            </tr>\`).join('') || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#646970;">항목이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>\`;
  }
  else if (page === 'post-new.php' || (page === 'post.php' && searchP.get('action') === 'edit')) {
    const postId  = searchP.get('post');
    const postType = searchP.get('post_type') || 'post';
    let existing = { title: { rendered: '' }, content: { raw: '' }, status: 'draft' };
    if (postId) {
      const ep = postType === 'page' ? 'pages' : 'posts';
      existing = await apiFetch(\`\${WP_API}/wp/v2/\${ep}/\${postId}\`).catch(() => existing);
    }
    app.innerHTML = \`
      <div class="wrap">
        <h1>\${postId ? '글 수정' : '새 글 추가'}</h1>
        <div style="display:grid;grid-template-columns:1fr 280px;gap:16px;margin-top:16px;">
          <div>
            <input id="post-title" type="text" value="\${existing.title.rendered}" placeholder="제목 입력..." style="width:100%;padding:12px;font-size:20px;border:1px solid #8c8f94;border-radius:4px;margin-bottom:12px;box-sizing:border-box;">
            <textarea id="post-content" style="width:100%;height:400px;padding:12px;border:1px solid #8c8f94;border-radius:4px;font-size:14px;font-family:monospace;box-sizing:border-box;">\${existing.content?.raw || ''}</textarea>
          </div>
          <div>
            <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:16px;margin-bottom:16px;">
              <h2 style="font-size:14px;margin:0 0 12px;">공개 설정</h2>
              <select id="post-status" style="width:100%;padding:6px;margin-bottom:12px;">
                <option value="publish" \${existing.status==='publish'?'selected':''}>공개</option>
                <option value="draft"   \${existing.status==='draft'  ?'selected':''}>임시글</option>
                <option value="private" \${existing.status==='private'?'selected':''}>비공개</option>
              </select>
              <button id="save-post" style="width:100%;padding:8px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">\${existing.status === 'publish' ? '업데이트' : '발행'}</button>
            </div>
          </div>
        </div>
      </div>\`;

    document.getElementById('save-post').onclick = async () => {
      const title   = document.getElementById('post-title').value;
      const content = document.getElementById('post-content').value;
      const status  = document.getElementById('post-status').value;
      const ep = postType === 'page' ? 'pages' : 'posts';
      try {
        const saved = postId
          ? await apiFetch(\`\${WP_API}/wp/v2/\${ep}/\${postId}\`, { method:'POST', body: JSON.stringify({title,content,status}) })
          : await apiFetch(\`\${WP_API}/wp/v2/\${ep}\`, { method:'POST', body: JSON.stringify({title,content,status}) });
        alert('저장되었습니다!');
        location.href = \`/wp-admin/post.php?post=\${saved.id}&action=edit\`;
      } catch(e) { alert('저장 실패: ' + e.message); }
    };
  }
  else if (page === 'upload.php') {
    const media = await apiFetch(\`\${WP_API}/wp/v2/media?per_page=20\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>미디어 라이브러리</h1>
        <input type="file" id="media-upload" accept="image/*,video/*,audio/*" style="margin:16px 0;">
        <button onclick="uploadMedia()" style="padding:6px 16px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;">업로드</button>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:20px;">
          \${media.map(m => \`<div style="border:1px solid #c3c4c7;border-radius:4px;overflow:hidden;">
            \${m.media_type==='image' ? \`<img src="\${m.source_url}" style="width:100%;height:120px;object-fit:cover;">\` : \`<div style="height:120px;background:#f6f7f7;display:flex;align-items:center;justify-content:center;font-size:32px;">📄</div>\`}
            <div style="padding:8px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${m.title.rendered}</div>
          </div>\`).join('') || '<p style="color:#646970;">미디어가 없습니다.</p>'}
        </div>
      </div>\`;

    window.uploadMedia = async () => {
      const file = document.getElementById('media-upload').files[0];
      if (!file) return;
      const token = getToken();
      const res   = await fetch(\`\${WP_API}/wp/v2/media\`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + decodeURIComponent(token), 'Content-Disposition': \`attachment; filename="\${file.name}"\`, 'Content-Type': file.type },
        body: file,
      });
      if (res.ok) { alert('업로드 완료!'); location.reload(); }
      else alert('업로드 실패');
    };
  }
  else if (page === 'edit-comments.php') {
    const comments = await apiFetch(\`\${WP_API}/wp/v2/comments?per_page=20\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>댓글</h1>
        <table style="width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#f6f7f7;"><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">작성자</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">내용</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">날짜</th></tr></thead>
          <tbody>
            \${comments.map(c => \`<tr><td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${c.author_name}</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${c.content.rendered}</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${(c.date||'').slice(0,10)}</td></tr>\`).join('') || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#646970;">댓글이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>\`;
  }
  else if (page === 'options-general.php') {
    const settings = await apiFetch(\`\${WP_API}/wp/v2/settings\`).catch(() => ({}));
    app.innerHTML = \`
      <div class="wrap">
        <h1>일반 설정</h1>
        <table style="background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;width:100%;max-width:700px;margin-top:16px;">
          \${[
            ['사이트 제목','title','text',settings.title||''],
            ['태그라인','description','text',settings.description||''],
            ['관리자 이메일','email','email',settings.email||''],
            ['타임존','timezone','text',settings.timezone||'Asia/Seoul'],
            ['페이지당 글 수','posts_per_page','number',settings.posts_per_page||10],
          ].map(([label,name,type,val]) => \`<tr>
            <th style="padding:12px 16px;text-align:left;border-bottom:1px solid #f0f0f1;width:200px;background:#f6f7f7;">\${label}</th>
            <td style="padding:12px 16px;border-bottom:1px solid #f0f0f1;"><input type="\${type}" id="s-\${name}" value="\${val}" style="padding:6px;border:1px solid #8c8f94;border-radius:4px;width:300px;"></td>
          </tr>\`).join('')}
        </table>
        <p style="margin-top:16px;"><button id="save-settings" style="padding:8px 16px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;">변경 사항 저장</button></p>
      </div>\`;

    document.getElementById('save-settings').onclick = async () => {
      const data = {};
      ['title','description','email','timezone','posts_per_page'].forEach(k => {
        const el = document.getElementById('s-' + k);
        if (el) data[k] = k === 'posts_per_page' ? parseInt(el.value) : el.value;
      });
      try {
        await apiFetch(\`\${WP_API}/wp/v2/settings\`, { method:'POST', body: JSON.stringify(data) });
        alert('저장되었습니다!');
      } catch(e) { alert('저장 실패: ' + e.message); }
    };
  }
  else if (page === 'themes.php') {
    const themes = await apiFetch(\`\${WP_API}/wp/v2/themes\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>테마</h1>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px;">
          \${themes.map(t => \`<div style="background:#fff;border:\${t.status==='active'?'2px solid #2271b1':'1px solid #c3c4c7'};border-radius:4px;overflow:hidden;">
            <div style="padding:16px;">
              <div style="font-weight:700;">\${t.name.rendered}</div>
              \${t.status==='active' ? '<div style="color:#2271b1;font-size:12px;margin-top:4px;">✓ 활성화됨</div>' : \`<button onclick="activateTheme('\${t.stylesheet}')" style="margin-top:8px;padding:4px 12px;background:#f0f0f1;border:1px solid #c3c4c7;border-radius:3px;cursor:pointer;font-size:12px;">활성화</button>\`}
            </div>
          </div>\`).join('') || '<p style="color:#646970;">테마가 없습니다.</p>'}
        </div>
      </div>\`;

    window.activateTheme = async (stylesheet) => {
      try {
        await apiFetch(\`\${WP_API}/wp/v2/themes/\${stylesheet}\`, { method:'POST', body: JSON.stringify({status:'active'}) });
        alert('테마가 활성화되었습니다!');
        location.reload();
      } catch(e) { alert('실패: ' + e.message); }
    };
  }
  else if (page === 'plugins.php') {
    const plugins = await apiFetch(\`\${WP_API}/wp/v2/plugins\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>플러그인</h1>
        <table style="width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#f6f7f7;"><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">플러그인</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">상태</th><th style="padding:8px 12px;border-bottom:1px solid #c3c4c7;">작업</th></tr></thead>
          <tbody>
            \${plugins.map(p => \`<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;font-weight:600;">\${p.name}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${p.status === 'active' ? '<span style="color:#00a32a;">활성화됨</span>' : '<span style="color:#646970;">비활성화됨</span>'}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">
                \${p.status === 'active'
                  ? \`<button onclick="togglePlugin('\${encodeURIComponent(p.plugin)}','inactive')" style="padding:4px 12px;cursor:pointer;">비활성화</button>\`
                  : \`<button onclick="togglePlugin('\${encodeURIComponent(p.plugin)}','active')" style="padding:4px 12px;background:#2271b1;color:#fff;border:none;border-radius:3px;cursor:pointer;">활성화</button>\`}
              </td>
            </tr>\`).join('') || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#646970;">플러그인이 없습니다. GitHub 레포에 wp-content/plugins/ 폴더를 추가하세요.</td></tr>'}
          </tbody>
        </table>
      </div>\`;

    window.togglePlugin = async (plugin, status) => {
      try {
        await apiFetch(\`\${WP_API}/wp/v2/plugins/\${plugin}\`, { method:'PUT', body: JSON.stringify({status}) });
        location.reload();
      } catch(e) { alert('실패: ' + e.message); }
    };
  }
  else if (page === 'users.php') {
    const users = await apiFetch(\`\${WP_API}/wp/v2/users\`).catch(() => []);
    app.innerHTML = \`
      <div class="wrap">
        <h1>사용자</h1>
        <table style="width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#f6f7f7;"><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">사용자</th><th style="padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;">이름</th></tr></thead>
          <tbody>
            \${users.map(u => \`<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${u.slug}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #f0f0f1;">\${u.name}</td>
            </tr>\`).join('')}
          </tbody>
        </table>
      </div>\`;
  }
  else {
    app.innerHTML = \`<div class="wrap"><h1>페이지를 찾을 수 없습니다</h1><p><a href="/wp-admin/">알림판으로 이동</a></p></div>\`;
  }
}

// 로그아웃
document.getElementById('wp-logout-btn').onclick = async (e) => {
  e.preventDefault();
  await fetch(CP_API + '/token/logout', { method:'POST' });
  location.href = '/wp-login.php';
};

// 인증 확인 후 렌더링
fetch(CP_API + '/token/validate', {
  method: 'POST',
  headers: getToken() ? { 'Authorization': 'Bearer ' + decodeURIComponent(getToken()) } : {},
}).then(r => r.json()).then(d => {
  if (d.code !== 'jwt_auth_valid_token') {
    location.href = '/wp-login.php?redirect_to=' + encodeURIComponent(location.href);
  } else {
    renderPage().catch(e => {
      console.error(e);
      document.getElementById('cp-loading').classList.add('hidden');
      document.getElementById('cp-admin-app').innerHTML = '<div class="wrap"><div class="notice notice-error"><p>오류: ' + e.message + '</p></div></div>';
    });
  }
}).catch(() => { location.href = '/wp-login.php'; });
</script>
</body>
</html>`;
}

// ─── WordPress 로그인 페이지 ─────────────────────────────────────────────────
function buildLoginPage(siteUrl, blogname, error = "") {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>로그인 — ${blogname}</title>
<link rel="stylesheet" href="/wp-admin/css/wp-admin.min.css">
<style>
body { background:#f0f0f1; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; font-family:-apple-system,BlinkMacSystemFont,sans-serif; }
#login { width:320px; }
#login h1 a { display:block; text-align:center; font-size:24px; font-weight:800; color:#1d2327; text-decoration:none; margin-bottom:20px; }
#loginform { background:#fff; padding:26px; border:1px solid #c3c4c7; border-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,.04); }
#loginform label { display:block; font-size:14px; font-weight:600; margin-bottom:4px; }
#loginform input[type=text],
#loginform input[type=password] { width:100%; padding:8px; border:1px solid #8c8f94; border-radius:4px; font-size:15px; margin-bottom:14px; box-sizing:border-box; }
#wp-submit { width:100%; padding:10px; background:#2271b1; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:14px; font-weight:600; }
#wp-submit:hover { background:#135e96; }
.login-error { background:#fff; border-left:4px solid #d63638; padding:12px; margin-bottom:16px; border-radius:4px; font-size:14px; }
</style>
</head>
<body>
<div id="login">
  <h1><a href="${siteUrl}">${blogname}</a></h1>
  ${error ? `<div class="login-error">${error}</div>` : ""}
  <form id="loginform" method="post">
    <label for="user_login">아이디 또는 이메일</label>
    <input id="user_login" type="text" name="log" autocomplete="username" autofocus>
    <label for="user_pass">비밀번호</label>
    <input id="user_pass" type="password" name="pwd" autocomplete="current-password">
    <input id="wp-submit" type="submit" value="로그인">
  </form>
</div>
<script>
document.getElementById('loginform').addEventListener('submit', async function(e) {
  e.preventDefault();
  const username = document.getElementById('user_login').value;
  const password = document.getElementById('user_pass').value;
  const btn      = document.getElementById('wp-submit');
  btn.value = '로그인 중...'; btn.disabled = true;
  try {
    const res = await fetch('/wp-json/cloudpress/v1/token', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username, password}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '로그인 실패');
    const redirect = new URLSearchParams(location.search).get('redirect_to') || '/wp-admin/';
    location.href = redirect;
  } catch(err) {
    document.querySelector('.login-error')?.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'login-error';
    errDiv.textContent = err.message;
    document.getElementById('loginform').before(errDiv);
    btn.value = '로그인'; btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}

// ─── 프론트엔드 WordPress 렌더링 ─────────────────────────────────────────────
async function buildFrontPage(env, url) {
  const siteUrl   = await getOption(env, "siteurl")         || `${url.protocol}//${url.host}`;
  const blogname  = await getOption(env, "blogname")        || "WordPress 사이트";
  const blogdesc  = await getOption(env, "blogdescription") || "";

  const path    = url.pathname.replace(/\/$/, "") || "/";
  const d       = db(env);

  // 특정 페이지 slug 체크
  if (path !== "/" && d) {
    const post = await d.prepare(
      "SELECT * FROM wp_posts WHERE post_name=? AND post_status='publish' LIMIT 1"
    ).bind(path.replace(/^\//, "")).first().catch(() => null);
    if (post) {
      return buildPostHtml(post, siteUrl, blogname, blogdesc);
    }
  }

  // 메인 페이지: 최근 글 목록
  const posts = d ? (await d.prepare(
    "SELECT * FROM wp_posts WHERE post_status='publish' AND post_type='post' ORDER BY post_date DESC LIMIT 10"
  ).all().catch(() => ({ results: [] }))).results || [] : [];

  const postsHtml = posts.length === 0
    ? `<p style="color:#6b7280;padding:40px;text-align:center;">아직 작성된 글이 없습니다.</p>`
    : posts.map(p => `
        <article style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e5e7eb;margin-bottom:16px;">
          <h2 style="margin:0 0 8px;"><a href="/${p.post_name}/" style="color:#1d2327;text-decoration:none;">${p.post_title}</a></h2>
          <div style="color:#6b7280;font-size:13px;margin-bottom:12px;">${(p.post_date||"").slice(0,10)}</div>
          <div style="color:#374151;line-height:1.6;">${(p.post_excerpt || p.post_content || "").slice(0,200).replace(/<[^>]*>/g,"")}${p.post_content?.length > 200 ? "..." : ""}</div>
          <a href="/${p.post_name}/" style="display:inline-block;margin-top:12px;color:#2271b1;text-decoration:none;font-size:14px;">더 읽기 →</a>
        </article>`
    ).join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${blogname}</title>
<meta name="description" content="${blogdesc}">
<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;color:#1d2327;}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 0;}
.container{max-width:800px;margin:0 auto;padding:0 16px;}
nav a{color:#2271b1;text-decoration:none;margin-right:16px;font-size:14px;}
nav a:hover{text-decoration:underline;}
main{padding:32px 0;}
footer{background:#fff;border-top:1px solid #e5e7eb;padding:16px;text-align:center;color:#6b7280;font-size:13px;margin-top:40px;}
</style>
</head>
<body>
<header>
  <div class="container" style="display:flex;align-items:center;justify-content:space-between;">
    <a href="/" style="font-size:20px;font-weight:700;color:#1d2327;text-decoration:none;">${blogname}</a>
    <nav>
      <a href="/">홈</a>
      <a href="/wp-admin/">관리자</a>
    </nav>
  </div>
</header>
<main>
  <div class="container">
    ${blogdesc ? `<p style="color:#6b7280;margin-bottom:24px;">${blogdesc}</p>` : ""}
    ${postsHtml}
  </div>
</main>
<footer>
  <p>${blogname} &mdash; Powered by <a href="https://cloudpress.site" style="color:#2271b1;">CloudPress</a></p>
</footer>
</body>
</html>`;
}

function buildPostHtml(post, siteUrl, blogname, blogdesc) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${post.post_title} — ${blogname}</title>
<link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;color:#1d2327;}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 0;}
.container{max-width:800px;margin:0 auto;padding:0 16px;}
nav a{color:#2271b1;text-decoration:none;margin-right:16px;font-size:14px;}
article{background:#fff;border-radius:8px;padding:32px;border:1px solid #e5e7eb;margin-top:24px;line-height:1.8;}
article h1{margin-top:0;}
.post-meta{color:#6b7280;font-size:13px;margin-bottom:24px;}
footer{background:#fff;border-top:1px solid #e5e7eb;padding:16px;text-align:center;color:#6b7280;font-size:13px;margin-top:40px;}
</style>
</head>
<body>
<header>
  <div class="container" style="display:flex;align-items:center;justify-content:space-between;">
    <a href="/" style="font-size:20px;font-weight:700;color:#1d2327;text-decoration:none;">${blogname}</a>
    <nav><a href="/">홈</a><a href="/wp-admin/">관리자</a></nav>
  </div>
</header>
<div class="container">
  <article>
    <h1>${post.post_title}</h1>
    <div class="post-meta">${(post.post_date||"").slice(0,10)}</div>
    <div>${post.post_content || ""}</div>
  </article>
  <p style="margin-top:16px;"><a href="/" style="color:#2271b1;text-decoration:none;">← 목록으로</a></p>
</div>
<footer>
  <p>${blogname} &mdash; Powered by <a href="https://cloudpress.site" style="color:#2271b1;">CloudPress</a></p>
</footer>
</body>
</html>`;
}

// ─── 메인 fetch 핸들러 ────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // CORS Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── WordPress 코어 정적 자산 (wp-admin/*, wp-includes/*) ────────────────
    if (STATIC_EXT.test(path)) {
      // 1) 사용자 GitHub 레포에서 서빙 (테마/플러그인)
      if (path.startsWith("/wp-content/")) {
        const repoPath = path.replace(/^\//, "");
        const ghRes    = await serveGithubAsset(env, repoPath);
        if (ghRes) return ghRes;
      }
      // 2) WordPress 공식 코어에서 서빙
      const corePath = path.replace(/^\//, "");
      const coreRes  = await serveCoreAsset(corePath);
      if (coreRes) return coreRes;

      return new Response("Not Found", { status: 404, headers: CORS });
    }

    // ── REST API ─────────────────────────────────────────────────────────────
    if (path.startsWith("/wp-json")) {
      // DB가 없으면 아직 프로비저닝 중
      const d = db(env);
      if (!d) return json({ error: "Database not ready. Please wait for provisioning to complete." }, 503);

      // DB 있고 WordPress 미설치시 자동 설치
      const installed = await isWpInstalled(env);
      if (!installed) {
        const ok = await autoInstallWordPress(env, url);
        if (!ok) return json({ error: "WordPress installation failed." }, 500);
      }
      return handleRestApi(request, env, url);
    }

    // ── WordPress 관리자 ──────────────────────────────────────────────────────
    if (path.startsWith("/wp-admin")) {
      const d = db(env);
      if (!d) return html(`<html><body><h1>프로비저닝 중...</h1><p>잠시 후 다시 시도해 주세요.</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>`);

      const installed = await isWpInstalled(env);
      if (!installed) {
        const ok = await autoInstallWordPress(env, url);
        if (!ok) return html(`<html><body><h1>WordPress 초기화 실패</h1><p>D1 데이터베이스 바인딩을 확인해 주세요.</p></body></html>`, 500);
      }

      const user = await getAuthUser(request, env);
      const page = await buildAdminPage(env, url, user);
      return html(page);
    }

    // ── WordPress 로그인 ──────────────────────────────────────────────────────
    if (path === "/wp-login.php" || path === "/wp-login") {
      const siteUrl  = `${url.protocol}//${url.host}`;
      const blogname = await getOption(env, "blogname").catch(() => "WordPress");
      return html(buildLoginPage(siteUrl, blogname || "WordPress"));
    }

    // ── 사이트맵 ─────────────────────────────────────────────────────────────
    if (path === "/sitemap.xml" || path === "/sitemap") {
      const siteUrl = `${url.protocol}//${url.host}`;
      const d = db(env);
      const posts = d ? (await d.prepare("SELECT post_name, post_modified FROM wp_posts WHERE post_status='publish' ORDER BY post_modified DESC LIMIT 100").all().catch(() => ({ results: [] }))).results || [] : [];
      const urls = posts.map(p => `  <url><loc>${siteUrl}/${p.post_name}/</loc><lastmod>${(p.post_modified||"").slice(0,10)}</lastmod></url>`).join("\n");
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc></url>\n${urls}\n</urlset>`, {
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      });
    }

    // ── 프론트엔드 WordPress ─────────────────────────────────────────────────
    const d = db(env);
    if (!d) {
      return html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>CloudPress</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb;">
      <div style="text-align:center;"><h1 style="color:#2271b1;">🚀 CloudPress</h1><p style="color:#6b7280;">사이트를 준비 중입니다. 잠시 후 다시 시도해 주세요.</p><script>setTimeout(()=>location.reload(),10000)</script></div></body></html>`);
    }

    const installed = await isWpInstalled(env);
    if (!installed) {
      await autoInstallWordPress(env, url);
    }

    const frontPage = await buildFrontPage(env, url);
    return html(frontPage);
  },
};
