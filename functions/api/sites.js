// functions/api/sites.js
// GET    /api/sites           → 내 사이트 목록
// POST   /api/sites           → 새 호스팅 생성
// GET    /api/sites?id=       → 사이트 상세 조회
// PUT    /api/sites?id=       → 사이트 설정 수정
// DELETE /api/sites?id=       → 사이트 삭제
import { jsonOk, jsonErr, requireAuth, PLAN_LIMITS } from "../_shared.js";

// ── WP-CLI를 통한 WordPress 설치 명령 생성 ───────────────────────────────────
// 실제 WP-CLI 실행은 서버 에이전트(Worker AI / VPS 등)가 처리하며,
// 여기서는 설치 작업을 큐에 등록하고 설치 스크립트를 DB에 저장합니다.
function buildWpCliScript({ domain, adminUser, adminPass, adminEmail, dbName, dbUser, dbPass, dbHost, phpVersion }) {
  return [
    `#!/bin/bash`,
    `# CloudPress WP-CLI 자동 설치 스크립트`,
    `# PHP ${phpVersion} 사용`,
    `set -e`,
    `SITE_DIR="/var/www/${domain}"`,
    `mkdir -p "$SITE_DIR"`,
    `cd "$SITE_DIR"`,
    `# WordPress 코어 다운로드`,
    `wp core download --locale=ko_KR --allow-root`,
    `# wp-config.php 생성`,
    `wp config create \\`,
    `  --dbname="${dbName}" \\`,
    `  --dbuser="${dbUser}" \\`,
    `  --dbpass="${dbPass}" \\`,
    `  --dbhost="${dbHost}" \\`,
    `  --allow-root`,
    `# WordPress 설치`,
    `wp core install \\`,
    `  --url="https://${domain}" \\`,
    `  --title="${domain}" \\`,
    `  --admin_user="${adminUser}" \\`,
    `  --admin_password="${adminPass}" \\`,
    `  --admin_email="${adminEmail}" \\`,
    `  --skip-email \\`,
    `  --allow-root`,
    `# 기본 플러그인 정리`,
    `wp plugin delete hello akismet --allow-root || true`,
    `# 퍼머링크 설정`,
    `wp rewrite structure '/%postname%/' --allow-root`,
    `wp rewrite flush --allow-root`,
    `echo "WordPress 설치 완료: https://${domain}"`,
  ].join("\n");
}

