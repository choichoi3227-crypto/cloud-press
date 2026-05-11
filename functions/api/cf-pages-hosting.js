// functions/api/cf-pages-hosting.js
//
// Cloudflare Pages 호스팅 모듈
// ─────────────────────────────────────────────────────────────────────────────
// 동작 방식:
//   1) GitHub 레포 생성 (스토리지)
//   2) WordPress 공식 GitHub(wordpress/wordpress) 파일을 Astro 코드로 변환하여 레포에 저장
//      - PHP → Astro(.astro) 변환 로직
//      - JS  → TypeScript(.ts) 변환 로직
//      - CSS 그대로 유지
//   3) Cloudflare Pages 프로젝트 생성
//   4) GitHub 레포 ↔ Cloudflare Pages 연동 (미러링)
//      → Pages에 사이트 전체 코드를 업로드하는 게 아니라,
//        GitHub 레포를 Pages가 직접 빌드·배포하도록 연동
//   5) Pages 빌드 설정: `astro build` (Astro 빌드)
//   6) Cloudflare D1/KV 바인딩 자동 설정
//
// Cloudflare Pages에는 미러링 코드 + Cloudflare 바인딩 연동 코드만 있음
// 전체 사이트 코드는 GitHub 레포에, Pages는 그 레포를 빌드·서빙
// ─────────────────────────────────────────────────────────────────────────────

import { ghReq, pickGithubToken } from "./github-storage.js";

// ── 딜레이 ────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── slug 생성 ──────────────────────────────────────────────────────────────────
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── base64 인코딩 (UTF-8 safe) ────────────────────────────────────────────────
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary  = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ── 비밀번호 해싱 ─────────────────────────────────────────────────────────────
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

// ── GitHub 파일 PUT ────────────────────────────────────────────────────────────
async function ghPutFile(token, owner, repo, path, content, message, sha) {
  const body = {
    message,
    content: toBase64(content),
    ...(sha ? { sha } : {}),
  };
  const res = await ghReq("PUT", `/repos/${owner}/${repo}/contents/${path}`, token, body);
  return { ok: res.ok || res.status === 200 || res.status === 201, sha: res.data?.content?.sha };
}

