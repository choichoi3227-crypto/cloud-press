// functions/api/account.js
// GET  /api/account  → 내 계정 정보 조회
// PUT  /api/account  → CF API 키 + 이메일 검증 후 저장
import { jsonOk, jsonErr, requireAuth, dbGetUserById, dbUpdateUserCfKey, validateCfApiKey } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  try {
    const user = await dbGetUserById(env.DB, payload.id);
    if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);
    return jsonOk({
      id:       user.id,
      email:    user.email,
      role:     user.role,
      plan:     user.plan || "free",
      hasCfKey: !!user.cf_global_api_key,
      cfEmail:  user.cf_email || "",
    });
  } catch (e) {
    return jsonErr("계정 조회 오류: " + e.message, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { cf_api_key, cf_email } = body;
  if (!cf_api_key) return jsonErr("API 키를 입력해주세요.", 400);
  if (!cf_email)   return jsonErr("Cloudflare 계정 이메일을 입력해주세요.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cf_email))
    return jsonErr("올바른 이메일 형식이 아닙니다.", 400);

  // Cloudflare API 키 실시간 검증
  const valid = await validateCfApiKey(cf_api_key, cf_email);
  if (!valid) return jsonErr("Cloudflare API 키 또는 이메일이 올바르지 않습니다. 다시 확인해주세요.", 400);

  try {
    await dbUpdateUserCfKey(env.DB, payload.id, cf_api_key, cf_email);
    return jsonOk({ success: true, message: "Cloudflare API 키가 검증되어 저장되었습니다." });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}
