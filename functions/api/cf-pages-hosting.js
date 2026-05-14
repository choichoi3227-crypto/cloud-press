// functions/api/cf-pages-hosting.js
// Cloudflare Pages 호스팅 프로비저닝 전담 모듈
// GitHub Tree API로 배치 push → 타임아웃 방지

import { ghReq, pickGithubToken } from "./github-storage.js";

// ── 딜레이 ────────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── slug 생성 ─────────────────────────────────────────────────────────────────
function slugify(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── base64 인코딩 (UTF-8 safe) ────────────────────────────────────────────────
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// ── 비밀번호 해싱 (SHA-256) ────────────────────────────────────────────────────
async function hashPassword(password) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Cloudflare API 헬퍼 ───────────────────────────────────────────────────────
async function cfReq(apiToken, method, path, body, cfEmail) {
  const headers = { "Content-Type": "application/json" };
  if (cfEmail) {
    headers["X-Auth-Email"] = cfEmail;
    headers["X-Auth-Key"]   = apiToken;
  } else {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── GitHub Tree API로 여러 파일 한 번에 push (타임아웃 방지) ──────────────────
async function ghBatchPush(token, owner, repo, files, commitMsg) {
  // 1. 현재 HEAD SHA 조회
  const refRes = await ghReq("GET", `/repos/${owner}/${repo}/git/refs/heads/main`, token);
  if (!refRes.ok) return false;
  const baseSha = refRes.data?.object?.sha;

  // 2. Base tree SHA 조회
  const commitRes = await ghReq("GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`, token);
  const baseTreeSha = commitRes.data?.tree?.sha;

  // 3. 새 tree 생성
  const tree = files.map(({ path, content }) => ({
    path,
    mode: "100644",
    type: "blob",
    content,
  }));

  const treeRes = await ghReq("POST", `/repos/${owner}/${repo}/git/trees`, token, {
    base_tree: baseTreeSha,
    tree,
  });
  if (!treeRes.ok) return false;
  const newTreeSha = treeRes.data?.sha;

  // 4. 새 commit 생성
  const newCommitRes = await ghReq("POST", `/repos/${owner}/${repo}/git/commits`, token, {
    message: commitMsg,
    tree:    newTreeSha,
    parents: [baseSha],
  });
  if (!newCommitRes.ok) return false;
  const newCommitSha = newCommitRes.data?.sha;

  // 5. refs/heads/main 업데이트
  const updateRes = await ghReq("PATCH", `/repos/${owner}/${repo}/git/refs/heads/main`, token, {
    sha:   newCommitSha,
    force: false,
  });
  return updateRes.ok;
}

// ── WordPress 공식 파일 변환 스크립트 생성 ───────────────────────────────────
// Worker에서 직접 fetch하지 않고, GitHub Actions 빌드 시 가져오는 스크립트를 레포에 포함
// → subrequest 20개 절감
function buildWordPressConvertScript() {
  const targetFiles = [
    { path: "wp-login.php",                              type: "php" },
    { path: "wp-signup.php",                             type: "php" },
    { path: "wp-comments-post.php",                      type: "php" },
    { path: "wp-cron.php",                               type: "php" },
    { path: "wp-includes/functions.php",                 type: "php" },
    { path: "wp-includes/class-wp-query.php",            type: "php" },
    { path: "wp-includes/class-wp-post.php",             type: "php" },
    { path: "wp-includes/class-wp-user.php",             type: "php" },
    { path: "wp-includes/post.php",                      type: "php" },
    { path: "wp-includes/user.php",                      type: "php" },
    { path: "wp-includes/formatting.php",                type: "php" },
    { path: "wp-includes/taxonomy.php",                  type: "php" },
    { path: "wp-includes/comment.php",                   type: "php" },
    { path: "wp-admin/admin.php",                        type: "php" },
    { path: "wp-admin/index.php",                        type: "php" },
    { path: "wp-admin/post.php",                         type: "php" },
    { path: "wp-admin/edit.php",                         type: "php" },
    { path: "wp-includes/js/wp-util.js",                 type: "js"  },
    { path: "wp-includes/js/customize-preview.js",       type: "js"  },
    { path: "wp-admin/css/common.css",                   type: "css" },
  ];

  const fileListJson = JSON.stringify(targetFiles, null, 2);

  const scriptContent = `#!/usr/bin/env node
// scripts/convert-wp-files.mjs
// GitHub Actions 빌드 시 WordPress 공식 소스를 가져와 Astro/TS로 변환
// Worker subrequest 한도 초과 방지를 위해 빌드 타임으로 이동

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const WP_RAW = 'https://raw.githubusercontent.com/WordPress/WordPress/master';
const TARGET_FILES = ${fileListJson};

function convertPhpToAstro(phpCode, fileName) {
  let code = phpCode
    .replace(/<\\?php\\s*/g, '')
    .replace(/<\\?=/g, '{')
    .replace(/\\?>/g, '}')
    .trim();
  code = code
    .replace(/\\$(\\w+)\\s*=\\s*/g, 'const $1 = ')
    .replace(/\\$(\\w+)/g, '$1');
  code = code.replace(/echo\\s+(.+?);/g, '{$1}');
  code = code.replace(/function\\s+(\\w+)\\s*\\(/g, 'function $1(');
  code = code.replace(/array\\s*\\(/g, '[').replace(/\\)/g, ']');
  code = code.replace(/"\\s*\\.\\s*"/g, '" + "').replace(/'\\s*\\.\\s*'/g, "' + '");
  code = code.replace(/foreach\\s*\\((\\w+)\\s+as\\s+(\\w+)\\s*=>\\s*(\\w+)\\)/g, 'for (const [$2, $3] of Object.entries($1))');
  code = code.replace(/foreach\\s*\\((\\w+)\\s+as\\s+(\\w+)\\)/g, 'for (const $2 of $1)');
  code = code.replace(/require_once\\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/require\\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/include_once\\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/include\\s+['"](.+?)['"]/g, "// import '$1'");
  code = code.replace(/^#\\s*/gm, '// ');
  code = code.replace(/(\\w+)::/g, '$1.');
  return \`---\\n// Converted from \${fileName} (WordPress official source → Astro)\\n// Source: https://github.com/WordPress/WordPress\\n\\n\${code}\\n---\\n\\n<slot />\\n\`;
}

function convertJsToTs(jsCode, fileName) {
  let code = jsCode.replace(/\\bvar\\s+/g, 'let ');
  if (code.includes('jQuery') || code.includes('$')) {
    code = \`// @ts-ignore - jQuery type\\ndeclare const jQuery: any;\\ndeclare const $: typeof jQuery;\\n\\n\` + code;
  }
  if (code.includes('wp.')) {
    code = \`// @ts-ignore - WordPress globals\\ndeclare const wp: any;\\n\\n\` + code;
  }
  if (code.includes('wpApiSettings') || code.includes('ajaxurl')) {
    code = \`// @ts-ignore - WordPress API globals\\ndeclare const wpApiSettings: any;\\ndeclare const ajaxurl: string;\\n\\n\` + code;
  }
  return \`// Converted from \${fileName} (WordPress official source → TypeScript)\\n// Source: https://github.com/WordPress/WordPress\\n\\n\${code}\\n\`;
}

async function run() {
  let converted = 0;
  const chunks = [];
  for (let i = 0; i < TARGET_FILES.length; i += 5) chunks.push(TARGET_FILES.slice(i, i + 5));

  for (const chunk of chunks) {
    const results = await Promise.allSettled(chunk.map(async (file) => {
      const res = await fetch(\`\${WP_RAW}/\${file.path}\`, { headers: { 'User-Agent': 'CloudPress/3.1' } });
      if (!res.ok) return null;
      const raw = await res.text();
      const base = file.path.split('/').pop();
      let outPath, content;
      if (file.type === 'php') {
        outPath = \`src/wp-converted/\${file.path.replace(/\\.php$/, '.astro')}\`;
        content = convertPhpToAstro(raw, base);
      } else if (file.type === 'js') {
        outPath = \`src/wp-converted/\${file.path.replace(/\\.js$/, '.ts')}\`;
        content = convertJsToTs(raw, base);
      } else {
        outPath = \`public/\${file.path}\`;
        content = raw;
      }
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, 'utf8');
      return outPath;
    }));
    results.forEach(r => { if (r.status === 'fulfilled' && r.value) converted++; });
  }
  console.log(\`WordPress 파일 변환 완료: \${converted}개\`);
}

run().catch(e => { console.error(e); process.exit(1); });
`;

  return [{ path: "scripts/convert-wp-files.mjs", content: scriptContent }];
}


// ── Astro 소스 파일 생성 ─────────────────────────────────────────────────────
function buildAstroFiles({ siteName, siteId, owner, repoName, planLimits }) {
  const storageGb = planLimits?.storage_gb ?? 5;
  const trafficGb = planLimits?.traffic_gb ?? 100;
  const ghRaw     = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;

  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: slugify(siteName) || "cloudpress-site",
        type: "module", version: "1.0.0",
        engines: { node: ">=20.0.0" },
        scripts: { dev: "astro dev", build: "astro build", preview: "astro preview" },
        dependencies: {
          "astro": "^4.16.0",
          "@astrojs/sitemap": "^3.2.1",
          "@astrojs/rss": "^4.0.7",
        },
      }, null, 2),
    },
    {
      path: "astro.config.mjs",
      content: `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
const site = process.env.SITE_URL || '';
export default defineConfig({
  site, base: '/',
  integrations: [sitemap()],
  output: 'static',
  build: { inlineStylesheets: 'auto' },
});
`,
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        extends: "astro/tsconfigs/strict",
        compilerOptions: { strictNullChecks: true, allowJs: true, skipLibCheck: true },
      }, null, 2),
    },
    {
      path: "src/lib/db.ts",
      content: `// GitHub 레포 _db/ 폴더에서 JSON 데이터 읽기
const REPO_RAW = '${ghRaw}';

export const PLAN_LIMITS = {
  storage_gb: ${storageGb},
  traffic_gb: ${trafficGb === null ? "null" : trafficGb},
  custom_domain: ${planLimits?.custom_domain ?? false},
  backups: ${planLimits?.backups ?? false},
};

async function fetchDb<T>(file: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(\`\${REPO_RAW}/_db/\${file}\`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json() as T;
  } catch { return fallback; }
}

export type Post = {
  id: number; slug: string; title: string; description?: string;
  status: 'publish' | 'draft'; author: string; categories: string[];
  tags: string[]; created_at: string; updated_at: string; content_file?: string;
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
    site_name: '${siteName.replace(/'/g, "\\'")}',
    site_url: '', site_description: '', admin_email: '',
    posts_per_page: 10, theme: 'default', timezone: 'Asia/Seoul', language: 'ko',
  });
}

export async function getCategories() { return fetchDb<any[]>('categories.json', []); }
export async function getTags() { return fetchDb<any[]>('tags.json', []); }

export async function getPostContent(slug: string): Promise<string> {
  try {
    const res = await fetch(\`\${REPO_RAW}/_content/posts/\${slug}.md\`);
    if (!res.ok) return '';
    return (await res.text()).replace(/^---[\\s\\S]*?---\\n?/, '').trim();
  } catch { return ''; }
}
`,
    },
    {
      path: "src/lib/markdown.ts",
      content: `export function markdownToHtml(md: string): string {
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
    },
    {
      path: "src/layouts/Base.astro",
      content: `---
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
</head>
<body>
  <header>
    <div class="container header-inner">
      <a href="/" class="site-title">{settings.site_name}</a>
      <nav><a href="/">홈</a><a href="/blog">블로그</a></nav>
    </div>
  </header>
  <main class="container"><slot /></main>
  <footer><div class="container"><p>© {new Date().getFullYear()} {settings.site_name}</p></div></footer>
</body>
</html>
`,
    },
    {
      path: "src/styles/global.css",
      content: `*,*::before,*::after{box-sizing:border-box;margin:0}
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
    },
    {
      path: "src/pages/index.astro",
      content: `---
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
    },
    {
      path: "src/pages/blog/index.astro",
      content: `---
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
    },
    {
      path: "src/pages/blog/[slug].astro",
      content: `---
import Base from '../../layouts/Base.astro';
import { getPosts, getPostContent } from '../../lib/db';
import { markdownToHtml } from '../../lib/markdown';
export async function getStaticPaths() {
  const posts = await getPosts();
  return posts.map(p => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post } = Astro.props;
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
    },
    {
      path: "src/pages/rss.xml.ts",
      content: `import rss from '@astrojs/rss';
import { getPosts, getSettings } from '../lib/db';
import type { APIContext } from 'astro';
export async function GET(context: APIContext) {
  const settings = await getSettings();
  const posts    = await getPosts();
  return rss({
    title: settings.site_name,
    description: settings.site_description,
    site: context.site!,
    items: posts.map(p => ({
      title: p.title,
      pubDate: new Date(p.created_at),
      description: p.description || '',
      link: \`/blog/\${p.slug}/\`,
    })),
  });
}
`,
    },
    {
      path: "public/favicon.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">C</text></svg>`,
    },
    { path: "public/robots.txt", content: "User-agent: *\nAllow: /\n" },
  ];
}

// ── wrangler.toml + GitHub Actions 생성 ──────────────────────────────────────
function buildConfigFiles({ siteId, siteName, cfAccountId, d1Id, kvSessionsId, kvCacheId, projName }) {
  return [
    {
      path: "wrangler.toml",
      content: `# Cloudflare Pages 빌드 및 바인딩 설정
name = "${slugify(siteName) || "cloudpress-site"}"
compatibility_date = "2025-04-01"

${d1Id ? `[[d1_databases]]
binding       = "DB"
database_name = "cp-${siteId.slice(0,8)}-db"
database_id   = "${d1Id}"` : "# D1 바인딩: Cloudflare 대시보드에서 설정"}

${kvSessionsId ? `[[kv_namespaces]]
binding = "SESSIONS"
id      = "${kvSessionsId}"` : "# KV SESSIONS: Cloudflare 대시보드에서 설정"}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : "# KV CACHE: Cloudflare 대시보드에서 설정"}

[vars]
SITE_ID   = "${siteId}"
SITE_NAME = "${siteName}"
`,
    },
    {
      path: ".github/workflows/cf-pages.yml",
      content: `name: Cloudflare Pages 빌드 검증

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm install --prefer-offline || npm install
      - name: WordPress 파일 변환 (PHP→Astro, JS→TS)
        run: node scripts/convert-wp-files.mjs
        continue-on-error: true
      - name: Astro 빌드
        env:
          SITE_ID: ${siteId}
        run: npm run build
      - name: 빌드 검증
        run: |
          test -f dist/index.html || (echo "빌드 실패: index.html 없음" && exit 1)
          echo "빌드 성공: $(find dist -type f | wc -l)개 파일"
`,
    },
  ];
}

// ── DB 초기 데이터 파일 ───────────────────────────────────────────────────────
async function buildDbFiles({ siteId, siteName, adminUser, adminPass, adminEmail }) {
  const passHash = await hashPassword(adminPass);
  const now      = new Date().toISOString();
  return [
    {
      path: "_db/settings.json",
      content: JSON.stringify({
        site_name: siteName, site_url: "", site_description: "",
        admin_email: adminEmail, posts_per_page: 10, theme: "default",
        timezone: "Asia/Seoul", language: "ko", created_at: now, site_id: siteId,
      }, null, 2),
    },
    {
      path: "_db/users.json",
      content: JSON.stringify([{
        id: 1, username: adminUser, email: adminEmail,
        password: passHash, role: "administrator",
        display_name: adminUser, created_at: now,
      }], null, 2),
    },
    { path: "_db/posts.json",      content: "[]" },
    { path: "_db/pages.json",      content: "[]" },
    { path: "_db/media.json",      content: "[]" },
    { path: "_db/categories.json", content: JSON.stringify([{ id: 1, name: "미분류", slug: "uncategorized", description: "", parent: 0, count: 0 }], null, 2) },
    { path: "_db/tags.json",       content: "[]" },
    { path: "_db/comments.json",   content: "[]" },
    { path: "_content/posts/.gitkeep", content: "" },
  ];
}

// ── Cloudflare D1 생성 ────────────────────────────────────────────────────────
async function createD1Database({ cfToken, cfAccountId, cfEmail, dbName, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  D1 생성 중: ${dbName}`);
  // GET 목록 조회 생략 → 바로 POST, 이미 존재하면 오류 메시지에서 uuid 추출
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database`, { name: dbName }, cfEmail);
  if (!res.ok) {
    // 이미 존재하는 경우: 오류에서 기존 uuid 파싱 시도
    const errMsg = res.data?.errors?.[0]?.message || "";
    const uuidMatch = errMsg.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) { await log(`  D1 기존 사용: ${uuidMatch[1]}`); return uuidMatch[1]; }
    // 이미 존재 메시지인 경우 이름으로 재조회 (1회만)
    if (errMsg.toLowerCase().includes("already exist") || res.status === 409) {
      const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/d1/database?name=${encodeURIComponent(dbName)}`, null, cfEmail);
      const found = listRes.data?.result?.find(db => db.name === dbName);
      if (found) { await log(`  D1 기존 사용: ${found.uuid}`); return found.uuid; }
    }
    await log(`  D1 생성 실패 (${res.status}): ${JSON.stringify(res.data?.errors)}`, "error");
    return null;
  }
  const id = res.data?.result?.uuid;
  await log(`  D1 생성 완료: ${id}`);
  return id;
}

// ── Cloudflare KV 생성 ────────────────────────────────────────────────────────
async function createKVNamespace({ cfToken, cfAccountId, cfEmail, title, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  KV 생성 중: ${title}`);
  // GET 목록 조회 생략 → 바로 POST, 이미 존재하면 오류 처리
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/storage/kv/namespaces`, { title }, cfEmail);
  if (!res.ok) {
    // 이미 존재하는 경우: 목록에서 찾기 (1회만)
    const errMsg = res.data?.errors?.[0]?.message || "";
    if (errMsg.toLowerCase().includes("already exist") || res.status === 409) {
      const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/storage/kv/namespaces`, null, cfEmail);
      const found = listRes.data?.result?.find(ns => ns.title === title);
      if (found) { await log(`  KV 기존 사용: ${found.id}`); return found.id; }
    }
    await log(`  KV 생성 실패 (${res.status}): ${JSON.stringify(res.data?.errors)}`, "error");
    return null;
  }
  const id = res.data?.result?.id;
  await log(`  KV 생성 완료: ${id}`);
  return id;
}

// ── Cloudflare Worker 생성 ────────────────────────────────────────────────────
async function createWorker({ cfToken, cfAccountId, cfEmail, workerName, siteId, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  Worker 생성 중: ${workerName}`);

  const script = `// CloudPress Worker: ${siteId}
export default {
  async fetch(request, env, ctx) {
    return fetch(request);
  }
};`;

  const bindings = [];
  if (d1Id)         bindings.push({ type: "d1",           name: "DB",       id: d1Id });
  if (kvSessionsId) bindings.push({ type: "kv_namespace", name: "SESSIONS", namespace_id: kvSessionsId });
  if (kvCacheId)    bindings.push({ type: "kv_namespace", name: "CACHE",    namespace_id: kvCacheId });

  const form = new FormData();
  form.append("metadata", JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-04-01",
    bindings,
  }));
  form.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");

  const headers = cfEmail
    ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
    : { "Authorization": `Bearer ${cfToken}` };

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`, {
    method: "PUT", headers, body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { await log(`  Worker 생성 실패 (${res.status}): ${JSON.stringify(data?.errors)}`, "error"); return null; }
  await log(`  Worker 생성 완료: ${workerName}`);
  return workerName;
}

// ── D1 스키마 초기화 ──────────────────────────────────────────────────────────
async function initD1Schema({ cfToken, cfAccountId, cfEmail, d1Id, siteId, adminUser, adminEmail, adminPassHash, log }) {
  if (!d1Id) return;
  await log("  D1 스키마 초기화 중...");
  const now = new Date().toISOString();
  const sqls = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT DEFAULT 'author', display_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT, status TEXT DEFAULT 'draft', author_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, filename TEXT, url TEXT, mime_type TEXT, size INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, role, display_name, created_at) VALUES ('admin-${siteId.slice(0,8)}', '${adminUser.replace(/'/g,"''")}', '${adminEmail.replace(/'/g,"''")}', '${adminPassHash}', 'administrator', '${adminUser.replace(/'/g,"''")}', '${now}')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_id', '${siteId}')`,
  ];

  // D1 Batch API로 한 번에 실행 (subrequest 7개 → 1개)
  const r = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database/${d1Id}/query`, {
    sql: sqls.join("; "),
  }, cfEmail);

  // Batch API가 지원되지 않는 경우 개별 실행으로 fallback
  if (!r.ok) {
    for (const sql of sqls) {
      const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database/${d1Id}/query`, { sql }, cfEmail);
      if (!res.ok) await log(`  D1 쿼리 실패: ${sql.slice(0,60)}`, "warning");
    }
  }
  await log("  D1 스키마 초기화 완료");
}

