// functions/api/logs.js
// GET  /api/logs?site_id=&limit=&level=&before=   → 사이트 로그 목록
// POST /api/logs                                   → 로그 수동 추가 (내부용)
// DELETE /api/logs?site_id=                        → 로그 전체 삭제

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const limit  = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const level  = url.searchParams.get("level");   // info | warning | error
  const before = url.searchParams.get("before");  // ISO 날짜 (페이지네이션)

  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  // 소유권 확인
  const site = await env.DB.prepare(
    "SELECT id, user_id, site_name, status FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    let sql    = "SELECT * FROM php_logs WHERE site_id = ?";
    const args = [siteId];

    if (level && ["info", "warning", "error"].includes(level)) {
      sql += " AND level = ?";
      args.push(level);
    }
    if (before) {
      sql += " AND created_at < ?";
      args.push(before);
    }

    sql += " ORDER BY id DESC LIMIT ?";
    args.push(limit);

    const { results } = await env.DB.prepare(sql).bind(...args).all();

    // 읽음 처리 (새 로그 알림 뱃지용)
    await env.DB.prepare(
      "UPDATE php_logs SET is_read = 1 WHERE site_id = ? AND is_read = 0"
    ).bind(siteId).run().catch(() => {});

    // 레벨별 카운트
    const counts = await env.DB.prepare(
      `SELECT level, COUNT(*) as cnt FROM php_logs WHERE site_id = ? GROUP BY level`
    ).bind(siteId).all().then(r => r.results || []).catch(() => []);

    const levelCounts = { info: 0, warning: 0, error: 0 };
    for (const c of counts) {
      if (c.level in levelCounts) levelCounts[c.level] = c.cnt;
    }

    return jsonOk({
      success: true,
      logs:    results || [],
      meta: {
        site_id:    siteId,
        site_name:  site.site_name,
        site_status: site.status,
        total:      results.length,
        level_counts: levelCounts,
        has_more:   results.length === limit,
      },
    });
  } catch (e) {
    return jsonErr("로그 조회 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_id, message, level = "info" } = body;
  if (!site_id)  return jsonErr("site_id가 필요합니다.", 400);
  if (!message)  return jsonErr("메시지를 입력해주세요.", 400);
  if (!["info", "warning", "error"].includes(level))
    return jsonErr("level은 info | warning | error 중 하나여야 합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
    ).bind(site_id, message.slice(0, 2000), level).run();
    return jsonOk({ success: true, message: "로그가 추가되었습니다." });
  } catch (e) {
    return jsonErr("로그 추가 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const logId  = url.searchParams.get("id");

  if (!siteId && !logId) return jsonErr("site_id 또는 id가 필요합니다.", 400);

  if (logId) {
    // 단일 로그 삭제
    const log = await env.DB.prepare(
      `SELECT l.*, s.user_id FROM php_logs l
       JOIN sites s ON l.site_id = s.id WHERE l.id = ?`
    ).bind(logId).first();
    if (!log) return jsonErr("로그를 찾을 수 없습니다.", 404);
    if (log.user_id !== payload.id && payload.role !== "admin")
      return jsonErr("권한이 없습니다.", 403);

    await env.DB.prepare("DELETE FROM php_logs WHERE id = ?").bind(logId).run();
    return jsonOk({ success: true, message: "로그가 삭제되었습니다." });
  }

  // 전체 로그 삭제
  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    const { meta } = await env.DB.prepare(
      "DELETE FROM php_logs WHERE site_id = ?"
    ).bind(siteId).run();
    return jsonOk({
      success: true,
      message: `로그 ${meta.changes || 0}건이 삭제되었습니다.`,
    });
  } catch (e) {
    return jsonErr("로그 삭제 오류: " + e.message, 500);
  }
}
