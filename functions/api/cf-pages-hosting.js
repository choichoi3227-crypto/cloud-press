/**
 * CloudPress — cf-pages-hosting.js v6.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 진짜 WordPress 호스팅 프로비저닝 (D1 완전 제거 버전)
 *
 * 변경사항:
 *   - D1 완전 제거 → GitHub 레포 내 _db/wordpress.db (SQLite) 사용
 *   - 이메일·유저네임·비밀번호 자동 생성 (사용자 입력 불필요)
 *   - Cloudflare Worker = 오직 미러링 코드만
 *   - GitHub Action으로 모든 진짜 WP 파일 자동 설치
 *   - php-wasm 코드(php-runner.js)를 GitHub 레포에 포함
 *   - Cloudflare 장애 시 GitHub Pages 폴백 로직 내장
 */

import { pickGithubToken } from "./github-storage.js";

// ─── 상수 ────────────────────────────────────────────────────────────────────
const WP_VERSION = "latest";

// ─── 유틸 ────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function slugify(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function randomStr(len = 16) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => chars[b % chars.length]).join("");
}

function randomPass(len = 20) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => chars[b % chars.length]).join("");
}

// ─── MD5 + phpass (WordPress 비밀번호 해시) ──────────────────────────────────
function _md5(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const msgLen = bytes.length, bitLen = msgLen * 8;
  const padLen = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);
  const padded = new Uint8Array(msgLen + padLen + 8);
  padded.set(bytes); padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(msgLen + padLen, bitLen >>> 0, true);
  view.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(i + j * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if      (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5*j+1)%16; }
      else if (j < 48) { f = b ^ c ^ d;           g = (3*j+5)%16; }
      else             { f = c ^ (b | ~d);         g = (7*j)%16; }
      f = (f + a + T[j] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << S[j]) | (f >>> (32 - S[j])))) >>> 0;
    }
    a0=(a0+a)>>>0; b0=(b0+b)>>>0; c0=(c0+c)>>>0; d0=(d0+d)>>>0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

function phpassCreate(password) {
  const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const countLog2 = 8;
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./";
  const rnd = new Uint8Array(8);
  crypto.getRandomValues(rnd);
  let salt = "";
  for (const b of rnd) salt += chars[b % chars.length];
  const prefix = `$P$${ITOA64[countLog2]}${salt}`;
  let count = 1 << countLog2;
  const passBytes = new TextEncoder().encode(password);
  let h = _md5(salt + password);
  while (count--) {
    const c = new Uint8Array(h.length + passBytes.length);
    c.set(h); c.set(passBytes, h.length);
    h = _md5(c);
  }
  const ITOA64a = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let output = "", i = 0;
  while (i < 16) {
    let value = h[i++];
    output += ITOA64a[value & 0x3f];
    if (i < 16) value |= h[i] << 8;
    output += ITOA64a[(value >> 6) & 0x3f];
    if (i++ >= 16) break;
    if (i < 16) value |= h[i] << 16;
    output += ITOA64a[(value >> 12) & 0x3f];
    if (i++ >= 16) break;
    output += ITOA64a[(value >> 18) & 0x3f];
  }
  return prefix + output;
}

