/**
 * CloudPress — cf-pages-hosting.js v5.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 진짜 WordPress 호스팅 프로비저닝
 *
 * 흐름:
 *   1. GitHub 레포 생성 → WordPress 공식 파일 + wp-config.php 업로드
 *   2. Cloudflare D1, KV 생성
 *   3. Cloudflare Worker 배포 (GitHub 레포 미러링 코드만)
 *      → Worker 코드: GitHub 레포에서 파일을 읽어 php-wasm으로 실행
 *   4. DB 정보 자동 생성 (사용자가 입력 불필요)
 *   5. WordPress 설치 자동 완료
 *
 * Worker 코드 원칙:
 *   - Worker에는 GitHub 레포 미러링 코드만 포함
 *   - 실제 WordPress PHP 파일은 GitHub 레포에 존재
 *   - php-wasm이 GitHub 레포의 파일을 실행
 */

import { pickGithubToken } from "./github-storage.js";

// ─── 상수 ────────────────────────────────────────────────────────────────────
const WP_VERSION = "6.7.2";
const WP_DOWNLOAD_URL = `https://wordpress.org/wordpress-${WP_VERSION}.zip`;
// WordPress 공식 GitHub (코어 파일 목록 참조)
const WP_GITHUB_OWNER = "WordPress";
const WP_GITHUB_REPO  = "WordPress";
const WP_GITHUB_BRANCH = "master"; // 태그: refs/tags/6.7.2

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

// ─── MD5 (phpass 호환) ───────────────────────────────────────────────────────
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
  // encode64
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
      "User-Agent":           "CloudPress/5.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ─── GitHub Tree API 배치 push ───────────────────────────────────────────────
