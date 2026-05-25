/**
 * CloudPress — worker-site-mirror.js v15.2
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker
 *
 * 처리 순서:
 *   1. PHP Runner Service Binding
 *   2. KV 캐시 HIT (정적 자산)
 *   3. WordPress 핵심 디렉터리 정적 자산 → GitHub raw
 *   4. dist/ (Astro 빌드 결과) 정적 HTML → GitHub raw
 *   4b. Astro 정적 자산 (dist/_assets/)
 *   5. _cache/ 정적 HTML → GitHub raw (레거시 폴백)
 *   6. 일반 정적 자산 → GitHub raw
 *   7. GitHub Pages 폴백
 *   최종: 404 페이지
 */

const GH_BRANCH  = "main";
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;
const WP_PHP_PATHS = /^\/wp-(admin|login\.php|cron\.php|json|comments|signup|activate|trackback|xmlrpc\.php|mail\.php|blog-header\.php|load\.php|settings\.php|app\.php)(\/|$|\?)/;
const WP_PHP_FILES = /^\/wp-(login|cron|xmlrpc|mail|blog-header|load|settings|app)\.php(\?|$)/;

const WP_PHP_ROUTES = {
  "/":            "/index.php",
  "/wp-login":    "/wp-login.php",
  "/wp-admin":    "/wp-admin/index.php",
  "/wp-admin/":   "/wp-admin/index.php",
  "/wp-json":     "/index.php",
  "/feed":        "/index.php",
  "/sitemap.xml": "/index.php",
  "/robots.txt":  "/robots.txt",
};

function resolvePhpFile(path) {
  const clean = path.replace(/\/$/, "") || "/";
  if (WP_PHP_ROUTES[clean]) return WP_PHP_ROUTES[clean];
  if (path.endsWith(".php")) return path;
  if (path.startsWith("/wp-admin")) {
    return path.endsWith("/") ? path + "index.php" : path + "/index.php";
  }
  if (!path.includes(".") || path.endsWith("/")) return "/index.php";
  return "/index.php";
}

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
};

const ghOwner = (e) => e.GH_OWNER       || "%%GH_OWNER%%";
const ghRepo  = (e) => e.GH_REPO        || "%%GH_REPO%%";
const ghToken = (e) => e.GITHUB_TOKEN   || "";
const ghPages = (e) => e.GH_PAGES_URL   || "%%GH_PAGES_URL%%";

const kvGet = async (e, k)    => { try { return await e.CACHE?.get(k, "arrayBuffer"); } catch { return null; } };
const kvPut = async (e, k, v) => { try { await e.CACHE?.put(k, v, { expirationTtl: 86400 }); } catch {} };

