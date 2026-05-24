// functions/api/github-pages-hosting.js
//
// GitHub Pages WordPress 호스팅 모듈 (v2 — 완전 재작성)
// ─────────────────────────────────────────────────────────────────────────────
// 레포 구조:
//   /wordpress/          ← 실제 WordPress 파일 (PHP 원본 그대로)
//   /_db/
//     wordpress.db       ← SQLite 호환 JSON DB (로그인·설정·URL 포함)
//     settings.json      ← 사이트 설정 (siteurl, blogname 등)
//     users.json         ← 사용자 (bcrypt 해시)
//     posts.json / pages.json / categories.json / tags.json / comments.json / media.json
//   /_content/
//     posts/<slug>.md    ← 글 본문 (Markdown)
//   /_config/
//     plan.json          ← 플랜 설정
//   /worker-site-mirror.js  ← Cloudflare Worker 소스 (레포에도 보관)
//   /wp-transform.ts     ← 단일 PHP 실시간 실행 브릿지 (접속 시 PHP 실행→결과 응답)
//   .github/workflows/
//     deploy.yml         ← WordPress DB 동기화
//     php-keepalive.yml  ← PHP keep-alive (최대 20초 대기)
//     cms-update.yml     ← CMS 콘텐츠 업데이트
//     plan-monitor.yml   ← 일일 리소스 모니터링
// ─────────────────────────────────────────────────────────────────────────────

import { ghReq, pickGithubToken } from "./github-storage.js";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const PROVISION_DELAYS = {
  after_repo_create:       12000,   // 레포 생성 후 안정화 대기 (12초)
  between_db_files:         800,    // DB 파일 간 간격 (0.8초)
  between_src_files:        600,    // 소스 파일 간 간격 (0.6초)
  between_workflow_files:   1000,   // 워크플로 파일 간 간격 (1초)
  after_astro_trigger:     60000,   // Astro 빌드 트리거 후 대기 (60초)
  after_pages_activate:    30000,   // GitHub Pages 활성화 후 대기 (30초)
  validation_phase:       120000,   // 검증 단계 대기 (2분)
  plan_config_phase:       30000,   // 플랜 설정 단계 대기 (30초)
};

export const GITHUB_PAGES_IPV4 = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
];
export const GITHUB_PAGES_IPV6 = [
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
];

// ── 유틸 ─────────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "");
}

// 비밀번호 해싱 (Web Crypto PBKDF2)
async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const key  = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" },
    key, 256
  );
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,"0")).join("");
  return `pbkdf2:sha256:100000:${salt}:${hash}`;
}

// base64 인코딩 (UTF-8 safe)
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary  = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function getGithubPagesUrl(owner, repoName) {
  return `https://${owner}.github.io/${repoName}`;
}

// ── GitHub 파일 R/W ───────────────────────────────────────────────────────────

async function ghGetFile(token, owner, repo, path) {
  const res = await ghReq("GET", `/repos/${owner}/${repo}/contents/${path}`, token);
  if (!res.ok && res.status !== 200) return null;
  const data = res.data || res;
  if (!data?.content) return null;
  return {
    content:  atob(data.content.replace(/\n/g, "")),
    sha:      data.sha,
    encoding: data.encoding,
  };
}

async function ghPutFile(token, owner, repo, path, content, message, sha) {
  const body = {
    message,
    content: toBase64(content),
    ...(sha ? { sha } : {}),
  };
  const res = await ghReq("PUT", `/repos/${owner}/${repo}/contents/${path}`, token, body);
  return { ok: res.ok || res.status === 200 || res.status === 201, sha: res.data?.content?.sha };
}

// ── JSON DB 헬퍼 ─────────────────────────────────────────────────────────────

async function readJsonDb(token, owner, repo, file) {
  const f = await ghGetFile(token, owner, repo, `_db/${file}`);
  if (!f) return { data: [], sha: null };
  try { return { data: JSON.parse(f.content), sha: f.sha }; }
  catch { return { data: [], sha: f.sha }; }
}

async function writeJsonDb(token, owner, repo, file, data, sha, msg) {
  const content = JSON.stringify(data, null, 2);
  return ghPutFile(token, owner, repo, `_db/${file}`, content, msg || `db: update ${file}`, sha);
}

// ── _db/wordpress.db 생성 (SQLite 호환 JSON 포맷) ────────────────────────────
// 이 파일은 PHP의 wp-content/db.php 드라이버가 읽는 메인 DB입니다.
// GitHub Actions의 php 액션이 이 파일을 SQLite로 변환합니다.

function buildWordpressDb({ siteUrl, siteName, adminUser, adminEmail, passHash, now, siteId }) {
  // WordPress options 테이블 완전 호환 구조
  return JSON.stringify({
    _version: "2.0",
    _engine:  "cloudpress-json-db",
    _site_id: siteId,
    options: [
      { option_name: "siteurl",             option_value: siteUrl,        autoload: "yes" },
      { option_name: "blogname",            option_value: siteName,       autoload: "yes" },
      { option_name: "blogdescription",     option_value: "",             autoload: "yes" },
      { option_name: "admin_email",         option_value: adminEmail,     autoload: "yes" },
      { option_name: "home",                option_value: siteUrl,        autoload: "yes" },
      { option_name: "template",            option_value: "twentytwentyfour", autoload: "yes" },
      { option_name: "stylesheet",          option_value: "twentytwentyfour", autoload: "yes" },
      { option_name: "blogcharset",         option_value: "UTF-8",        autoload: "yes" },
      { option_name: "WPLANG",              option_value: "ko_KR",        autoload: "yes" },
      { option_name: "timezone_string",     option_value: "Asia/Seoul",   autoload: "yes" },
      { option_name: "date_format",         option_value: "Y년 n월 j일",  autoload: "yes" },
      { option_name: "time_format",         option_value: "H:i",          autoload: "yes" },
      { option_name: "permalink_structure", option_value: "/%postname%/", autoload: "yes" },
      { option_name: "posts_per_page",      option_value: "10",           autoload: "yes" },
      { option_name: "active_plugins",      option_value: "a:0:{}",       autoload: "yes" },
      { option_name: "wp_user_roles",       option_value: "",             autoload: "yes" },
      { option_name: "db_version",          option_value: "57155",        autoload: "yes" },
      { option_name: "initial_db_version",  option_value: "57155",        autoload: "yes" },
      { option_name: "cloudpress_site_id",  option_value: siteId,         autoload: "yes" },
      { option_name: "cloudpress_version",  option_value: "2.0",          autoload: "yes" },
    ],
    users: [{
      ID:            1,
      user_login:    adminUser,
      user_pass:     passHash,
      user_email:    adminEmail,
      user_url:      siteUrl,
      user_registered: now,
      display_name:  adminUser,
      user_status:   0,
    }],
    usermeta: [
      { user_id: 1, meta_key: "wp_capabilities",    meta_value: 'a:1:{s:13:"administrator";b:1;}' },
      { user_id: 1, meta_key: "wp_user_level",      meta_value: "10" },
      { user_id: 1, meta_key: "nickname",            meta_value: adminUser },
      { user_id: 1, meta_key: "first_name",          meta_value: adminUser },
      { user_id: 1, meta_key: "last_name",           meta_value: "" },
      { user_id: 1, meta_key: "rich_editing",        meta_value: "true" },
      { user_id: 1, meta_key: "comment_shortcuts",   meta_value: "false" },
      { user_id: 1, meta_key: "admin_color",         meta_value: "fresh" },
    ],
    posts: [{
      ID:            1,
      post_author:   1,
      post_date:     now,
      post_date_gmt: now,
      post_content:  "CloudPress WordPress 호스팅에 오신 것을 환영합니다! 이 글을 삭제하거나 수정하세요.",
      post_title:    "CloudPress에 오신 것을 환영합니다!",
      post_status:   "publish",
      post_name:     "welcome",
      post_type:     "post",
      comment_status: "open",
      ping_status:   "open",
      post_modified: now,
    }],
    terms: [
      { term_id: 1, name: "미분류", slug: "uncategorized", term_group: 0 },
    ],
    term_taxonomy: [
      { term_taxonomy_id: 1, term_id: 1, taxonomy: "category", description: "", parent: 0, count: 1 },
    ],
    term_relationships: [
      { object_id: 1, term_taxonomy_id: 1, term_order: 0 },
    ],
    _created_at: now,
    _updated_at: now,
  }, null, 2);
}

