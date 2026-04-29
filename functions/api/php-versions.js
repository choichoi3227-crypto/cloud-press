// functions/api/php-versions.js
// GET  /api/php-versions          → php.net 에서 최신 PHP 버전 목록 조회
// PUT  /api/php-versions?id=      → 특정 사이트에 PHP 버전 적용 (무중단)

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// php.net releases JSON에서 지원중인 버전 파싱
async function fetchPhpVersionsFromOfficial() {
  try {
    const res = await fetch("https://www.php.net/releases/index.php?json&version=8", {
      headers: { "User-Agent": "CloudPress/1.0" },
    });
    const data = await res.json();
    return Object.keys(data).map(v => {
      const rel = data[v];
      return {
        version:             v,
        date:                rel.date || "",
        is_security_release: rel.is_security_release || false,
        supported:           true,
        // 사람이 읽기 좋은 표기: "PHP 8.3" 형식
        display_version:     "PHP " + v.split(".").slice(0, 2).join("."),
        // 지원 여부 라벨
        support_label:       "지원됨",
      };
    });
  } catch {
    return null;
  }
}

async function fetchPhpVersions7() {
  try {
    const res = await fetch("https://www.php.net/releases/index.php?json&version=7", {
      headers: { "User-Agent": "CloudPress/1.0" },
    });
    const data = await res.json();
    return Object.keys(data).map(v => ({
      version:             v,
      date:                data[v].date || "",
      is_security_release: data[v].is_security_release || false,
      supported:           false,
      display_version:     "PHP " + v.split(".").slice(0, 2).join("."),
      support_label:       "지원 종료 (EOL)",
    }));
  } catch {
    return [];
  }
}

// 안전한 폴백 버전 목록 (php.net 접근 불가 시)
const FALLBACK_VERSIONS = [
  { version: "8.3.21", date: "2025-05-08", is_security_release: true,  supported: true,  display_version: "PHP 8.3", support_label: "지원됨" },
  { version: "8.2.28", date: "2025-05-08", is_security_release: true,  supported: true,  display_version: "PHP 8.2", support_label: "지원됨" },
  { version: "8.1.32", date: "2024-12-19", is_security_release: false, supported: false, display_version: "PHP 8.1", support_label: "지원 종료 (EOL)" },
  { version: "8.0.30", date: "2023-08-03", is_security_release: false, supported: false, display_version: "PHP 8.0", support_label: "지원 종료 (EOL)" },
  { version: "7.4.33", date: "2022-11-03", is_security_release: false, supported: false, display_version: "PHP 7.4", support_label: "지원 종료 (EOL)" },
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const [v8, v7] = await Promise.all([
    fetchPhpVersionsFromOfficial(),
    fetchPhpVersions7(),
  ]);

  let versions;
  if (v8 && v8.length > 0) {
    // major.minor 기준으로 최신 패치만 표시
    const minorMap = {};
    for (const v of [...v8, ...v7]) {
      const parts = v.version.split(".");
      const minor = `${parts[0]}.${parts[1]}`;
      if (!minorMap[minor] || v.version > minorMap[minor].version) {
        minorMap[minor] = v;
      }
    }
    versions = Object.values(minorMap).sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  } else {
    versions = FALLBACK_VERSIONS;
  }

  return jsonOk({ success: true, versions, source: v8 ? "php.net" : "fallback" });
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

  // 버전 형식 검증 (x.y 또는 x.y.z)
  if (!/^\d+\.\d+(\.\d+)?$/.test(php_version))
    return jsonErr("올바른 PHP 버전 형식이 아닙니다.", 400);

  const site = await env.DB.prepare(
    "SELECT id, user_id, php_version FROM sites WHERE id = ?"
  ).bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const prevVersion = site.php_version;

  try {
    await env.DB.prepare(
      "UPDATE sites SET php_version = ? WHERE id = ?"
    ).bind(php_version, siteId).run();

    await env.DB.prepare(
      `INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, 'info')`
    ).bind(
      siteId,
      `PHP 버전이 ${prevVersion} → ${php_version} 으로 변경되었습니다. (무중단 적용)`
    ).run();

    if (env.CACHE) {
      await env.CACHE.delete(`php_version:${siteId}`).catch(() => {});
      await env.CACHE.put(`php_version:${siteId}`, php_version, { expirationTtl: 86400 });
    }

    const minor = php_version.split(".").slice(0, 2).join(".");
    return jsonOk({
      success:      true,
      message:      `PHP ${minor} 이 무중단으로 적용되었습니다.`,
      prev_version: prevVersion,
      new_version:  php_version,
    });
  } catch (e) {
    return jsonErr("PHP 버전 변경 오류: " + e.message, 500);
  }
}