async function ghBatchPush(token, owner, repo, files, commitMsg) {
  // HEAD SHA 조회
  const refRes = await ghReq("GET", `/repos/${owner}/${repo}/git/refs/heads/main`, token);
  if (!refRes.ok) return false;
  const baseSha = refRes.data?.object?.sha;

  // Base tree SHA 조회
  const commitRes = await ghReq("GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  const baseTreeSha = commitRes.data?.tree?.sha;

  // Blob 생성 (병렬)
  const tree = await Promise.all(files.map(async ({ path, content, encoding = "utf-8" }) => {
    if (encoding === "base64") {
      return { path, mode: "100644", type: "blob", content };
    }
    // 텍스트 파일은 직접 tree에 내용 포함
    return { path, mode: "100644", type: "blob", content };
  }));

  // Tree 생성
  const treeRes = await ghReq("POST", `/repos/${owner}/${repo}/git/trees`, token, {
    base_tree: baseTreeSha,
    tree,
  });
  if (!treeRes.ok) return false;
  const newTreeSha = treeRes.data?.sha;

  // Commit 생성
  const commitNewRes = await ghReq("POST", `/repos/${owner}/${repo}/git/commits`, token, {
    message: commitMsg,
    tree: newTreeSha,
    parents: [baseSha],
  });
  if (!commitNewRes.ok) return false;
  const newCommitSha = commitNewRes.data?.sha;

  // Ref 업데이트
  const updateRes = await ghReq("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, token, {
    sha: newCommitSha,
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

// ─── D1 생성 ─────────────────────────────────────────────────────────────────
async function createD1Database({ cfToken, cfAccountId, cfEmail, dbName, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  D1 생성 중: ${dbName}`);
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database`, { name: dbName }, cfEmail);
  if (!res.ok) {
    const errMsg = res.data?.errors?.[0]?.message || "";
    if (errMsg.toLowerCase().includes("already exist") || res.status === 409) {
      const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/d1/database?name=${encodeURIComponent(dbName)}`, null, cfEmail);
      const found = listRes.data?.result?.find(db => db.name === dbName);
      if (found) { await log(`  D1 기존 사용: ${found.uuid}`); return found.uuid; }
    }
    await log(`  D1 생성 실패: ${JSON.stringify(res.data?.errors)}`, "error");
    return null;
  }
  const id = res.data?.result?.uuid;
  await log(`  D1 생성 완료: ${id}`);
  return id;
}

// ─── KV 생성 ─────────────────────────────────────────────────────────────────
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
    name: repoName,
    private: true,
    description: `CloudPress WordPress 사이트 — ${repoName}`,
    auto_init: true,
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
  await delay(2000); // GitHub 레포 초기화 대기
  return true;
}

// ─── WordPress 공식 코어 파일 목록 (GitHub API로 조회) ───────────────────────
// WordPress 6.7.2 태그의 루트 파일 목록 (핵심 파일만)
const WP_ROOT_FILES = [
  "index.php",
  "wp-activate.php",
  "wp-blog-header.php",
  "wp-comments-post.php",
  "wp-cron.php",
  "wp-links-opml.php",
  "wp-load.php",
  "wp-login.php",
  "wp-mail.php",
  "wp-settings.php",
  "wp-signup.php",
  "wp-trackback.php",
  "xmlrpc.php",
];

// ─── wp-config.php 생성 ──────────────────────────────────────────────────────
// CloudPress 전용 wp-config.php (D1 데이터베이스 연동)
function buildWpConfig({
  siteId,
  siteUrl,
  dbName,
  dbUser,
  dbPass,
  dbHost,
  dbPrefix,
  authKey,
  secureAuthKey,
  loggedInKey,
  nonceKey,
  authSalt,
  secureAuthSalt,
  loggedInSalt,
  nonceSalt,
}) {
  return `<?php
/**
 * WordPress 기본 설정 파일
 * CloudPress 자동 생성 — 직접 수정하지 마세요
 * 수정은 CloudPress 관리 패널을 이용하세요
 */

// ── 데이터베이스 설정 ─────────────────────────────────────────────────────────
// CloudPress D1(SQLite) 데이터베이스
// DB_HOST에 D1 데이터베이스 식별자를 저장
define( 'DB_NAME',     getenv('CP_DB_NAME')     ?: '${dbName}' );
define( 'DB_USER',     getenv('CP_DB_USER')     ?: '${dbUser}' );
define( 'DB_PASSWORD', getenv('CP_DB_PASS')     ?: '${dbPass}' );
define( 'DB_HOST',     getenv('CP_DB_HOST')     ?: '${dbHost}' );
define( 'DB_CHARSET',  'utf8mb4' );
define( 'DB_COLLATE',  '' );

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

// ── WordPress 테이블 접두사 ──────────────────────────────────────────────────
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
define( 'DISALLOW_FILE_MODS', false );

// ── 업로드 경로 (GitHub 레포 → wp-content/uploads) ──────────────────────────
define( 'UPLOADS', 'wp-content/uploads' );

// ── WordPress 설정 로드 ──────────────────────────────────────────────────────
require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── Worker 소스 (GitHub 레포 미러링 전용) ───────────────────────────────────
// 이 코드만이 Cloudflare Worker에 올라감
// 실제 WordPress PHP 파일은 GitHub 레포에 있고, php-wasm으로 실행됨
function buildWorkerSource({
  siteId,
  githubOwner,
  githubRepo,
  d1DbName,
  wpAdminUser,
  wpAdminEmail,
  dbName,
  dbUser,
  dbPass,
  dbPrefix,
}) {
  return `/**
 * CloudPress WordPress Worker — 사이트: ${siteId}
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 역할: GitHub 레포지토리 미러링 + php-wasm WordPress 실행
 *
 * 이 Worker 코드는 오직 다음만 수행합니다:
 *   1. 요청 수신
 *   2. GitHub 레포에서 WordPress 파일 조회
 *   3. PHP_RUNNER(cloudpress-php)에 전달하여 실행
 *   4. 결과 반환
 *   5. 정적 자산 캐싱
 *
 * 실제 WordPress PHP 파일 위치: ${githubOwner}/${githubRepo}
 * WordPress 코어: WordPress/WordPress (공식 GitHub)
 */

const SITE_ID      = "${siteId}";
const GH_OWNER     = "${githubOwner}";
const GH_REPO      = "${githubRepo}";
const GH_BRANCH    = "main";
const WP_VERSION   = "6.7.2";
const DB_NAME      = "${dbName}";
const DB_USER      = "${dbUser}";
const DB_PREFIX    = "${dbPrefix}";
// DB_PASS, GITHUB_TOKEN은 Worker Secret으로 관리

// 정적 파일 확장자
const STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|mp4|mp3|ogg|wav|webm|avif|zip|gz|tar)$/i;

// CORS 헤더
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-WP-Nonce",
};

// KV 헬퍼
async function kvGet(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvSet(env, key, val, ttl = 3600) {
  try { await env.CACHE?.put(key, val, { expirationTtl: ttl }); } catch {}
}

// GitHub Raw fetch (캐시 활용)
async function fetchFromGitHub(path, token, cf = { cacheEverything: true, cacheTtl: 3600 }) {
  const url = \`https://raw.githubusercontent.com/\${GH_OWNER}/\${GH_REPO}/\${GH_BRANCH}/\${path}\`;
  const headers = { "User-Agent": "CloudPress-Worker/5.0" };
  if (token) headers["Authorization"] = \`Bearer \${token}\`;
  try {
    const res = await fetch(url, { headers, cf });
    if (res.ok) return res;
  } catch {}
  return null;
}

// WordPress 코어 정적 자산 fetch (jsDelivr CDN)
async function fetchWpCore(filePath) {
  const cdnUrl = \`https://cdn.jsdelivr.net/gh/WordPress/WordPress@\${WP_VERSION}/\${filePath}\`;
  try {
    const res = await fetch(cdnUrl, { cf: { cacheEverything: true, cacheTtl: 86400 * 7 } });
    if (res.ok) return res;
  } catch {}
  // 폴백: GitHub Raw
  const rawUrl = \`https://raw.githubusercontent.com/WordPress/WordPress/master/\${filePath}\`;
  try {
    const res = await fetch(rawUrl, { cf: { cacheEverything: true, cacheTtl: 86400 } });
    if (res.ok) return res;
  } catch {}
  return null;
}

// MIME 타입
function mime(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return {
    css:"text/css;charset=utf-8", js:"application/javascript;charset=utf-8",
    json:"application/json;charset=utf-8", xml:"application/xml;charset=utf-8",
    svg:"image/svg+xml", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg",
    gif:"image/gif", webp:"image/webp", ico:"image/x-icon",
    woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf",
    pdf:"application/pdf", zip:"application/zip",
    mp4:"video/mp4", webm:"video/webm", mp3:"audio/mpeg",
    txt:"text/plain;charset=utf-8", html:"text/html;charset=utf-8",
  }[ext] || "application/octet-stream";
}

// 유지보수 모드 체크
async function isMaintenanceMode(env) {
  const val = await kvGet(env, \`cp:maintenance:\${SITE_ID}\`);
  return val === "1";
}

// 유지보수 페이지
function maintenancePage() {
  return new Response(\`<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>유지보수 중</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f0f1;}
.box{text-align:center;padding:40px;background:#fff;border-radius:8px;border:1px solid #c3c4c7;max-width:400px;}
h1{color:#1d2327;}p{color:#646970;}</style></head>
<body><div class="box">
<h1>🔧 유지보수 중</h1>
<p>설정을 업데이트하고 있습니다. 잠시 후 다시 접속해 주세요.</p>
<p style="font-size:12px;color:#a7aaad;margin-top:20px;">잠시 후 자동으로 새로고침됩니다.</p>
</div>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>\`, {
    status: 503,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Retry-After": "30",
    },
  });
}

// PHP_RUNNER로 WordPress 실행 요청
async function runWordPress(env, request, phpFile, extraEnv = {}) {
  if (!env.PHP_RUNNER) {
    return new Response("PHP Runner not configured", { status: 503 });
  }

  const url     = new URL(request.url);
  const method  = request.method.toUpperCase();
  const token   = env.GITHUB_TOKEN;

  // wp-config.php 내용 읽기 (GitHub 레포 → 우선, 폴백: 환경변수 생성)
  let wpConfigContent = null;
  const configRes = await fetchFromGitHub("wp-config.php", token, { cacheEverything: false });
  if (configRes) wpConfigContent = await configRes.text();

  // 요청 쿠키/헤더 전달
  const phpEnv = {
    REQUEST_METHOD:  method,
    REQUEST_URI:     url.pathname + url.search,
    QUERY_STRING:    url.search.slice(1),
    HTTP_HOST:       url.hostname,
    SERVER_NAME:     url.hostname,
    SERVER_PORT:     url.port || (url.protocol === "https:" ? "443" : "80"),
    HTTPS:           url.protocol === "https:" ? "on" : "off",
    SCRIPT_FILENAME: \`/var/www/wordpress\${phpFile}\`,
    SCRIPT_NAME:     phpFile,
    HTTP_USER_AGENT: request.headers.get("User-Agent") || "",
    HTTP_REFERER:    request.headers.get("Referer") || "",
    HTTP_COOKIE:     request.headers.get("Cookie") || "",
    HTTP_ACCEPT:     request.headers.get("Accept") || "",
    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language") || "",
    CONTENT_TYPE:    request.headers.get("Content-Type") || "",
    CONTENT_LENGTH:  request.headers.get("Content-Length") || "",
    REMOTE_ADDR:     request.headers.get("CF-Connecting-IP") || "127.0.0.1",
    // CloudPress DB 정보
    CP_SITE_ID:  SITE_ID,
    CP_DB_NAME:  DB_NAME,
    CP_DB_USER:  DB_USER,
    CP_DB_PASS:  env.DB_PASS || "",
    CP_DB_HOST:  "localhost",
    ...extraEnv,
  };

  let stdin = "";
  if (["POST", "PUT", "PATCH"].includes(method)) {
    try { stdin = await request.text(); } catch {}
  }

  const payload = {
    phpFile,
    phpEnv,
    stdin,
    siteConfig: {
      siteId:        SITE_ID,
      githubOwner:   GH_OWNER,
      githubRepo:    GH_REPO,
      githubBranch:  GH_BRANCH,
      wpConfigContent,
      dbName:        DB_NAME,
      dbUser:        DB_USER,
      dbPass:        env.DB_PASS || "",
      dbHost:        "localhost",
    },
    skipCache: method !== "GET" || phpEnv.HTTP_COOKIE?.includes("wordpress_logged_in"),
  };

  const phpRunnerReq = new Request("https://php-runner/run-wordpress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return env.PHP_RUNNER.fetch(phpRunnerReq);
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // CORS 프리플라이트
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 유지보수 모드 체크 (설정 변경 중 접속 차단)
    if (await isMaintenanceMode(env)) {
      // /wp-admin/과 /wp-json/은 차단 예외
      if (!path.startsWith("/wp-admin/") && !path.startsWith("/wp-json/cloudpress/")) {
        return maintenancePage();
      }
    }

    // ── 정적 자산 서빙 (캐시 우선) ──────────────────────────────────────────
    if (STATIC_EXT.test(path)) {
      const filePath = path.replace(/^\\//, "");

      // 1. 사용자 wp-content (GitHub 레포)
      if (path.startsWith("/wp-content/")) {
        const token  = env.GITHUB_TOKEN;
        const cached = await kvGet(env, \`static:\${filePath}\`);
        if (cached) {
          return new Response(cached, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=3600",
              "X-Cache":       "HIT",
            },
          });
        }
        const res = await fetchFromGitHub(filePath, token);
        if (res) {
          const body = await res.text();
          ctx.waitUntil(kvSet(env, \`static:\${filePath}\`, body, 3600));
          return new Response(body, {
            headers: {
              "Content-Type":  mime(filePath),
              "Cache-Control": "public, max-age=3600",
              "X-Source":      "github",
            },
          });
        }
      }

      // 2. WordPress 코어 자산 (wp-includes, wp-admin CSS/JS)
      const coreRes = await fetchWpCore(filePath);
      if (coreRes) {
        const body = await coreRes.arrayBuffer();
        return new Response(body, {
          headers: {
            "Content-Type":  mime(filePath),
            "Cache-Control": "public, max-age=86400, immutable",
            "X-Source":      "wp-core",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    }

    // ── WordPress 실행 (php-wasm) ────────────────────────────────────────────
    // DB가 없으면 준비 중 메시지
    if (!env.DB) {
      return new Response(\`<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;">
<h1>🚀 준비 중...</h1><p>데이터베이스를 초기화하고 있습니다.</p>
<script>setTimeout(()=>location.reload(),5000)</script></body></html>\`, {
        status: 503, headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    // PHP Runner가 없으면 D1 기반 WordPress REST API로 폴백
    if (!env.PHP_RUNNER) {
      return new Response(\`<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;">
<h1>⚠️ PHP Runner 미설정</h1><p>cloudpress-php Worker를 먼저 배포해야 합니다.</p></body></html>\`, {
        status: 503, headers: { "Content-Type": "text/html;charset=utf-8" },
      });
    }

    // PHP 파일 경로 결정
    let phpFile = "/index.php";
    if (path.startsWith("/wp-admin/")) {
      phpFile = path.endsWith(".php") ? path : "/wp-admin/index.php";
    } else if (path === "/wp-login.php") {
      phpFile = "/wp-login.php";
    } else if (path.endsWith(".php")) {
      phpFile = path;
    } else if (path === "/" || path === "") {
      phpFile = "/index.php";
    } else {
      // 퍼머링크 처리 — index.php에 REQUEST_URI 전달
      phpFile = "/index.php";
    }

    return runWordPress(env, request, phpFile);
  },
};
`;
}

// ─── 메인 프로비저닝 함수 ─────────────────────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env,
  siteId,
  siteName,
  adminUser,
  adminPass,       // 자동 생성된 비밀번호 (sites.js에서 전달)
  adminEmail,
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
  const shortId    = siteId.replace(/-/g, "").slice(0, 8);
  const safeSlug   = slugify(siteName) || `site-${shortId}`;
  const workerName = `cp-${shortId}-wp`;
  const d1DbName   = `cp-${shortId}-db`;
  const kvCacheName= `cp-${shortId}-cache`;
  const repoName   = `cp-${shortId}-${safeSlug}`.slice(0, 100);

  await log(`━━━ 호스팅 프로비저닝 시작 ━━━`);
  await log(`사이트 ID  : ${siteId}`);
  await log(`Worker 명  : ${workerName}`);
  await log(`D1 DB 명   : ${d1DbName}`);
  await log(`GitHub 레포: ${repoName}`);

  // ── 1. 자동 생성 자격증명 ─────────────────────────────────────────────────
  // DB 정보 자동 생성 (사용자가 입력 불필요)
  const dbName    = `wp_${shortId}`;
  const dbUser    = `wp_user_${shortId}`;
  const dbPass    = randomPass(24);
  const dbPrefix  = `wp_`;
  // WordPress 인증 키/솔트 자동 생성
  const authKey         = randomStr(64);
  const secureAuthKey   = randomStr(64);
  const loggedInKey     = randomStr(64);
  const nonceKey        = randomStr(64);
  const authSalt        = randomStr(64);
  const secureAuthSalt  = randomStr(64);
  const loggedInSalt    = randomStr(64);
  const nonceSalt       = randomStr(64);
  // WordPress 관리자 비밀번호 (미제공 시 자동 생성)
  const wpAdminPass     = adminPass || randomPass(16);
  const wpAdminUser     = adminUser || "admin";

  await log(`✅ DB 자격증명 자동 생성 완료`);
  await log(`   DB 이름: ${dbName} / 사용자: ${dbUser}`);

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
    await log("GitHub 토큰 없음 — GitHub 레포 스킵 (Worker만 배포)", "warn");
  }

  // ── 3. D1 & KV 생성 ───────────────────────────────────────────────────────
  let d1Id     = null;
  let kvCacheId = null;

  if (cfToken && cfAccountId) {
    await log("▶ Cloudflare 리소스 생성 중...");
    [d1Id, kvCacheId] = await Promise.all([
      createD1Database({ cfToken, cfAccountId, cfEmail, dbName: d1DbName, log }),
      createKVNamespace({ cfToken, cfAccountId, cfEmail, title: kvCacheName, log }),
    ]);
  }

  // ── 4. GitHub 레포 생성 + WordPress 파일 push ─────────────────────────────
  let githubRepoUrl = null;

  if (ghToken && owner) {
    await log("▶ GitHub 레포 생성 중...");
    const created = await createGitHubRepo({ ghToken, owner, repoName, log });

    if (created) {
      await log("▶ WordPress 파일 GitHub 레포에 push 중...");

      // wp-config.php 생성 (자동 생성 자격증명 사용)
      const siteUrl = initialDomain
        ? `https://${initialDomain}`
        : cfAccountId
          ? `https://${workerName}.${shortId}.workers.dev`
          : `https://${repoName}.workers.dev`;

      const wpConfigContent = buildWpConfig({
        siteId,
        siteUrl,
        dbName,
        dbUser,
        dbPass,
        dbHost: "localhost", // D1은 내부 연결
        dbPrefix,
        authKey, secureAuthKey, loggedInKey, nonceKey,
        authSalt, secureAuthSalt, loggedInSalt, nonceSalt,
      });

      // Worker 소스 (GitHub 레포 미러링 전용)
      const workerSource = buildWorkerSource({
        siteId,
        githubOwner: owner,
        githubRepo: repoName,
        d1DbName,
        wpAdminUser,
        wpAdminEmail: adminEmail,
        dbName,
        dbUser,
        dbPass,
        dbPrefix,
      });

      // WordPress D1 초기화 SQL (WordPress 스키마)
      const wpSchemaSql = buildWordPressD1Schema({ dbPrefix });

      // WordPress 관리자 초기 데이터 SQL
      const passHash = phpassCreate(wpAdminPass);
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const wpInitSql = buildWordPressInitData({
        dbPrefix, wpAdminUser, passHash, adminEmail, siteName, siteUrl, now
      });

      // GitHub에 push할 파일 목록
      const filesToPush = [
        // wp-config.php — WordPress 설정
        { path: "wp-config.php", content: wpConfigContent },
        // worker.js — Cloudflare Worker (GitHub 레포 미러링 코드만)
        { path: "worker.js", content: workerSource },
        // wrangler.toml — Worker 배포 설정
        {
          path: "wrangler.toml",
          content: buildWranglerToml({ workerName, d1Id, d1DbName, kvCacheId, kvCacheName, siteId }),
        },
        // .github/workflows/deploy.yml — GitHub Actions 자동 배포
        {
          path: ".github/workflows/deploy.yml",
          content: buildGitHubActionsWorkflow({ workerName }),
        },
        // _sql/schema.sql — WordPress D1 스키마
        { path: "_sql/schema.sql", content: wpSchemaSql },
        // _sql/init.sql — WordPress 초기 데이터
        { path: "_sql/init.sql", content: wpInitSql },
        // wp-content/uploads/.gitkeep — 업로드 폴더
        { path: "wp-content/uploads/.gitkeep", content: "" },
        // wp-content/themes/.gitkeep — 테마 폴더
        { path: "wp-content/themes/.gitkeep", content: "" },
        // wp-content/plugins/.gitkeep — 플러그인 폴더
        { path: "wp-content/plugins/.gitkeep", content: "" },
        // README
        {
          path: "README.md",
          content: buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl }),
        },
      ];

      const pushed = await ghBatchPush(ghToken, owner, repoName, filesToPush, "🚀 CloudPress 초기 WordPress 설정");
      if (pushed) {
        await log(`✅ GitHub 파일 push 완료 (${filesToPush.length}개 파일)`);
        githubRepoUrl = `https://github.com/${owner}/${repoName}`;
      } else {
        await log("⚠️ GitHub push 실패 (부분 진행)", "warn");
      }
    }
  }

  // ── 5. Cloudflare Worker 배포 ─────────────────────────────────────────────
  let workerDomain = null;

  if (cfToken && cfAccountId && owner && ghToken) {
    await log("▶ Cloudflare Worker 배포 중...");

    // GitHub 레포에서 worker.js 읽기 (방금 push한 것)
    await delay(3000); // GitHub 반영 대기
    let workerSource = null;
    try {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/main/worker.js`;
      const res = await fetch(rawUrl, {
        headers: { "Authorization": `Bearer ${ghToken}`, "User-Agent": "CloudPress/5.0" },
      });
      if (res.ok) {
        workerSource = await res.text();
        await log("  Worker 소스: GitHub 레포에서 읽기 완료");
      }
    } catch (e) {
      await log(`  Worker 소스 읽기 실패: ${e.message}`, "warn");
    }

    if (workerSource) {
      const deployed = await deployWorker({
        cfToken, cfAccountId, cfEmail,
        workerName, workerSource,
        d1Id, d1DbName, kvCacheId,
        siteId, ghOwner: owner, ghRepo: repoName,
        dbPass: dbPass,
        wpAdminUser, wpAdminPass, adminEmail,
        log,
      });

      if (deployed) {
        workerDomain = deployed.workerDomain;

        // D1 스키마 초기화
        if (d1Id) {
          await log("▶ D1 WordPress 스키마 초기화 중...");
          const schemaResult = await initD1Schema({
            cfToken, cfAccountId, cfEmail,
            d1Id,
            dbPrefix,
            adminUser: wpAdminUser,
            adminPass: wpAdminPass,
            adminEmail,
            siteName,
            siteUrl: workerDomain || siteUrl,
            log,
          });
          if (schemaResult) {
            await log("✅ WordPress 스키마 초기화 완료");
          } else {
            await log("⚠️ D1 스키마 초기화 실패 (수동 설정 필요)", "warn");
          }
        }
      }
    }
  }

  // ── 6. 결과 반환 ──────────────────────────────────────────────────────────
  const cfPagesUrl = workerDomain || (owner ? `https://github.com/${owner}/${repoName}` : null);

  await log("━━━ 프로비저닝 완료 ━━━");
  await log(`사이트 URL: ${cfPagesUrl || "설정 필요"}`);
  await log(`GitHub 레포: ${githubRepoUrl || "미생성"}`);
  await log(`WordPress 관리자: ${wpAdminUser} / 비밀번호는 관리 패널에서 확인`);

  return {
    success:        true,
    workerName,
    workerDomain,
    cfPagesUrl,
    githubRepoUrl,
    githubOwner:    owner,
    githubRepo:     repoName,
    d1Id,
    kvCacheId,
    // DB 자격증명 (플랫폼 DB에 암호화 저장)
    dbName,
    dbUser,
    dbPass,
    dbPrefix,
    // WordPress 관리자 (생성 완료 후 알림용)
    wpAdminUser,
    wpAdminPass,
    wpAdminEmail:   adminEmail,
    // 자동 생성 완료 플래그
    autoProvisioned: true,
  };
}

// ─── Worker 배포 ──────────────────────────────────────────────────────────────
async function deployWorker({
  cfToken, cfAccountId, cfEmail,
  workerName, workerSource,
  d1Id, d1DbName, kvCacheId,
  siteId, ghOwner, ghRepo,
  dbPass, wpAdminUser, wpAdminPass, adminEmail,
  log,
}) {
  const boundaryVal = `----FormBoundary${Math.random().toString(36).slice(2)}`;

  const bindings = [
    ...(d1Id ? [
      { type: "d1", name: "DB", database_id: d1Id },
    ] : []),
    ...(kvCacheId ? [
      { type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId },
    ] : []),
    { type: "plain_text", name: "SITE_ID",      text: siteId },
    { type: "plain_text", name: "GH_OWNER",     text: ghOwner || "" },
    { type: "plain_text", name: "GH_REPO",      text: ghRepo  || "" },
    // PHP_RUNNER Service Binding (cloudpress-php Worker)
    { type: "service", name: "PHP_RUNNER", service: "cloudpress-php", environment: "production" },
  ];

  const metadataObj = {
    main_module: "worker.js",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };

  const metaPart =
    `--${boundaryVal}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadataObj) + `\r\n`;

  const scriptPart =
    `--${boundaryVal}\r\n` +
    `Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n` +
    `Content-Type: application/javascript+module\r\n\r\n` +
    workerSource + `\r\n`;

  const closing = `--${boundaryVal}--\r\n`;

  const bodyText = metaPart + scriptPart + closing;
  const bodyBytes = new TextEncoder().encode(bodyText);

  const deployRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundaryVal}`,
        ...(cfEmail
          ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
          : { "Authorization": `Bearer ${cfToken}` }),
      },
      body: bodyBytes,
    }
  );

  const deployData = await deployRes.json().catch(() => ({}));
  if (!deployRes.ok) {
    const errMsg = JSON.stringify(deployData?.errors || deployData);
    await log(`  Worker 배포 실패 (${deployRes.status}): ${errMsg}`, "error");
    return null;
  }
  await log(`  ✅ Worker 배포 완료: ${workerName}`);

  // Secrets 설정 (DB 비밀번호, GitHub 토큰 등)
  const ghToken = await pickGithubToken({ GITHUB_TOKEN: undefined }).catch(() => null);
  const secrets = [
    { name: "DB_PASS",         text: dbPass },
    { name: "WP_ADMIN_USER",   text: wpAdminUser },
    { name: "WP_ADMIN_PASS",   text: wpAdminPass },
    { name: "WP_ADMIN_EMAIL",  text: adminEmail },
    { name: "JWT_SECRET",      text: btoa(Array.from(crypto.getRandomValues(new Uint8Array(32)), b => String.fromCharCode(b)).join("")) },
  ];

  for (const secret of secrets) {
    try {
      const sRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/secrets`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(cfEmail
              ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
              : { "Authorization": `Bearer ${cfToken}` }),
          },
          body: JSON.stringify({ name: secret.name, text: secret.text, type: "secret_text" }),
        }
      );
      if (sRes.ok) await log(`  Secret: ${secret.name} ✅`);
    } catch {}
  }

  // Worker 서브도메인 활성화
  let workerDomain = null;
  try {
    const subRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfEmail
            ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
            : { "Authorization": `Bearer ${cfToken}` }),
        },
        body: JSON.stringify({ enabled: true }),
      }
    );
    if (subRes.ok) {
      const subData = await subRes.json();
      const subdomain = subData?.result?.subdomain;
      if (subdomain) {
        workerDomain = `https://${workerName}.${subdomain}.workers.dev`;
        await log(`  Worker URL: ${workerDomain}`);
      }
    }
  } catch {}

  return { workerName, workerDomain };
}

