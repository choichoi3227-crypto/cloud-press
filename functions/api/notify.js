// functions/api/notify.js
// POST /api/notify/hosting-complete  → 호스팅 생성 완료 이메일 발송
// GET  /api/notify/site-status?id=   → 사이트 프로비저닝 상태 폴링
//
// 이메일 발송: Supabase Edge Functions / SMTP (admin_settings에 설정된 방식 사용)

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// ── 설정 조회 헬퍼 ──────────────────────────────────────────────────────────
async function getSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM admin_settings").all()
    .catch(() => ({ results: [] }));
  const s = {};
  for (const r of (rows.results || [])) s[r.key] = r.value;
  return s;
}

// ── Supabase 이메일 발송 ────────────────────────────────────────────────────
async function sendViaSupabase(settings, to, subject, html) {
  const url = settings.supabase_url;
  const key = settings.supabase_service_key;
  if (!url || !key) throw new Error("Supabase 설정이 없습니다.");

  const res = await fetch(`${url}/functions/v1/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${key}`,
    },
    body: JSON.stringify({
      to,
      subject,
      html,
      from: settings.smtp_from || settings.support_email || "noreply@cloudpress.app",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Supabase 이메일 오류 (${res.status})`);
  return data;
}

// ── SMTP 직접 발송 (Cloudflare Email Workers 방식) ──────────────────────────
// Cloudflare Email Workers가 없을 경우 Supabase로 fallback
async function sendEmail(env, to, subject, html) {
  const settings = await getSettings(env);

  // Supabase Edge Function 방식 (권장)
  if (settings.supabase_url && settings.supabase_service_key) {
    return sendViaSupabase(settings, to, subject, html);
  }

  // Cloudflare Email Workers 바인딩 방식
  if (env.EMAIL) {
    const msg = {
      from: { email: settings.smtp_from || "noreply@cloudpress.app", name: "CloudPress" },
      to:   [{ email: to }],
      subject,
      content: [{ type: "text/html", value: html }],
    };
    await env.EMAIL.send(msg);
    return { sent: true };
  }

  throw new Error(
    "이메일 발송 설정이 없습니다. 관리자 설정에서 Supabase URL/키를 입력하거나 Cloudflare Email Workers를 연결해주세요."
  );
}

// ── 호스팅 완료 이메일 HTML 템플릿 ─────────────────────────────────────────
function buildCompletionEmail({ siteName, domain, siteId, platformDomain }) {
  const siteUrl   = `https://${domain}`;
  const detailUrl = `https://${platformDomain || "cloudpress.app"}/hosting-detail?id=${siteId}`;
  const wpAdminUrl = `https://${domain}/wp-admin`;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>호스팅 생성 완료</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Apple SD Gothic Neo',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
    <!-- 헤더 -->
    <tr>
      <td style="background:linear-gradient(135deg,#1d4ed8,#4f46e5);padding:32px 40px;text-align:center;">
        <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;">☁ CloudPress</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;">WordPress 서버리스 호스팅</div>
      </td>
    </tr>
    <!-- 본문 -->
    <tr>
      <td style="padding:40px;">
        <div style="font-size:22px;font-weight:700;color:#fff;margin-bottom:8px;">
          🎉 호스팅 생성이 완료되었습니다!
        </div>
        <div style="font-size:14px;color:#9ca3af;margin-bottom:32px;">
          <strong style="color:#e5e7eb">${siteName}</strong> 호스팅이 성공적으로 준비되었습니다.<br>
          Cloudflare Worker, D1 데이터베이스, KV 스토리지가 모두 연결되었습니다.
        </div>

        <!-- 사이트 정보 -->
        <div style="background:#1a1a1a;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:20px;margin-bottom:24px;">
          <div style="font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;">사이트 정보</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:6px 0;color:#9ca3af;font-size:13px;width:110px;">사이트 이름</td>
              <td style="padding:6px 0;color:#f3f4f6;font-size:13px;font-weight:600;">${siteName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#9ca3af;font-size:13px;">도메인</td>
              <td style="padding:6px 0;font-size:13px;">
                <a href="${siteUrl}" style="color:#60a5fa;text-decoration:none;font-family:monospace;">${domain}</a>
              </td>
            </tr>
          </table>
        </div>

        <!-- 바로가기 버튼 -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="padding-right:8px;" width="50%">
              <a href="${siteUrl}" style="display:block;background:#1d4ed8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:14px;">
                🌐 사이트 방문
              </a>
            </td>
            <td style="padding-left:8px;" width="50%">
              <a href="${wpAdminUrl}" style="display:block;background:#0f172a;border:1px solid rgba(255,255,255,0.15);color:#e5e7eb;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:14px;">
                🔧 WP 관리자
              </a>
            </td>
          </tr>
          <tr><td colspan="2" style="padding-top:10px;">
            <a href="${detailUrl}" style="display:block;background:#064e3b;border:1px solid rgba(16,185,129,0.3);color:#34d399;text-decoration:none;text-align:center;padding:12px;border-radius:10px;font-weight:600;font-size:13px;">
              📊 콘솔에서 호스팅 관리하기 →
            </a>
          </td></tr>
        </table>

        <!-- 안내 -->
        <div style="background:#1e3a5f;border:1px solid rgba(59,130,246,0.25);border-radius:10px;padding:16px;font-size:12px;color:#93c5fd;line-height:1.7;">
          <strong style="color:#60a5fa;">📌 다음 단계</strong><br>
          1. WordPress 관리자 페이지에서 초기 설정을 완료하세요<br>
          2. 콘솔 → 도메인 탭에서 커스텀 도메인을 연결할 수 있습니다<br>
          3. GitHub 파일 업로드가 완료되면 테마·플러그인이 활성화됩니다 (최대 15분)
        </div>
      </td>
    </tr>
    <!-- 푸터 -->
    <tr>
      <td style="padding:20px 40px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;">
        <div style="font-size:11px;color:#4b5563;">
          CloudPress · 서버리스 WordPress 호스팅<br>
          이 이메일은 자동 발송되었습니다
        </div>
      </td>
    </tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ── GET /api/notify/site-status?id= ────────────────────────────────────────
// 호스팅 생성 상태 폴링 (인증 필요)
async function handleGetStatus(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("id");
  if (!siteId) return jsonErr("사이트 ID가 필요합니다.", 400);

  const site = await env.DB.prepare(
    `SELECT id, site_name, primary_domain, status, cf_worker_name, github_repo_name,
            cf_d1_id, cf_kv_id, created_at
     FROM sites WHERE id = ? AND user_id = ?`
  ).bind(siteId, payload.id).first();

  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

  // 최근 로그 가져오기
  const logs = await env.DB.prepare(
    "SELECT message, level, created_at FROM php_logs WHERE site_id = ? ORDER BY rowid DESC LIMIT 20"
  ).bind(siteId).all().catch(() => ({ results: [] }));

  // 완료 여부 체크
  const isComplete = site.status === "active";
  const isError    = site.status === "error";

  // WP 설치 완료 여부 (로그에서 확인)
  const allLogs    = (logs.results || []).map(l => l.message);
  const wpDone     = allLogs.some(m => m.includes("WordPress 설치 완료") || m.includes("cloudpress-installed"));
  const workerDone = allLogs.some(m => m.includes("Worker 생성 완료"));
  const d1Done     = allLogs.some(m => m.includes("D1 생성 완료") || m.includes("D1 데이터베이스 생성 완료") || m.includes("D1 생성 완료"));
  const ghDone     = allLogs.some(m => m.includes("GitHub 저장소 생성 완료"));

  return jsonOk({
    success: true,
    id:     site.id,
    status: site.status,
    site_name: site.site_name,
    domain:    site.primary_domain,
    is_complete: isComplete,
    is_error:    isError,
    steps: {
      github:  ghDone,
      d1:      d1Done,
      worker:  workerDone,
      wp_init: allLogs.some(m => m.includes("WordPress DB 초기화 완료")),
      wp_files: wpDone,
    },
    logs: (logs.results || []).slice(0, 10).reverse(),
  });
}

// ── POST /api/notify/hosting-complete ──────────────────────────────────────
// 호스팅 완료 이메일 발송 (내부 호출 또는 인증된 사용자)
async function handleSendComplete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const { site_id } = body;
  if (!site_id) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, site_name, primary_domain, status, user_id FROM sites WHERE id = ?"
  ).bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin") return jsonErr("권한 없음", 403);

  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(site.user_id).first();
  if (!user?.email) return jsonErr("사용자 이메일 없음", 404);

  const settings = await getSettings(env);
  const platformDomain = settings.platform_domain || "cloudpress.app";

  const html = buildCompletionEmail({
    siteName:       site.site_name,
    domain:         site.primary_domain || `${site.id}.workers.dev`,
    siteId:         site.id,
    platformDomain,
  });

  try {
    await sendEmail(
      env,
      user.email,
      `[CloudPress] ${site.site_name} 호스팅 생성이 완료되었습니다! 🎉`,
      html
    );
    // 발송 기록
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, 'info')"
    ).bind(site.id, `완료 이메일 발송: ${user.email}`).run().catch(() => {});

    return jsonOk({ success: true, message: `완료 이메일이 ${user.email}로 발송되었습니다.` });
  } catch (e) {
    return jsonErr("이메일 발송 오류: " + e.message, 500);
  }
}

// ── 라우터 ──────────────────────────────────────────────────────────────────
function getSubPath(context) {
  const url = new URL(context.request.url);
  return url.pathname.replace(/^.*\/api\/notify\/?/, "").replace(/\?.*$/, "");
}

export async function onRequestGet(context) {
  const sub = getSubPath(context);
  if (sub === "site-status" || sub === "site-status/") return handleGetStatus(context);
  return jsonErr("알 수 없는 경로", 404);
}

export async function onRequestPost(context) {
  const sub = getSubPath(context);
  if (sub === "hosting-complete" || sub === "hosting-complete/") return handleSendComplete(context);
  return jsonErr("알 수 없는 경로", 404);
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
