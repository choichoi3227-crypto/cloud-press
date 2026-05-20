/**
 * CloudPress — worker-site-mirror.js v14.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 사이트별 Cloudflare Worker
 *
 * 처리 순서:
 *   1. PHP Runner Service Binding (GitHub Actions keepalive PHP 서버)
 *   2. KV 캐시 HIT (정적 자산)
 *   3. wp-content 정적 자산 → GitHub raw 미러
 *   4. _cache/ 정적 HTML → GitHub raw (install 직후 생성됨)
 *   5. wp-content 없는 정적 자산 → GitHub raw (직접)
 *   6. GitHub Pages 폴백
 *   404: 깔끔한 WordPress 404
 */

const GH_BRANCH = "main";
const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
};

const ghOwner = (e) => e.GH_OWNER  || "%%GH_OWNER%%";
const ghRepo  = (e) => e.GH_REPO   || "%%GH_REPO%%";
const ghToken = (e) => e.GITHUB_TOKEN || "";
const ghPages = (e) => e.GH_PAGES_URL || "%%GH_PAGES_URL%%";
const siteUrl = (e) => e.SITE_URL  || "%%SITE_URL%%";

const kvGet = async (e, k)    => { try { return await e.CACHE?.get(k, "arrayBuffer"); } catch { return null; } };
const kvPut = async (e, k, v) => { try { await e.CACHE?.put(k, v, { expirationTtl: 86400 }); } catch {} };

