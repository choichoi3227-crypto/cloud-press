/**
 * CloudPress WordPress Engine v3.0
 * 진짜 WordPress PHP를 php-wasm으로 실행하는 핵심 엔진
 */

export class SupabaseStorage {
  constructor(url, key) {
    this.url = url.replace(/\/$/, "");
    this.key = key;
  }
  headers() {
    return { apikey: this.key, Authorization: `Bearer ${this.key}` };
  }
  async get(bucket, path) {
    try {
      const res = await fetch(`${this.url}/storage/v1/object/${bucket}/${path}`, { headers: this.headers() });
      return res.ok ? res : null;
    } catch { return null; }
  }
  async getText(bucket, path) {
    const r = await this.get(bucket, path);
    return r ? r.text() : null;
  }
  async put(bucket, path, body, ct = "application/octet-stream") {
    const res = await fetch(`${this.url}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": ct, "x-upsert": "true" },
      body,
    });
    return res.ok;
  }
  async exists(bucket, path) {
    const res = await fetch(`${this.url}/storage/v1/object/info/${bucket}/${path}`, { headers: this.headers() });
    return res.ok;
  }
  async createBucket(name) {
    const res = await fetch(`${this.url}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: name, name, public: false, file_size_limit: 524288000 }),
    });
    const t = await res.text();
    return res.ok || t.includes("already exists") || t.includes("Duplicate");
  }
}

export class WordPressInstaller {
  constructor(storage, kv, db) {
    this.storage = storage;
    this.kv = kv;
    this.db = db;
  }

  bucketName(siteId) {
    return `site-${siteId.replace(/-/g, "").slice(0, 20).toLowerCase()}`;
  }

  async ensureInstalled(siteId, siteUrl) {
    const bucket = this.bucketName(siteId);
    const installed = await this.kv?.get(`wp:installed:${siteId}`);
    if (installed === "1") return { bucket, ready: true };

    await this.storage.createBucket(bucket);

    const configExists = await this.storage.exists(bucket, "wp-config.php");
    const coreExists   = await this.storage.exists(bucket, "wp-load.php");

    if (configExists && coreExists) {
      await this.kv?.put(`wp:installed:${siteId}`, "1");
      return { bucket, ready: true };
    }

    if (!configExists) {
      await this._createWpConfig(bucket, siteId, siteUrl);
    }

    if (!coreExists) {
      const installing = await this.kv?.get(`wp:installing:${siteId}`);
      if (!installing) {
        await this.kv?.put(`wp:installing:${siteId}`, "1", { expirationTtl: 1800 });
        this._installCore(bucket, siteId).catch(console.error);
      }
      return { bucket, ready: false, installing: true };
    }

    return { bucket, ready: true };
  }

  async _installCore(bucket, siteId) {
    try {
      const res = await fetch("https://ko.wordpress.org/latest-ko_KR.zip");
      if (!res.ok) throw new Error("WordPress 다운로드 실패");
      const zip = await res.arrayBuffer();
      await this.storage.put(bucket, "_wordpress.zip", zip, "application/zip");
      await this.kv?.put(`wp:installing:${siteId}`, "2");
      await this.db?.prepare("UPDATE sites SET status='provisioning', updated_at=datetime('now') WHERE id=?")
        .bind(siteId).run().catch(() => {});
    } catch (e) {
      console.error("[installer]", e.message);
      await this.kv?.delete(`wp:installing:${siteId}`);
    }
  }

  async _createWpConfig(bucket, siteId, siteUrl) {
    const r = () => Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b=>b.toString(16).padStart(2,"0")).join("");
    const bn = this.bucketName(siteId);
    const config = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'wordpress');
