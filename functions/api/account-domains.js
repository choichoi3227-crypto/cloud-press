// functions/api/account-domains.js
// 계정(사용자) 단위 도메인 관리
//
// GET    /api/account-domains              → 내 계정 도메인 목록
// POST   /api/account-domains             → 계정에 도메인 추가 (Cloudflare Zone 등록)
// PUT    /api/account-domains?id=         → 도메인을 특정 호스팅에 연결 / 해제
// DELETE /api/account-domains?id=         → 계정 도메인 삭제
// GET    /api/account-domains?id=&verify=1 → 네임서버 전환 확인

import { jsonOk, jsonErr, requireAuth, getAdminCfCredentials } from "../_shared.js";
import {
  setupGithubPagesDns,
  configureGithubPagesCustomDomainWithToken,
} from "./github-pages-hosting.js";
import { pickGithubToken } from "./github-storage.js";

// ── Cloudflare API 헬퍼 ───────────────────────────────────────────────────────
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

// ── 루트 도메인 추출 ────────────────────────────────────────────────────────
function getRootDomain(domain) {
  const parts = domain.split(".");
  const twoPartTLDs = ["co.uk","com.au","co.jp","co.kr","com.br","co.nz","org.uk","net.au","co.za"];
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTLDs.includes(lastTwo)) return parts.slice(-3).join(".");
  }
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

// ── DNS-over-HTTPS로 NS 레코드 조회 ─────────────────────────────────────────
async function lookupNsRecords(domain) {
  try {
    const root = getRootDomain(domain);
    const [cfRes, ggRes] = await Promise.allSettled([
      fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(root)}&type=NS`,
        { headers: { Accept: "application/dns-json" } }),
      fetch(`https://dns.google/resolve?name=${encodeURIComponent(root)}&type=NS`,
        { headers: { Accept: "application/dns-json" } }),
    ]);
    let nsRecords = [];
    for (const r of [cfRes, ggRes]) {
      if (r.status === "fulfilled" && r.value.ok) {
        const data = await r.value.json().catch(() => ({}));
        const records = (data.Answer || [])
          .filter(rec => rec.type === 2)
          .map(rec => rec.data.replace(/\.$/, "").toLowerCase());
        nsRecords = [...nsRecords, ...records];
      }
    }
    return [...new Set(nsRecords)];
  } catch {
    return [];
  }
}

function isCloudflareNs(nsRecords) {
  return nsRecords.some(ns =>
    ns.endsWith(".ns.cloudflare.com") || ns.endsWith(".cloudflare.com")
  );
}

// ── CF Zone 생성 또는 조회 ────────────────────────────────────────────────────
async function getOrCreateCfZone(apiKey, email, domain) {
  const root = getRootDomain(domain);

  // 기존 Zone 조회
  const listRes = await cfReq("GET", `/zones?name=${encodeURIComponent(root)}&per_page=1`, apiKey, email);
  if (listRes.result?.length > 0) {
    const zone = listRes.result[0];
    const alreadyActive = zone.status === "active";
    return {
      zoneId:      zone.id,
      nameservers: zone.name_servers || [],
      status:      zone.status,
      alreadyOnCf: alreadyActive,
    };
  }

  // 새 Zone 생성
  const createRes = await cfReq("POST", "/zones", apiKey, email, {
    name: root,
    jump_start: false,
  });

  if (!createRes.success) {
    const errMsg = createRes.errors?.[0]?.message || "Zone 생성 실패";
    return { error: errMsg };
  }

  return {
    zoneId:      createRes.result.id,
    nameservers: createRes.result.name_servers || [],
    status:      createRes.result.status || "pending",
    alreadyOnCf: false,
  };
}

