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

// ─── GitHub Repository Variable 설정 (암호화 불필요, Actions vars.*로 접근) ──
async function setGhVariable(ghToken, owner, repo, name, value) {
  // 존재 여부 확인 후 PUT(update) or POST(create)
  const checkRes = await ghReq("GET", `/repos/${owner}/${repo}/actions/variables/${name}`, ghToken);
  const method = (checkRes.status === 200) ? "PATCH" : "POST";
  return ghReq(method, `/repos/${owner}/${repo}/actions/variables${method === "POST" ? "" : "/" + name}`, ghToken, {
    name,
    value: String(value),
  });
}

// ─── GitHub Repository Secret 설정 (libsodium seal 암호화) ──────────────────
async function setGhSecret(ghToken, owner, repo, name, value) {
  // 1. 레포 public key 가져오기
  const pkRes = await ghReq("GET", `/repos/${owner}/${repo}/actions/secrets/public-key`, ghToken);
  if (!pkRes.ok) return pkRes;
  const { key_id, key: b64Key } = pkRes.data;

  // 2. libsodium seal (X25519 + XSalsa20-Poly1305) — Web Crypto로 구현
  const recipientPub = Uint8Array.from(atob(b64Key), c => c.charCodeAt(0));
  const msg          = new TextEncoder().encode(value);

  // Ephemeral X25519 키쌍 생성
  const ephKP = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", ephKP.publicKey));

  // 수신자 공개키를 raw X25519 CryptoKey로 import
  const recipKey = await crypto.subtle.importKey("raw", recipientPub, { name: "X25519" }, false, []);

  // ECDH → 공유 비밀
  const sharedBits = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: recipKey }, ephKP.privateKey, 256));

  // HSalsa20 대신 HKDF로 키 유도 (Web Crypto 지원)
  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const aesKey  = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("github-secret") },
    hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
  );

  // AES-GCM 암호화 (nonce = 0, GitHub은 NaCl seal 기대하지만 Secrets API는 base64 encrypted_value만 요구)
  // 참고: GitHub Secrets API는 실제로 NaCl secretbox가 아닌 libsodium sealed_box를 요구.
  // Cloudflare Workers에서 NaCl 없이 완전 구현이 어려우므로,
  // CF 토큰은 GitHub Variable(비암호화)로, GH_TOKEN만 wrangler secret으로 처리.
  // 이 함수는 향후 확장용으로 남겨둠.
  return { ok: false, _note: "NaCl seal not available in Workers — use setGhVariable instead" };
}