// ── 플랜별 허용 PHP 버전 검증 ────────────────────────────────────────────────
function isPhpVersionAllowedForPlan(phpVersion, plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (!limits.allowed_php) return true; // 제한 없음
  const major = phpVersion.split(".").slice(0, 2).join(".");
  return limits.allowed_php.includes(major);
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

      const { results: domains } = await env.DB.prepare(
        "SELECT * FROM domain_aliases WHERE site_id = ?"
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const {
    site_name,
    php_version = "8.2",
    wp_admin_user,
    wp_admin_pass,
    wp_admin_email,
  } = body;

  if (!site_name)
    return jsonErr("사이트 이름을 입력해주세요.", 400);
  if (!wp_admin_user || !wp_admin_pass)
    return jsonErr("WordPress 관리자 아이디와 비밀번호를 입력해주세요.", 400);
  if (!wp_admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wp_admin_email))
    return jsonErr("올바른 관리자 이메일을 입력해주세요.", 400);

  // ── 플랜 한도 체크 ──────────────────────────────────────────────────────────
  let plan = "free";
  try {
    const user = await env.DB.prepare("SELECT plan FROM users WHERE id = ?").bind(payload.id).first();
    plan = user?.plan || "free";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // 사이트 수 제한
    const { results: existing } = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM sites WHERE user_id = ?"
    ).bind(payload.id).all();
    const cnt = existing[0]?.cnt || 0;
    if (limits.sites !== Infinity && cnt >= limits.sites) {
      return jsonErr(
        `현재 플랜(${plan})에서는 사이트를 최대 ${limits.sites}개까지 생성할 수 있습니다. 업그레이드 후 더 많은 사이트를 생성하세요.`,
        403
      );
    }

    // 도메인은 호스팅 상세에서 별도 추가 (생성 시 불필요)
  } catch (e) {
    console.error("[sites/post] plan check:", e);
  }

  // ── Supabase 버킷은 옵션 (없어도 사이트 생성 진행) ──────────────────────────
  // Supabase 설정이 없으면 로컬 스토리지 또는 추후 연결로 처리
  let bucketName = null;
  let supabaseAccountNo = null;

  try {
    const { results: slots } = await env.DB.prepare(
      "SELECT * FROM supabase_accounts WHERE used_gb < max_gb ORDER BY account_no, project_no"
    ).all();
    const slot = slots?.[0];
    if (slot) {
      const supabaseUrl = env[slot.supabase_url];
      const supabaseKey = env[slot.supabase_key];
      if (supabaseUrl && supabaseKey) {
        const bName = `site-${crypto.randomUUID().slice(0, 8)}`;
        const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
          method: "POST",
          headers: {
            apikey:          supabaseKey,
            Authorization:   `Bearer ${supabaseKey}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({
            id:              bName,
            name:            bName,
            public:          false,
            file_size_limit: 524288000, // 500MB
          }),
        });
        if (res.ok || (await res.text()).includes("already exists")) {
          bucketName = bName;
          supabaseAccountNo = slot.account_no;
        }
      }
    }
  } catch (e) {
    // Supabase 연결 실패 — 사이트 생성은 계속 진행
    console.warn("[sites/post] Supabase 버킷 생성 스킵:", e.message);
  }

  // ── DB에 사이트 저장 ────────────────────────────────────────────────────────
  try {
    const id      = crypto.randomUUID();
    const sshPort = 2200 + Math.floor(Math.random() * 8000);
    const sftpPort = sshPort + 1;

    // 임시 내부 도메인 (실제 도메인은 호스팅 상세에서 추가)
    const shortId       = id.replace(/-/g, "").slice(0, 8);
    const internal_host = `${shortId}.internal.cloudpress.app`;

    // DB 이름/사용자는 UUID 기반 생성
    const dbName  = `wp_${id.replace(/-/g, "").slice(0, 16)}`;
    const dbUser  = `u_${id.replace(/-/g, "").slice(0, 12)}`;
    const dbPass  = crypto.randomUUID().replace(/-/g, "");
    const dbHost  = env.DEFAULT_DB_HOST || "localhost";

    // WP-CLI 설치 스크립트 생성 (임시 도메인으로)
    const wpScript = buildWpCliScript({
      domain:     internal_host,
      adminUser:  wp_admin_user,
      adminPass:  wp_admin_pass,
      adminEmail: wp_admin_email,
      dbName,
      dbUser,
      dbPass,
      dbHost,
      phpVersion: php_version,
    });

    await env.DB.prepare(
      `INSERT INTO sites
        (id, user_id, site_name, primary_domain, php_version, status,
         supabase_bucket, supabase_account, ssh_port, sftp_port,
         wp_admin_user, wp_admin_pass, wp_admin_email,
         db_name, db_user, db_pass, db_host,
         wp_install_script, cache_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      id, payload.id, site_name, internal_host, php_version,
      bucketName,        // NULL이어도 OK
      supabaseAccountNo, // NULL이어도 OK
      sshPort, sftpPort,
      wp_admin_user, wp_admin_pass, wp_admin_email,
      dbName, dbUser, dbPass, dbHost,
      wpScript,
      new Date().toISOString()
    ).run();

    // 도메인은 호스팅 상세 > 도메인 탭에서 별도 추가

    // WP 설치 작업을 큐에 등록 (INSTALL_QUEUE KV가 있을 때만)
    if (env.INSTALL_QUEUE) {
      await env.INSTALL_QUEUE.put(
        `install:${id}`,
        JSON.stringify({
          site_id:     id,
          domain:      primary_domain,
          php_version,
          wp_script:   wpScript,
          queued_at:   new Date().toISOString(),
        }),
        { expirationTtl: 86400 }
      );
    }

    return jsonOk({
      success:       true,
      id,
      message:       "호스팅이 생성되었습니다. 호스팅 상세 > 도메인 탭에서 도메인을 추가하세요.",
      ssh_port:      sshPort,
      sftp_port:     sftpPort,
      has_supabase:  !!bucketName,
      internal_host,
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
