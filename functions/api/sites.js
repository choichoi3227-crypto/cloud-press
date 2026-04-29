// functions/api/sites.js
// GET    /api/sites           → 내 사이트 목록
// POST   /api/sites           → 새 호스팅 생성 (Supabase 버킷 자동 생성)
// GET    /api/sites?id=       → 사이트 상세 조회
// PUT    /api/sites?id=       → 사이트 설정 수정
// DELETE /api/sites?id=       → 사이트 삭제
import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";

// ── Supabase 버킷 생성 ────────────────────────────────────────────────────────
async function createSupabaseBucket(supabaseUrl, supabaseKey, bucketName) {
  const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      "apikey":        supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      id:     bucketName,
      name:   bucketName,
      public: false,
      file_size_limit: 524288000, // 500MB per file
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    // 이미 존재하면 무시
    if (!err.includes("already exists")) throw new Error(`버킷 생성 실패: ${err}`);
  }
  return true;
}

// ── 사용 가능한 Supabase 슬롯 찾기 ───────────────────────────────────────────
async function findAvailableSupabaseSlot(db) {
  const { results } = await db.prepare(
    "SELECT * FROM supabase_accounts WHERE used_gb < max_gb ORDER BY account_no, project_no"
  ).all();
  return results[0] || null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");

  try {
    if (id) {
      // 단일 사이트 상세
      const site = await env.DB.prepare(
        "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
      ).bind(id, payload.id, payload.role).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

      // 도메인 별칭 목록
      const { results: domains } = await env.DB.prepare(
        "SELECT * FROM domain_aliases WHERE site_id = ?"
      ).bind(id).all();

      // SSH 키 목록
      const { results: sshKeys } = await env.DB.prepare(
        "SELECT id, key_name, created_at FROM site_ssh_keys WHERE site_id = ?"
      ).bind(id).all();

      return jsonOk({ success: true, site, domains, sshKeys });
    }

    // 목록
    const query = payload.role === "admin"
      ? "SELECT id, site_name, primary_domain, php_version, status, is_throttled, cache_enabled, created_at FROM sites ORDER BY rowid DESC"
      : "SELECT id, site_name, primary_domain, php_version, status, is_throttled, cache_enabled, created_at FROM sites WHERE user_id = ? ORDER BY rowid DESC";
    const stmt = payload.role === "admin"
      ? env.DB.prepare(query)
      : env.DB.prepare(query).bind(payload.id);

    const { results } = await stmt.all();
    return jsonOk({ success: true, sites: results });
  } catch (e) {
    return jsonErr("조회 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_name, primary_domain, php_version = "8.2", wp_admin_user, wp_admin_pass } = body;
  if (!site_name || !primary_domain) return jsonErr("사이트 이름과 도메인을 입력해주세요.", 400);
  if (!wp_admin_user || !wp_admin_pass) return jsonErr("WordPress 관리자 아이디와 비밀번호를 입력해주세요.", 400);

  // 플랜 한도 체크
  try {
    const user = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
    const plan = user?.plan || "free";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const { results: existing } = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?"
    ).bind(payload.id).all();
    const cnt = existing[0]?.cnt || 0;
    if (limits.sites !== Infinity && cnt >= limits.sites) {
      return jsonErr(`현재 플랜(${plan})에서는 사이트를 ${limits.sites}개까지 생성할 수 있습니다.`, 403);
    }
  } catch (e) {
    console.error("[sites/post] plan check:", e);
  }

  // Supabase 버킷 생성
  let bucketName = null;
  let supabaseAccountNo = 1;
  try {
    const slot = await findAvailableSupabaseSlot(env.DB);
    if (slot) {
      const supabaseUrl = env[slot.supabase_url];
      const supabaseKey = env[slot.supabase_key];
      if (supabaseUrl && supabaseKey) {
        bucketName = `site-${crypto.randomUUID().slice(0, 8)}`;
        await createSupabaseBucket(supabaseUrl, supabaseKey, bucketName);
        supabaseAccountNo = slot.account_no;
      }
    }
  } catch (e) {
    console.error("[sites/post] bucket creation:", e);
    // 버킷 생성 실패해도 사이트 생성은 계속
  }

  try {
    const id = crypto.randomUUID();
    const sshPort = 2200 + Math.floor(Math.random() * 8000);
    const sftpPort = sshPort + 1;

    await env.DB.prepare(
      `INSERT INTO sites 
        (id, user_id, site_name, primary_domain, php_version, status, 
         supabase_bucket, supabase_account, ssh_port, sftp_port,
         wp_admin_user, wp_admin_pass, cache_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      id, payload.id, site_name, primary_domain, php_version,
      bucketName, supabaseAccountNo, sshPort, sftpPort,
      wp_admin_user, wp_admin_pass,
      new Date().toISOString()
    ).run();

    // 기본 도메인 별칭 등록
    await env.DB.prepare(
      "INSERT INTO domain_aliases (site_id, domain, is_primary) VALUES (?, ?, 1)"
    ).bind(id, primary_domain).run();

    return jsonOk({
      success: true,
      id,
      message: "호스팅이 생성되었습니다.",
      ssh_port: sshPort,
      sftp_port: sftpPort,
      bucket: bucketName,
    });
  } catch (e) {
    return jsonErr("호스팅 생성 오류: " + e.message, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  // 소유 확인
  const site = await env.DB.prepare("SELECT id, user_id FROM sites WHERE id = ?").bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const allowed = ["php_version", "cache_enabled", "cache_ttl", "status"];
  const updates = [];
  const values  = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (!updates.length) return jsonErr("변경할 설정이 없습니다.", 400);

  values.push(id);
  try {
    await env.DB.prepare(
      `UPDATE sites SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();
    return jsonOk({ success: true, message: "설정이 저장되었습니다." });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  try {
    const site = await env.DB.prepare("SELECT id, user_id FROM sites WHERE id = ?").bind(id).first();
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
    if (site.user_id !== payload.id && payload.role !== "admin")
      return jsonErr("권한이 없습니다.", 403);

    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "호스팅이 삭제되었습니다." });
  } catch (e) {
    return jsonErr("삭제 오류: " + e.message, 500);
  }
}