// ─── GitHub Tree API 배치 push ───────────────────────────────────────────────
async function ghBatchPush(token, owner, repo, files, commitMsg) {
  // auto_init 직후 main branch가 준비될 때까지 최대 5회 재시도
  let refRes;
  for (let attempt = 0; attempt < 5; attempt++) {
    refRes = await ghReq("GET", `/repos/${owner}/${repo}/git/refs/heads/main`, token);
    if (refRes.ok && refRes.data?.object?.sha) break;
    await delay(3000);
  }
  if (!refRes || !refRes.ok || !refRes.data?.object?.sha) return false;

  const baseSha    = refRes.data.object.sha;
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

// ─── Cloudflare 계정 Workers 서브도메인 조회 ─────────────────────────────────
// 실제 Worker URL: {workerName}.{accountSubdomain}.workers.dev
async function getAccountWorkerSubdomain(cfToken, cfAccountId, cfEmail) {
  const res = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/workers/subdomain`, null, cfEmail);
  return res.data?.result?.subdomain || null;
}

// ─── KV 네임스페이스 생성 ────────────────────────────────────────────────────
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
  await log(`  ✅ KV 생성 완료: ${id}`);
  return id;
}

// ─── GitHub 레포 생성 ────────────────────────────────────────────────────────
async function createGitHubRepo({ ghToken, owner, repoName, log }) {
  await log(`  GitHub 레포 생성: ${owner}/${repoName}`);
  const res = await ghReq("POST", "/user/repos", ghToken, {
    name: repoName,
    private: false,
    description: `CloudPress WordPress 사이트 — ${repoName}`,
    auto_init: true,
  });
  if (!res.ok && res.status !== 422) {
    await log(`  레포 생성 실패: ${JSON.stringify(res.data?.errors)}`, "error");
    return false;
  }
  if (res.status === 422) { await log(`  레포 기존 사용: ${owner}/${repoName}`); }
  else { await log(`  ✅ 레포 생성 완료: ${owner}/${repoName}`); }
  await delay(2000);
  return true;
}

// ─── wp-config.php (SQLite .db 파일용) ───────────────────────────────────────
function buildWpConfig({
  siteId, siteUrl, dbPrefix,
  authKey, secureAuthKey, loggedInKey, nonceKey,
  authSalt, secureAuthSalt, loggedInSalt, nonceSalt,
}) {
  return `<?php
/**
 * CloudPress WordPress 설정 (자동 생성)
 * DB: GitHub 레포 내 _db/wordpress.db (SQLite)
 */

// ── SQLite 연동 (sqlite-database-integration 플러그인) ──
define( 'DB_NAME',     'wordpress' );
define( 'DB_USER',     'root' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST',     'localhost' );
define( 'DB_CHARSET',  'utf8mb4' );
define( 'DB_COLLATE',  '' );
define( 'table_prefix', '${dbPrefix}' );

// SQLite 플러그인 설정
define( 'SQLITE_DB_DIR',  __DIR__ . '/_db/' );
define( 'SQLITE_DB_FILE', 'wordpress.db' );

// ── 인증 키/솔트 ──
define( 'AUTH_KEY',         '${authKey}' );
define( 'SECURE_AUTH_KEY',  '${secureAuthKey}' );
define( 'LOGGED_IN_KEY',    '${loggedInKey}' );
define( 'NONCE_KEY',        '${nonceKey}' );
define( 'AUTH_SALT',        '${authSalt}' );
define( 'SECURE_AUTH_SALT', '${secureAuthSalt}' );
define( 'LOGGED_IN_SALT',   '${loggedInSalt}' );
define( 'NONCE_SALT',       '${nonceSalt}' );

// ── URL 설정 ──
define( 'WP_HOME',    '${siteUrl}' );
define( 'WP_SITEURL', '${siteUrl}' );

// ── 기타 ──
define( 'WP_DEBUG',        false );
define( 'WP_CACHE',        true  );
define( 'WP_AUTO_UPDATE_CORE', false );
define( 'DISALLOW_FILE_EDIT',  false );

if ( ! defined( 'ABSPATH' ) ) {
  define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;
}

// ─── 미러링 Worker 소스 ──────────────────────────────────────────────────────
// 역할: GitHub 레포 파일 미러링 + PHP_RUNNER로 WordPress 실행
// 고정 화면 없음 - PHP_RUNNER 없으면 _cache/ 서빙, 그것도 없으면 404
// ⚠️  이 함수는 배열+join으로 Worker 소스를 생성합니다.
//     템플릿 리터럴을 중첩하면 \\ 이스케이프가 손실되어
//     정규식(/^\\//)이 /^//로 깨지고 CF Worker 배포 SyntaxError가 발생합니다.
function buildWorkerSource({ siteId, githubOwner, githubRepo, ghPagesUrl }) {
  const _ghPagesUrl = ghPagesUrl || "";

  // Worker 소스를 배열+join으로 생성 (중첩 템플릿 리터럴 이스케이프 문제 완전 방지)
  const lines = [
    "/**",
    " * CloudPress 미러링 Worker v10",
    " * GitHub: " + githubOwner + "/" + githubRepo,
    " *",
    " * 요청 처리 순서:",
    " *   1. 정적 파일(.css/.js/이미지) → GitHub 레포 raw / WordPress CDN",
    " *   2. KV HTML 캐시 (비로그인 GET)",
    " *   3. PHP_RUNNER Service Binding → php-wasm WordPress 실행  ← 핵심",
    " *   4. _cache/ 정적 HTML → GitHub 레포 (PHP_RUNNER 없을 때 폴백)",
    " *   5. GitHub Pages 폴백",
    " *   6. 없으면 404 (고정 화면 절대 없음)",
    " */",
    "",
    "const SITE_ID      = " + JSON.stringify(siteId) + ";",
    "const GH_OWNER     = " + JSON.stringify(githubOwner) + ";",
    "const GH_REPO      = " + JSON.stringify(githubRepo) + ";",
    "const GH_BRANCH    = \"main\";",
    "const GH_PAGES_URL = " + JSON.stringify(_ghPagesUrl) + ";",
    "",
    "const STATIC_EXT = /\\.(css|js|mjs|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm|gz|br)$/i;",
    "const SKIP_CACHE = [\"/wp-admin\", \"/wp-login.php\", \"/cart\", \"/checkout\", \"/my-account\", \"/wp-cron.php\", \"/xmlrpc.php\"];",
    "const SEC        = { \"X-Content-Type-Options\": \"nosniff\", \"X-Frame-Options\": \"SAMEORIGIN\", \"Referrer-Policy\": \"strict-origin-when-cross-origin\" };",
    "",
    "const ghOwner = (e) => e.GH_OWNER  || GH_OWNER;",
    "const ghRepo  = (e) => e.GH_REPO   || GH_REPO;",
    "const ghToken = (e) => e.GITHUB_TOKEN || \"\";",
    "const ghPages = (e) => e.GH_PAGES_URL || GH_PAGES_URL || \"\";",
    "const getSiteId = (e) => e.SITE_ID || SITE_ID;",
    "",
    "const kvGet    = async (e,k) => { try { return await e.CACHE?.get(k); }               catch { return null; } };",
    "const kvGetBuf = async (e,k) => { try { return await e.CACHE?.get(k,\"arrayBuffer\"); } catch { return null; } };",
    "const kvPut    = async (e,k,v,t=3600) => { try { await e.CACHE?.put(k,v,{expirationTtl:t}); } catch {} };",
    "",
    "function mime(p) {",
    "  const ext = (p.split(\".\").pop() || \"\").toLowerCase();",
    "  return ({",
    "    css:\"text/css\", js:\"application/javascript\", mjs:\"application/javascript\",",
    "    json:\"application/json\", html:\"text/html;charset=utf-8\", xml:\"application/xml\",",
    "    svg:\"image/svg+xml\", png:\"image/png\", jpg:\"image/jpeg\", jpeg:\"image/jpeg\",",
    "    gif:\"image/gif\", webp:\"image/webp\", avif:\"image/avif\", ico:\"image/x-icon\",",
    "    woff:\"font/woff\", woff2:\"font/woff2\", ttf:\"font/ttf\", otf:\"font/otf\",",
    "    eot:\"application/vnd.ms-fontobject\", pdf:\"application/pdf\",",
    "    mp4:\"video/mp4\", mp3:\"audio/mpeg\", txt:\"text/plain\",",
    "  })[ext] || \"application/octet-stream\";",
    "}",
    "",
    "// GitHub 레포 raw 파일 fetch",
    "async function ghRaw(env, filePath) {",
    "  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);",
    "  if (!o || !r) return null;",
    "  try {",
    "    const res = await fetch(",
    "      `https://raw.githubusercontent.com/${o}/${r}/${GH_BRANCH}/${filePath}`,",
    "      { headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), \"User-Agent\": \"CloudPress/10\" },",
    "        cf: { cacheEverything: true, cacheTtl: 300 } }",
    "    );",
    "    return res.ok ? res : null;",
    "  } catch { return null; }",
    "}",
    "",
    "// WordPress 코어 파일 CDN fetch",
    "async function wpCdn(filePath) {",
    "  for (const base of [",
    "    \"https://cdn.jsdelivr.net/gh/WordPress/WordPress@master/\",",
    "    \"https://raw.githubusercontent.com/WordPress/WordPress/master/\",",
    "  ]) {",
    "    try {",
    "      const r = await fetch(base + filePath, { cf: { cacheEverything: true, cacheTtl: 86400 } });",
    "      if (r.ok) return r;",
    "    } catch {}",
    "  }",
    "  return null;",
    "}",
    "",
    "// PHP_RUNNER Service Binding으로 WordPress PHP 실행",
    "async function runPhp(req, env, ctx) {",
    "  if (!env.PHP_RUNNER) return null;",
    "  const url    = new URL(req.url);",
    "  const method = req.method.toUpperCase();",
    "  const sid    = getSiteId(env);",
    "  const noCache = SKIP_CACHE.some(p => url.pathname.startsWith(p))",
    "    || (req.headers.get(\"Cookie\") || \"\").includes(\"wordpress_logged_in\");",
    "  const body = (method === \"POST\" || method === \"PUT\" || method === \"PATCH\")",
    "    ? await req.text().catch(() => \"\") : \"\";",
    "  try {",
    "    const res = await env.PHP_RUNNER.fetch(new Request(\"https://php-runner/run-wordpress\", {",
    "      method: \"POST\",",
    "      headers: { \"Content-Type\": \"application/json\" },",
    "      body: JSON.stringify({",
    "        phpFile: url.pathname === \"/\" ? \"/index.php\" : url.pathname,",
    "        phpEnv: {",
    "          REQUEST_METHOD:       method,",
    "          REQUEST_URI:          url.pathname + url.search,",
    "          QUERY_STRING:         url.search.slice(1),",
    "          HTTP_HOST:            url.hostname,",
    "          SERVER_NAME:          url.hostname,",
    "          SERVER_PORT:          \"443\",",
    "          HTTPS:                \"on\",",
    "          DOCUMENT_ROOT:        \"/var/www/wordpress\",",
    "          SCRIPT_FILENAME:      `/var/www/wordpress${url.pathname === \"/\" ? \"/index.php\" : url.pathname}`,",
    "          SCRIPT_NAME:          url.pathname === \"/\" ? \"/index.php\" : url.pathname,",
    "          PHP_SELF:             url.pathname === \"/\" ? \"/index.php\" : url.pathname,",
    "          GATEWAY_INTERFACE:    \"CGI/1.1\",",
    "          SERVER_PROTOCOL:      \"HTTP/1.1\",",
    "          HTTP_USER_AGENT:      req.headers.get(\"User-Agent\") || \"\",",
    "          HTTP_ACCEPT:          req.headers.get(\"Accept\") || \"\",",
    "          HTTP_ACCEPT_LANGUAGE: req.headers.get(\"Accept-Language\") || \"\",",
    "          HTTP_COOKIE:          req.headers.get(\"Cookie\") || \"\",",
    "          HTTP_REFERER:         req.headers.get(\"Referer\") || \"\",",
    "          CONTENT_TYPE:         req.headers.get(\"Content-Type\") || \"\",",
    "          CONTENT_LENGTH:       req.headers.get(\"Content-Length\") || \"\",",
    "          HTTP_AUTHORIZATION:   req.headers.get(\"Authorization\") || \"\",",
    "          HTTP_X_FORWARDED_FOR: req.headers.get(\"CF-Connecting-IP\") || \"\",",
    "          WP_HOME:              `https://${url.hostname}`,",
    "          WP_SITEURL:           `https://${url.hostname}`,",
    "        },",
    "        stdin: body,",
    "        siteConfig: { siteId: sid, githubOwner: ghOwner(env), githubRepo: ghRepo(env), githubToken: ghToken(env) },",
    "        skipCache: noCache,",
    "      }),",
    "    }));",
    "    if (!res.ok && res.status >= 500) return null;",
    "    if (!noCache && method === \"GET\" && res.ok && res.headers.get(\"Content-Type\")?.includes(\"text/html\")) {",
    "      const html = await res.clone().text();",
    "      ctx.waitUntil(kvPut(env, `php:${sid}:${url.pathname}${url.search}`, html, 3600));",
    "    }",
    "    return res;",
    "  } catch { return null; }",
    "}",
    "",
    "export default {",
    "  async fetch(req, env, ctx) {",
    "    const url    = new URL(req.url);",
    "    const path   = url.pathname;",
    "    const method = req.method.toUpperCase();",
    "    const sid    = getSiteId(env);",
    "",
    "    // CORS",
    "    if (method === \"OPTIONS\") return new Response(null, { status: 204, headers: {",
    "      \"Access-Control-Allow-Origin\": \"*\",",
    "      \"Access-Control-Allow-Methods\": \"GET,POST,PUT,DELETE,PATCH,OPTIONS\",",
    "      \"Access-Control-Allow-Headers\": \"Content-Type,Authorization,X-WP-Nonce\",",
    "    }});",
    "",
    "    // 헬스체크",
    "    if (path === \"/_health\") return new Response(",
    "      JSON.stringify({ ok: true, site: sid, php: !!env.PHP_RUNNER, kv: !!env.CACHE }),",
    "      { headers: { \"Content-Type\": \"application/json\" } }",
    "    );",
    "",
    "    // ── 1. 정적 파일 ────────────────────────────────────────────────────────",
    "    if (STATIC_EXT.test(path)) {",
    "      const fp = path.slice(1);",
    "      const ckey = `static:${sid}:${fp}`;",
    "      const cached = await kvGetBuf(env, ckey);",
    "      if (cached) return new Response(cached, { headers: { \"Content-Type\": mime(fp), \"Cache-Control\": \"public,max-age=3600\", \"X-Cache\": \"HIT\", ...SEC }});",
    "      const gr = await ghRaw(env, fp);",
    "      if (gr) {",
    "        const buf = await gr.arrayBuffer();",
    "        ctx.waitUntil(kvPut(env, ckey, buf, path.startsWith(\"/wp-content/\") ? 3600 : 86400));",
    "        return new Response(buf, { headers: {",
    "          \"Content-Type\": mime(fp),",
    "          \"Cache-Control\": path.startsWith(\"/wp-content/\") ? \"public,max-age=3600\" : \"public,max-age=86400,immutable\",",
    "          ...SEC,",
    "        }});",
    "      }",
    "      if (path.startsWith(\"/wp-includes/\") || path.startsWith(\"/wp-admin/\")) {",
    "        const cr = await wpCdn(fp);",
    "        if (cr) {",
    "          const buf = await cr.arrayBuffer();",
    "          ctx.waitUntil(kvPut(env, ckey, buf, 86400));",
    "          return new Response(buf, { headers: { \"Content-Type\": mime(fp), \"Cache-Control\": \"public,max-age=86400,immutable\", ...SEC }});",
    "        }",
    "      }",
    "      return new Response(\"Not Found\", { status: 404 });",
    "    }",
    "",
    "    const isLoggedIn = (req.headers.get(\"Cookie\") || \"\").includes(\"wordpress_logged_in\");",
    "    const cacheable  = method === \"GET\" && !SKIP_CACHE.some(p => path.startsWith(p)) && !isLoggedIn;",
    "",
    "    // ── 2. KV HTML 캐시 ─────────────────────────────────────────────────────",
    "    if (cacheable) {",
    "      const cached = await kvGet(env, `php:${sid}:${path}${url.search}`);",
    "      if (cached) return new Response(cached, { headers: {",
    "        \"Content-Type\": \"text/html;charset=utf-8\",",
    "        \"Cache-Control\": \"public,s-maxage=60,stale-while-revalidate=3600\",",
    "        \"X-Cache\": \"HIT\", ...SEC,",
    "      }});",
    "    }",
    "",
    "    // ── 3. PHP_RUNNER → WordPress 실행 (핵심) ───────────────────────────────",
    "    const phpRes = await runPhp(req, env, ctx);",
    "    if (phpRes) return phpRes;",
    "",
    "    // ── 4. _cache/ 정적 HTML (PHP_RUNNER 없거나 실패 시) ────────────────────",
    "    if (cacheable) {",
    "      const cachePath = (path === \"/\" || path === \"\")",
    "        ? \"_cache/index.html\"",
    "        : `_cache${path.endsWith(\"/\") ? path : path + \"/\"}index.html`;",
    "      const cr = await ghRaw(env, cachePath);",
    "      if (cr) {",
    "        const html = await cr.text();",
    "        ctx.waitUntil(kvPut(env, `php:${sid}:${path}${url.search}`, html, 1800));",
    "        return new Response(html, { headers: {",
    "          \"Content-Type\": \"text/html;charset=utf-8\",",
    "          \"Cache-Control\": \"public,s-maxage=60,stale-while-revalidate=1800\",",
    "          \"X-Fallback\": \"gh-cache\", ...SEC,",
    "        }});",
    "      }",
    "    }",
    "",
    "    // ── 5. GitHub Pages 폴백 ────────────────────────────────────────────────",
    "    const pagesUrl = ghPages(env);",
    "    if (pagesUrl && cacheable) {",
    "      try {",
    "        const r = await fetch(`${pagesUrl}${path}`, {",
    "          cf: { cacheEverything: true, cacheTtl: 300 },",
    "          headers: { \"User-Agent\": \"CloudPress/10\" },",
    "        });",
    "        if (r.ok) {",
    "          const html = await r.text();",
    "          return new Response(html, { headers: {",
    "            \"Content-Type\": \"text/html;charset=utf-8\",",
    "            \"Cache-Control\": \"public,max-age=60\",",
    "            \"X-Fallback\": \"github-pages\", ...SEC,",
    "          }});",
    "        }",
    "      } catch {}",
    "    }",
    "",
    "    // ── 6. KV stale ─────────────────────────────────────────────────────────",
    "    const stale = await kvGet(env, `php:${sid}:${path}${url.search}`);",
    "    if (stale) return new Response(stale, { headers: {",
    "      \"Content-Type\": \"text/html;charset=utf-8\",",
    "      \"Cache-Control\": \"public,max-age=30\",",
    "      \"X-Fallback\": \"kv-stale\", ...SEC,",
    "    }});",
    "",
    "    // ── 7. 404 (고정 화면 없음) ─────────────────────────────────────────────",
    "    return new Response(\"Not Found\", { status: 404, headers: { \"Content-Type\": \"text/plain\", ...SEC }});",
    "  }",
    "};",
  ];

  return lines.join("\n");
}

// ─── wrangler.toml ────────────────────────────────────────────────────────────
function buildWranglerToml({ workerName, kvCacheId, kvCacheName, siteId, ghOwner, ghRepo, ghPagesUrl, workerUrl }) {
  const phpRunnerName = `${workerName}-php`;
  return `# CloudPress WordPress Worker 배포 설정 (자동 생성)
name               = "${workerName}"
main               = "worker.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
# Worker URL: ${workerUrl || `https://${workerName}.<your-subdomain>.workers.dev`}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 바인딩 설정 필요`}

[[services]]
binding = "PHP_RUNNER"
service = "${phpRunnerName}"

[vars]
SITE_ID      = "${siteId}"
GH_OWNER     = "${ghOwner}"
GH_REPO      = "${ghRepo}"
GH_PAGES_URL = "${ghPagesUrl || ""}"
`;
}

// ─── wrangler-php.toml (PHP Runner) ──────────────────────────────────────────
function buildPhpRunnerWranglerToml({ workerName, kvCacheId, siteId, ghOwner, ghRepo }) {
  const phpRunnerName = `${workerName}-php`;
  return `# CloudPress PHP Runner Worker (자동 생성)
name               = "${phpRunnerName}"
main               = "php-runner.js"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : `# KV CACHE: Cloudflare 대시보드에서 바인딩 설정 필요`}

[vars]
SITE_ID  = "${siteId}"
GH_OWNER = "${ghOwner}"
GH_REPO  = "${ghRepo}"
`;
}

// ─── GitHub Actions: WordPress 전체 설치 + SQLite DB 초기화 ─────────────────
// 규칙:
//   - JS 변수(wpAdminUser 등)는 env: 블록으로 주입 → bash에서는 $VAR로 접근
//   - bash 변수 ${VAR}는 JS 템플릿 리터럴 안에서 \${VAR}로 이스케이프
//   - sqlite3는 heredoc 대신 개별 명령 사용 (heredoc+이스케이프 충돌 방지)
//   - Python으로 phpass 해시 생성 (MD5 대신)
function buildWpInstallAction({ wpAdminUser, wpAdminPass, wpAdminEmail, siteUrl, siteName, dbPrefix }) {
  const p = dbPrefix || "wp_";
  return `name: 🚀 WordPress 설치 + SQLite DB 초기화

on:
  workflow_dispatch:
    inputs:
      force_reinstall:
        description: '강제 재설치'
        type: boolean
        default: false

permissions:
  contents: write

jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: 의존성 설치
        run: |
          sudo apt-get install -y sqlite3 php-cli php-sqlite3
          echo "✅ 의존성 설치 완료"

      - name: WordPress 최신버전 다운로드
        run: |
          wget -q https://wordpress.org/latest.tar.gz -O /tmp/wp.tar.gz
          tar -xzf /tmp/wp.tar.gz -C /tmp/
          WP_VER=\$(grep "wp_version" /tmp/wordpress/wp-includes/version.php | grep -oP "[\\d.]+" | head -1)
          echo "📥 WordPress \${WP_VER} 다운로드 완료"
          rsync -a --exclude='wp-config.php' --exclude='wp-config-sample.php' /tmp/wordpress/ ./
          echo "✅ WordPress 파일 설치: \$(find . -name '*.php' -not -path './.git/*' | wc -l)개 PHP 파일"

      - name: SQLite Database Integration 플러그인 설치
        run: |
          mkdir -p wp-content/plugins wp-content/themes wp-content/uploads _db
          wget -q "https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip" -O /tmp/sqlite.zip
          unzip -q /tmp/sqlite.zip -d wp-content/plugins/
          PLUGIN_DIR="wp-content/plugins/sqlite-database-integration"
          if [ -f "\${PLUGIN_DIR}/db.copy" ]; then
            cp "\${PLUGIN_DIR}/db.copy" wp-content/db.php
            echo "✅ db.php 드롭인 설치 완료 (db.copy)"
          elif [ -f "\${PLUGIN_DIR}/db.php" ]; then
            cp "\${PLUGIN_DIR}/db.php" wp-content/db.php
            echo "✅ db.php 드롭인 설치 완료 (db.php)"
          else
            echo "❌ db.php 없음"; ls "\${PLUGIN_DIR}/"; exit 1
          fi

      - name: Twenty Twenty-Four 테마 설치
        run: |
          if [ ! -d "wp-content/themes/twentytwentyfour" ]; then
            wget -q "https://downloads.wordpress.org/theme/twentytwentyfour.latest-stable.zip" -O /tmp/theme.zip
            unzip -q /tmp/theme.zip -d wp-content/themes/
            echo "✅ 테마 설치 완료"
          else
            echo "✅ 테마 이미 존재"
          fi

      - name: SQLite DB 초기화
        env:
          ADMIN_USER: ${wpAdminUser}
          ADMIN_PASS: ${wpAdminPass}
          ADMIN_EMAIL: ${wpAdminEmail}
          SITE_URL: ${siteUrl}
          SITE_NAME: ${siteName}
          DB_PREFIX: ${p}
        run: |
          NOW=\$(date -u +"%Y-%m-%d %H:%M:%S")
          PFX="\$DB_PREFIX"
          DB="_db/wordpress.db"

          echo "🗄️ SQLite DB 테이블 생성 중..."
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT NOT NULL DEFAULT '' UNIQUE, option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes');"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}users (ID INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT NOT NULL DEFAULT '', user_pass TEXT NOT NULL DEFAULT '', user_nicename TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL DEFAULT '', user_url TEXT NOT NULL DEFAULT '', user_registered TEXT NOT NULL DEFAULT '', user_activation_key TEXT NOT NULL DEFAULT '', user_status INTEGER NOT NULL DEFAULT 0, display_name TEXT NOT NULL DEFAULT '');"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}usermeta (umeta_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_author INTEGER NOT NULL DEFAULT 0, post_date TEXT NOT NULL DEFAULT '', post_date_gmt TEXT NOT NULL DEFAULT '', post_content TEXT NOT NULL DEFAULT '', post_title TEXT NOT NULL DEFAULT '', post_excerpt TEXT NOT NULL DEFAULT '', post_status TEXT NOT NULL DEFAULT 'publish', comment_status TEXT NOT NULL DEFAULT 'open', ping_status TEXT NOT NULL DEFAULT 'open', post_password TEXT NOT NULL DEFAULT '', post_name TEXT NOT NULL DEFAULT '', to_ping TEXT NOT NULL DEFAULT '', pinged TEXT NOT NULL DEFAULT '', post_modified TEXT NOT NULL DEFAULT '', post_modified_gmt TEXT NOT NULL DEFAULT '', post_content_filtered TEXT NOT NULL DEFAULT '', post_parent INTEGER NOT NULL DEFAULT 0, guid TEXT NOT NULL DEFAULT '', menu_order INTEGER NOT NULL DEFAULT 0, post_type TEXT NOT NULL DEFAULT 'post', post_mime_type TEXT NOT NULL DEFAULT '', comment_count INTEGER NOT NULL DEFAULT 0);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}postmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}comments (comment_ID INTEGER PRIMARY KEY AUTOINCREMENT, comment_post_ID INTEGER NOT NULL DEFAULT 0, comment_author TEXT NOT NULL DEFAULT '', comment_author_email TEXT NOT NULL DEFAULT '', comment_author_url TEXT NOT NULL DEFAULT '', comment_author_IP TEXT NOT NULL DEFAULT '', comment_date TEXT NOT NULL DEFAULT '', comment_date_gmt TEXT NOT NULL DEFAULT '', comment_content TEXT NOT NULL DEFAULT '', comment_karma INTEGER NOT NULL DEFAULT 0, comment_approved TEXT NOT NULL DEFAULT '1', comment_agent TEXT NOT NULL DEFAULT '', comment_type TEXT NOT NULL DEFAULT 'comment', comment_parent INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL DEFAULT 0);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}commentmeta (meta_id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}terms (term_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '', term_group INTEGER NOT NULL DEFAULT 0);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT, term_id INTEGER NOT NULL DEFAULT 0, taxonomy TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', parent INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0);"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}term_relationships (object_id INTEGER NOT NULL DEFAULT 0, term_taxonomy_id INTEGER NOT NULL DEFAULT 0, term_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (object_id, term_taxonomy_id));"
          sqlite3 "\$DB" "CREATE TABLE IF NOT EXISTS \${PFX}links (link_id INTEGER PRIMARY KEY AUTOINCREMENT, link_url TEXT NOT NULL DEFAULT '', link_name TEXT NOT NULL DEFAULT '', link_image TEXT NOT NULL DEFAULT '', link_target TEXT NOT NULL DEFAULT '', link_description TEXT NOT NULL DEFAULT '', link_visible TEXT NOT NULL DEFAULT 'Y', link_owner INTEGER NOT NULL DEFAULT 1, link_rating INTEGER NOT NULL DEFAULT 0, link_updated TEXT NOT NULL DEFAULT '', link_rel TEXT NOT NULL DEFAULT '', link_notes TEXT NOT NULL DEFAULT '', link_rss TEXT NOT NULL DEFAULT '');"

          echo "📝 기본 옵션 삽입..."
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}options (option_name,option_value,autoload) VALUES ('siteurl','\$SITE_URL','yes'),('home','\$SITE_URL','yes'),('blogname','\$SITE_NAME','yes'),('blogdescription','','yes'),('admin_email','\$ADMIN_EMAIL','yes'),('blogpublic','1','yes'),('blog_charset','UTF-8','yes'),('date_format','Y년 n월 j일','yes'),('time_format','A g:i','yes'),('start_of_week','0','yes'),('timezone_string','Asia/Seoul','yes'),('permalink_structure','/%postname%/','yes'),('template','twentytwentyfour','yes'),('stylesheet','twentytwentyfour','yes'),('current_theme','Twenty Twenty-Four','yes'),('active_plugins','a:1:{i:0;s:51:\"sqlite-database-integration/sqlite-database-integration.php\";}','yes'),('wp_db_version','57155','yes'),('initial_db_version','57155','yes'),('db_version','57155','yes'),('posts_per_page','10','yes'),('default_category','1','yes'),('cp_installed_at','\$NOW','yes');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}terms VALUES (1,'미분류','uncategorized',0);"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}term_taxonomy VALUES (1,1,'category','',0,0);"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}posts (ID,post_author,post_date,post_date_gmt,post_content,post_title,post_excerpt,post_status,post_name,post_modified,post_modified_gmt,post_type,guid,comment_status,ping_status,menu_order,post_parent) VALUES (1,1,'\$NOW','\$NOW','WordPress에 오신 것을 환영합니다!','안녕하세요!','','publish','hello-world','\$NOW','\$NOW','post','\$SITE_URL/?p=1','open','open',0,0);"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}term_relationships VALUES (1,1,0);"
          sqlite3 "\$DB" "UPDATE \${PFX}term_taxonomy SET count=1 WHERE term_taxonomy_id=1;"

          TABLES=\$(sqlite3 "\$DB" "SELECT count(*) FROM sqlite_master WHERE type='table';")
          echo "✅ DB 초기화 완료: \${TABLES}개 테이블 | 크기: \$(du -h \$DB | cut -f1)"

      - name: 관리자 계정 생성 (phpass 해시)
        env:
          ADMIN_USER: ${wpAdminUser}
          ADMIN_PASS: ${wpAdminPass}
          ADMIN_EMAIL: ${wpAdminEmail}
          SITE_URL: ${siteUrl}
          DB_PREFIX: ${p}
        run: |
          NOW=\$(date -u +"%Y-%m-%d %H:%M:%S")
          PFX="\$DB_PREFIX"
          DB="_db/wordpress.db"

          # phpass 해시 생성 (base64 인코딩으로 YAML 특수문자 충돌 완전 방지)
          echo "aW1wb3J0IGhhc2hsaWIsIG9zCnB3ID0gb3MuZW52aXJvbi5nZXQoJ0FETUlOX1BBU1MnLCAnJykKaXRvYTY0ID0gJy4vMDEyMzQ1Njc4OUFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXonCmRlZiBlbmNvZGU2NChoLCBuKToKICAgIG8sIGkgPSAnJywgMAogICAgd2hpbGUgaSA8IG46CiAgICAgICAgdiA9IGhbaV07IGkgKz0gMTsgbyArPSBpdG9hNjRbdiAmIDB4M2ZdCiAgICAgICAgaWYgaSA8IG46IHYgfD0gaFtpXSA8PCA4CiAgICAgICAgbyArPSBpdG9hNjRbKHYgPj4gNikgJiAweDNmXQogICAgICAgIGlmIGkgPj0gbjogYnJlYWsKICAgICAgICBpICs9IDEKICAgICAgICBpZiBpIDwgbjogdiB8PSBoW2ldIDw8IDE2CiAgICAgICAgbyArPSBpdG9hNjRbKHYgPj4gMTIpICYgMHgzZl0KICAgICAgICBpZiBpID49IG46IGJyZWFrCiAgICAgICAgaSArPSAxOyBvICs9IGl0b2E2NFsodiA+PiAxOCkgJiAweDNmXQogICAgcmV0dXJuIG8Kc2FsdCA9ICcnLmpvaW4oW2l0b2E2NFtiICUgNjRdIGZvciBiIGluIG9zLnVyYW5kb20oOCldKQpwZnggPSAnJFAkJyArIGl0b2E2NFs4XSArIHNhbHQKY250ID0gMSA8PCA4CmIgPSBwdy5lbmNvZGUoKQpoID0gaGFzaGxpYi5tZDUoKHNhbHQgKyBwdykuZW5jb2RlKCkpLmRpZ2VzdCgpCmZvciBfIGluIHJhbmdlKGNudCk6IGggPSBoYXNobGliLm1kNShieXRlcyhoKSArIGIpLmRpZ2VzdCgpCnByaW50KHBmeCArIGVuY29kZTY0KGxpc3QoaCksIDE2KSkK" | base64 -d > /tmp/phpass.py
          PASS_HASH=\$(python3 /tmp/phpass.py)
          echo "  phpass 앞 6자리: \${PASS_HASH:0:6}..."
          sqlite3 "\$DB" "INSERT OR REPLACE INTO \${PFX}users (ID,user_login,user_pass,user_nicename,user_email,user_url,user_registered,user_status,display_name) VALUES (1,'\$ADMIN_USER','\$PASS_HASH','\$ADMIN_USER','\$ADMIN_EMAIL','\$SITE_URL','\$NOW',0,'\$ADMIN_USER');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}usermeta (user_id,meta_key,meta_value) VALUES (1,'\${PFX}capabilities','a:1:{s:13:\"administrator\";b:1;}');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}usermeta (user_id,meta_key,meta_value) VALUES (1,'\${PFX}user_level','10');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}usermeta (user_id,meta_key,meta_value) VALUES (1,'admin_color','fresh');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}usermeta (user_id,meta_key,meta_value) VALUES (1,'rich_editing','1');"
          sqlite3 "\$DB" "INSERT OR IGNORE INTO \${PFX}usermeta (user_id,meta_key,meta_value) VALUES (1,'show_admin_bar_front','1');"
          echo "✅ 관리자 계정 생성 완료: \$ADMIN_USER"

      - name: wp-config.php 확인
        run: |
          [ -f wp-config.php ] && echo "✅ wp-config.php 존재" || { echo "❌ wp-config.php 없음"; exit 1; }

      - name: 전체 파일 커밋 & 푸시
        run: |
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.app"
          git add -A
          TOTAL=\$(git diff --staged --name-only | wc -l | tr -d ' ')
          if git diff --staged --quiet; then
            echo "변경사항 없음"
          else
            git commit -m "🚀 WordPress 설치 완료 + SQLite DB 초기화 (\${TOTAL}개 파일)"
            git push
            echo "✅ 커밋 완료: \${TOTAL}개 파일"
          fi
          echo "📊 레포 총 파일: \$(find . -not -path './.git/*' -type f | wc -l)개"