// ── GitHub Pages용 DNS 레코드 설정 ────────────────────────────────────────────
// GitHub Pages 공식 문서 기준 A 레코드 4개 + AAAA 레코드 4개
async function setupGithubPagesDnsRecords(apiKey, email, zoneId, domain) {
  const root = getRootDomain(domain);

  // GitHub Pages IP (공식 문서: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
  const ghIpv4 = ["185.199.108.153","185.199.109.153","185.199.110.153","185.199.111.153"];
  const ghIpv6 = ["2606:50c0:8000::153","2606:50c0:8001::153","2606:50c0:8002::153","2606:50c0:8003::153"];

  // 기존 A 레코드 조회 후 없으면 추가
  const existingA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(root)}`, apiKey, email);
  const existingIps = (existingA.result || []).map(r => r.content);

  for (const ip of ghIpv4) {
    if (!existingIps.includes(ip)) {
      await cfReq("POST", `/zones/${zoneId}/dns_records`, apiKey, email, {
        type: "A", name: root, content: ip, ttl: 3600, proxied: false,
      }).catch(() => {});
    }
  }

  // AAAA 레코드
  const existingAAAA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(root)}`, apiKey, email);
  const existingIpv6 = (existingAAAA.result || []).map(r => r.content);

  for (const ip of ghIpv6) {
    if (!existingIpv6.includes(ip)) {
      await cfReq("POST", `/zones/${zoneId}/dns_records`, apiKey, email, {
        type: "AAAA", name: root, content: ip, ttl: 3600, proxied: false,
      }).catch(() => {});
    }
  }

  // www CNAME → GitHub Pages (owner.github.io)
  if (!domain.startsWith("www.")) {
    const existingCname = await cfReq("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=www.${encodeURIComponent(root)}`, apiKey, email);
    if (!(existingCname.result?.length > 0)) {
      // site 연결이 있으면 실제 github.io 주소 사용, 없으면 placeholder
      await cfReq("POST", `/zones/${zoneId}/dns_records`, apiKey, email, {
        type: "CNAME", name: `www.${root}`, content: root, ttl: 3600, proxied: false,
      }).catch(() => {});
    }
  }
}

