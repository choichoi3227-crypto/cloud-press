// functions/api/admin/ai-settings.js
// GET    /api/admin/ai-settings          → Gemini API 키 목록 + 모델 설정 조회
// POST   /api/admin/ai-settings          → Gemini API 키 추가
// DELETE /api/admin/ai-settings?id=      → Gemini API 키 삭제
// PUT    /api/admin/ai-settings          → 모델명 변경

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return null;
  if (payload.role !== "admin") return null;
  return payload;
}

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gemini_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run().catch(() => {});
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`).run().catch(() => {});
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTables(env);

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, label, SUBSTR(api_key,1,8) || '••••••••' as api_key_masked, created_at FROM gemini_settings ORDER BY id DESC"
    ).all().catch(() => ({ results: [] }));

    const modelRow = await env.DB.prepare("SELECT value FROM ai_settings WHERE key='gemini_model'").first().catch(() => null);

    return jsonOk({
      success: true,
      keys: results || [],
      model: modelRow?.value || "gemini-2.5-flash-lite-preview-06-17",
      count: results?.length || 0,
    });
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTables(env);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const { api_key, label } = body;
  if (!api_key || !api_key.trim()) return jsonErr("API 키를 입력해주세요.", 400);

  try {
    await env.DB.prepare(
      "INSERT INTO gemini_settings (api_key, label) VALUES (?, ?)"
    ).bind(api_key.trim(), label || "").run();
    return jsonOk({ success: true, message: "Gemini API 키가 추가되었습니다." });
  } catch (e) {
    return jsonErr("저장 실패: " + e.message, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTables(env);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const { model } = body;
  if (!model || !model.trim()) return jsonErr("모델명을 입력해주세요.", 400);

  try {
    await env.DB.prepare(
      "INSERT INTO ai_settings (key, value) VALUES ('gemini_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(model.trim()).run();
    return jsonOk({ success: true, message: "모델이 변경되었습니다.", model: model.trim() });
  } catch (e) {
    return jsonErr("저장 실패: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTables(env);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return jsonErr("ID가 필요합니다.", 400);

  try {
    await env.DB.prepare("DELETE FROM gemini_settings WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "API 키가 삭제되었습니다." });
  } catch (e) {
    return jsonErr("삭제 실패: " + e.message, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
