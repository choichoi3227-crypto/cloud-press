// functions/api/ssh-keys.js
// GET    /api/ssh-keys?site_id=  → SSH 키 목록
// POST   /api/ssh-keys           → SSH 공개키 등록
// DELETE /api/ssh-keys?id=       → SSH 키 삭제
// GET    /api/ssh-keys/info?site_id= → SSH/SFTP 접속 정보

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url    = new URL(request.url);
  const siteId = url.searchParams.get("site_id");
  if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  // SSH/SFTP 접속 정보 요청
  if (url.pathname.endsWith("/info")) {
    return jsonOk({
      success: true,
      ssh: {
        host:     site.primary_domain,
        port:     site.ssh_port || 22,
        user:     `wp-${site.id.slice(0, 8)}`,
        command:  `ssh -p ${site.ssh_port || 22} wp-${site.id.slice(0, 8)}@${site.primary_domain}`,
      },
      sftp: {
        host:     site.primary_domain,
        port:     site.sftp_port || 2222,
        user:     `wp-${site.id.slice(0, 8)}`,
        path:     "/var/www/html",
        command:  `sftp -P ${site.sftp_port || 2222} wp-${site.id.slice(0, 8)}@${site.primary_domain}`,
      },
    });
  }

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, key_name, created_at FROM site_ssh_keys WHERE site_id = ? ORDER BY created_at DESC"
    ).bind(siteId).all();
    return jsonOk({ success: true, keys: results });
  } catch (e) {
    return jsonErr("SSH 키 조회 오류: " + e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_id, key_name, public_key } = body;
  if (!site_id || !key_name || !public_key)
    return jsonErr("site_id, key_name, public_key 가 필요합니다.", 400);

  // SSH 공개키 형식 검증
  if (!public_key.startsWith("ssh-rsa") && !public_key.startsWith("ssh-ed25519") && !public_key.startsWith("ecdsa-sha2"))
    return jsonErr("올바른 SSH 공개키 형식이 아닙니다. (ssh-rsa, ssh-ed25519, ecdsa-sha2-nistp256 지원)", 400);

  const site = await env.DB.prepare("SELECT user_id FROM sites WHERE id = ?").bind(site_id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    await env.DB.prepare(
      "INSERT INTO site_ssh_keys (site_id, key_name, public_key, created_at) VALUES (?, ?, ?, ?)"
    ).bind(site_id, key_name, public_key, new Date().toISOString()).run();
    return jsonOk({ success: true, message: "SSH 키가 등록되었습니다." });
  } catch (e) {
    return jsonErr("SSH 키 등록 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("키 ID가 필요합니다.", 400);

  try {
    const key = await env.DB.prepare(
      "SELECT sk.*, s.user_id FROM site_ssh_keys sk JOIN sites s ON sk.site_id = s.id WHERE sk.id = ?"
    ).bind(id).first();
    if (!key) return jsonErr("SSH 키를 찾을 수 없습니다.", 404);
    if (key.user_id !== payload.id && payload.role !== "admin")
      return jsonErr("권한이 없습니다.", 403);

    await env.DB.prepare("DELETE FROM site_ssh_keys WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "SSH 키가 삭제되었습니다." });
  } catch (e) {
    return jsonErr("SSH 키 삭제 오류: " + e.message, 500);
  }
}