// ── 테이블 초기화 ─────────────────────────────────────────────────────────────
async function ensureTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_domains (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT NOT NULL,
      domain         TEXT UNIQUE NOT NULL,
      site_id        TEXT,                     -- NULL: 계정에만 등록, 값 있으면 호스팅에 연결
      is_primary     INTEGER DEFAULT 0,
      cf_ssl_status  TEXT DEFAULT 'pending',   -- pending | active
      cf_zone_id     TEXT,
      cf_nameservers TEXT,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `).run().catch(() => {});
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env);

  const url    = new URL(request.url);
  const id     = url.searchParams.get("id");
  const verify = url.searchParams.get("verify") === "1";

  // ── 네임서버 확인 ──────────────────────────────────────────────────────────
  if (id && verify) {
    const ud = await env.DB.prepare(
      "SELECT * FROM user_domains WHERE id = ? AND user_id = ?"
    ).bind(id, payload.id).first();
    if (!ud) return jsonErr("도메인을 찾을 수 없습니다.", 404);

    const expectedNs = (ud.cf_nameservers || "").split(",").filter(Boolean);
    const currentNs  = await lookupNsRecords(ud.domain);
    const isCfNs     = isCloudflareNs(currentNs);
    const nsMatch    = expectedNs.length > 0
      ? expectedNs.every(ns => currentNs.includes(ns.toLowerCase()))
      : isCfNs;

    if (nsMatch || isCfNs) {
      await env.DB.prepare(
        "UPDATE user_domains SET cf_ssl_status = 'active' WHERE id = ?"
      ).bind(id).run();

      // 연결된 호스팅이 있으면 GitHub Pages DNS 레코드 자동 설정
      if (ud.site_id && ud.cf_zone_id) {
        const adminCf = await getAdminCfCredentials(env.DB);
        if (adminCf.apiKey && adminCf.email) {
          await setupGithubPagesDnsRecords(
            adminCf.apiKey, adminCf.email, ud.cf_zone_id, ud.domain
          ).catch(e => console.warn("[account-domains/verify] dns:", e.message));
        }
      }

      return jsonOk({
        success: true, verified: true,
        message: "✅ 네임서버 전환 확인 완료! 도메인이 활성화되었습니다.",
        domain: ud.domain,
        current_nameservers: currentNs,
      });
    }

    return jsonOk({
      success: true, verified: false,
      message: currentNs.length === 0
        ? "아직 네임서버 정보를 가져올 수 없습니다. DNS 전파에 최대 24~48시간이 걸릴 수 있습니다."
        : `현재 네임서버: ${currentNs.join(", ")} — 아직 Cloudflare 네임서버로 전환되지 않았습니다.`,
      domain: ud.domain,
      current_nameservers:  currentNs,
      expected_nameservers: expectedNs,
    });
  }

  // ── 목록 조회 ──────────────────────────────────────────────────────────────
  const { results } = await env.DB.prepare(
    `SELECT ud.*, s.site_name FROM user_domains ud
     LEFT JOIN sites s ON ud.site_id = s.id
     WHERE ud.user_id = ?
     ORDER BY ud.id DESC`
  ).bind(payload.id).all();

  return jsonOk({ success: true, domains: results });
}

// ── POST (계정에 도메인 추가) ─────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { domain } = body;
  if (!domain) return jsonErr("도메인을 입력해주세요.", 400);

  const domainClean = domain.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domainClean))
    return jsonErr("올바른 도메인 형식이 아닙니다. (예: example.com)", 400);

  // 이미 등록된 도메인 확인
  const existing = await env.DB.prepare(
    "SELECT id, user_id FROM user_domains WHERE domain = ?"
  ).bind(domainClean).first();

  if (existing) {
    if (existing.user_id === payload.id)
      return jsonErr("이미 내 계정에 등록된 도메인입니다.", 409);
    return jsonErr("이 도메인은 다른 계정에서 사용 중입니다.", 409);
  }

  // 관리자 Cloudflare API 키 사용 (사용자 개별 키 불필요)
  const adminCf = await getAdminCfCredentials(env.DB);

  let nameservers = [];
  let zoneId      = null;
  let zoneStatus  = "pending";
  let alreadyOnCf = false;
  let zoneError   = null;

  if (adminCf.apiKey && adminCf.email) {
    try {
      const zoneResult = await getOrCreateCfZone(
        adminCf.apiKey, adminCf.email, domainClean
      );
      if (zoneResult.error) {
        zoneError = zoneResult.error;
      } else {
        zoneId      = zoneResult.zoneId;
        nameservers = zoneResult.nameservers || [];
        zoneStatus  = zoneResult.status || "pending";
        alreadyOnCf = zoneResult.alreadyOnCf || false;
      }
    } catch (e) {
      zoneError = e.message;
    }
  }

  // DB 저장
  const initialStatus = (alreadyOnCf || zoneStatus === "active") ? "active" : "pending";
  try {
    await env.DB.prepare(
      `INSERT INTO user_domains (user_id, domain, site_id, is_primary, cf_ssl_status, cf_zone_id, cf_nameservers)
       VALUES (?, ?, NULL, 0, ?, ?, ?)`
    ).bind(
      payload.id, domainClean, initialStatus,
      zoneId, nameservers.join(",")
    ).run();
  } catch (e) {
    return jsonErr("도메인 등록 오류: " + e.message, 500);
  }

  // 이미 활성이면 GitHub Pages DNS 자동 설정
  if (initialStatus === "active" && zoneId && adminCf.apiKey) {
    await setupGithubPagesDnsRecords(
      adminCf.apiKey, adminCf.email, zoneId, domainClean
    ).catch(e => console.warn("[account-domains/post] dns:", e.message));
  }

  // 응답
  let message, instructions;
  if (zoneError) {
    message = `도메인이 등록되었습니다. (Cloudflare Zone 생성 실패: ${zoneError})`;
    instructions = ["관리자에게 문의하거나 Cloudflare 대시보드에서 직접 Zone을 추가해주세요."];
  } else if (!adminCf.apiKey) {
    message = "도메인이 등록되었습니다. 관리자가 Cloudflare API 키를 설정하면 자동 DNS 설정이 가능합니다.";
    instructions = ["관리자에게 시스템 설정의 Cloudflare API 키 등록을 요청해주세요."];
  } else if (alreadyOnCf || initialStatus === "active") {
    message = "✅ 도메인이 즉시 활성화되었습니다. GitHub Pages DNS 레코드가 자동 설정되었습니다.";
    instructions = ["이제 호스팅 연결 탭에서 이 도메인을 특정 호스팅에 연결할 수 있습니다."];
  } else if (nameservers.length > 0) {
    message = "도메인이 등록되었습니다. 아래 Cloudflare 네임서버로 변경해주세요.";
    instructions = [
      "1. 도메인 등록기(가비아, 후이즈, Namecheap 등)에서 네임서버 설정 변경",
      "2. 기존 네임서버를 아래 Cloudflare 네임서버로 교체:",
      ...nameservers.map(ns => `   • ${ns}`),
      "3. 변경 후 \"NS 확인\" 버튼을 클릭하여 인증 완료",
      "⏱ DNS 전파는 최대 24~48시간이 소요될 수 있습니다.",
    ];
  } else {
    message = "도메인이 등록되었습니다.";
    instructions = ["Cloudflare Zone 생성 후 네임서버를 확인하세요."];
  }

  return jsonOk({
    success: true, message,
    domain:      domainClean,
    nameservers,
    zone_id:     zoneId,
    zone_status: alreadyOnCf ? "active" : zoneStatus,
    instructions,
  });
}

// ── PUT (호스팅 연결 / 해제) ──────────────────────────────────────────────────
export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("도메인 ID가 필요합니다.", 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식 오류", 400); }

  const ud = await env.DB.prepare(
    "SELECT * FROM user_domains WHERE id = ? AND user_id = ?"
  ).bind(id, payload.id).first();
  if (!ud) return jsonErr("도메인을 찾을 수 없습니다.", 404);

  const { site_id } = body; // null이면 연결 해제, 값이 있으면 연결

  if (site_id !== null && site_id !== undefined && site_id !== "") {
    // 호스팅 소유권 확인
    const site = await env.DB.prepare(
      "SELECT id, github_repo_owner, github_repo_name, cf_worker_name FROM sites WHERE id = ? AND user_id = ?"
    ).bind(site_id, payload.id).first();
    if (!site) return jsonErr("해당 호스팅을 찾을 수 없거나 권한이 없습니다.", 404);

    // 다른 user_domain에서 이미 이 site에 연결된 도메인이 있는지 확인 (is_primary 용)
    await env.DB.prepare(
      "UPDATE user_domains SET site_id = ? WHERE id = ?"
    ).bind(site_id, id).run();

    // 활성화된 도메인이면 sites.primary_domain 업데이트 및 GitHub Pages DNS 설정
    if (ud.cf_ssl_status === "active" && ud.cf_zone_id) {
      const currentPrimary = await env.DB.prepare(
        "SELECT primary_domain FROM sites WHERE id = ?"
      ).bind(site_id).first();
      if (!currentPrimary?.primary_domain || currentPrimary.primary_domain.endsWith(".workers.dev")) {
        await env.DB.prepare(
          "UPDATE sites SET primary_domain = ? WHERE id = ?"
        ).bind(ud.domain, site_id).run();
      }

      // GitHub Pages DNS + 커스텀 도메인 설정
      const adminCf = await getAdminCfCredentials(env.DB);
      if (adminCf.apiKey && adminCf.email && ud.cf_zone_id) {
        await setupGithubPagesDns({
          cfApiKey: adminCf.apiKey,
          cfEmail:  adminCf.email,
          zoneId:   ud.cf_zone_id,
          domain:   ud.domain,
          owner:    site.github_repo_owner || '',
          repoName: site.github_repo_name  || '',
        }).catch(e => console.warn("[account-domains/put] dns:", e.message));
      }

      // GitHub Pages 커스텀 도메인 등록 (CNAME 파일 + Pages API)
      if (site.github_repo_owner && site.github_repo_name) {
        const ghToken = await pickGithubToken(env).catch(() => null);
        if (ghToken) {
          await configureGithubPagesCustomDomainWithToken({
            token:    ghToken,
            owner:    site.github_repo_owner,
            repoName: site.github_repo_name,
            domain:   ud.domain,
          }).catch(e => console.warn("[account-domains/put] gh-pages custom domain:", e.message));
        }
      }

      // 호스팅의 primary_domain 업데이트
      await env.DB.prepare(
        "UPDATE sites SET primary_domain = ?, status = 'active' WHERE id = ?"
      ).bind(ud.domain, site_id).run().catch(() => {});
    }

    return jsonOk({ success: true, message: `도메인이 호스팅에 연결되었습니다.` });
  } else {
    // 연결 해제
    await env.DB.prepare(
      "UPDATE user_domains SET site_id = NULL, is_primary = 0 WHERE id = ?"
    ).bind(id).run();
    return jsonOk({ success: true, message: "도메인 연결이 해제되었습니다." });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  await ensureTable(env);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("도메인 ID가 필요합니다.", 400);

  const ud = await env.DB.prepare(
    "SELECT * FROM user_domains WHERE id = ? AND user_id = ?"
  ).bind(id, payload.id).first();
  if (!ud) return jsonErr("도메인을 찾을 수 없습니다.", 404);

  // 연결된 호스팅의 primary_domain 초기화
  if (ud.site_id) {
    const site = await env.DB.prepare(
      "SELECT primary_domain FROM sites WHERE id = ?"
    ).bind(ud.site_id).first();
    if (site?.primary_domain === ud.domain) {
      await env.DB.prepare(
        "UPDATE sites SET primary_domain = NULL WHERE id = ?"
      ).bind(ud.site_id).run();
    }
  }

  await env.DB.prepare("DELETE FROM user_domains WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "도메인이 삭제되었습니다." });
}

// CORS
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
