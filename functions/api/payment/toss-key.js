// functions/api/payment/toss-key.js
// GET /api/payment/toss-key → 토스페이먼츠 클라이언트 키 반환 (공개 키만)

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  // 어드민 설정에서 토스페이먼츠 클라이언트 키 조회
  const setting = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'toss_client_key'"
  ).first().catch(() => null);

  const clientKey = setting?.value || env.TOSS_CLIENT_KEY || null;

  // 사용자 고유 키 생성 (빌링키 발급용)
  const customerKey = `cp_user_${payload.id}`;

  return jsonOk({ 
    success: true, 
    client_key: clientKey,
    customer_key: customerKey
  });
}