// ── Cloudflare Pages 프로젝트 생성 ───────────────────────────────────────────
async function createCfPagesProject({ cfToken, cfAccountId, cfEmail, projectName, owner, repoName, log }) {
  if (!cfToken || !cfAccountId) {
    await log("  CF API 없음 - Pages 프로젝트 수동 생성 필요", "warning");
    return null;
  }
  await log(`  Pages 프로젝트 생성 중: ${projectName}`);
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/pages/projects`, {
    name: projectName,
    production_branch: "main",
    source: {
      type: "github",
      config: { owner, repo_name: repoName, production_branch: "main", pr_comments_enabled: false, deployments_enabled: true },
    },
    build_config: { build_command: "npm install && npm run build", destination_dir: "dist", root_dir: "", build_caching: true },
    deployment_configs: { production: { env_vars: { NODE_VERSION: { value: "20" } } } },
  }, cfEmail);

  if (!res.ok && res.data?.errors?.[0]?.message?.includes("already exists")) {
    await log(`  Pages 프로젝트 이미 존재 - 기존 사용`, "warning");
    const getRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/pages/projects/${projectName}`, null, cfEmail);
    return getRes.ok ? getRes.data?.result : null;
  }
  if (!res.ok) { await log(`  Pages 생성 실패 (${res.status}): ${JSON.stringify(res.data?.errors)}`, "error"); return null; }
  await log(`  Pages 프로젝트 생성 완료: ${projectName}`);
  return res.data?.result;
}