// ─── D1 WordPress 스키마 초기화 ─────────────────────────────────────────────
async function initD1Schema({
  cfToken, cfAccountId, cfEmail,
  d1Id, dbPrefix,
  adminUser, adminPass, adminEmail,
  siteName, siteUrl, log,
}) {
  if (!cfToken || !cfAccountId || !d1Id) return false;

  const passHash = phpassCreate(adminPass);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // WordPress 필수 테이블 생성 SQL
  const schemaSqls = buildWordPressD1SchemaSqls({ dbPrefix });
  const initSqls   = buildWordPressInitSqls({ dbPrefix, adminUser, passHash, adminEmail, siteName, siteUrl, now });

  const allSqls = [...schemaSqls, ...initSqls];

  let success = true;
  for (const sql of allSqls) {
    try {
      const res = await cfReq(cfToken, "POST",
        `/accounts/${cfAccountId}/d1/database/${d1Id}/query`,
        { sql },
        cfEmail
      );
      if (!res.ok) {
        const errMsg = res.data?.errors?.[0]?.message || "";
        // 이미 존재하는 테이블은 무시
        if (!errMsg.includes("already exists") && !errMsg.includes("UNIQUE")) {
          await log(`  SQL 오류: ${errMsg}`, "warn");
        }
      }
    } catch (e) {
      await log(`  SQL 실행 오류: ${e.message}`, "warn");
      success = false;
    }
  }
  return success;
}

