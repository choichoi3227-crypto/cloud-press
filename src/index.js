/**
 * CloudPress Platform — src/index.js
 * 메인 Worker 라우터 (플랫폼 API + WordPress 서빙)
 */
import { WordPressEngine, SupabaseStorage } from "./wp-engine.js";

// ─── 유틸리티 ──────────────────────────────────────────────────────────────
function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
function jsonErr(msg, status = 400) { return jsonOk({ error: msg }, status); }

// ─── JWT 인증 ──────────────────────────────────────────────────────────────
async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const pad  = s => s + "=".repeat((4 - s.length % 4) % 4);
    const b64  = s => atob(pad(s.replace(/-/g,"+").replace(/_/g,"/")));
    const sig  = Uint8Array.from(b64(parts[2]), c => c.charCodeAt(0));
    const key  = await crypto.subtle.importKey("raw",
      new TextEncoder().encode(env.JWT_SECRET || "cloudpress-secret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, sig,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const payload = JSON.parse(b64(parts[1]));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─── 사이트 생성 (Supabase 버킷 자동 생성 포함) ───────────────────────────
async function createSiteWithBucket(env, userId, siteData) {
  const { site_name, primary_domain, php_version = "8.2", storage_limit = 10 } = siteData;

  if (!site_name || !primary_domain) throw new Error("사이트 이름과 도메인을 입력해주세요.");

  // Supabase Storage 초기화
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;

  const siteId = crypto.randomUUID();
  const shortId = siteId.replace(/-/g, "").slice(0, 20).toLowerCase();
  const bucketName = `site-${shortId}`;

  let supabaseBucket = null;
  let provisionError = null;

  // Supabase 버킷 생성
  if (supabaseUrl && supabaseKey) {
    const storage = new SupabaseStorage(supabaseUrl, supabaseKey);
    const ok = await storage.createBucket(bucketName);
    if (ok) {
      supabaseBucket = bucketName;
      // supabase_accounts에 기본 계정 등록 (없으면)
      await env.DB.prepare(
        `INSERT OR IGNORE INTO supabase_accounts (account_no, supabase_url, supabase_key, max_gb)
         VALUES ('default', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 450)`
      ).run().catch(() => {});
    } else {
      provisionError = "버킷 생성 실패";
    }
  } else {
    provisionError = "SUPABASE_URL/SUPABASE_SERVICE_KEY 환경변수 미설정";
  }

  // DB에 사이트 삽입 (버킷 생성 성공 여부와 관계없이 — 나중에 재시도 가능)
  await env.DB.prepare(
    `INSERT INTO sites
      (id, user_id, site_name, primary_domain, php_version, status,
       storage_limit, supabase_bucket, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    siteId, userId, site_name, primary_domain, php_version,
    supabaseBucket ? "active" : "provisioning",
    storage_limit,
    supabaseBucket
  ).run();

  return { siteId, bucketName: supabaseBucket, provisionError };
}

// ─── Scheduled Worker (WordPress Cron + 설치 큐 처리) ─────────────────────
async function handleScheduled(event, env) {
  // 설치 큐 처리: zip이 업로드된 사이트들의 WordPress 압축 해제
  if (env.KV && env.PHP_RUNNER) {
    try {
      const list = await env.KV.list({ prefix: "wp:installing:" });
      for (const key of (list.keys || []).slice(0, 5)) {
        const status = await env.KV.get(key.name);
        if (status === "2") {
          // ZIP 업로드 완료 → PHP Runner에서 압축 해제 요청
          const siteId = key.name.replace("wp:installing:", "");
          await env.PHP_RUNNER.fetch(new Request("https://php/extract-wordpress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ siteId }),
          })).catch(console.error);
        }
      }
    } catch (e) {
      console.error("[scheduled] 설치 큐 오류:", e.message);
    }
  }
}

// ─── 메인 Export ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    // ── 건강 체크 ────────────────────────────────────────────────────────
    if (url.pathname === "/api/health") {
      return jsonOk({
        status: "ok",
        version: "3.0.0",
        bindings: {
          DB: !!env.DB, KV: !!env.KV, CACHE: !!env.CACHE,
          PHP_RUNNER: !!env.PHP_RUNNER,
        },
        supabase: !!env.SUPABASE_URL,
        ts: new Date().toISOString(),
      });
    }

    // ── 플랫폼 API 라우팅 (/api/*) ────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, method);
    }

    // ── WordPress 사이트 라우팅 ───────────────────────────────────────────
    // 1) 쿼리스트링으로 사이트 ID 직접 지정 (개발/테스트)
    let siteId = url.searchParams.get("__site_id");
    let site   = null;

    // 2) 호스트명에서 추출 (cp-site-XXXX.workers.dev)
    if (!siteId) {
      const m = url.hostname.match(/^cp-site-([a-z0-9]+)\.workers\.dev$/);
      if (m) siteId = m[1];
    }

    // 3) DB에서 커스텀 도메인 조회
    if (!siteId && env.DB) {
      site = await env.DB.prepare(
        "SELECT * FROM sites WHERE primary_domain = ? AND status IN ('active','provisioning') LIMIT 1"
      ).bind(url.hostname).first().catch(() => null);
      if (site) siteId = site.id;
    }

    if (siteId) {
      // site 정보 없으면 DB에서 조회
      if (!site && env.DB) {
        site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? LIMIT 1")
          .bind(siteId).first().catch(() => null);
      }
      if (!site) {
        site = { id: siteId, primary_domain: url.hostname, status: "active" };
      }

      // Supabase 설정 확인
      if (!env.SUPABASE_URL || (!env.SUPABASE_SERVICE_KEY && !env.SUPABASE_KEY)) {
        return new Response(
          `⚠️  Supabase 환경변수를 설정하세요:\n\n` +
          `  wrangler secret put SUPABASE_URL\n` +
          `  wrangler secret put SUPABASE_SERVICE_KEY\n\n` +
          `설정 후 wrangler deploy 를 다시 실행하세요.`,
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      const engine = new WordPressEngine(env, site);
      return engine.run(request);
    }

    // ── CloudPress 플랫폼 대시보드 (정적 파일) ────────────────────────────
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("CloudPress WordPress Hosting Platform v3.0\n배포 완료 ✅", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

// ─── API 핸들러 ────────────────────────────────────────────────────────────
async function handleApi(request, env, url, method) {
  // ── POST /api/sites (사이트 생성) ──────────────────────────────────────
  if (url.pathname === "/api/sites" && method === "POST") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);

    let body;
    try { body = await request.json(); }
    catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(payload.id).first().catch(() => null);
    if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);

    const storageLimit = user.storage_limit_gb || 10;

    try {
      const { siteId, bucketName, provisionError } = await createSiteWithBucket(
        env, payload.id,
        { ...body, storage_limit: storageLimit }
      );

      return jsonOk({
        success: true,
        id: siteId,
        supabase_bucket: bucketName,
        provision_error: provisionError || null,
        message: provisionError
          ? `사이트가 생성되었으나 버킷 생성 오류가 있습니다: ${provisionError}`
          : "사이트가 생성되었습니다.",
      });
    } catch (e) {
      return jsonErr("사이트 생성 오류: " + e.message, 500);
    }
  }

  // ── GET /api/sites (목록) ─────────────────────────────────────────────
  if (url.pathname === "/api/sites" && method === "GET") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    try {
      const { results } = await env.DB.prepare(
        "SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(payload.id).all();
      return jsonOk(results || []);
    } catch (e) {
      return jsonErr("사이트 목록 조회 오류: " + e.message, 500);
    }
  }

  // ── GET /api/sites/:id ────────────────────────────────────────────────
  if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+$/) && method === "GET") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    const siteId = url.pathname.split("/").pop();
    try {
      const site = await env.DB.prepare(
        "SELECT * FROM sites WHERE id = ? AND user_id = ?"
      ).bind(siteId, payload.id).first();
      if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
      return jsonOk(site);
    } catch (e) {
      return jsonErr("사이트 조회 오류: " + e.message, 500);
    }
  }

  // ── POST /api/sites/:id/provision-bucket (버킷 재생성) ────────────────
  if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+\/provision-bucket$/) && method === "POST") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    const siteId = url.pathname.split("/")[3];

    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id = ? AND user_id = ?"
    ).bind(siteId, payload.id).first().catch(() => null);
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return jsonErr("SUPABASE_URL 및 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.", 503);
    }

    const storage = new SupabaseStorage(supabaseUrl, supabaseKey);
    const shortId = siteId.replace(/-/g, "").slice(0, 20).toLowerCase();
    const bucketName = `site-${shortId}`;

    const ok = await storage.createBucket(bucketName);
    if (!ok) return jsonErr("버킷 생성 실패", 500);

    await env.DB.prepare(
      "UPDATE sites SET supabase_bucket = ?, status = 'active', updated_at = datetime('now') WHERE id = ?"
    ).bind(bucketName, siteId).run();

    return jsonOk({ success: true, bucket: bucketName });
  }

  // ── PATCH /api/sites/:id/cache ────────────────────────────────────────
  if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+\/cache$/) && method === "PATCH") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    const siteId = url.pathname.split("/")[3];
    const { enabled, ttl = 3600 } = await request.json().catch(() => ({}));
    await env.DB.prepare(
      "UPDATE sites SET cache_enabled = ?, cache_ttl = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).bind(enabled ? 1 : 0, ttl, siteId, payload.id).run();
    // 캐시 무효화
    if (env.CACHE && !enabled) {
      env.CACHE.list({ prefix: `html:${siteId}:` }).then(async (list) => {
        for (const k of (list.keys || [])) {
          await env.CACHE.delete(k.name).catch(() => {});
        }
      }).catch(() => {});
    }
    return jsonOk({ success: true });
  }

  // ── POST /api/sites/update-php ────────────────────────────────────────
  if (url.pathname === "/api/sites/update-php" && method === "POST") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    const { site_id, new_version } = await request.json().catch(() => ({}));
    if (!site_id || !new_version) return jsonErr("site_id와 new_version이 필요합니다.", 400);
    await env.DB.prepare(
      "UPDATE sites SET php_version = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).bind(new_version, site_id, payload.id).run();
    return jsonOk({ success: true, message: `PHP ${new_version}으로 변경되었습니다.` });
  }

  // ── DELETE /api/sites/:id ─────────────────────────────────────────────
  if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+$/) && method === "DELETE") {
    const payload = await requireAuth(request, env);
    if (!payload) return jsonErr("인증이 필요합니다.", 401);
    const siteId = url.pathname.split("/").pop();
    await env.DB.prepare(
      "DELETE FROM sites WHERE id = ? AND user_id = ?"
    ).bind(siteId, payload.id).run();
    return jsonOk({ success: true });
  }

  // ── 나머지 API는 functions/ Pages Functions으로 폴백 ──────────────────
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return jsonErr("API 엔드포인트를 찾을 수 없습니다.", 404);
}
