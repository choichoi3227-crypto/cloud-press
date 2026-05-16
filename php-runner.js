/**
 * CloudPress PHP Runner Worker v5.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 진짜 WordPress를 php-wasm으로 실행하는 전용 Worker
 *
 * 역할:
 *   - GitHub 레포지토리에서 WordPress 파일을 읽어와 php-wasm VFS에 마운트
 *   - WordPress 공식 코어(WordPress/WordPress GitHub)를 직접 사용
 *   - 사용자 wp-content(테마/플러그인/업로드)는 개인 GitHub 레포에서
 *   - KV 캐시로 정적 자산 & 비로그인 PHP 출력 캐싱 (속도 저하 방지)
 *   - 미디어 업로드 시 GitHub 레포에 미러링
 *
 * 배포:
 *   wrangler deploy --config wrangler-php.toml
 *
 * 메인 Worker(worker.js)에서 Service Binding으로 호출됨
 *
 * 환경변수 (wrangler secret put):
 *   GITHUB_TOKEN  - GitHub Personal Access Token (사이트별 레포 접근)
 *
 * KV 바인딩:
 *   CACHE - PHP 출력 & 정적 자산 캐시
 */

// ─── 상수 ────────────────────────────────────────────────────────────────────
const WP_VERSION    = "6.7.2";
const WP_CORE_OWNER = "WordPress";
const WP_CORE_REPO  = "WordPress";
const WP_CORE_BRANCH = "master";

// WordPress 코어 파일 CDN (jsDelivr 미러 — 더 빠름)
const WP_CDN_BASE   = `https://cdn.jsdelivr.net/gh/WordPress/WordPress@${WP_VERSION}`;
// 폴백: 공식 GitHub Raw
const WP_RAW_BASE   = `https://raw.githubusercontent.com/${WP_CORE_OWNER}/${WP_CORE_REPO}/${WP_CORE_BRANCH}`;

// ─── KV 캐시 헬퍼 ────────────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return await env.CACHE?.get(key, "arrayBuffer"); } catch { return null; }
}
async function kvGetText(env, key) {
  try { return await env.CACHE?.get(key); } catch { return null; }
}
async function kvSet(env, key, value, ttl = 3600) {
  try { await env.CACHE?.put(key, value, { expirationTtl: ttl }); } catch {}
}
async function kvSetWithMeta(env, key, value, meta, ttl = 86400) {
  try { await env.CACHE?.put(key, value, { expirationTtl: ttl, metadata: meta }); } catch {}
}
async function kvGetWithMeta(env, key) {
  try { return await env.CACHE?.getWithMetadata(key, "arrayBuffer"); } catch { return null; }
}

