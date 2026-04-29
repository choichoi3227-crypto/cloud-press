// functions/api/sites.js
// GET  /api/sites        → 내 사이트 목록
// POST /api/sites        → 새 사이트 생성
// DELETE /api/sites?id=  → 사이트 삭제
import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, site_name, primary_domain, php_version, status, is_throttled FROM sites WHERE user_id = ? ORDER BY rowid DESC"
    ).bind(payload.id).all();
    return jsonOk({ success: true, sites: results });
  } catch (e) {
    return jsonErr("사이트 목록 조회 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_name, primary_domain, php_version = "8.2" } = body;
  if (!site_name || !primary_domain) return jsonErr("사이트 이름과 도메인을 입력해주세요.", 400);

  try {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO sites (id, user_id, site_name, primary_domain, php_version, status) VALUES (?, ?, ?, ?, ?, 'active')"
    ).bind(id, payload.id, site_name, primary_domain, php_version).run();
    return jsonOk({ success: true, id, message: "사이트가 생성되었습니다." });
  } catch (e) {
    return jsonErr("사이트 생성 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  try {
    // 본인 소유 확인
    const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?")
      .bind(id, payload.id).first();
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "사이트가 삭제되었습니다." });
  } catch (e) {
    return jsonErr("사이트 삭제 오류: " + e.message, 500);
  }
}
