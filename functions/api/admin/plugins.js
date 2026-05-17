// functions/api/admin/plugins.js
// POST /api/admin/plugins  → 플러그인 zip을 KV에 저장 (wp-rocket 등)
// GET  /api/admin/plugins  → 등록된 플러그인 목록 조회

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// ── GET: 플러그인 목록 ────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  const plugins = [];

  // aibp-pro: 코드에 내장됨
  plugins.push({
    slug:        "aibp-pro",
    name:        "AIBP Pro: AI Blog Posting",
    source:      "built-in",
    description: "AI 블로그 자동 작성 플러그인 (내장)",
    status:      "ready",
  });

  // wp-rocket: KV에 있는지 확인
  let wpRocketStatus = "not_uploaded";
  let wpRocketSize   = null;
  try {
    if (env?.KV) {
      const meta = await env.KV.get("plugin:wp-rocket:meta", "json").catch(() => null);
      if (meta) {
        wpRocketStatus = "ready";
        wpRocketSize   = meta.size;
      }
    }
  } catch {}

  plugins.push({
    slug:        "wp-rocket",
    name:        "WP Rocket",
    source:      "kv",
    description: "WordPress 캐싱 & 성능 최적화 플러그인",
    status:      wpRocketStatus,
    size:        wpRocketSize,
  });

  return jsonOk({ plugins });
}

// ── POST: 플러그인 zip 업로드 ─────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 본문 파싱 오류.", 400); }

  const { slug, filename, size, data } = body;

  if (!slug || !data)       return jsonErr("slug와 data가 필요합니다.", 400);
  if (!filename?.endsWith(".zip")) return jsonErr("zip 파일만 허용됩니다.", 400);
  if (size > 20 * 1024 * 1024)    return jsonErr("파일 크기가 20MB를 초과합니다.", 400);

  const allowedSlugs = ["wp-rocket"];
  if (!allowedSlugs.includes(slug)) return jsonErr(`허용되지 않는 플러그인: ${slug}`, 400);

  if (!env?.KV) return jsonErr("KV 바인딩이 없습니다.", 503);

  try {
    // KV에 base64 데이터 저장 (최대 25MB KV 값 한도)
    await env.KV.put(`plugin:${slug}:zip-base64`, data);
    await env.KV.put(`plugin:${slug}:meta`, JSON.stringify({
      filename,
      size,
      uploaded_at: new Date().toISOString(),
    }));

    return jsonOk({
      message:     `${slug} 플러그인 업로드 완료`,
      slug,
      filename,
      size,
      uploaded_at: new Date().toISOString(),
    });
  } catch (e) {
    return jsonErr(`KV 저장 오류: ${e.message}`, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