// ── Pages D1/KV 바인딩 설정 ───────────────────────────────────────────────────
async function setCfPagesBindings({ cfToken, cfAccountId, cfEmail, projectName, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId || !projectName) return;
  await log("  Pages 바인딩 설정 중...");
  const cfg = { env_vars: {} };
  if (d1Id)         cfg.d1_databases  = { DB: { id: d1Id } };
  if (kvSessionsId) cfg.kv_namespaces = { ...cfg.kv_namespaces, SESSIONS: { namespace_id: kvSessionsId } };
  if (kvCacheId)    cfg.kv_namespaces = { ...cfg.kv_namespaces, CACHE:    { namespace_id: kvCacheId } };

  const res = await cfReq(cfToken, "PATCH", `/accounts/${cfAccountId}/pages/projects/${projectName}`,
    { deployment_configs: { production: cfg } }, cfEmail);
  if (res.ok) await log("  Pages 바인딩 완료");
  else        await log(`  Pages 바인딩 실패: ${JSON.stringify(res.data?.errors)}`, "warning");
}

// ── 메인: 호스팅 프로비저닝 ──────────────────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env, siteId, siteName,
  adminUser, adminPass, adminEmail,
  plan, planLimits,
  cfToken, cfAccountId, cfEmail,
  initialDomain, userId, isAdmin,
  log,
}) {
  // ── GitHub 토큰 확인 ───────────────────────────────────────────────────
  const token = await pickGithubToken(env);
  if (!token) {
    await log("GitHub 토큰 없음 - 관리자 패널 → GitHub 토큰에서 등록 필요", "error");
    return null;
  }
  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_") && !token.startsWith("gho_") && !token.startsWith("ghr_")) {
    await log(`GitHub 토큰 형식 오류: ${token.slice(0,8)}... (ghp_ / github_pat_ 으로 시작해야 함)`, "error");
    await log("CF API Token이 아닌 GitHub Personal Access Token을 등록해주세요", "error");
    return null;
  }

  const shortId  = siteId.replace(/-/g, "").slice(0, 8);
  const repoName = `cp-${shortId}`;
  const projName = `cp-${shortId}`;

  // ── [1/5] GitHub 계정 확인 + 레포 생성 ────────────────────────────────
  await log("[1/5] GitHub 레포 생성 중...");
  const { ok: meOk, status: meStatus, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log(`GitHub 인증 실패 (HTTP ${meStatus}): ${JSON.stringify(meData).slice(0,200)}`, "error");
    return null;
  }
  const owner = meData.login;
  await log(`  GitHub 계정: ${owner}`);

  const { ok: repoOk, status: repoStatus, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name: repoName,
    description: `CloudPress: ${siteName} (${siteId})`,
    private: false, auto_init: true, has_issues: false, has_wiki: false,
  });
  if (!repoOk && !repoData?.errors?.[0]?.message?.includes("already exists")) {
    await log(`GitHub 레포 생성 실패 (HTTP ${repoStatus}): ${repoData?.message}`, "error");
    return null;
  }
  await log(`[1/5] 완료: https://github.com/${owner}/${repoName}`);

  await delay(4000); // 레포 초기화 대기

  // ── [2/5] Cloudflare D1 / KV / Worker 생성 ────────────────────────────
  await log("[2/5] Cloudflare 리소스 생성 중 (D1, KV, Worker)...");
  const prefix = `cp-${shortId}`;
  let d1Id = null, kvSessionsId = null, kvCacheId = null, workerName = null;

  if (cfToken && cfAccountId) {
    d1Id = await createD1Database({ cfToken, cfAccountId, cfEmail, dbName: `${prefix}-db`, log });
    kvSessionsId = await createKVNamespace({ cfToken, cfAccountId, cfEmail, title: `${prefix}-sessions`, log });
    kvCacheId    = await createKVNamespace({ cfToken, cfAccountId, cfEmail, title: `${prefix}-cache`,    log });
    workerName   = await createWorker({ cfToken, cfAccountId, cfEmail, workerName: prefix, siteId, d1Id, kvSessionsId, kvCacheId, log });

    if (d1Id) {
      const passHash = await hashPassword(adminPass);
      await initD1Schema({ cfToken, cfAccountId, cfEmail, d1Id, siteId, adminUser, adminEmail, adminPassHash: passHash, log });
    }

    await env.DB.prepare("UPDATE sites SET cf_worker_name=?, cf_d1_id=?, cf_kv_id=? WHERE id=?")
      .bind(workerName || null, d1Id || null, kvSessionsId || null, siteId).run().catch(() => {});

    await log(`[2/5] 완료 — D1:${d1Id?"✅":"❌"} KV:${kvSessionsId?"✅":"❌"} Worker:${workerName?"✅":"❌"}`);
  } else {
    await log("[2/5] CF API 없음 — D1/KV/Worker 건너뜀", "warning");
  }

  // ── [3/5] GitHub 레포에 전체 파일 배치 push ────────────────────────────
  await log("[3/5] 파일 생성 중 (Astro 소스, DB 초기 데이터, wrangler.toml, GitHub Actions)...");

  const astroFiles  = buildAstroFiles({ siteName, siteId, owner, repoName, planLimits });
  const dbFiles     = await buildDbFiles({ siteId, siteName, adminUser, adminPass, adminEmail });
  const configFiles = buildConfigFiles({ siteId, siteName, cfAccountId, d1Id, kvSessionsId, kvCacheId, projName });

  const allFiles = [...astroFiles, ...dbFiles, ...configFiles];

  const batch1ok = await ghBatchPush(token, owner, repoName, allFiles, "init: Astro source, DB data, CF config");
  await log(`[3/5] 기본 파일 push: ${batch1ok ? "✅" : "❌ 실패"}`);

  // ── [4/5] WordPress 변환 스크립트를 레포에 push (빌드 타임에 실행) ────────
  await log("[4/5] WordPress 공식 파일 변환 중 (PHP→Astro, JS→TS)...");
  const wpScriptFiles = buildWordPressConvertScript();
  if (wpScriptFiles.length > 0) {
    const batch2ok = await ghBatchPush(token, owner, repoName, wpScriptFiles, `convert: add WordPress file conversion script (build-time)`);
    await log(`[4/5] WordPress 파일 변환 push: ${batch2ok ? "✅ " + wpScriptFiles.length + "개" : "❌ 실패"}`);
  } else {
    await log("[4/5] WordPress 파일 변환 없음 (네트워크 오류)", "warning");
  }

  // ── [5/5] Cloudflare Pages 프로젝트 생성 + 바인딩 ─────────────────────
  await log("[5/5] Cloudflare Pages 프로젝트 생성 중...");
  let pagesUrl = `https://${projName}.pages.dev`;

  if (cfToken && cfAccountId) {
    const pagesProject = await createCfPagesProject({ cfToken, cfAccountId, cfEmail, projectName: projName, owner, repoName, log });
    if (pagesProject) {
      await setCfPagesBindings({ cfToken, cfAccountId, cfEmail, projectName: projName, d1Id, kvSessionsId, kvCacheId, log });
      await log(`[5/5] Pages 완료: ${pagesUrl}`);
    } else {
      await log(`[5/5] Pages 수동 설정 필요: CF 대시보드 → Pages → ${repoName} 연동`, "warning");
    }
  } else {
    await log("[5/5] CF API 없음 — Pages 수동 설정 필요", "warning");
    pagesUrl = null;
  }

  await log("✅ 호스팅 구축 완료!");

  return {
    owner, repoName, pagesUrl, pagesProject: projName,
    cfDomain: initialDomain || null,
    d1Id, kvSessionsId, kvCacheId, workerName,
  };
}

// ── URL 계산 ──────────────────────────────────────────────────────────────────
export function getCfPagesUrl(projectName) {
  return `https://${projectName}.pages.dev`;
}