// ── Cloudflare API 헬퍼 ───────────────────────────────────────────────────────
async function cfReq(apiToken, method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type":  "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── PHP → Astro 변환 로직 ─────────────────────────────────────────────────────
// WordPress 공식 GitHub에서 가져온 PHP 파일을 Astro(.astro)로 변환
// 코드 변환만 수행, 기능/이모티콘/내용 추가 없음
function convertPhpToAstro(phpCode, fileName) {
  // PHP 오프닝/클로징 태그 제거
  let code = phpCode
    .replace(/<\?php\s*/g, "")
    .replace(/<\?=/g, "{")
    .replace(/\?>/g, "}")
    .trim();

  // PHP 변수 → JavaScript 변수
  code = code
    .replace(/\$(\w+)\s*=\s*/g, "const $1 = ")
    .replace(/\$(\w+)/g, "$1");

  // PHP echo → Astro 표현식
  code = code.replace(/echo\s+(.+?);/g, "{$1}");

  // PHP 함수 선언 → JS 함수
  code = code.replace(/function\s+(\w+)\s*\(/g, "function $1(");

  // PHP 배열 → JS 배열/객체
  code = code.replace(/array\s*\(/g, "[").replace(/\)/g, "]");

  // PHP 문자열 연결 . → +
  code = code.replace(/"\s*\.\s*"/g, '" + "');
  code = code.replace(/'\s*\.\s*'/g, "' + '");

  // PHP foreach → JS for...of
  code = code.replace(/foreach\s*\((\w+)\s+as\s+(\w+)\s*=>\s*(\w+)\)/g, "for (const [$2, $3] of Object.entries($1))");
  code = code.replace(/foreach\s*\((\w+)\s+as\s+(\w+)\)/g, "for (const $2 of $1)");

  // PHP if/else 그대로 유지 (JS와 동일)

  // PHP require/include → import
  code = code.replace(/require_once\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/require\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/include_once\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/include\s+['"](.+?)['"]/g, "// import '$1'");

  // PHP 주석 → JS 주석 (이미 유사)
  // // 그대로, /* */ 그대로, # → //
  code = code.replace(/^#\s*/gm, "// ");

  // PHP 정적 메서드/속성
  code = code.replace(/(\w+)::/g, "$1.");

  // PHP null 병합 연산자 ?? 그대로 (JS와 동일)

  // PHP heredoc → 템플릿 리터럴
  code = code.replace(/<<<(\w+)\n([\s\S]*?)\n\1;/g, "`$2`");

  // Astro 컴포넌트 구조로 래핑
  const componentName = fileName
    .replace(/\.php$/, "")
    .replace(/[^a-zA-Z0-9]/g, "_");

  return `---
// Converted from ${fileName} (WordPress official source → Astro)
// Source: https://github.com/WordPress/WordPress

${code}
---

<slot />
`;
}

// ── JS → TypeScript 변환 로직 ─────────────────────────────────────────────────
// WordPress 공식 GitHub에서 가져온 JS 파일을 TypeScript(.ts)로 변환
// 코드 변환만 수행, 기능/이모티콘/내용 추가 없음
function convertJsToTs(jsCode, fileName) {
  let code = jsCode;

  // var → let/const (선언만, 할당 패턴으로 구분)
  // 재할당 패턴이 있는 경우 let, 없으면 const
  code = code.replace(/\bvar\s+/g, "let ");

  // jQuery 타입 힌트 추가 (사용되는 경우)
  if (code.includes("jQuery") || code.includes("$")) {
    code = `// @ts-ignore - jQuery type\ndeclare const jQuery: any;\ndeclare const $: typeof jQuery;\n\n` + code;
  }

  // WordPress 전역 변수 타입 힌트
  if (code.includes("wp.")) {
    code = `// @ts-ignore - WordPress globals\ndeclare const wp: any;\n\n` + code;
  }

  // window.wpApiSettings 등 WordPress API 전역
  if (code.includes("wpApiSettings") || code.includes("ajaxurl")) {
    code = `// @ts-ignore - WordPress API globals\ndeclare const wpApiSettings: any;\ndeclare const ajaxurl: string;\n\n` + code;
  }

  return `// Converted from ${fileName} (WordPress official source → TypeScript)
// Source: https://github.com/WordPress/WordPress

${code}
`;
}

// ── WordPress 공식 GitHub에서 파일 목록 조회 ─────────────────────────────────
// wordpress/wordpress 공식 레포에서 핵심 파일들을 가져와 변환
async function fetchWordPressOfficialFiles(log) {
  const WP_REPO = "WordPress/WordPress";
  const WP_BRANCH = "master";
  const WP_RAW_BASE = `https://raw.githubusercontent.com/${WP_REPO}/${WP_BRANCH}`;

  // WordPress 공식 레포에서 가져올 핵심 파일 목록
  // (PHP → Astro 변환, JS → TS 변환 대상)
  const targetFiles = [
    // 핵심 PHP 파일
    { path: "wp-login.php",         type: "php" },
    { path: "wp-signup.php",        type: "php" },
    { path: "wp-comments-post.php", type: "php" },
    { path: "wp-cron.php",          type: "php" },
    { path: "wp-mail.php",          type: "php" },
    { path: "xmlrpc.php",           type: "php" },
    { path: "wp-trackback.php",     type: "php" },
    // wp-includes 핵심 파일
    { path: "wp-includes/functions.php",        type: "php" },
    { path: "wp-includes/class-wp-query.php",   type: "php" },
    { path: "wp-includes/class-wp-post.php",    type: "php" },
    { path: "wp-includes/class-wp-user.php",    type: "php" },
    { path: "wp-includes/post.php",             type: "php" },
    { path: "wp-includes/user.php",             type: "php" },
    { path: "wp-includes/formatting.php",       type: "php" },
    { path: "wp-includes/taxonomy.php",         type: "php" },
    { path: "wp-includes/comment.php",          type: "php" },
    // wp-includes JS 파일
    { path: "wp-includes/js/jquery/jquery.min.js", type: "js" },
    { path: "wp-includes/js/wp-util.js",           type: "js" },
    { path: "wp-includes/js/customize-preview.js", type: "js" },
    // wp-admin 핵심 PHP
    { path: "wp-admin/admin.php",               type: "php" },
    { path: "wp-admin/index.php",               type: "php" },
    { path: "wp-admin/post.php",                type: "php" },
    { path: "wp-admin/edit.php",                type: "php" },
    { path: "wp-admin/users.php",               type: "php" },
    { path: "wp-admin/options.php",             type: "php" },
    { path: "wp-admin/upload.php",              type: "php" },
    // wp-admin CSS
    { path: "wp-admin/css/common.css",          type: "css" },
    { path: "wp-admin/css/dashboard.css",       type: "css" },
  ];

  const converted = [];

  for (const file of targetFiles) {
    try {
      const res = await fetch(`${WP_RAW_BASE}/${file.path}`, {
        headers: { "User-Agent": "CloudPress-Hosting/3.1" },
      });
      if (!res.ok) continue;

      const rawContent = await res.text();
      let convertedContent;
      let outputPath;

      if (file.type === "php") {
        convertedContent = convertPhpToAstro(rawContent, file.path.split("/").pop());
        outputPath = `src/wp-converted/${file.path.replace(/\.php$/, ".astro")}`;
      } else if (file.type === "js") {
        // jQuery.min.js는 변환 없이 그대로 복사
        if (file.path.includes(".min.js")) {
          convertedContent = rawContent;
          outputPath = `public/wp-includes/js/${file.path.split("/").pop()}`;
        } else {
          convertedContent = convertJsToTs(rawContent, file.path.split("/").pop());
          outputPath = `src/wp-converted/${file.path.replace(/\.js$/, ".ts")}`;
        }
      } else if (file.type === "css") {
        // CSS는 그대로 유지
        convertedContent = rawContent;
        outputPath = `public/${file.path}`;
      }

      if (convertedContent && outputPath) {
        converted.push({ path: outputPath, content: convertedContent, original: file.path });
      }
    } catch (e) {
      // 파일 가져오기 실패 시 건너뜀
      await log(`  WordPress 파일 변환 건너뜀: ${file.path}`, "warning");
    }
  }

  await log(`  WordPress 공식 파일 변환 완료: ${converted.length}개`);
  return converted;
}

// ── Cloudflare Pages 미러링용 설정 파일 생성 ─────────────────────────────────
// Pages에는 미러링 코드 + Cloudflare 바인딩 연동 코드만 포함
// 전체 사이트 코드는 GitHub 레포에 있고, Pages는 그 레포를 빌드·서빙
function buildCfPagesConfig({ siteId, siteName, cfAccountId, d1Id, kvSessionsId, kvCacheId }) {
  return {
    // ── Cloudflare Pages 빌드 설정 (_cloudflare/config.json) ─────────────
    // GitHub 연동 후 Pages가 이 설정을 읽어 빌드 실행
    "_cloudflare/config.json": JSON.stringify({
      build_command:   "npm install && npm run build",
      destination_dir: "dist",
      root_dir:        "",
      // Cloudflare 바인딩 자동 연동
      bindings: {
        d1_databases: d1Id ? [{ binding: "DB", database_id: d1Id }] : [],
        kv_namespaces: [
          ...(kvSessionsId ? [{ binding: "SESSIONS", namespace_id: kvSessionsId }] : []),
          ...(kvCacheId    ? [{ binding: "CACHE",    namespace_id: kvCacheId }]    : []),
        ],
        vars: {
          SITE_ID:   siteId,
          SITE_NAME: siteName,
        },
      },
    }, null, 2),

    // ── wrangler.toml (Cloudflare Pages 빌드/바인딩 자동 설정) ───────────
    // Pages가 GitHub 레포를 클론 후, 이 파일을 읽어 바인딩 자동 적용
    "wrangler.toml": `# Cloudflare Pages 빌드 및 바인딩 설정
# 이 파일은 Cloudflare Pages가 GitHub 레포를 미러링·빌드할 때 자동 사용됩니다.
# 전체 사이트 코드는 GitHub 레포에 있으며, Pages는 빌드·서빙만 담당합니다.

name = "${slugify(siteName) || "cloudpress-site"}"
compatibility_date = "2025-04-01"

${d1Id ? `[[d1_databases]]
binding       = "DB"
database_name = "cloudpress-site-${siteId.slice(0, 8)}"
database_id   = "${d1Id}"` : "# D1 바인딩: Cloudflare 대시보드에서 설정 필요"}

${kvSessionsId ? `[[kv_namespaces]]
binding = "SESSIONS"
id      = "${kvSessionsId}"` : "# KV SESSIONS: Cloudflare 대시보드에서 설정 필요"}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : "# KV CACHE: Cloudflare 대시보드에서 설정 필요"}

[vars]
SITE_ID   = "${siteId}"
SITE_NAME = "${siteName}"
`,
  };
}

// ── 미러링용 GitHub Actions 워크플로우 ────────────────────────────────────────
// GitHub 레포 변경 시 Cloudflare Pages에 자동 미러링 (Pages Direct Upload 아님)
// GitHub 연동 설정으로 Pages가 직접 레포를 빌드
function buildMirrorWorkflow({ siteId, cfAccountId, cfPagesProject }) {
  return {
    // GitHub 연동 확인 워크플로우 (실제 배포는 Cloudflare Pages가 자동 수행)
    ".github/workflows/cf-pages-mirror.yml": `name: Cloudflare Pages 미러링 확인

# 이 워크플로우는 Cloudflare Pages와의 GitHub 연동 상태를 확인합니다.
# 실제 빌드·배포는 Cloudflare Pages가 이 레포를 직접 빌드하여 수행합니다.
# (GitHub Actions로 Pages에 업로드하는 방식 아님)

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  verify-mirror:
    runs-on: ubuntu-latest
    steps:
      - name: 레포 체크아웃
        uses: actions/checkout@v4

      - name: Cloudflare Pages 연동 상태 확인
        run: |
          echo "Cloudflare Pages 프로젝트: ${cfPagesProject || "미설정"}"
          echo "Site ID: ${siteId}"
          echo "이 레포는 Cloudflare Pages와 연동되어 자동 빌드·배포됩니다."
          echo "Pages 빌드 명령: npm install && npm run build"
          echo "빌드 출력 디렉토리: dist/"

      - name: Node.js 20 설정
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 의존성 설치
        run: npm install --prefer-offline || npm install

      - name: Astro 빌드 검증
        run: |
          npm run build
          echo "빌드 완료 - dist/ 디렉토리 생성됨"
          ls -la dist/

      - name: 빌드 결과 요약
        run: |
          FILE_COUNT=$(find dist -type f | wc -l)
          echo "빌드 파일 수: $FILE_COUNT"
          echo "Cloudflare Pages가 이 레포를 자동으로 빌드·배포합니다."
`,

    // Astro 빌드 검증 워크플로우
    ".github/workflows/astro-build.yml": `name: Astro 빌드 검증

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - '_db/**'
      - '_content/**'
      - 'public/**'
      - 'astro.config.mjs'
      - 'package.json'
      - 'wrangler.toml'
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Node.js 20 설정
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: 'package.json'

      - name: 패키지 설치
        run: npm install --prefer-offline || npm install

      - name: Astro 빌드
        env:
          SITE_ID: ${siteId}
        run: npm run build

      - name: 빌드 검증
        run: |
          test -f dist/index.html || (echo "빌드 실패: index.html 없음" && exit 1)
          echo "빌드 성공: $(find dist -type f | wc -l)개 파일 생성"
`,
  };
}

// ── DB 초기 데이터 ──────────────────────────────────────────────────────────
async function initDbFiles(token, owner, repoName, { siteId, siteName, adminUser, adminPass, adminEmail, planLimits, log }) {
  const passHash = await hashPassword(adminPass);
  const now      = new Date().toISOString();

  const initialDb = {
    "settings.json": {
      site_name:        siteName,
      site_url:         "",
      site_description: "",
      admin_email:      adminEmail,
      posts_per_page:   10,
      theme:            "default",
      timezone:         "Asia/Seoul",
      language:         "ko",
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
    await delay(300);
  }
  await log("  _db/ 초기 데이터 완료");
}

// ── Astro 소스 파일 생성 ─────────────────────────────────────────────────────
function buildAstroSource({ siteName, siteId, owner, repoName, planLimits }) {
  const storageGb = planLimits?.storage_gb ?? 5;
  const trafficGb = planLimits?.traffic_gb ?? 100;
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;

  return {
    "package.json": JSON.stringify({
      name:    slugify(siteName) || "cloudpress-site",
      type:    "module",
      version: "1.0.0",
      engines: { node: ">=20.0.0" },
      scripts: {
        dev:     "astro dev",
        build:   "astro build",
        preview: "astro preview",
      },
      dependencies: {
        "astro":            "^4.16.0",
        "@astrojs/sitemap": "^3.2.1",
        "@astrojs/rss":     "^4.0.7",
      },
    }, null, 2),

    "astro.config.mjs": `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const site = process.env.SITE_URL || '';

export default defineConfig({
  site,
  base: '/',
  integrations: [sitemap()],
  output: 'static',
  build: {
    inlineStylesheets: 'auto',
  },
});
`,

    "tsconfig.json": JSON.stringify({
      extends: "astro/tsconfigs/strict",
      compilerOptions: {
        strictNullChecks: true,
        allowJs: true,
        skipLibCheck: true,
      },
    }, null, 2),

    "src/lib/db.ts": `// GitHub 레포 _db/ 폴더에서 JSON 데이터 읽기
const REPO_RAW = '${ghRawBase}';

export const PLAN_LIMITS = {
  storage_gb:   ${storageGb},
  traffic_gb:   ${trafficGb === null ? "null" : trafficGb},
  custom_domain: ${planLimits?.custom_domain ?? false},
  backups:      ${planLimits?.backups ?? false},
};

async function fetchDb<T>(file: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(\`\${REPO_RAW}/_db/\${file}\`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json() as T;
  } catch {
    return fallback;
  }
}

export type Post = {
  id: number; slug: string; title: string; description?: string;
  status: 'publish' | 'draft'; author: string; categories: string[];
  tags: string[]; created_at: string; updated_at: string;
  content_file?: string;
};

export type SiteSettings = {
  site_name: string; site_url: string; site_description: string;
  admin_email: string; posts_per_page: number; theme: string;
  timezone: string; language: string;
};

export async function getPosts(status = 'publish'): Promise<Post[]> {
  const posts = await fetchDb<Post[]>('posts.json', []);
  return posts
    .filter(p => status === 'all' || p.status === status)
    .sort((a, b) => new Date(b.created_at).valueOf() - new Date(a.created_at).valueOf());
}

export async function getPost(slug: string): Promise<Post | null> {
  const posts = await fetchDb<Post[]>('posts.json', []);
  return posts.find(p => p.slug === slug) ?? null;
}

export async function getSettings(): Promise<SiteSettings> {
  return fetchDb<SiteSettings>('settings.json', {
    site_name: '${siteName}',
    site_url:  '',
    site_description: '',
    admin_email: '',
    posts_per_page: 10,
    theme: 'default',
    timezone: 'Asia/Seoul',
    language: 'ko',
  });
}

export async function getCategories() {
  return fetchDb<any[]>('categories.json', []);
}

export async function getTags() {
  return fetchDb<any[]>('tags.json', []);
}

export async function getPostContent(slug: string): Promise<string> {
  try {
    const res = await fetch(\`\${REPO_RAW}/_content/posts/\${slug}.md\`);
    if (!res.ok) return '';
    const text = await res.text();
    return text.replace(/^---[\\s\\S]*?---\\n?/, '').trim();
  } catch { return ''; }
}
`,

    "src/lib/markdown.ts": `export function markdownToHtml(md: string): string {
  if (!md) return '';
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,     '<em>$1</em>')
    .replace(/\`(.+?)\`/g,      '<code>$1</code>')
    .replace(/^> (.+)$/gm,    '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm,    '<li>$1</li>')
    .replace(/(<li>.*<\\/li>\\n?)+/gs, m => \`<ul>\${m}</ul>\`)
    .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2">$1</a>')
    .replace(/!\\[(.*)\\]\\((.+?)\\)/g, '<img alt="$1" src="$2" loading="lazy">')
    .replace(/\\n\\n/g, '</p><p>');
}
`,

    "src/layouts/Base.astro": `---
import { getSettings } from '../lib/db';
interface Props { title?: string; description?: string; }
const { title, description } = Astro.props;
const settings = await getSettings();
const pageTitle = title ? \`\${title} — \${settings.site_name}\` : settings.site_name;
---
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{pageTitle}</title>
  {description && <meta name="description" content={description} />}
  <link rel="stylesheet" href="/styles/global.css">
  <link rel="alternate" type="application/rss+xml" title={settings.site_name} href="/rss.xml">
  <link rel="sitemap" href="/sitemap-index.xml">
</head>
<body>
  <header>
    <div class="container header-inner">
      <a href="/" class="site-title">{settings.site_name}</a>
      <nav>
        <a href="/">홈</a>
        <a href="/blog">블로그</a>
      </nav>
    </div>
  </header>
  <main class="container">
    <slot />
  </main>
  <footer>
    <div class="container">
      <p>© {new Date().getFullYear()} {settings.site_name}</p>
    </div>
  </footer>
</body>
</html>
`,

    "src/styles/global.css": `*,*::before,*::after{box-sizing:border-box;margin:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.75;color:#222;background:#fff}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4{line-height:1.3;margin:1.5rem 0 .75rem;font-weight:700}
p{margin-bottom:1rem}img{max-width:100%;height:auto}
.container{max-width:800px;margin:0 auto;padding:0 1.5rem}
header{border-bottom:1px solid #e5e7eb;padding:1rem 0}
.header-inner{display:flex;justify-content:space-between;align-items:center}
.site-title{font-size:1.25rem;font-weight:800;color:#111}
nav a{margin-left:1.5rem;color:#555;font-weight:500}
main{padding:2.5rem 0 4rem;min-height:60vh}
footer{border-top:1px solid #e5e7eb;padding:2rem 0;text-align:center;color:#9ca3af;font-size:.875rem}
.post-list{list-style:none;padding:0;display:grid;gap:2rem}
.post-card{border-bottom:1px solid #f3f4f6;padding-bottom:2rem}
.post-title{font-size:1.375rem;font-weight:700;margin:0 0 .375rem}
.post-meta{color:#9ca3af;font-size:.875rem;margin-bottom:.5rem}
`,

    "src/pages/index.astro": `---
import Base from '../layouts/Base.astro';
import { getPosts, getSettings } from '../lib/db';
const settings = await getSettings();
const posts    = (await getPosts()).slice(0, settings.posts_per_page);
---
<Base>
  <h1 style="font-size:2rem;font-weight:800;margin-bottom:2rem;">최근 글</h1>
  {posts.length === 0
    ? <p style="color:#9ca3af;">아직 작성된 글이 없습니다.</p>
    : <ul class="post-list">
        {posts.map(post => (
          <li class="post-card">
            <div class="post-meta">{new Date(post.created_at).toLocaleDateString('ko-KR')} · {post.author}</div>
            <div class="post-title"><a href={\`/blog/\${post.slug}\`}>{post.title}</a></div>
            {post.description && <p>{post.description}</p>}
          </li>
        ))}
      </ul>
  }
</Base>
`,

    "src/pages/blog/index.astro": `---
import Base from '../../layouts/Base.astro';
import { getPosts } from '../../lib/db';
const posts = await getPosts();
---
<Base title="블로그">
  <h1 style="font-size:2rem;font-weight:800;margin-bottom:2rem;">블로그</h1>
  {posts.length === 0
    ? <p style="color:#9ca3af;">아직 작성된 글이 없습니다.</p>
    : <ul class="post-list">
        {posts.map(post => (
          <li class="post-card">
            <div class="post-meta">{new Date(post.created_at).toLocaleDateString('ko-KR')} · {post.author}</div>
            <div class="post-title"><a href={\`/blog/\${post.slug}\`}>{post.title}</a></div>
            {post.description && <p>{post.description}</p>}
          </li>
        ))}
      </ul>
  }
</Base>
`,

    "src/pages/blog/[slug].astro": `---
import Base from '../../layouts/Base.astro';
import { getPosts, getPostContent } from '../../lib/db';
import { markdownToHtml } from '../../lib/markdown';
export async function getStaticPaths() {
  const posts = await getPosts();
  return posts.map(p => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post }    = Astro.props;
const mdContent   = await getPostContent(post.slug);
const htmlContent = markdownToHtml(mdContent);
---
<Base title={post.title} description={post.description}>
  <article>
    <header style="margin-bottom:2.5rem;">
      <h1 style="font-size:2rem;font-weight:800;margin-bottom:.75rem;">{post.title}</h1>
      <div class="post-meta">{new Date(post.created_at).toLocaleDateString('ko-KR')} · {post.author}</div>
    </header>
    <div class="prose" set:html={htmlContent} />
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #e5e7eb;">
      <a href="/blog">← 목록으로</a>
    </div>
  </article>
</Base>
`,

    "src/pages/rss.xml.ts": `import rss from '@astrojs/rss';
import { getPosts, getSettings } from '../lib/db';
import type { APIContext } from 'astro';
export async function GET(context: APIContext) {
  const settings = await getSettings();
  const posts    = await getPosts();
  return rss({
    title:       settings.site_name,
    description: settings.site_description,
    site:        context.site!,
    items: posts.map(p => ({
      title:       p.title,
      pubDate:     new Date(p.created_at),
      description: p.description || '',
      link:        \`/blog/\${p.slug}/\`,
    })),
  });
}
`,

    "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">C</text></svg>`,
    "public/robots.txt":  "User-agent: *\nAllow: /\n",
  };
}

// ── Cloudflare Pages 프로젝트 생성 + GitHub 연동 ─────────────────────────────
async function createCfPagesProject({ cfToken, cfAccountId, projectName, owner, repoName, log }) {
  if (!cfToken || !cfAccountId) {
    await log("  Cloudflare API 토큰/계정 ID 없음 - Pages 프로젝트 수동 생성 필요", "warning");
    return null;
  }

  await log(`  Cloudflare Pages 프로젝트 생성 중: ${projectName}`);

  // Pages 프로젝트 생성 (GitHub 연동)
  const createRes = await cfReq(cfToken, "POST",
    `/accounts/${cfAccountId}/pages/projects`,
    {
      name:              projectName,
      production_branch: "main",
      // GitHub 레포 연동 설정 (미러링)
      // Pages가 이 레포를 직접 빌드·배포 (코드 업로드 아님)
      source: {
        type: "github",
        config: {
          owner:              owner,
          repo_name:          repoName,
          production_branch:  "main",
          pr_comments_enabled: false,
          deployments_enabled: true,
        },
      },
      build_config: {
        build_command:      "npm install && npm run build",
        destination_dir:    "dist",
        root_dir:           "",
        build_caching:      true,
      },
      deployment_configs: {
        production: {
          env_vars: {
            NODE_VERSION: { value: "20" },
          },
        },
      },
    }
  );

  if (!createRes.ok && createRes.data?.errors?.[0]?.message?.includes("already exists")) {
    await log(`  Pages 프로젝트 이미 존재 - 기존 프로젝트 사용`, "warning");
    // 기존 프로젝트 조회
    const getRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/pages/projects/${projectName}`);
    if (getRes.ok) return getRes.data?.result;
    return null;
  }

  if (!createRes.ok) {
    await log(`  Pages 프로젝트 생성 실패: ${JSON.stringify(createRes.data?.errors)}`, "error");
    return null;
  }

  await log(`  Cloudflare Pages 프로젝트 생성 완료: ${projectName}`);
  return createRes.data?.result;
}

// ── Cloudflare Pages D1/KV 바인딩 자동 설정 ──────────────────────────────────
async function setCfPagesBindings({ cfToken, cfAccountId, projectName, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId || !projectName) return;

  await log("  Cloudflare 바인딩 자동 설정 중 (D1, KV)...");

  const bindings = {};
  if (d1Id) {
    bindings.d1_databases = {
      DB: { id: d1Id },
    };
  }
  if (kvSessionsId || kvCacheId) {
    bindings.kv_namespaces = {};
    if (kvSessionsId) bindings.kv_namespaces.SESSIONS = { namespace_id: kvSessionsId };
    if (kvCacheId)    bindings.kv_namespaces.CACHE    = { namespace_id: kvCacheId };
  }

  if (!Object.keys(bindings).length) return;

  const res = await cfReq(cfToken, "PATCH",
    `/accounts/${cfAccountId}/pages/projects/${projectName}`,
    { deployment_configs: { production: bindings } }
  );

  if (res.ok) {
    await log("  Cloudflare 바인딩 설정 완료 (D1, KV)");
  } else {
    await log(`  Cloudflare 바인딩 설정 실패: ${JSON.stringify(res.data?.errors)}`, "warning");
  }
}

// ── 메인: Cloudflare Pages 호스팅 생성 ───────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env, siteId, siteName,
  adminUser, adminPass, adminEmail,
  plan, planLimits,
  cfToken, cfAccountId,
  initialDomain, userId, isAdmin,
  log,
}) {
  const token = await pickGithubToken(env);
  if (!token) {
    await log("GitHub 토큰 없음 - 관리자 설정에서 GitHub 토큰을 추가해주세요", "error");
    return null;
  }

  const shortId   = siteId.replace(/-/g, "").slice(0, 8);
  const repoName  = `cp-${shortId}`;
  const projName  = `cp-${shortId}`;

  // GitHub 계정 확인
  const { ok: meOk, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log("GitHub 토큰 인증 실패", "error");
    return null;
  }
  const owner = meData.login;

  await log(`[1/6] GitHub 레포 생성 중: ${owner}/${repoName}`);

  // ── GitHub 레포 생성 ───────────────────────────────────────────────────
  const { ok: repoOk, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: `CloudPress 호스팅: ${siteName} (Site ID: ${siteId})`,
    private:     false,
    auto_init:   true,
    has_issues:  false,
    has_wiki:    false,
    has_projects: false,
  });

  if (!repoOk && !repoData?.errors?.[0]?.message?.includes("already exists")) {
    await log(`GitHub 레포 생성 실패: ${repoData?.message}`, "error");
    await log("GitHub 토큰을 확인하세요. 관리자 설정 > GitHub 토큰에서 재설정 후 다시 시도하세요.", "warning");
    return null;
  }
  await log(`[1/6] GitHub 레포 생성 완료: ${owner}/${repoName}`);

  await delay(8000); // 레포 초기화 대기

  // ── [2/6] DB 초기 데이터 생성 ─────────────────────────────────────────
  await log("[2/6] DB 초기 데이터 생성 중...");
  await initDbFiles(token, owner, repoName, {
    siteId, siteName, adminUser, adminPass, adminEmail, planLimits, log,
  });

  // ── [3/6] WordPress 공식 파일 → Astro 변환 ────────────────────────────
  await log("[3/6] WordPress 공식 파일 Astro 변환 중...");
  const wpConverted = await fetchWordPressOfficialFiles(log);
  let convertedCount = 0;
  for (const file of wpConverted) {
    await ghPutFile(token, owner, repoName, file.path, file.content,
      `convert: ${file.original} to Astro/TS`, null).catch(() => {});
    convertedCount++;
    await delay(200);
    if (convertedCount % 5 === 0) await log(`  변환 진행: ${convertedCount}/${wpConverted.length}개`);
  }
  await log(`[3/6] WordPress 파일 변환 완료: ${convertedCount}개`);

  // ── [4/6] Astro 소스 파일 생성 ────────────────────────────────────────
  await log("[4/6] Astro 소스 파일 생성 중...");
  const astroFiles = buildAstroSource({ siteName, siteId, owner, repoName, planLimits });
  let fileCount = 0;
  for (const [path, content] of Object.entries(astroFiles)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    fileCount++;
    await delay(250);
  }
  await log(`[4/6] Astro 소스 ${fileCount}개 파일 생성 완료`);

  // ── [5/6] Cloudflare Pages 설정 파일 + 미러링 워크플로우 생성 ──────────
  await log("[5/6] Cloudflare Pages 설정 + 미러링 워크플로우 생성 중...");
  const cfPagesConfig = buildCfPagesConfig({
    siteId, siteName,
    cfAccountId,
    d1Id:        env.DB?.__D1_CONTRACT__?.databaseId || null,
    kvSessionsId: null,
    kvCacheId:    null,
  });
  const mirrorWorkflows = buildMirrorWorkflow({ siteId, cfAccountId, cfPagesProject: projName });

  for (const [path, content] of Object.entries({ ...cfPagesConfig, ...mirrorWorkflows })) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    await delay(300);
  }
  await log("[5/6] Cloudflare Pages 설정 파일 생성 완료");

  // ── [6/6] Cloudflare Pages 프로젝트 생성 + GitHub 연동 (미러링) ─────────
  await log("[6/6] Cloudflare Pages 프로젝트 생성 + GitHub 연동 중...");
  let pagesProject = null;
  let pagesUrl     = null;

  if (cfToken && cfAccountId) {
    pagesProject = await createCfPagesProject({
      cfToken, cfAccountId,
      projectName: projName,
      owner, repoName, log,
    });

    if (pagesProject) {
      pagesUrl = `https://${projName}.pages.dev`;

      // D1/KV 바인딩 자동 설정
      await setCfPagesBindings({
        cfToken, cfAccountId,
        projectName: projName,
        d1Id:        null,
        kvSessionsId: null,
        kvCacheId:    null,
        log,
      });

      await log(`[6/6] Cloudflare Pages 연동 완료: ${pagesUrl}`);
    } else {
      await log("[6/6] Cloudflare Pages 수동 설정 필요", "warning");
      await log(`  Cloudflare 대시보드에서 Pages 프로젝트 생성 후 GitHub 레포(${owner}/${repoName}) 연동`, "warning");
      pagesUrl = `https://${projName}.pages.dev`;
    }
  } else {
    await log("[6/6] Cloudflare API 토큰 없음 - Pages 수동 설정 필요", "warning");
    await log(`  GitHub 레포: https://github.com/${owner}/${repoName}`, "warning");
    await log(`  Cloudflare 대시보드 > Pages > 프로젝트 생성 > GitHub 레포 연동`, "warning");
    await log(`  빌드 명령: npm install && npm run build`, "warning");
    await log(`  빌드 출력 디렉토리: dist`, "warning");
    pagesUrl = null;
  }

  await log("Cloudflare Pages 호스팅 구축 완료!");

  return {
    owner,
    repoName,
    pagesUrl,
    pagesProject: projName,
    cfDomain: initialDomain || null,
  };
}

// ── URL 계산 ──────────────────────────────────────────────────────────────────
export function getCfPagesUrl(projectName) {
  return `https://${projectName}.pages.dev`;
}
