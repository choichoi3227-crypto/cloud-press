// functions/api/dns.js
// GET    /api/dns?domain=&site_id=       → DNS 레코드 목록 (Cloudflare API)
// POST   /api/dns                        → DNS 레코드 추가
// PUT    /api/dns                        → DNS 레코드 수정
// DELETE /api/dns?record_id=&domain=&site_id= → DNS 레코드 삭제

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

async function cfReq(method, path, apiKey, email, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      "X-Auth-Key":   apiKey,
      "X-Auth-Email": email,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// 도메인으로 Zone ID 조회 (DB 캐시 우선)
async function getZoneId(env, userId, domain) {
  // domain_aliases에서 cf_zone_id 조회
  const da = await env.DB.prepare(
    "SELECT cf_zone_id FROM domain_aliases WHERE domain = ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)"
  ).bind(domain, userId).first();

  if (da?.cf_zone_id) return da.cf_zone_id;

  // 없으면 CF API에서 조회
  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(userId).first();

  if (!user?.cf_global_api_key || !user?.cf_email) return null;

  // 루트 도메인 추출
  const parts = domain.split(".");
  const root = parts.length > 2 ? parts.slice(-2).join(".") : domain;

  const res = await cfReq("GET", `/zones?name=${encodeURIComponent(root)}&per_page=1`, user.cf_global_api_key, user.cf_email);
  return res.result?.[0]?.id || null;
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const domain  = url.searchParams.get("domain");
  const siteId  = url.searchParams.get("site_id");

  if (!domain) return jsonErr("domain 파라미터가 필요합니다.", 400);

  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();

  if (!user?.cf_global_api_key || !user?.cf_email) {
    return jsonErr("Cloudflare API 키가 설정되어 있지 않습니다. 계정 설정에서 먼저 등록해주세요.", 400);
  }

  const zoneId = await getZoneId(env, payload.id, domain);
  if (!zoneId) return jsonErr("Cloudflare Zone을 찾을 수 없습니다. 도메인을 먼저 등록해주세요.", 404);

  // DNS 레코드 + Zone 정보를 병렬로 조회
  const [recsRes, zoneRes] = await Promise.all([
    cfReq("GET", `/zones/${zoneId}/dns_records?per_page=100&order=type`, user.cf_global_api_key, user.cf_email),
    cfReq("GET", `/zones/${zoneId}`, user.cf_global_api_key, user.cf_email),
  ]);

  if (!recsRes.success) {
    return jsonErr(recsRes.errors?.[0]?.message || "DNS 레코드를 가져오지 못했습니다.", 500);
  }

  const records = (recsRes.result || []).map(r => ({
    id:          r.id,
    type:        r.type,
    name:        r.name,
    content:     r.content,
    ttl:         r.ttl,
    proxied:     r.proxied,
    priority:    r.priority,
    zone_id:     r.zone_id,
    created_on:  r.created_on,
    modified_on: r.modified_on,
  }));

  // Zone 메타 정보
  const zoneData = zoneRes.result || {};
  const zone_status   = zoneData.status || "unknown";
  const nameservers   = (zone_status !== "active" && zoneData.name_servers?.length)
    ? zoneData.name_servers
    : [];

  return jsonOk({ success: true, records, zone_id: zoneId, zone_status, nameservers });
}

// ── POST (추가) ───────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { domain, site_id, type, name, content, ttl, proxied, priority } = body;
  if (!domain || !type || !name || !content) {
    return jsonErr("domain, type, name, content는 필수입니다.", 400);
  }

  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();
  if (!user?.cf_global_api_key) return jsonErr("Cloudflare API 키가 설정되어 있지 않습니다.", 400);

  const zoneId = await getZoneId(env, payload.id, domain);
  if (!zoneId) return jsonErr("Cloudflare Zone을 찾을 수 없습니다.", 404);

  const recordBody = { type, name, content, ttl: ttl || 1 };
  if (typeof proxied === 'boolean') recordBody.proxied = proxied;
  if (type === 'MX' && priority) recordBody.priority = priority;

  const res = await cfReq("POST", `/zones/${zoneId}/dns_records`, user.cf_global_api_key, user.cf_email, recordBody);
  if (!res.success) {
    return jsonErr(res.errors?.[0]?.message || "DNS 레코드 추가에 실패했습니다.", 500);
  }

  return jsonOk({ success: true, message: "DNS 레코드가 추가되었습니다.", record: res.result });
}

// ── PUT (수정) ────────────────────────────────────────────────────────────────
export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { domain, record_id, type, name, content, ttl, proxied, priority } = body;
  if (!domain || !record_id || !type || !name || !content) {
    return jsonErr("domain, record_id, type, name, content는 필수입니다.", 400);
  }

  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();
  if (!user?.cf_global_api_key) return jsonErr("Cloudflare API 키가 설정되어 있지 않습니다.", 400);

  const zoneId = await getZoneId(env, payload.id, domain);
  if (!zoneId) return jsonErr("Cloudflare Zone을 찾을 수 없습니다.", 404);

  const recordBody = { type, name, content, ttl: ttl || 1 };
  if (typeof proxied === 'boolean') recordBody.proxied = proxied;
  if (type === 'MX' && priority) recordBody.priority = priority;

  const res = await cfReq("PUT", `/zones/${zoneId}/dns_records/${record_id}`, user.cf_global_api_key, user.cf_email, recordBody);
  if (!res.success) {
    return jsonErr(res.errors?.[0]?.message || "DNS 레코드 수정에 실패했습니다.", 500);
  }

  return jsonOk({ success: true, message: "DNS 레코드가 수정되었습니다.", record: res.result });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url      = new URL(request.url);
  const recordId = url.searchParams.get("record_id");
  const domain   = url.searchParams.get("domain");

  if (!recordId || !domain) return jsonErr("record_id와 domain이 필요합니다.", 400);

  const user = await env.DB.prepare(
    "SELECT cf_global_api_key, cf_email FROM users WHERE id = ?"
  ).bind(payload.id).first();
  if (!user?.cf_global_api_key) return jsonErr("Cloudflare API 키가 설정되어 있지 않습니다.", 400);

  const zoneId = await getZoneId(env, payload.id, domain);
  if (!zoneId) return jsonErr("Cloudflare Zone을 찾을 수 없습니다.", 404);

  const res = await cfReq("DELETE", `/zones/${zoneId}/dns_records/${recordId}`, user.cf_global_api_key, user.cf_email);
  if (!res.success) {
    return jsonErr(res.errors?.[0]?.message || "DNS 레코드 삭제에 실패했습니다.", 500);
  }

  return jsonOk({ success: true, message: "DNS 레코드가 삭제되었습니다." });
}
