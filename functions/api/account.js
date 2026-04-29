// functions/api/account.js
// GET  /api/account  → 내 계정 정보 조회
// PUT  /api/account  → CF API 키 등 설정 저장
import { jsonOk, jsonErr, requireAuth, dbGetUserById, dbUpdateUserCfKey } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  try {
    const user = await dbGetUserById(env.DB, payload.id);
    if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);
    return jsonOk({
      id:    user.id,
      email: user.email,
      role:  user.role,
      hasCfKey: !!user.cf_global_api_key,
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

  const { cf_api_key } = body;
  if (!cf_api_key) return jsonErr("저장할 값이 없습니다.", 400);

  try {
    await dbUpdateUserCfKey(env.DB, payload.id, cf_api_key);
    return jsonOk({ success: true, message: "설정이 저장되었습니다." });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}
