/**
 * CloudPress 유료 상품 API
 * CloudPressDB (DynamoDB 유사) · CP3 (S3 유사) · CacheCloud (CloudFront 유사)
 */

import { jsonOk, jsonErr, requireAuth, isAdminEmail } from "../_shared.js";
import {
  ghHealthCheck,
  buildDnsPlan,
  pickServerFromPlan,
  storagePathForAssignment,
} from "./products-dns.js";

const PRODUCT_TYPES = ["cpdb", "cp3", "cachecloud"];

async function ensureProductTables(env) {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS product_pool_servers (
      id TEXT PRIMARY KEY, product_type TEXT NOT NULL, name TEXT NOT NULL,
      github_owner TEXT NOT NULL, github_repo TEXT NOT NULL, github_token TEXT,
      weight INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1,
      health_status TEXT NOT NULL DEFAULT 'unknown', health_message TEXT,
      health_checked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS product_dns_plans (
      id TEXT PRIMARY KEY, product_type TEXT NOT NULL, plan_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS site_product_assignments (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, user_id TEXT NOT NULL,
      product_type TEXT NOT NULL, server_id TEXT NOT NULL, storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, product_type))`,
    `CREATE TABLE IF NOT EXISTS user_product_subscriptions (
      user_id TEXT NOT NULL, product_type TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'inactive', expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, product_type))`,
    `CREATE TABLE IF NOT EXISTS cachecloud_sites (
      site_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, worker_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ];
  for (const sql of sqls) await env.DB.prepare(sql).run().catch(() => {});
}

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return { error: jsonErr("인증이 필요합니다.", 401) };
  if (payload.role !== "admin" && !isAdminEmail(payload.email)) {
    return { error: jsonErr("관리자 권한이 필요합니다.", 403) };
  }
  return { payload };
}

async function ghPutJson(token, owner, repo, path, contentObj, message) {
  const content = JSON.stringify(contentObj, null, 2);
  const b64 = btoa(unescape(encodeURIComponent(content)));
  let sha = null;
  const getRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  }
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, content: b64, sha }),
    }
  );
  return res.ok;
}

async function getActiveDnsPlan(env, productType) {
  const row = await env.DB.prepare(
    "SELECT plan_json FROM product_dns_plans WHERE product_type = ? AND active = 1 ORDER BY created_at DESC LIMIT 1"
  ).bind(productType).first().catch(() => null);
  if (!row?.plan_json) return null;
  try { return JSON.parse(row.plan_json); } catch { return null; }
}

async function runHealthCheckAndPlan(env, productType) {
  const { results: servers } = await env.DB.prepare(
    "SELECT * FROM product_pool_servers WHERE product_type = ? ORDER BY name"
  ).bind(productType).all();
  const now = new Date().toISOString();
  for (const s of servers || []) {
    const hc = await ghHealthCheck({
      owner: s.github_owner,
      repo: s.github_repo,
      token: s.github_token,
    });
    await env.DB.prepare(
      "UPDATE product_pool_servers SET health_status = ?, health_message = ?, health_checked_at = ? WHERE id = ?"
    ).bind(hc.status, hc.message, now, s.id).run();
    s.health_status = hc.status;
    s.health_message = hc.message;
  }
  const refreshed = await env.DB.prepare(
    "SELECT * FROM product_pool_servers WHERE product_type = ?"
  ).bind(productType).all();
  const plan = buildDnsPlan(refreshed.results || []);
  await env.DB.prepare(
    "UPDATE product_dns_plans SET active = 0 WHERE product_type = ?"
  ).bind(productType).run().catch(() => {});
  const planId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO product_dns_plans (id, product_type, plan_json, active, created_at) VALUES (?, ?, ?, 1, ?)"
  ).bind(planId, productType, JSON.stringify(plan), now).run();
  return { servers: refreshed.results || [], plan, plan_id: planId };
}