function mime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({
    css:"text/css;charset=utf-8", js:"application/javascript;charset=utf-8",
    json:"application/json;charset=utf-8", xml:"application/xml;charset=utf-8",
    svg:"image/svg+xml", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg",
    gif:"image/gif", webp:"image/webp", avif:"image/avif", ico:"image/x-icon",
    woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf",
    eot:"application/vnd.ms-fontobject", otf:"font/otf",
    pdf:"application/pdf", zip:"application/zip",
    mp4:"video/mp4", mp3:"audio/mpeg",
    txt:"text/plain;charset=utf-8", html:"text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

async function ghRaw(env, filePath, ttl = 300) {
  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);
  if (!o || !r || o === "%%GH_OWNER%%" || r === "%%GH_REPO%%") return null;
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${o}/${r}/${GH_BRANCH}/${filePath}`,
      {
        headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), "User-Agent": "CloudPress/14" },
        cf: { cacheEverything: true, cacheTtl: ttl },
      }
    );
    return res.ok ? res : null;
  } catch { return null; }
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
    const url  = new URL(req.url);
    const path = url.pathname;
    const isGet = req.method === "GET";

    // ── 1차: PHP Runner Service Binding → /run-wordpress POST 방식으로 호출 ──
    // php-runner는 /run-wordpress POST만 처리하므로 payload를 직접 구성
    if (env.PHP_RUNNER) {
      try {
        const method = req.method.toUpperCase();
        let postBody = "";
        if (["POST", "PUT", "PATCH"].includes(method)) {
          postBody = await req.clone().text().catch(() => "");
        }
        const phpFile = (path === "/" || path === "") ? "/index.php"
          : path.endsWith(".php") ? path
          : path.startsWith("/wp-admin") ? (path.endsWith("/") ? path + "index.php" : path)
          : "/index.php";

        const payload = {
          phpFile,
          phpEnv: {
            REQUEST_URI:    path + url.search,
            REQUEST_METHOD: method,
            HTTP_HOST:      url.host,
            SERVER_NAME:    url.host,
            SERVER_PORT:    url.port || (url.protocol === "https:" ? "443" : "80"),
            HTTPS:          url.protocol === "https:" ? "on" : "",
            QUERY_STRING:   url.search.replace(/^\?/, ""),
            DOCUMENT_ROOT:  "/wordpress",
            SCRIPT_FILENAME: `/wordpress${phpFile}`,
            SCRIPT_NAME:    phpFile,
            PHP_SELF:       phpFile,
            GATEWAY_INTERFACE: "CGI/1.1",
            SERVER_PROTOCOL: "HTTP/1.1",
            SERVER_SOFTWARE: "CloudPress/14.0",
            HTTP_COOKIE:          req.headers.get("Cookie")           || "",
            HTTP_USER_AGENT:      req.headers.get("User-Agent")       || "CloudPress",
            HTTP_ACCEPT:          req.headers.get("Accept")           || "*/*",
            HTTP_ACCEPT_LANGUAGE: req.headers.get("Accept-Language")  || "ko-KR,ko;q=0.9",
            HTTP_ACCEPT_ENCODING: req.headers.get("Accept-Encoding")  || "gzip",
            HTTP_REFERER:         req.headers.get("Referer")          || "",
            HTTP_X_FORWARDED_FOR: req.headers.get("CF-Connecting-IP") || "",
            CONTENT_TYPE:         req.headers.get("Content-Type")     || "",
            CONTENT_LENGTH:       String(postBody.length),
            GITHUB_OWNER: ghOwner(env),
            GITHUB_REPO:  ghRepo(env),
            GITHUB_TOKEN: ghToken(env),
          },
          stdin: postBody,
          siteConfig: {
            githubOwner: ghOwner(env),
            githubRepo:  ghRepo(env),
            githubToken: ghToken(env),
            ghPagesUrl:  ghPages(env) !== "%%GH_PAGES_URL%%" ? ghPages(env) : "",
            siteUrl:     siteUrl(env) !== "%%SITE_URL%%"     ? siteUrl(env) : "",
          },
          skipCache: (req.headers.get("Cookie") || "").includes("wordpress_logged_in"),
        };

        const phpRes = await env.PHP_RUNNER.fetch(
          new Request("https://php/run-wordpress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        );
        // 200~499 응답은 그대로 반환 (404 포함 — WP가 직접 404 페이지 생성)
        // 단 400은 잘못된 요청(php-runner 라우팅 실패)이므로 제외
        if (phpRes.ok || (phpRes.status >= 300 && phpRes.status < 500 && phpRes.status !== 400)) {
          return phpRes;
        }
      } catch { /* PHP Runner 오프라인 → 다음 단계로 */ }
    }

    // ── 2차: KV 캐시 HIT (정적 자산) ────────────────────────────────────────
    if (isGet && STATIC_EXT.test(path)) {
      const cacheKey = `v14:${ghOwner(env)}/${ghRepo(env)}:${path}`;
      const cached = await kvGet(env, cacheKey);
      if (cached) {
        return new Response(cached, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC },
        });
      }
    }

    // ── 3차: wp-content 정적 자산 → GitHub raw ──────────────────────────────
    if (isGet && STATIC_EXT.test(path) && path.startsWith("/wp-content/")) {
      const res = await ghRaw(env, path.replace(/^\//, ""), 86400);
      if (res) {
        const body = await res.arrayBuffer();
        const cacheKey = `v14:${ghOwner(env)}/${ghRepo(env)}:${path}`;
        ctx.waitUntil(kvPut(env, cacheKey, body));
        return new Response(body, {
          headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC },
        });
      }
    }

    // ── 4차: _cache/ 정적 HTML (install/keepalive 워크플로우가 생성) ─────────
    if (isGet && !STATIC_EXT.test(path)) {
      // _cache/index.html, _cache/about/index.html 등
      let cp = "_cache" + path;
      if (cp.endsWith("/")) cp += "index.html";
      else cp += "/index.html";

      let res = await ghRaw(env, cp, 60);
      // /path.html 형태도 시도
      if (!res) res = await ghRaw(env, "_cache" + path + ".html", 60);

      if (res) {
        const body = await res.arrayBuffer();
        // HTML 캐시는 짧게 (keepalive가 갱신하므로)
        return new Response(body, {
          headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public,max-age=60,s-maxage=300", ...SEC },
        });
      }
    }

    // ── 5차: 일반 정적 자산 GitHub raw (wp-content 아닌 것) ─────────────────
    if (isGet && STATIC_EXT.test(path)) {
      const res = await ghRaw(env, path.replace(/^\//, ""), 3600);
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
        if (r.ok) return r;
      } catch {}
    }

    // ── 7차: wp-admin / wp-json 등 POST 요청은 PHP Runner 없이 503 ──────────
    if (path.startsWith("/wp-admin") || path.startsWith("/wp-json") || path.startsWith("/wp-login")) {
      return new Response(
        JSON.stringify({ error: "WordPress PHP 서버가 현재 오프라인입니다. 잠시 후 다시 시도해주세요.", code: "php_offline" }),
        { status: 503, headers: { ...SEC, "Content-Type": "application/json", "Retry-After": "30" } }
      );
    }

    // ── 최종: WordPress 스타일 404 ───────────────────────────────────────────
    return wp404(env.SITE_NAME || "WordPress");
  },
};
