// functions/api/admin/[[path]].js
// /api/admin/* 모든 경로를 처리하는 통합 라우터
//
// CF Pages Functions에서 같은 디렉터리의 구체 파일(inquiries.js, ai-settings.js,
// cms-settings.js)이 우선 처리되므로, 그 외 경로(stats, users, sites, settings 등)는
// 이 [[path]].js → admin.js로 위임한다.
// inquiries, ai-settings, cms-settings는 해당 파일에서 직접 import해서 라우팅한다.

import {
  onRequestGet    as adminGet,
  onRequestPost   as adminPost,
  onRequestPut    as adminPut,
  onRequestDelete as adminDelete,
} from "../admin.js";

import {
  onRequestGet    as inquiriesGet,
  onRequestPut    as inquiriesPut,
  onRequestDelete as inquiriesDelete,
  onRequestOptions as inquiriesOptions,
} from "./inquiries.js";

import {
  onRequestGet    as aiGet,
  onRequestPost   as aiPost,
  onRequestPut    as aiPut,
  onRequestDelete as aiDelete,
} from "./ai-settings.js";

import {
  onRequestGet  as cmsGet,
  onRequestPost as cmsPost,
} from "./cms-settings.js";

// sub-path 추출 헬퍼
function subPath(context) {
  if (context.params?.path) {
    const p = Array.isArray(context.params.path)
      ? context.params.path.join("/")
      : context.params.path;
    return p.replace(/^\/+|\/+$/g, "");
  }
  const url = new URL(context.request.url);
  return url.pathname
    .replace(/^.*\/api\/admin\/?/, "")
    .replace(/\?.*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

// ── OPTIONS ──────────────────────────────────────────────────────────────────
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

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const sub = subPath(context);
  if (sub === "inquiries")   return inquiriesGet(context);
  if (sub === "ai-settings") return aiGet(context);
  if (sub === "cms-settings") return cmsGet(context);
  // stats, users, sites, settings, quota-stats → admin.js
  return adminGet(context);
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const sub = subPath(context);
  if (sub === "ai-settings")  return aiPost(context);
  if (sub === "cms-settings") return cmsPost(context);
  if (typeof adminPost === "function") return adminPost(context);
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

// ── PUT ───────────────────────────────────────────────────────────────────────
export async function onRequestPut(context) {
  const sub = subPath(context);
  if (sub === "inquiries")   return inquiriesPut(context);
  if (sub === "ai-settings") return aiPut(context);
  // users, sites, settings → admin.js
  return adminPut(context);
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const sub = subPath(context);
  if (sub === "inquiries")   return inquiriesDelete(context);
  if (sub === "ai-settings") return aiDelete(context);
  // users, sites → admin.js
  return adminDelete(context);
}