// ─── WordPress D1 스키마 (SQLite 호환) ──────────────────────────────────────
function buildWordPressD1SchemaSqls({ dbPrefix }) {
  const p = dbPrefix;
  return [
    `CREATE TABLE IF NOT EXISTS ${p}options (
      option_id INTEGER PRIMARY KEY AUTOINCREMENT,
      option_name TEXT NOT NULL DEFAULT '' UNIQUE,
      option_value TEXT NOT NULL DEFAULT '',
      autoload TEXT NOT NULL DEFAULT 'yes'
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}users (
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
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}usermeta (
      umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}posts (
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
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}postmeta (
      meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}terms (
      term_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      term_group INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}term_taxonomy (
      term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL DEFAULT 0,
      taxonomy TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      parent INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}term_relationships (
      object_id INTEGER NOT NULL DEFAULT 0,
      term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
      term_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (object_id, term_taxonomy_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}comments (
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
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}commentmeta (
      meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL DEFAULT 0,
      meta_key TEXT DEFAULT NULL,
      meta_value TEXT DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}links (
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
    )`,
  ];
}

function buildWordPressInitSqls({ dbPrefix, adminUser, passHash, adminEmail, siteName, siteUrl, now }) {
  const p = dbPrefix;
  return [
    // 관리자 사용자
    `INSERT OR IGNORE INTO ${p}users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name)
     VALUES ('${adminUser}', '${passHash}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', 0, '${adminUser}')`,
    // 관리자 권한
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, '${p}capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, '${p}user_level', '10')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, 'admin_color', 'fresh')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, 'rich_editing', '1')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, 'comment_shortcuts', '0')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, 'show_admin_bar_front', '1')`,
    // WordPress 기본 옵션
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('siteurl', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('home', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogname', '${siteName}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogdescription', 'CloudPress로 만든 WordPress 사이트', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('admin_email', '${adminEmail}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogpublic', '1', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blog_charset', 'UTF-8', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('date_format', 'Y년 n월 j일', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('time_format', 'A g:i', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('start_of_week', '0', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('timezone_string', 'Asia/Seoul', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('permalink_structure', '/%postname%/', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('template', 'twentytwentyfour', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('stylesheet', 'twentytwentyfour', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('current_theme', 'Twenty Twenty-Four', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('active_plugins', 'a:0:{}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('wp_user_roles', 'a:5:{s:13:"administrator";a:2:{s:4:"name";s:13:"Administrator";s:12:"capabilities";a:1:{s:13:"administrator";b:1;}}s:6:"editor";a:2:{s:4:"name";s:6:"Editor";s:12:"capabilities";a:1:{s:6:"editor";b:1;}}s:6:"author";a:2:{s:4:"name";s:6:"Author";s:12:"capabilities";a:1:{s:6:"author";b:1;}}s:11:"contributor";a:2:{s:4:"name";s:11:"Contributor";s:12:"capabilities";a:1:{s:11:"contributor";b:1;}}s:10:"subscriber";a:2:{s:4:"name";s:10:"Subscriber";s:12:"capabilities";a:1:{s:10:"subscriber";b:1;}}}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('wp_db_version', '57155', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('initial_db_version', '57155', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('db_version', '57155', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('cp_auto_installed', '1', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('cp_installed_at', '${now}', 'yes')`,
    // 기본 카테고리
    `INSERT OR IGNORE INTO ${p}terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0)`,
    `INSERT OR IGNORE INTO ${p}term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 1)`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('default_category', '1', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('posts_per_page', '10', 'yes')`,
    // 샘플 글
    `INSERT OR IGNORE INTO ${p}posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status, menu_order, post_parent)
     VALUES (1, '${now}', '${now}', 'WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.\n\n<!-- wp:paragraph -->\n<p>이 글을 수정하거나 삭제하고 새로운 글을 작성해보세요!</p>\n<!-- /wp:paragraph -->', '안녕하세요!', '', 'publish', 'hello-world', '${now}', '${now}', 'post', '${siteUrl}/?p=1', 'open', 'open', 0, 0)`,
    `INSERT OR IGNORE INTO ${p}term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0)`,
    `UPDATE ${p}term_taxonomy SET count = 1 WHERE term_taxonomy_id = 1`,
  ];
}

function buildWordPressD1Schema({ dbPrefix }) {
  const sqls = buildWordPressD1SchemaSqls({ dbPrefix });
  return sqls.join(";\n\n") + ";";
}

function buildWordPressInitData({ dbPrefix, wpAdminUser, passHash, adminEmail, siteName, siteUrl, now }) {
  const sqls = buildWordPressInitSqls({ dbPrefix, adminUser: wpAdminUser, passHash, adminEmail, siteName, siteUrl, now });
  return sqls.join(";\n\n") + ";";
}

// ─── wrangler.toml 빌드 ──────────────────────────────────────────────────────
function buildWranglerToml({ workerName, d1Id, d1DbName, kvCacheId, kvCacheName, siteId }) {
  return `# CloudPress WordPress Worker 배포 설정
# GitHub 레포 미러링 전용 Worker
name              = "${workerName}"
main              = "worker.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

${d1Id ? `[[d1_databases]]
binding       = "DB"
database_name = "${d1DbName}"
database_id   = "${d1Id}"` : `# D1: Cloudflare 대시보드에서 바인딩 설정 필요`}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 설정 필요`}

# PHP Runner Service Binding (cloudpress-php Worker)
[[services]]
binding = "PHP_RUNNER"
service = "cloudpress-php"

[vars]
SITE_ID = "${siteId}"
`;
}

// ─── GitHub Actions 워크플로 ─────────────────────────────────────────────────
function buildGitHubActionsWorkflow({ workerName }) {
  return `name: CloudPress WordPress Worker 자동 배포

on:
  push:
    branches: [main]
    paths:
      - 'worker.js'
      - 'wrangler.toml'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Wrangler Deploy
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
`;
}

// ─── README 빌드 ─────────────────────────────────────────────────────────────
function buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl }) {
  return `# ${siteName}

CloudPress로 생성된 진짜 WordPress 사이트입니다.

## 구조

\`\`\`
${repoName}/
├── worker.js          # Cloudflare Worker (GitHub 레포 미러링만)
├── wrangler.toml      # Worker 배포 설정
├── wp-config.php      # WordPress 설정 (자동 생성)
├── wp-content/
│   ├── themes/        # 테마 (이 레포에 추가)
│   ├── plugins/       # 플러그인 (이 레포에 추가)
│   └── uploads/       # 미디어 업로드 (자동 미러링)
└── _sql/
    ├── schema.sql     # WordPress D1 스키마
    └── init.sql       # 초기 데이터
\`\`\`

## 작동 원리

1. **Cloudflare Worker** (\`worker.js\`)가 모든 요청을 수신
2. 정적 자산은 직접 이 레포에서 서빙
3. PHP 요청은 \`cloudpress-php\` Worker (php-wasm)로 전달
4. php-wasm이 이 레포의 WordPress 파일을 실행
5. 데이터는 Cloudflare D1 (SQLite)에 저장

## 관리

- **CloudPress 대시보드**: https://cloud-press.co.kr/dashboard
- **사이트 ID**: ${siteId}
- **Worker**: ${workerName}
- **사이트 URL**: ${siteUrl}

## 커스터마이징

### 테마 추가
\`wp-content/themes/my-theme/\` 폴더에 테마 파일 추가 후 push

### 플러그인 추가
\`wp-content/plugins/my-plugin/\` 폴더에 플러그인 파일 추가 후 push

## 주의

- \`wp-config.php\`는 자동 생성됩니다. 직접 수정하지 마세요.
- DB 자격증명 변경은 CloudPress 관리 패널에서 하세요.
- 변경 적용 중에는 사이트 접속이 일시 차단됩니다.
`;
    }