// ─── GitHub API 헬퍼 ─────────────────────────────────────────────────────────
async function ghReq(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization:          `Bearer ${token}`,
      Accept:                 "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type":         "application/json",
      "User-Agent":           "CloudPress/6.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ─── GitHub Tree API 배치 push ───────────────────────────────────────────────
async function ghBatchPush(token, owner, repo, files, commitMsg) {
  const refRes = await ghReq("GET", `/repos/${owner}/${repo}/git/refs/heads/main`, token);
  if (!refRes.ok) return false;
  const baseSha    = refRes.data?.object?.sha;
  const commitRes  = await ghReq("GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  const baseTreeSha = commitRes.data?.tree?.sha;

  const tree = files.map(({ path, content }) => ({
    path, mode: "100644", type: "blob", content,
  }));

  const treeRes = await ghReq("POST", `/repos/${owner}/${repo}/git/trees`, token, {
    base_tree: baseTreeSha,
    tree,
  });
  if (!treeRes.ok) return false;

  const commitNewRes = await ghReq("POST", `/repos/${owner}/${repo}/git/commits`, token, {
    message: commitMsg,
    tree:    treeRes.data?.sha,
    parents: [baseSha],
  });
  if (!commitNewRes.ok) return false;

  const updateRes = await ghReq("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, token, {
    sha:   commitNewRes.data?.sha,
    force: false,
  });
  return updateRes.ok;
}

// ─── Cloudflare API 헬퍼 ─────────────────────────────────────────────────────
async function cfReq(apiToken, method, path, body, cfEmail) {
  const headers = { "Content-Type": "application/json" };
  if (cfEmail) {
    headers["X-Auth-Email"] = cfEmail;
    headers["X-Auth-Key"]   = apiToken;
  } else {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ─── KV 생성 (캐시용 — D1 제거, KV는 유지) ──────────────────────────────────
async function createKVNamespace({ cfToken, cfAccountId, cfEmail, title, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  KV 생성 중: ${title}`);
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/storage/kv/namespaces`, { title }, cfEmail);
  if (!res.ok) {
    const errMsg = res.data?.errors?.[0]?.message || "";
    if (errMsg.toLowerCase().includes("already exist") || res.status === 409) {
      const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/storage/kv/namespaces`, null, cfEmail);
      const found = listRes.data?.result?.find(ns => ns.title === title);
      if (found) { await log(`  KV 기존 사용: ${found.id}`); return found.id; }
    }
    await log(`  KV 생성 실패: ${JSON.stringify(res.data?.errors)}`, "error");
    return null;
  }
  const id = res.data?.result?.id;
  await log(`  KV 생성 완료: ${id}`);
  return id;
}

// ─── GitHub 레포 생성 ────────────────────────────────────────────────────────
async function createGitHubRepo({ ghToken, owner, repoName, log }) {
  await log(`  GitHub 레포 생성: ${owner}/${repoName}`);
  const res = await ghReq("POST", "/user/repos", ghToken, {
    name:        repoName,
    private:     false,
    description: `CloudPress WordPress 사이트 — ${repoName}`,
    auto_init:   true,
  });
  if (!res.ok && res.status !== 422) {
    await log(`  레포 생성 실패: ${JSON.stringify(res.data?.errors)}`, "error");
    return false;
  }
  if (res.status === 422) {
    await log(`  레포 기존 사용: ${owner}/${repoName}`);
  } else {
    await log(`  레포 생성 완료: ${owner}/${repoName}`);
  }
  await delay(2000);
  return true;
}

// ─── wp-config.php 생성 (SQLite 전용) ───────────────────────────────────────
function buildWpConfig({
  siteId, siteUrl, dbPrefix,
  authKey, secureAuthKey, loggedInKey, nonceKey,
  authSalt, secureAuthSalt, loggedInSalt, nonceSalt,
}) {
  return `<?php
/**
 * WordPress 기본 설정 파일
 * CloudPress 자동 생성 — 직접 수정하지 마세요
 * 데이터베이스: SQLite (_db/wordpress.db — GitHub 레포 저장)
 */

// ── SQLite 데이터베이스 설정 ──────────────────────────────────────────────────
// D1(Cloudflare) 대신 GitHub 레포 내 SQLite .db 파일 사용
// db.php 드롭인(wp-content/db.php)이 SQLite 연결을 처리합니다.
define( 'DB_NAME',     '${siteId}_wp' );
define( 'DB_USER',     'cloudpress' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST',     'localhost' );
define( 'DB_CHARSET',  'utf8mb4' );
define( 'DB_COLLATE',  '' );

// ── SQLite 플러그인 설정 ──────────────────────────────────────────────────────
// wp-content/db.php (SQLite Database Integration 드롭인)
define( 'SQLITE_DB_DIR',  ABSPATH . '_db/' );   // GitHub 레포 내 _db/ 폴더
define( 'SQLITE_DB_FILE', 'wordpress.db' );      // .db 확장자 (D1 금지)

// ── 인증 키 & 솔트 ──────────────────────────────────────────────────────────
define( 'AUTH_KEY',         '${authKey}' );
define( 'SECURE_AUTH_KEY',  '${secureAuthKey}' );
define( 'LOGGED_IN_KEY',    '${loggedInKey}' );
define( 'NONCE_KEY',        '${nonceKey}' );
define( 'AUTH_SALT',        '${authSalt}' );
define( 'SECURE_AUTH_SALT', '${secureAuthSalt}' );
define( 'LOGGED_IN_SALT',   '${loggedInSalt}' );
define( 'NONCE_SALT',       '${nonceSalt}' );

// ── CloudPress 전용 설정 ─────────────────────────────────────────────────────
define( 'CP_SITE_ID', getenv('CP_SITE_ID') ?: '${siteId}' );
define( 'CP_GITHUB_OWNER',  getenv('CP_GITHUB_OWNER')  ?: '' );
define( 'CP_GITHUB_REPO',   getenv('CP_GITHUB_REPO')   ?: '' );
define( 'CP_GITHUB_TOKEN',  getenv('CP_GITHUB_TOKEN')  ?: '' );

// ── 테이블 접두사 ────────────────────────────────────────────────────────────
$table_prefix = '${dbPrefix}';

// ── 절대 경로 ───────────────────────────────────────────────────────────────
if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

// ── 디버그 설정 ─────────────────────────────────────────────────────────────
define( 'WP_DEBUG',         false );
define( 'WP_DEBUG_LOG',     false );
define( 'WP_DEBUG_DISPLAY', false );

// ── 보안 설정 ───────────────────────────────────────────────────────────────
define( 'DISALLOW_FILE_EDIT', true );

// ── 업로드 경로 ──────────────────────────────────────────────────────────────
define( 'UPLOADS', 'wp-content/uploads' );

// ── WordPress 설정 로드 ──────────────────────────────────────────────────────
require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── Worker 소스 빌드 (순수 미러링 코드만) ───────────────────────────────────
function buildWorkerSource({ siteId, githubOwner, githubRepo, ghPagesUrl }) {
  const _ghPagesUrl = ghPagesUrl || "";
  const src = `/**
 * CloudPress — site worker v8.0
 * 사이트 ID: ${siteId}
 * GitHub: ${githubOwner}/${githubRepo}
 * 이 코드는 자동 생성됩니다.
 *
 * 실행 우선순위:
 *   1. PHP_RUNNER Service Binding (배포된 경우) → php-wasm으로 WP 실행
 *   2. KV 캐시 HTML (빠른 응답)
 *   3. 정적 자산: GitHub 레포 → WordPress CDN
 */

const SITE_ID      = "${siteId}";
const GH_OWNER     = "${githubOwner}";
const GH_REPO      = "${githubRepo}";
const GH_BRANCH    = "main";
const GH_PAGES_URL = "${_ghPagesUrl}";
const WP_VERSION   = "latest";

const STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm|gz|tar)$/i;
const SKIP_CACHE  = ["/wp-admin","/wp-login.php","/cart","/checkout","/my-account","/wp-cron.php","/xmlrpc.php"];
const BOT_RE      = /googlebot|bingbot|yandex|baiduspider|facebookexternalhit|twitterbot|slurp|duckduckbot|linkedinbot|whatsapp|telegram/i;

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
  "X-XSS-Protection":      "1; mode=block",
};

function getSiteId(e)  { return e.SITE_ID      || SITE_ID;    }
function getOwner(e)   { return e.GH_OWNER     || GH_OWNER;   }
function getRepo(e)    { return e.GH_REPO      || GH_REPO;    }
function getToken(e)   { return e.GITHUB_TOKEN || "";          }
function getPages(e)   { return e.GH_PAGES_URL || GH_PAGES_URL || ""; }

async function kvGet(e,k)             { try{return await e.CACHE?.get(k);}catch{return null;} }
async function kvGetBuf(e,k)          { try{return await e.CACHE?.get(k,"arrayBuffer");}catch{return null;} }
async function kvPut(e,k,v,t=86400)   { try{await e.CACHE?.put(k,v,{expirationTtl:t});}catch{} }

function mime(p){
  const x=(p.split(".").pop()||"").toLowerCase();
  return({css:"text/css;charset=utf-8",js:"application/javascript;charset=utf-8",
    json:"application/json;charset=utf-8",xml:"application/xml;charset=utf-8",
    svg:"image/svg+xml",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",
    gif:"image/gif",webp:"image/webp",avif:"image/avif",ico:"image/x-icon",
    woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf",
    eot:"application/vnd.ms-fontobject",pdf:"application/pdf",zip:"application/zip",
    mp4:"video/mp4",webm:"video/webm",mp3:"audio/mpeg",ogg:"audio/ogg",
    wav:"audio/wav",txt:"text/plain;charset=utf-8",html:"text/html;charset=utf-8"
  })[x]||"application/octet-stream";
}

async function ghFetch(e, path, noCache=false){
  const owner=getOwner(e),repo=getRepo(e),token=getToken(e);
  if(!owner||!repo)return null;
  const url=\`https://raw.githubusercontent.com/\${owner}/\${repo}/\${GH_BRANCH}/\${path}\`;
  const h={"User-Agent":"CloudPress/8.0"};
  if(token)h["Authorization"]=\`Bearer \${token}\`;
  try{
    const r=await fetch(url,{headers:h,cf:noCache?{cacheEverything:false}:{cacheEverything:true,cacheTtl:300}});
    if(r.ok)return r;
  }catch{}
  return null;
}

async function wpCoreFetch(path){
  const u1=\`https://cdn.jsdelivr.net/gh/WordPress/WordPress@\${WP_VERSION}/\${path}\`;
  try{const r=await fetch(u1,{cf:{cacheEverything:true,cacheTtl:604800}});if(r.ok)return r;}catch{}
  const u2=\`https://raw.githubusercontent.com/WordPress/WordPress/master/\${path}\`;
  try{const r=await fetch(u2,{cf:{cacheEverything:true,cacheTtl:86400}});if(r.ok)return r;}catch{}
  return null;
}

function maintPage(){
  return new Response(\`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="15"><title>유지보수 중</title><style>body{font-family:sans-serif;background:#f0f0f1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:48px;background:#fff;border-radius:8px;border:1px solid #c3c4c7;max-width:420px}</style></head><body><div class="b"><div style="font-size:48px;margin-bottom:16px">🔧</div><h1 style="color:#1d2327;font-size:22px;margin-bottom:12px">유지보수 중</h1><p style="color:#646970;line-height:1.6">설정을 업데이트하고 있습니다.<br>잠시 후 자동으로 다시 접속됩니다.</p></div></body></html>\`,
    {status:503,headers:{"Content-Type":"text/html;charset=utf-8","Retry-After":"30","Cache-Control":"no-store"}});
}

// ─── PHP_RUNNER Service Binding으로 WordPress 실행 ───────────────────────────
async function runViaPhpRunner(req, env, ctx) {
  if(!env.PHP_RUNNER) return null;

  const url    = new URL(req.url);
  const method = req.method.toUpperCase();
  const siteId = getSiteId(env);
  const skipCache = SKIP_CACHE.some(p=>url.pathname.startsWith(p))
    || (req.headers.get("Cookie")||"").includes("wordpress_logged_in");

  let stdin = "";
  if(method==="POST"||method==="PUT"||method==="PATCH"){
    stdin = await req.text().catch(()=>"");
  }

  const payload = {
    phpFile:   url.pathname==="/" ? "/index.php" : url.pathname,
    phpEnv: {
      REQUEST_METHOD:       method,
      REQUEST_URI:          url.pathname + url.search,
      QUERY_STRING:         url.search.slice(1),
      HTTP_HOST:            url.hostname,
      SERVER_NAME:          url.hostname,
      SERVER_PORT:          "443",
      HTTPS:                "on",
      DOCUMENT_ROOT:        "/var/www/wordpress",
      SCRIPT_FILENAME:      \`/var/www/wordpress\${url.pathname==="/"?"/index.php":url.pathname}\`,
      SCRIPT_NAME:          url.pathname==="/"?"/index.php":url.pathname,
      PHP_SELF:             url.pathname==="/"?"/index.php":url.pathname,
      GATEWAY_INTERFACE:    "CGI/1.1",
      SERVER_PROTOCOL:      "HTTP/1.1",
      SERVER_SOFTWARE:      "CloudPress/8.0",
      HTTP_USER_AGENT:      req.headers.get("User-Agent")||"",
      HTTP_ACCEPT:          req.headers.get("Accept")||"",
      HTTP_ACCEPT_LANGUAGE: req.headers.get("Accept-Language")||"",
      HTTP_ACCEPT_ENCODING: req.headers.get("Accept-Encoding")||"",
      HTTP_COOKIE:          req.headers.get("Cookie")||"",
      HTTP_REFERER:         req.headers.get("Referer")||"",
      HTTP_X_FORWARDED_FOR: req.headers.get("CF-Connecting-IP")||"",
      HTTP_AUTHORIZATION:   req.headers.get("Authorization")||"",
      CONTENT_TYPE:         req.headers.get("Content-Type")||"",
      CONTENT_LENGTH:       req.headers.get("Content-Length")||"",
      WP_HOME:              \`https://\${url.hostname}\`,
      WP_SITEURL:           \`https://\${url.hostname}\`,
    },
    stdin,
    siteConfig: {
      siteId,
      githubOwner: getOwner(env),
      githubRepo:  getRepo(env),
      githubToken: getToken(env),
    },
    skipCache,
  };

  try {
    const phpRes = await env.PHP_RUNNER.fetch(
      new Request("https://php-runner/run-wordpress", {
        method:  "POST",
        headers: {"Content-Type":"application/json"},
        body:    JSON.stringify(payload),
      })
    );

    // 5xx → 폴백으로 넘김
    if(!phpRes.ok && phpRes.status>=500) return null;

    // 성공 HTML → KV 캐시 저장 (비로그인 GET만)
    if(!skipCache && method==="GET" && phpRes.ok && phpRes.headers.get("Content-Type")?.includes("text/html")){
      const html = await phpRes.clone().text();
      ctx.waitUntil(
        kvPut(env, \`php:\${siteId}:\${url.pathname}\${url.search}\`, html, 3600)
      );
    }
    return phpRes;
  } catch {
    return null;
  }
}

// ─── 정적 파일 서빙 ──────────────────────────────────────────────────────────
async function serveStatic(req, env, ctx, path) {
  const fp = path.startsWith("/")?path.slice(1):path;
  const siteId = getSiteId(env);

  // wp-content → GitHub 레포 (테마/플러그인/업로드)
  if(path.startsWith("/wp-content/")){
    const ck=\`static:\${siteId}:\${fp}\`;
    const cb=await kvGetBuf(env,ck);
    if(cb)return new Response(cb,{headers:{"Content-Type":mime(fp),"Cache-Control":"public,max-age=3600","X-Cache":"HIT",...SEC_HEADERS}});
    const r=await ghFetch(env,fp);
    if(r){
      const b=await r.arrayBuffer();
      ctx.waitUntil(kvPut(env,ck,b,3600));
      return new Response(b,{headers:{"Content-Type":mime(fp),"Cache-Control":"public,max-age=3600","X-Source":"github",...SEC_HEADERS}});
    }
  }

  // wp-includes / wp-admin 정적 자산 → GitHub 레포 → WordPress CDN
  if(path.startsWith("/wp-includes/")||path.startsWith("/wp-admin/")){
    const gr=await ghFetch(env,fp);
    if(gr){const b=await gr.arrayBuffer();return new Response(b,{headers:{"Content-Type":mime(fp),"Cache-Control":"public,max-age=86400,stale-while-revalidate=604800","X-Source":"github",...SEC_HEADERS}});}
    const cr=await wpCoreFetch(fp);
    if(cr){const b=await cr.arrayBuffer();return new Response(b,{headers:{"Content-Type":mime(fp),"Cache-Control":"public,max-age=86400,immutable","X-Source":"wp-cdn",...SEC_HEADERS}});}
  }

  // 기타 정적 파일
  const cr2=await ghFetch(env,fp.startsWith("_cache/")?fp:\`_cache/\${fp}\`);
  if(cr2){const b=await cr2.arrayBuffer();return new Response(b,{headers:{"Content-Type":mime(fp),"Cache-Control":"public,max-age=86400",...SEC_HEADERS}});}

  return new Response("Not Found",{status:404});
}

export default {
  async fetch(req, env, ctx) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method.toUpperCase();
    const siteId = getSiteId(env);

    // CORS preflight
    if(method==="OPTIONS") return new Response(null,{status:204,headers:{
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET,POST,PUT,DELETE,PATCH,OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type,Authorization,X-WP-Nonce,X-Requested-With",
    }});

    // 헬스체크
    if(path==="/_health") return new Response(
      JSON.stringify({ok:true,site:siteId,engine:env.PHP_RUNNER?"php-wasm":"init",wp:WP_VERSION}),
      {headers:{"Content-Type":"application/json"}}
    );

    // 유지보수 모드
    const maint=await kvGet(env,\`cp:maintenance:\${siteId}\`);
    if(maint==="1"&&!path.startsWith("/wp-admin/")) return maintPage();

    // 1. 정적 파일 처리
    if(STATIC_EXT.test(path)) return serveStatic(req,env,ctx,path);

    // 2. 봇 사전렌더링 캐시 (SEO 최적화)
    const isBot=BOT_RE.test(req.headers.get("User-Agent")||"");
    if(isBot&&method==="GET"){
      const pr=await kvGet(env,\`prerender:\${siteId}:\${path}\${url.search}\`);
      if(pr)return new Response(pr,{headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"public,max-age=300","X-Cache":"PRERENDER",...SEC_HEADERS}});
    }

    // 3. KV HTML 캐시 (비로그인 GET)
    const isLoggedIn=(req.headers.get("Cookie")||"").includes("wordpress_logged_in");
    const cacheable = method==="GET" && !SKIP_CACHE.some(p=>path.startsWith(p)) && !isLoggedIn;
    if(cacheable){
      const c=await kvGet(env,\`php:\${siteId}:\${path}\${url.search}\`);
      if(c)return new Response(c,{headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"public,s-maxage=60,stale-while-revalidate=3600","X-Cache":"HIT",...SEC_HEADERS}});
    }

    // 4. PHP_RUNNER Service Binding으로 WordPress 실행 (핵심 경로)
    const phpRes = await runViaPhpRunner(req,env,ctx);
    if(phpRes) return phpRes;

    // 5. PHP_RUNNER 없음 → GitHub _cache/ 정적 HTML 폴백
    //    (WordPress 아직 미설치이거나 PHP Runner 미배포 상태)
    if(cacheable){
      const cachePath=(path==="/"||path==="")?
        "_cache/index.html":
        \`_cache\${path.endsWith("/")?path:path+"/"}index.html\`;
      const cr=await ghFetch(env,cachePath);
      if(cr){
        const html=await cr.text();
        ctx.waitUntil(kvPut(env,\`html:\${siteId}:\${path}\${url.search}\`,html,3600));
        return new Response(html,{headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"public,s-maxage=60,stale-while-revalidate=3600","X-Cache":"GH-CACHE",...SEC_HEADERS}});
      }
    }

    // 6. GitHub Pages 폴백
    const pagesBase=getPages(env);
    if(pagesBase){
      try{
        const r=await fetch(\`\${pagesBase}\${path}\`,{cf:{cacheEverything:true,cacheTtl:300},headers:{"User-Agent":"CloudPress-Fallback/1.0"}});
        if(r.ok)return new Response(await r.text(),{status:200,headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"public,max-age=60","X-Fallback":"github-pages",...SEC_HEADERS}});
      }catch{}
    }

    // 7. KV stale 캐시 (최후 폴백)
    const stale=await kvGet(env,\`php:\${siteId}:\${path}\${url.search}\`);
    if(stale)return new Response(stale,{status:200,headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"public,max-age=30","X-Fallback":"kv-stale",...SEC_HEADERS}});

    // 8. 모든 폴백 실패 → 설치 상태에 따라 안내 화면 표시
    const repoUrl    = (getOwner(env) && getRepo(env)) ? \`https://github.com/\${getOwner(env)}/\${getRepo(env)}\` : "";
    const actionsUrl = repoUrl ? \`\${repoUrl}/actions/workflows/install-wordpress.yml\` : "";
    const ghPagesActionsUrl = repoUrl ? \`\${repoUrl}/actions/workflows/gh-pages-fallback.yml\` : "";

    // _db/wordpress.db 존재 여부로 설치 완료 판단
    let wpInstalled = false;
    try {
      const dbRes = await ghFetch(env, "_db/wordpress.db");
      wpInstalled = !!dbRes;
    } catch {}

    const commonCss = "*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Malgun Gothic,sans-serif;background:#f0f0f1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}.card{background:#fff;border:1px solid #c3c4c7;border-radius:4px;max-width:520px;width:100%;padding:40px;text-align:center}.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:3px;display:inline-block;margin-bottom:14px}h1{color:#1d2327;font-size:20px;font-weight:600;margin:0 0 10px}p{color:#646970;line-height:1.6;margin:0 0 14px;font-size:14px}a.btn{display:inline-block;background:#2271b1;color:#fff;text-decoration:none;padding:8px 18px;border-radius:3px;font-size:13px;font-weight:600;margin:4px}.steps{text-align:left;background:#f6f7f7;border-radius:4px;padding:14px 18px;margin:14px 0;font-size:13px;color:#3c434a;line-height:2}.note{font-size:12px;color:#a7aaad;margin-top:14px}";

    const statusHtml = wpInstalled
      ? \`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="20">
<title>캐시 생성 중</title><style>\${commonCss}</style></head>
<body><div class="card">
<div class="badge" style="background:#00a32a;color:#fff">ALMOST READY</div>
<h1>🎉 WordPress 설치 완료!</h1>
<p>정적 캐시를 생성하고 있습니다. 잠시 후 사이트가 열립니다.</p>
<ol class="steps">
  <li>✅ GitHub 레포지토리 생성</li>
  <li>✅ WordPress 최신버전 설치 완료</li>
  <li>✅ 데이터베이스 초기화 완료</li>
  <li>⏳ 정적 캐시 생성 중...</li>
</ol>
\${ghPagesActionsUrl?\`<a class="btn" href="\${ghPagesActionsUrl}" target="_blank">🔄 캐시 생성 진행상황 보기</a>\`:""}
\${repoUrl?\` <a class="btn" style="background:#6e7d88" href="\${repoUrl}" target="_blank">📁 GitHub 레포 보기</a>\`:""}
<p class="note">20초마다 자동 새로고침됩니다</p>
</div></body></html>\`
      : \`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="30">
<title>WordPress 준비 중</title><style>\${commonCss}</style></head>
<body><div class="card">
<div class="badge" style="background:#f0b849;color:#fff">WORDPRESS INSTALLING</div>
<h1>⚙️ WordPress 설치 진행 중</h1>
<p>GitHub Actions가 WordPress 최신버전을 자동으로 설치하고 있습니다.</p>
<ol class="steps">
  <li>✅ GitHub 레포지토리 생성</li>
  <li>⏳ WordPress 최신버전 전체 파일 설치 중...</li>
  <li>⏳ 데이터베이스 초기화 중...</li>
  <li>⏳ 정적 캐시 생성 중...</li>
</ol>
\${actionsUrl?\`<a class="btn" href="\${actionsUrl}" target="_blank">🔄 설치 진행상황 보기</a>\`:""}
\${repoUrl?\` <a class="btn" style="background:#6e7d88" href="\${repoUrl}" target="_blank">📁 GitHub 레포 보기</a>\`:""}
<p class="note">30초마다 자동 새로고침됩니다</p>
</div></body></html>\`;

    return new Response(statusHtml,
      {status:503,headers:{"Content-Type":"text/html;charset=utf-8","Cache-Control":"no-store","Retry-After":"30",...SEC_HEADERS}});
  },
};`;
  return src;
}
// ─── GitHub Actions 워크플로우 빌드 ─────────────────────────────────────────

// 메인: WordPress 전체 설치 + SQLite DB 초기화
function buildWpInstallAction({ wpAdminUser, wpAdminPass, wpAdminEmail, siteUrl, siteName, dbPrefix }) {
  const p = dbPrefix || "wp_";
  return `name: 🚀 WordPress 설치 + SQLite DB 초기화

on:
  workflow_dispatch:
    inputs:
      force_reinstall:
        description: '강제 재설치 (기존 파일 덮어쓰기)'
        type: boolean
        default: false

permissions:
  contents: write

jobs:
  install-wordpress:
    name: WordPress 최신버전 설치
    runs-on: ubuntu-latest
    steps:
      - name: 레포 체크아웃
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: SQLite 설치
        run: sudo apt-get install -y sqlite3

      - name: WordPress 최신버전 다운로드 (모든 파일)
        run: |
          echo "📥 WordPress 최신버전 다운로드 중..."
          wget -q https://wordpress.org/latest.tar.gz -O /tmp/wp.tar.gz
          tar -xzf /tmp/wp.tar.gz -C /tmp/
          WP_VER=$(grep "^\$wp_version" /tmp/wordpress/wp-includes/version.php | grep -oP "[\d.]+")
          echo "✅ WordPress \${WP_VER} 압축 해제 완료"

          # wp-config.php는 보호 (덮어쓰지 않음)
          echo "📁 WordPress 파일 복사 중 (wp-config.php 제외)..."
          rsync -a --exclude='wp-config.php' --exclude='wp-config-sample.php' /tmp/wordpress/ ./

          # 설치 확인
          echo "✅ WordPress 루트 파일:"
          ls -la *.php 2>/dev/null | head -20
          echo "✅ wp-includes 디렉토리 크기: $(du -sh wp-includes 2>/dev/null | cut -f1)"
          echo "✅ wp-admin 디렉토리 크기: $(du -sh wp-admin 2>/dev/null | cut -f1)"

      - name: SQLite Database Integration 플러그인 설치
        run: |
          echo "📥 SQLite Database Integration 설치 중..."
          mkdir -p wp-content/plugins wp-content/themes wp-content/uploads

          # SQLite 플러그인 다운로드
          wget -q "https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip" -O /tmp/sqlite-plugin.zip
          unzip -q /tmp/sqlite-plugin.zip -d wp-content/plugins/
          echo "✅ SQLite 플러그인 설치 완료"

          # db.php 드롭인 복사 (WordPress가 SQLite를 기본 DB로 사용하도록)
          PLUGIN_DIR="wp-content/plugins/sqlite-database-integration"
          if [ -f "\${PLUGIN_DIR}/db.copy" ]; then
            cp "\${PLUGIN_DIR}/db.copy" wp-content/db.php
            echo "✅ db.php 드롭인 설치 완료"
          elif [ -f "\${PLUGIN_DIR}/db.php" ]; then
            cp "\${PLUGIN_DIR}/db.php" wp-content/db.php
            echo "✅ db.php 드롭인 설치 완료 (db.php 사용)"
          fi
          cat wp-content/db.php | head -5 || true

      - name: Twenty Twenty-Four 테마 확인
        run: |
          if [ -d "wp-content/themes/twentytwentyfour" ]; then
            echo "✅ Twenty Twenty-Four 테마 존재"
          else
            echo "📥 Twenty Twenty-Four 테마 다운로드..."
            wget -q "https://downloads.wordpress.org/theme/twentytwentyfour.latest-stable.zip" -O /tmp/theme.zip
            unzip -q /tmp/theme.zip -d wp-content/themes/
            echo "✅ 테마 설치 완료"
          fi

      - name: SQLite 데이터베이스 초기화 (_db/wordpress.db)
        run: |
          echo "🗄️ SQLite 데이터베이스 초기화 중..."
          mkdir -p _db

          ADMIN_USER="${wpAdminUser}"
          ADMIN_PASS="${wpAdminPass}"
          ADMIN_EMAIL="${wpAdminEmail}"
          SITE_URL="${siteUrl}"
          SITE_NAME="${siteName}"
          NOW=$(date -u +"%Y-%m-%d %H:%M:%S")
          DB_PREFIX="${p}"

          # SQLite DB 초기화
          sqlite3 _db/wordpress.db << EOSQL
          -- WordPress 핵심 테이블 생성
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}options (
            option_id INTEGER PRIMARY KEY AUTOINCREMENT,
            option_name TEXT NOT NULL DEFAULT '' UNIQUE,
            option_value TEXT NOT NULL DEFAULT '',
            autoload TEXT NOT NULL DEFAULT 'yes'
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}users (
            ID INTEGER PRIMARY KEY AUTOINCREMENT,
            user_login TEXT NOT NULL DEFAULT '',
            user_pass TEXT NOT NULL DEFAULT '',
            user_nicename TEXT NOT NULL DEFAULT '',
            user_email TEXT NOT NULL DEFAULT '',
            user_url TEXT NOT NULL DEFAULT '',
            user_registered TEXT NOT NULL DEFAULT '',
            user_activation_key TEXT NOT NULL DEFAULT '',
            user_status INTEGER NOT NULL DEFAULT 0,
            display_name TEXT NOT NULL DEFAULT ''
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}usermeta (
            umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            meta_key TEXT DEFAULT NULL,
            meta_value TEXT DEFAULT NULL
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}posts (
            ID INTEGER PRIMARY KEY AUTOINCREMENT,
            post_author INTEGER NOT NULL DEFAULT 0,
            post_date TEXT NOT NULL DEFAULT '',
            post_date_gmt TEXT NOT NULL DEFAULT '',
            post_content TEXT NOT NULL DEFAULT '',
            post_title TEXT NOT NULL DEFAULT '',
            post_excerpt TEXT NOT NULL DEFAULT '',
            post_status TEXT NOT NULL DEFAULT 'publish',
            comment_status TEXT NOT NULL DEFAULT 'open',
            ping_status TEXT NOT NULL DEFAULT 'open',
            post_password TEXT NOT NULL DEFAULT '',
            post_name TEXT NOT NULL DEFAULT '',
            to_ping TEXT NOT NULL DEFAULT '',
            pinged TEXT NOT NULL DEFAULT '',
            post_modified TEXT NOT NULL DEFAULT '',
            post_modified_gmt TEXT NOT NULL DEFAULT '',
            post_content_filtered TEXT NOT NULL DEFAULT '',
            post_parent INTEGER NOT NULL DEFAULT 0,
            guid TEXT NOT NULL DEFAULT '',
            menu_order INTEGER NOT NULL DEFAULT 0,
            post_type TEXT NOT NULL DEFAULT 'post',
            post_mime_type TEXT NOT NULL DEFAULT '',
            comment_count INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}postmeta (
            meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL DEFAULT 0,
            meta_key TEXT DEFAULT NULL,
            meta_value TEXT DEFAULT NULL
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}comments (
            comment_ID INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_post_ID INTEGER NOT NULL DEFAULT 0,
            comment_author TEXT NOT NULL DEFAULT '',
            comment_author_email TEXT NOT NULL DEFAULT '',
            comment_author_url TEXT NOT NULL DEFAULT '',
            comment_author_IP TEXT NOT NULL DEFAULT '',
            comment_date TEXT NOT NULL DEFAULT '',
            comment_date_gmt TEXT NOT NULL DEFAULT '',
            comment_content TEXT NOT NULL DEFAULT '',
            comment_karma INTEGER NOT NULL DEFAULT 0,
            comment_approved TEXT NOT NULL DEFAULT '1',
            comment_agent TEXT NOT NULL DEFAULT '',
            comment_type TEXT NOT NULL DEFAULT 'comment',
            comment_parent INTEGER NOT NULL DEFAULT 0,
            user_id INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}commentmeta (
            meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
            comment_id INTEGER NOT NULL DEFAULT 0,
            meta_key TEXT DEFAULT NULL,
            meta_value TEXT DEFAULT NULL
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}terms (
            term_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL DEFAULT '',
            slug TEXT NOT NULL DEFAULT '',
            term_group INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}term_taxonomy (
            term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
            term_id INTEGER NOT NULL DEFAULT 0,
            taxonomy TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            parent INTEGER NOT NULL DEFAULT 0,
            count INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}term_relationships (
            object_id INTEGER NOT NULL DEFAULT 0,
            term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
            term_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (object_id, term_taxonomy_id)
          );
          CREATE TABLE IF NOT EXISTS \${DB_PREFIX}links (
            link_id INTEGER PRIMARY KEY AUTOINCREMENT,
            link_url TEXT NOT NULL DEFAULT '',
            link_name TEXT NOT NULL DEFAULT '',
            link_image TEXT NOT NULL DEFAULT '',
            link_target TEXT NOT NULL DEFAULT '',
            link_description TEXT NOT NULL DEFAULT '',
            link_visible TEXT NOT NULL DEFAULT 'Y',
            link_owner INTEGER NOT NULL DEFAULT 1,
            link_rating INTEGER NOT NULL DEFAULT 0,
            link_updated TEXT NOT NULL DEFAULT '',
            link_rel TEXT NOT NULL DEFAULT '',
            link_notes TEXT NOT NULL DEFAULT '',
            link_rss TEXT NOT NULL DEFAULT ''
          );
          -- 기본 옵션 삽입
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('siteurl', '\$SITE_URL', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('home', '\$SITE_URL', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('blogname', '\$SITE_NAME', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('blogdescription', 'CloudPress WordPress 사이트', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('admin_email', '\$ADMIN_EMAIL', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('blogpublic', '1', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('blog_charset', 'UTF-8', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('date_format', 'Y년 n월 j일', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('time_format', 'A g:i', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('start_of_week', '0', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('timezone_string', 'Asia/Seoul', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('permalink_structure', '/%postname%/', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('template', 'twentytwentyfour', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('stylesheet', 'twentytwentyfour', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('current_theme', 'Twenty Twenty-Four', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('active_plugins', 'a:1:{i:0;s:51:"sqlite-database-integration/sqlite-database-integration.php";}', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('wp_db_version', '57155', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('initial_db_version', '57155', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('db_version', '57155', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('posts_per_page', '10', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('default_category', '1', 'yes');
          INSERT OR IGNORE INTO \${DB_PREFIX}options (option_name, option_value, autoload) VALUES ('cp_installed_at', '\$NOW', 'yes');
          -- 기본 카테고리
          INSERT OR IGNORE INTO \${DB_PREFIX}terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0);
          INSERT OR IGNORE INTO \${DB_PREFIX}term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 0);
          -- 샘플 글
          INSERT OR IGNORE INTO \${DB_PREFIX}posts (ID, post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status, menu_order, post_parent)
          VALUES (1, 1, '\$NOW', '\$NOW', 'WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.', '안녕하세요!', '', 'publish', 'hello-world', '\$NOW', '\$NOW', 'post', '\$SITE_URL/?p=1', 'open', 'open', 0, 0);
          INSERT OR IGNORE INTO \${DB_PREFIX}term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0);
          UPDATE \${DB_PREFIX}term_taxonomy SET count = 1 WHERE term_taxonomy_id = 1;
          EOSQL

          echo "✅ 데이터베이스 초기화 완료"
          ls -la _db/
          sqlite3 _db/wordpress.db "SELECT count(*) as tables FROM sqlite_master WHERE type='table';" 2>/dev/null || true

      - name: 관리자 계정 생성
        run: |
          # phpass 없이는 WordPress 해시를 직접 생성할 수 없으므로
          # wp-cli를 사용해 관리자 계정 생성
          echo "👤 관리자 계정 정보를 DB에 기록 중..."
          NOW=$(date -u +"%Y-%m-%d %H:%M:%S")

          # 임시로 MD5 해시 사용 (wp-cli 없을 때)
          PASS_HASH=$(echo -n "${wpAdminPass}" | md5sum | cut -d' ' -f1)

          sqlite3 _db/wordpress.db << EOSQL
          INSERT OR IGNORE INTO wp_users (ID, user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name)
          VALUES (1, '${wpAdminUser}', '\$PASS_HASH', '${wpAdminUser}', '${wpAdminEmail}', '${siteUrl}', '\$NOW', 0, '${wpAdminUser}');
          INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}');
          INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_user_level', '10');
          INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'admin_color', 'fresh');
          INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'rich_editing', '1');
          INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'show_admin_bar_front', '1');
          EOSQL
          echo "✅ 관리자 계정 생성 완료: ${wpAdminUser}"

      - name: .gitignore 설정
        run: |
          cat >> .gitignore << 'EOF'
          node_modules/
          *.log
          wp-content/uploads/cache/
          wp-content/cache/
          EOF

      - name: 모든 WordPress 파일 커밋 & 푸시
        run: |
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.app"
          git add -A
          git status --short | head -30
          TOTAL=$(git diff --staged --name-only | wc -l)
          echo "📁 커밋할 파일: \${TOTAL}개"
          git diff --staged --quiet || git commit -m "🚀 WordPress 최신버전 완전 설치 + SQLite DB 초기화 (\${TOTAL}개 파일)"
          git push
          echo "✅ 모든 파일 푸시 완료"
          echo "📊 레포 파일 통계:"
          find . -not -path './.git/*' -type f | wc -l
`;
}

// Cloudflare Worker 자동 배포 Action
function buildWorkerDeployAction({ workerName }) {
  const phpRunnerName = `${workerName}-php`;
  return `name: Cloudflare Worker 자동 배포

on:
  workflow_dispatch:

jobs:
  deploy-php-runner:
    name: PHP Runner Worker 배포 (먼저 실행)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: CF_API_TOKEN secret 확인
        run: |
          if [ -z "\$CLOUDFLARE_API_TOKEN" ]; then
            echo "❌ CF_API_TOKEN secret이 설정되지 않았습니다."
            echo "   레포 Settings → Secrets and variables → Actions → New repository secret"
            echo "   Name: CF_API_TOKEN  |  Value: Cloudflare API 토큰 (Workers:Edit 권한 필요)"
            echo "   Name: CF_ACCOUNT_ID |  Value: Cloudflare 계정 ID"
            echo "   토큰 발급: https://dash.cloudflare.com/profile/api-tokens"
            exit 1
          fi
          echo "✅ CF_API_TOKEN 확인 완료"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
      - name: php-runner Worker 배포
        run: npx wrangler deploy --config wrangler-php.toml
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}

  deploy-worker:
    name: 메인 Worker 배포
    runs-on: ubuntu-latest
    needs: deploy-php-runner
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: GITHUB_TOKEN secret 설정
        run: echo "\${{ secrets.GH_TOKEN }}" | npx wrangler secret put GITHUB_TOKEN
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}
        continue-on-error: true
      - name: 메인 Worker 배포
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}
      - name: php-runner GITHUB_TOKEN secret 설정
        run: echo "\${{ secrets.GH_TOKEN }}" | npx wrangler secret put GITHUB_TOKEN --config wrangler-php.toml
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}
        continue-on-error: true
`;
}

// GitHub Pages 정적 캐시 생성 Action (CF 장애 대비 폴백)
function buildGhPagesAction({ siteName }) {
  return `name: WordPress 정적 캐시 생성 + GitHub Pages 배포

on:
  schedule:
    - cron: '0 */3 * * *'  # 3시간마다 정적 캐시 갱신
  workflow_dispatch:
  workflow_run:
    workflows: ["🚀 WordPress 설치 + SQLite DB 초기화"]
    types: [completed]

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  build-cache:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: PHP 8.2 + WordPress 의존성 설치
        run: |
          # Ubuntu 24.04 (noble) 기본 저장소에는 php8.2 패키지가 없음 → ondrej/php PPA 추가
          sudo apt-get update -qq
          sudo apt-get install -y software-properties-common
          sudo add-apt-repository -y ppa:ondrej/php
          sudo apt-get update -qq
          sudo apt-get install -y php8.2-cli php8.2-sqlite3 php8.2-mbstring php8.2-xml php8.2-curl php8.2-gd sqlite3
          echo "✅ PHP 설치 완료: $(php8.2 -v | head -1)"

      - name: WordPress 코어 다운로드 (없으면)
        run: |
          if [ ! -f "wp-includes/version.php" ]; then
            echo "📥 WordPress 최신버전 다운로드..."
            wget -q https://wordpress.org/latest.tar.gz -O /tmp/wp.tar.gz
            tar -xzf /tmp/wp.tar.gz -C /tmp/
            # wp-content, wp-config.php 보존하면서 코어만 복사
            rsync -a --exclude='wp-content' --exclude='wp-config.php' /tmp/wordpress/ ./
            echo "✅ WordPress 코어 복사 완료"
          fi

      - name: SQLite DB 확인
        run: |
          mkdir -p _db
          if [ ! -f "_db/wordpress.db" ]; then
            echo "⚠️ _db/wordpress.db 없음 — install-wordpress.yml 먼저 실행 필요"
            exit 0
          fi
          echo "✅ DB 파일 존재: $(du -h _db/wordpress.db | cut -f1)"

      - name: WordPress 정적 캐시 생성 (_cache/)
        env:
          WP_SITEURL: \${{ vars.WP_SITEURL || 'http://localhost' }}
        run: |
          mkdir -p _cache
          
          # PHP 내장 서버로 WordPress 실행
          PHP_BIN=$(which php8.2 || which php)
          
          # wp-config.php에서 siteurl 확인
          if [ -f "wp-config.php" ]; then
            SITEURL=$(grep "siteurl\|home" wp-config.php | head -1 | grep -oP "https?://[^'\"]*" | head -1 || echo "")
          fi
          SITEURL=\${SITEURL:-"http://localhost:8888"}
          
          echo "🚀 PHP 내장 서버 시작: $SITEURL"
          \$PHP_BIN -S localhost:8888 -t . index.php &
          SERVER_PID=\$!
          sleep 3
          
          # 메인 페이지 캐시 생성
          echo "📄 메인 페이지 크롤링..."
          curl -s -L --max-time 30 "http://localhost:8888/" \
            -H "Host: $(echo \$SITEURL | sed 's|https\?://||')" \
            -o _cache/index.html 2>/dev/null || true
          
          # sitemap에서 URL 추출해서 크롤링
          curl -s -L --max-time 15 "http://localhost:8888/sitemap.xml" \
            -H "Host: $(echo \$SITEURL | sed 's|https\?://||')" \
            -o /tmp/sitemap.xml 2>/dev/null || true
          
          if [ -f "/tmp/sitemap.xml" ]; then
            grep -oP '(?<=<loc>)[^<]+' /tmp/sitemap.xml | head -50 | while read url; do
              path=$(echo "\$url" | sed "s|\$SITEURL||" | sed "s|http://localhost:8888||")
              if [ -n "\$path" ] && [ "\$path" != "/" ]; then
                mkdir -p "_cache\${path}"
                curl -s -L --max-time 20 "http://localhost:8888\${path}" \
                  -H "Host: $(echo \$SITEURL | sed 's|https\?://||')" \
                  -o "_cache\${path}index.html" 2>/dev/null || true
                echo "  ✅ 캐시: \$path"
              fi
            done
          fi
          
          kill \$SERVER_PID 2>/dev/null || true
          
          # 캐시 결과 확인
          CACHE_COUNT=\$(find _cache -name "*.html" | wc -l)
          echo "✅ 정적 캐시 생성: \${CACHE_COUNT}개 페이지"

      - name: _cache/ 커밋 & 푸시
        run: |
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.site"
          git add _cache/
          if git diff --staged --quiet; then
            echo "변경 없음 — 캐시 최신 상태"
          else
            git commit -m "🔄 WordPress 정적 캐시 갱신 [\$(date '+%Y-%m-%d %H:%M')]"
            git push
            echo "✅ _cache/ 업데이트 완료"
          fi

      - name: GitHub Pages 배포 (폴백용)
        uses: actions/upload-pages-artifact@v3
        with:
          path: _cache

  deploy-pages:
    needs: build-cache
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/deploy-pages@v4
        id: deployment
`;
}

// ─── wrangler.toml 빌드 (D1 제거, SQLite .db 사용) ──────────────────────────
function buildWranglerToml({ workerName, kvCacheId, kvCacheName, siteId, ghOwner, ghRepo, ghPagesUrl }) {
  const phpRunnerName = `${workerName}-php`;
  return `# CloudPress WordPress Worker 배포 설정
# PHP_RUNNER Service Binding으로 즉시 WordPress 실행
# 데이터베이스: GitHub 레포 내 _db/wordpress.db (SQLite)
name               = "${workerName}"
main               = "worker.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 50000

# ── 캐시 (KV) ────────────────────────────────────────────────────────────────
${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 바인딩 설정 필요`}

# ── PHP_RUNNER Service Binding ────────────────────────────────────────────────
# php-runner Worker를 Service Binding으로 연결 (즉시 WP 실행)
[[services]]
binding = "PHP_RUNNER"
service = "${phpRunnerName}"

# ── 환경변수 ─────────────────────────────────────────────────────────────────
[vars]
SITE_ID      = "${siteId}"
GH_OWNER     = "${ghOwner}"
GH_REPO      = "${ghRepo}"
GH_PAGES_URL = "${ghPagesUrl}"

# GITHUB_TOKEN은 secret으로 설정 (wrangler secret put GITHUB_TOKEN)
`;
}

function buildPhpRunnerWranglerToml({ workerName, kvCacheId, siteId, ghOwner, ghRepo }) {
  const phpRunnerName = `${workerName}-php`;
  return `# CloudPress PHP Runner Worker 배포 설정
# php-wasm으로 WordPress를 직접 실행하는 Worker
name               = "${phpRunnerName}"
main               = "php-runner.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 50000

# ── 캐시 (KV) — 메인 Worker와 같은 KV 공유 ──────────────────────────────────
${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 바인딩 설정 필요`}

# ── 환경변수 ─────────────────────────────────────────────────────────────────
[vars]
SITE_ID  = "${siteId}"
GH_OWNER = "${ghOwner}"
GH_REPO  = "${ghRepo}"

# GITHUB_TOKEN은 secret으로 설정 (wrangler secret put GITHUB_TOKEN)
`;
}

// ─── README 빌드 ─────────────────────────────────────────────────────────────
function buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl, wpAdminUser }) {
  return `# ${siteName}

CloudPress로 생성된 진짜 WordPress 사이트입니다.

## 구조

\`\`\`
${repoName}/
├── worker.js              # Cloudflare Worker (미러링 전용)
├── wrangler.toml          # Worker 배포 설정
├── wp-config.php          # WordPress 설정 (자동 생성)
├── wp-admin/              # WordPress 관리자 (자동 설치)
├── wp-includes/           # WordPress 코어 (자동 설치)
├── wp-content/
│   ├── themes/            # 테마
│   ├── plugins/           # 플러그인 (SQLite 포함)
│   ├── uploads/           # 미디어 업로드
│   └── db.php             # SQLite DB 드롭인
├── _db/
│   └── wordpress.db       # SQLite 데이터베이스 (.db 파일)
└── .github/workflows/
    ├── install-wordpress.yml  # WordPress 전체 설치
    └── deploy-worker.yml      # Worker 자동 배포
\`\`\`

## 데이터베이스

- **엔진**: SQLite (.db 파일) — Cloudflare D1 사용 안 함
- **위치**: \`_db/wordpress.db\`
- **관리자**: ${wpAdminUser}

## 작동 원리

1. **Cloudflare Worker** (\`worker.js\`)가 모든 요청 수신
2. 정적 자산은 GitHub 레포에서 직접 서빙
3. 동적 요청은 GitHub _cache/ 정적 HTML로 서빙 (GitHub Actions가 생성)
4. php-wasm이 이 레포의 WP 파일 + \`_db/wordpress.db\` 실행
5. Cloudflare 장애 시 GitHub Pages 정적 폴백 자동 전환

## CloudPress 관리

- **대시보드**: https://cloud-press.co.kr/dashboard
- **사이트 ID**: \`${siteId}\`
- **Worker**: \`${workerName}\`
- **사이트 URL**: ${siteUrl}
`;
}

// ─── 메인 프로비저닝 함수 ─────────────────────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env,
  siteId,
  siteName,
  // adminUser, adminPass, adminEmail — 제거: 자동 생성
  plan,
  planLimits,
  cfToken,
  cfAccountId,
  cfEmail,
  initialDomain,
  userId,
  isAdmin,
  log,
}) {
  const shortId     = siteId.replace(/-/g, "").slice(0, 8);
  const safeSlug    = slugify(siteName) || `site-${shortId}`;
  const workerName  = `cp-${shortId}-wp`;
  const kvCacheName = `cp-${shortId}-cache`;
  const repoName    = `cp-${shortId}-${safeSlug}`.slice(0, 100);
  const dbPrefix    = "wp_";

  await log(`━━━ 호스팅 프로비저닝 시작 ━━━`);
  await log(`사이트 ID  : ${siteId}`);
  await log(`Worker 명  : ${workerName}`);
  await log(`DB         : GitHub 레포 내 SQLite (_db/wordpress.db) — D1 사용 안 함`);
  await log(`GitHub 레포: ${repoName}`);

  // ── 1. 관리자 자격증명 자동 생성 ─────────────────────────────────────────
  const wpAdminUser  = "admin";
  const wpAdminPass  = randomPass(16);
  const wpAdminEmail = `admin@${shortId}.cloudpress.app`;

  await log(`✅ 관리자 자격증명 자동 생성`);
  await log(`   아이디: ${wpAdminUser} / 이메일: ${wpAdminEmail}`);

  // 인증 키/솔트 자동 생성
  const authKey        = randomStr(64);
  const secureAuthKey  = randomStr(64);
  const loggedInKey    = randomStr(64);
  const nonceKey       = randomStr(64);
  const authSalt       = randomStr(64);
  const secureAuthSalt = randomStr(64);
  const loggedInSalt   = randomStr(64);
  const nonceSalt      = randomStr(64);

  // ── 2. GitHub 토큰 조회 ────────────────────────────────────────────────────
  const ghToken = await pickGithubToken(env).catch(() => null);
  let owner = null;

  if (ghToken) {
    try {
      const userRes = await ghReq("GET", "/user", ghToken);
      if (userRes.ok) {
        owner = userRes.data.login;
        await log(`GitHub 사용자: ${owner}`);
      }
    } catch (e) {
      await log(`GitHub 사용자 조회 실패: ${e.message}`, "warn");
    }
  }

  if (!owner) {
    await log("GitHub 토큰 없음 — 관리자 설정에서 GitHub 토큰 등록 필요", "warn");
  }

  // ── 3. KV 생성 (캐시 전용 — D1 제거) ────────────────────────────────────
  let kvCacheId = null;
  if (cfToken && cfAccountId) {
    await log("▶ Cloudflare KV 캐시 생성 중...");
    kvCacheId = await createKVNamespace({ cfToken, cfAccountId, cfEmail, title: kvCacheName, log });
  }

  // ── 3.5 PHP Runner 소스코드 로드 (레포에 push 및 직접 배포용) ──────────────
  // 플랫폼의 php-runner.js를 KV 또는 Assets에서 읽어옴
  let phpRunnerSourceCode = null;
  try {
    // 1. KV에서 읽기 시도
    if (env?.ASSETS) {
      const assetRes = await env.ASSETS.fetch(new Request("https://platform/php-runner.js")).catch(() => null);
      if (assetRes?.ok) phpRunnerSourceCode = await assetRes.text();
    }
    // 2. KV에서 읽기 시도
    if (!phpRunnerSourceCode && env?.KV) {
      phpRunnerSourceCode = await env.KV.get("platform:php-runner.js").catch(() => null);
    }
    // 3. 같은 도메인의 /php-runner.js 읽기
    if (!phpRunnerSourceCode) {
      const r = await fetch("https://cloud-press.co.kr/php-runner.js", {
        headers: { "User-Agent": "CloudPress-Provision/7.0" },
        cf: { cacheEverything: true, cacheTtl: 3600 },
      }).catch(() => null);
      if (r?.ok) phpRunnerSourceCode = await r.text();
    }
    if (phpRunnerSourceCode) {
      await log("  ✅ PHP Runner 소스코드 로드 완료");
    } else {
      await log("  ⚠️ PHP Runner 소스코드 로드 실패 — GitHub Actions로 나중에 배포", "warn");
    }
  } catch (e) {
    await log(`  ⚠️ PHP Runner 소스 로드 중 오류: ${e.message}`, "warn");
  }

// ── 4. GitHub 레포 생성 ───────────────────────────────────────────────────
  let githubRepoUrl = null;
  const siteUrl = initialDomain
    ? `https://${initialDomain}`
    : cfAccountId
      ? `https://${workerName}.workers.dev`
      : `https://${repoName}.workers.dev`;

  // GitHub Pages URL (폴백용)
  const ghPagesUrl = owner ? `https://${owner}.github.io/${repoName}` : "";

  if (ghToken && owner) {
    await log("▶ GitHub 레포 생성 중...");
    const created = await createGitHubRepo({ ghToken, owner, repoName, log });

    if (created) {
      await log("▶ 초기 파일 GitHub 레포에 push 중...");

      const wpConfigContent = buildWpConfig({
        siteId, siteUrl, dbPrefix,
        authKey, secureAuthKey, loggedInKey, nonceKey,
        authSalt, secureAuthSalt, loggedInSalt, nonceSalt,
      });

      const workerSource = buildWorkerSource({
        siteId,
        githubOwner: owner,
        githubRepo:  repoName,
        ghPagesUrl,
      });

      const wranglerToml = buildWranglerToml({
        workerName, kvCacheId, kvCacheName, siteId,
        ghOwner: owner, ghRepo: repoName, ghPagesUrl,
      });

      // ── GitHub에 push할 초기 파일 목록 ───────────────────────────────────
      const filesToPush = [
        // wp-config.php — WordPress 설정 (SQLite)
        { path: "wp-config.php", content: wpConfigContent },
        // worker.js — Cloudflare Worker (미러링 전용)
        { path: "worker.js", content: workerSource },
        // wrangler.toml — Worker 배포 설정 (D1 제거)
        { path: "wrangler.toml", content: wranglerToml },
        // GitHub Actions: WordPress 전체 설치 (모든 WP 파일 자동 다운로드)
        {
          path: ".github/workflows/install-wordpress.yml",
          content: buildWpInstallAction({
            wpAdminUser, wpAdminPass, wpAdminEmail,
            siteUrl, siteName, dbPrefix,
          }),
        },
        // GitHub Actions: Worker 자동 배포
        {
          path: ".github/workflows/deploy-worker.yml",
          content: buildWorkerDeployAction({ workerName }),
        },
        // GitHub Actions: GitHub Pages 정적 폴백 (CF 장애 대비 SEO)
        {
          path: ".github/workflows/gh-pages-fallback.yml",
          content: buildGhPagesAction({ siteName }),
        },
        // _db/.gitkeep — 데이터베이스 폴더 (install-wordpress.yml이 .db 생성)
        { path: "_db/.gitkeep", content: "# 이 폴더에 wordpress.db SQLite 데이터베이스가 생성됩니다.\n# install-wordpress.yml 워크플로우가 자동으로 생성합니다.\n" },
        // _cache/.gitkeep — Worker가 서빙할 WordPress 정적 캐시 (gh-pages-fallback.yml이 채움)
        { path: "_cache/.gitkeep", content: "# 이 폴더에 WordPress 정적 HTML 캐시가 생성됩니다.\n# gh-pages-fallback.yml 워크플로우가 자동으로 생성합니다.\n" },
        // wp-content 기본 구조
        { path: "wp-content/uploads/.gitkeep",  content: "" },
        { path: "wp-content/themes/.gitkeep",   content: "" },
        { path: "wp-content/plugins/.gitkeep",  content: "" },
        // wrangler-php.toml — PHP Runner Worker 배포 설정
        {
          path: "wrangler-php.toml",
          content: buildPhpRunnerWranglerToml({
            workerName, kvCacheId, siteId,
            ghOwner: owner, ghRepo: repoName,
          }),
        },
        // php-runner.js — php-wasm으로 WordPress를 직접 실행하는 Worker
        // 플랫폼의 php-runner.js 소스를 사이트 레포에 복사
        ...(phpRunnerSourceCode ? [{ path: "php-runner.js", content: phpRunnerSourceCode }] : []),
        { path: "php-runner-readme.md", content: buildPhpRunnerReadme() },
        // README
        {
          path: "README.md",
          content: buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl, wpAdminUser }),
        },
      ];

      const pushed = await ghBatchPush(ghToken, owner, repoName, filesToPush, "🚀 CloudPress 초기 설정 (WordPress 설치 준비)");
      if (pushed) {
        await log(`✅ GitHub 초기 파일 push 완료 (${filesToPush.length}개 파일)`);
        githubRepoUrl = `https://github.com/${owner}/${repoName}`;

        // GitHub Actions 트리거 (WordPress 전체 설치)
        await delay(3000); // 파일 반영 대기
        await log("▶ WordPress 전체 설치 Action 트리거 중 (모든 WP 파일 자동 설치)...");
        const triggerRes = await ghReq(
          "POST",
          `/repos/${owner}/${repoName}/actions/workflows/install-wordpress.yml/dispatches`,
          ghToken,
          { ref: "main" }
        ).catch(() => ({ ok: false }));

        if (triggerRes.ok || triggerRes.status === 204) {
          await log("  🚀 WordPress 설치 Action 트리거 완료 (GitHub Actions에서 설치 진행 중)");
          await log("  📁 설치 내용: WordPress 최신버전 모든 파일 + SQLite DB 초기화");
          await log("  ⏱️ 완료까지 약 2~5분 소요");
        } else {
          await log("  ⚠️ Action 트리거 실패 — GitHub 레포 Actions 탭에서 수동 실행하세요", "warn");
        }

        // GitHub Pages 활성화 (CF 장애 시 폴백용)
        await ghReq("POST", `/repos/${owner}/${repoName}/pages`, ghToken, {
          build_type: "workflow",
        }).catch(() => {});
      } else {
        await log("⚠️ GitHub push 실패 (부분 진행)", "warn");
      }
    }
  }

  // ── 5. Cloudflare Worker 배포 ─────────────────────────────────────────────
  let workerDomain = null;

  if (cfToken && cfAccountId) {
    await log("▶ Cloudflare Worker 배포 중...");

    // 미러링 Worker 소스: GitHub에서 읽기 시도 → 실패 시 buildWorkerSource()로 즉시 생성
    let workerSource = null;
    if (owner && ghToken) {
      try {
        await delay(3000); // GitHub 반영 대기
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/main/worker.js`;
        const res = await fetch(rawUrl, {
          headers: { "Authorization": `Bearer ${ghToken}`, "User-Agent": "CloudPress/6.0" },
        });
        if (res.ok) {
          workerSource = await res.text();
          await log("  Worker 소스: GitHub 레포에서 읽기 완료");
        }
      } catch (e) {
        await log(`  Worker 소스 GitHub 읽기 실패: ${e.message}`, "warn");
      }
    }

    // GitHub 읽기 실패 시 buildWorkerSource()로 즉시 생성 (미러링 Worker 항상 배포)
    if (!workerSource) {
      workerSource = buildWorkerSource({
        siteId,
        githubOwner: owner || "",
        githubRepo:  repoName,
        ghPagesUrl:  ghPagesUrl || "",
      });
      await log("  Worker 소스: 로컬 빌드 (buildWorkerSource) 사용");
    }

    // 1. PHP Runner Worker 먼저 배포 (Service Binding 타겟)
    await log("  PHP Runner Worker 배포 중...");
    const phpRunnerName = `${workerName}-php`;

    // PHP Runner 소스: GitHub → 플랫폼 로드된 phpRunnerSourceCode 순으로 시도
    let phpRunnerSource = null;
    if (owner && ghToken) {
      try {
        const phpRawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/main/php-runner.js`;
        const phpRes = await fetch(phpRawUrl, {
          headers: { "Authorization": `Bearer ${ghToken}`, "User-Agent": "CloudPress/7.0" },
        });
        if (phpRes.ok) {
          phpRunnerSource = await phpRes.text();
          await log("  PHP Runner 소스: GitHub 레포에서 읽기 완료");
        }
      } catch (e) {
        await log(`  PHP Runner 소스 GitHub 읽기 실패: ${e.message}`, "warn");
      }
    }

    // GitHub 실패 시 프로비저닝 단계에서 로드한 플랫폼 소스 사용
    if (!phpRunnerSource && phpRunnerSourceCode) {
      phpRunnerSource = phpRunnerSourceCode;
      await log("  PHP Runner 소스: 플랫폼 기본 소스 사용");
    }

    if (phpRunnerSource) {
      await deployPhpRunnerWorker({
        cfToken, cfAccountId, cfEmail,
        workerName: phpRunnerName,
        workerSource: phpRunnerSource,
        kvCacheId, kvCacheName,
        siteId, ghOwner: owner || "", ghRepo: repoName,
        log,
      }).catch(async (e) => {
        await log(`  PHP Runner 배포 실패: ${e.message} (GitHub Actions로 재시도 가능)`, "warn");
      });
    } else {
      await log("  ⚠️ PHP Runner 소스를 찾을 수 없습니다. GitHub Actions deploy-worker.yml이 실행되면 자동 배포됩니다.", "warn");
    }

    // 2. 미러링 Worker 배포 (PHP_RUNNER Service Binding 포함) — 항상 실행
    const deployed = await deployWorker({
      cfToken, cfAccountId, cfEmail,
      workerName, workerSource,
      kvCacheId, kvCacheName,
      siteId, ghOwner: owner || "", ghRepo: repoName, ghPagesUrl: ghPagesUrl || "",
      ghToken: ghToken || null,
      log,
    });
    if (deployed) workerDomain = deployed.workerDomain;
  }

  // ── 6. 결과 반환 ──────────────────────────────────────────────────────────
  const cfPagesUrl = workerDomain || (owner ? `https://${repoName}.workers.dev` : null);

  await log("━━━ 프로비저닝 완료 ━━━");
  await log(`사이트 URL   : ${cfPagesUrl || "설정 필요"}`);
  await log(`GitHub 레포  : ${githubRepoUrl || "미생성"}`);
  await log(`DB           : ${owner ? `https://github.com/${owner}/${repoName}/blob/main/_db/wordpress.db` : "미생성"}`);
  await log(`WP 관리자    : ${wpAdminUser} (비밀번호: 호스팅 상세 페이지에서 확인)`);
  await log(`WP Action    : WordPress 설치 Action이 백그라운드에서 실행 중입니다`);

  return {
    success:       true,
    workerName,
    workerDomain,
    cfPagesUrl,
    githubRepoUrl,
    githubOwner:   owner,
    githubRepo:    repoName,
    kvCacheId,
    // DB 정보 (D1 제거 — SQLite .db)
    dbEngine:      "sqlite",
    dbPath:        "_db/wordpress.db",
    dbFileUrl:     owner ? `https://github.com/${owner}/${repoName}/blob/main/_db/wordpress.db` : null,
    // 관리자 자격증명 (자동 생성)
    wpAdminUser,
    wpAdminPass,
    wpAdminEmail,
    autoProvisioned: true,
  };
}


// ─── Cloudflare Workers Upload 멀티파트 빌더 ─────────────────────────────────
// CF Workers Upload API는 반드시 Uint8Array 바이너리 바디로 전송해야 함
// 문자열 concat 방식은 502 오류 발생
function buildWorkerMultipart(metadataObj, files) {
  const enc = new TextEncoder();
  const boundary = "----CFWorkerBoundary" + Math.random().toString(36).slice(2);
  const parts = [];

  // metadata part
  const metaStr =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadataObj) + `\r\n`;
  parts.push(enc.encode(metaStr));

  // source file parts
  for (const { name, content: src } of files) {
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"; filename="${name}"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n`;
    parts.push(enc.encode(header));
    parts.push(enc.encode(src));
    parts.push(enc.encode("\r\n"));
  }

  // terminator
  parts.push(enc.encode(`--${boundary}--`));

  // flatten
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { merged.set(p, offset); offset += p.length; }

  return { body: merged, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── PHP Runner Worker 배포 ──────────────────────────────────────────────────
async function deployPhpRunnerWorker({
  cfToken, cfAccountId, cfEmail,
  workerName, workerSource,
  kvCacheId, kvCacheName,
  siteId, ghOwner, ghRepo,
  log,
}) {
  const bindings = [
    ...(kvCacheId ? [{ type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId }] : []),
    { type: "plain_text", name: "SITE_ID",  text: siteId },
    { type: "plain_text", name: "GH_OWNER", text: ghOwner || "" },
    { type: "plain_text", name: "GH_REPO",  text: ghRepo  || "" },
  ];

  const metadataObj = {
    main_module:         "php-runner.js",
    compatibility_date:  "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };

  const { body, contentType } = buildWorkerMultipart(metadataObj, [
    { name: "php-runner.js", content: workerSource },
  ]);

  const headers = {
    "Content-Type": contentType,
    ...(cfEmail
      ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
      : { "Authorization": `Bearer ${cfToken}` }),
  };

  await log(`  PHP Runner 배포 시작: ${workerName} (소스 ${workerSource.length}bytes)`);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`,
    { method: "PUT", headers, body }
  );
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    await log(`  ✅ PHP Runner Worker 배포 완료: ${workerName}`);
    return { ok: true };
  } else {
    const errDetail = JSON.stringify(data?.errors || data);
    const phpErrText = await res.clone().text().catch(() => "");
    await log(`  ⚠️ PHP Runner Worker 배포 실패 [${res.status}]: ${errDetail || phpErrText}`, "warn");
    return null;
  }
}

// ─── Worker 배포 (D1 제거, KV + PHP_RUNNER만) ────────────────────────────────
async function deployWorker({
  cfToken, cfAccountId, cfEmail,
  workerName, workerSource,
  kvCacheId, kvCacheName,
  siteId, ghOwner, ghRepo, ghPagesUrl,
  ghToken,
  log,
}) {
  // phpRunnerExists: PHP Runner가 실제로 배포됐는지 먼저 확인
  let phpRunnerExists = false;
  try {
    const checkRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}-php`,
      {
        method: "GET",
        headers: cfEmail
          ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
          : { "Authorization": `Bearer ${cfToken}` },
      }
    );
    phpRunnerExists = checkRes.ok;
    await log(`  PHP Runner 존재 확인: ${phpRunnerExists ? "✅ 있음" : "❌ 없음 (Service Binding 제외)"}`);
  } catch (e) {
    await log(`  PHP Runner 확인 실패: ${e.message}`, "warn");
  }

  const bindings = [
    ...(kvCacheId ? [{ type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId }] : []),
    { type: "plain_text", name: "SITE_ID",      text: siteId },
    { type: "plain_text", name: "GH_OWNER",     text: ghOwner || "" },
    { type: "plain_text", name: "GH_REPO",      text: ghRepo  || "" },
    { type: "plain_text", name: "GH_PAGES_URL", text: ghPagesUrl || "" },
    // PHP Runner가 실제 배포된 경우에만 Service Binding 추가 (없으면 배포 오류 방지)
    ...(phpRunnerExists ? [{ type: "service", name: "PHP_RUNNER", service: `${workerName}-php` }] : []),
  ];

  const metadataObj = {
    main_module:         "worker.js",
    compatibility_date:  "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };

  const { body: workerBody, contentType: workerCT } = buildWorkerMultipart(metadataObj, [
    { name: "worker.js", content: workerSource },
  ]);

  const headers = {
    "Content-Type": workerCT,
    ...(cfEmail
      ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
      : { "Authorization": `Bearer ${cfToken}` }),
  };

  await log(`  메인 Worker 배포 시작: ${workerName} (bindings: ${bindings.map(b=>b.name).join(", ")})`);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`,
    { method: "PUT", headers, body: workerBody }
  );
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errDetail = JSON.stringify(data?.errors || data);
    const errText = await res.clone().text().catch(() => "");
    await log(`  ❌ 메인 Worker 배포 실패 [${res.status}]: ${errDetail || errText}`, "error");
    return null;
  }

  await log(`  ✅ 메인 Worker(미러링) 배포 완료: ${workerName}`);

  // workers.dev 도메인 활성화
  await cfReq(cfToken, "POST",
    `/accounts/${cfAccountId}/workers/scripts/${workerName}/subdomain`,
    { enabled: true }, cfEmail
  ).catch(() => {});

  const workerDomain = `https://${workerName}.workers.dev`;
  await log(`  🌐 사이트 URL: ${workerDomain}`);

  // GITHUB_TOKEN secret 자동 설정 (관리자 GitHub 토큰을 Worker secret으로 등록)
  if (ghToken && ghOwner) {
    // 메인 Worker에 GITHUB_TOKEN secret 등록
    await setWorkerSecret(cfToken, cfAccountId, cfEmail, workerName, "GITHUB_TOKEN", ghToken, log);
    // PHP Runner Worker에도 동일하게 등록
    await setWorkerSecret(cfToken, cfAccountId, cfEmail, `${workerName}-php`, "GITHUB_TOKEN", ghToken, log);
  }

  return { workerDomain };
}

// ─── Worker Secret 설정 ───────────────────────────────────────────────────────
async function setWorkerSecret(cfToken, cfAccountId, cfEmail, workerName, secretName, secretValue, log) {
  try {
    const headers = {
      "Content-Type": "application/json",
      ...(cfEmail
        ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
        : { "Authorization": `Bearer ${cfToken}` }),
    };
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/secrets`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: secretName, text: secretValue, type: "secret_text" }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await log(`  🔑 ${workerName} secret [${secretName}] 등록 완료`);
    } else {
      await log(`  ⚠️ ${workerName} secret [${secretName}] 등록 실패: ${data?.errors?.[0]?.message || res.status}`, "warn");
    }
  } catch (e) {
    await log(`  ⚠️ ${workerName} secret 등록 오류: ${e.message}`, "warn");
  }
}

// ─── php-runner.js 설명 (README) ─────────────────────────────────────────────
function buildPhpRunnerReadme() {
  return `# PHP Runner (php-wasm)

이 레포지토리의 WordPress 사이트는 **php-wasm**으로 실행됩니다.

## 구조

- worker.js: 메인 Cloudflare Worker (요청 라우팅, KV 캐시)
- php-runner.js: PHP Runner Worker (php-wasm으로 WordPress 직접 실행)
- wrangler.toml: 메인 Worker 설정 (PHP_RUNNER Service Binding 포함)
- wrangler-php.toml: PHP Runner Worker 배포 설정

## 동작 원리

1. 요청 -> worker.js (메인 Worker)
2. KV 캐시 HIT -> 캐시된 HTML 반환
3. KV 캐시 MISS -> PHP_RUNNER Service Binding -> php-runner.js 호출
4. php-runner.js가 WP 코어(CDN) + wp-content(GitHub) -> php-wasm VFS 마운트 -> WordPress 실행
5. PHP 출력 -> KV 캐시 저장 -> 클라이언트 반환

## 배포

\`\`\`bash
# PHP Runner 먼저 배포
npx wrangler deploy --config wrangler-php.toml

# 메인 Worker 배포 (Service Binding 연결)
npx wrangler deploy
\`\`\`
`;
}

// ─── SQL 빌더 (내부 함수 — 하위 호환) ───────────────────────────────────────────────
function buildWordPressD1SchemaSqls({ dbPrefix }) {
  const p = dbPrefix;
  return [
    `CREATE TABLE IF NOT EXISTS ${p}options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT NOT NULL DEFAULT '' UNIQUE, option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes')`,
    `CREATE TABLE IF NOT EXISTS ${p}users (ID INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT NOT NULL DEFAULT '', user_pass TEXT NOT NULL DEFAULT '', user_nicename TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL DEFAULT '', user_url TEXT NOT NULL DEFAULT '', user_registered TEXT NOT NULL DEFAULT '', user_activation_key TEXT NOT NULL DEFAULT '', user_status INTEGER NOT NULL DEFAULT 0, display_name TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ${p}usermeta (umeta_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_author INTEGER NOT NULL DEFAULT 0, post_date TEXT NOT NULL DEFAULT '', post_date_gmt TEXT NOT NULL DEFAULT '', post_content TEXT NOT NULL DEFAULT '', post_title TEXT NOT NULL DEFAULT '', post_excerpt TEXT NOT NULL DEFAULT '', post_status TEXT NOT NULL DEFAULT 'publish', comment_status TEXT NOT NULL DEFAULT 'open', ping_status TEXT NOT NULL DEFAULT 'open', post_password TEXT NOT NULL DEFAULT '', post_name TEXT NOT NULL DEFAULT '', to_ping TEXT NOT NULL DEFAULT '', pinged TEXT NOT NULL DEFAULT '', post_modified TEXT NOT NULL DEFAULT '', post_modified_gmt TEXT NOT NULL DEFAULT '', post_content_filtered TEXT NOT NULL DEFAULT '', post_parent INTEGER NOT NULL DEFAULT 0, guid TEXT NOT NULL DEFAULT '', menu_order INTEGER NOT NULL DEFAULT 0, post_type TEXT NOT NULL DEFAULT 'post', post_mime_type TEXT NOT NULL DEFAULT '', comment_count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${p}postmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}comments (comment_ID INTEGER PRIMARY KEY AUTOINCREMENT, comment_post_ID INTEGER NOT NULL DEFAULT 0, comment_author TEXT NOT NULL DEFAULT '', comment_author_email TEXT NOT NULL DEFAULT '', comment_author_url TEXT NOT NULL DEFAULT '', comment_author_IP TEXT NOT NULL DEFAULT '', comment_date TEXT NOT NULL DEFAULT '', comment_date_gmt TEXT NOT NULL DEFAULT '', comment_content TEXT NOT NULL DEFAULT '', comment_karma INTEGER NOT NULL DEFAULT 0, comment_approved TEXT NOT NULL DEFAULT '1', comment_agent TEXT NOT NULL DEFAULT '', comment_type TEXT NOT NULL DEFAULT 'comment', comment_parent INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${p}commentmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}terms (term_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', term_group INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${p}term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL DEFAULT 0, taxonomy TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', parent INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${p}term_relationships (object_id INTEGER NOT NULL DEFAULT 0, term_taxonomy_id INTEGER NOT NULL DEFAULT 0, term_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (object_id, term_taxonomy_id))`,
    `CREATE TABLE IF NOT EXISTS ${p}links (link_id INTEGER PRIMARY KEY AUTOINCREMENT, link_url TEXT NOT NULL DEFAULT '', link_name TEXT NOT NULL DEFAULT '', link_image TEXT NOT NULL DEFAULT '', link_target TEXT NOT NULL DEFAULT '', link_description TEXT NOT NULL DEFAULT '', link_visible TEXT NOT NULL DEFAULT 'Y', link_owner INTEGER NOT NULL DEFAULT 1, link_rating INTEGER NOT NULL DEFAULT 0, link_updated TEXT NOT NULL DEFAULT '', link_rel TEXT NOT NULL DEFAULT '', link_notes TEXT NOT NULL DEFAULT '', link_rss TEXT NOT NULL DEFAULT '')`,
  ];
}

function buildWordPressInitSqls({ dbPrefix, adminUser, passHash, adminEmail, siteName, siteUrl, now }) {
  const p = dbPrefix || "wp_";
  adminUser  = adminUser  || "admin";
  passHash   = passHash   || "";
  adminEmail = adminEmail || "admin@example.com";
  siteName   = siteName   || "CloudPress Site";
  siteUrl    = siteUrl    || "https://example.com";
  now        = now        || new Date().toISOString().replace("T", " ").slice(0, 19);
  return [
    `INSERT OR IGNORE INTO ${p}users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name) VALUES ('${adminUser}', '${passHash}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', 0, '${adminUser}')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, '${p}capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, '${p}user_level', '10')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('siteurl', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('home', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogname', '${siteName}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('admin_email', '${adminEmail}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogpublic', '1', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blog_charset', 'UTF-8', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('permalink_structure', '/%postname%/', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('template', 'twentytwentyfour', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('stylesheet', 'twentytwentyfour', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('wp_db_version', '57155', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('cp_installed_at', '${now}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0)`,
    `INSERT OR IGNORE INTO ${p}term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 0)`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('default_category', '1', 'yes')`,
    `INSERT OR IGNORE INTO ${p}posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status, menu_order, post_parent) VALUES (1, '${now}', '${now}', 'WordPress에 오신 것을 환영합니다!', '안녕하세요!', '', 'publish', 'hello-world', '${now}', '${now}', 'post', '${siteUrl}/?p=1', 'open', 'open', 0, 0)`,
    `INSERT OR IGNORE INTO ${p}term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0)`,
    `UPDATE ${p}term_taxonomy SET count = 1 WHERE term_taxonomy_id = 1`,
  ];
}
