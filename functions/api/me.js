// functions/api/me.js  →  GET /api/me
// 현재 로그인된 유저 정보 반환
import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);
  return jsonOk({ id: payload.id, email: payload.email, role: payload.role });
}
