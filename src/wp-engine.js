/**
 * CloudPress WordPress Engine v4.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 진짜 WordPress PHP를 php-wasm으로 실행하는 핵심 엔진
 *
 * 아키텍처:
 *   GitHub 레포 (스토리지)
 *     ├── wp-content/themes/    ← 사용자 테마
 *     ├── wp-content/plugins/   ← 사용자 플러그인
 *     ├── wp-content/uploads/   ← 미디어 파일 (업로드 시 미러링)
 *     └── wp-config.php         ← WordPress 설정
 *   WordPress 코어 (WordPress/WordPress 공식 레포 → jsDelivr CDN)
 *   Cloudflare Pages → GitHub 레포 미러링으로 자동 배포
 *
 * 캐싱 레이어:
 *   L1: Cloudflare Edge Cache (정적 자산 immutable 1y)
 *   L2: KV Cache (PHP 출력 1h, 정적 파일 24h)
 *   L3: stale-while-revalidate (오래된 캐시도 즉시 반환 후 백그라운드 갱신)
 */

const WP_VERSION    = "latest";
const WP_CORE_CDN   = `https://cdn.jsdelivr.net/npm/wordpress-static@${WP_VERSION}`;
const WP_GITHUB_RAW = "https://raw.githubusercontent.com/WordPress/WordPress/master";

const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip|pdf|mp4|mp3|ogg|wav|webm)$/i;

const SKIP_CACHE_PATHS = [
  "/wp-admin", "/wp-login.php", "/cart", "/checkout", "/my-account",
  "/wp-cron.php", "/xmlrpc.php",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With,X-WP-Nonce",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
  "X-XSS-Protection":       "1; mode=block",
};

// ─── GitHub API ───────────────────────────────────────────────────────────────
async function ghFetch(method, apiPath, token, body) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization:           `Bearer ${token}`,
      Accept:                  "application/vnd.github+json",
      "X-GitHub-Api-Version":  "2022-11-28",
      "Content-Type":          "application/json",
      "User-Agent":            "CloudPress-WPEngine/4.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ─── KV 캐시 ──────────────────────────────────────────────────────────────────
class KVCache {
  constructor(kv) { this.kv = kv; }

  async get(key) {
    if (!this.kv) return null;
    try { return await this.kv.get(key); } catch { return null; }
  }

  async getWithMeta(key) {
    if (!this.kv) return null;
    try { return await this.kv.getWithMetadata(key); } catch { return null; }
  }

  async set(key, value, ttl = 3600, metadata = {}) {
    if (!this.kv) return;
    try {
      await this.kv.put(key, value, { expirationTtl: ttl, metadata });
    } catch {}
  }

  async delete(key) {
    if (!this.kv) return;
    try { await this.kv.delete(key); } catch {}
  }

  async listAndDelete(prefix) {
    if (!this.kv) return;
    try {
      const list = await this.kv.list({ prefix });
      await Promise.allSettled((list.keys || []).map(k => this.kv.delete(k.name)));
    } catch {}
  }
}

// ─── GitHub 스토리지 미러링 ────────────────────────────────────────────────────
export class GitHubMirror {
  constructor(token, owner, repo, branch = "main") {
    this.token  = token;
    this.owner  = owner;
    this.repo   = repo;
    this.branch = branch;
  }

  get enabled() { return !!(this.token && this.owner && this.repo); }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
  }

  // 파일을 GitHub 레포에 업로드 (미러링)
  async put(filePath, content, message) {
    if (!this.enabled) return false;

    // base64 인코딩
    let b64;
    if (typeof content === "string") {
      const bytes = new TextEncoder().encode(content);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      b64 = btoa(bin);
    } else {
      const bytes = content instanceof ArrayBuffer
        ? new Uint8Array(content) : new Uint8Array(content.buffer);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      b64 = btoa(bin);
    }

    // 기존 SHA 조회 (update인 경우 필요)
    let sha;
    const { data: existing } = await ghFetch(
      "GET",
      `/repos/${this.owner}/${this.repo}/contents/${filePath}?ref=${this.branch}`,
      this.token
    );
    if (existing?.sha) sha = existing.sha;

    const body = {
      message: message || `upload: ${filePath}`,
      content: b64,
      branch:  this.branch,
    };
    if (sha) body.sha = sha;

    const { ok } = await ghFetch(
      "PUT",
      `/repos/${this.owner}/${this.repo}/contents/${filePath}`,
      this.token,
      body
    );
    return ok;
  }

  // 파일을 GitHub 레포에서 읽기
  async get(filePath) {
    if (!this.enabled) return null;
    const res = await fetch(this.rawUrl(filePath), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "CloudPress-WPEngine/4.0",
      },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    return res.ok ? res : null;
  }

  // 디렉터리 내 파일 목록
  async list(dir = "") {
    if (!this.enabled) return [];
    const { ok, data } = await ghFetch(
      "GET",
      `/repos/${this.owner}/${this.repo}/contents/${dir}?ref=${this.branch}`,
      this.token
    );
    return ok && Array.isArray(data) ? data : [];
  }
}

