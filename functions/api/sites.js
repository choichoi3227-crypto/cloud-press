// functions/api/sites.js
// POST   → 호스팅 생성 (CF API로 Worker/D1/KV 자동 생성, GitHub repo 자동 생성)
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
} from "./github-storage.js";

// ── Cloudflare API 헬퍼 ───────────────────────────────────────────────────────
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

// ── CF 계정 ID 조회 ───────────────────────────────────────────────────────────
async function getCfAccountId(cf) {
  const r = await cf.get("/accounts?per_page=1");
  return r.result?.[0]?.id || null;
}

// ── CF Worker 생성 (GitHub 스토리지 연동) ─────────────────────────────────────
async function createCfWorker(cf, accountId, workerName, siteId, githubOwner, githubRepo) {
  const script = `
// CloudPress WordPress Worker — site: ${siteId}
// Storage: GitHub (${githubOwner}/${githubRepo})
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        }
      });
    }

    // wp-admin, wp-login.php → WordPress 관리 처리
    if (url.pathname.startsWith('/wp-admin') || url.pathname === '/wp-login.php') {
      return new Response(JSON.stringify({ site: '${siteId}', status: 'active', storage: 'github' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 미디어 파일 → GitHub Raw로 서빙
    if (url.pathname.startsWith('/wp-content/uploads/')) {
      const filePath = url.pathname.replace('/wp-content/uploads/', '');
      const githubRaw = \`https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/main/uploads/\${filePath}\`;
      const ghToken = env.GITHUB_TOKEN;
      const fetchOpts = ghToken
        ? { headers: { Authorization: \`Bearer \${ghToken}\` } }
        : {};
      const ghRes = await fetch(githubRaw, fetchOpts).catch(() => null);
      if (ghRes?.ok) return ghRes;
    }

    // 정적 파일 (테마, 플러그인) → GitHub Raw
    if (url.pathname.startsWith('/wp-content/')) {
      const filePath = url.pathname.slice('/wp-content/'.length);
      const githubRaw = \`https://raw.githubusercontent.com/${githubOwner}/${githubRepo}/main/wp-content/\${filePath}\`;
      const ghToken = env.GITHUB_TOKEN;
      const fetchOpts = ghToken
        ? { headers: { Authorization: \`Bearer \${ghToken}\` } }
        : {};
      const ghRes = await fetch(githubRaw, fetchOpts).catch(() => null);
      if (ghRes?.ok) return ghRes;
    }

    // KV 캐시 확인
    if (env.CACHE) {
      const cacheKey = \`page:\${url.pathname}\`;
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Cache': 'HIT' }
        });
      }
    }

    return new Response('CloudPress WordPress Site — ' + url.pathname, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};
`.trim();

  const formData = new FormData();
  formData.append("metadata", JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [],
  }));
  formData.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
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

// ── CF D1 DB 생성 ─────────────────────────────────────────────────────────────
async function createCfD1(cf, accountId, dbName) {
  const r = await cf.post(`/accounts/${accountId}/d1/database`, { name: dbName });
  if (r.success) return { id: r.result.uuid, name: r.result.name };
  const list = await cf.get(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(dbName)}`);
  const existing = list.result?.find(d => d.name === dbName);
  if (existing) return { id: existing.uuid, name: existing.name };
  return null;
}

// ── CF KV 네임스페이스 생성 ───────────────────────────────────────────────────
async function createCfKV(cf, accountId, kvName) {
  const r = await cf.post(`/accounts/${accountId}/storage/kv/namespaces`, { title: kvName });
  if (r.success) return { id: r.result.id, name: kvName };
  const list = await cf.get(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const existing = list.result?.find(k => k.title === kvName);
  if (existing) return { id: existing.id, name: existing.title };
  return null;
}

// ── GitHub repo 프로비저닝 ────────────────────────────────────────────────────
async function provisionGithubRepo(env, siteId, shortId, siteName) {
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

  // 기본 디렉터리 구조 초기화 (타임아웃 방지 위해 순차적으로)
  const initFiles = [
    { path: "uploads/.gitkeep",          content: "" },
    { path: "wp-content/themes/.gitkeep", content: "" },
    { path: "wp-content/plugins/.gitkeep", content: "" },
    { path: "wp-core/.gitkeep",           content: "" },
    { path: "README.md",                  content: `# CloudPress Site: ${siteName}\n\nSite ID: ${siteId}\nCreated: ${new Date().toISOString()}\n\n## Directory Structure\n- \`uploads/\` - WordPress media uploads\n- \`wp-content/themes/\` - WordPress themes\n- \`wp-content/plugins/\` - WordPress plugins\n- \`wp-core/\` - WordPress core files (chunked)\n` },
  ];

  // 순차 업로드 (타임아웃 방지)
  for (const file of initFiles) {
    await uploadFileToGithub(token, owner, repoName, file.path, file.content, `init: ${file.path}`)
      .catch(e => console.warn(`[github] init file failed: ${file.path}`, e.message));
    // 작은 딜레이 (API rate limit 방지)
    await new Promise(r => setTimeout(r, 200));
  }

  return { owner, repoName, token };
}

