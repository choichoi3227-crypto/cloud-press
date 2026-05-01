// functions/api/php-versions.js
// GET  /api/php-versions       → PHP 버전 목록 (php.net 실시간 or 폴백)
// PUT  /api/php-versions?id=   → 사이트 PHP 버전 변경

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// php.net JSON API에서 8.x 버전 목록 파싱
async function fetchPhpBranch(major) {
  try {
    const res = await fetch(
      `https://www.php.net/releases/index.php?json&version=${major}&max=5`,
      { headers: { "User-Agent": "CloudPress/1.0" }, cf: { cacheTtl: 3600 } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Object.entries(data).map(([ver, rel]) => ({
      version:             ver,                                      // "8.3.21" (숫자 형식)
      display_version:     `PHP ${ver.split(".").slice(0,2).join(".")}`,  // "PHP 8.3"
      minor:               ver.split(".").slice(0,2).join("."),     // "8.3"
      date:                rel.date || "",
      is_security_release: !!rel.is_security_release,
      supported:           major >= 8,                               // 7.x는 EOL
      support_label:       major >= 8 ? "지원됨" : "지원 종료 (EOL)",
    }));
  } catch {
    return [];
  }
}

// 폴백 버전 목록 (php.net 다운 시)
const FALLBACK = [
  { version:"8.3.21", minor:"8.3", display_version:"PHP 8.3", date:"2025-05-08", is_security_release:true,  supported:true,  support_label:"지원됨" },
  { version:"8.2.28", minor:"8.2", display_version:"PHP 8.2", date:"2025-05-08", is_security_release:true,  supported:true,  support_label:"지원됨" },
  { version:"8.1.32", minor:"8.1", display_version:"PHP 8.1", date:"2024-12-19", is_security_release:false, supported:false, support_label:"지원 종료 (EOL)" },
  { version:"7.4.33", minor:"7.4", display_version:"PHP 7.4", date:"2022-11-03", is_security_release:false, supported:false, support_label:"지원 종료 (EOL)" },
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  // php.net에서 8.x, 7.x 동시 조회
  const [v8, v7] = await Promise.all([fetchPhpBranch(8), fetchPhpBranch(7)]);
  const all = [...v8, ...v7];

  let versions;
  let source;

  if (all.length > 0) {
    // minor 버전 기준으로 최신 패치만 1개씩 추출
    const minorMap = {};
    for (const v of all) {
      if (!minorMap[v.minor] || v.version > minorMap[v.minor].version)
        minorMap[v.minor] = v;
    }
    versions = Object.values(minorMap).sort((a, b) =>
      b.minor.localeCompare(a.minor, undefined, { numeric: true })
    );
    source = "php.net";
  } else {
    versions = FALLBACK;
    source   = "fallback";
  }

  return jsonOk({ success: true, versions, source });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("id");
  if (!siteId) return jsonErr("사이트 ID가 필요합니다.", 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { php_version } = body;
  if (!php_version) return jsonErr("PHP 버전을 지정해주세요.", 400);
  if (!/^\d+\.\d+(\.\d+)?$/.test(php_version))
    return jsonErr("올바른 PHP 버전 형식이 아닙니다. (예: 8.3 또는 8.3.21)", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, php_version FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const prev = site.php_version;
  const minor = php_version.split(".").slice(0,2).join(".");

  try {
    await env.DB.prepare(
      "UPDATE sites SET php_version = ? WHERE id = ?"
    ).bind(php_version, siteId).run();

    // 변경 로그
    await env.DB.prepare(
      "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, 'info')"
    ).bind(siteId, `PHP ${prev} → PHP ${minor} 으로 변경 (무중단 적용)`).run().catch(() => {});

    return jsonOk({
      success: true,
      message: `PHP ${minor} 이 무중단으로 적용되었습니다.`,
      prev_version: prev,
      new_version:  php_version,
    });
  } catch (e) {
    return jsonErr("PHP 버전 변경 오류: " + e.message, 500);
  }
}