// ─── WordPress 코어 정적 자산 서빙 ────────────────────────────────────────────
async function serveCoreAsset(filePath, cache) {
  const cacheKey = `core:${filePath}`;

  // KV 캐시 확인
  const cached = await cache.getWithMeta(cacheKey);
  if (cached?.value) {
    return new Response(cached.value, {
      headers: {
        "Content-Type":  cached.metadata?.ct || mimeType(filePath),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Cache":       "HIT",
        ...SECURITY_HEADERS,
      },
    });
  }

  // CDN에서 가져오기 (jsDelivr → WordPress/WordPress GitHub Raw)
  for (const baseUrl of [WP_CORE_CDN, WP_GITHUB_RAW]) {
    try {
      const res = await fetch(`${baseUrl}/${filePath}`, {
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
      if (!res.ok) continue;

      const body = await res.arrayBuffer();
      const ct   = mimeType(filePath);

      // 텍스트 파일만 KV에 저장 (바이너리는 Edge 캐시 의존)
      if (body.byteLength < 2 * 1024 * 1024) {
        const isText = /\.(css|js|svg|xml|json|txt|html|map)$/.test(filePath);
        if (isText) {
          await cache.set(cacheKey, new TextDecoder().decode(body), 86400, { ct });
        }
      }

      return new Response(body, {
        headers: {
          "Content-Type":  ct,
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
          "X-Cache":       "MISS",
          ...SECURITY_HEADERS,
        },
      });
    } catch {}
  }

  return null;
}

// ─── WordPress Engine 클래스 ─────────────────────────────────────────────────
export class WordPressEngine {
  constructor(env, site) {
    this.env  = env;
    this.site = site;
    this.cache = new KVCache(env.CACHE || env.KV);
    this.mirror = new GitHubMirror(
      env.GITHUB_TOKEN || site?.github_token,
      env.GITHUB_OWNER || site?.github_repo_owner,
      env.GITHUB_REPO  || site?.github_repo_name,
    );
  }

  async run(request, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const siteId  = this.site?.id || "default";
    const siteUrl = `${url.protocol}//${url.host}`;
    const path    = url.pathname;

    // ── 정적 파일 처리 ───────────────────────────────────────────────────────
    if (STATIC_EXT.test(path)) {
      return this._serveStatic(request, url, siteId, ctx);
    }

    // ── 미디어 업로드 처리 (POST /wp-content/uploads/*) ─────────────────────
    if (method === "POST" && path === "/wp-json/wp/v2/media") {
      return this._handleMediaUpload(request, url, siteId, ctx);
    }

    // ── PHP 캐시 (GET 비로그인) ───────────────────────────────────────────────
    if (method === "GET" && !this._skipCache(path)) {
      const cookie = request.headers.get("Cookie") || "";
      if (!cookie.includes("wordpress_logged_in")) {
        const cached = await this._getPhpCache(siteId, url);
        if (cached) return cached;
      }
    }

    // ── PHP 실행 ─────────────────────────────────────────────────────────────
    return this._execWordPress(request, url, siteId, siteUrl, ctx);
  }

  // ── 정적 파일 서빙 ────────────────────────────────────────────────────────
  async _serveStatic(request, url, siteId, ctx) {
    const path     = url.pathname;
    const filePath = path.replace(/^\//, "");

    // wp-content 파일: GitHub 미러에서 우선
    if (path.startsWith("/wp-content/")) {
      const ghRes = await this.mirror.get(filePath);
      if (ghRes) {
        const body = await ghRes.arrayBuffer();
        const ct   = mimeType(path);
        const isUpload = path.startsWith("/wp-content/uploads/");
        return new Response(body, {
          headers: {
            "Content-Type":  ct,
            "Cache-Control": isUpload
              ? "public, max-age=86400"
              : "public, max-age=31536000, immutable",
            "Vary":          "Accept-Encoding",
            "X-Source":      "github-mirror",
            ...SECURITY_HEADERS,
          },
        });
      }
      if (path.startsWith("/wp-content/uploads/")) {
        return new Response("Not Found", { status: 404 });
      }
    }

    // wp-admin, wp-includes: WordPress 코어 CDN
    const coreRes = await serveCoreAsset(filePath, this.cache);
    if (coreRes) return coreRes;

    return new Response("Not Found", { status: 404 });
  }

  // ── 미디어 업로드 미러링 ──────────────────────────────────────────────────
  async _handleMediaUpload(request, url, siteId, ctx) {
    // PHP로 업로드 처리 먼저
    const phpRes = await this._execWordPress(request.clone(), url, siteId, `${url.protocol}//${url.host}`, ctx);

    // 업로드된 파일을 GitHub에도 미러링 (비동기)
    if (phpRes.status === 201 && ctx) {
      ctx.waitUntil((async () => {
        try {
          const body = await phpRes.clone().json();
          const sourceUrl = body?.source_url;
          if (sourceUrl && this.mirror.enabled) {
            const fileRes = await fetch(sourceUrl);
            if (fileRes.ok) {
              const fileBuffer = await fileRes.arrayBuffer();
              const now   = new Date();
              const year  = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, "0");
              const filename = sourceUrl.split("/").pop() || "upload";
              const repoPath = `wp-content/uploads/${year}/${month}/${filename}`;
              await this.mirror.put(repoPath, fileBuffer, `upload: ${filename}`);
            }
          }
        } catch (e) {
          console.error("[mirror-upload]", e.message);
        }
      })());
    }

    return phpRes;
  }

  // ── PHP 캐시 조회 ─────────────────────────────────────────────────────────
  async _getPhpCache(siteId, url) {
    const key = `php:${siteId}:${url.pathname}${url.search}`.slice(0, 512);
    const r   = await this.cache.getWithMeta(key);
    if (!r?.value) return null;

    return new Response(r.value, {
      headers: {
        "Content-Type":  "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600",
        "X-Cache":       "HIT",
        "Age":           String(r.metadata?.age || 0),
        ...SECURITY_HEADERS,
      },
    });
  }

  // ── WordPress PHP 실행 ────────────────────────────────────────────────────
  async _execWordPress(request, url, siteId, siteUrl, ctx) {
    const env = this.env;

    if (!env.PHP_RUNNER) {
      return this._phpRunnerRequired();
    }

    let postBody = "";
    if (["POST", "PUT", "PATCH"].includes(request.method)) {
      postBody = await request.text().catch(() => "");
    }

    // wp-config.php와 db.php를 GitHub 미러에서 직접 가져오기
    const [wpConfig, dbPhp] = await Promise.all([
      this.mirror.get("wp-config.php").then(r => r?.text()).catch(() => ""),
      this.mirror.get("wp-content/db.php").then(r => r?.text()).catch(() => ""),
    ]);

    const phpFile = this._resolvePhpFile(url.pathname);

    const phpEnv = {
      // WordPress 필수 환경변수
      WP_HOME:    siteUrl,
      WP_SITEURL: siteUrl,
      REQUEST_URI:    url.pathname + url.search,
      REQUEST_METHOD: request.method,
      HTTP_HOST:      url.host,
      SERVER_NAME:    url.host,
      SERVER_PORT:    url.port || (url.protocol === "https:" ? "443" : "80"),
      HTTPS:          url.protocol === "https:" ? "on" : "",
      DOCUMENT_ROOT:  "/wordpress",
      SCRIPT_FILENAME: `/wordpress${phpFile}`,
      SCRIPT_NAME:    phpFile,
      PHP_SELF:       phpFile,
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL: "HTTP/1.1",
      SERVER_SOFTWARE: "CloudPress/4.0",

      // HTTP 요청 헤더
      HTTP_COOKIE:          request.headers.get("Cookie")          || "",
      HTTP_USER_AGENT:      request.headers.get("User-Agent")      || "CloudPress",
      HTTP_ACCEPT:          request.headers.get("Accept")          || "*/*",
      HTTP_ACCEPT_LANGUAGE: request.headers.get("Accept-Language") || "ko-KR,ko;q=0.9",
      HTTP_ACCEPT_ENCODING: request.headers.get("Accept-Encoding") || "gzip",
      HTTP_REFERER:         request.headers.get("Referer")         || "",
      HTTP_X_FORWARDED_FOR: request.headers.get("CF-Connecting-IP") || "",
      HTTP_X_REAL_IP:       request.headers.get("CF-Connecting-IP") || "",
      CONTENT_TYPE:         request.headers.get("Content-Type")    || "",
      CONTENT_LENGTH:       String(postBody.length),
      QUERY_STRING:         url.search.replace(/^\?/, ""),

      // GitHub 저장소 (php-runner가 코어 파일 fetching에 사용)
      GITHUB_OWNER: this.mirror.owner || "",
      GITHUB_REPO:  this.mirror.repo  || "",
      GITHUB_TOKEN: this.mirror.token || "",

      // CloudPress 전용
      CLOUDPRESS_SITE_ID: siteId,
    };

    const payload = {
      phpFile,
      phpEnv,
      stdin:  postBody,
      files: {
        "/wordpress/wp-config.php":        wpConfig || "",
        "/wordpress/wp-content/db.php":    dbPhp    || "",
      },
      bucket:    siteId,
      siteId,
      skipCache: false,
    };

    const res = await env.PHP_RUNNER.fetch(
      new Request("https://php/run-wordpress", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      })
    );

    // 성공 HTML 응답 → KV 캐시 저장 (비로그인 GET)
    if (
      res.status === 200 &&
      request.method === "GET" &&
      !this._skipCache(url.pathname) &&
      !(request.headers.get("Cookie") || "").includes("wordpress_logged_in") &&
      ctx
    ) {
      const ct = res.headers.get("Content-Type") || "";
      if (ct.includes("text/html")) {
        ctx.waitUntil((async () => {
          const html = await res.clone().text();
          if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
            const key = `php:${siteId}:${url.pathname}${url.search}`.slice(0, 512);
            await this.cache.set(key, html, 3600, { age: 0 });
          }
        })());
      }
    }

    return res;
  }

  _resolvePhpFile(pathname) {
    if (pathname.endsWith(".php")) return pathname;
    if (pathname === "/wp-admin" || pathname === "/wp-admin/") return "/wp-admin/index.php";
    if (pathname.startsWith("/wp-admin/")) {
      return pathname.endsWith("/") ? pathname + "index.php" : pathname;
    }
    return "/index.php";
  }

  _skipCache(path) {
    return SKIP_CACHE_PATHS.some(s => path.startsWith(s));
  }

  _phpRunnerRequired() {
    return new Response(
      `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>PHP Runner 설정 필요</title>
<style>body{font-family:sans-serif;max-width:640px;margin:80px auto;padding:24px;background:#0a0a0a;color:#e5e5e5}
h1{color:#f87171}pre{background:#1c1c1c;padding:16px;border-radius:8px;font-size:13px;color:#86efac;line-height:1.6;overflow:auto}</style>
</head><body>
<h1>⚙️ PHP Runner Worker 설정 필요</h1>
<p>진짜 WordPress PHP 실행을 위해 cloudpress-php worker를 먼저 배포하세요.</p>
<pre># 1단계: PHP Runner Worker 배포
wrangler deploy --config wrangler-php.toml

# 2단계: wrangler.toml에 서비스 바인딩 활성화
# [[services]]
# binding = "PHP_RUNNER"
# service = "cloudpress-php"

# 3단계: 메인 Worker 재배포
wrangler deploy</pre>
</body></html>`,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

// ─── MIME 타입 ────────────────────────────────────────────────────────────────
function mimeType(path) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return ({
    css:   "text/css; charset=utf-8",
    js:    "application/javascript; charset=utf-8",
    mjs:   "application/javascript; charset=utf-8",
    json:  "application/json; charset=utf-8",
    xml:   "application/xml; charset=utf-8",
    svg:   "image/svg+xml",
    png:   "image/png",
    jpg:   "image/jpeg",
    jpeg:  "image/jpeg",
    gif:   "image/gif",
    webp:  "image/webp",
    avif:  "image/avif",
    ico:   "image/x-icon",
    woff:  "font/woff",
    woff2: "font/woff2",
    ttf:   "font/ttf",
    eot:   "application/vnd.ms-fontobject",
    otf:   "font/otf",
    pdf:   "application/pdf",
    zip:   "application/zip",
    mp4:   "video/mp4",
    webm:  "video/webm",
    mp3:   "audio/mpeg",
    ogg:   "audio/ogg",
    wav:   "audio/wav",
    txt:   "text/plain; charset=utf-8",
  })[ext] || "application/octet-stream";
}