`;
}

// ─── GitHub Actions: Worker 재배포 ───────────────────────────────────────────
function buildWorkerDeployAction({ workerName }) {
  const phpRunnerName = `${workerName}-php`;
  return `name: ☁️ Cloudflare Worker 재배포

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ['worker.js', 'php-runner.js', 'wrangler.toml', 'wrangler-php.toml']

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Node.js 22 설정 (Wrangler 필수)
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Wrangler 설치
        run: npm install -g wrangler@latest

      - name: PHP Runner 배포 (먼저)
        env:
          CLOUDFLARE_API_TOKEN: \${{ vars.CF_API_TOKEN }}
          CLOUDFLARE_API_KEY: \${{ vars.CF_API_KEY }}
          CLOUDFLARE_EMAIL: \${{ vars.CF_EMAIL }}
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CF_ACCOUNT_ID }}
        run: |
          # Global API Key 우선, 없으면 API Token 사용
          if [ -n "\$CLOUDFLARE_API_KEY" ] && [ -n "\$CLOUDFLARE_EMAIL" ]; then
            export CLOUDFLARE_API_TOKEN=""
          fi
          if [ -f "php-runner.js" ]; then
            npx wrangler deploy --config wrangler-php.toml
            echo "✅ PHP Runner 배포 완료: ${phpRunnerName}"
          else
            echo "⚠️ php-runner.js 없음 — PHP Runner 배포 건너뜀"
          fi

      - name: 메인 Worker 배포
        env:
          CLOUDFLARE_API_TOKEN: \${{ vars.CF_API_TOKEN }}
          CLOUDFLARE_API_KEY: \${{ vars.CF_API_KEY }}
          CLOUDFLARE_EMAIL: \${{ vars.CF_EMAIL }}
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CF_ACCOUNT_ID }}
        run: |
          if [ -n "\$CLOUDFLARE_API_KEY" ] && [ -n "\$CLOUDFLARE_EMAIL" ]; then
            export CLOUDFLARE_API_TOKEN=""
          fi
          npx wrangler deploy --config wrangler.toml
          echo "✅ 메인 Worker 배포 완료: ${workerName}"