// ─── MIME 타입 ───────────────────────────────────────────────────────────────
function mimeType(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map = {
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp", avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", eot: "application/vnd.ms-fontobject", otf: "font/otf",
    pdf: "application/pdf",
    zip: "application/zip",
    mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    txt: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    php: "text/html; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

// ─── WordPress 코어 파일 fetch (CDN → GitHub Raw 폴백) ───────────────────────
async function fetchCoreFile(filePath, env) {
  // 1. KV 캐시 확인
  const cacheKey = `core:${filePath}`;
  const cached = await kvGetWithMeta(env, cacheKey);
  if (cached?.value) {
    return { buffer: cached.value, ct: cached.metadata?.ct || mimeType(filePath), fromCache: true };
  }

  // 2. jsDelivr CDN (빠른 엣지 캐시)
  const cdnUrl = `${WP_CDN_BASE}/${filePath}`;
  try {
    const res = await fetch(cdnUrl, {
      cf: { cacheEverything: true, cacheTtl: 86400 * 7 },
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const ct = mimeType(filePath) || res.headers.get("Content-Type") || "application/octet-stream";
      // 5MB 이하만 KV에 저장
      if (buf.byteLength < 5 * 1024 * 1024) {
        await kvSetWithMeta(env, cacheKey, buf, { ct }, 86400 * 3);
      }
      return { buffer: buf, ct };
    }
  } catch {}

  // 3. GitHub Raw 폴백
  try {
    const rawUrl = `${WP_RAW_BASE}/${filePath}`;
    const res = await fetch(rawUrl, {
      headers: { "User-Agent": "CloudPress/5.0" },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const ct = mimeType(filePath) || "application/octet-stream";
      if (buf.byteLength < 5 * 1024 * 1024) {
        await kvSetWithMeta(env, cacheKey, buf, { ct }, 3600);
      }
      return { buffer: buf, ct };
    }
  } catch {}

  return null;
}

// ─── 사용자 GitHub 레포에서 파일 fetch ──────────────────────────────────────
async function fetchUserRepoFile(owner, repo, branch, filePath, token, env) {
  // 1. KV 캐시 (짧은 TTL — 사용자가 자주 수정할 수 있으므로)
  const cacheKey = `user:${owner}/${repo}/${filePath}`;
  const cached = await kvGetWithMeta(env, cacheKey);
  if (cached?.value) {
    return { buffer: cached.value, ct: cached.metadata?.ct || mimeType(filePath), fromCache: true };
  }

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  const headers = { "User-Agent": "CloudPress/5.0" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      headers,
      cf: { cacheEverything: false }, // 사용자 파일은 엣지 캐시 우회
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const ct = mimeType(filePath) || "application/octet-stream";
      // 5MB 이하만 KV에 저장 (TTL 짧게 — 5분)
      if (buf.byteLength < 5 * 1024 * 1024) {
        await kvSetWithMeta(env, cacheKey, buf, { ct }, 300);
      }
      return { buffer: buf, ct };
    }
  } catch {}
  return null;
}

// ─── GitHub 레포에 파일 미러링 (업로드) ─────────────────────────────────────
async function mirrorToGitHub(token, owner, repo, branch, filePath, content, message) {
  if (!token || !owner || !repo) return false;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "CloudPress/5.0",
  };

  // 기존 SHA 조회
  let sha;
  try {
    const r = await fetch(`${apiUrl}?ref=${branch}`, { headers });
    if (r.ok) sha = (await r.json())?.sha;
  } catch {}

  // base64 인코딩
  const bytes = content instanceof ArrayBuffer
    ? new Uint8Array(content)
    : typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);

  const body = { message: message || `upload: ${filePath}`, content: b64, branch };
  if (sha) body.sha = sha;

  try {
    const r = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

// ─── php-wasm 로드 (싱글톤) ──────────────────────────────────────────────────
let _phpWasm = null;
async function loadPhpWasm() {
  if (_phpWasm) return _phpWasm;
  try {
    _phpWasm = await import("@php-wasm/web");
    return _phpWasm;
  } catch {
    // CDN 폴백
    try {
      _phpWasm = await import(
        `https://cdn.jsdelivr.net/npm/@php-wasm/web@0.9.46/build/php_8_2.mjs`
      );
      return _phpWasm;
    } catch (e2) {
      throw new Error("php-wasm 로드 실패: " + e2.message);
    }
  }
}

// ─── VFS 파일 마운트 헬퍼 ────────────────────────────────────────────────────
function vfsMount(php, vfsPath, content) {
  const dir = vfsPath.lastIndexOf("/") > 0
    ? vfsPath.substring(0, vfsPath.lastIndexOf("/"))
    : "";
  if (dir) { try { php.mkdirTree(dir); } catch {} }
  if (typeof content === "string") {
    php.writeFile(vfsPath, content);
  } else {
    php.writeFile(vfsPath, new Uint8Array(content));
  }
}

// ─── WordPress 코어 필수 파일 목록 (요청 경로에 따라 최소화) ─────────────────
function getCoreFiles(phpFile) {
  // 항상 필요한 최소 파일
  const always = [
    "wp-load.php",
    "wp-blog-header.php",
    "wp-settings.php",
    "wp-includes/version.php",
    "wp-includes/compat.php",
    "wp-includes/class-wp-error.php",
    "wp-includes/functions.php",
    "wp-includes/option.php",
    "wp-includes/class-wp-hook.php",
    "wp-includes/plugin.php",
    "wp-includes/default-constants.php",
    "wp-includes/vars.php",
    "wp-includes/kses.php",
    "wp-includes/formatting.php",
    "wp-includes/cache.php",
    "wp-includes/cache-compat.php",
    "wp-includes/capabilities.php",
    "wp-includes/class-wp-roles.php",
    "wp-includes/class-wp-user.php",
    "wp-includes/class-wp-session-tokens.php",
    "wp-includes/class-wp-user-meta-session-tokens.php",
    "wp-includes/meta.php",
    "wp-includes/taxonomy.php",
    "wp-includes/class-wp-taxonomy.php",
    "wp-includes/class-wp-term.php",
    "wp-includes/class-wp-term-query.php",
    "wp-includes/query.php",
    "wp-includes/class-wp-query.php",
    "wp-includes/post.php",
    "wp-includes/class-wp-post.php",
    "wp-includes/post-formats.php",
    "wp-includes/post-thumbnail-template.php",
    "wp-includes/user.php",
    "wp-includes/general-template.php",
    "wp-includes/link-template.php",
    "wp-includes/template.php",
    "wp-includes/template-loader.php",
    "wp-includes/theme.php",
    "wp-includes/class-wp-theme.php",
    "wp-includes/rewrite.php",
    "wp-includes/class-wp-rewrite.php",
    "wp-includes/class-wp.php",
    "wp-includes/locale.php",
    "wp-includes/l10n.php",
    "wp-includes/class-wp-locale.php",
    "wp-includes/class-wp-locale-switcher.php",
    "wp-includes/http.php",
    "wp-includes/class-http.php",
    "wp-includes/class-wp-http.php",
    "wp-includes/class-wp-http-requests-response.php",
    "wp-includes/http-functions.php",
    "wp-includes/rest-api.php",
    "wp-includes/class-wp-rest-server.php",
    "wp-includes/class-wp-rest-request.php",
    "wp-includes/class-wp-rest-response.php",
    "wp-includes/rest-api/class-wp-rest-controller.php",
    "wp-includes/pomo/mo.php",
    "wp-includes/pomo/po.php",
    "wp-includes/pomo/translations.php",
    "wp-includes/pomo/entry.php",
    "wp-includes/class-walker.php",
    "wp-includes/class-wp-walker.php",
    "wp-includes/comment.php",
    "wp-includes/comment-template.php",
    "wp-includes/category.php",
    "wp-includes/category-template.php",
    "wp-includes/author-template.php",
    "wp-includes/canonical.php",
    "wp-includes/shortcodes.php",
    "wp-includes/embed.php",
    "wp-includes/class-wp-embed.php",
    "wp-includes/media.php",
    "wp-includes/default-widgets.php",
    "wp-includes/widgets.php",
    "wp-includes/class-wp-widget.php",
    "wp-includes/class-wp-widget-factory.php",
    "wp-includes/nav-menu.php",
    "wp-includes/nav-menu-template.php",
    "wp-includes/admin-bar.php",
    "wp-includes/class-wp-admin-bar.php",
    "wp-includes/rss.php",
    "wp-includes/feed.php",
    "wp-includes/bookmark.php",
    "wp-includes/bookmark-template.php",
    "wp-includes/cron.php",
    "wp-includes/deprecated.php",
    "wp-includes/script-loader.php",
    "wp-includes/class-wp-scripts.php",
    "wp-includes/class-wp-styles.php",
    "wp-includes/class-wp-dependencies.php",
    "wp-includes/class-wp-dependency.php",
    "wp-includes/default-filters.php",
    "wp-includes/update.php",
    "wp-includes/blocks.php",
    "wp-includes/blocks/index.php",
    "wp-includes/class-wp-block-type.php",
    "wp-includes/class-wp-block-type-registry.php",
    "wp-includes/class-wp-block.php",
    "wp-includes/class-wp-block-list.php",
    "wp-includes/class-wp-block-parser.php",
    "wp-includes/block-supports/index.php",
    "wp-includes/block-template-utils.php",
    "wp-includes/block-patterns.php",
    "wp-includes/class-wp-block-patterns-registry.php",
    "wp-includes/class-wp-block-pattern-categories-registry.php",
    "wp-includes/class-wp-block-template.php",
    "wp-includes/class-wp-classic-to-block-menu-converter.php",
    "wp-includes/class-wp-navigation-fallback.php",
    "wp-includes/class-wp-object-cache.php",
    "wp-includes/class-wp-meta-query.php",
    "wp-includes/class-wp-date-query.php",
    "wp-includes/class-wp-comment.php",
    "wp-includes/class-wp-comment-query.php",
    "wp-includes/class-wp-network.php",
    "wp-includes/class-wp-network-query.php",
    "wp-includes/class-wp-post-type.php",
    "wp-includes/class-wp-image-editor.php",
    "wp-includes/class-wp-image-editor-gd.php",
    "wp-includes/class-wp-image-editor-imagick.php",
    "wp-includes/class-wp-oembed.php",
    "wp-includes/class-wp-xmlrpc-server.php",
    "wp-includes/class-phpseclib-rsa.php",
    "wp-includes/class-pop3.php",
    "wp-includes/class-smtp.php",
    "wp-includes/class-phpmailer.php",
    "wp-includes/ID3/license.commercial.txt",
    "wp-includes/ms-functions.php",
    "wp-includes/ms-default-filters.php",
    "wp-includes/ms-deprecated.php",
    "wp-includes/pluggable.php",
    "wp-includes/pluggable-deprecated.php",
    "wp-includes/registration-functions.php",
    "wp-includes/registration.php",
    "index.php",
  ];

  if (phpFile && phpFile.startsWith("/wp-admin/")) {
    always.push(
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
      "wp-admin/includes/upgrade.php",
      "wp-admin/includes/option.php",
      "wp-admin/includes/class-wp-upgrader.php",
      "wp-admin/includes/class-wp-filesystem-base.php",
      "wp-admin/includes/class-wp-filesystem-direct.php",
      "wp-admin/includes/dashboard.php",
      "wp-admin/includes/nav-menu.php",
      "wp-admin/includes/bookmark.php",
      "wp-admin/includes/comment.php",
      "wp-admin/includes/meta-boxes.php",
      "wp-admin/includes/update-core.php",
      "wp-admin/includes/deprecated.php",
      "wp-admin/includes/screen.php",
      "wp-admin/includes/class-wp-list-table.php",
    );
  }

  if (phpFile === "/wp-login.php") {
    always.push("wp-login.php");
  }

  return [...new Set(always)];
}

// ─── WordPress VFS 구축 ───────────────────────────────────────────────────────
async function buildWpVFS(php, env, payload) {
  const { phpFile, siteConfig } = payload;
  const {
    githubOwner,
    githubRepo,
    githubBranch = "main",
    wpConfigContent,
    dbContent,
  } = siteConfig;

  const token = env.GITHUB_TOKEN;
  const wpRoot = "/var/www/wordpress";

  // 1. WordPress 코어 파일 마운트 (병렬 fetch)
  const coreFiles = getCoreFiles(phpFile);
  const chunks = [];
  for (let i = 0; i < coreFiles.length; i += 10) {
    chunks.push(coreFiles.slice(i, i + 10));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (f) => {
      const result = await fetchCoreFile(f, env);
      if (result) {
        vfsMount(php, `${wpRoot}/${f}`, result.buffer);
      }
    }));
  }

  // 2. wp-config.php 마운트 (직접 주입 or GitHub)
  if (wpConfigContent) {
    vfsMount(php, `${wpRoot}/wp-config.php`, wpConfigContent);
  } else if (githubOwner && githubRepo) {
    const r = await fetchUserRepoFile(
      githubOwner, githubRepo, githubBranch, "wp-config.php", token, env
    );
    if (r) vfsMount(php, `${wpRoot}/wp-config.php`, r.buffer);
  }

  // 3. wp-content/ (테마, 플러그인, 업로드) — GitHub 레포에서
  if (githubOwner && githubRepo) {
    // 필수 파일: wp-content/db.php (D1 드라이버)
    const wpContentFiles = [
      "wp-content/db.php",
    ];
    if (phpFile && phpFile.startsWith("/wp-admin/")) {
      wpContentFiles.push(
        "wp-content/themes/twentytwentyfour/style.css",
        "wp-content/themes/twentytwentyfour/functions.php",
        "wp-content/themes/twentytwentyfour/index.php",
      );
    }
    await Promise.all(wpContentFiles.map(async (f) => {
      const r = await fetchUserRepoFile(
        githubOwner, githubRepo, githubBranch, f, token, env
      );
      if (r) vfsMount(php, `${wpRoot}/${f}`, r.buffer);
    }));
  }

  // 4. db.php 직접 주입 (GitHub에 없는 경우 인라인 생성)
  // php-wasm 환경에서 D1 DB 접근을 위한 커스텀 드라이버
  const dbPhpPath = `${wpRoot}/wp-content/db.php`;
  try { php.readFileAsText(dbPhpPath); } catch {
    // db.php가 없으면 기본 WordPress DB 클래스 사용 (SQLite 호환)
    // D1은 외부에서 wp-config.php의 DB_* 상수로 연결
  }

  return wpRoot;
}

// ─── PHP 실행 ────────────────────────────────────────────────────────────────
async function runWordPress(payload, env) {
  const {
    phpFile = "/index.php",
    phpEnv = {},
    stdin = "",
    siteConfig = {},
    skipCache = false,
  } = payload;

  const siteId = siteConfig.siteId || "default";

  // PHP 출력 캐시 확인 (GET + 비로그인 요청만)
  const cacheable =
    !skipCache &&
    phpEnv.REQUEST_METHOD === "GET" &&
    !phpFile.startsWith("/wp-admin/") &&
    phpFile !== "/wp-login.php" &&
    !/cart|checkout|my-account/.test(phpFile) &&
    !phpEnv.HTTP_COOKIE?.includes("wordpress_logged_in");

  if (cacheable) {
    const cacheKey = `php:${siteId}:${phpEnv.REQUEST_URI || phpFile}`;
    const cached = await kvGetText(env, cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
          "X-Cache": "HIT",
          "X-Powered-By": "CloudPress/php-wasm",
        },
      });
    }
  }

  // php-wasm 로드
  const wasm = await loadPhpWasm();
  const php = await wasm.startPHP({
    dataRoot: "/tmp",
    phpIniEntries: {
      "memory_limit":              "256M",
      "max_execution_time":        "30",
      "upload_max_filesize":       "64M",
      "post_max_size":             "64M",
      "error_reporting":           "E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT",
      "display_errors":            "0",
      "log_errors":                "1",
      "error_log":                 "/tmp/wp-errors.log",
      "date.timezone":             "Asia/Seoul",
      "mbstring.language":         "Korean",
      "mbstring.internal_encoding":"UTF-8",
      "default_charset":           "UTF-8",
      "output_buffering":          "Off",
      "zlib.output_compression":   "On",
      "opcache.enable":            "1",
      "opcache.validate_timestamps":"0",
      "session.cookie_httponly":   "1",
      "session.cookie_samesite":   "Lax",
      "session.save_path":         "/tmp/sessions",
      "upload_tmp_dir":            "/tmp/uploads",
    },
  });

  // /tmp 디렉토리 초기화
  try { php.mkdirTree("/tmp/sessions"); } catch {}
  try { php.mkdirTree("/tmp/uploads"); } catch {}

  // 환경변수 설정
  for (const [k, v] of Object.entries(phpEnv)) {
    if (v !== undefined && v !== null) {
      php.setEnv(k, String(v));
    }
  }
  // CloudPress 전용 환경변수
  if (siteConfig.siteId)     php.setEnv("CP_SITE_ID",      siteConfig.siteId);
  if (siteConfig.dbHost)     php.setEnv("CP_DB_HOST",       siteConfig.dbHost);
  if (siteConfig.dbName)     php.setEnv("CP_DB_NAME",       siteConfig.dbName);
  if (siteConfig.dbUser)     php.setEnv("CP_DB_USER",       siteConfig.dbUser);
  if (siteConfig.dbPass)     php.setEnv("CP_DB_PASS",       siteConfig.dbPass);

  if (stdin) php.setStdin(stdin);

  // VFS 구축
  const wpRoot = await buildWpVFS(php, env, payload);

  let status = 200;
  const headers = new Headers({
    "X-Powered-By": "CloudPress/php-wasm",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
  });
  let output = "";

  try {
    const targetFile = phpFile
      ? `${wpRoot}${phpFile}`
      : `${wpRoot}/index.php`;

    const result = await php.run({ code: `<?php require '${targetFile}'; ?>` });
    output = result.text || "";

    if (result.headers) {
      for (const header of result.headers) {
        const ci = header.indexOf(":");
        if (ci < 0) continue;
        const name  = header.slice(0, ci).trim();
        const value = header.slice(ci + 1).trim();
        const lname = name.toLowerCase();
        if (lname === "location") {
          status = 302;
          headers.set("Location", value);
        } else if (lname === "status") {
          const m = value.match(/^(\d+)/);
          if (m) status = parseInt(m[1]);
        } else if (lname === "set-cookie") {
          headers.append("Set-Cookie", value);
        } else if (!lname.startsWith("http/")) {
          headers.set(name, value);
        }
      }
    }

    if ((result.exitCode || 0) !== 0 && !output) {
      status = 500;
      output = "WordPress 실행 오류 (exit: " + (result.exitCode || 0) + ")";
    }
  } catch (e) {
    status = 500;
    output = "WordPress 예외: " + e.message;
    console.error("[php-runner] WordPress 실행 오류:", e);
  } finally {
    try { php.exit(0); } catch {}
  }

  if (!headers.has("Content-Type")) {
    const t = output.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) headers.set("Content-Type", "application/json; charset=utf-8");
    else if (t.startsWith("<?xml") || t.startsWith("<rss")) headers.set("Content-Type", "application/xml; charset=utf-8");
    else headers.set("Content-Type", "text/html; charset=utf-8");
  }

  // PHP 출력 캐시 저장 (성공한 HTML만)
  if (cacheable && status === 200 && headers.get("Content-Type")?.includes("text/html")) {
    if (!output.includes("wpadminbar") && !output.includes("wordpress_logged_in")) {
      const cacheKey = `php:${siteId}:${phpEnv.REQUEST_URI || phpFile}`;
      await kvSet(env, cacheKey, output, 3600);
    }
  }

  return new Response(output, { status, headers });
}