// ── Astro 소스 파일 생성 ──────────────────────────────────────────────────────
// 중요: php/js/css 파일들은 /wordpress/ 폴더에 원본 그대로 유지.
// wp-transform.ts 단일 파일이 PHP→Astro 브릿지 역할을 합니다.

// ── Astro 소스 파일 생성 ──────────────────────────────────────────────────────
// 중요: Astro 정적 페이지 파일(src/pages/, src/layouts/ 등)은 레포에 없음.
// wp-transform.ts 단일 파일이 PHP를 실시간 실행하여 그 결과를 그대로 응답합니다.

function buildAstroSource({ siteName, siteUrl, siteId, adminUser, adminEmail, owner, repoName, planLimits }) {
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;
  const storageGb  = planLimits?.storage_gb ?? 5;
  const trafficGb  = planLimits?.traffic_gb ?? 100;

  return {
    // ── package.json ──────────────────────────────────────────────────────
    "package.json": JSON.stringify({
      name:    slugify(siteName) || "cloudpress-site",
      type:    "module",
      version: "1.0.0",
      engines: { node: ">=20.0.0" },
      scripts: {
        dev:   "node wp-transform.ts",
        start: "node wp-transform.ts",
      },
      dependencies: {},
    }, null, 2),

    // ── tsconfig.json ─────────────────────────────────────────────────────
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        allowJs: true,
        skipLibCheck: true,
      },
    }, null, 2),

    // ────────────────────────────────────────────────────────────────────────
    // wp-transform.ts — 핵심 단일 변환 파일
    // 사용자 접속 시 PHP 파일을 실시간으로 실행하고, 그 결과를 그대로 응답합니다.
    // GitHub 레포에는 이 파일 하나만 있고, Astro 정적 페이지 파일은 없습니다.
    // 모든 백엔드: PHP/JS 담당 | 프론트엔드: PHP 실행 결과를 그대로 응답
    // ────────────────────────────────────────────────────────────────────────
    "wp-transform.ts": `/**
 * wp-transform.ts — CloudPress WordPress PHP 실시간 실행 브릿지
 *
 * ⚠️  이 파일 하나가 모든 PHP 실행을 담당합니다.
 *     사용자가 접속하면 PHP 파일을 실시간으로 실행하고,
 *     해당 PHP 실행 결과를 그대로 응답합니다.
 *
 *     /wordpress/ 폴더의 PHP·JS·CSS 파일들은 100% 원본 그대로 유지됩니다.
 *     GitHub 레포에는 Astro 정적 페이지 파일이 없습니다.
 *
 * 동작 방식:
 *   1. 사용자 접속 → 요청 경로 파싱
 *   2. 해당 경로의 WordPress PHP 파일을 실시간 실행 (PHP_RUNNER Service Binding)
 *   3. PHP 실행 결과(HTML/JSON 등)를 그대로 응답
 *   4. 정적 자산(css/js/images)은 GitHub raw에서 직접 서빙
 */

const GH_OWNER   = '${owner}';
const GH_REPO    = '${repoName}';
const GH_BRANCH  = 'main';
const SITE_URL   = '${siteUrl}';
const SITE_ID    = '${siteId}';
const GH_RAW_BASE = 'https://raw.githubusercontent.com/${owner}/${repoName}/main';

const STATIC_EXT = /\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;

const SEC: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options':        'SAMEORIGIN',
  'Referrer-Policy':        'strict-origin-when-cross-origin',
};

function mime(p: string): string {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    css:'text/css;charset=utf-8', js:'application/javascript;charset=utf-8',
    json:'application/json;charset=utf-8', xml:'application/xml;charset=utf-8',
    svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
    gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
    woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf',
    html:'text/html;charset=utf-8', php:'text/html;charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

function fixCharset(res: Response): Response {
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('charset') || (!ct.includes('text/html') && !ct.includes('text/plain'))) return res;
  const h = new Headers(res.headers);
  h.set('Content-Type', ct.replace(/;\s*$/, '') + ';charset=utf-8');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function ghRaw(filePath: string, ttl = 300): Promise<Response | null> {
  try {
    const res = await fetch(
      \`\${GH_RAW_BASE}/\${filePath}\`,
      { headers: { 'User-Agent': 'CloudPress/1' }, cf: { cacheEverything: true, cacheTtl: ttl } as any }
    );
    return res.ok ? res : null;
  } catch { return null; }
}

function wp404(): Response {
  return new Response(\`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>404</title></head>
<body><h1>404 — 페이지를 찾을 수 없습니다</h1><a href="/">← 홈으로</a></body></html>\`,
    { status: 404, headers: { ...SEC, 'Content-Type': 'text/html;charset=utf-8' } }
  );
}

// ── PHP 실행 환경 타입 ────────────────────────────────────────────────────────
interface Env {
  PHP_RUNNER?: { fetch(req: Request): Promise<Response> };
  CACHE?:      { get(k: string, t?: string): Promise<ArrayBuffer | null>; put(k: string, v: ArrayBuffer, opts?: object): Promise<void> };
  GITHUB_TOKEN?: string;
  SITE_NAME?:    string;
}

// ── 메인 핸들러: PHP 실시간 실행 → 결과 그대로 응답 ─────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url   = new URL(req.url);
    const path  = url.pathname;
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    // 1. PHP_RUNNER Service Binding으로 PHP 실시간 실행 → 결과 그대로 응답
    if (env.PHP_RUNNER) {
      try {
        let body = '';
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await req.clone().text().catch(() => '');
        }
        // PHP 파일 경로 결정
        let phpFile = path.endsWith('.php') ? path : '/index.php';
        if (path.startsWith('/wp-admin') && !path.endsWith('.php')) {
          phpFile = path.endsWith('/') ? path + 'index.php' : path + '/index.php';
        }
        const payload = {
          phpFile,
          phpEnv: {
            REQUEST_URI:     path + url.search,
            REQUEST_METHOD:  req.method,
            HTTP_HOST:       url.host,
            SERVER_NAME:     url.host,
            HTTPS:           url.protocol === 'https:' ? 'on' : '',
            HTTP_COOKIE:     req.headers.get('Cookie')       || '',
            HTTP_USER_AGENT: req.headers.get('User-Agent')   || '',
            CONTENT_TYPE:    req.headers.get('Content-Type') || '',
            CONTENT_LENGTH:  String(body.length),
            QUERY_STRING:    url.search.replace(/^\?/, ''),
            GITHUB_OWNER:    GH_OWNER,
            GITHUB_REPO:     GH_REPO,
            GITHUB_TOKEN:    env.GITHUB_TOKEN || '',
          },
          stdin: body,
          siteConfig: { githubOwner: GH_OWNER, githubRepo: GH_REPO, ghPagesUrl: SITE_URL },
        };
        const phpRes = await env.PHP_RUNNER.fetch(
          new Request('https://php-runner/run-wordpress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        );
        // PHP 실행 결과를 그대로 응답 (status < 500이면 정상)
        if (phpRes.status < 500) return fixCharset(phpRes);
      } catch {}
    }

    // 2. 정적 자산(css/js/이미지 등): KV 캐시 → GitHub raw 서빙
    if (isGet && STATIC_EXT.test(path)) {
      // KV 캐시 확인
      if (env.CACHE) {
        const cacheKey = \`wp:\${GH_OWNER}/\${GH_REPO}:\${path}\`;
        try {
          const cached = await env.CACHE.get(cacheKey, 'arrayBuffer');
          if (cached) return new Response(cached, { headers: { 'Content-Type': mime(path), 'Cache-Control': 'public,max-age=604800,immutable', ...SEC } });
        } catch {}
      }
      // WordPress 정적 자산 → GitHub raw
      const assetPath = path.startsWith('/wp-content/') || path.startsWith('/wp-includes/') || path.startsWith('/wp-admin/')
        ? 'wordpress' + path
        : path.slice(1);
      const res = await ghRaw(assetPath, 86400);
      if (res) {
        const buf = await res.arrayBuffer();
        if (env.CACHE) {
          const cacheKey = \`wp:\${GH_OWNER}/\${GH_REPO}:\${path}\`;
          ctx.waitUntil(env.CACHE.put(cacheKey, buf, { expirationTtl: 86400 }));
        }
        return new Response(buf, { headers: { 'Content-Type': mime(path), 'Cache-Control': 'public,max-age=604800,immutable', ...SEC } });
      }
    }

    // 3. PHP_RUNNER 없는 환경에서 GitHub Pages 폴백 (사이트 URL로 프록시)
    if (isGet && SITE_URL) {
      try {
        const r = await fetch(SITE_URL + path + url.search);
        if (r.ok) return fixCharset(r);
      } catch {}
    }

    return wp404();
  },
};

// ── WordPress 타입 정의 (JS 파일 → TS 타입 래핑) ──────────────────────────────
export interface WPPost {
  ID:           number;
  post_title:   string;
  post_content: string;
  post_name:    string;
  post_status:  'publish' | 'draft' | 'private';
  post_date:    string;
  post_author:  number;
  post_type:    'post' | 'page' | string;
}

export interface WPUser {
  ID:           number;
  user_login:   string;
  user_email:   string;
  display_name: string;
  user_url:     string;
}

export interface WPOption {
  option_name:  string;
  option_value: string;
  autoload:     string;
}

export interface WPSettings {
  siteurl:         string;
  blogname:        string;
  blogdescription: string;
  admin_email:     string;
  home:            string;
  WPLANG:          string;
}

export interface WPDb {
  _version: string;
  _engine:  string;
  _site_id: string;
  options:  WPOption[];
  users:    WPUser[];
  posts:    WPPost[];
}

// ── PHP 경로 → WordPress 파일 매핑 ───────────────────────────────────────────
export const WP_PHP_ROUTES: Record<string, string> = {
  '/':            '/index.php',
  '/wp-login':    '/wp-login.php',
  '/wp-admin':    '/wp-admin/index.php',
  '/wp-admin/':   '/wp-admin/index.php',
  '/wp-json':     '/index.php',
  '/feed':        '/index.php',
  '/sitemap.xml': '/index.php',
  '/robots.txt':  '/robots.txt',
};

// ── 캐시 헤더 생성 (NGINX 스타일) ─────────────────────────────────────────────
export function buildCacheHeaders(path: string): Record<string, string> {
  if (STATIC_EXT.test(path)) {
    return { 'Cache-Control': 'public, max-age=604800, immutable', 'Vary': 'Accept-Encoding' };
  }
  if (path.endsWith('.php') || path === '/' || !path.includes('.')) {
    return { 'Cache-Control': 'public, s-maxage=60, max-age=0, must-revalidate', 'Vary': 'Accept-Encoding, Cookie', 'X-Cache-Rules': 'wp-dynamic' };
  }
  return { 'Cache-Control': 'public, max-age=300' };
}

export const SITE_URL_EXPORT = SITE_URL;
export const SITE_ID_EXPORT  = SITE_ID;
`,

    // ── public/robots.txt ─────────────────────────────────────────────────
    "public/robots.txt": `User-agent: *
Allow: /
Disallow: /wp-admin/
Disallow: /wp-includes/
Sitemap: ${siteUrl}/sitemap-index.xml
`,
  };
}

