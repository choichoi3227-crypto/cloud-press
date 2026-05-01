// functions/api/domains.js
// GET    /api/domains?site_id=              → 도메인 목록 + 서버 IP
// GET    /api/domains?site_id=&domain=&verify=1 → A레코드 확인 및 자동 활성화
// POST   /api/domains                       → 도메인 추가 (중복 감지)
// DELETE /api/domains?id=                   → 도메인 삭제

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// Cloudflare Anycast IP — wrangler secret put SERVER_IP 로 주입
// 없으면 기본값 사용 (실제 배포 시 반드시 환경변수로 설정)
function getServerIp(env) {
  return env.SERVER_IP || "104.21.0.1";
}

// Cloudflare DNS-over-HTTPS로 A레코드 조회
async function lookupARecord(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Answer || []).filter(r => r.type === 1).map(r => r.data);
  } catch {
    return [];
  }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url     = new URL(request.url);
  const siteId  = url.searchParams.get("site_id");
  const domain  = url.searchParams.get("domain");
  const verify  = url.searchParams.get("verify") === "1";

  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  // 소유권 확인
  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const serverIp = getServerIp(env);

  // A레코드 확인 요청
  if (verify && domain) {
    const da = await env.DB.prepare(
      "SELECT * FROM domain_aliases WHERE site_id = ? AND domain = ?"
    ).bind(siteId, domain).first();
    if (!da) return jsonErr("등록되지 않은 도메인입니다.", 404);

    const resolvedIps = await lookupARecord(domain);
    const matched = resolvedIps.includes(serverIp);

    if (matched) {
      await env.DB.prepare(
        "UPDATE domain_aliases SET cf_ssl_status = 'active' WHERE site_id = ? AND domain = ?"
      ).bind(siteId, domain).run();
      return jsonOk({
        success: true, verified: true,
        message: `✅ A레코드 확인 완료! 도메인이 활성화되었습니다.`,
        domain, resolved_ips: resolvedIps, server_ip: serverIp,
      });
    }
    return jsonOk({
      success: true, verified: false,
      message: resolvedIps.length === 0
        ? `아직 A레코드가 전파되지 않았습니다. DNS 전파에 최대 24시간이 걸릴 수 있습니다.`
        : `A레코드가 ${resolvedIps.join(", ")}를 가리키고 있습니다. ${serverIp}로 변경해주세요.`,
      domain, resolved_ips: resolvedIps, server_ip: serverIp,
    });
  }

  // 도메인 목록
  const { results } = await env.DB.prepare(
    "SELECT * FROM domain_aliases WHERE site_id = ? ORDER BY is_primary DESC, id ASC"
  ).bind(siteId).all();

  return jsonOk({ success: true, domains: results, server_ip: serverIp });
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_id, domain } = body;
  if (!site_id) return jsonErr("site_id가 필요합니다.", 400);
  if (!domain)  return jsonErr("도메인을 입력해주세요.", 400);

  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domainClean))
    return jsonErr("올바른 도메인 형식이 아닙니다. (예: example.com, www.example.com)", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // 중복 감지 — 같은 도메인이 이미 다른 호스팅에 등록된 경우
  const existing = await env.DB.prepare(
    `SELECT da.site_id, s.site_name
     FROM domain_aliases da
     JOIN sites s ON da.site_id = s.id
     WHERE da.domain = ?`
  ).bind(domainClean).first();

  if (existing) {
    if (existing.site_id === site_id)
      return jsonErr("이미 이 호스팅에 등록된 도메인입니다.", 409);
    return jsonErr(
      `이 도메인은 이미 다른 호스팅 '${existing.site_name}'에서 사용 중입니다.`, 409
    );
  }

  const serverIp = getServerIp(env);

  try {
    await env.DB.prepare(
      `INSERT INTO domain_aliases (site_id, domain, is_primary, cf_ssl_status, server_ip)
       VALUES (?, ?, 0, 'pending', ?)`
    ).bind(site_id, domainClean, serverIp).run();
  } catch (e) {
    return jsonErr("도메인 등록 오류: " + e.message, 500);
  }

  return jsonOk({
    success: true,
    message: "도메인이 등록되었습니다.",
    domain: domainClean, server_ip: serverIp, status: "pending",
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("도메인 ID가 필요합니다.", 400);

  const da = await env.DB.prepare(
    `SELECT da.*, s.user_id FROM domain_aliases da
     JOIN sites s ON da.site_id = s.id WHERE da.id = ?`
  ).bind(id).first();
  if (!da) return jsonErr("도메인을 찾을 수 없습니다.", 404);
  if (da.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);
  if (da.is_primary)
    return jsonErr("기본 내부 도메인은 삭제할 수 없습니다.", 400);

  await env.DB.prepare("DELETE FROM domain_aliases WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "도메인이 삭제되었습니다." });
}
