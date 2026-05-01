// functions/api/sites.js
import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";

// ── WP-CLI 설치 스크립트 생성 ─────────────────────────────────────────────────
function buildWpCliScript({ siteId, domain, adminUser, adminPass, adminEmail, dbName, dbUser, dbPass, dbHost, phpVersion }) {
  const phpBin = `php${phpVersion.split(".").slice(0,2).join(".")}`;
  return [
    `#!/bin/bash`,
    `# CloudPress WP-CLI 자동 설치 — 사이트 ID: ${siteId}`,
    `set -euo pipefail`,
    `SITE_DIR="/var/www/${siteId}"`,
    `PHP_BIN="${phpBin}"`,
    `WP_CLI="/usr/local/bin/wp"`,
    ``,
    `# ── 디렉터리 준비 ──`,
    `mkdir -p "$SITE_DIR"`,
    `cd "$SITE_DIR"`,
    `chown -R www-data:www-data "$SITE_DIR"`,
    ``,
    `# ── WP-CLI 설치 확인 ──`,
    `if [ ! -f "$WP_CLI" ]; then`,
    `  curl -sO https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`,
    `  chmod +x wp-cli.phar`,
    `  mv wp-cli.phar "$WP_CLI"`,
    `fi`,
    ``,
    `# ── WordPress 코어 다운로드 (한국어) ──`,
    `"$WP_CLI" core download --locale=ko_KR --allow-root --path="$SITE_DIR"`,
    ``,
    `# ── wp-config.php 생성 ──`,
    `"$WP_CLI" config create \\`,
    `  --dbname="${dbName}" \\`,
    `  --dbuser="${dbUser}" \\`,
    `  --dbpass="${dbPass}" \\`,
    `  --dbhost="${dbHost}" \\`,
    `  --dbprefix="wp_" \\`,
    `  --allow-root --path="$SITE_DIR"`,
    ``,
    `# ── 데이터베이스 생성 ──`,
    `"$WP_CLI" db create --allow-root --path="$SITE_DIR" || true`,
    ``,
    `# ── WordPress 설치 ──`,
    `"$WP_CLI" core install \\`,
    `  --url="https://${domain}" \\`,
    `  --title="${domain}" \\`,
    `  --admin_user="${adminUser}" \\`,
    `  --admin_password="${adminPass}" \\`,
    `  --admin_email="${adminEmail}" \\`,
    `  --skip-email \\`,
    `  --allow-root --path="$SITE_DIR"`,
    ``,
    `# ── 기본 플러그인 제거 ──`,
    `"$WP_CLI" plugin delete hello akismet --allow-root --path="$SITE_DIR" || true`,
    ``,
    `# ── 기본 포스트/댓글 제거 ──`,
    `"$WP_CLI" post delete 1 2 --force --allow-root --path="$SITE_DIR" || true`,
    ``,
    `# ── 퍼머링크 설정 ──`,
    `"$WP_CLI" rewrite structure '/%postname%/' --allow-root --path="$SITE_DIR"`,
    `"$WP_CLI" rewrite flush --allow-root --path="$SITE_DIR"`,
    ``,
    `# ── 파일 권한 설정 ──`,
    `find "$SITE_DIR" -type d -exec chmod 755 {} \\;`,
    `find "$SITE_DIR" -type f -exec chmod 644 {} \\;`,
    `chown -R www-data:www-data "$SITE_DIR"`,
    ``,
    `echo "[CloudPress] WordPress 설치 완료: https://${domain}"`,
    `echo "[CloudPress] 관리자: https://${domain}/wp-admin"`,
  ].join("\n");
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");

  try {
    if (id) {
      const site = await env.DB.prepare(
        "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
      ).bind(id, payload.id, payload.role).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

      const { results: domains } = await env.DB.prepare(
        "SELECT * FROM domain_aliases WHERE site_id = ? ORDER BY is_primary DESC"
      ).bind(id).all();
      const { results: sshKeys } = await env.DB.prepare(
        "SELECT id, key_name, created_at FROM site_ssh_keys WHERE site_id = ?"
      ).bind(id).all();

      return jsonOk({ success: true, site, domains, sshKeys });
    }

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

// ── POST ──────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { site_name, php_version = "8.2", wp_admin_user, wp_admin_pass, wp_admin_email } = body;

  if (!site_name?.trim())       return jsonErr("사이트 이름을 입력해주세요.", 400);
  if (!wp_admin_user?.trim())   return jsonErr("WordPress 관리자 아이디를 입력해주세요.", 400);
  if (!wp_admin_pass || wp_admin_pass.length < 8)
    return jsonErr("WordPress 비밀번호는 8자 이상이어야 합니다.", 400);
  if (!wp_admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wp_admin_email))
    return jsonErr("올바른 관리자 이메일을 입력해주세요.", 400);

  // ── 플랜 한도 체크 ──────────────────────────────────────────────────────────
  try {
    const user = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
    const plan   = user?.plan || "free";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const row    = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?"
    ).bind(payload.id).first();
    const cnt = row?.cnt || 0;
    if (limits.sites !== Infinity && cnt >= limits.sites)
      return jsonErr(
        `${plan} 플랜에서는 사이트를 최대 ${limits.sites}개까지 생성할 수 있습니다.`, 403
      );
  } catch (e) {
    console.error("[sites/post] plan check:", e);
  }

  // ── ID / 내부 도메인 생성 ────────────────────────────────────────────────────
  const id          = crypto.randomUUID();
  const shortId     = id.replace(/-/g, "").slice(0, 8);
  const internalHost = `${shortId}.sites.cloudpress.app`;

  // ── DB 자격증명 생성 ─────────────────────────────────────────────────────────
  const dbName = `wp_${id.replace(/-/g,"").slice(0,16)}`;
  const dbUser = `u_${id.replace(/-/g,"").slice(0,12)}`;
  const dbPass = crypto.randomUUID().replace(/-/g,"");
  const dbHost = env.DEFAULT_DB_HOST || "127.0.0.1";

  // ── Supabase 버킷 할당 시도 (실패해도 사이트 생성 계속) ─────────────────────
  let bucketName        = null;
  let supabaseAccountNo = null;
  let supabaseUrl       = null;

  try {
    // 환경변수에서 직접 Supabase URL/KEY 읽기 (DB 조회 우선, 없으면 env 직접)
    const slot = await env.DB.prepare(
      "SELECT * FROM supabase_accounts WHERE used_gb < max_gb ORDER BY used_gb ASC LIMIT 1"
    ).first().catch(() => null);

    const sUrl = slot ? env[slot.supabase_url] : (env.SUPABASE_URL || null);
    const sKey = slot ? env[slot.supabase_key] : (env.SUPABASE_KEY || null);

    if (sUrl && sKey) {
      const bName = `site-${shortId}`;
      const res = await fetch(`${sUrl}/storage/v1/bucket`, {
        method: "POST",
        headers: {
          apikey: sKey, Authorization: `Bearer ${sKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: bName, name: bName, public: false, file_size_limit: 524288000 }),
      });
      const txt = await res.text();
      if (res.ok || txt.includes("already exists")) {
        bucketName        = bName;
        supabaseAccountNo = slot?.account_no ?? 1;
        supabaseUrl       = sUrl;
        // used_gb 업데이트
        if (slot) {
          await env.DB.prepare(
            "UPDATE supabase_accounts SET used_gb = used_gb + 0.01 WHERE account_no = ?"
          ).bind(slot.account_no).run().catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn("[sites/post] Supabase skip:", e.message);
  }

  // ── WP-CLI 설치 스크립트 ──────────────────────────────────────────────────────
  const wpScript = buildWpCliScript({
    siteId: id, domain: internalHost,
    adminUser: wp_admin_user, adminPass: wp_admin_pass, adminEmail: wp_admin_email,
    dbName, dbUser, dbPass, dbHost,
    phpVersion: php_version,
  });

  // ── DB 저장 ───────────────────────────────────────────────────────────────────
  try {
    await env.DB.prepare(
      `INSERT INTO sites
        (id, user_id, site_name, primary_domain, php_version, status,
         supabase_bucket, supabase_account,
         wp_admin_user, wp_admin_pass, wp_admin_email,
         db_name, db_user, db_pass, db_host,
         wp_install_script, cache_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      id, payload.id, site_name.trim(), internalHost, php_version,
      bucketName, supabaseAccountNo,
      wp_admin_user, wp_admin_pass, wp_admin_email,
      dbName, dbUser, dbPass, dbHost,
      wpScript,
      new Date().toISOString()
    ).run();
  } catch (e) {
    return jsonErr("호스팅 생성 오류: " + e.message, 500);
  }

  // ── WP 설치 큐 등록 ───────────────────────────────────────────────────────────
  if (env.INSTALL_QUEUE) {
    await env.INSTALL_QUEUE.put(
      `install:${id}`,
      JSON.stringify({
        site_id: id, domain: internalHost, php_version,
        wp_script: wpScript, queued_at: new Date().toISOString(),
      }),
      { expirationTtl: 86400 }
    ).catch(() => {});
  }

  return jsonOk({
    success: true, id,
    message: "호스팅이 생성되었습니다! 호스팅 상세 > 도메인 탭에서 도메인을 추가하세요.",
    has_supabase: !!bucketName,
    internal_host: internalHost,
    wp_admin_url: `https://${internalHost}/wp-admin`,
  });
}

// ── PUT ───────────────────────────────────────────────────────────────────────
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

  const site = await env.DB.prepare("SELECT id, user_id FROM sites WHERE id = ?").bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  const allowed = ["php_version", "cache_enabled", "cache_ttl", "status"];
  const updates = [], values = [];
  for (const key of allowed) {
    if (body[key] !== undefined) { updates.push(`${key} = ?`); values.push(body[key]); }
  }
  if (!updates.length) return jsonErr("변경할 설정이 없습니다.", 400);
  values.push(id);

  try {
    await env.DB.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return jsonOk({ success: true, message: "설정이 저장되었습니다." });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);

  const site = await env.DB.prepare("SELECT id, user_id FROM sites WHERE id = ?").bind(id).first();
  if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
  if (site.user_id !== payload.id && payload.role !== "admin")
    return jsonErr("권한이 없습니다.", 403);

  try {
    await env.DB.prepare("DELETE FROM domain_aliases WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM site_ssh_keys WHERE site_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
    return jsonOk({ success: true, message: "호스팅이 삭제되었습니다." });
  } catch (e) {
    return jsonErr("삭제 오류: " + e.message, 500);
  }
}