// ── GitHub Actions 워크플로우 ─────────────────────────────────────────────────

function buildGithubActionsWorkflows({ siteId, owner, repoName, siteUrl, adminUser, adminEmail }) {
  return {
    // ── 메인 배포 워크플로우 ──────────────────────────────────────────────
    ".github/workflows/deploy.yml": `name: WordPress DB 동기화 & 사이트 유지관리

on:
  push:
    branches: [main]
    paths:
      - '_db/**'
      - 'wordpress/**'
      - 'wp-transform.ts'
      - '_content/**'
      - '_config/**'
  workflow_dispatch:
    inputs:
      reason:
        description: '수동 실행 사유'
        required: false
        default: '수동 실행'

jobs:
  sync:
    name: WordPress DB 동기화
    runs-on: ubuntu-latest
    steps:
      - name: 저장소 체크아웃
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: PHP 환경 설정
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          extensions: mbstring, json, curl, pdo, pdo_sqlite
          ini-values: memory_limit=256M, max_execution_time=60
          coverage: none

      - name: _db/wordpress.db 검증 및 SQLite 변환
        run: |
          echo "🔄 wordpress.db JSON → SQLite 변환 중..."
          if [ ! -f "_db/wordpress.db" ]; then
            echo "ℹ️ _db/wordpress.db 없음 - 건너뜀"
            exit 0
          fi
          php -r "
          \$json = file_get_contents('_db/wordpress.db');
          \$data = json_decode(\$json, true);
          if (!\$data) { echo '❌ JSON 파싱 오류\n'; exit(1); }
          \$pdo = new PDO('sqlite:_db/wordpress.sqlite');
          \$pdo->exec('PRAGMA journal_mode=WAL;');
          \$pdo->exec('CREATE TABLE IF NOT EXISTS wp_options (option_id INTEGER PRIMARY KEY AUTOINCREMENT, option_name TEXT UNIQUE, option_value TEXT, autoload TEXT DEFAULT yes)');
          \$stmt = \$pdo->prepare('INSERT OR REPLACE INTO wp_options (option_name, option_value, autoload) VALUES (?,?,?)');
          foreach (\$data['options'] ?? [] as \$opt) { \$stmt->execute([\$opt['option_name'], \$opt['option_value'], \$opt['autoload'] ?? 'yes']); }
          \$pdo->exec('CREATE TABLE IF NOT EXISTS wp_users (ID INTEGER PRIMARY KEY, user_login TEXT, user_pass TEXT, user_email TEXT, user_url TEXT, user_registered TEXT, display_name TEXT, user_status INTEGER DEFAULT 0)');
          \$stmt = \$pdo->prepare('INSERT OR REPLACE INTO wp_users VALUES (?,?,?,?,?,?,?,?)');
          foreach (\$data['users'] ?? [] as \$u) { \$stmt->execute([\$u['ID'], \$u['user_login'], \$u['user_pass'], \$u['user_email'], \$u['user_url'] ?? '', \$u['user_registered'] ?? date('Y-m-d H:i:s'), \$u['display_name'], \$u['user_status'] ?? 0]); }
          \$pdo->exec('CREATE TABLE IF NOT EXISTS wp_posts (ID INTEGER PRIMARY KEY, post_author INTEGER, post_date TEXT, post_date_gmt TEXT, post_content TEXT, post_title TEXT, post_status TEXT, post_name TEXT, post_type TEXT DEFAULT post, post_modified TEXT, comment_status TEXT DEFAULT open)');
          \$stmt = \$pdo->prepare('INSERT OR REPLACE INTO wp_posts (ID,post_author,post_date,post_date_gmt,post_content,post_title,post_status,post_name,post_type,post_modified,comment_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
          foreach (\$data['posts'] ?? [] as \$p) { \$stmt->execute([\$p['ID'], \$p['post_author'] ?? 1, \$p['post_date'], \$p['post_date_gmt'] ?? \$p['post_date'], \$p['post_content'] ?? '', \$p['post_title'], \$p['post_status'] ?? 'publish', \$p['post_name'], \$p['post_type'] ?? 'post', \$p['post_modified'] ?? \$p['post_date'], \$p['comment_status'] ?? 'open']); }
          echo '✅ SQLite 변환 완료 → _db/wordpress.sqlite\n';
          "

      - name: 변경사항 커밋 (SQLite 파일)
        run: |
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.app"
          git add _db/wordpress.sqlite || true
          git diff --staged --quiet || git commit -m "sync: wordpress.db → wordpress.sqlite"
          git push || true
`,

    // ── PHP keep-alive 워크플로우 (요청사항 6) ────────────────────────────
    ".github/workflows/php-keepalive.yml": `name: WordPress PHP keep-alive (최대 20초 대기)

on:
  schedule:
    # 5분마다 실행 (GitHub Actions 최소 간격)
    - cron: '*/5 * * * *'
  workflow_dispatch:
    inputs:
      target_url:
        description: '테스트할 URL (기본: 사이트 홈)'
        required: false
        default: ''

jobs:
  keepalive:
    name: PHP Runner 워밍업
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - name: 저장소 체크아웃
        uses: actions/checkout@v4

      - name: PHP 환경 설정
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          extensions: mbstring, json, curl
          coverage: none

      - name: WordPress DB 상태 확인
        run: |
          echo "📋 _db/wordpress.db 상태 확인..."
          if [ -f "_db/wordpress.db" ]; then
            SIZE=$(wc -c < _db/wordpress.db)
            echo "✅ wordpress.db 존재 (${SIZE} bytes)"
            php -r "
            \\$data = json_decode(file_get_contents('_db/wordpress.db'), true);
            echo '  옵션 수: ' . count(\\$data['options'] ?? []) . '\\n';
            echo '  글 수: '   . count(\\$data['posts']   ?? []) . '\\n';
            echo '  사용자: '  . count(\\$data['users']   ?? []) . '\\n';
            \\$siteurl = '';
            foreach (\\$data['options'] ?? [] as \\$opt) {
              if (\\$opt['option_name'] === 'siteurl') { \\$siteurl = \\$opt['option_value']; break; }
            }
            echo '  siteurl: ' . \\$siteurl . '\\n';
            "
          else
            echo "⚠️ wordpress.db 없음"
          fi

      - name: PHP keep-alive 요청 (최대 20초 대기)
        run: |
          SITE_URL="${siteUrl}"
          if [ -n "\${{ inputs.target_url }}" ]; then
            SITE_URL="\${{ inputs.target_url }}"
          fi
          
          echo "🔄 PHP keep-alive: $SITE_URL"
          
          # 최대 20초 대기하며 3회 시도
          for i in 1 2 3; do
            echo "  시도 $i/3..."
            HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 --connect-timeout 10 "$SITE_URL" 2>/dev/null || echo "000")
            DURATION=$(curl -s -o /dev/null -w "%{time_total}" --max-time 20 --connect-timeout 10 "$SITE_URL" 2>/dev/null || echo "0")
            echo "  HTTP $HTTP_CODE (응답시간: ${DURATION}s)"
            
            if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
              echo "  ✅ PHP Runner 정상 응답"
              break
            fi
            
            [ $i -lt 3 ] && sleep 5
          done
          
          # wp-admin 확인
          echo "  🔐 wp-admin 확인..."
          WP_ADMIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$SITE_URL/wp-admin/" 2>/dev/null || echo "000")
          echo "  wp-admin HTTP: $WP_ADMIN_CODE"

      - name: 캐시 워밍업 (주요 PHP 페이지)
        run: |
          SITE_URL="${siteUrl}"
          PATHS=("/" "/wp-login.php" "/wp-json/wp/v2/posts" "/feed/")
          
          for path in "\${PATHS[@]}"; do
            CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$SITE_URL$path" 2>/dev/null || echo "000")
            echo "  $path → HTTP $CODE"
            sleep 1
          done

      - name: keep-alive 결과 기록
        run: |
          echo "✅ PHP keep-alive 완료 at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
`,

    // ── CMS 콘텐츠 업데이트 워크플로우 ──────────────────────────────────
    ".github/workflows/cms-update.yml": `name: CMS 콘텐츠 업데이트

on:
  workflow_dispatch:
    inputs:
      action:
        description: '작업 종류'
        required: true
        type: choice
        options: [rebuild, validate, purge-cache, sync-db]
        default: rebuild
      message:
        description: '변경 내용 메모'
        required: false
        default: 'CMS 콘텐츠 업데이트'

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: PHP 환경 설정
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.3'
          extensions: mbstring, json, pdo, pdo_sqlite
          coverage: none

      - name: DB 파일 검증 (PHP + JSON)
        run: |
          echo "📦 DB 파일 검사 중..."
          
          # wordpress.db JSON 검증
          if [ -f "_db/wordpress.db" ]; then
            php -r "
            \\$data = json_decode(file_get_contents('_db/wordpress.db'), true);
            if (!\\$data) { echo '❌ wordpress.db JSON 파싱 오류\\n'; exit(1); }
            echo '✅ wordpress.db (' . count(\\$data['options'] ?? []) . ' options, ' . count(\\$data['posts'] ?? []) . ' posts)\\n';
            "
          fi
          
          # 기타 JSON DB 파일 검증
          for f in _db/*.json; do
            if python3 -c "import json,sys; json.load(open('\\$f'))" 2>/dev/null; then
              echo "✅ \\$f"
            else
              echo "❌ \\$f — JSON 파싱 오류"
              exit 1
            fi
          done
          echo "모든 DB 파일 정상"

      - name: DB 동기화 트리거
        if: inputs.action == 'rebuild'
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo:  context.repo.repo,
              workflow_id: 'deploy.yml',
              ref: 'main',
              inputs: { reason: '콘텐츠 업데이트' },
            });
            console.log('✅ DB 동기화 워크플로우 트리거 완료');
`,

    // ── 플랜 모니터링 워크플로우 ──────────────────────────────────────────
    ".github/workflows/plan-monitor.yml": `name: 플랜 리소스 모니터링

on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 스토리지 사용량 측정
        run: |
          TOTAL=$(du -sb . 2>/dev/null | cut -f1)
          TOTAL_MB=$((TOTAL / 1024 / 1024))
          TOTAL_GB=$(echo "scale=2; $TOTAL_MB/1024" | bc)
          echo "storage_mb=$TOTAL_MB" >> $GITHUB_ENV
          echo "storage_gb=$TOTAL_GB" >> $GITHUB_ENV
          echo "📊 스토리지 사용량: \${TOTAL_MB}MB (\${TOTAL_GB}GB)"

      - name: 플랜 제한 확인
        run: |
          if [ -f "_config/plan.json" ]; then
            LIMIT_GB=$(python3 -c "import json; d=json.load(open('_config/plan.json')); print(d.get('storage_gb',5))")
            USED_GB=$storage_gb
            USED_PCT=$(python3 -c "print(round(float('$USED_GB')/float('$LIMIT_GB')*100,1))")
            echo "제한: \${LIMIT_GB}GB | 사용: \${USED_GB}GB | \${USED_PCT}%"
            OVER_80=$(python3 -c "print('yes' if float('$USED_GB') > float('$LIMIT_GB')*0.8 else 'no')")
            if [ "$OVER_80" = "yes" ]; then
              echo "⚠️ 스토리지 80% 초과!"
            fi
          fi

      - name: 사용량 기록
        run: |
          echo "{ \\"measured_at\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\", \\"storage_mb\\": $storage_mb }" > _config/usage.json
          git config user.name "CloudPress Bot"
          git config user.email "bot@cloudpress.app"
          git add _config/usage.json
          git diff --staged --quiet || git commit -m "chore: update usage stats"
          git push || true
`,
  };
}

