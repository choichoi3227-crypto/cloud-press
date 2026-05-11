// functions/api/sites.js
// POST   → 호스팅 생성 (Cloudflare Pages + GitHub 레포 as Storage)
// GET    → 사이트 목록 / 상세
// PUT    → 설정 변경
// DELETE → 사이트 삭제
//
// 호스팅 방식:
//   - GitHub 레포: 스토리지 (WordPress 공식 파일 → Astro 변환 코드 저장)
//   - Cloudflare Pages: 배포 (GitHub 레포를 미러링, 사이트 전체 코드 업로드 아님)
//   - D1: 플랫폼 메타데이터 DB
//   - KV: 세션/캐시
//   - Cloudflare API: Pages 프로젝트 생성 + GitHub 연동 (미러링)

import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";
import { pickGithubToken, ghReq } from "./github-storage.js";
import { provisionCloudflarePagesHosting, getCfPagesUrl } from "./cf-pages-hosting.js";

// ── Cloudflare API 헬퍼 ────────────────────────────────────────────────────

class CfApi {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.base = "https://api.cloudflare.com/client/v4";
  }
  async req(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
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

      return jsonOk({
        success: true, site, domains, sshKeys,
        cf_pages_url: site.cf_pages_url || null,
        hosting_type: "cloudflare_pages",
      });
    }

    const query = payload.role === "admin"
      ? `SELECT id, site_name, primary_domain, php_version, status,
              is_throttled, cache_enabled,
              github_repo_owner, github_repo_name,
              cf_pages_url, cf_pages_project,
              plan, storage_used_mb, traffic_used_mb,
              created_at
         FROM sites ORDER BY rowid DESC`
      : `SELECT id, site_name, primary_domain, php_version, status,
              is_throttled, cache_enabled,
              github_repo_owner, github_repo_name,
              cf_pages_url, cf_pages_project,
              plan, storage_used_mb, traffic_used_mb,
              created_at
         FROM sites WHERE user_id = ? ORDER BY rowid DESC`;
    const stmt = payload.role === "admin"
      ? env.DB.prepare(query)
      : env.DB.prepare(query).bind(payload.id);

    const { results } = await stmt.all();
    const sites = (results || []).map(s => ({
      ...s,
      hosting_type: "cloudflare_pages",
    }));
    return jsonOk({ success: true, sites });
  } catch (e) {
    return jsonErr("조회 오류: " + e.message, 500);
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────
// 호스팅 생성:
//   1) GitHub 레포 생성 (스토리지) + WordPress 공식 파일 → Astro 변환 코드 업로드
//   2) Cloudflare Pages 프로젝트 생성
//   3) GitHub 레포 ↔ Cloudflare Pages 연동 (미러링 설정)
//      → 사이트 전체 코드를 Pages에 업로드하는 것이 아니라,
//        GitHub 레포의 Astro 변환 코드가 Pages에 자동 미러링되도록 연동
//   4) Cloudflare D1/KV 바인딩 자동 설정
//   5) (선택) 커스텀 도메인 DNS 설정
//
// 어드민은 결제 수단 없이 생성 가능

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const {
    site_name,
    php_version = "8.2",
    wp_admin_user,
    wp_admin_pass,
    wp_admin_email,
    cf_api_token,           // Cloudflare API 토큰 (Pages 프로젝트 생성용)
    cf_account_id,          // Cloudflare 계정 ID
    initial_domain,
    plan = "free",
    payment_method_id,
  } = body;

  // ── 기본 검증 ────────────────────────────────────────────────────────────
  if (!site_name?.trim())     return jsonErr("사이트 이름을 입력해주세요.", 400);
  if (!wp_admin_user?.trim()) return jsonErr("관리자 아이디를 입력해주세요.", 400);
  if (!wp_admin_pass || wp_admin_pass.length < 8)
    return jsonErr("비밀번호는 8자 이상이어야 합니다.", 400);
  if (!wp_admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wp_admin_email))
    return jsonErr("올바른 이메일을 입력해주세요.", 400);

  // ── 유료 플랜 결제수단 검증 (어드민은 예외) ─────────────────────────────
  if (plan !== "free" && !payment_method_id && payload.role !== "admin") {
    return jsonErr("유료 플랜은 결제수단 등록이 필요합니다.", 400);
  }

  // ── 플랜 한도 체크 (어드민은 무제한) ─────────────────────────────────────
  if (payload.role !== "admin") {
    try {
      const user    = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
      const curPlan = user?.plan || "free";
      const limits  = PLAN_LIMITS[curPlan] || PLAN_LIMITS.free;
      const row     = await env.DB.prepare("SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?").bind(payload.id).first();
      const cnt     = row?.cnt || 0;
      if (limits.sites !== Infinity && cnt >= limits.sites)
        return jsonErr(`${curPlan} 플랜에서는 최대 ${limits.sites}개 사이트를 생성할 수 있습니다.`, 403);
    } catch (e) {
      console.error("[sites/post] plan check:", e);
    }
  }

  // ── CF API 토큰 저장 (제공된 경우) ────────────────────────────────────────
  if (cf_api_token && cf_account_id) {
    await env.DB.prepare(
      "UPDATE users SET cf_api_token = ?, cf_account_id = ? WHERE id = ?"
    ).bind(cf_api_token, cf_account_id, payload.id).run().catch(() => {});
  }

  // ── ID 생성 ────────────────────────────────────────────────────────────────
  const id = crypto.randomUUID();

  // ── 사이트 레코드 DB 저장 (provisioning 상태) ─────────────────────────────
  try {
    await env.DB.prepare(
      `INSERT INTO sites
        (id, user_id, site_name, primary_domain, php_version, status,
         github_repo_owner, github_repo_name,
         cf_pages_url, cf_pages_project,
         wp_admin_user, wp_admin_pass, wp_admin_email,
         db_name, db_user, db_pass, db_host,
         cf_worker_name, cf_d1_id, cf_kv_id,
         plan, storage_used_mb, traffic_used_mb,
         payment_method_id,
         wp_install_script, cache_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning',
               NULL, NULL,
               NULL, NULL,
               ?, ?, ?,
               NULL, NULL, NULL, NULL,
               NULL, NULL, NULL,
               ?, 0, 0,
               ?,
               '', 1, ?)`
    ).bind(
      id, payload.id, site_name.trim(), null, php_version,
      wp_admin_user, wp_admin_pass, wp_admin_email,
      plan,
      // 어드민은 결제수단 없어도 저장 가능
      (payload.role === "admin" ? null : (payment_method_id || null)),
      new Date().toISOString()
    ).run();
  } catch (e) {
    return jsonErr("호스팅 생성 오류: " + e.message, 500);
  }

  // ── 로그 헬퍼 ────────────────────────────────────────────────────────────
  const log = async (msg, level = "info") => {
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(id, msg, level).run().catch(() => {});
  };

  const planLimits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  // ── 백그라운드 프로비저닝 ────────────────────────────────────────────────
  const provision = async () => {
    try {
      await log("Cloudflare Pages 호스팅 구축 시작");
      await log(`플랜: ${plan} | 스토리지: ${planLimits.storage_gb}GB`);

      // Cloudflare API 토큰/계정 ID 조회 (account.html: cf_global_api_key+cf_email 컬럼 사용)
      const u = await env.DB.prepare("SELECT cf_api_token, cf_account_id, cf_global_api_key, cf_email FROM users WHERE id = ?")
        .bind(payload.id).first().catch(() => null);
      const cfToken     = cf_api_token  || u?.cf_api_token  || u?.cf_global_api_key || env.CF_API_TOKEN;
      const cfAccountId = cf_account_id || u?.cf_account_id || u?.cf_email          || env.CF_ACCOUNT_ID;
      const result = await provisionCloudflarePagesHosting({
        env,
        siteId:      id,
        siteName:    site_name.trim(),
        adminUser:   wp_admin_user,
        adminPass:   wp_admin_pass,
        adminEmail:  wp_admin_email,
        plan,
        planLimits,
        cfToken,
        cfAccountId,
        initialDomain: initial_domain,
        userId:      payload.id,
        isAdmin:     payload.role === "admin",
        log,
      });

      if (!result) {
        // GitHub 토큰/CF 설정 없어도 사이트 레코드는 active로 유지 (수동 연동 안내)
        await env.DB.prepare(
          "UPDATE sites SET status = 'active', plan = ? WHERE id = ?"
        ).bind(plan, id).run().catch(() => {});
        await log("GitHub 토큰 또는 Cloudflare 설정이 없어 자동 프로비저닝을 건너뜠습니다. 관리자 설정에서 GitHub 토큰을 추가하세요.", "warning");
        return;
      }

      const { owner, repoName, pagesUrl, pagesProject, cfDomain, d1Id, kvSessionsId, kvCacheId, workerName } = result;

      // DB 최종 업데이트
      const primaryDomain = cfDomain || pagesUrl?.replace("https://", "").split("/")[0] || null;
      await env.DB.prepare(
        `UPDATE sites SET
          primary_domain    = ?,
          github_repo_owner = ?,
          github_repo_name  = ?,
          cf_pages_url      = ?,
          cf_pages_project  = ?,
          cf_worker_name    = ?,
          cf_d1_id          = ?,
          cf_kv_id          = ?,
          plan              = ?,
          status            = 'active'
         WHERE id = ?`
      ).bind(
        primaryDomain,
        owner,
        repoName,
        pagesUrl,
        pagesProject,
        workerName   || null,
        d1Id         || null,
        kvSessionsId || null,
        plan,
        id
      ).run();

      await log("Cloudflare Pages 호스팅 구축 완료!");
      await log(`Pages URL: ${pagesUrl}`);
      await log(`GitHub 레포: https://github.com/${owner}/${repoName}`);

    } catch (e) {
      await log("프로비저닝 오류: " + e.message, "error");
      await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?").bind(id).run().catch(() => {});
    }
  };

  // waitUntil 처리
  const realWaitUntil = context._workerCtx?.waitUntil?.bind(context._workerCtx);
  if (realWaitUntil) {
    realWaitUntil(provision());
  } else if (context.waitUntil && context.waitUntil !== (() => {})) {
    try { context.waitUntil(provision()); } catch { provision().catch(() => {}); }
  } else {
    provision().catch(() => {});
  }

  return jsonOk({
    success: true,
    id,
    message: "Cloudflare Pages 호스팅 구축이 시작되었습니다. 완료까지 5~8분이 소요됩니다.",
    status:  "provisioning",
    note:    "GitHub 레포(스토리지) → Cloudflare Pages(배포) 방식으로 미러링됩니다.",
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

  const site = await env.DB.prepare("SELECT id, user_id, plan FROM sites WHERE id = ?").bind(id).first();
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
    "SELECT id, user_id, github_repo_owner, github_repo_name, cf_pages_project FROM sites WHERE id = ?"
  ).bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM site_ssh_keys WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM php_logs WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({
      success: true,
      message: "호스팅이 삭제되었습니다." + (site.github_repo_name
        ? ` GitHub 저장소(${site.github_repo_owner}/${site.github_repo_name})는 보존됩니다.`
        : ""),
    });
  } catch (e) {
    return jsonErr("삭제 오류: " + e.message, 500);
  }
}