`;
}

// ─── GitHub Actions: _cache/ 정적 캐시 갱신 (PHP Runner 없을 때 폴백) ────────
function buildGhPagesAction({ siteName }) {
  return `name: 🔄 정적 캐시 갱신 (SEO 폴백)

on:
  workflow_dispatch:
  schedule:
    - cron: '0 */6 * * *'
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
    if: \${{ github.event.workflow_run.conclusion == 'success' || github.event_name != 'workflow_run' }}
    steps:
      - uses: actions/checkout@v4

      - name: PHP + 의존성 설치
        run: |
          sudo apt-get install -y php-cli php-sqlite3 php-mbstring php-xml php-curl sqlite3

      - name: DB 존재 확인
        run: |
          if [ ! -f "_db/wordpress.db" ]; then
            echo "⚠️ _db/wordpress.db 없음 — install-wordpress.yml 먼저 실행 필요"
            exit 0
          fi
          echo "✅ DB: \$(du -h _db/wordpress.db | cut -f1)"

      - name: WordPress 정적 캐시 생성
        env:
          WP_SITEURL: \${{ vars.WP_SITEURL }}
        run: |
          mkdir -p _cache
          SITEURL="\${WP_SITEURL:-http://localhost:8888}"
          php -S localhost:8888 -t . &
          SERVER_PID=\$!
          sleep 5

          curl -sf -L --max-time 30 http://localhost:8888/ -o _cache/index.html 2>/dev/null || echo "⚠️ 메인 페이지 캐시 실패"
          curl -sf -L --max-time 15 http://localhost:8888/sitemap.xml -o /tmp/sitemap.xml 2>/dev/null || true

          if [ -f /tmp/sitemap.xml ]; then
            grep -o '<loc>[^<]*</loc>' /tmp/sitemap.xml | sed 's|<loc>||;s|</loc>||' | head -30 | while read -r loc; do
              REL=\$(echo "\$loc" | sed "s|\$SITEURL||;s|http://localhost:8888||")
              [ -z "\$REL" ] || [ "\$REL" = "/" ] && continue
              mkdir -p "_cache\${REL}"
              curl -sf -L --max-time 20 "http://localhost:8888\${REL}" -o "_cache\${REL}index.html" 2>/dev/null || true
            done
          fi

          kill \$SERVER_PID 2>/dev/null || true
          COUNT=\$(find _cache -name "*.html" 2>/dev/null | wc -l)
          echo "✅ 정적 캐시: \${COUNT}개 페이지"

      - name: 캐시 커밋
        run: |
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.app"
          git add _cache/
          git diff --staged --quiet || git commit -m "🔄 정적 캐시 갱신 [\$(date '+%Y-%m-%d %H:%M')]" && git push || true

      - uses: actions/upload-pages-artifact@v3
        with: { path: _cache }

  deploy-pages:
    needs: build-cache
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "\${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: actions/deploy-pages@v4
        id: deployment
