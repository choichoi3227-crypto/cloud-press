// functions/api/cache.js
// GET  /api/cache?site_id=    → 캐시 설정 조회
// PUT  /api/cache             → 캐시 설정 변경
// DELETE /api/cache?site_id=  → 캐시 전체 퍼지

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, primary_domain, cache_enabled, cache_ttl FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  return jsonOk({
    success:       true,
    cache_enabled: !!site.cache_enabled,
    cache_ttl:     site.cache_ttl || 3600,
    cached_pages:  0, // 실제 환경에서는 KV key 카운트 구현
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_id, cache_enabled, cache_ttl } = body;
  if (!site_id) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare("SELECT user_id FROM sites WHERE id = ?").bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    await env.DB.prepare(
      "UPDATE sites SET cache_enabled = ?, cache_ttl = ? WHERE id = ?"
    ).bind(cache_enabled ? 1 : 0, cache_ttl || 3600, site_id).run();
    return jsonOk({ success: true, message: "캐시 설정이 저장되었습니다." });
  } catch (e) {
    return jsonErr("캐시 설정 저장 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT user_id, primary_domain FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  let purgedCount = 0;
  // KV 캐시 퍼지 (CACHE 바인딩이 있을 때만)
  if (env.CACHE) {
    try {
      // page 캐시, opt 캐시 등 site prefix 기반 삭제
      const prefixes = [
        `page:${siteId}:`,
        `opt:${siteId}:`,
        `php_version:${siteId}`,
      ];
      for (const prefix of prefixes) {
        try {
          const list = await env.CACHE.list({ prefix });
          for (const key of list.keys) {
            await env.CACHE.delete(key.name);
            purgedCount++;
          }
        } catch {}
      }
    } catch (e) {
      console.error("[cache purge]", e);
    }
  }

  return jsonOk({
    success:      true,
    message:      `캐시가 퍼지되었습니다. (${purgedCount}개 삭제)`,
    purged_count: purgedCount,
  });
}
