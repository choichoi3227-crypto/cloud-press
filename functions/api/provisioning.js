// functions/api/provisioning.js
// POST /api/provisioning?id={siteId}

import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";
import { provisionCloudflarePagesHosting } from "./cf-pages-hosting.js";

async function isSubscribed(env, userId, productType) {
  if (!env?.DB || !userId) return false;
  const row = await env.DB.prepare(
    `SELECT status, expires_at
     FROM user_product_subscriptions
     WHERE user_id = ? AND product_type = ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, productType).first().catch(() => null);
  if (!row || row.status !== "active") return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const payload = await requireAuth(request, env).catch(() => null);
  if (!payload) return jsonErr("Unauthorized", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("id");
  if (!siteId) return jsonErr("site id required", 400);

  const site = await env.DB.prepare(
    "SELECT * FROM sites WHERE id = ? AND user_id = ?"
  ).bind(siteId, payload.id).first().catch(() => null);

  if (!site) return jsonErr("Site not found", 404);
  if (site.status !== "provisioning") return jsonErr("Already processed", 409);

  const log = async (msg, level = "info") => {
    console.log(`[Provision][${level}] ${msg}`);
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(siteId, String(msg).slice(0, 2000), level)
     .run().catch((e) => console.error("[Provision] log DB err:", e?.message));
  };

  const sendNotification = async ({ success, siteUrl, siteName, wpAdminUser, wpAdminPass, error }) => {
    try {
      if (env.RESEND_API_KEY && payload.email) {
        const subject = success
          ? `✅ [CloudPress] "${siteName}" WordPress 호스팅 개설 완료`
          : `❌ [CloudPress] "${siteName}" 호스팅 개설 실패`;
        const htmlBody = success
          ? `<h2>✅ WordPress 호스팅 개설 완료</h2>
<p>사이트 <strong>${siteName}</strong>가 성공적으로 개설되었습니다.</p>
<table style="border-collapse:collapse;font-size:14px;margin:16px 0;">
  <tr><td style="padding:6px 16px;font-weight:bold;background:#f5f5f5;">사이트 URL</td><td style="padding:6px 16px;"><a href="${siteUrl}">${siteUrl}</a></td></tr>
  <tr><td style="padding:6px 16px;font-weight:bold;background:#f5f5f5;">관리자 페이지</td><td style="padding:6px 16px;"><a href="${siteUrl}/wp-admin/">${siteUrl}/wp-admin/</a></td></tr>
  <tr><td style="padding:6px 16px;font-weight:bold;background:#f5f5f5;">관리자 ID</td><td style="padding:6px 16px;">${wpAdminUser}</td></tr>
  <tr><td style="padding:6px 16px;font-weight:bold;background:#f5f5f5;">관리자 비밀번호</td><td style="padding:6px 16px;"><code style="background:#f0f0f0;padding:2px 8px;border-radius:3px;">${wpAdminPass}</code></td></tr>
</table>
<p><a href="https://cloud-press.co.kr/hosting.html" style="background:#2271b1;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;">대시보드 바로가기</a></p>`
          : `<h2>❌ 호스팅 개설 실패</h2>
<p>사이트 <strong>${siteName}</strong> 개설 중 오류가 발생했습니다.</p>
<p><strong>오류:</strong> ${error || "알 수 없는 오류"}</p>
<p><a href="https://cloud-press.co.kr/hosting.html">다시 시도하기</a></p>`;

        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "CloudPress <noreply@cloud-press.co.kr>", to: [payload.email], subject, html: htmlBody }),
        });
        await log(`  📧 이메일 알림 발송: ${payload.email}`);
      }

      if (env.KV) {
        const notif = {
          type: success ? "success" : "error",
          title: success ? `"${siteName}" 호스팅 개설 완료` : `"${siteName}" 호스팅 개설 실패`,
          message: success ? `WordPress 설치 완료. ${siteUrl}` : `오류: ${error || "알 수 없는 오류"}`,
          siteUrl: siteUrl || null,
          createdAt: new Date().toISOString(),
          read: false,
        };
        await env.KV.put(`notify:${payload.id}:${Date.now()}`, JSON.stringify(notif), { expirationTtl: 86400 * 30 });
        await log(`  🔔 인앱 알림 저장 완료`);
      }
    } catch (e) {
      await log(`  ⚠️ 알림 발송 실패: ${e.message}`, "warn");
    }
  };

  const u = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_account_id, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first().catch(() => null);

  const cfToken     = u?.cf_global_api_key || env.CF_API_TOKEN  || null;
  const cfAccountId = u?.cf_account_id     || env.CF_ACCOUNT_ID || null;
  const cfEmail     = u?.cf_email          || null;
  const planLimits  = PLAN_LIMITS[site.plan] || PLAN_LIMITS.free;

  const run = async () => {
    await log("▶ 프로비저닝 시작");
    await log(`CF Token     : ${cfToken     ? "✅ " + String(cfToken).slice(0,8)     + "..." : "❌ 없음"}`);
    await log(`CF AccountId : ${cfAccountId ? "✅ " + String(cfAccountId).slice(0,8) + "..." : "❌ 없음"}`);
    await log(`Plan         : ${site.plan}`);

    try {
      const result = await provisionCloudflarePagesHosting({
        env, siteId,
        siteName:      site.site_name,
        plan:          site.plan,
        planLimits,
        cfToken, cfAccountId, cfEmail,
        initialDomain: site.initial_domain || null,
        userId:        payload.id,
        isAdmin:       payload.role === "admin",
        featureFlags: {
          cacheCloud: await isSubscribed(env, payload.id, "cachecloud"),
          cp3: await isSubscribed(env, payload.id, "cp3"),
        },
        log,
      });

      if (!result || !result.success) {
        const errMsg = result?.error || "프로비저닝 실패 (알 수 없는 오류)";
        await log(`❌ 프로비저닝 실패: ${errMsg}`, "error");
        await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?").bind(siteId).run().catch(() => {});
        await sendNotification({ success: false, siteName: site.site_name, error: errMsg });
        return;
      }

      const {
        workerName, workerDomain, cfPagesUrl,
        githubOwner, githubRepo,
        kvCacheId,
        wpAdminUser, wpAdminPass, wpAdminEmail,
        siteUrl, phpRunnerDeployed,
      } = result;

      const primaryDomain = workerDomain || cfPagesUrl || siteUrl;

      await env.DB.prepare(`
        UPDATE sites SET
          primary_domain    = ?,
          github_repo_owner = ?,
          github_repo_name  = ?,
          cf_pages_url      = ?,
          cf_pages_project  = NULL,
          cf_worker_name    = ?,
          cf_d1_id          = ?,
          cf_kv_id          = ?,
          wp_admin_user     = ?,
          wp_admin_pass     = ?,
          wp_admin_email    = ?,
          plan              = ?,
          status            = 'active'
        WHERE id = ?
      `).bind(
        primaryDomain, githubOwner || null, githubRepo || null,
        cfPagesUrl || null, workerName || null, null, kvCacheId || null,
        wpAdminUser || "admin", wpAdminPass || "", wpAdminEmail || "",
        site.plan, siteId
      ).run();

      await log("━━━ ✅ 호스팅 개설 완료 ━━━");
      await log(`사이트 URL   : ${primaryDomain}`);
      await log(`관리자       : ${primaryDomain}/wp-admin/ (${wpAdminUser})`);
      await log(`KV 캐시       : ${kvCacheId || "없음"}`);
      await log(`GitHub        : ${githubOwner ? "https://github.com/" + githubOwner + "/" + githubRepo : "없음"}`);
      await log(`PHP Runner    : ${phpRunnerDeployed ? "✅ 배포됨" : "⚠️ Actions에서 추후 배포"}`);
      await log(`WP 설치 Action: GitHub Actions install-wordpress.yml 실행 중`);
      await log(`🔄 코드 변환  : PHP→Astro, JS→TypeScript 실시간 변환 활성화됨`);

      await sendNotification({
        success: true, siteUrl: primaryDomain,
        siteName: site.site_name,
        wpAdminUser: wpAdminUser || "admin",
        wpAdminPass: wpAdminPass || "(대시보드에서 확인)",
      });

    } catch (e) {
      const msg = String(e?.message || e);
      const stk = String(e?.stack   || "").slice(0, 600);
      console.error("[Provision] FATAL:", msg, stk);
      await log("❌ 치명적 오류: " + msg, "error");
      await log("스택: " + stk, "error");
      await env.DB.prepare("UPDATE sites SET status = 'error' WHERE id = ?").bind(siteId).run().catch(() => {});
      await sendNotification({ success: false, siteName: site.site_name, error: msg });
    }
  };

  if (typeof context.waitUntil === "function") {
    context.waitUntil(run());
    return jsonOk({ ok: true, message: "프로비저닝 시작됨 (백그라운드 실행 중)" });
  }
  await run();
  return jsonOk({ ok: true, message: "프로비저닝 완료" });
}