`;
}

// ─── README ──────────────────────────────────────────────────────────────────
function buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl, wpAdminUser }) {
  return `# ${siteName}

CloudPress로 생성된 WordPress 사이트입니다.

## 사이트 정보
- **URL**: ${siteUrl}
- **관리자**: ${siteUrl}/wp-admin/ (ID: \`${wpAdminUser}\`)
- **Worker 이름**: \`${workerName}\`
- **Worker URL**: ${siteUrl}
- **GitHub**: [${owner}/${repoName}](https://github.com/${owner}/${repoName})

## 아키텍처
\`\`\`
요청 → Cloudflare Worker (미러링) → PHP Runner (php-wasm) → WordPress
                ↕                            ↕
           KV 캐시                    GitHub 레포 (_db/wordpress.db)
\`\`\`

## GitHub Actions
| 워크플로우 | 설명 |
|-----------|------|
| install-wordpress.yml | WordPress 설치 + SQLite DB 초기화 |
| deploy-worker.yml | Cloudflare Worker 재배포 |
| gh-pages-fallback.yml | 정적 캐시 갱신 (SEO 폴백) |
`;
}

// ─── Worker 멀티파트 빌더 ─────────────────────────────────────────────────────
function buildWorkerMultipart(metadataObj, files) {
  const enc = new TextEncoder();
  const boundary = "----CFWorkerBoundary" + Math.random().toString(36).slice(2);
  const parts = [];
  const metaStr = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadataObj)}\r\n`;
  parts.push(enc.encode(metaStr));
  for (const { name, content: src } of files) {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: application/javascript+module\r\n\r\n`;
    parts.push(enc.encode(header));
    parts.push(enc.encode(src));
    parts.push(enc.encode("\r\n"));
  }
  parts.push(enc.encode(`--${boundary}--`));
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) { merged.set(p, offset); offset += p.length; }
  return { body: merged, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── Worker Secret 설정 ───────────────────────────────────────────────────────
async function setWorkerSecret(cfToken, cfAccountId, cfEmail, workerName, secretName, secretValue, log) {
  try {
    const headers = {
      "Content-Type": "application/json",
      ...(cfEmail ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken } : { "Authorization": `Bearer ${cfToken}` }),
    };
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/secrets`,
      { method: "PUT", headers, body: JSON.stringify({ name: secretName, text: secretValue, type: "secret_text" }) }
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) { await log(`  🔑 secret [${secretName}] 등록 완료`); }
    else { await log(`  ⚠️ secret [${secretName}] 실패: ${data?.errors?.[0]?.message || res.status}`, "warn"); }
  } catch (e) { await log(`  ⚠️ secret 오류: ${e.message}`, "warn"); }
}

// ─── PHP Runner Worker 배포 ───────────────────────────────────────────────────
async function deployPhpRunnerWorker({ cfToken, cfAccountId, cfEmail, workerName, workerSource, kvCacheId, siteId, ghOwner, ghRepo, log }) {
  const bindings = [
    ...(kvCacheId ? [{ type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId }] : []),
    { type: "plain_text", name: "SITE_ID",  text: siteId },
    { type: "plain_text", name: "GH_OWNER", text: ghOwner || "" },
    { type: "plain_text", name: "GH_REPO",  text: ghRepo  || "" },
  ];
  const metadataObj = { main_module: "php-runner.js", compatibility_date: "2025-04-01", compatibility_flags: ["nodejs_compat"], bindings };
  const { body, contentType } = buildWorkerMultipart(metadataObj, [{ name: "php-runner.js", content: workerSource }]);
  const headers = { "Content-Type": contentType, ...(cfEmail ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken } : { "Authorization": `Bearer ${cfToken}` }) };
  await log(`  PHP Runner 배포 중: ${workerName}`);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`, { method: "PUT", headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/workers/scripts/${workerName}/subdomain`, { enabled: true }, cfEmail).catch(() => {});
    await log(`  ✅ PHP Runner 배포 완료: ${workerName}`);
    return true;
  }
  await log(`  ⚠️ PHP Runner 배포 실패 [${res.status}]: ${JSON.stringify(data?.errors)}`, "warn");
  return false;
}

// ─── 미러링 Worker 배포 (PHP Runner Service Binding 포함) ────────────────────
async function deployMirrorWorker({ cfToken, cfAccountId, cfEmail, workerName, workerSource, kvCacheId, phpRunnerExists, siteId, ghOwner, ghRepo, ghPagesUrl, ghToken, log }) {
  const bindings = [
    ...(kvCacheId ? [{ type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId }] : []),
    { type: "plain_text", name: "SITE_ID",      text: siteId },
    { type: "plain_text", name: "GH_OWNER",     text: ghOwner || "" },
    { type: "plain_text", name: "GH_REPO",      text: ghRepo  || "" },
    { type: "plain_text", name: "GH_PAGES_URL", text: ghPagesUrl || "" },
    // PHP Runner가 실제 배포된 경우에만 Service Binding 추가
    ...(phpRunnerExists ? [{ type: "service", name: "PHP_RUNNER", service: `${workerName}-php` }] : []),
  ];
  const metadataObj = { main_module: "worker.js", compatibility_date: "2025-04-01", compatibility_flags: ["nodejs_compat"], bindings };
  const { body, contentType } = buildWorkerMultipart(metadataObj, [{ name: "worker.js", content: workerSource }]);
  const headers = { "Content-Type": contentType, ...(cfEmail ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken } : { "Authorization": `Bearer ${cfToken}` }) };
  await log(`  미러링 Worker 배포 중: ${workerName} (PHP_RUNNER binding: ${phpRunnerExists ? "✅" : "❌ 없음"})`);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`, { method: "PUT", headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    await log(`  ❌ Worker 배포 실패 [${res.status}]: ${JSON.stringify(data?.errors)}`, "error");
    return null;
  }
  await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/workers/scripts/${workerName}/subdomain`, { enabled: true }, cfEmail).catch(() => {});

  // 실제 계정 서브도메인 조회 → {workerName}.{accountSubdomain}.workers.dev
  const accountSubdomain = await getAccountWorkerSubdomain(cfToken, cfAccountId, cfEmail).catch(() => null);
  const workerDomain = accountSubdomain
    ? `https://${workerName}.${accountSubdomain}.workers.dev`
    : `https://${workerName}.workers.dev`; // fallback (subdomain 조회 실패 시)
  await log(`  ✅ 미러링 Worker 배포 완료: ${workerDomain}`);
  if (ghToken && ghOwner) {
    await setWorkerSecret(cfToken, cfAccountId, cfEmail, workerName, "GITHUB_TOKEN", ghToken, log);
    await setWorkerSecret(cfToken, cfAccountId, cfEmail, `${workerName}-php`, "GITHUB_TOKEN", ghToken, log).catch(() => {});
  }
  return { workerDomain };
}

// ─── 메인 프로비저닝 ──────────────────────────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env, siteId, siteName, plan, planLimits,
  cfToken, cfAccountId, cfEmail,
  initialDomain, userId, isAdmin, log,
}) {
  const shortId     = siteId.replace(/-/g, "").slice(0, 8);
  const safeSlug    = slugify(siteName) || `site-${shortId}`;
  const workerName  = `cp-${shortId}-wp`;
  const kvCacheName = `cp-${shortId}-cache`;
  const repoName    = `cp-${shortId}-${safeSlug}`.slice(0, 100);
  const dbPrefix    = "wp_";

  await log(`━━━ 호스팅 프로비저닝 시작 ━━━`);
  await log(`사이트    : ${siteName} (${siteId})`);
  await log(`Worker    : ${workerName} (미러링 코드)`);
  await log(`DB        : GitHub 레포 _db/wordpress.db (SQLite)`);

  // ── 1. 자격증명 생성 ──────────────────────────────────────────────────────
  const wpAdminUser  = "admin";
  const wpAdminPass  = randomPass(16);
  const wpAdminEmail = `admin@${shortId}.cloudpress.app`;

  const authKey = randomStr(64), secureAuthKey = randomStr(64);
  const loggedInKey = randomStr(64), nonceKey = randomStr(64);
  const authSalt = randomStr(64), secureAuthSalt = randomStr(64);
  const loggedInSalt = randomStr(64), nonceSalt = randomStr(64);

  // ── 2. GitHub 토큰 ────────────────────────────────────────────────────────
  const ghToken = await pickGithubToken(env).catch(() => null);
  let owner = null;
  if (ghToken) {
    try {
      const r = await ghReq("GET", "/user", ghToken);
      if (r.ok) { owner = r.data.login; await log(`GitHub: ${owner}`); }
    } catch {}
  }
  if (!owner) await log("⚠️ GitHub 토큰 없음", "warn");

  // ── 3. KV 생성 (D1 사용 안 함) ───────────────────────────────────────────
  let kvCacheId = null;
  if (cfToken && cfAccountId) {
    await log("▶ [1/4] KV 캐시 생성...");
    kvCacheId = await createKVNamespace({ cfToken, cfAccountId, cfEmail, title: kvCacheName, log });
  }

  // ── 4. php-runner.js 소스 로드 ────────────────────────────────────────────
  await log("▶ [2/4] PHP Runner 소스 로드...");
  let phpRunnerSourceCode = null;
  try {
    if (env?.ASSETS) {
      const r = await env.ASSETS.fetch(new Request("https://platform/php-runner.js")).catch(() => null);
      if (r?.ok) phpRunnerSourceCode = await r.text();
    }
    if (!phpRunnerSourceCode && env?.KV) {
      phpRunnerSourceCode = await env.KV.get("platform:php-runner.js").catch(() => null);
    }
    if (!phpRunnerSourceCode) {
      const r = await fetch("https://cloud-press.co.kr/php-runner.js", { headers: { "User-Agent": "CloudPress/8.0" } }).catch(() => null);
      if (r?.ok) phpRunnerSourceCode = await r.text();
    }
    if (phpRunnerSourceCode) await log(`  ✅ PHP Runner 소스 로드 완료 (${phpRunnerSourceCode.length.toLocaleString()} bytes)`);
    else await log("  ⚠️ PHP Runner 소스 없음 — GitHub Actions deploy-worker.yml로 나중에 배포 가능", "warn");
  } catch (e) { await log(`  ⚠️ PHP Runner 로드 오류: ${e.message}`, "warn"); }

  // ── 5. PHP Runner Worker 배포 ─────────────────────────────────────────────
  let phpRunnerDeployed = false;
  const phpRunnerName   = `${workerName}-php`;

  if (cfToken && cfAccountId && phpRunnerSourceCode) {
    await log("▶ [3/4] PHP Runner Worker 배포...");
    phpRunnerDeployed = await deployPhpRunnerWorker({
      cfToken, cfAccountId, cfEmail,
      workerName: phpRunnerName,
      workerSource: phpRunnerSourceCode,
      kvCacheId, siteId,
      ghOwner: owner || "", ghRepo: repoName,
      log,
    }).catch(async (e) => { await log(`  PHP Runner 배포 실패: ${e.message}`, "warn"); return false; });
  }

  // ── 6. 미러링 Worker 소스 빌드 + 배포 ────────────────────────────────────
  // 실제 계정 서브도메인 미리 조회 (workerName.accountSubdomain.workers.dev 형식)
  let accountSubdomain = null;
  if (cfToken && cfAccountId) {
    accountSubdomain = await getAccountWorkerSubdomain(cfToken, cfAccountId, cfEmail).catch(() => null);
    if (accountSubdomain) await log(`  계정 Workers 서브도메인: ${accountSubdomain}`);
    else await log("  ⚠️ 계정 서브도메인 조회 실패 — workers.dev fallback 사용", "warn");
  }

  const realWorkerUrl = accountSubdomain
    ? `https://${workerName}.${accountSubdomain}.workers.dev`
    : `https://${workerName}.workers.dev`;
  const siteUrl    = initialDomain ? `https://${initialDomain}` : realWorkerUrl;
  const ghPagesUrl = owner ? `https://${owner}.github.io/${repoName}` : "";

  const workerSource = buildWorkerSource({ siteId, githubOwner: owner || "", githubRepo: repoName, ghPagesUrl });

  let workerDomain = null;
  if (cfToken && cfAccountId) {
    await log("▶ [4/4] 미러링 Worker 배포 (PHP Runner Service Binding)...");
    const deployed = await deployMirrorWorker({
      cfToken, cfAccountId, cfEmail,
      workerName, workerSource,
      kvCacheId, phpRunnerExists: phpRunnerDeployed,
      siteId, ghOwner: owner || "", ghRepo: repoName, ghPagesUrl,
      ghToken: ghToken || null,
      log,
    });
    if (deployed) workerDomain = deployed.workerDomain;
  }

  if (!workerDomain) {
    await log("⚠️ Worker 배포 실패 — GitHub 레포는 계속 생성합니다", "warn");
    // Worker 없어도 GitHub 레포는 생성 (나중에 deploy-worker.yml로 배포 가능)
  }

  // ── 7. GitHub 레포 + 파일 push ────────────────────────────────────────────
  let githubRepoUrl = null;
  if (ghToken && owner) {
    await log("▶ GitHub 레포 생성 + 파일 push...");
    const created = await createGitHubRepo({ ghToken, owner, repoName, log });
    if (created) {
      const filesToPush = [
        { path: "wp-config.php", content: buildWpConfig({ siteId, siteUrl, dbPrefix, authKey, secureAuthKey, loggedInKey, nonceKey, authSalt, secureAuthSalt, loggedInSalt, nonceSalt }) },
        { path: "worker.js", content: workerSource },
        { path: "wrangler.toml", content: buildWranglerToml({ workerName, kvCacheId, kvCacheName, siteId, ghOwner: owner, ghRepo: repoName, ghPagesUrl, workerUrl: realWorkerUrl }) },
        { path: "wrangler-php.toml", content: buildPhpRunnerWranglerToml({ workerName, kvCacheId, siteId, ghOwner: owner, ghRepo: repoName }) },
        ...(phpRunnerSourceCode ? [{ path: "php-runner.js", content: phpRunnerSourceCode }] : []),
        { path: "_db/.gitkeep", content: "# wordpress.db SQLite DB가 이 폴더에 생성됩니다.\n" },
        { path: "_cache/.gitkeep", content: "# WordPress 정적 HTML 캐시가 이 폴더에 생성됩니다.\n" },
        { path: "wp-content/uploads/.gitkeep", content: "" },
        { path: "wp-content/themes/.gitkeep",  content: "" },
        { path: "wp-content/plugins/.gitkeep", content: "" },
        {
          path: ".github/workflows/install-wordpress.yml",
          content: buildWpInstallAction({ wpAdminUser, wpAdminPass, wpAdminEmail, siteUrl, siteName, dbPrefix }),
        },
        {
          path: ".github/workflows/deploy-worker.yml",
          content: buildWorkerDeployAction({ workerName }),
        },
        {
          path: ".github/workflows/gh-pages-fallback.yml",
          content: buildGhPagesAction({ siteName }),
        },
        {
          path: "README.md",
          content: buildReadme({ siteName, siteId, owner, repoName, workerName, siteUrl, wpAdminUser }),
        },
      ];

      const pushed = await ghBatchPush(ghToken, owner, repoName, filesToPush, "🚀 CloudPress 초기 설정");
      if (pushed) {
        githubRepoUrl = `https://github.com/${owner}/${repoName}`;
        await log(`✅ GitHub 레포 push 완료: ${githubRepoUrl}`);

        // GitHub Variables 등록
        await Promise.allSettled([
          // CF_API_TOKEN: Wrangler용 API Token (제한적 권한 가능)
          cfToken     ? setGhVariable(ghToken, owner, repoName, "CF_API_TOKEN",  cfToken)     : null,
          // CF_API_KEY + CF_EMAIL: Global API Key 방식 (더 넓은 권한, wrangler deploy 안정적)
          cfToken     ? setGhVariable(ghToken, owner, repoName, "CF_API_KEY",    cfToken)     : null,
          cfEmail     ? setGhVariable(ghToken, owner, repoName, "CF_EMAIL",      cfEmail)     : null,
          cfAccountId ? setGhVariable(ghToken, owner, repoName, "CF_ACCOUNT_ID", cfAccountId) : null,
          ghToken     ? setGhVariable(ghToken, owner, repoName, "GH_TOKEN",      ghToken)     : null,
          siteUrl     ? setGhVariable(ghToken, owner, repoName, "WP_SITEURL",    siteUrl)     : null,
        ]);
        await log("  ✅ GitHub Actions 환경변수 등록 완료");

        // WordPress 설치 Action 트리거
        await delay(3000);
        const triggerRes = await ghReq("POST", `/repos/${owner}/${repoName}/actions/workflows/install-wordpress.yml/dispatches`, ghToken, { ref: "main" }).catch(() => ({ ok: false }));
        if (triggerRes.ok || triggerRes.status === 204) {
          await log("  🚀 WordPress 설치 Action 트리거 완료 (약 3~5분 소요)");
        } else {
          await log("  ⚠️ Action 트리거 실패 — GitHub Actions 탭에서 수동 실행하세요", "warn");
        }

        // GitHub Pages 활성화
        await ghReq("POST", `/repos/${owner}/${repoName}/pages`, ghToken, { build_type: "workflow" }).catch(() => {});
      } else {
        await log("⚠️ GitHub push 실패", "warn");
      }
    }
  }

  // ── 8. 성공 판단: Worker OR GitHub 레포 중 하나라도 있으면 부분 성공 ────
  // WordPress 설치는 GitHub Actions가 비동기로 완료함
  // Worker 없어도 GitHub Actions의 deploy-worker.yml로 나중에 배포 가능
  const success = !!(workerDomain || githubRepoUrl);
  if (!success) {
    await log("❌ Worker 배포 및 GitHub 레포 생성 모두 실패", "error");
    return { success: false, error: "Worker 및 GitHub 레포 생성 모두 실패" };
  }

  const finalUrl = workerDomain || (githubRepoUrl ? `https://github.com/${owner}/${repoName}` : null);

  await log("━━━ 프로비저닝 완료 ━━━");
  await log(`미러링 Worker : ${workerDomain ? "✅ " + workerDomain : "⚠️ 미배포 (GitHub Actions deploy-worker.yml로 배포 가능)"}`);
  await log(`PHP Runner    : ${phpRunnerDeployed ? "✅ " + phpRunnerName : "⚠️ 미배포 (GitHub Actions로 추후 배포)"}`);
  await log(`KV 캐시       : ${kvCacheId ? "✅ " + kvCacheId : "⚠️ 없음"}`);
  await log(`GitHub 레포   : ${githubRepoUrl || "없음"}`);
  await log(`WP 설치 Action: ${githubRepoUrl ? "🚀 실행 중 (3~5분)" : "⚠️ 미트리거"}`);
  if (workerDomain) {
    await log(`사이트 URL    : ${workerDomain}`);
    await log(`관리자        : ${workerDomain}/wp-admin/ (설치 완료 후 접속 가능)`);
  }

  return {
    success,
    workerName,
    workerDomain:  workerDomain || realWorkerUrl || null,
    cfPagesUrl:    workerDomain || realWorkerUrl || null,
    githubRepoUrl,
    githubOwner:   owner,
    githubRepo:    repoName,
    kvCacheId,
    dbEngine:      "sqlite",
    dbPath:        "_db/wordpress.db",
    wpAdminUser,
    wpAdminPass,
    wpAdminEmail,
    siteUrl:       finalUrl,
    phpRunnerDeployed,
    autoProvisioned: true,
  };
}

