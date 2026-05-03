// functions/api/admin/inquiries.js
// GET  /api/admin/inquiries        → 문의 목록
// GET  /api/admin/inquiries?id=    → 단건 조회
// PUT  /api/admin/inquiries?id=    → 답변 달기 / 상태 변경
// DELETE /api/admin/inquiries?id=  → 문의 삭제

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return null;
  if (payload.role !== "admin") return null;
  return payload;
}

async function ensureTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS support_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT DEFAULT '',
    message TEXT NOT NULL,
    user_id TEXT DEFAULT NULL,
    status TEXT DEFAULT 'open',
    admin_reply TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    replied_at TEXT DEFAULT NULL
  )`).run().catch(() => {});
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTable(env);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const status = url.searchParams.get("status") || "";
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    if (id) {
      const row = await env.DB.prepare("SELECT * FROM support_inquiries WHERE id = ?").bind(id).first();
      if (!row) return jsonErr("문의를 찾을 수 없습니다.", 404);
      return jsonOk({ success: true, inquiry: row });
    }

    let query, args;
    if (status) {
      query = "SELECT * FROM support_inquiries WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?";
      args = [status, limit, offset];
    } else {
      query = "SELECT * FROM support_inquiries ORDER BY id DESC LIMIT ? OFFSET ?";
      args = [limit, offset];
    }

    const { results } = await env.DB.prepare(query).bind(...args).all();
    const totalRow = await env.DB.prepare(
      status ? "SELECT COUNT(*) as cnt FROM support_inquiries WHERE status = ?" : "SELECT COUNT(*) as cnt FROM support_inquiries"
    ).bind(...(status ? [status] : [])).first();

    const openRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM support_inquiries WHERE status='open'").first();

    return jsonOk({
      success: true,
      inquiries: results || [],
      total: totalRow?.cnt || 0,
      open_count: openRow?.cnt || 0,
      page,
      limit,
    });
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTable(env);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return jsonErr("ID가 필요합니다.", 400);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  try {
    const { admin_reply, status } = body;
    if (admin_reply !== undefined) {
      await env.DB.prepare(
        "UPDATE support_inquiries SET admin_reply = ?, status = 'replied', replied_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(admin_reply, id).run();
      return jsonOk({ success: true, message: "답변이 저장되었습니다." });
    }
    if (status) {
      await env.DB.prepare("UPDATE support_inquiries SET status = ? WHERE id = ?").bind(status, id).run();
      return jsonOk({ success: true, message: "상태가 변경되었습니다." });
    }
    return jsonErr("변경할 항목이 없습니다.", 400);
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);
  await ensureTable(env);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return jsonErr("ID가 필요합니다.", 400);

  try {
    await env.DB.prepare("DELETE FROM support_inquiries WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "문의가 삭제되었습니다." });
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
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
