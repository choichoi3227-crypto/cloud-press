// functions/api/admin/[[path]].js
// Cloudflare Pages Functions catch-all router for /api/admin/*
// /api/admin/stats, /api/admin/users, /api/admin/sites 등 모든 서브경로를
// admin.js 핸들러로 위임합니다. (Unexpected token '<' 오류 수정)

import {
  onRequestGet,
  onRequestPut,
  onRequestDelete,
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

// POST 도 필요한 경우를 위해
export async function onRequestPost(context) {
  // admin.js에 POST 핸들러가 없으므로 405 반환
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