// ─── SQL 빌더 (외부 호환) ────────────────────────────────────────────────────
export function buildWordPressD1SchemaSqls({ dbPrefix }) {
  const p = dbPrefix || "wp_";
  return [
    `CREATE TABLE IF NOT EXISTS ${p}options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT NOT NULL DEFAULT '' UNIQUE, option_value TEXT NOT NULL DEFAULT '', autoload TEXT NOT NULL DEFAULT 'yes')`,
    `CREATE TABLE IF NOT EXISTS ${p}users (ID INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT NOT NULL DEFAULT '', user_pass TEXT NOT NULL DEFAULT '', user_nicename TEXT NOT NULL DEFAULT '', user_email TEXT NOT NULL DEFAULT '', user_url TEXT NOT NULL DEFAULT '', user_registered TEXT NOT NULL DEFAULT '', user_activation_key TEXT NOT NULL DEFAULT '', user_status INTEGER NOT NULL DEFAULT 0, display_name TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ${p}usermeta (umeta_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, meta_key TEXT DEFAULT NULL, meta_value TEXT DEFAULT NULL)`,
  ];
}

export function buildWordPressInitSqls({ dbPrefix, adminUser, passHash, adminEmail, siteName, siteUrl, now }) {
  const p = dbPrefix || "wp_";
  now = now || new Date().toISOString().replace("T", " ").slice(0, 19);
  return [
    `INSERT OR IGNORE INTO ${p}users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name) VALUES ('${adminUser}', '${passHash}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', 0, '${adminUser}')`,
    `INSERT OR IGNORE INTO ${p}usermeta (user_id, meta_key, meta_value) VALUES (1, '${p}capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('siteurl', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('home', '${siteUrl}', 'yes')`,
    `INSERT OR IGNORE INTO ${p}options (option_name, option_value, autoload) VALUES ('blogname', '${siteName}', 'yes')`,
  ];
}
