// functions/api/admin/[[path]].js
// Cloudflare Pages Functions catch-all router for /api/admin/*
// /api/admin/stats, /api/admin/users, /api/admin/sites 등 모든 서브경로를
// admin.js 핸들러로 위임합니다.
// 주의: 같은 디렉토리의 구체적인 파일(ai-settings.js, cms-settings.js, inquiries.js)은
// CF Pages Functions에서 [[path]].js보다 우선순위가 높으므로 충돌 없음.

import {
  onRequestGet,
  onRequestPut,
  onRequestDelete,
  onRequestPost as adminPost,
} from "../admin.js";

export { onRequestGet, onRequestPut, onRequestDelete };

// OPTIONS (CORS 프리플라이트) 처리
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// POST → admin.js로 위임 (정의되어 있으면 사용, 없으면 405)
export async function onRequestPost(context) {
  if (typeof adminPost === "function") {
    return adminPost(context);
  }
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
