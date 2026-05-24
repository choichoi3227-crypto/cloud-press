// functions/api/oauth/google/callback.js
// GET /api/oauth/google/callback  ← Google OAuth 인증 후 리디렉션 콜백

export async function onRequestGet(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const code   = url.searchParams.get("code");
  const error  = url.searchParams.get("error");

  const HTML_CLOSE = (msg, success) => new Response(`<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>Google Drive 연동</title>
<style>body{font-family:sans-serif;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.box{text-align:center;padding:40px;background:#111;border-radius:16px;border:1px solid rgba(255,255,255,.1);max-width:400px;}
.ico{font-size:3rem;margin-bottom:16px;}
h2{margin:0 0 8px;}p{color:#9ca3af;font-size:14px;}</style></head>
<body><div class="box">
  <div class="ico">${success ? "✅" : "❌"}</div>
  <h2>${success ? "연결 완료!" : "연결 실패"}</h2>
  <p>${msg}</p>
  <p style="margin-top:16px;font-size:12px;color:#4b5563;">이 창은 닫아도 됩니다.</p>
  <script>setTimeout(()=>window.close(),2000);</script>
</div></body></html>`, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });

  if (error) {
    return HTML_CLOSE(
      `Google 인증 오류: ${error}<br><small>Google Cloud Console의 OAuth 동의 화면에서 테스트 사용자를 추가하거나 앱을 프로덕션으로 전환하세요.</small>`,
      false
    );
  }

  if (!code) {
    return HTML_CLOSE("인증 코드가 없습니다.", false);
  }

  // Client ID / Secret 을 DB에서 가져오기
  const rows = await env.DB.prepare(
    "SELECT key, value FROM admin_settings WHERE key IN ('gdrive_client_id','gdrive_client_secret')"
  ).all().catch(() => ({ results: [] }));

  const s = {};
  for (const r of rows.results || []) s[r.key] = r.value;

  const clientId     = s.gdrive_client_id     || env.GDRIVE_CLIENT_ID     || "";
  const clientSecret = s.gdrive_client_secret || env.GDRIVE_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    return HTML_CLOSE("Client ID 또는 Client Secret이 설정되지 않았습니다. 관리자 시스템 설정에서 먼저 저장하세요.", false);
  }

  const redirectUri = new URL("/api/oauth/google/callback", request.url).toString();

  // code → refresh_token 교환
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      return HTML_CLOSE(
        `토큰 교환 실패: ${tokenData.error_description || tokenData.error || "알 수 없는 오류"}<br>
         <small>access_type=offline 및 prompt=consent가 필요합니다.</small>`,
        false
      );
    }

    // refresh_token을 DB에 저장
    await env.DB.prepare(
      "INSERT INTO admin_settings (key, value) VALUES ('gdrive_refresh_token', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(tokenData.refresh_token).run();

    return HTML_CLOSE("Google Drive가 성공적으로 연결되었습니다! Refresh Token이 저장되었습니다.", true);
  } catch (e) {
    return HTML_CLOSE(`오류: ${e.message}`, false);
  }
}
