// functions/api/admin.js
// GET /api/admin/stats     → 전체 통계
// GET /api/admin/users     → 사용자 목록
// PUT /api/admin/users?id= → 사용자 플랜/역할 변경
// DEL /api/admin/users?id= → 사용자 삭제
// GET /api/admin/sites     → 전체 사이트 목록
// PUT /api/admin/sites?id= → 사이트 상태 변경
// DEL /api/admin/sites?id= → 사이트 강제 삭제

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return null;
  if (payload.role !== "admin") return null;
  return payload;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  const url  = new URL(request.url);
  const path = url.pathname.replace(/.*\/api\/admin\/?/, "");

  try {
    // ── 통계 ──────────────────────────────────────────────────────────────────
    if (path === "stats" || path === "") {
      const [usersRow, sitesRow, activeRow] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM sites").first(),
        env.DB.prepare("SELECT COUNT(*) as cnt FROM sites WHERE status = 'active'").first(),
      ]);
      const planRows = await env.DB.prepare(
        "SELECT plan, COUNT(*) as cnt FROM users GROUP BY plan"
      ).all();
      return jsonOk({
        success: true,
        stats: {
          total_users:   usersRow?.cnt   || 0,
          total_sites:   sitesRow?.cnt   || 0,
          active_sites:  activeRow?.cnt  || 0,
          plans: planRows.results || [],
        },
      });
    }

    // ── 사용자 목록 ──────────────────────────────────────────────────────────
    if (path === "users") {
      const page  = parseInt(url.searchParams.get("page") || "1");
      const limit = 50;
      const offset = (page - 1) * limit;
      const search = url.searchParams.get("q") || "";

      let query, args;
      if (search) {
        query = `SELECT id, email, role, plan, created_at FROM users WHERE email LIKE ? ORDER BY rowid DESC LIMIT ? OFFSET ?`;
        args  = [`%${search}%`, limit, offset];
      } else {
        query = `SELECT id, email, role, plan, created_at FROM users ORDER BY rowid DESC LIMIT ? OFFSET ?`;
        args  = [limit, offset];
      }
      const { results } = await env.DB.prepare(query).bind(...args).all();
      const total = (await env.DB.prepare(
        search
          ? "SELECT COUNT(*) as cnt FROM users WHERE email LIKE ?"
          : "SELECT COUNT(*) as cnt FROM users"
      ).bind(...(search ? [`%${search}%`] : [])).first())?.cnt || 0;

      return jsonOk({ success: true, users: results, total, page, limit });
    }

    // ── 전체 사이트 목록 ─────────────────────────────────────────────────────
    if (path === "sites") {
      const page   = parseInt(url.searchParams.get("page") || "1");
      const limit  = 50;
      const offset = (page - 1) * limit;
      const { results } = await env.DB.prepare(
        `SELECT s.id, s.site_name, s.primary_domain, s.php_version, s.status,
                s.created_at, u.email as owner_email, u.plan as owner_plan
         FROM sites s JOIN users u ON s.user_id = u.id
         ORDER BY s.rowid DESC LIMIT ? OFFSET ?`
      ).bind(limit, offset).all();
      const total = (await env.DB.prepare("SELECT COUNT(*) as cnt FROM sites").first())?.cnt || 0;
      return jsonOk({ success: true, sites: results, total, page, limit });
    }

    return jsonErr("알 수 없는 경로입니다.", 404);
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  const url  = new URL(request.url);
  const path = url.pathname.replace(/.*\/api\/admin\/?/, "");
  const id   = url.searchParams.get("id");

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  try {
    if (path === "users" && id) {
      const allowed = ["plan", "role"];
      const updates = [], values = [];
      for (const k of allowed) {
        if (body[k] !== undefined) { updates.push(`${k} = ?`); values.push(body[k]); }
      }
      if (!updates.length) return jsonErr("변경할 항목이 없습니다.", 400);
      values.push(id);
      await env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
      return jsonOk({ success: true, message: "사용자 정보가 변경되었습니다." });
    }

    if (path === "sites" && id) {
      const allowed = ["status", "php_version", "is_throttled"];
      const updates = [], values = [];
      for (const k of allowed) {
        if (body[k] !== undefined) { updates.push(`${k} = ?`); values.push(body[k]); }
      }
      if (!updates.length) return jsonErr("변경할 항목이 없습니다.", 400);
      values.push(id);
      await env.DB.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
      return jsonOk({ success: true, message: "사이트 정보가 변경되었습니다." });
    }

    return jsonErr("알 수 없는 경로입니다.", 404);
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  const url  = new URL(request.url);
  const path = url.pathname.replace(/.*\/api\/admin\/?/, "");
  const id   = url.searchParams.get("id");
  if (!id) return jsonErr("ID가 필요합니다.", 400);

  try {
    if (path === "users") {
      // 관리자 자신은 삭제 불가
      if (id === admin.id) return jsonErr("자기 자신은 삭제할 수 없습니다.", 400);
      await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?)").bind(id).run();
      await env.DB.prepare("DELETE FROM sites WHERE user_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return jsonOk({ success: true, message: "사용자와 관련 데이터가 삭제되었습니다." });
    }
    if (path === "sites") {
      await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM site_ssh_keys WHERE site_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
      return jsonOk({ success: true, message: "사이트가 삭제되었습니다." });
    }
    return jsonErr("알 수 없는 경로입니다.", 404);
  } catch (e) {
    return jsonErr("서버 오류: " + e.message, 500);
  }
}