function mime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({
    css:"text/css;charset=utf-8",       js:"application/javascript;charset=utf-8",
    json:"application/json;charset=utf-8", xml:"application/xml;charset=utf-8",
    svg:"image/svg+xml",   png:"image/png",     jpg:"image/jpeg",   jpeg:"image/jpeg",
    gif:"image/gif",       webp:"image/webp",   avif:"image/avif",  ico:"image/x-icon",
    woff:"font/woff",      woff2:"font/woff2",  ttf:"font/ttf",
    eot:"application/vnd.ms-fontobject",        otf:"font/otf",
    pdf:"application/pdf", zip:"application/zip",
    mp4:"video/mp4",       mp3:"audio/mpeg",
    txt:"text/plain;charset=utf-8",
    html:"text/html;charset=utf-8",
    php:"text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

async function ghRaw(env, filePath, ttl = 300) {
  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);
  if (!o || !r || o === "%%GH_OWNER%%" || r === "%%GH_REPO%%") return null;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${o}/${r}/${GH_BRANCH}/${filePath}`,
      {
        headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), "User-Agent": "CloudPress/15" },
        cf: { cacheEverything: true, cacheTtl: ttl },
      }
    );
    return res.ok ? res : null;
  } catch { return null; }
}

/**
 * PHP Runner 응답의 Content-Type에 charset=utf-8을 강제로 주입합니다.
 * WordPress가 내보내는 HTML에 <meta charset="UTF-8">이 있어도
 * HTTP 헤더 레벨에서 charset이 없으면 브라우저가 잘못된 인코딩으로 렌더링합니다.
 */
function fixCharset(res) {
  const ct = res.headers.get("Content-Type") || "";
  // 이미 charset 있거나 HTML이 아니면 그대로 반환
  if (ct.includes("charset") || (!ct.includes("text/html") && !ct.includes("text/plain"))) {
    return res;
  }
  // charset=utf-8 주입
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Content-Type", ct.replace(/;\s*$/, "") + ";charset=utf-8");
  return new Response(res.body, {
    status:     res.status,
    statusText: res.statusText,
    headers:    newHeaders,
  });
}

/**
 * HTML 문자열에 <meta charset="UTF-8">이 없으면 <head> 바로 뒤에 삽입합니다.
 */
function ensureCharsetMeta(html) {
  if (/charset/i.test(html.slice(0, 2000))) return html;
  // <head> 태그 뒤에 삽입
  return html.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="UTF-8">');
}

// WordPress 스타일 404 페이지
function wp404(siteTitle = "WordPress") {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>페이지를 찾을 수 없습니다 — ${siteTitle}</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       background:#fff;color:#1e293b;padding:2rem;display:flex;
       align-items:center;justify-content:center;min-height:100vh}
  .wrap{max-width:500px;text-align:center}
  h1{font-size:6rem;font-weight:900;color:#e2e8f0;margin:0;line-height:1}
  h2{font-size:1.5rem;font-weight:700;margin:.5rem 0 1rem}
  p{color:#64748b;margin-bottom:1.5rem}
  a{color:#6366f1;text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
</style>
</head>
<body>
  <div class="wrap">
    <h1>404</h1>
    <h2>페이지를 찾을 수 없습니다</h2>
    <p>찾으시는 페이지가 없거나 이동되었습니다.</p>
    <a href="/">← 홈으로 돌아가기</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { ...SEC, "Content-Type": "text/html;charset=utf-8" },
  });
}


export default {
  async fetch(req, env, ctx) {
    const url   = new URL(req.url);
    const path  = url.pathname;
    const isGet = req.method === "GET" || req.method === "HEAD";

    // ── 1차: PHP Runner Service Binding ─────────────────────────────────────
    if (env.PHP_RUNNER) {
      try {
        let body = "";
        if (req.method !== "GET" && req.method !== "HEAD") {
          body = await req.clone().text().catch(() => "");
        }
        const phpFile = resolvePhpFile(path);
        const siteUrl = `${url.protocol}//${url.host}`;
        const [wpCfgRes, dbPhpRes] = await Promise.all([
          ghRaw(env, "wordpress/wp-config.php", 120),
          ghRaw(env, "wordpress/wp-content/db.php", 120),
        ]);
        const wpConfig = wpCfgRes ? await wpCfgRes.text() : "";
        const dbPhp    = dbPhpRes ? await dbPhpRes.text() : "";

        const payload = {
          phpFile,
          phpEnv: {
            WP_HOME:              siteUrl,
            WP_SITEURL:           siteUrl,
            REQUEST_URI:          path + url.search,
            REQUEST_METHOD:       req.method,
            HTTP_HOST:            url.host,
            SERVER_NAME:          url.host,
            HTTPS:                url.protocol === "https:" ? "on" : "",
            DOCUMENT_ROOT:        "/wordpress",
            SCRIPT_FILENAME:      `/wordpress${phpFile}`,
            SCRIPT_NAME:          phpFile,
            PHP_SELF:             phpFile,
            HTTP_COOKIE:          req.headers.get("Cookie")           || "",
            HTTP_USER_AGENT:      req.headers.get("User-Agent")       || "",
            HTTP_ACCEPT:          req.headers.get("Accept")           || "*/*",
            HTTP_ACCEPT_LANGUAGE: req.headers.get("Accept-Language")  || "ko-KR,ko;q=0.9",
            HTTP_ACCEPT_ENCODING: req.headers.get("Accept-Encoding")  || "",
            HTTP_REFERER:         req.headers.get("Referer")          || "",
            HTTP_AUTHORIZATION:   req.headers.get("Authorization")    || "",
            CONTENT_TYPE:         req.headers.get("Content-Type")     || "",
            CONTENT_LENGTH:       String(body.length),
            QUERY_STRING:         url.search.replace(/^\?/, ""),
            GITHUB_OWNER:         ghOwner(env),
            GITHUB_REPO:          ghRepo(env),
            GITHUB_TOKEN:         ghToken(env),
          },
          stdin:      body,
          skipCache:  false,
          files: {
            "/wordpress/wp-config.php":     wpConfig,
            "/wordpress/wp-content/db.php": dbPhp,
          },
          siteConfig: {
            githubOwner: ghOwner(env),
            githubRepo:  ghRepo(env),
            ghPagesUrl:  ghPages(env),
          },
        };

        const phpRes = await env.PHP_RUNNER.fetch(
          new Request("https://php-runner/run-wordpress", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
          })
        );
        // charset 보정 후 반환 (500 이상은 다음 단계로)
        if (phpRes.status < 500) return fixCharset(phpRes);
      } catch { /* PHP Runner 오프라인 → 다음 단계로 */ }
    }

    // ── 2차: KV 캐시 HIT (정적 자산) ────────────────────────────────────────
    if (isGet && STATIC_EXT.test(path)) {
      const cacheKey = `v15:${ghOwner(env)}/${ghRepo(env)}:${path}`;
      const cached = await kvGet(env, cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC },
        });
      }
    }

    // ── 3차: WordPress 핵심 디렉터리 정적 자산 → GitHub raw ─────────────────
    if (isGet && STATIC_EXT.test(path) &&
        (path.startsWith("/wp-content/") || path.startsWith("/wp-includes/") || path.startsWith("/wp-admin/"))) {
      const res = await ghRaw(env, "wordpress" + path, 86400);
      if (res) {
        const body = await res.arrayBuffer();
        const cacheKey = `v15:${ghOwner(env)}/${ghRepo(env)}:${path}`;
        ctx.waitUntil(kvPut(env, cacheKey, body));
        return new Response(body, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC },
        });
      }
    }

    // ── 4차: dist/ (Astro 빌드 결과) 정적 HTML ──────────────────────────────
    if (isGet && !STATIC_EXT.test(path) && !WP_PHP_PATHS.test(path) && !WP_PHP_FILES.test(path)) {
      const clean = path.replace(/\/$/, "") || "/";
      const distCandidates = [
        `dist${clean}/index.html`,
        `dist${clean}.html`,
      ];
      if (path === "/" || path === "") distCandidates.unshift("dist/index.html");

      for (const dp of distCandidates) {
        const res = await ghRaw(env, dp, 60);
        if (res) {
          const raw  = await res.text();
          const html = ensureCharsetMeta(raw);
          return new Response(html, {
            headers: {
              "Content-Type":  "text/html;charset=utf-8",
              "Cache-Control": "public,max-age=60,s-maxage=300",
              ...SEC,
            },
          });
        }
      }
    }

    // ── 4-b차: Astro 정적 자산 (dist/_assets/) ──────────────────────────────
    if (isGet && STATIC_EXT.test(path)) {
      const distAsset = await ghRaw(env, "dist" + path, 86400);
      if (distAsset) {
        const body = await distAsset.arrayBuffer();
        return new Response(body, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=86400,immutable", ...SEC },
        });
      }
    }

    // ── 5차: _cache/ 정적 HTML ───────────────────────────────────────────────
    if (isGet && !STATIC_EXT.test(path) && !WP_PHP_PATHS.test(path) && !WP_PHP_FILES.test(path)) {
      let cp = "_cache" + path;
      if (cp.endsWith("/")) cp += "index.html";
      else if (!cp.includes(".")) cp += "/index.html";

      let res = await ghRaw(env, cp, 60);
      if (!res) res = await ghRaw(env, "_cache" + path + ".html", 60);

      if (res) {
        const raw  = await res.text();
        const html = ensureCharsetMeta(raw);
        return new Response(html, {
          headers: {
            "Content-Type":  "text/html;charset=utf-8",
            "Cache-Control": "public,max-age=60,s-maxage=300",
            ...SEC,
          },
        });
      }
    }

    // ── 6차: GitHub Pages 폴백 ───────────────────────────────────────────────
    const pagesBase = ghPages(env);
    if (pagesBase && pagesBase !== "%%GH_PAGES_URL%%") {
      try {
        const r = await fetch(pagesBase + path + url.search);
        if (r.ok) return fixCharset(r);
      } catch {}
    }

    // ── 최종: WordPress 스타일 404 ───────────────────────────────────────────
    return wp404(env.SITE_NAME || "WordPress");
  },
};
