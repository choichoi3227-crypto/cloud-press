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
// ─── 사이트별 Worker 소스 빌드 (worker-site-mirror.js 기반) ─────────────────
// 각 사이트 Worker는 worker-site-mirror.js를 기반으로 사이트별 상수를 치환합니다.
// Worker에는 오직 GitHub 레포 미러링 코드만 포함됩니다.
// 진짜 WordPress PHP 실행은 PHP_RUNNER(cloudpress-php) Service Binding으로 위임합니다.
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
  // worker-site-mirror.js 소스에서 플레이스홀더 치환
  const baseSrc = '/**\n * CloudPress — worker-site-mirror.js\n * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n * 사이트별 Cloudflare Worker 미러링 코드 (진짜 WordPress 실행)\n *\n * 역할:\n *   1. 요청 수신\n *   2. 정적 자산 → GitHub 레포 또는 WordPress/WordPress 공식 CDN에서 서빙\n *   3. PHP 요청 → PHP_RUNNER(cloudpress-php) Service Binding으로 전달\n *   4. php-wasm이 GitHub 레포의 WordPress 파일을 실행\n *   5. 유지보수 모드 (설정 변경 중 접속 차단)\n *\n * 이 파일은 각 호스팅 생성 시 GitHub 레포에 worker.js 로 복사됩니다.\n * cf-pages-hosting.js의 buildWorkerSource()가 이 파일 내용을 기반으로\n * 사이트별 상수(SITE_ID, GH_OWNER, GH_REPO 등)를 치환하여 생성합니다.\n *\n * Worker 바인딩 (wrangler.toml / 프로비저닝 시 자동 설정):\n *   PHP_RUNNER  - cloudpress-php Worker (Service Binding) — php-wasm WordPress 실행\n *   DB          - Cloudflare D1 (WordPress 데이터베이스)\n *   CACHE       - Cloudflare KV (PHP 출력 캐시 + 정적 자산 캐시)\n *   SITE_ID     - 사이트 고유 ID (plain_text 환경변수)\n *   GH_OWNER    - GitHub 레포 소유자 (plain_text 환경변수)\n *   GH_REPO     - GitHub 레포 이름 (plain_text 환경변수)\n *   GITHUB_TOKEN - GitHub Personal Access Token (secret)\n *   DB_PASS     - WordPress DB 비밀번호 (secret, 자동 생성)\n *\n * 배포 전제 조건:\n *   cloudpress-php Worker가 먼저 배포되어 있어야 합니다.\n *   (npm run deploy:php 또는 wrangler deploy --config wrangler-php.toml)\n *\n * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n */\n\n// ─── 사이트 상수 (cf-pages-hosting.js buildWorkerSource()에서 치환) ──────────\n// 이 파일이 직접 배포될 때는 환경변수(env.*)를 우선 사용합니다.\nconst SITE_ID    = "%%SITE_ID%%";\nconst GH_OWNER   = "%%GH_OWNER%%";\nconst GH_REPO    = "%%GH_REPO%%";\nconst GH_BRANCH  = "main";\nconst WP_VERSION = "6.7.2";\n\n// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────\nconst STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|pdf|zip|mp4|mp3|ogg|wav|webm|gz|tar)$/i;\n\n// 캐시 스킵 경로 (로그인 필요 / 동적 페이지)\nconst SKIP_CACHE_PATHS = [\n  "/wp-admin", "/wp-login.php", "/cart", "/checkout",\n  "/my-account", "/wp-cron.php", "/xmlrpc.php",\n];\n\n// ─── CORS 헤더 ───────────────────────────────────────────────────────────────\nconst CORS_HEADERS = {\n  "Access-Control-Allow-Origin":  "*",\n  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",\n  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-WP-Nonce,X-Requested-With",\n};\n\n// ─── 보안 헤더 ───────────────────────────────────────────────────────────────\nconst SECURITY_HEADERS = {\n  "X-Content-Type-Options": "nosniff",\n  "X-Frame-Options":        "SAMEORIGIN",\n  "Referrer-Policy":        "strict-origin-when-cross-origin",\n};\n\n// ─── KV 헬퍼 ─────────────────────────────────────────────────────────────────\nasync function kvGet(env, key) {\n  try { return await env.CACHE?.get(key); } catch { return null; }\n}\nasync function kvSet(env, key, val, ttl = 3600) {\n  try { await env.CACHE?.put(key, val, { expirationTtl: ttl }); } catch {}\n}\n\n// ─── MIME 타입 ───────────────────────────────────────────────────────────────\nfunction mime(path) {\n  const ext = (path.split(".").pop() || "").toLowerCase();\n  return ({\n    css: "text/css;charset=utf-8",\n    js: "application/javascript;charset=utf-8",\n    mjs: "application/javascript;charset=utf-8",\n    json: "application/json;charset=utf-8",\n    xml: "application/xml;charset=utf-8",\n    svg: "image/svg+xml",\n    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",\n    gif: "image/gif", webp: "image/webp", avif: "image/avif",\n    ico: "image/x-icon",\n    woff: "font/woff", woff2: "font/woff2",\n    ttf: "font/ttf", eot: "application/vnd.ms-fontobject", otf: "font/otf",\n    pdf: "application/pdf", zip: "application/zip",\n    mp4: "video/mp4", webm: "video/webm",\n    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",\n    txt: "text/plain;charset=utf-8",\n    html: "text/html;charset=utf-8",\n  })[ext] || "application/octet-stream";\n}\n\n// ─── 사이트 상수 해석 (환경변수 우선) ────────────────────────────────────────\nfunction getSiteId(env)   { return env.SITE_ID   || SITE_ID;   }\nfunction getGhOwner(env)  { return env.GITHUB_OWNER || env.GH_OWNER  || GH_OWNER;  }\nfunction getGhRepo(env)   { return env.GITHUB_REPO  || env.GH_REPO   || GH_REPO;   }\nfunction getGhToken(env)  { return env.GITHUB_TOKEN || ""; }\n\n// ─── GitHub Raw fetch (사용자 레포 파일) ─────────────────────────────────────\nasync function fetchFromGitHub(env, filePath, noCache = false) {\n  const owner = getGhOwner(env);\n  const repo  = getGhRepo(env);\n  const token = getGhToken(env);\n  if (!owner || !repo) return null;\n\n  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${GH_BRANCH}/${filePath}`;\n  const headers = { "User-Agent": "CloudPress-SiteMirror/1.0" };\n  if (token) headers["Authorization"] = `Bearer ${token}`;\n\n  try {\n    const res = await fetch(url, {\n      headers,\n      cf: noCache\n        ? { cacheEverything: false }\n        : { cacheEverything: true, cacheTtl: 300 },\n    });\n    if (res.ok) return res;\n  } catch {}\n  return null;\n}\n\n// ─── WordPress 코어 정적 자산 fetch (jsDelivr CDN → GitHub Raw 폴백) ─────────\nasync function fetchWpCore(filePath) {\n  // jsDelivr CDN (빠른 글로벌 엣지)\n  const cdnUrl = `https://cdn.jsdelivr.net/gh/WordPress/WordPress@${WP_VERSION}/${filePath}`;\n  try {\n    const res = await fetch(cdnUrl, {\n      cf: { cacheEverything: true, cacheTtl: 86400 * 7 },\n    });\n    if (res.ok) return res;\n  } catch {}\n\n  // 폴백: 공식 GitHub Raw\n  const rawUrl = `https://raw.githubusercontent.com/WordPress/WordPress/master/${filePath}`;\n  try {\n    const res = await fetch(rawUrl, {\n      cf: { cacheEverything: true, cacheTtl: 86400 },\n    });\n    if (res.ok) return res;\n  } catch {}\n\n  return null;\n}\n\n// ─── 유지보수 모드 ────────────────────────────────────────────────────────────\nasync function isMaintenanceMode(env) {\n  const siteId = getSiteId(env);\n  const val = await kvGet(env, `cp:maintenance:${siteId}`);\n  return val === "1";\n}\n\nfunction maintenancePage() {\n  return new Response(`<!DOCTYPE html>\n<html lang="ko">\n<head>\n  <meta charset="UTF-8">\n  <meta http-equiv="refresh" content="10">\n  <title>유지보수 중 — CloudPress</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body {\n      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n      background: #f0f0f1;\n      display: flex; align-items: center; justify-content: center;\n      min-height: 100vh;\n    }\n    .box {\n      text-align: center; padding: 48px 40px;\n      background: #fff; border-radius: 8px;\n      border: 1px solid #c3c4c7; max-width: 420px;\n      box-shadow: 0 1px 3px rgba(0,0,0,.08);\n    }\n    .icon { font-size: 48px; margin-bottom: 16px; }\n    h1 { color: #1d2327; font-size: 22px; margin-bottom: 12px; }\n    p  { color: #646970; line-height: 1.6; }\n    .note { font-size: 12px; color: #a7aaad; margin-top: 20px; }\n  </style>\n</head>\n<body>\n  <div class="box">\n    <div class="icon">🔧</div>\n    <h1>유지보수 중</h1>\n    <p>설정을 업데이트하고 있습니다.<br>잠시 후 자동으로 다시 접속됩니다.</p>\n    <p class="note">10초 후 자동으로 새로고침됩니다.</p>\n  </div>\n</body>\n</html>`, {\n    status: 503,\n    headers: {\n      "Content-Type": "text/html;charset=utf-8",\n      "Retry-After": "30",\n      "Cache-Control": "no-store",\n    },\n  });\n}\n\n// ─── PHP 실행 (PHP_RUNNER Service Binding → cloudpress-php Worker) ────────────\nasync function runWordPress(request, env, ctx, phpFile) {\n  // PHP_RUNNER 바인딩 확인\n  if (!env.PHP_RUNNER) {\n    return new Response(`<!DOCTYPE html>\n<html lang="ko"><head><meta charset="UTF-8"><title>PHP Runner 필요</title>\n<style>body{font-family:sans-serif;max-width:600px;margin:80px auto;padding:24px;background:#0a0a0a;color:#e5e5e5}\nh1{color:#f87171}pre{background:#1c1c1c;padding:16px;border-radius:8px;font-size:13px;color:#86efac;overflow:auto}</style></head>\n<body>\n<h1>⚙️ PHP Runner 설정 필요</h1>\n<p>진짜 WordPress 실행을 위해 <code>cloudpress-php</code> Worker가 필요합니다.</p>\n<pre># 1단계: cloudpress-php Worker 배포 (php-wasm)\nwrangler deploy --config wrangler-php.toml\n\n# 2단계: 이 Worker 재배포\nwrangler deploy</pre>\n<p style="margin-top:16px;color:#94a3b8;">cloudpress-php가 배포된 후 이 사이트 Worker에\n<code>PHP_RUNNER</code> Service Binding이 연결됩니다.</p>\n</body></html>`, {\n      status: 503,\n      headers: { "Content-Type": "text/html;charset=utf-8" },\n    });\n  }\n\n  const url    = new URL(request.url);\n  const method = request.method.toUpperCase();\n  const token  = getGhToken(env);\n  const owner  = getGhOwner(env);\n  const repo   = getGhRepo(env);\n  const siteId = getSiteId(env);\n\n  // wp-config.php를 GitHub 레포에서 읽기 (캐시 우회 — 변경 즉시 반영)\n  let wpConfigContent = null;\n  try {\n    const cfgRes = await fetchFromGitHub(env, "wp-config.php", true);\n    if (cfgRes) wpConfigContent = await cfgRes.text();\n  } catch {}\n\n  // 요청 body\n  let stdin = "";\n  if (["POST", "PUT", "PATCH"].includes(method)) {\n    try { stdin = await request.text(); } catch {}\n  }\n\n  // PHP 환경변수\n  const phpEnv = {\n    REQUEST_METHOD:       method,\n    REQUEST_URI:          url.pathname + url.search,\n    QUERY_STRING:         url.search.slice(1),\n    HTTP_HOST:            url.hostname,\n    SERVER_NAME:          url.hostname,\n    SERVER_PORT:          url.port || (url.protocol === "https:" ? "443" : "80"),\n    HTTPS:                url.protocol === "https:" ? "on" : "off",\n    SCRIPT_FILENAME:      `/var/www/wordpress${phpFile}`,\n    SCRIPT_NAME:          phpFile,\n    PHP_SELF:             phpFile,\n    DOCUMENT_ROOT:        "/var/www/wordpress",\n    GATEWAY_INTERFACE:    "CGI/1.1",\n    SERVER_PROTOCOL:      "HTTP/1.1",\n    SERVER_SOFTWARE:      "CloudPress/1.0",\n    HTTP_COOKIE:          request.headers.get("Cookie")           || "",\n    HTTP_USER_AGENT:      request.headers.get("User-Agent")       || "",\n    HTTP_ACCEPT:          request.headers.get("Accept")           || "*/*",\n    HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language")  || "ko-KR,ko;q=0.9",\n    HTTP_ACCEPT_ENCODING: request.headers.get("Accept-Encoding")  || "gzip",\n    HTTP_REFERER:         request.headers.get("Referer")          || "",\n    HTTP_X_FORWARDED_FOR: request.headers.get("CF-Connecting-IP") || "127.0.0.1",\n    REMOTE_ADDR:          request.headers.get("CF-Connecting-IP") || "127.0.0.1",\n    CONTENT_TYPE:         request.headers.get("Content-Type")     || "",\n    CONTENT_LENGTH:       request.headers.get("Content-Length")   || String(stdin.length),\n    // CloudPress 사이트 정보\n    CP_SITE_ID:  siteId,\n    CP_DB_NAME:  env.CP_DB_NAME  || "",\n    CP_DB_USER:  env.CP_DB_USER  || "",\n    CP_DB_PASS:  env.DB_PASS     || "",\n    CP_DB_HOST:  "localhost",\n  };\n\n  // cloudpress-php에 전달할 payload\n  const payload = {\n    phpFile,\n    phpEnv,\n    stdin,\n    siteConfig: {\n      siteId,\n      githubOwner:    owner,\n      githubRepo:     repo,\n      githubBranch:   GH_BRANCH,\n      wpConfigContent,\n      dbName:  env.CP_DB_NAME  || "",\n      dbUser:  env.CP_DB_USER  || "",\n      dbPass:  env.DB_PASS     || "",\n      dbHost:  "localhost",\n    },\n    // 로그인 상태이거나 POST이면 캐시 스킵\n    skipCache: method !== "GET" || (phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in"),\n  };\n\n  // PHP_RUNNER(cloudpress-php) Service Binding으로 WordPress 실행\n  const phpReq = new Request("https://cloudpress-php/run-wordpress", {\n    method: "POST",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify(payload),\n  });\n\n  const phpRes = await env.PHP_RUNNER.fetch(phpReq);\n\n  // PHP 출력 캐싱 (GET + 비로그인 + HTML만)\n  const isCacheable =\n    method === "GET" &&\n    !SKIP_CACHE_PATHS.some(p => url.pathname.startsWith(p)) &&\n    !(phpEnv.HTTP_COOKIE || "").includes("wordpress_logged_in");\n\n  if (isCacheable && phpRes.ok) {\n    const ct = phpRes.headers.get("Content-Type") || "";\n    if (ct.includes("text/html")) {\n      const html = await phpRes.text();\n      // 관리자바가 없는 공개 페이지만 캐시\n      if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {\n        const cacheKey = `php:${siteId}:${url.pathname}${url.search}`;\n        ctx.waitUntil(kvSet(env, cacheKey, html, 3600));\n      }\n      return new Response(html, {\n        status: phpRes.status,\n        headers: {\n          ...Object.fromEntries(phpRes.headers),\n          ...SECURITY_HEADERS,\n          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",\n        },\n      });\n    }\n  }\n\n  // 헤더에 보안 헤더 추가\n  const resHeaders = new Headers(phpRes.headers);\n  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {\n    resHeaders.set(k, v);\n  }\n\n  return new Response(phpRes.body, {\n    status: phpRes.status,\n    headers: resHeaders,\n  });\n}\n\n// ─── 메인 fetch 핸들러 ───────────────────────────────────────────────────────\nexport default {\n  async fetch(request, env, ctx) {\n    const url    = new URL(request.url);\n    const path   = url.pathname;\n    const method = request.method.toUpperCase();\n\n    // ── CORS 프리플라이트 ─────────────────────────────────────────────────\n    if (method === "OPTIONS") {\n      return new Response(null, { status: 204, headers: CORS_HEADERS });\n    }\n\n    // ── 유지보수 모드 체크 (설정 변경 중 접속 차단) ───────────────────────\n    // /wp-admin/, /wp-json/cloudpress/ 는 예외 (관리자 접근 허용)\n    if (await isMaintenanceMode(env)) {\n      if (!path.startsWith("/wp-admin/") && !path.startsWith("/wp-json/cloudpress/")) {\n        return maintenancePage();\n      }\n    }\n\n    // ── KV PHP 캐시 조회 (GET + 비로그인) ────────────────────────────────\n    const isCacheable =\n      method === "GET" &&\n      !SKIP_CACHE_PATHS.some(p => path.startsWith(p)) &&\n      !(request.headers.get("Cookie") || "").includes("wordpress_logged_in") &&\n      !STATIC_EXT.test(path);\n\n    if (isCacheable) {\n      const cached = await kvGet(env, `php:${getSiteId(env)}:${path}${url.search}`);\n      if (cached) {\n        return new Response(cached, {\n          headers: {\n            "Content-Type":  "text/html;charset=utf-8",\n            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",\n            "X-Cache":       "HIT",\n            ...SECURITY_HEADERS,\n          },\n        });\n      }\n    }\n\n    // ── 정적 자산 서빙 ────────────────────────────────────────────────────\n    if (STATIC_EXT.test(path)) {\n      const filePath = path.replace(/^\\//, "");\n\n      // 1. 사용자 wp-content (GitHub 레포에서)\n      if (path.startsWith("/wp-content/")) {\n        // KV 캐시 먼저\n        const cacheKey = `static:${filePath}`;\n        const cached = await kvGet(env, cacheKey);\n        if (cached) {\n          return new Response(cached, {\n            headers: {\n              "Content-Type":  mime(filePath),\n              "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",\n              "X-Cache":       "HIT",\n            },\n          });\n        }\n        const ghRes = await fetchFromGitHub(env, filePath);\n        if (ghRes) {\n          const body = await ghRes.arrayBuffer();\n          ctx.waitUntil(\n            env.CACHE?.put(cacheKey, body, { expirationTtl: 3600 }).catch(() => {})\n          );\n          return new Response(body, {\n            headers: {\n              "Content-Type":  mime(filePath),\n              "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",\n              "X-Source":      "github-user-repo",\n            },\n          });\n        }\n      }\n\n      // 2. WordPress 코어 자산 (wp-includes/, wp-admin/ 정적 파일)\n      if (path.startsWith("/wp-includes/") || path.startsWith("/wp-admin/")) {\n        const coreRes = await fetchWpCore(filePath);\n        if (coreRes) {\n          const body = await coreRes.arrayBuffer();\n          return new Response(body, {\n            headers: {\n              "Content-Type":  mime(filePath),\n              "Cache-Control": "public, max-age=86400, immutable",\n              "X-Source":      "wp-core-cdn",\n            },\n          });\n        }\n      }\n\n      return new Response("Not Found", { status: 404 });\n    }\n\n    // ── PHP 파일 경로 결정 ────────────────────────────────────────────────\n    let phpFile = "/index.php";\n\n    if (path === "/wp-login.php") {\n      phpFile = "/wp-login.php";\n    } else if (path.startsWith("/wp-admin/")) {\n      phpFile = path.endsWith(".php")\n        ? path\n        : "/wp-admin/index.php";\n    } else if (path.endsWith(".php")) {\n      phpFile = path;\n    } else {\n      // 퍼머링크 — index.php가 REQUEST_URI를 보고 라우팅\n      phpFile = "/index.php";\n    }\n\n    // ── WordPress 실행 (PHP_RUNNER → cloudpress-php → php-wasm) ──────────\n    return runWordPress(request, env, ctx, phpFile);\n  },\n};\n';
  return baseSrc
    .replace(/%%SITE_ID%%/g,   siteId       || "")
    .replace(/%%GH_OWNER%%/g,  githubOwner  || "")
    .replace(/%%GH_REPO%%/g,   githubRepo   || "");
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

  // siteUrl을 함수 스코프에 미리 정의 (GitHub 블록 밖에서도 참조 가능)
  const siteUrl = initialDomain
    ? `https://${initialDomain}`
    : cfAccountId
      ? `https://${workerName}.${shortId}.workers.dev`
      : `https://${repoName}.workers.dev`;

  if (ghToken && owner) {
    await log("▶ GitHub 레포 생성 중...");
    const created = await createGitHubRepo({ ghToken, owner, repoName, log });

    if (created) {
      await log("▶ WordPress 파일 GitHub 레포에 push 중...");

      // wp-config.php 생성 (자동 생성 자격증명 사용)

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
      }
    }
  }

  // ── 5-1. D1 스키마 초기화 (Worker 배포 여부와 무관하게 실행) ──────────────
  if (cfToken && cfAccountId && d1Id) {
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
    // PHP_RUNNER: cloudpress-php Worker (플랫폼 공유 php-wasm 실행기)
    // cloudpress-php Worker가 먼저 배포되어 있어야 작동합니다.
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
  // ghToken은 deployWorker 파라미터로 이미 전달됨 (별도 조회 불필요)
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

  // undefined 값 방어 — SQL 문자열에 'undefined'가 삽입되는 것을 방지
  const safeAdminUser  = adminUser  || "admin";
  const safeAdminPass  = adminPass  || randomPass(16);
  const safeAdminEmail = adminEmail || "admin@example.com";
  const safeSiteName   = siteName   || "CloudPress Site";
  const safeSiteUrl    = siteUrl    || "https://example.com";
  const safeDbPrefix   = dbPrefix   || "wp_";

  const passHash = phpassCreate(safeAdminPass);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // WordPress 필수 테이블 생성 SQL
  const schemaSqls = buildWordPressD1SchemaSqls({ dbPrefix: safeDbPrefix });
  const initSqls   = buildWordPressInitSqls({ dbPrefix: safeDbPrefix, adminUser: safeAdminUser, passHash, adminEmail: safeAdminEmail, siteName: safeSiteName, siteUrl: safeSiteUrl, now });

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
  // undefined 값이 SQL에 삽입되지 않도록 방어
  const p            = dbPrefix   || "wp_";
  adminUser  = adminUser  || "admin";
  passHash   = passHash   || "";
  adminEmail = adminEmail || "admin@example.com";
  siteName   = siteName   || "CloudPress Site";
  siteUrl    = siteUrl    || "https://example.com";
  now        = now        || new Date().toISOString().replace("T", " ").slice(0, 19);
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
# 이 Worker는 GitHub 레포의 WordPress 파일을 cloudpress-php(php-wasm)로 실행합니다.
name              = "${workerName}"
main              = "worker.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 50000

${d1Id ? `[[d1_databases]]
binding       = "DB"
database_name = "${d1DbName}"
database_id   = "${d1Id}"` : `# D1: Cloudflare 대시보드에서 바인딩 설정 필요`}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 설정 필요`}

# PHP Runner: cloudpress-php Worker (php-wasm으로 진짜 WordPress PHP 실행)
# 이 바인딩이 작동하려면 cloudpress-php Worker가 먼저 배포되어 있어야 합니다.
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
