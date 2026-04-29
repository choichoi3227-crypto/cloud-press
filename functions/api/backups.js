// functions/api/backups.js
// GET    /api/backups?site_id=   → 백업 목록 조회
// POST   /api/backups            → 수동 백업 생성
// DELETE /api/backups?id=        → 백업 삭제
// GET    /api/backups/download?id= → 백업 다운로드 URL 생성

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// Supabase signed URL 생성
async function createSignedUrl(supabaseUrl, supabaseKey, bucketName, path, expiresIn = 3600) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/${bucketName}/${path}`,
    {
      method: "POST",
      headers: {
        "apikey":        supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    }
  );
  if (!res.ok) throw new Error("서명된 URL 생성 실패");
  const data = await res.json();
  return `${supabaseUrl}/storage/v1${data.signedURL}`;
}

async function getSiteAndCheck(db, siteId, userId, role) {
  const site = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first();
  if (!site) return { error: "사이트를 찾을 수 없습니다.", status: 404 };
  if (site.user_id !== userId && role !== "admin")
    return { error: "권한이 없습니다.", status: 403 };
  return { site };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  const dlId   = url.searchParams.get("download_id");

  // 백업 다운로드 URL 생성
  if (dlId) {
    const snap = await env.DB.prepare(
      "SELECT fs.*, s.user_id, s.supabase_account FROM file_snapshots fs JOIN sites s ON fs.site_id = s.id WHERE fs.id = ?"
    ).bind(dlId).first();
    if (!snap) return jsonErr("백업을 찾을 수 없습니다.", 404);
    if (snap.user_id !== payload.id && payload.role !== "admin")
      return jsonErr("권한이 없습니다.", 403);

    const acct = snap.supabase_account || 1;
    const supabaseUrl = env[`SUPABASE_URL_${acct}_1`] || env.SUPABASE_URL;
    const supabaseKey = env[`SUPABASE_KEY_${acct}_1`] || env.SUPABASE_KEY;
    const bucket = await env.DB.prepare("SELECT supabase_bucket FROM sites WHERE id = ?").bind(snap.site_id).first();
    const bucketName = bucket?.supabase_bucket || "cloudpress-p1";

    try {
      const signedUrl = await createSignedUrl(supabaseUrl, supabaseKey, bucketName, snap.backup_path);
      return jsonOk({ success: true, download_url: signedUrl, expires_in: 3600 });
    } catch (e) {
      return jsonErr("다운로드 URL 생성 실패: " + e.message, 500);
    }
  }

  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);
  const { site, error, status } = await getSiteAndCheck(env.DB, siteId, payload.id, payload.role);
  if (error) return jsonErr(error, status);

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, snapshot_type, label, size, created_at FROM file_snapshots WHERE site_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(siteId).all();
    return jsonOk({ success: true, backups: results });
  } catch (e) {
    return jsonErr("백업 목록 조회 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_id, label } = body;
  if (!site_id) return jsonErr("site_id가 필요합니다.", 400);

  const { site, error, status } = await getSiteAndCheck(env.DB, site_id, payload.id, payload.role);
  if (error) return jsonErr(error, status);

  try {
    const backupPath = `backups/${site_id}/${Date.now()}.tar.gz`;
    const backupLabel = label || `수동 백업 ${new Date().toLocaleString("ko-KR")}`;

    await env.DB.prepare(
      `INSERT INTO file_snapshots (site_id, backup_path, snapshot_type, label, created_at)
       VALUES (?, ?, 'manual', ?, ?)`
    ).bind(site_id, backupPath, backupLabel, new Date().toISOString()).run();

    return jsonOk({ success: true, message: "백업이 생성되었습니다.", label: backupLabel });
  } catch (e) {
    return jsonErr("백업 생성 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("백업 ID가 필요합니다.", 400);

  try {
    const snap = await env.DB.prepare(
      "SELECT fs.*, s.user_id FROM file_snapshots fs JOIN sites s ON fs.site_id = s.id WHERE fs.id = ?"
    ).bind(id).first();
    if (!snap) return jsonErr("백업을 찾을 수 없습니다.", 404);
    if (snap.user_id !== payload.id && payload.role !== "admin")
      return jsonErr("권한이 없습니다.", 403);

    await env.DB.prepare("DELETE FROM file_snapshots WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "백업이 삭제되었습니다." });
  } catch (e) {
    return jsonErr("백업 삭제 오류: " + e.message, 500);
  }
}
