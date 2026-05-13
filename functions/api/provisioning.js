// functions/api/provisioning.js
// POST /api/provisioning?id={siteId}
// sites.js가 사이트 레코드 생성 후 이 엔드포인트를 호출
// Cloudflare Pages Functions에서 독립적으로 실행됨

import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";
import { provisionCloudflarePagesHosting } from "./cf-pages-hosting.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── 인증 ────────────────────────────────────────────────────────────────
  const payload = await requireAuth(request, env).catch(() => null);
  if (!payload) return jsonErr("Unauthorized", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("id");
  if (!siteId) return jsonErr("site id required", 400);

  // ── 사이트 조회 ──────────────────────────────────────────────────────────
  const site = await env.DB.prepare(
    "SELECT * FROM sites WHERE id = ? AND user_id = ?"
  ).bind(siteId, payload.id).first().catch(() => null);

  if (!site) return jsonErr("Site not found", 404);
  if (site.status !== "provisioning") return jsonErr("Already processed", 409);

  // ── 로그 헬퍼 ───────────────────────────────────────────────────────────
  const log = async (msg, level = "info") => {
    console.log(`[Provision][${level}] ${msg}`);
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(siteId, String(msg).slice(0, 2000), level)
     .run().catch((e) => console.error("[Provision] log DB err:", e?.message));
  };

  // ── CF 자격증명 ─────────────────────────────────────────────────────────
  const u = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_account_id, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first().catch(() => null);

  const cfToken     = u?.cf_global_api_key || env.CF_API_TOKEN  || null;
  const cfAccountId = u?.cf_account_id     || env.CF_ACCOUNT_ID || null;
  const cfEmail     = u?.cf_email          || null;

  const planLimits = PLAN_LIMITS[site.plan] || PLAN_LIMITS.free;

  // ── 본체: provision 실행 후 즉시 응답 반환 ──────────────────────────────
  // waitUntil로 백그라운드 실행
  const run = async () => {
    await log("▶ 프로비저닝 시작");
    await log(`CF Token     : ${cfToken     ? "✅ " + String(cfToken).slice(0,8)     + "..." : "❌ 없음"}`);
    await log(`CF AccountId : ${cfAccountId ? "✅ " + String(cfAccountId).slice(0,8) + "..." : "❌ 없음"}`);
    await log(`Plan         : ${site.plan}`);

    try {
      const result = await provisionCloudflarePagesHosting({
        env,
        siteId,
        siteName:      site.site_name,
        adminUser:     site.wp_admin_user  || "admin",
        adminPass:     site.wp_admin_pass  || "changeme123!",
        adminEmail:    site.wp_admin_email || payload.email,
        plan:          site.plan,
        planLimits,
        cfToken,
        cfAccountId,
        cfEmail,
        initialDomain: site.initial_domain || null,
        userId:        payload.id,
        isAdmin:       payload.role === "admin",
        log,
      });

      if (!result) {
        await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?")
          .bind(siteId).run().catch(() => {});
        return;
      }

      const {
        owner, repoName, pagesUrl, pagesProject, cfDomain,
        d1Id, kvSessionsId, kvCacheId, workerName,
      } = result;

      const primaryDomain = cfDomain || pagesUrl || null;

      await env.DB.prepare(`
        UPDATE sites SET
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
        WHERE id = ?
      `).bind(
        primaryDomain, owner, repoName,
        pagesUrl, pagesProject,
        workerName    || null,
        d1Id          || null,
        kvSessionsId  || null,
        site.plan,
        siteId
      ).run();

      await log("✅ 프로비저닝 완료!");
      await log(`Pages URL : ${pagesUrl}`);
      await log(`GitHub    : https://github.com/${owner}/${repoName}`);
      if (d1Id)         await log(`D1        : ${d1Id}`);
      if (kvSessionsId) await log(`KV        : ${kvSessionsId}`);
      if (workerName)   await log(`Worker    : ${workerName}`);

    } catch (e) {
      const msg = String(e?.message || e);
      const stk = String(e?.stack   || "").slice(0, 600);
      console.error("[Provision] FATAL:", msg, stk);
      await log("❌ 오류: " + msg, "error");
      await log("스택: "   + stk,  "error");
      await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?")
        .bind(siteId).run().catch(() => {});
    }
  };

  // waitUntil 사용 가능하면 백그라운드로, 아니면 await
  if (typeof context.waitUntil === "function") {
    context.waitUntil(run());
    return jsonOk({ ok: true, message: "프로비저닝 시작됨" });
  }

  // waitUntil 없으면 동기 실행 (응답 느리지만 안전)
  await run();
  return jsonOk({ ok: true, message: "프로비저닝 완료" });
}
