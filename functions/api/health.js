// functions/api/health.js  →  GET /api/health
import { jsonOk, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { env, request } = context;

  // 인증된 사용자의 CF 설정 여부 확인
  let cf_configured = false;
  try {
    const payload = await requireAuth(request, env).catch(() => null);
    if (payload) {
      const u = await env.DB.prepare(
        "SELECT cf_global_api_key, cf_account_id FROM users WHERE id = ?"
      ).bind(payload.id).first().catch(() => null);
      cf_configured = !!(u?.cf_global_api_key && u?.cf_account_id);
    }
  } catch {}

  // GitHub 토큰 여부 (env 변수 또는 DB)
  let github_token = !!env.GITHUB_TOKEN;
  if (!github_token) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id FROM github_tokens WHERE active = 1 LIMIT 1"
      ).all();
      github_token = (results?.length ?? 0) > 0;
    } catch {}
  }

  return jsonOk({
    status:       "ok",
    github_token,
    cf_configured,
    bindings: {
      DB:       !!env.DB,
      SESSIONS: !!env.SESSIONS,
      CACHE:    !!env.CACHE,
    },
    secrets: {
      JWT_SECRET:     !!env.JWT_SECRET,
      CF_API_TOKEN:   !!env.CF_API_TOKEN,
      CF_ACCOUNT_ID:  !!env.CF_ACCOUNT_ID,
      GITHUB_TOKEN:   !!env.GITHUB_TOKEN,
      PURGE_KEY:      !!env.PURGE_KEY,
      ENCRYPTION_KEY: !!env.ENCRYPTION_KEY,
    },
    ts: new Date().toISOString(),
  });
}