// ── 레포 초기화 ──────────────────────────────────────────────────────────────

export async function initGithubPagesRepo({
  token, owner, repoName,
  siteId, siteName, siteUrl,
  adminUser, adminPass, adminEmail,
  planLimits,
  log,
}) {
  await log("📁 GitHub 레포 초기화 중 (WordPress DB + wp-transform.ts 생성)...");

  const passHash = await hashPassword(adminPass);
  const now      = new Date().toISOString();

  // ── STEP A: _db/wordpress.db 생성 (요청사항 1·4) ─────────────────────────
  await log("  [A] _db/wordpress.db 생성 중 (사이트 URL·로그인 정보 자동 설정)...");
  const wordpressDbContent = buildWordpressDb({
    siteUrl: siteUrl || getGithubPagesUrl(owner, repoName),
    siteName, adminUser, adminEmail, passHash, now, siteId,
  });
  await ghPutFile(token, owner, repoName, "_db/wordpress.db",
    wordpressDbContent, "init: _db/wordpress.db (WordPress 메인 DB)", null).catch(() => {});
  await delay(PROVISION_DELAYS.between_db_files);

  // ── STEP B: _db/ JSON 파일들 생성 ─────────────────────────────────────────
  await log("  [B] _db/ JSON 파일 생성 중...");
  const initialDb = {
    "settings.json": {
      site_name:        siteName,
      site_url:         siteUrl || getGithubPagesUrl(owner, repoName),
      site_description: "",
      admin_email:      adminEmail,
      admin_user:       adminUser,
      posts_per_page:   10,
      theme:            "twentytwentyfour",
      timezone:         "Asia/Seoul",
      language:         "ko_KR",
      created_at:       now,
      site_id:          siteId,
    },
    "users.json": [{
      id:           1,
      username:     adminUser,
      email:        adminEmail,
      password:     passHash,
      role:         "administrator",
      display_name: adminUser,
      created_at:   now,
    }],
    "posts.json":      [],
    "pages.json":      [],
    "media.json":      [],
    "categories.json": [{ id: 1, name: "미분류", slug: "uncategorized", description: "", parent: 0, count: 0 }],
    "tags.json":       [],
    "comments.json":   [],
  };

  for (const [file, data] of Object.entries(initialDb)) {
    await ghPutFile(token, owner, repoName, `_db/${file}`,
      JSON.stringify(data, null, 2), `init: _db/${file}`, null).catch(() => {});
    await delay(PROVISION_DELAYS.between_db_files);
  }
  await log("  ✅ _db/ 초기 데이터 완료");

  // ── STEP C: 환영 글 생성 ──────────────────────────────────────────────────
  const welcomeMd = `---
title: "CloudPress WordPress에 오신 것을 환영합니다!"
description: "첫 번째 글입니다."
pubDate: "${now}"
author: "${adminUser}"
slug: "welcome"
tags: []
categories: ["미분류"]
status: "publish"
---

# 환영합니다!

**CloudPress WordPress** 호스팅을 시작하셨습니다.

## 관리자 패널 접속

- 주소: \`${siteUrl || getGithubPagesUrl(owner, repoName)}/wp-admin\`
- 아이디: \`${adminUser}\`
- 위에서 설정한 비밀번호로 로그인하세요.

## 기술 구조

- **PHP 파일**: /wordpress/ 폴더에 원본 그대로 보관
- **DB**: _db/wordpress.db (JSON → GitHub Actions에서 SQLite 변환)
- **캐싱**: Cloudflare Worker + KV 스토리지 (NGINX급 속도)
- **변환**: wp-transform.ts 단일 파일 (PHP↔Astro 브릿지)
`;
  await ghPutFile(token, owner, repoName, "_content/posts/welcome.md",
    welcomeMd, "init: welcome post", null).catch(() => {});
  await delay(PROVISION_DELAYS.between_db_files);

  // posts.json에 등록
  const { data: posts, sha: postsSha } = await readJsonDb(token, owner, repoName, "posts.json");
  await writeJsonDb(token, owner, repoName, "posts.json", [...(posts || []), {
    id: 1, slug: "welcome",
    title: "CloudPress WordPress에 오신 것을 환영합니다!",
    description: "첫 번째 글입니다.",
    status: "publish", author_id: 1, author: adminUser,
    categories: ["미분류"], tags: [],
    created_at: now, updated_at: now,
    content_file: "_content/posts/welcome.md",
  }], postsSha, "init: welcome post meta");
  await delay(PROVISION_DELAYS.between_db_files);

  // ── STEP D: wp-transform.ts 및 기본 파일 생성 ──────────────────────────────
  await log("  [D] 기본 파일 생성 중 (wp-transform.ts 포함)...");
  const astroFiles = buildAstroSource({
    siteName, siteUrl: siteUrl || getGithubPagesUrl(owner, repoName),
    siteId, adminUser, adminEmail, owner, repoName, planLimits,
  });

  let fileCount = 0;
  for (const [path, content] of Object.entries(astroFiles)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    fileCount++;
    await delay(PROVISION_DELAYS.between_src_files);
    if (fileCount % 3 === 0) await log(`  📄 파일 ${fileCount}/${Object.keys(astroFiles).length}개 생성 중...`);
  }
  await log(`  ✅ ${fileCount}개 파일 생성 완료 (wp-transform.ts 포함)`);

  // ── STEP E: worker-site-mirror.js 레포에 업로드 (요청사항 3) ─────────────
  await log("  [E] worker-site-mirror.js 업로드 중 (Cloudflare Worker 소스)...");
  const workerMirrorContent = `/**
 * worker-site-mirror.js — CloudPress 사이트 Cloudflare Worker
 * 자동 생성됨 (CloudPress 호스팅 생성 시)
 * 
 * GH_OWNER:    ${owner}
 * GH_REPO:     ${repoName}
 * GH_PAGES_URL: ${siteUrl || getGithubPagesUrl(owner, repoName)}
 * SITE_ID:     ${siteId}
 *
 * 이 파일을 Cloudflare Workers에 배포하면 WordPress PHP_RUNNER와 연동됩니다.
 * wrangler.toml의 vars 섹션에 위 값들이 자동 설정됩니다.
 */

// ── 실제 worker-site-mirror.js v15 소스는 아래에 있습니다 ──────────────────
// (Cloudflare Worker 배포 시 이 파일을 사용합니다)

const GH_BRANCH  = "main";
const STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|pdf|zip|mp4|mp3|ogg|wav|webm)$/i;

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "Referrer-Policy":        "strict-origin-when-cross-origin",
};

const ghOwner = (e) => e.GH_OWNER       || "${owner}";
const ghRepo  = (e) => e.GH_REPO        || "${repoName}";
const ghToken = (e) => e.GITHUB_TOKEN   || "";
const ghPages = (e) => e.GH_PAGES_URL   || "${siteUrl || getGithubPagesUrl(owner, repoName)}";

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
    html:"text/html;charset=utf-8", php:"text/html;charset=utf-8",
  })[ext] || "application/octet-stream";
}

async function ghRaw(env, filePath, ttl = 300) {
  const o = ghOwner(env), r = ghRepo(env), t = ghToken(env);
  if (!o || !r) return null;
  try {
    const res = await fetch(
      \`https://raw.githubusercontent.com/\${o}/\${r}/\${GH_BRANCH}/\${filePath}\`,
      {
        headers: { ...(t ? { Authorization: \`Bearer \${t}\` } : {}), "User-Agent": "CloudPress/15" },
        cf: { cacheEverything: true, cacheTtl: ttl },
      }
    );
    return res.ok ? res : null;
  } catch { return null; }
}

function fixCharset(res) {
  const ct = res.headers.get("Content-Type") || "";
  if (ct.includes("charset") || (!ct.includes("text/html") && !ct.includes("text/plain"))) return res;
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Content-Type", ct.replace(/;\\s*$/, "") + ";charset=utf-8");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: newHeaders });
}

function ensureCharsetMeta(html) {
  if (/charset/i.test(html.slice(0, 2000))) return html;
  return html.replace(/<head([^>]*)>/i, '<head$1>\\n<meta charset="UTF-8">');
}

function wp404(siteTitle = "WordPress") {
  return new Response(\`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>404 — \${siteTitle}</title>
<style>body{margin:0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}
.w{text-align:center}.n{font-size:6rem;font-weight:900;color:#e2e8f0;margin:0}</style>
</head><body><div class="w"><p class="n">404</p><h2>페이지를 찾을 수 없습니다</h2>
<a href="/">← 홈으로</a></div></body></html>\`, {
    status: 404, headers: { ...SEC, "Content-Type": "text/html;charset=utf-8" },
  });
}

export default {
  async fetch(req, env, ctx) {
    const url   = new URL(req.url);
    const path  = url.pathname;
    const isGet = req.method === "GET" || req.method === "HEAD";

    // 1차: PHP Runner Service Binding
    if (env.PHP_RUNNER) {
      try {
        let body = "";
        if (req.method !== "GET" && req.method !== "HEAD") {
          body = await req.clone().text().catch(() => "");
        }
        const payload = {
          phpFile: path.endsWith(".php") ? path : "/index.php",
          phpEnv: {
            REQUEST_URI:    path + url.search,
            REQUEST_METHOD: req.method,
            HTTP_HOST:      url.host,
            SERVER_NAME:    url.host,
            HTTPS:          url.protocol === "https:" ? "on" : "",
            HTTP_COOKIE:    req.headers.get("Cookie")        || "",
            HTTP_USER_AGENT:req.headers.get("User-Agent")    || "",
            CONTENT_TYPE:   req.headers.get("Content-Type")  || "",
            CONTENT_LENGTH: String(body.length),
            QUERY_STRING:   url.search.replace(/^\\?/, ""),
            GITHUB_OWNER:   ghOwner(env),
            GITHUB_REPO:    ghRepo(env),
            GITHUB_TOKEN:   ghToken(env),
          },
          stdin: body,
          siteConfig: { githubOwner: ghOwner(env), githubRepo: ghRepo(env), ghPagesUrl: ghPages(env) },
        };
        const phpRes = await env.PHP_RUNNER.fetch(
          new Request("https://php-runner/run-wordpress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        );
        if (phpRes.status < 500) return fixCharset(phpRes);
      } catch {}
    }

    // 2차: KV 캐시
    if (isGet && STATIC_EXT.test(path)) {
      const cacheKey = \`v15:\${ghOwner(env)}/\${ghRepo(env)}:\${path}\`;
      const cached = await kvGet(env, cacheKey);
      if (cached) return new Response(cached, { headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC } });
    }

    // 3차: WordPress 정적 자산 → GitHub raw
    if (isGet && STATIC_EXT.test(path) &&
        (path.startsWith("/wp-content/") || path.startsWith("/wp-includes/") || path.startsWith("/wp-admin/"))) {
      const res = await ghRaw(env, "wordpress" + path, 86400);
      if (res) {
        const body = await res.arrayBuffer();
        const cacheKey = \`v15:\${ghOwner(env)}/\${ghRepo(env)}:\${path}\`;
        ctx.waitUntil(kvPut(env, cacheKey, body));
        return new Response(body, { headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=604800,immutable", ...SEC } });
      }
    }

    // 4차: _cache/ 정적 HTML
    if (isGet && !STATIC_EXT.test(path)) {
      let cp = "_cache" + path;
      if (cp.endsWith("/")) cp += "index.html";
      else if (!cp.includes(".")) cp += "/index.html";
      let res = await ghRaw(env, cp, 60);
      if (!res) res = await ghRaw(env, "_cache" + path + ".html", 60);
      if (res) {
        const raw  = await res.text();
        const html = ensureCharsetMeta(raw);
        return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public,max-age=60,s-maxage=300", ...SEC } });
      }
    }

    // 5차: 일반 정적 자산
    if (isGet && STATIC_EXT.test(path)) {
      let res = await ghRaw(env, "wordpress" + path, 3600);
      if (!res) res = await ghRaw(env, path.slice(1), 3600);
      if (res) {
        const body = await res.arrayBuffer();
        return new Response(body, { headers: { "Content-Type": mime(path), "Cache-Control": "public,max-age=3600", ...SEC } });
      }
    }

    // 6차: GitHub Pages 폴백
    const pagesBase = ghPages(env);
    if (pagesBase) {
      try {
        const r = await fetch(pagesBase + path + url.search);
        if (r.ok) return fixCharset(r);
      } catch {}
    }

    return wp404(env.SITE_NAME || "${siteName}");
  },
};
`;
  await ghPutFile(token, owner, repoName, "worker-site-mirror.js",
    workerMirrorContent, "init: worker-site-mirror.js (Cloudflare Worker 소스)", null).catch(() => {});
  await delay(PROVISION_DELAYS.between_src_files);
  await log("  ✅ worker-site-mirror.js 업로드 완료");

  // ── STEP F: GitHub Actions 워크플로우 설정 ────────────────────────────────
  await log("  [F] GitHub Actions 워크플로우 설정 중 (php-keepalive.yml 포함)...");
  const workflows = buildGithubActionsWorkflows({
    siteId, owner, repoName,
    siteUrl: siteUrl || getGithubPagesUrl(owner, repoName),
    adminUser, adminEmail,
  });

  for (const [path, content] of Object.entries(workflows)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    await delay(PROVISION_DELAYS.between_workflow_files);
  }
  await log("  ✅ GitHub Actions 워크플로우 설정 완료 (php-keepalive.yml 포함)");

  // ── STEP G: _config/plan.json ─────────────────────────────────────────────
  await ghPutFile(token, owner, repoName, "_config/plan.json",
    JSON.stringify({
      storage_gb:    planLimits?.storage_gb ?? 5,
      traffic_gb:    planLimits?.traffic_gb ?? 100,
      custom_domain: planLimits?.custom_domain ?? false,
      backups:       planLimits?.backups ?? false,
      created_at:    now,
      site_id:       siteId,
    }, null, 2),
    "init: _config/plan.json", null).catch(() => {});
  await delay(PROVISION_DELAYS.between_db_files);

  // ── STEP H: README ────────────────────────────────────────────────────────
  const readmeContent = `# ${siteName}

CloudPress WordPress 호스팅으로 생성된 사이트입니다.

## 구조

\`\`\`
/_db/
  wordpress.db    ← WordPress 메인 DB (JSON → GitHub Actions에서 SQLite 변환)
  settings.json   ← 사이트 설정
  users.json      ← 사용자 (PBKDF2 해시)
  posts.json      ← 글 목록
/_content/posts/  ← 글 본문 (Markdown)
/_config/         ← 플랜·사용량 설정
/wordpress/       ← WordPress PHP 파일 (원본 그대로)
/wp-transform.ts  ← PHP↔Astro 단일 변환 파일
/worker-site-mirror.js ← Cloudflare Worker 소스
/public/          ← 공개 정적 파일
\`\`\`

## 관리자 접속

- URL: \`${siteUrl || getGithubPagesUrl(owner, repoName)}/wp-admin\`
- ID: \`${adminUser}\`

## 배포

\`main\` 브랜치 push → GitHub Actions:
1. PHP 환경 설정 (shivammathur/setup-php@v2)
2. wordpress.db → SQLite 변환
3. Astro 빌드
4. GitHub Pages 배포

## keep-alive

php-keepalive.yml: 5분마다 실행, 최대 20초 대기
`;
  await ghPutFile(token, owner, repoName, "README.md",
    readmeContent, "init: README.md", null).catch(() => {});

  // ── STEP I: GitHub Pages 활성화 ──────────────────────────────────────────
  await log("  [I] GitHub Pages 활성화 중...");
  await delay(2000);

  const pagesRes = await ghReq("POST", `/repos/${owner}/${repoName}/pages`, token, {
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => ({ ok: false }));

  if (pagesRes.ok || pagesRes.data?.url) {
    await log("  ✅ GitHub Pages 활성화 완료");
  } else {
    await log("  ℹ️ GitHub Pages는 첫 빌드 완료 후 자동 활성화됩니다", "warning");
  }

  await delay(PROVISION_DELAYS.after_pages_activate);

  // ── STEP J: 첫 빌드 트리거 ───────────────────────────────────────────────
  await log("  [J] 첫 빌드 트리거 중 (php-keepalive.yml도 함께 트리거)...");
  const triggerRes = await ghReq(
    "POST",
    `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token,
    { ref: "main", inputs: { reason: "초기 빌드" } }
  ).catch(() => ({ ok: false }));

  if (triggerRes.ok || triggerRes.status === 204) {
    await log("  🚀 첫 빌드 트리거 완료");
  } else {
    await log("  ℹ️ 첫 빌드는 다음 push 시 자동 실행됩니다", "warning");
  }

  // php-keepalive 첫 실행 트리거
  await ghReq(
    "POST",
    `/repos/${owner}/${repoName}/actions/workflows/php-keepalive.yml/dispatches`,
    token,
    { ref: "main" }
  ).catch(() => {});

  await delay(PROVISION_DELAYS.after_astro_trigger);
  await log("  🔄 빌드 실행 중... (GitHub Actions 런너 할당 완료)");
}

// ── Cloudflare DNS 설정 ────────────────────────────────────────────────────

async function cfReq(method, path, apiKey, email, body) {
  const headers = {
    "X-Auth-Key":   apiKey,
    "X-Auth-Email": email,
    "Content-Type": "application/json",
  };
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function getRootDomain(domain) {
  const parts = domain.split(".");
  const twoPartTLDs = ["co.uk","com.au","co.jp","co.kr","com.br","co.nz","org.uk","net.au","co.za"];
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join(".");
    if (twoPartTLDs.includes(lastTwo)) return parts.slice(-3).join(".");
  }
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

export async function setupGithubPagesDns({ cfApiKey, cfEmail, domain, owner, repoName }) {
  if (!cfApiKey || !cfEmail) return [];

  const zoneRes = await cfReq(
    "GET",
    `/zones?name=${encodeURIComponent(getRootDomain(domain))}&status=active`,
    cfApiKey, cfEmail
  );
  const zoneId = zoneRes.result?.[0]?.id;
  if (!zoneId) return [];

  const results = [];

  const existingA   = await cfReq("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(getRootDomain(domain))}`, cfApiKey, cfEmail);
  const existingIps = (existingA.result || []).map(r => r.content);
  for (const ip of GITHUB_PAGES_IPV4) {
    if (!existingIps.includes(ip)) {
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, cfApiKey, cfEmail, {
        type: "A", name: getRootDomain(domain), content: ip, ttl: 3600, proxied: false,
      });
      results.push({ type: "A", ip, ok: r.success });
    } else {
      results.push({ type: "A", ip, ok: true, existed: true });
    }
  }

  const existingAAAA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(getRootDomain(domain))}`, cfApiKey, cfEmail);
  const existingIpv6 = (existingAAAA.result || []).map(r => r.content);
  for (const ip of GITHUB_PAGES_IPV6) {
    if (!existingIpv6.includes(ip)) {
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, cfApiKey, cfEmail, {
        type: "AAAA", name: getRootDomain(domain), content: ip, ttl: 3600, proxied: false,
      });
      results.push({ type: "AAAA", ip, ok: r.success });
    }
  }

  if (!domain.startsWith("www.")) {
    const existingCname = await cfReq("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(`www.${getRootDomain(domain)}`)}`, cfApiKey, cfEmail);
    if (!(existingCname.result?.length > 0)) {
      const ghHost = `${owner}.github.io`;
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, cfApiKey, cfEmail, {
        type: "CNAME", name: `www.${getRootDomain(domain)}`, content: ghHost, ttl: 3600, proxied: false,
      });
      results.push({ type: "CNAME", name: `www.${getRootDomain(domain)}`, content: ghHost, ok: r.success });
    }
  }

  return results;
}

