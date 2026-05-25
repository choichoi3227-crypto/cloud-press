// functions/api/domains.js
// GET    /api/domains?site_id=                    → 도메인 목록 + 네임서버 정보
// GET    /api/domains?site_id=&domain=&verify=1   → 네임서버 전환 확인 및 자동 활성화
// POST   /api/domains                             → 도메인 추가 (CF 네임서버 방식 + 이미 CF 사용 중이면 자동 추가)
// DELETE /api/domains?id=                         → 도메인 삭제

import { jsonOk, jsonErr, requireAuth, getAdminCfCredentials } from "../_shared.js";
import { configureGithubPagesCustomDomainWithToken, setupGithubPagesDns } from "./github-pages-hosting.js";
import { pickGithubToken } from "./github-storage.js";

// ── Cloudflare API 헬퍼 ───────────────────────────────────────────────────────
// apiKey: Bearer token (starts with "Bearer ") or raw key (X-Auth-Key mode)
async function cfReq(method, path, apiKey, email, body) {
  // API Token 방식이면 Bearer, 아니면 X-Auth-Key 방식
  const isToken = !email || apiKey.startsWith("Bearer ");
  const rawKey  = apiKey.replace(/^Bearer /, "");
  const headers = {
    "Content-Type": "application/json",
    ...(isToken
      ? { "Authorization": `Bearer ${rawKey}` }
      : { "X-Auth-Key": rawKey, "X-Auth-Email": email }),
  };
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── 루트 도메인 추출 ────────────────────────────────────────────────────────
function getRootDomain(domain) {
  const parts = domain.split(".");
  // TLD 처리 (co.uk, com.au 등 2단계 TLD 지원)
  if (parts.length > 2) {
    const twoPartTLDs = ["co.uk","com.au","co.jp","co.kr","com.br","co.nz","org.uk","net.au","co.za"];
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTLDs.includes(lastTwo) && parts.length > 2) {
      return parts.slice(-3).join(".");
    }
  }
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

// ── DNS-over-HTTPS로 NS 레코드 조회 ─────────────────────────────────────────
async function lookupNsRecords(domain) {
  try {
    const root = getRootDomain(domain);
    // Cloudflare DoH + Google DoH 두 군데 조회 (신뢰성 향상)
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

    // 중복 제거
    return [...new Set(nsRecords)];
  } catch {
    return [];
  }
}

// ── 현재 NS가 Cloudflare인지 판별 ────────────────────────────────────────────
function isCloudflareNs(nsRecords) {
  return nsRecords.some(ns =>
    ns.endsWith(".ns.cloudflare.com") ||
    ns.endsWith(".cloudflare.com")
  );
}

// ── CF Zone 생성 또는 조회 ────────────────────────────────────────────────────
async function getOrCreateCfZone(apiKey, email, domain) {
  const root = getRootDomain(domain);

  // 1) 기존 Zone 조회 (사용자 계정에 이미 있는지 확인)
  const list = await cfReq("GET", `/zones?name=${encodeURIComponent(root)}&per_page=1`, apiKey, email);
  if (list.success && list.result?.length > 0) {
    const z = list.result[0];
    // 이미 사용자 CF 계정에 Zone이 있음 → 네임서버 변경 불필요
    const alreadyActive = z.status === "active";
    return {
      zoneId:      z.id,
      nameservers: z.name_servers || [],
      status:      z.status,
      alreadyOnCf: alreadyActive, // 이미 해당 CF 계정을 사용 중
    };
  }

  // 2) Zone 없음 → 새로 생성 (사용자 계정에 추가)
  // 계정 ID 조회
  const accRes = await cfReq("GET", "/accounts?per_page=1", apiKey, email);
  const accountId = accRes.result?.[0]?.id;

  const create = await cfReq("POST", "/zones", apiKey, email, {
    name:       root,
    account:    accountId ? { id: accountId } : undefined,
    jump_start: false,
    type:       "full",
  });

  if (create.success) {
    const z = create.result;
    return {
      zoneId:      z.id,
      nameservers: z.name_servers || [],
      status:      z.status,
      alreadyOnCf: false,
      justCreated: true,
    };
  }

  // 오류 메시지 처리
  const errMsg = create.errors?.[0]?.message || "Zone 생성 실패";
  // "already exists" 에러면 재조회
  if (errMsg.toLowerCase().includes("already exists")) {
    const retry = await cfReq("GET", `/zones?name=${encodeURIComponent(root)}&per_page=1`, apiKey, email);
    if (retry.success && retry.result?.length > 0) {
      const z = retry.result[0];
      return {
        zoneId:      z.id,
        nameservers: z.name_servers || [],
        status:      z.status,
        alreadyOnCf: z.status === "active",
      };
    }
  }

  return { error: errMsg };
}

// ── CF Zone에 Worker 커스텀 도메인 설정 ────────────────────────────────────────
async function setupWorkerCustomDomain(apiKey, email, zoneId, domain, workerName) {
  if (!workerName) return;

  // zone에서 account ID 조회
  const zoneInfo = await cfReq("GET", `/zones/${zoneId}`, apiKey, email);
  const cfAccountId = zoneInfo.result?.account?.id;

  if (!cfAccountId) {
    // accountId 없으면 레거시 라우트 방식으로 폴백
    const routes = await cfReq("GET", `/zones/${zoneId}/workers/routes`, apiKey, email);
    if (routes.success) {
      for (const r of routes.result || []) {
        if (r.pattern.includes(domain)) {
          await cfReq("DELETE", `/zones/${zoneId}/workers/routes/${r.id}`, apiKey, email).catch(() => {});
        }
      }
    }
    const patterns = [`${domain}/*`, `www.${domain}/*`];
    for (const pattern of patterns) {
      await cfReq("POST", `/zones/${zoneId}/workers/routes`, apiKey, email, {
        pattern,
        script: workerName,
      }).catch(() => {});
    }
    return;
  }

  // Worker 커스텀 도메인 API (라우트 방식이 아닌 커스텀 도메인 방식)
  // PUT /accounts/:account_id/workers/domains
  const root = getRootDomain(domain);
  const hostnames = [root];
  if (domain !== root) hostnames.unshift(domain); // 서브도메인 있으면 먼저
  if (!hostnames.includes(`www.${root}`)) hostnames.push(`www.${root}`);

  for (const hostname of hostnames) {
    await cfReq("PUT", `/accounts/${cfAccountId}/workers/domains`, apiKey, email, {
      environment: "production",
      hostname,
      service:     workerName,
      zone_id:     zoneId,
    }).catch(() => {});
  }
}

// ── DNS 레코드 설정 (Proxied A 레코드) ──────────────────────────────────────
async function setupDnsRecords(apiKey, email, zoneId, domain) {
  // Cloudflare Anycast — proxied이면 실제 IP 불필요 (192.0.2.1 placeholder)
  const proxyIp = "192.0.2.1";
  const root = getRootDomain(domain);

  // 기존 A 레코드 조회
  const existing = await cfReq("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(root)}`, apiKey, email);
  if (existing.success && existing.result?.length > 0) {
    // 이미 있으면 proxied 확인
    const rec = existing.result[0];
    if (!rec.proxied) {
      await cfReq("PATCH", `/zones/${zoneId}/dns_records/${rec.id}`, apiKey, email, {
        proxied: true,
      });
    }
  } else {
    // A 레코드 생성
    await cfReq("POST", `/zones/${zoneId}/dns_records`, apiKey, email, {
      type:    "A",
      name:    root,
      content: proxyIp,
      proxied: true,
      ttl:     1, // auto
    }).catch(() => {});

    // www CNAME
    await cfReq("POST", `/zones/${zoneId}/dns_records`, apiKey, email, {
      type:    "CNAME",
      name:    `www.${root}`,
      content: root,
      proxied: true,
      ttl:     1,
    }).catch(() => {});
  }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const domain = url.searchParams.get("domain");
  const verify = url.searchParams.get("verify") === "1";

  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, cf_worker_name FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // ── 네임서버 전환 확인 ───────────────────────────────────────────────────
  if (verify && domain) {
    const da = await env.DB.prepare(
      "SELECT * FROM domain_aliases WHERE site_id = ? AND domain = ?"
    ).bind(siteId, domain).first();
    if (!da) return jsonErr("등록되지 않은 도메인입니다.", 404);

    const expectedNs = (da.cf_nameservers || "").split(",").filter(Boolean);
    const currentNs  = await lookupNsRecords(domain);
    const isCfNs     = isCloudflareNs(currentNs);

    const nsMatch = expectedNs.length > 0
      ? expectedNs.every(ns => currentNs.includes(ns.toLowerCase()))
      : isCfNs;

    if (nsMatch || isCfNs) {
      const adminCf = await getAdminCfCredentials(env.DB);

      let workerRouteSet = false;
      if (adminCf.apiKey && da.cf_zone_id && site.cf_worker_name) {
        try {
          await setupDnsRecords(adminCf.apiKey, adminCf.email || "", da.cf_zone_id, domain);
          await setupWorkerCustomDomain(
            adminCf.apiKey, adminCf.email || "",
            da.cf_zone_id, domain, site.cf_worker_name
          );
          workerRouteSet = true;
        } catch (e) {
          console.warn("[domains/verify] worker route:", e.message);
        }
      }

      await env.DB.prepare(
        "UPDATE domain_aliases SET cf_ssl_status = 'active' WHERE site_id = ? AND domain = ?"
      ).bind(siteId, domain).run();

      // primary_domain 업데이트 (첫 활성 도메인)
      const primaryDomain = await env.DB.prepare(
        "SELECT domain FROM domain_aliases WHERE site_id = ? AND is_primary = 1 LIMIT 1"
      ).bind(siteId).first();
      if (!primaryDomain) {
        await env.DB.prepare(
          "UPDATE sites SET primary_domain = ? WHERE id = ?"
        ).bind(domain, siteId).run();
      }

      return jsonOk({
        success:  true,
        verified: true,
        message:  `✅ 네임서버 전환 확인 완료! 도메인이 활성화되었습니다.${workerRouteSet ? " Worker 커스텀 도메인도 자동 설정되었습니다." : ""}`,
        domain,
        current_nameservers: currentNs,
      });
    }

    return jsonOk({
      success:  true,
      verified: false,
      message:  currentNs.length === 0
        ? "아직 네임서버 정보를 가져올 수 없습니다. DNS 전파에 최대 24~48시간이 걸릴 수 있습니다."
        : `현재 네임서버: ${currentNs.join(", ")} — 아직 Cloudflare 네임서버로 전환되지 않았습니다.`,
      domain,
      current_nameservers:  currentNs,
      expected_nameservers: expectedNs,
    });
  }

  // ── 도메인 목록 ──────────────────────────────────────────────────────────
  const { results } = await env.DB.prepare(
    "SELECT * FROM domain_aliases WHERE site_id = ? ORDER BY is_primary DESC, id ASC"
  ).bind(siteId).all();

  return jsonOk({ success: true, domains: results });
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

  const domainClean = domain.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domainClean))
    return jsonErr("올바른 도메인 형식이 아닙니다. (예: example.com, www.example.com)", 400);

  if (domainClean.endsWith(".cloudpress.app") || domainClean.endsWith(".sites.cloudpress.app"))
    return jsonErr("cloudpress.app 서브도메인은 사용할 수 없습니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, cf_worker_name, hosting_type, github_repo_owner, github_repo_name FROM sites WHERE id = ?"
  ).bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // 중복 감지
  const existing = await env.DB.prepare(
    `SELECT da.site_id, s.site_name FROM domain_aliases da
     JOIN sites s ON da.site_id = s.id WHERE da.domain = ?`
  ).bind(domainClean).first();

  if (existing) {
    if (existing.site_id === site_id)
      return jsonErr("이미 이 호스팅에 등록된 도메인입니다.", 409);
    return jsonErr(`이 도메인은 이미 다른 호스팅 '${existing.site_name}'에서 사용 중입니다.`, 409);
  }

  // ── 관리자 CF API 키 조회 (플랫폼 차원의 도메인 추가) ─────────────────────
  const adminCf = await getAdminCfCredentials(env.DB);

  if (!adminCf.apiKey)
    return jsonErr("플랫폼 Cloudflare API 키가 설정되어 있지 않습니다. 관리자에게 문의해주세요.", 400);

  const cfApiKey = adminCf.apiKey;
  const cfEmail  = adminCf.email || "";

  let nameservers    = [];
  let zoneId         = null;
  let zoneStatus     = "pending";
  let zoneError      = null;
  let alreadyOnCf    = false;
  let workerRouteSet = false;

  try {
    const zoneResult = await getOrCreateCfZone(
      cfApiKey, cfEmail, domainClean
    );

    if (zoneResult.error) {
      zoneError = zoneResult.error;
    } else {
      zoneId      = zoneResult.zoneId;
      nameservers = zoneResult.nameservers || [];
      zoneStatus  = zoneResult.status || "pending";
      alreadyOnCf = zoneResult.alreadyOnCf || false;

      // DNS 레코드 설정
      if (zoneId) {
        await setupDnsRecords(cfApiKey, cfEmail, zoneId, domainClean)
          .catch(e => console.warn("[domains] dns setup:", e.message));
      }

      // 이미 CF 네임서버 사용 중이거나 Zone이 active면 Worker 커스텀 도메인 즉시 설정
      if ((alreadyOnCf || zoneStatus === "active") && site.cf_worker_name && zoneId) {
        try {
          await setupWorkerCustomDomain(
            cfApiKey, cfEmail,
            zoneId, domainClean, site.cf_worker_name
          );
          workerRouteSet = true;
        } catch (e) {
          console.warn("[domains/post] worker route:", e.message);
        }
      }
    }
  } catch (e) {
    zoneError = e.message;
    console.warn("[domains/post] zone creation:", e.message);
  }

  // ── DB 저장 ─────────────────────────────────────────────────────────────
  const initialStatus = (alreadyOnCf || zoneStatus === "active") ? "active" : "pending";
  try {
    await env.DB.prepare(
      `INSERT INTO domain_aliases
        (site_id, domain, is_primary, cf_ssl_status, cf_zone_id, cf_nameservers, created_at)
       VALUES (?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(
      site_id, domainClean, initialStatus,
      zoneId,
      nameservers.join(",")
    ).run();
  } catch (e) {
    return jsonErr("도메인 등록 오류: " + e.message, 500);
  }

  // 이미 활성이면 sites.primary_domain 업데이트
  if (initialStatus === "active") {
    const currentPrimary = await env.DB.prepare(
      "SELECT primary_domain FROM sites WHERE id = ?"
    ).bind(site_id).first();
    if (!currentPrimary?.primary_domain || currentPrimary.primary_domain.endsWith(".workers.dev")) {
      await env.DB.prepare(
        "UPDATE sites SET primary_domain = ? WHERE id = ?"
      ).bind(domainClean, site_id).run();
    }
  }

  // ── GitHub Pages 호스팅: WordPress siteurl/home 자동 갱신 (도메인 추가 시) ──
  // hosting_type이 'github_pages' 이거나 github_repo_name이 있으면 자동 갱신
  let wpUrlUpdated = false;
  if (
    (site.hosting_type === "github_pages" || site.github_repo_name) &&
    site.github_repo_owner && site.github_repo_name
  ) {
    try {
      const ghToken = await pickGithubToken(env);
      if (ghToken) {
        await configureGithubPagesCustomDomainWithToken({
          token:     ghToken,
          owner:     site.github_repo_owner,
          repoName:  site.github_repo_name,
          domain:    domainClean,
          siteId:    site_id,
        });
        wpUrlUpdated = true;
      }
    } catch (e) {
      console.warn("[domains/post] WordPress URL 자동 갱신 실패:", e.message);
    }
  }

  // ── 응답 메시지 생성 ─────────────────────────────────────────────────────
  let message, instructions;

  if (zoneError) {
    message = `도메인이 등록되었습니다. (Cloudflare Zone 생성 실패: ${zoneError})`;
    instructions = ["Cloudflare 대시보드에서 직접 Zone을 추가하거나 다시 시도해주세요."];
  } else if (alreadyOnCf || initialStatus === "active") {
    const wpMsg = wpUrlUpdated ? " WordPress siteurl/home도 자동 갱신되었습니다." : "";
    message = `✅ 도메인이 자동으로 활성화되었습니다! 이미 해당 Cloudflare 계정에서 도메인을 사용 중입니다.${workerRouteSet ? " Worker 커스텀 도메인도 설정되었습니다." : ""}${wpMsg}`;
    instructions = [
      "이미 이 도메인의 DNS가 Cloudflare를 통해 관리되고 있습니다.",
      workerRouteSet ? "Worker 커스텀 도메인이 자동으로 설정되었습니다." : "Cloudflare 대시보드 > Workers > 커스텀 도메인에서 수동으로 설정해주세요.",
      wpUrlUpdated ? "WordPress siteurl/home이 해당 도메인으로 자동 설정되었습니다." : "",
    ].filter(Boolean);
  } else if (nameservers.length > 0) {
    const wpMsg = wpUrlUpdated ? "\n※ WordPress siteurl/home도 해당 도메인으로 미리 설정되었습니다. DNS 전파 완료 후 자동 적용됩니다." : "";
    message = `도메인이 등록되었습니다. 아래 Cloudflare 네임서버로 변경해주세요.${wpMsg}`;
    instructions = [
      `1. 도메인 등록기(가비아, 후이즈, Namecheap 등)에서 네임서버 설정 변경`,
      `2. 기존 네임서버를 아래 Cloudflare 네임서버로 교체:`,
      ...nameservers.map(ns => `   • ${ns}`),
      `3. 변경 후 "도메인 확인" 버튼을 클릭하여 인증 완료`,
      `⏱ DNS 전파는 최대 24~48시간이 소요될 수 있습니다.`,
    ];
  } else {
    message = `도메인이 등록되었습니다.`;
    instructions = ["Cloudflare Zone 생성 후 네임서버를 확인하고 변경해주세요."];
  }

  return jsonOk({
    success:        true,
    message,
    domain:         domainClean,
    nameservers,
    zone_id:        zoneId,
    zone_status:    alreadyOnCf ? "active" : zoneStatus,
    already_on_cf:  alreadyOnCf,
    worker_custom_domain: workerRouteSet,
    wp_url_updated: wpUrlUpdated,
    verify_method:  alreadyOnCf ? "auto" : "nameserver",
    instructions,
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
    `SELECT da.*, s.user_id, s.cf_worker_name FROM domain_aliases da
     JOIN sites s ON da.site_id = s.id WHERE da.id = ?`
  ).bind(id).first();
  if (!da) return jsonErr("도메인을 찾을 수 없습니다.", 404);
  if (da.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // CF Zone의 Worker 라우트 제거
  if (da.cf_zone_id && da.cf_ssl_status === "active") {
    try {
      const adminCfDel = await getAdminCfCredentials(env.DB);
      if (adminCfDel.apiKey) {
        const routes = await cfReq(
          "GET", `/zones/${da.cf_zone_id}/workers/routes`,
          adminCfDel.apiKey, adminCfDel.email || ""
        );
        for (const r of routes.result || []) {
          if (r.pattern.includes(da.domain)) {
            await cfReq(
              "DELETE", `/zones/${da.cf_zone_id}/workers/routes/${r.id}`,
              adminCfDel.apiKey, adminCfDel.email || ""
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn("[domains/delete] CF cleanup:", e.message);
    }
  }

  await env.DB.prepare("DELETE FROM domain_aliases WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "도메인이 삭제되었습니다." });
}