async function assignSiteToProduct(env, { siteId, userId, productType, seed }) {
  const plan = await getActiveDnsPlan(env, productType);
  if (!plan?.entries?.length) return { error: "활성 DNS 플랜이 없습니다. 관리자에게 문의하세요." };
  const picked = pickServerFromPlan(plan, seed || `${userId}:${siteId}`);
  if (!picked) return { error: "할당 가능한 서버가 없습니다." };
  const server = await env.DB.prepare(
    "SELECT * FROM product_pool_servers WHERE id = ?"
  ).bind(picked.server_id).first();
  if (!server) return { error: "서버를 찾을 수 없습니다." };
  const storagePath = storagePathForAssignment(productType, userId, siteId);
  const assignId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO site_product_assignments (id, site_id, user_id, product_type, server_id, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, product_type) DO UPDATE SET
       server_id = excluded.server_id, storage_path = excluded.storage_path`
  ).bind(assignId, siteId, userId, productType, server.id, storagePath, new Date().toISOString()).run();

  if (productType === "cpdb" && server.github_token) {
    const dbJson = {
      _version: "1.0",
      _engine: "cloudpress-db-shard",
      site_id: siteId,
      user_id: userId,
      updated_at: new Date().toISOString(),
      tables: { options: [], posts: [], users: [] },
    };
    await ghPutJson(
      server.github_token,
      server.github_owner,
      server.github_repo,
      `${storagePath}/wordpress.db.json`,
      dbJson,
      `init: CPDB shard for site ${siteId}`
    ).catch(() => {});
    await ghPutJson(
      server.github_token,
      server.github_owner,
      server.github_repo,
      `${storagePath}/meta.json`,
      { site_id: siteId, user_id: userId, product: "cpdb" },
      `init: CPDB meta ${siteId}`
    ).catch(() => {});
  }

  if (productType === "cp3" && server.github_token) {
    await ghPutJson(
      server.github_token,
      server.github_owner,
      server.github_repo,
      `${storagePath}/.cp3-meta.json`,
      { site_id: siteId, user_id: userId, product: "cp3", created_at: new Date().toISOString() },
      `init: CP3 bucket ${siteId}`
    ).catch(() => {});
  }

  return {
    assignment: {
      site_id: siteId,
      product_type: productType,
      server_id: server.id,
      server_name: server.name,
      github_owner: server.github_owner,
      github_repo: server.github_repo,
      storage_path: storagePath,
    },
    dns_plan: plan,
  };
}

function getSubPath(url) {
  return url.pathname.replace(/^\/api\/products\/?/, "").replace(/\/$/, "");
}

// ── GET ─────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  await ensureProductTables(env);
  const sub = getSubPath(new URL(request.url));
  const url = new URL(request.url);

  if (sub === "catalog") {
    return jsonOk({
      success: true,
      products: [
        { id: "hosting", name: "WordPress 호스팅", paid: false },
        { id: "cachecloud", name: "CacheCloud", paid: true, description: "CloudFront 유사 엣지 캐시" },
        { id: "cp3", name: "CP3", paid: true, description: "S3 유사 오브젝트 스토리지" },
        { id: "cpdb", name: "CloudPressDB", paid: true, description: "DynamoDB 유사 분산 DB" },
      ],
    });
  }

  const auth = await requireAuth(request, env);
  if (!auth) return jsonErr("인증이 필요합니다.", 401);

  if (sub === "subscriptions") {
    const { results } = await env.DB.prepare(
      "SELECT product_type, plan, status, expires_at FROM user_product_subscriptions WHERE user_id = ?"
    ).bind(auth.id).all();
    return jsonOk({ success: true, subscriptions: results || [] });
  }

  const siteId = url.searchParams.get("site_id");
  const type = url.searchParams.get("type") || "cpdb";

  if (sub === "assignment" && siteId) {
    let row = await env.DB.prepare(
      `SELECT a.*, s.name as server_name, s.github_owner, s.github_repo, s.health_status
       FROM site_product_assignments a
       JOIN product_pool_servers s ON a.server_id = s.id
       WHERE a.site_id = ? AND a.product_type = ?`
    ).bind(siteId, type).first().catch(() => null);
    if (!row) {
      const site = await env.DB.prepare(
        "SELECT id, user_id FROM sites WHERE id = ? AND user_id = ?"
      ).bind(siteId, auth.id).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
      const subRow = await env.DB.prepare(
        "SELECT status FROM user_product_subscriptions WHERE user_id = ? AND product_type = ?"
      ).bind(auth.id, type).first();
      if (type !== "hosting" && subRow?.status !== "active") {
        return jsonErr("해당 상품 구독이 필요합니다.", 402);
      }
      const assigned = await assignSiteToProduct(env, {
        siteId, userId: auth.id, productType: type,
      });
      if (assigned.error) return jsonErr(assigned.error, 503);
      row = { ...assigned.assignment, health_status: "healthy" };
    }
    const plan = await getActiveDnsPlan(env, type);
    return jsonOk({ success: true, assignment: row, dns_plan: plan });
  }

  if (sub === "dns-plan") {
    const plan = await getActiveDnsPlan(env, type);
    return jsonOk({ success: true, product_type: type, plan });
  }

  if (sub === "cachecloud" && siteId) {
    const row = await env.DB.prepare(
      "SELECT * FROM cachecloud_sites WHERE site_id = ? AND user_id = ?"
    ).bind(siteId, auth.id).first();
    return jsonOk({ success: true, cachecloud: row || null });
  }

  // Admin: pool servers list
  if (sub === "admin/servers") {
    const admin = await requireAdmin(request, env);
    if (admin.error) return admin.error;
    const pt = url.searchParams.get("type") || "cpdb";
    const { results } = await env.DB.prepare(
      `SELECT id, product_type, name, github_owner, github_repo,
              weight, enabled, health_status, health_message, health_checked_at, created_at
       FROM product_pool_servers WHERE product_type = ? ORDER BY name`
    ).bind(pt).all();
    const plan = await getActiveDnsPlan(env, pt);
    return jsonOk({ success: true, servers: results || [], dns_plan: plan });
  }

  return jsonErr("알 수 없는 경로", 404);
}

// ── POST ────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  await ensureProductTables(env);
  const sub = getSubPath(new URL(request.url));

  let body = {};
  try { body = await request.json(); } catch {}

  if (sub === "admin/servers") {
    const admin = await requireAdmin(request, env);
    if (admin.error) return admin.error;
    const { product_type, name, github_owner, github_repo, github_token, weight } = body;
    if (!PRODUCT_TYPES.includes(product_type) || product_type === "cachecloud") {
      return jsonErr("product_type은 cpdb 또는 cp3 이어야 합니다.", 400);
    }
    if (!name || !github_repo) return jsonErr("name, github_repo 필수", 400);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO product_pool_servers
       (id, product_type, name, github_owner, github_repo, github_token, weight, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      id, product_type, name,
      github_owner || "", github_repo, github_token || "",
      Number(weight) || 100
    ).run();
    await runHealthCheckAndPlan(env, product_type);
    return jsonOk({ success: true, id, message: "DB/스토리지 서버가 등록되었습니다." });
  }

  if (sub === "admin/health-check") {
    const admin = await requireAdmin(request, env);
    if (admin.error) return admin.error;
    const pt = body.product_type || "cpdb";
    const result = await runHealthCheckAndPlan(env, pt);
    return jsonOk({ success: true, ...result });
  }

  if (sub === "subscribe") {
    const auth = await requireAuth(request, env);
    if (!auth) return jsonErr("인증이 필요합니다.", 401);
    const { product_type, plan } = body;
    if (!["cachecloud", "cp3", "cpdb"].includes(product_type)) {
      return jsonErr("유효하지 않은 상품", 400);
    }
    await env.DB.prepare(
      `INSERT INTO user_product_subscriptions (user_id, product_type, plan, status, created_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(user_id, product_type) DO UPDATE SET plan = excluded.plan, status = 'active'`
    ).bind(auth.id, product_type, plan || "standard", new Date().toISOString()).run();
    return jsonOk({ success: true, message: "구독이 활성화되었습니다." });
  }

  if (sub === "cachecloud/enable") {
    const auth = await requireAuth(request, env);
    if (!auth) return jsonErr("인증이 필요합니다.", 401);
    const { site_id, worker_name } = body;
    if (!site_id) return jsonErr("site_id 필수", 400);
    const site = await env.DB.prepare(
      "SELECT id FROM sites WHERE id = ? AND user_id = ?"
    ).bind(site_id, auth.id).first();
    if (!site) return jsonErr("사이트 없음", 404);
    await env.DB.prepare(
      `INSERT INTO cachecloud_sites (site_id, user_id, worker_name, enabled, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(site_id) DO UPDATE SET worker_name = excluded.worker_name, enabled = 1`
    ).bind(site_id, auth.id, worker_name || `cp-cache-${site_id.slice(0, 8)}`, new Date().toISOString()).run();
    return jsonOk({ success: true, message: "CacheCloud가 활성화되었습니다." });
  }

  if (sub === "cpdb/write") {
    const auth = await requireAuth(request, env);
    if (!auth) return jsonErr("인증이 필요합니다.", 401);
    const { site_id, data } = body;
    const assigned = await assignSiteToProduct(env, {
      siteId: site_id, userId: auth.id, productType: "cpdb",
    });
    if (assigned.error) return jsonErr(assigned.error, 503);
    const a = assigned.assignment;
    const server = await env.DB.prepare("SELECT * FROM product_pool_servers WHERE id = ?")
      .bind(a.server_id).first();
    if (!server?.github_token) return jsonErr("서버 토큰 없음", 503);
    const ok = await ghPutJson(
      server.github_token, server.github_owner, server.github_repo,
      `${a.storage_path}/wordpress.db.json`, data || {},
      `sync: CPDB ${site_id}`
    );
    return jsonOk({ success: ok, storage_path: a.storage_path });
  }

  return jsonErr("알 수 없는 경로", 404);
}

// ── DELETE ──────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  await ensureProductTables(env);
  const sub = getSubPath(new URL(request.url));
  const id = new URL(request.url).searchParams.get("id");

  if (sub === "admin/servers" && id) {
    const admin = await requireAdmin(request, env);
    if (admin.error) return admin.error;
    const row = await env.DB.prepare("SELECT product_type FROM product_pool_servers WHERE id = ?")
      .bind(id).first();
    await env.DB.prepare("DELETE FROM product_pool_servers WHERE id = ?").bind(id).run();
    if (row?.product_type) await runHealthCheckAndPlan(env, row.product_type);
    return jsonOk({ success: true });
  }

  return jsonErr("알 수 없는 경로", 404);
}
