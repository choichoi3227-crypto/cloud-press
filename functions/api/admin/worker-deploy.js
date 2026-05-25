// functions/api/admin/worker-deploy.js
// POST /api/admin/worker-deploy
//   action: "create_master_worker"     → 총괄 워커 생성
//   action: "create_multisite_worker"  → 멀티사이트 워커 생성
//   action: "save_cf_api"             → 워커 생성용 CF API 키 저장
//   action: "get_cf_api_status"       → CF API 저장 여부 확인
//   action: "list_workers"            → 생성된 워커 목록 조회

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

async function ensureTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cms_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `).run().catch(() => {});

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS deployed_workers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,  -- 'master' | 'multisite'
      script_name TEXT NOT NULL,
      github_repo TEXT,
      status      TEXT DEFAULT 'creating',
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run().catch(() => {});
}

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM cms_settings WHERE key = ?")
    .bind(key).first().catch(() => null);
  return row?.value ?? null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO cms_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

// ── CF Workers API 헬퍼 ───────────────────────────────────────────────────
async function cfApiReq(method, path, apiKey, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── GitHub API 헬퍼 ────────────────────────────────────────────────────────
async function githubApiReq(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── 계정 ID 자동 조회 ─────────────────────────────────────────────────────
async function getCfAccountId(apiKey) {
  const res = await cfApiReq("GET", "/accounts?per_page=1", apiKey);
  return res.result?.[0]?.id || null;
}

// ── 워커 스크립트 생성 (기본 빈 Worker) ─────────────────────────────────────
function buildMasterWorkerScript() {
  return `// CP3 Master Worker - Control Plane
