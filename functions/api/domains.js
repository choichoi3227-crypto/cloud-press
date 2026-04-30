// functions/api/domains.js
// GET    /api/domains?site_id=   → 도메인 목록 조회
// POST   /api/domains            → 도메인 추가 (중복 감지 포함)
// DELETE /api/domains?id=        → 도메인 삭제
// GET    /api/domains/verify?site_id=&domain=  → A레코드 확인 후 자동 활성화

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// Cloudflare Anycast IP (WordPress 트래픽이 이 IP로 들어옴)
// 실제 운영 환경에서는 env.SERVER_IP 로 관리
const CF_ANYCAST_IP = "104.21.0.1"; // 실제 서버 IP로 교체 필요

async function getServerIp(env) {
  return env.SERVER_IP || CF_ANYCAST_IP;
}

// DNS A레코드 조회 (Cloudflare DNS over HTTPS 활용)
async function lookupARecord(domain) {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } }
    );
    const data = await res.json();
    if (data.Answer && data.Answer.length > 0) {
      return data.Answer.filter(r => r.type === 1).map(r => r.data);
    }
    return [];
  } catch {
    return [];
  }
}

// ── GET: 도메인 목록 ───────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const domain = url.searchParams.get("domain");

  // /api/domains/verify 처리 (URL 경로가 /api/domains이고 쿼리로 구분)
  const isVerify = url.searchParams.get("verify") === "1";

  if (isVerify && siteId && domain) {
    // A레코드 확인 후 자동 활성화
    return await verifyAndActivate(env, payload, siteId, domain);
  }

  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  // 해당 사이트가 본인 것인지 확인
  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const { results } = await env.DB.prepare(
    "SELECT * FROM domain_aliases WHERE site_id = ? ORDER BY is_primary DESC"
  ).bind(siteId).all();

  const serverIp = await getServerIp(env);

  return jsonOk({ success: true, domains: results, server_ip: serverIp });
}

// ── POST: 도메인 추가 ─────────────────────────────────────────────────────────
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

  // 도메인 형식 검증
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain))
    return jsonErr("올바른 도메인 형식이 아닙니다. (예: example.com, www.example.com)", 400);

  // 사이트 소유 확인
  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // ── 중복 감지: 다른 사이트에서 이미 사용 중인 도메인 ─────────────────────
  const existing = await env.DB.prepare(
    "SELECT da.site_id, s.site_name FROM domain_aliases da JOIN sites s ON da.site_id = s.id WHERE da.domain = ?"
  ).bind(domain).first();

  if (existing) {
    if (existing.site_id === site_id) {
      return jsonErr("이미 이 호스팅에 등록된 도메인입니다.", 409);
    }
    return jsonErr(
      `이 도메인은 이미 다른 호스팅(${existing.site_name})에서 사용 중입니다.`,
      409
    );
  }

  // DB에 도메인 등록 (pending 상태 — A레코드 확인 전)
  const serverIp = await getServerIp(env);

  try {
    await env.DB.prepare(
      `INSERT INTO domain_aliases
        (site_id, domain, is_primary, cf_ssl_status, server_ip)
       VALUES (?, ?, 0, 'pending', ?)`
    ).bind(site_id, domain, serverIp).run();
  } catch (e) {
    return jsonErr("도메인 등록 오류: " + e.message, 500);
  }

  return jsonOk({
    success:   true,
    message:   "도메인이 등록되었습니다. 아래 IP로 A레코드를 설정하면 자동으로 활성화됩니다.",
    domain,
    server_ip: serverIp,
    status:    "pending",
    guide: [
      `도메인 관리 페이지에서 A 레코드를 추가하세요:`,
      `  - 이름(Name): @ 또는 ${domain}`,
      `  - 값(Value): ${serverIp}`,
      `  - TTL: Auto (또는 300)`,
      `설정 후 [A레코드 확인] 버튼을 누르면 자동으로 활성화됩니다.`,
    ],
  });
}

// ── DELETE: 도메인 삭제 ───────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("도메인 ID가 필요합니다.", 400);

  const da = await env.DB.prepare(
    "SELECT da.*, s.user_id FROM domain_aliases da JOIN sites s ON da.site_id = s.id WHERE da.id = ?"
  ).bind(id).first();
  if (!da) return jsonErr("도메인을 찾을 수 없습니다.", 404);
  if (da.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);
  if (da.is_primary)
    return jsonErr("기본 도메인은 삭제할 수 없습니다.", 400);

  await env.DB.prepare("DELETE FROM domain_aliases WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "도메인이 삭제되었습니다." });
}

// ── A레코드 확인 및 자동 활성화 ───────────────────────────────────────────────
async function verifyAndActivate(env, payload, siteId, domain) {
  const site = await env.DB.prepare(
    "SELECT id, user_id FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const da = await env.DB.prepare(
    "SELECT * FROM domain_aliases WHERE site_id = ? AND domain = ?"
  ).bind(siteId, domain).first();
  if (!da) return jsonErr("등록되지 않은 도메인입니다.", 404);

  const serverIp  = await getServerIp(env);
  const resolvedIps = await lookupARecord(domain);

  const matched = resolvedIps.includes(serverIp);

  if (matched) {
    // A레코드가 올바르게 설정됨 → active로 업데이트
    await env.DB.prepare(
      "UPDATE domain_aliases SET cf_ssl_status = 'active' WHERE site_id = ? AND domain = ?"
    ).bind(siteId, domain).run();

    return jsonOk({
      success:      true,
      verified:     true,
      message:      `✅ A레코드가 확인되었습니다. 도메인이 활성화되었습니다.`,
      domain,
      resolved_ips: resolvedIps,
      server_ip:    serverIp,
    });
  } else {
    return jsonOk({
      success:      true,
      verified:     false,
      message:      resolvedIps.length === 0
        ? `❌ 아직 A레코드가 없습니다. DNS 전파에 최대 24시간이 걸릴 수 있습니다.`
        : `❌ A레코드가 ${resolvedIps.join(", ")}로 설정되어 있습니다. ${serverIp}로 변경해주세요.`,
      domain,
      resolved_ips: resolvedIps,
      server_ip:    serverIp,
    });
  }
}
