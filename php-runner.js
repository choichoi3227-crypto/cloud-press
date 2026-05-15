/**
 * CloudPress PHP Runner Worker v4.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * php-wasm (WebAssembly PHP 8.2)으로 진짜 WordPress PHP 실행
 * - 진짜 WordPress 코어를 GitHub에서 가져와 php-wasm으로 실행
 * - 정적 자산 KV 캐시 (immutable, stale-while-revalidate)
 * - PHP 출력 KV 캐시 (비로그인 GET 요청만)
 * - GitHub 업로드 시 모든 파일 미러링
 * - 메인 Worker에서 Service Binding으로 호출
 *
 * wrangler-php.toml에서 별도 Worker로 배포:
 *   wrangler deploy --config wrangler-php.toml
 */

// ─── php-wasm 싱글톤 ─────────────────────────────────────────────────────────
let _phpModule = null;

async function loadPhpWasm() {
  if (_phpModule) return _phpModule;
  try {
    // Workers 환경 — npm으로 번들된 버전 우선
    _phpModule = await import("@php-wasm/web");
    return _phpModule;
  } catch {
    try {
      // jsDelivr CDN 폴백 (php 8.2)
      _phpModule = await import(
        "https://cdn.jsdelivr.net/npm/@php-wasm/web@0.9.27/build/php_8_2.mjs"
      );
      return _phpModule;
    } catch (e2) {
      throw new Error("php-wasm 로드 실패: " + e2.message);
    }
  }
}

// ─── GitHub Raw 파일 fetch (CDN 캐시 활용) ───────────────────────────────────
async function fetchGitHubRaw(owner, repo, branch, path, token) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const headers = { "User-Agent": "CloudPress-PHPRunner/4.0" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    headers,
    // Cloudflare Edge 캐시 활용
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  return res.ok ? res : null;
}

