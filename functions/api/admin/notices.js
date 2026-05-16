// functions/api/admin/notices.js
// GET    /api/admin/notices        → 공지 목록 (공개 포함)
// GET    /api/admin/notices?id=    → 단건 조회
// POST   /api/admin/notices        → 공지 생성 (어드민 전용)
// PUT    /api/admin/notices?id=    → 공지 수정 (어드민 전용)
// DELETE /api/admin/notices?id=    → 공지 삭제 (어드민 전용)

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return null;
  if (payload.role !== "admin") return null;
  return payload;
}

async function ensureTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    type       TEXT DEFAULT 'info',
    is_active  INTEGER DEFAULT 1,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run().catch(() => {});
}

// GET - 공지 목록 또는 단건 (인증 없이 공개 조회 가능, 어드민은 전체 조회)
export async function onRequestGet(context) {
  const { request, env } = context;
  await ensureTable(env);

  const url    = new URL(request.url);
  const id     = url.searchParams.get("id");
  const pub    = url.searchParams.get("public") === "1"; // 공개 조회 모드

  // 단건 조회
  if (id) {
    const notice = await env.DB.prepare(
      "SELECT * FROM notices WHERE id = ?"
    ).bind(id).first();
    if (!notice) return jsonErr("공지를 찾을 수 없습니다.", 404);
    return jsonOk({ success: true, notice });
  }

  // 목록 조회 (공개 모드: is_active=1만, 어드민: 전체)
  let notices;
  if (pub) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM notices WHERE is_active = 1 ORDER BY created_at DESC"
    ).all();
    notices = results;
  } else {
    // 어드민 인증 확인
    const payload = await requireAdmin(request, env);
    if (!payload) return jsonErr("관리자 권한이 필요합니다.", 403);
    const { results } = await env.DB.prepare(
      "SELECT * FROM notices ORDER BY created_at DESC"
    ).all();
    notices = results;
  }

  return jsonOk({ success: true, notices });
}

// POST - 공지 생성
export async function onRequestPost(context) {
  const { request, env } = context;
  await ensureTable(env);

  const payload = await requireAdmin(request, env);
  if (!payload) return jsonErr("관리자 권한이 필요합니다.", 403);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { title, content, type = "info", is_active = 1 } = body;
  if (!title?.trim()) return jsonErr("제목을 입력해주세요.", 400);
  if (!content?.trim()) return jsonErr("내용을 입력해주세요.", 400);

  const validTypes = ["info", "warning", "danger", "success"];
  if (!validTypes.includes(type)) return jsonErr("올바른 공지 유형이 아닙니다.", 400);

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "INSERT INTO notices (title, content, type, is_active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(title.trim(), content.trim(), type, is_active ? 1 : 0, payload.id, now, now).run();

  return jsonOk({ success: true, message: "공지가 등록되었습니다.", id: result.meta?.last_row_id });
}

// PUT - 공지 수정
export async function onRequestPut(context) {
  const { request, env } = context;
  await ensureTable(env);

  const payload = await requireAdmin(request, env);
  if (!payload) return jsonErr("관리자 권한이 필요합니다.", 403);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("공지 ID가 필요합니다.", 400);

  const notice = await env.DB.prepare("SELECT id FROM notices WHERE id = ?").bind(id).first();
  if (!notice) return jsonErr("공지를 찾을 수 없습니다.", 404);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { title, content, type, is_active } = body;
  const fields = [];
  const values = [];

  if (title !== undefined)     { fields.push("title = ?");     values.push(title.trim()); }
  if (content !== undefined)   { fields.push("content = ?");   values.push(content.trim()); }
  if (type !== undefined)      { fields.push("type = ?");      values.push(type); }
  if (is_active !== undefined) { fields.push("is_active = ?"); values.push(is_active ? 1 : 0); }

  if (!fields.length) return jsonErr("수정할 항목이 없습니다.", 400);

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  await env.DB.prepare(
    `UPDATE notices SET ${fields.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return jsonOk({ success: true, message: "공지가 수정되었습니다." });
}

// DELETE - 공지 삭제
export async function onRequestDelete(context) {
  const { request, env } = context;
  await ensureTable(env);

  const payload = await requireAdmin(request, env);
  if (!payload) return jsonErr("관리자 권한이 필요합니다.", 403);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("공지 ID가 필요합니다.", 400);

  const notice = await env.DB.prepare("SELECT id FROM notices WHERE id = ?").bind(id).first();
  if (!notice) return jsonErr("공지를 찾을 수 없습니다.", 404);

  await env.DB.prepare("DELETE FROM notices WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "공지가 삭제되었습니다." });
}