// ── GitHub에 WordPress 코어 분할 업로드 ──────────────────────────────────────
// 실제 WP 코어는 매우 크므로 백그라운드에서 청크 단위로 업로드
async function uploadWordPressCore(token, owner, repoName, log) {
  // WP 코어 메타정보만 먼저 기록 (실제 파일은 별도 배포 스크립트로)
  const meta = {
    version:     "6.5.5",
    source:      "https://wordpress.org/wordpress-6.5.5.zip",
    uploaded_at: new Date().toISOString(),
    status:      "pending",
    note:        "WordPress core files are managed separately. Use the setup script to upload.",
  };

  await uploadFileToGithub(
    token, owner, repoName,
    "wp-core/meta.json",
    JSON.stringify(meta, null, 2),
    "add WordPress core meta"
  ).catch(() => {});

  await log("GitHub repo 초기화 완료. WordPress 코어는 setup 스크립트로 업로드됩니다.");
}

// ── WordPress 초기 설정 SQL (D1에 직접 적용) ─────────────────────────────────
function buildWpInitSql(siteId, domain, adminUser, adminPass, adminEmail) {
  const now     = new Date().toISOString().slice(0, 19).replace("T", " ");
  const siteUrl = `https://${domain}`;
  return `
CREATE TABLE IF NOT EXISTS wp_options (
  option_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  option_name  TEXT UNIQUE NOT NULL,
  option_value TEXT,
  autoload     TEXT DEFAULT 'yes'
);
CREATE TABLE IF NOT EXISTS wp_users (
  ID            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_login    TEXT NOT NULL,
  user_pass     TEXT NOT NULL,
  user_email    TEXT NOT NULL,
  user_registered TEXT,
  display_name  TEXT,
  user_status   INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wp_usermeta (
  umeta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  meta_key    TEXT,
  meta_value  TEXT
);
CREATE TABLE IF NOT EXISTS wp_posts (
  ID          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_title  TEXT,
  post_status TEXT DEFAULT 'publish',
  post_type   TEXT DEFAULT 'post',
  post_date   TEXT
);

INSERT OR IGNORE INTO wp_options (option_name, option_value) VALUES
  ('siteurl',      '${siteUrl}'),
  ('home',         '${siteUrl}'),
  ('blogname',     '${domain}'),
  ('admin_email',  '${adminEmail}'),
  ('permalink_structure', '/%postname%/'),
  ('wp_user_roles', ''),
  ('active_plugins', ''),
  ('template',     'twentytwentyfour'),
  ('stylesheet',   'twentytwentyfour'),
  ('site_id',      '${siteId}');

INSERT OR IGNORE INTO wp_users (user_login, user_pass, user_email, user_registered, display_name)
VALUES ('${adminUser}', '${adminPass}', '${adminEmail}', '${now}', '${adminUser}');
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

  // ── 플랜 한도 체크 ──────────────────────────────────────────────────────────
  try {
    const user    = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
    const plan    = user?.plan || "free";
    const limits  = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const row     = await env.DB.prepare("SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?").bind(payload.id).first();
    const cnt     = row?.cnt || 0;
    if (limits.sites !== Infinity && cnt >= limits.sites)
      return jsonErr(`${plan} 플랜에서는 사이트를 최대 ${limits.sites}개까지 생성할 수 있습니다.`, 403);
  } catch (e) {
    console.error("[sites/post] plan check:", e);
  }

  // ── 사용자의 Cloudflare API 키 조회 ─────────────────────────────────────────
  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();

  if (!user?.cf_global_api_key || !user?.cf_email)
    return jsonErr("Cloudflare Global API 키가 설정되어 있지 않습니다. 계정 설정에서 먼저 등록해주세요.", 400);

  // GitHub 토큰 존재 확인 (경고만, 차단 안 함)
  const ghToken = await pickGithubToken(env);
  const hasGithub = !!ghToken;

  // ── ID 생성 ─────────────────────────────────────────────────────────────────
  const id      = crypto.randomUUID();
  const shortId = id.replace(/-/g, "").slice(0, 8);

  // ── CF API 인스턴스 ─────────────────────────────────────────────────────────
  const cf = new CfApi(user.cf_global_api_key, user.cf_email, null);

  // ── CF 계정 ID 조회 ─────────────────────────────────────────────────────────
  let cfAccountId = env.CF_ACCOUNT_ID || null;
  if (!cfAccountId) {
    cfAccountId = await getCfAccountId(cf).catch(() => null);
  }
  if (!cfAccountId)
    return jsonErr("Cloudflare 계정 ID를 가져올 수 없습니다. CF_ACCOUNT_ID 환경변수를 확인해주세요.", 500);

  cf.accountId = cfAccountId;

  // ── 사이트 레코드 먼저 DB에 저장 (provisioning 상태) ───────────────────────
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
      null, null, // github_repo_owner, github_repo_name (후에 업데이트)
      wp_admin_user, wp_admin_pass, wp_admin_email,
      dbName, dbUser, dbPass, dbHost,
      null, null, null,
      new Date().toISOString()
    ).run();
  } catch (e) {
    return jsonErr("호스팅 생성 오류: " + e.message, 500);
  }

  // ── 로그 기록 헬퍼 ──────────────────────────────────────────────────────────
  const log = async (msg, level = "info") => {
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(id, msg, level).run().catch(() => {});
  };

  // ── 백그라운드 프로비저닝 ──────────────────────────────────────────────────
  const provision = async () => {
    try {
      await log("호스팅 프로비저닝 시작");

      // 1) GitHub repo 생성
      let githubOwner = null;
      let githubRepoName = null;
      if (hasGithub) {
        await log("GitHub 저장소 생성 중...");
        const ghResult = await provisionGithubRepo(env, id, shortId, site_name.trim());
        if (ghResult) {
          githubOwner    = ghResult.owner;
          githubRepoName = ghResult.repoName;
          await log(`GitHub 저장소 생성 완료: ${githubOwner}/${githubRepoName}`);

          // WordPress 코어 메타 업로드 (타임아웃 방지 - 메타만)
          await uploadWordPressCore(ghResult.token, githubOwner, githubRepoName, log);
        } else {
          await log("GitHub 저장소 생성 실패 (계속 진행)", "warning");
        }
      } else {
        await log("GitHub 토큰 미설정 - 스토리지 없이 진행 (관리자 설정에서 토큰 추가 필요)", "warning");
      }

      // 2) CF Worker 생성
      const workerName = `cp-site-${shortId}`;
      await log(`Cloudflare Worker 생성 중: ${workerName}`);
      const workerOk = await createCfWorker(
        cf, cfAccountId, workerName, id,
        githubOwner || "placeholder",
        githubRepoName || `cloudpress-site-${shortId}`
      );
      if (!workerOk) await log("Worker 생성 실패 (계속 진행)", "warning");
      else await log(`Worker 생성 완료: ${workerName}`);

      // 3) CF D1 DB 생성
      const d1Name = `cp-db-${shortId}`;
      await log(`D1 데이터베이스 생성 중: ${d1Name}`);
      const d1 = await createCfD1(cf, cfAccountId, d1Name);
      const d1Id = d1?.id || null;
      if (d1Id) await log(`D1 생성 완료: ${d1Name} (${d1Id})`);
      else      await log("D1 생성 실패 (계속 진행)", "warning");

      // 4) CF KV 생성
      const kvName = `cp-kv-${shortId}`;
      await log(`KV 네임스페이스 생성 중: ${kvName}`);
      const kv = await createCfKV(cf, cfAccountId, kvName);
      const kvId = kv?.id || null;
      if (kvId) await log(`KV 생성 완료: ${kvName} (${kvId})`);
      else      await log("KV 생성 실패 (계속 진행)", "warning");

      // 5) WordPress D1 초기화 SQL 실행
      const tempDomain = `${workerName}.workers.dev`;
      if (d1Id) {
        await log("WordPress 데이터베이스 초기화 중...");
        const initSql = buildWpInitSql(id, tempDomain, wp_admin_user, wp_admin_pass, wp_admin_email);
        const sqlRes = await cf.post(
          `/accounts/${cfAccountId}/d1/database/${d1Id}/query`,
          { sql: initSql }
        );
        if (sqlRes.success) await log("WordPress DB 초기화 완료");
        else                await log("WordPress DB 초기화 실패: " + JSON.stringify(sqlRes.errors), "warning");
      }

      // 6) DB 업데이트
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

      await log(`호스팅 생성 완료! GitHub: ${githubOwner}/${githubRepoName} — 도메인 탭에서 커스텀 도메인을 연결하세요.`);

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
    success:       true,
    id,
    message:       `호스팅 생성이 시작되었습니다. Cloudflare 리소스(Worker/D1/KV)${hasGithub ? "와 GitHub 저장소" : ""}를 자동으로 생성 중입니다.`,
    status:        "provisioning",
    wp_admin_user,
    github_enabled: hasGithub,
    note:          "도메인 탭에서 커스텀 도메인을 연결해주세요.",
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
        cf.accountId = accountId;
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

  // GitHub repo는 삭제하지 않음 (데이터 보호) — 사용자가 직접 삭제

  try {
    await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM site_ssh_keys WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM php_logs WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({
      success: true,
      message: "호스팅이 삭제되었습니다." + (site.github_repo_name ? ` (GitHub 저장소 ${site.github_repo_owner}/${site.github_repo_name}는 보존되었습니다. 필요시 직접 삭제하세요.)` : ""),
    });
  } catch (e) {
    return jsonErr("삭제 오류: " + e.message, 500);
  }
}