// ─── WordPress 코어 파일을 GitHub에서 가져오기 ──────────────────────────────
async function fetchWordPressCore(filePath) {
  // 공식 WordPress/WordPress 레포 (master 브랜치)
  const urls = [
    `https://raw.githubusercontent.com/WordPress/WordPress/master/${filePath}`,
    `https://cdn.jsdelivr.net/npm/wordpress-static@6.7.2/${filePath}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
      if (res.ok) return res;
    } catch {}
  }
  return null;
}

// ─── PHP 가상 파일시스템 구축 ────────────────────────────────────────────────
// WordPress 코어 파일을 php-wasm VFS에 마운트
async function buildWordPressVFS(php, env, bucket, siteId, phpFile) {
  const needed = getNeededFiles(phpFile);

  // 사용자 GitHub 레포에서 wp-config.php, wp-content/ 가져오기
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  const userFiles = [
    "wp-config.php",
    "wp-content/db.php",
  ];

  for (const f of userFiles) {
    const res = owner && repo
      ? await fetchGitHubRaw(owner, repo, "main", f, token)
      : null;
    if (res) {
      const content = await res.text();
      mountFile(php, `/wordpress/${f}`, content);
    }
  }

  // WordPress 코어 필수 파일만 lazy load (필요한 것만)
  for (const coreFile of needed) {
    const res = await fetchWordPressCore(coreFile);
    if (res) {
      const isText = /\.(php|json|txt|mo|po)$/.test(coreFile);
      if (isText) {
        mountFile(php, `/wordpress/${coreFile}`, await res.text());
      } else {
        const buf = await res.arrayBuffer();
        mountBinary(php, `/wordpress/${coreFile}`, new Uint8Array(buf));
      }
    }
  }
}

function mountFile(php, vfsPath, content) {
  const dir = vfsPath.substring(0, vfsPath.lastIndexOf("/"));
  if (dir) { try { php.mkdirTree(dir); } catch {} }
  php.writeFile(vfsPath, content);
}

function mountBinary(php, vfsPath, bytes) {
  const dir = vfsPath.substring(0, vfsPath.lastIndexOf("/"));
  if (dir) { try { php.mkdirTree(dir); } catch {} }
  php.writeFile(vfsPath, bytes);
}

// 요청 경로에 따라 필요한 코어 파일 결정 (최소화)
function getNeededFiles(phpFile) {
  const core = [
    "wp-load.php",
    "wp-blog-header.php",
    "wp-settings.php",
    "wp-includes/functions.php",
    "wp-includes/class-wp-hook.php",
    "wp-includes/plugin.php",
    "wp-includes/option.php",
    "wp-includes/formatting.php",
    "wp-includes/query.php",
    "wp-includes/class-wp-query.php",
    "wp-includes/post.php",
    "wp-includes/user.php",
    "wp-includes/meta.php",
    "wp-includes/taxonomy.php",
    "wp-includes/class-wp.php",
    "wp-includes/rewrite.php",
    "wp-includes/class-wp-rewrite.php",
    "wp-includes/template.php",
    "wp-includes/template-loader.php",
    "wp-includes/kses.php",
    "wp-includes/cache.php",
    "wp-includes/l10n.php",
    "wp-includes/capabilities.php",
    "wp-includes/class-wp-roles.php",
    "wp-includes/class-wp-user.php",
    "wp-includes/class-wp-session-tokens.php",
    "wp-includes/class-wp-user-meta-session-tokens.php",
    "wp-includes/vars.php",
    "wp-includes/compat.php",
    "wp-includes/class-wp-error.php",
    "wp-includes/http.php",
    "wp-includes/pomo/mo.php",
    "wp-includes/pomo/po.php",
    "wp-includes/pomo/translations.php",
    "wp-includes/version.php",
  ];

  if (phpFile && phpFile.startsWith("/wp-admin/")) {
    core.push(
      "wp-admin/admin.php",
      "wp-admin/includes/admin.php",
      "wp-admin/includes/template.php",
      "wp-admin/includes/misc.php",
      "wp-admin/includes/post.php",
      "wp-admin/includes/user.php",
      "wp-admin/includes/plugin.php",
      "wp-admin/includes/theme.php",
      "wp-admin/includes/file.php",
      "wp-admin/includes/media.php",
    );
  }

  return core;
}

// ─── PHP 실행 핵심 함수 ────────────────────────────────────────────────────────
async function executeWordPress({ phpFile, phpEnv = {}, files = {}, stdin = "", env, siteId, bucket }) {
  const wasm = await loadPhpWasm();

  const php = await wasm.startPHP({
    dataRoot: "/tmp",
    phpIniEntries: {
      "memory_limit":             "256M",
      "max_execution_time":       "30",
      "upload_max_filesize":      "64M",
      "post_max_size":            "64M",
      "error_reporting":          "E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT",
      "display_errors":           "0",
      "log_errors":               "1",
      "date.timezone":            "Asia/Seoul",
      "mbstring.language":        "Korean",
      "mbstring.internal_encoding": "UTF-8",
      "default_charset":          "UTF-8",
      "output_compression":       "Off",
      "zlib.output_compression":  "On",
      "opcache.enable":           "1",
      "opcache.validate_timestamps": "0",
      "session.cookie_httponly":  "1",
      "session.cookie_samesite":  "Lax",
    },
  });

  // 환경변수 설정
  for (const [key, value] of Object.entries(phpEnv)) {
    if (value !== undefined && value !== null) {
      php.setEnv(key, String(value));
    }
  }

  // 직접 주입된 파일 마운트 (wp-config.php, wp-content/db.php 등)
  for (const [path, content] of Object.entries(files)) {
    if (content) mountFile(php, path, content);
  }

  // WordPress 코어 VFS 구축
  await buildWordPressVFS(php, env, bucket, siteId, phpFile);

  if (stdin) php.setStdin(stdin);

  let output = "";
  let status = 200;
  const headers = new Headers();
  headers.set("X-Powered-By", "CloudPress/php-wasm");

  try {
    // 실행할 PHP 파일 경로
    const targetFile = phpFile
      ? `/wordpress${phpFile}`
      : "/wordpress/index.php";

    const result = await php.run({ code: `<?php require '${targetFile}'; ?>` });

    output = result.text || "";
    const exitCode = result.exitCode || 0;

    if (result.headers) {
      for (const header of result.headers) {
        const colonIdx = header.indexOf(":");
        if (colonIdx < 0) continue;
        const name  = header.slice(0, colonIdx).trim();
        const value = header.slice(colonIdx + 1).trim();

        const lname = name.toLowerCase();
        if (lname === "location") {
          status = 302;
          headers.set("Location", value);
        } else if (lname.startsWith("http/")) {
          const m = lname.match(/http\/\d+\.?\d*\s+(\d+)/i);
          if (m) status = parseInt(m[1]);
        } else if (lname === "status") {
          const m = value.match(/^(\d+)/);
          if (m) status = parseInt(m[1]);
        } else if (lname === "set-cookie") {
          headers.append("Set-Cookie", value);
        } else {
          headers.set(name, value);
        }
      }
    }

    if (exitCode !== 0 && !output) {
      status = 500;
      output = "WordPress PHP 실행 오류 (exit: " + exitCode + ")";
    }

  } catch (e) {
    status = 500;
    output = "WordPress PHP 예외: " + e.message;
    console.error("[php-runner]", e);
  } finally {
    try { php.exit(0); } catch {}
  }

  if (!headers.has("Content-Type")) {
    const trimmed = output.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    } else if (trimmed.startsWith("<?xml") || trimmed.startsWith("<rss")) {
      headers.set("Content-Type", "application/xml; charset=utf-8");
    } else {
      headers.set("Content-Type", "text/html; charset=utf-8");
    }
  }

  // 보안 헤더 추가
  headers.set("X-Content-Type-Options",  "nosniff");
  headers.set("X-Frame-Options",          "SAMEORIGIN");
  headers.set("Referrer-Policy",          "same-origin");

  return new Response(output, { status, headers });
}

// ─── GitHub 미러링: 업로드 요청을 GitHub 레포에도 저장 ───────────────────────
async function mirrorFileToGitHub(env, filePath, content, message) {
  const owner = env.GITHUB_OWNER;
  const repo  = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  if (!owner || !repo || !token) return;

  // 기존 SHA 조회
  let sha;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CloudPress-PHPRunner/4.0",
        },
      }
    );
    if (res.ok) {
      const data = await res.json();
      sha = data.sha;
    }
  } catch {}

  // 파일 업로드
  let base64;
  if (typeof content === "string") {
    const bytes = new TextEncoder().encode(content);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    base64 = btoa(bin);
  } else {
    const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    base64 = btoa(bin);
  }

  const body = { message: message || `upload: ${filePath}`, content: base64 };
  if (sha) body.sha = sha;

  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "CloudPress-PHPRunner/4.0",
      },
      body: JSON.stringify(body),
    }
  ).catch(e => console.error("[mirror]", e.message));
}

// ─── KV 캐시 헬퍼 ────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvSet(env, key, value, ttl = 3600) {
  try { await env.CACHE?.put(key, value, { expirationTtl: ttl }); } catch {}
}
async function kvGetMeta(env, key) {
  try {
    const r = await env.CACHE?.getWithMetadata(key);
    return r;
  } catch { return null; }
}

// ─── 정적 파일 캐시 키 ───────────────────────────────────────────────────────
function staticCacheKey(path) {
  return `static:${path}`;
}

function phpCacheKey(siteId, pathname, search) {
  return `php:${siteId}:${pathname}${search}`.slice(0, 512);
}

// ─── 요청 처리 ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // ── 정적 파일 서빙 (KV 캐시 우선) ──────────────────────────────────────
    if (url.pathname === "/serve-static" && method === "GET") {
      const filePath = url.searchParams.get("path") || "";
      const cacheKey = staticCacheKey(filePath);

      const cached = await kvGetMeta(env, cacheKey);
      if (cached?.value) {
        return new Response(cached.value, {
          headers: {
            "Content-Type":  cached.metadata?.ct || "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Cache":       "HIT",
            "ETag":          cached.metadata?.etag || "",
          },
        });
      }

      // GitHub에서 가져오기
      const owner = env.GITHUB_OWNER;
      const repo  = env.GITHUB_REPO;
      const token = env.GITHUB_TOKEN;
      let res = null;

      if (owner && repo && filePath.startsWith("wp-content/")) {
        res = await fetchGitHubRaw(owner, repo, "main", filePath, token);
      }
      if (!res) {
        res = await fetchWordPressCore(filePath);
      }
      if (!res) {
        return new Response("Not Found", { status: 404 });
      }

      const body = await res.arrayBuffer();
      const ct   = mimeType(filePath);
      const etag = `"${Date.now().toString(36)}"`;

      // KV에 저장 (5MB 이하만)
      if (body.byteLength < 5 * 1024 * 1024) {
        const isText = /\.(css|js|svg|html|xml|json|txt)$/.test(filePath);
        if (isText) {
          await env.CACHE?.put(cacheKey, new TextDecoder().decode(body), {
            expirationTtl: 86400,
            metadata: { ct, etag },
          }).catch(() => {});
        }
      }

      return new Response(body, {
        headers: {
          "Content-Type":  ct,
          "Cache-Control": "public, max-age=31536000, immutable",
          "ETag":          etag,
          "X-Cache":       "MISS",
        },
      });
    }

    // ── 미디어 업로드 미러링 ─────────────────────────────────────────────────
    if (url.pathname === "/mirror-upload" && method === "POST") {
      const filePath = url.searchParams.get("path") || "";
      const message  = url.searchParams.get("message") || `upload: ${filePath}`;
      const body     = await request.arrayBuffer();

      ctx.waitUntil(mirrorFileToGitHub(env, filePath, body, message));

      return new Response(JSON.stringify({ success: true, path: filePath }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── PHP 실행 ─────────────────────────────────────────────────────────────
    if (url.pathname === "/run-wordpress" && method === "POST") {
      let payload;
      try { payload = await request.json(); }
      catch { return new Response("Invalid JSON", { status: 400 }); }

      const {
        phpFile  = "/index.php",
        phpEnv   = {},
        stdin    = "",
        files    = {},
        bucket   = "",
        siteId   = "",
        skipCache = false,
        supabase,
      } = payload;

      // PHP 캐시 조회 (GET만, 관리자/로그인 제외)
      const isCacheable = !skipCache
        && phpEnv.REQUEST_METHOD === "GET"
        && !phpFile.startsWith("/wp-admin/")
        && phpFile !== "/wp-login.php"
        && !/cart|checkout|my-account/.test(phpFile)
        && !phpEnv.HTTP_COOKIE?.includes("wordpress_logged_in");

      if (isCacheable && siteId) {
        const cacheKey = phpCacheKey(siteId, phpEnv.REQUEST_URI || phpFile, "");
        const cached   = await kvGet(env, cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: {
              "Content-Type":  "text/html; charset=utf-8",
              "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
              "X-Cache":       "HIT",
              "X-Powered-By":  "CloudPress/php-wasm",
            },
          });
        }
      }

      // PHP 실행
      const wpEnv = { ...env, ...supabase };
      const res = await executeWordPress({
        phpFile,
        phpEnv,
        files,
        stdin,
        env: { ...env, GITHUB_OWNER: phpEnv.GITHUB_OWNER || env.GITHUB_OWNER, GITHUB_REPO: phpEnv.GITHUB_REPO || env.GITHUB_REPO, GITHUB_TOKEN: phpEnv.GITHUB_TOKEN || env.GITHUB_TOKEN },
        siteId,
        bucket,
      });

      // 성공 HTML 응답 캐시 저장
      if (res.status === 200 && isCacheable && siteId) {
        const ct = res.headers.get("Content-Type") || "";
        if (ct.includes("text/html")) {
          const html = await res.clone().text();
          if (!html.includes("wpadminbar") && !html.includes("wordpress_logged_in")) {
            const cacheKey = phpCacheKey(siteId, phpEnv.REQUEST_URI || phpFile, "");
            ctx.waitUntil(kvSet(env, cacheKey, html, 3600));
          }
        }
      }

      return res;
    }

    // ── 캐시 무효화 ──────────────────────────────────────────────────────────
    if (url.pathname === "/invalidate-cache" && method === "POST") {
      const { siteId, pattern } = await request.json().catch(() => ({}));
      if (siteId && env.CACHE) {
        try {
          const list = await env.CACHE.list({ prefix: `php:${siteId}:` });
          for (const key of (list.keys || [])) {
            await env.CACHE.delete(key.name).catch(() => {});
          }
        } catch {}
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── 헬스체크 ─────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", version: "4.0", engine: "php-wasm" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("CloudPress PHP Runner: 잘못된 요청", { status: 400 });
  },
};

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mimeType(path) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return {
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
    html:  "text/html; charset=utf-8",
    htm:   "text/html; charset=utf-8",
    php:   "text/html; charset=utf-8",
  }[ext] || "application/octet-stream";
}
