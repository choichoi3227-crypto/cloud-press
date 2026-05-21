/**
 * CloudPress — worker-site-mirror.js v15.1
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker
 *
 * 처리 순서:
 *   1. PHP Runner Service Binding
 *   2. KV 캐시 HIT (정적 자산)
 *   3. wp-content / wp-includes / wp-admin 정적 자산 → GitHub raw
 *   4. _cache/ 정적 HTML → GitHub raw
 *   5. 일반 정적 자산 GitHub raw
 *   6. GitHub Pages 폴백
 *   7. PHP Runner 없을 때 준비 중 안내 페이지
 *   최종: WordPress 스타일 404
 */

const GH_BRANCH  = "main";
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;
const WP_PHP_PATHS = /^\/wp-(admin|login\.php|cron\.php|json|comments|signup|activate|trackback|xmlrpc\.php|mail\.php|blog-header\.php|load\.php|settings\.php|app\.php)(\/|$|\?)/;
const WP_PHP_FILES = /^\/wp-(login|cron|xmlrpc|mail|blog-header|load|settings|app)\.php(\?|$)/;

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

// PHP Runner 없을 때 준비 중 안내 페이지
function phpOfflinePage(path, siteTitle = "WordPress") {
  const isAdmin = path.startsWith("/wp-admin");
  const title   = isAdmin ? "WordPress 관리자" : "WordPress";
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${title} — 시작 중...</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#f0f0f1;color:#3c434a;display:flex;align-items:center;
       justify-content:center;min-height:100vh;padding:1rem}
  .card{background:#fff;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.13);
        padding:2rem;max-width:420px;width:100%;text-align:center}
  .logo{width:64px;height:64px;margin:0 auto 1.5rem;background:#2271b1;
        border-radius:50%;display:flex;align-items:center;justify-content:center}
  .logo svg{fill:#fff;width:36px;height:36px}
  h1{font-size:1.25rem;font-weight:600;margin:0 0 .75rem;color:#1d2327}
  p{font-size:.9rem;color:#646970;margin:0 0 1.5rem;line-height:1.6}
  .spinner{width:32px;height:32px;border:3px solid #e2e8f0;
           border-top-color:#2271b1;border-radius:50%;
           animation:spin 1s linear infinite;margin:0 auto 1rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  .note{font-size:.8rem;color:#8c8f94;background:#f6f7f7;
        border-radius:3px;padding:.5rem .75rem;margin-top:1.25rem}
  a{color:#2271b1;text-decoration:none}a:hover{text-decoration:underline}
</style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zM3.8 12c0-1.2.3-2.4.7-3.4L8 19.4C5.5 18 3.8 15.2 3.8 12zm8.2 8.2c-.8 0-1.6-.1-2.4-.3l2.5-7.4 2.6 7.1c0 .1.1.2.1.3-.9.2-1.8.3-2.8.3zm1.1-11.6l2.2 6.4.6-2 1.6-4.4c.3-.7.4-1.3.4-1.8 0-.2 0-.4-.1-.5.6.1 1.2.1 1.7.1h.2c-.8 2.5-1.7 5.4-2.6 8.2l-1.4-4.2-.9-2.5-.9-2.4c.3-.3.6-.5 1-.5.1 0 .2 0 .3.1zm-3.3.2c-.1.5-.3 1.1-.6 1.8L7.6 16c-.5-1.2-.8-2.5-.8-3.9 0-2.1.8-4 2-5.4.4 1 .9 2 1 2.1z"/>
      </svg>
    </div>
    <div class="spinner"></div>
    <h1>WordPress PHP 서버 시작 중</h1>
    <p>PHP 서버가 준비되는 동안 잠시 기다려 주세요.<br>
       30초 후 자동으로 새로고침됩니다.</p>
    <div class="note">
      <strong>참고:</strong> 첫 방문 또는 비활성 상태에서 PHP 서버가
      시작하는 데 1~2분이 걸릴 수 있습니다.<br><br>
      <a href="/">← 홈으로 돌아가기</a>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      ...SEC,
      "Content-Type":  "text/html;charset=utf-8",
      "Retry-After":   "30",
      "Cache-Control": "no-store",
    },
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
        const payload = {
          phpFile: path.endsWith(".php") ? path : "/index.php",
          phpEnv: {
            REQUEST_URI:          path + url.search,
            REQUEST_METHOD:       req.method,
            HTTP_HOST:            url.host,
            SERVER_NAME:          url.host,
            HTTPS:                url.protocol === "https:" ? "on" : "",
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

    // ── 4차: _cache/ 정적 HTML ───────────────────────────────────────────────
    if (isGet && !STATIC_EXT.test(path) && !WP_PHP_PATHS.test(path) && !WP_PHP_FILES.test(path)) {
      let cp = "_cache" + path;
      if (cp.endsWith("/")) cp += "index.html";
      else if (!cp.includes(".")) cp += "/index.html";

      let res = await ghRaw(env, cp, 60);
      if (!res) res = await ghRaw(env, "_cache" + path + ".html", 60);

      if (res) {
        // ▼▼▼ 인코딩 깨짐 핵심 수정: 텍스트로 읽어서 charset meta 보장 후 반환 ▼▼▼
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

    // ── 5차: 일반 정적 자산 GitHub raw ──────────────────────────────────────
    if (isGet && STATIC_EXT.test(path)) {
      let res = await ghRaw(env, "wordpress" + path, 3600);
      if (!res) res = await ghRaw(env, path.slice(1), 3600);
      if (res) {
        const body = await res.arrayBuffer();
        return new Response(body, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=3600", ...SEC },
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

    // ── 7차: PHP 경로 → PHP Runner 없을 때 준비 중 안내 ─────────────────────
    if (WP_PHP_PATHS.test(path) || WP_PHP_FILES.test(path) || path.endsWith(".php")) {
      return phpOfflinePage(path, env.SITE_NAME || "WordPress");
    }

    // ── 최종: WordPress 스타일 404 ───────────────────────────────────────────
    return wp404(env.SITE_NAME || "WordPress");
  },
};