define('DB_PASSWORD', '${r()}');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
define('AUTH_KEY',         '${r()}');
define('SECURE_AUTH_KEY',  '${r()}');
define('LOGGED_IN_KEY',    '${r()}');
define('NONCE_KEY',        '${r()}');
define('AUTH_SALT',        '${r()}');
define('SECURE_AUTH_SALT', '${r()}');
define('LOGGED_IN_SALT',   '${r()}');
define('NONCE_SALT',       '${r()}');
$table_prefix = 'wp_';
define('WP_SITEURL', getenv('WP_HOME') ?: '${siteUrl}');
define('WP_HOME',    getenv('WP_HOME') ?: '${siteUrl}');
define('CLOUDPRESS_SUPABASE_URL', getenv('SUPABASE_URL') ?: '');
define('CLOUDPRESS_SUPABASE_KEY', getenv('SUPABASE_KEY') ?: '');
define('CLOUDPRESS_BUCKET',       getenv('SITE_BUCKET') ?: '${bn}');
define('SQLITE_DB_REALPATH', '/tmp/wp_${siteId.replace(/-/g,"").slice(0,8)}.db');
define('CLOUDPRESS_D1_ENDPOINT', getenv('D1_ENDPOINT') ?: '');
define('CLOUDPRESS_D1_TOKEN',    getenv('D1_TOKEN')    ?: '');
define('WP_DEBUG', false);
define('WP_CACHE', true);
define('DISALLOW_FILE_EDIT', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('DISABLE_WP_CRON', true);
define('WP_MAX_MEMORY_LIMIT', '256M');
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`;
    await this.storage.put(bucket, "wp-config.php", config, "text/plain");
  }
}

export class WordPressEngine {
  constructor(env, site) {
    this.env  = env;
    this.site = site;
    this.storage = new SupabaseStorage(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY
    );
    this.installer = new WordPressInstaller(
      this.storage,
      env.KV || env.CACHE,
      env.DB
    );
  }

  async run(request) {
    const url     = new URL(request.url);
    const siteId  = this.site.id;
    const siteUrl = `${url.protocol}//${url.host}`;

    const { bucket, ready, installing } =
      await this.installer.ensureInstalled(siteId, siteUrl);

    if (!ready) return this._installingPage();

    // 정적 파일 처리
    const staticRes = await this._serveStatic(request, bucket, url);
    if (staticRes) return staticRes;

    // 페이지 캐시 (GET)
    if (request.method === "GET") {
      const cached = await this._getCache(siteId, url);
      if (cached) return cached;
    }

    // PHP 실행
    return this._execWordPress(request, bucket, siteId, siteUrl, url);
  }

  async _serveStatic(request, bucket, url) {
    const p = url.pathname;
    const staticExt = /\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i;

    if (staticExt.test(p) && (
      p.startsWith("/wp-includes/") ||
      p.startsWith("/wp-admin/") ||
      p.startsWith("/wp-content/themes/") ||
      p.startsWith("/wp-content/plugins/")
    )) {
      const file = await this.storage.get(bucket, p.replace(/^\//, ""));
      if (file) {
        const body = await file.arrayBuffer();
        return new Response(body, {
          headers: {
            "Content-Type": this._mime(p),
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    if (p.startsWith("/wp-content/uploads/")) {
      const file = await this.storage.get(bucket, p.replace(/^\//, ""));
      if (file) {
        return new Response(await file.arrayBuffer(), {
          headers: { "Content-Type": this._mime(p), "Cache-Control": "public, max-age=86400" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }
    return null;
  }

  async _getCache(siteId, url) {
    if (!this.env.CACHE) return null;
    const skip = ["/wp-admin", "/wp-login.php", "/cart", "/checkout", "/my-account"];
    if (skip.some(s => url.pathname.startsWith(s))) return null;
    try {
      const key = `html:${siteId}:${url.pathname}${url.search}`.slice(0, 512);
      const html = await this.env.CACHE.get(key);
      if (html) return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Cache": "HIT" },
      });
    } catch {}
    return null;
  }

  async _execWordPress(request, bucket, siteId, siteUrl, url) {
    const env = this.env;
    let postBody = "";
    if (["POST","PUT","PATCH"].includes(request.method)) postBody = await request.text();

    const phpEnv = {
      WP_HOME: siteUrl, WP_SITEURL: siteUrl,
      REQUEST_URI: url.pathname + url.search,
      REQUEST_METHOD: request.method,
      HTTP_HOST: url.host, SERVER_NAME: url.host,
      SERVER_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
      HTTPS: url.protocol === "https:" ? "on" : "",
      DOCUMENT_ROOT: "/wordpress",
      HTTP_COOKIE: request.headers.get("Cookie") || "",
      HTTP_USER_AGENT: request.headers.get("User-Agent") || "CloudPress",
      HTTP_X_FORWARDED_FOR: request.headers.get("CF-Connecting-IP") || "",
      CONTENT_TYPE: request.headers.get("Content-Type") || "",
      CONTENT_LENGTH: String(postBody.length),
      SUPABASE_URL: env.SUPABASE_URL || "",
      SUPABASE_KEY: env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY || "",
      SITE_BUCKET: bucket,
      D1_ENDPOINT: env.D1_ENDPOINT || "",
      D1_TOKEN: env.D1_TOKEN || "",
    };

    if (!env.PHP_RUNNER) return this._phpRunnerRequired();

    const wpConfig = await this.storage.getText(bucket, "wp-config.php") || "";
    const dbPhp    = await this.storage.getText(bucket, "wp-content/db.php") || "";

    const res = await env.PHP_RUNNER.fetch(new Request("https://php/run-wordpress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phpFile: this._resolvePhp(url.pathname),
        phpEnv,
        stdin: postBody,
        files: {
          "/wordpress/wp-config.php": wpConfig,
          "/wordpress/wp-content/db.php": dbPhp,
        },
        bucket,
        supabase: { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY },
      }),
    }));

    // 캐시 저장
    if (res.status === 200 && request.method === "GET" && env.CACHE) {
      const ct = res.headers.get("Content-Type") || "";
      if (ct.includes("text/html")) {
        const html = await res.clone().text();
        if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
          const key = `html:${siteId}:${url.pathname}${url.search}`.slice(0, 512);
          env.CACHE.put(key, html, { expirationTtl: 3600 }).catch(() => {});
        }
      }
    }
    return res;
  }

  _resolvePhp(pathname) {
    if (pathname.endsWith(".php")) return pathname;
    if (pathname.startsWith("/wp-admin")) {
      return pathname === "/wp-admin" || pathname === "/wp-admin/"
        ? "/wp-admin/index.php"
        : pathname.replace(/\/$/, "") + "/index.php";
    }
    return "/index.php";
  }

  _mime(path) {
    const e = path.split(".").pop()?.toLowerCase();
    return { css:"text/css;charset=utf-8", js:"application/javascript;charset=utf-8",
      jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif",
      webp:"image/webp", svg:"image/svg+xml", ico:"image/x-icon",
      woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf" }[e] || "application/octet-stream";
  }

  _installingPage() {
    return new Response(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WordPress 설치 중</title><meta http-equiv="refresh" content="5">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#1e1b4b,#312e81);
min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.card{background:rgba(255,255,255,.08);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.15);
border-radius:24px;padding:48px;max-width:480px;width:90%;text-align:center}
h1{font-size:20px;font-weight:700;margin-bottom:12px}
p{color:rgba(255,255,255,.7);font-size:14px;line-height:1.7;margin-bottom:24px}
.bar{background:rgba(255,255,255,.1);border-radius:100px;height:6px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);
animation:ld 2s ease-in-out infinite}@keyframes ld{0%{width:20%}60%{width:85%}100%{width:20%}}
.steps{text-align:left;margin-top:24px;display:flex;flex-direction:column;gap:8px}
.step{font-size:13px;color:rgba(255,255,255,.45);display:flex;align-items:center;gap:10px;
padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.step.done{color:#4ade80}.step.active{color:#a5b4fc;font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
</style></head><body><div class="card">
<div style="font-size:48px;margin-bottom:20px">⚙️</div>
<h1>WordPress 자동 설치 중</h1>
<p>CloudPress가 서버리스 WordPress를 준비하고 있습니다.<br>5초 후 자동 새로고침됩니다.</p>
<div class="bar"><div class="fill"></div></div>
<div class="steps">
  <div class="step done"><div class="dot"></div>Cloudflare Worker 생성</div>
  <div class="step done"><div class="dot"></div>Supabase 버킷 생성</div>
  <div class="step done"><div class="dot"></div>wp-config.php 생성</div>
  <div class="step active"><div class="dot"></div>WordPress 코어 다운로드 중...</div>
  <div class="step"><div class="dot"></div>데이터베이스 초기화</div>
</div></div></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  _phpRunnerRequired() {
    return new Response(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>PHP Runner 필요</title>
<style>body{font-family:sans-serif;max-width:620px;margin:80px auto;padding:24px;
background:#0a0a0a;color:#e5e5e5}h1{color:#f87171;margin-bottom:16px}
pre{background:#1c1c1c;padding:16px;border-radius:8px;font-size:12px;
color:#86efac;overflow:auto;line-height:1.6}</style></head><body>
<h1>⚙️ PHP Runner Worker 설정 필요</h1>
<p>WordPress PHP 실행을 위해 php-runner worker를 먼저 배포해야 합니다.</p>
<pre># Step 1: PHP Runner Worker 배포
wrangler deploy --config wrangler-php.toml

# Step 2: wrangler.toml 서비스 바인딩 주석 해제
# [[services]]
# binding = "PHP_RUNNER"
# service = "cloudpress-php"

# Step 3: 메인 Worker 재배포
wrangler deploy</pre>
</body></html>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}