// 자동 생성됨 by CloudPress Admin

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // Health check
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({
      status: 'ok',
      type: 'master_worker',
      timestamp: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Pool status
  if (url.pathname === '/api/pools/status') {
    return new Response(JSON.stringify({
      pools: [],
      message: 'Master Worker ready. Configure pools via admin panel.',
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('CP3 Master Worker - Control Plane', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
`;
}

function buildMultisiteWorkerScript(index) {
  return `// CP3 Multisite Worker - Pool ${index}
// 자동 생성됨 by CloudPress Admin

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return new Response(JSON.stringify({
      status: 'ok',
      type: 'multisite_worker',
      pool: ${index},
      timestamp: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('CP3 Multisite Worker - Pool ${index}', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
`;
}

// ── Worker 배포 ──────────────────────────────────────────────────────────
async function deployWorker(accountId, scriptName, scriptContent, apiKey) {
  const formData = new FormData();
  const metadata = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2024-01-01",
  });
  formData.append("metadata", new Blob([metadata], { type: "application/json" }), "metadata.json");
  formData.append("worker.js", new Blob([scriptContent], { type: "application/javascript+module" }), "worker.js");

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData,
    }
  );
  return res.json();
}

// ── GitHub 레포 생성 ────────────────────────────────────────────────────────
async function createGithubRepo(token, orgOrUser, repoName, description, isOrg) {
  // 조직 여부 판별
  const path = isOrg
    ? `/orgs/${orgOrUser}/repos`
    : "/user/repos";

  const res = await githubApiReq("POST", path, token, {
    name:        repoName,
    description: description || `CloudPress CP3 - ${repoName}`,
    private:     true,
    auto_init:   true,
  });

  if (res.full_name) {
    return { success: true, full_name: res.full_name, html_url: res.html_url };
  }
  // 이미 존재하면 성공으로 처리
  if (res.errors?.[0]?.message?.includes("already exists")) {
    return { success: true, full_name: `${orgOrUser}/${repoName}`, already_exists: true };
  }
  return { success: false, error: res.message || JSON.stringify(res.errors) };
}

// ── POST 핸들러 ────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  await ensureTables(env);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 본문을 파싱할 수 없습니다.", 400); }

  const { action } = body;

  // ── CF API 키 저장 ──────────────────────────────────────────────────────
  if (action === "save_cf_api") {
    const { cf_api_key, cf_email } = body;
    if (!cf_api_key) return jsonErr("Cloudflare API 키를 입력해주세요.", 400);

    // 검증
    const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { "Authorization": `Bearer ${cf_api_key}` },
    }).then(r => r.json()).catch(() => ({ success: false }));

    const isToken = verifyRes.success;

    let accountId = null;
    if (isToken) {
      accountId = await getCfAccountId(cf_api_key);
    } else {
      // Global API Key 방식 시도
      if (!cf_email) return jsonErr("Global API Key 방식은 이메일도 필요합니다.", 400);
      const accRes = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
        headers: { "X-Auth-Key": cf_api_key, "X-Auth-Email": cf_email },
      }).then(r => r.json()).catch(() => ({ success: false }));
      if (!accRes.success) return jsonErr("Cloudflare API 키가 유효하지 않습니다.", 400);
      accountId = accRes.result?.[0]?.id || null;
    }

    await setSetting(env, "admin_cf_api_key",    cf_api_key);
    await setSetting(env, "admin_cf_email",      cf_email || "");
    await setSetting(env, "admin_cf_account_id", accountId || "");

    return jsonOk({
      success:    true,
      message:    "Cloudflare API 키가 저장되었습니다.",
      account_id: accountId,
      auth_type:  isToken ? "token" : "global_key",
    });
  }

  // ── CF API 상태 확인 ────────────────────────────────────────────────────
  if (action === "get_cf_api_status") {
    const [hasKey, accountId, email] = await Promise.all([
      getSetting(env, "admin_cf_api_key").then(v => !!v),
      getSetting(env, "admin_cf_account_id"),
      getSetting(env, "admin_cf_email"),
    ]);
    return jsonOk({ has_key: hasKey, account_id: accountId, email });
  }

  // 이하 워커 생성 액션은 CF API 키 필요
  const cfApiKey    = await getSetting(env, "admin_cf_api_key");
  const cfAccountId = await getSetting(env, "admin_cf_account_id");
  if (!cfApiKey) return jsonErr("워커 생성 Cloudflare API 키가 설정되지 않았습니다.", 400);

  const accountId = cfAccountId || await getCfAccountId(cfApiKey);
  if (!accountId) return jsonErr("Cloudflare Account ID를 확인할 수 없습니다.", 400);

  // GitHub 토큰
  const ghToken    = await getSetting(env, "admin_gh_worker_token") ||
                     (await env.DB.prepare("SELECT token FROM github_tokens ORDER BY id ASC LIMIT 1")
                       .first().catch(() => null))?.token;
  const ghOwner    = body.github_owner || await getSetting(env, "admin_gh_owner") || "";

  // ── 총괄 워커 생성 ──────────────────────────────────────────────────────
  if (action === "create_master_worker") {
    const scriptName = body.script_name || "cp3-master-worker";
    const results    = { worker: null, github_repo: null };

    // Worker 배포
    try {
      const script  = buildMasterWorkerScript();
      const deployRes = await deployWorker(accountId, scriptName, script, cfApiKey);
      if (deployRes.success) {
        results.worker = { success: true, script_name: scriptName };
      } else {
        results.worker = { success: false, error: deployRes.errors?.[0]?.message || "Worker 배포 실패" };
      }
    } catch (e) {
      results.worker = { success: false, error: e.message };
    }

    // GitHub 레포 생성
    if (ghToken && ghOwner) {
      try {
        const repoName = body.github_repo_name || `cp3-master-worker`;
        const ghRes = await createGithubRepo(ghToken, ghOwner, repoName, "CP3 Master Worker - Control Plane", false);
        results.github_repo = ghRes;
      } catch (e) {
        results.github_repo = { success: false, error: e.message };
      }
    }

    // DB 저장
    if (results.worker?.success) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO deployed_workers (id, name, type, script_name, github_repo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        id, scriptName, "master", scriptName,
        results.github_repo?.full_name || null,
        "active",
        new Date().toISOString(), new Date().toISOString()
      ).run().catch(() => {});
    }

    const allSuccess = results.worker?.success;
    return jsonOk({
      success: allSuccess,
      message: allSuccess
        ? `✅ 총괄 워커(${scriptName})가 생성되었습니다.`
        : `❌ 총괄 워커 생성 실패: ${results.worker?.error}`,
      results,
      worker_url: allSuccess ? `https://${scriptName}.${accountId?.slice(0,8)}.workers.dev` : null,
    });
  }

  // ── 멀티사이트 워커 생성 ────────────────────────────────────────────────
  if (action === "create_multisite_worker") {
    const count      = Math.min(parseInt(body.count) || 1, 10); // 최대 10개
    const namePrefix = body.name_prefix || "cp3-pool";
    const created    = [];
    const failed     = [];

    for (let i = 1; i <= count; i++) {
      const scriptName = `${namePrefix}-${i}`;
      let workerOk  = false;
      let githubOk  = null;

      // Worker 배포
      try {
        const script    = buildMultisiteWorkerScript(i);
        const deployRes = await deployWorker(accountId, scriptName, script, cfApiKey);
        workerOk = !!deployRes.success;
        if (!workerOk) {
          failed.push({ index: i, name: scriptName, error: deployRes.errors?.[0]?.message || "배포 실패" });
          continue;
        }
      } catch (e) {
        failed.push({ index: i, name: scriptName, error: e.message });
        continue;
      }

      // GitHub 레포 생성
      if (ghToken && ghOwner) {
        try {
          const repoName = body.github_repo_prefix
            ? `${body.github_repo_prefix}-${i}`
            : `cp3-pool-${i}`;
          githubOk = await createGithubRepo(
            ghToken, ghOwner, repoName,
            `CP3 Multisite Worker Pool ${i}`, false
          );
        } catch (e) {
          githubOk = { success: false, error: e.message };
        }
      }

      // DB 저장
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO deployed_workers (id, name, type, script_name, github_repo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        id, scriptName, "multisite", scriptName,
        githubOk?.full_name || null,
        "active",
        new Date().toISOString(), new Date().toISOString()
      ).run().catch(() => {});

      created.push({
        index:       i,
        name:        scriptName,
        github_repo: githubOk?.full_name || null,
        worker_ok:   true,
        github_ok:   githubOk?.success || false,
      });
    }

    return jsonOk({
      success: created.length > 0,
      message: `✅ 멀티사이트 워커 ${created.length}개 생성 완료` +
               (failed.length > 0 ? `, ${failed.length}개 실패` : ""),
      created,
      failed,
      total: count,
    });
  }

  // ── 워커 목록 조회 ──────────────────────────────────────────────────────
  if (action === "list_workers") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM deployed_workers ORDER BY created_at DESC"
    ).all().catch(() => ({ results: [] }));
    return jsonOk({ success: true, workers: results });
  }

  return jsonErr("알 수 없는 action입니다.", 400);
}

// ── GET: 워커 목록 + CF API 상태 ───────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  await ensureTables(env);

  const [hasKey, accountId, email, workers] = await Promise.all([
    getSetting(env, "admin_cf_api_key").then(v => !!v),
    getSetting(env, "admin_cf_account_id"),
    getSetting(env, "admin_cf_email"),
    env.DB.prepare("SELECT * FROM deployed_workers ORDER BY created_at DESC").all()
      .catch(() => ({ results: [] })),
  ]);

  return jsonOk({
    cf_api: { has_key: hasKey, account_id: accountId, email },
    workers: workers.results || [],
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