// GitHub Pages 커스텀 도메인 설정 + WordPress DB URL 자동 갱신 (요청사항 4)
export async function configureGithubPagesCustomDomainWithToken({ token, owner, repoName, domain, siteId }) {
  const domainUrl = `https://${domain}`;

  // CNAME 파일 업데이트
  const existing = await ghGetFile(token, owner, repoName, "public/CNAME").catch(() => null);
  await ghPutFile(token, owner, repoName, "public/CNAME", domain,
    `chore: set custom domain ${domain}`, existing?.sha || null).catch(() => {});

  // GitHub Pages API에 커스텀 도메인 등록
  await ghReq("PUT", `/repos/${owner}/${repoName}/pages`, token, {
    cname: domain,
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => {});

  // ── WordPress DB의 siteurl·home 자동 갱신 (요청사항 4) ──────────────────
  const dbFile = await ghGetFile(token, owner, repoName, "_db/wordpress.db").catch(() => null);
  if (dbFile) {
    try {
      const dbData = JSON.parse(dbFile.content);
      let updated = false;
      for (const opt of dbData.options || []) {
        if (opt.option_name === "siteurl" || opt.option_name === "home") {
          opt.option_value = domainUrl;
          updated = true;
        }
      }
      dbData._updated_at = new Date().toISOString();
      if (updated) {
        await ghPutFile(token, owner, repoName, "_db/wordpress.db",
          JSON.stringify(dbData, null, 2),
          `chore: update siteurl/home → ${domainUrl}`,
          dbFile.sha).catch(() => {});
      }
    } catch {}
  }

  // settings.json의 site_url도 갱신
  const settingsFile = await ghGetFile(token, owner, repoName, "_db/settings.json").catch(() => null);
  if (settingsFile) {
    try {
      const settings = JSON.parse(settingsFile.content);
      settings.site_url = domainUrl;
      settings.updated_at = new Date().toISOString();
      await ghPutFile(token, owner, repoName, "_db/settings.json",
        JSON.stringify(settings, null, 2),
        `chore: update site_url → ${domainUrl}`,
        settingsFile.sha).catch(() => {});
    } catch {}
  }



  // 재빌드 트리거
  await ghReq("POST", `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token, { ref: "main", inputs: { reason: `커스텀 도메인 설정: ${domain}` } }).catch(() => {});
}

// ── 호스팅 생성 메인 함수 ────────────────────────────────────────────────────

export async function provisionGithubPagesHosting({
  env, siteId, siteName,
  adminUser, adminPass, adminEmail,
  plan, planLimits,
  log,
}) {
  const token = await pickGithubToken(env);
  if (!token) {
    await log("GitHub 토큰 없음 — 관리자 설정에서 GitHub 토큰을 추가해주세요", "error");
    return null;
  }

  const shortId  = siteId.replace(/-/g, "").slice(0, 8);
  const repoName = `cp-${shortId}`;

  const { ok: meOk, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log("GitHub 토큰 인증 실패 — 유효한 토큰인지 확인해주세요", "error");
    return null;
  }
  const owner = meData.login;

  await log(`👤 GitHub 계정: ${owner}`);
  await log(`📦 [1/6] 레포 생성 중: ${owner}/${repoName}`);

  const { ok: repoOk, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: `CloudPress WordPress 호스팅: ${siteName} (Site ID: ${siteId})`,
    private:     false,
    auto_init:   true,
    has_issues:  false,
    has_wiki:    false,
    has_projects: false,
  });

  if (!repoOk && repoData?.errors?.[0]?.message?.includes("already exists")) {
    await log(`⚠️ 레포 ${repoName} 이미 존재 — 기존 레포 사용`, "warning");
  } else if (!repoOk) {
    await log(`❌ 레포 생성 실패: ${repoData?.message || JSON.stringify(repoData)}`, "error");
    return null;
  } else {
    await log(`✅ [1/6] 레포 생성 완료: ${owner}/${repoName}`);
  }

  const pagesUrl = getGithubPagesUrl(owner, repoName);

  await delay(PROVISION_DELAYS.after_repo_create);

  await log(`📝 [2/6] WordPress DB + Astro 소스 초기화 중...`);
  await log(`⚡ [3/6] GitHub Actions 워크플로우 설정 중 (php-keepalive.yml 포함)...`);

  await initGithubPagesRepo({
    token, owner, repoName,
    siteId, siteName,
    siteUrl: pagesUrl,
    adminUser, adminPass, adminEmail,
    planLimits,
    log,
  });

  return {
    owner,
    repoName,
    token,
    pagesUrl,
    primaryDomain: null,
  };
}
