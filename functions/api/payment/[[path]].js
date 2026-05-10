// functions/api/payment/[[path]].js
// /api/payment/* 모든 경로를 처리하는 통합 라우터
//
// CF Pages Functions에서 같은 디렉터리에 구체 파일(cards.js, toss-key.js)과
// [[path]].js가 공존하면 구체 파일이 우선 처리되어 라우팅이 분산된다.
// 대신 이 파일 하나에서 모든 sub-path를 직접 라우팅하고,
// cards.js / toss-key.js는 이 파일에서 import해서 위임한다.

import {
  onRequestGet  as paymentGet,
  onRequestPost as paymentPost,
  onRequestOptions as paymentOptions,
} from "../payment.js";

import {
  onRequestGet    as cardsGet,
  onRequestPost   as cardsPost,
  onRequestPatch  as cardsPatch,
  onRequestDelete as cardsDelete,
} from "./cards.js";

import { onRequestGet as tossKeyGet } from "./toss-key.js";

import { jsonErr } from "../../_shared.js";

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
    .replace(/^.*\/api\/payment\/?/, "")
    .replace(/\?.*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

// ── OPTIONS ──────────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const sub = subPath(context);
  if (sub === "cards")    return cardsGet(context);
  if (sub === "toss-key") return tossKeyGet(context);
  // history, site-plan, client-key → payment.js
  return paymentGet(context);
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const sub = subPath(context);
  if (sub === "cards") return cardsPost(context);
  // request, confirm → payment.js
  return paymentPost(context);
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
export async function onRequestPatch(context) {
  const sub = subPath(context);
  if (sub === "cards") return cardsPatch(context);
  return jsonErr("Method Not Allowed", 405);
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const sub = subPath(context);
  if (sub === "cards") return cardsDelete(context);
  return jsonErr("Method Not Allowed", 405);
}