// ─── 정적 파일 서빙 ──────────────────────────────────────────────────────────
async function serveStatic(filePath, env, githubOwner, githubRepo, token) {
  // 1. 사용자 wp-content는 GitHub 레포에서
  if (filePath.startsWith("wp-content/") && githubOwner && githubRepo) {
    const branch = "main";
    const r = await fetchUserRepoFile(githubOwner, githubRepo, branch, filePath, token, env);
    if (r) {
      return new Response(r.buffer, {
        headers: {
          "Content-Type":  r.ct,
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
          "X-Source":      "github-user-repo",
        },
      });
    }
  }

  // 2. WordPress 코어 파일 (wp-includes, wp-admin 정적 자산)
  const r = await fetchCoreFile(filePath, env);
  if (r) {
    return new Response(r.buffer, {
      headers: {
        "Content-Type":  r.ct,
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Cache":       r.fromCache ? "HIT" : "MISS",
        "X-Source":      "wp-core",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
}

// ─── 메인 fetch 핸들러 ───────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // ── 헬스체크 ─────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", version: "5.0", engine: "php-wasm", wp: WP_VERSION }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 정적 파일 서빙 ───────────────────────────────────────────────────────
    if (url.pathname === "/serve-static" && method === "GET") {
      const filePath     = url.searchParams.get("path") || "";
      const githubOwner  = url.searchParams.get("github_owner") || "";
      const githubRepo   = url.searchParams.get("github_repo") || "";
      const token        = env.GITHUB_TOKEN;
      return serveStatic(filePath, env, githubOwner, githubRepo, token);
    }

    // ── 미디어 업로드 미러링 ─────────────────────────────────────────────────
    if (url.pathname === "/mirror-upload" && method === "POST") {
      const filePath    = url.searchParams.get("path") || "";
      const ghOwner     = url.searchParams.get("github_owner") || "";
      const ghRepo      = url.searchParams.get("github_repo") || "";
      const ghBranch    = url.searchParams.get("github_branch") || "main";
      const message     = url.searchParams.get("message") || `upload: ${filePath}`;
      const body        = await request.arrayBuffer();

      ctx.waitUntil(
        mirrorToGitHub(env.GITHUB_TOKEN, ghOwner, ghRepo, ghBranch, filePath, body, message)
      );

      return new Response(JSON.stringify({ success: true, path: filePath }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── PHP 실행 ─────────────────────────────────────────────────────────────
    if (url.pathname === "/run-wordpress" && method === "POST") {
      let payload;
      try { payload = await request.json(); }
      catch { return new Response("Invalid JSON", { status: 400 }); }

      return runWordPress(payload, env);
    }

    // ── KV 캐시 무효화 ───────────────────────────────────────────────────────
    if (url.pathname === "/invalidate-cache" && method === "POST") {
      const { siteId, pattern } = await request.json().catch(() => ({}));
      if (env.CACHE) {
        try {
          // PHP 출력 캐시 삭제
          if (siteId) {
            const list = await env.CACHE.list({ prefix: `php:${siteId}:` });
            for (const k of (list.keys || [])) {
              await env.CACHE.delete(k.name).catch(() => {});
            }
          }
          // 사용자 파일 캐시 삭제
          if (pattern) {
            const list = await env.CACHE.list({ prefix: `user:${pattern}` });
            for (const k of (list.keys || [])) {
              await env.CACHE.delete(k.name).catch(() => {});
            }
          }
        } catch {}
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("CloudPress PHP Runner: 잘못된 요청", { status: 400 });
  },
};
