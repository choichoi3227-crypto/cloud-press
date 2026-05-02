// functions/api/payment/cards.js
// GET    /api/payment/cards     → 카드 목록
// POST   /api/payment/cards     → 카드 추가 (토스페이먼츠 빌링키 등록)
// PATCH  /api/payment/cards     → 기본 카드 설정
// DELETE /api/payment/cards?id= → 카드 삭제

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, card_name, brand, last4, exp_month, exp_year, is_default, created_at FROM payment_cards WHERE user_id = ? ORDER BY is_default DESC, id DESC"
    ).bind(payload.id).all();
    return jsonOk({ success: true, cards: results || [] });
  } catch {
    return jsonOk({ success: true, cards: [] });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { billing_key, card_name, brand, last4, exp_month, exp_year } = body;
  if (!billing_key) return jsonErr("billing_key가 필요합니다.", 400);

  // 기존 카드가 있으면 is_default = 0으로 초기화
  const existing = await env.DB.prepare("SELECT COUNT(*) as cnt FROM payment_cards WHERE user_id = ?").bind(payload.id).first();
  const isDefault = (existing?.cnt || 0) === 0 ? 1 : 0;

  try {
    await env.DB.prepare(
      `INSERT INTO payment_cards (user_id, billing_key, card_name, brand, last4, exp_month, exp_year, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(payload.id, billing_key, card_name || '카드', brand || '', last4 || '', exp_month || '', exp_year || '', isDefault).run();

    return jsonOk({ success: true, message: "카드가 등록되었습니다." });
  } catch (e) {
    return jsonErr("카드 등록에 실패했습니다: " + e.message, 500);
  }
}

export async function onRequestPatch(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { card_id } = body;
  if (!card_id) return jsonErr("card_id가 필요합니다.", 400);

  try {
    await env.DB.prepare("UPDATE payment_cards SET is_default = 0 WHERE user_id = ?").bind(payload.id).run();
    await env.DB.prepare("UPDATE payment_cards SET is_default = 1 WHERE id = ? AND user_id = ?").bind(card_id, payload.id).run();
    return jsonOk({ success: true, message: "기본 결제 수단이 변경되었습니다." });
  } catch (e) {
    return jsonErr("변경에 실패했습니다.", 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("id가 필요합니다.", 400);

  try {
    await env.DB.prepare("DELETE FROM payment_cards WHERE id = ? AND user_id = ?").bind(id, payload.id).run();
    return jsonOk({ success: true, message: "카드가 삭제되었습니다." });
  } catch (e) {
    return jsonErr("삭제에 실패했습니다.", 500);
  }
}
