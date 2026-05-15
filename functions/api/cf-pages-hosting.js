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

// ── MD5 pure-JS (phpass 호환) ──────────────────────────────────────────────────
function _md5(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const msgLen = bytes.length, bitLen = msgLen * 8;
  const padLen = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);
  const padded = new Uint8Array(msgLen + padLen + 8);
  padded.set(bytes); padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(msgLen + padLen, bitLen >>> 0, true);
  view.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < padded.length; i += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(i + j * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if      (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5*j+1)%16; }
      else if (j < 48) { f = b ^ c ^ d;           g = (3*j+5)%16; }
      else             { f = c ^ (b | ~d);         g = (7*j)%16; }
      f = (f + a + T[j] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((f << S[j]) | (f >>> (32 - S[j])))) >>> 0;
    }
    a0=(a0+a)>>>0; b0=(b0+b)>>>0; c0=(c0+c)>>>0; d0=(d0+d)>>>0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

// ── phpass 비밀번호 해시 생성 (WordPress 호환) ─────────────────────────────────
// worker-wp.js의 phpassCheck()와 호환되는 $P$ 해시 생성
function phpassCreate(password) {
  const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const countLog2 = 8; // 2^8 = 256 iterations
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./";
  const rnd = new Uint8Array(8);
  crypto.getRandomValues(rnd);
  let salt = "";
  for (const b of rnd) salt += chars[b % chars.length];
  const prefix = `$P$${ITOA64[countLog2]}${salt}`;
  let count = 1 << countLog2;
  const passBytes = new TextEncoder().encode(password);
  let h = _md5(salt + password);
  while (count--) {
    const c = new Uint8Array(h.length + passBytes.length);
    c.set(h); c.set(passBytes, h.length);
    h = _md5(c);
  }
  // encode64
  let output = ""; let i = 0;
  while (i < 16) {
    let value = h[i++];
    output += ITOA64[value & 0x3f];
    if (i < 16) value |= h[i] << 8;
    output += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= 16) break;
    if (i < 16) value |= h[i] << 16;
    output += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= 16) break;
    output += ITOA64[(value >> 18) & 0x3f];
  }
  return prefix + output;
}

// ── 비밀번호 해싱 (phpass — WordPress 호환) ────────────────────────────────────
// worker-wp.js의 phpassCheck()와 호환되어야 하므로 phpass 사용
function hashPassword(password) {
  return phpassCreate(password);
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
  const passHash = hashPassword(adminPass);
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

// ── worker-wp.js 소스 (인라인 임베드 — 원격 fetch 불필요) ──────────────────
const _WORKER_WP_SOURCE = "/**\n * CloudPress WordPress Worker v6.0\n * \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n * PHP-FREE WordPress SaaS Engine\n * - PHP/php-wasm \uc644\uc804 \uc81c\uac70 (CPU \uc81c\ud55c \ubb38\uc81c \ud574\uacb0)\n * - D1(SQLite) \uae30\ubc18 \uc644\uc804\ud55c WordPress REST API \uad6c\ud604\n * - WordPress \ucf54\uc5b4 \uc815\uc801 \uc790\uc0b0 \u2192 WordPress/WordPress \uacf5\uc2dd GitHub CDN\n * - \uc0ac\uc6a9\uc790 \ud14c\ub9c8/\ud50c\ub7ec\uadf8\uc778 \u2192 \uac1c\uc778 GitHub \ub808\ud3ec or jsDelivr CDN\n * - \uad00\ub9ac\uc790 UI \u2192 WordPress \uacf5\uc2dd \uad00\ub9ac\uc790 UI\uc640 100% \ub3d9\uc77c\ud55c \ub808\uc774\uc544\uc6c3\n * - \ubaa8\ub4e0 \ud50c\ub7ec\uadf8\uc778/\ud14c\ub9c8 \uc124\uce58 \uac00\ub2a5 (GitHub \ub808\ud3ec \uc5f0\ub3d9)\n * \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n *\n * \ubc14\uc778\ub529 (sites.js createCfWorkerWithBindings\uc5d0\uc11c \uc790\ub3d9 \uc5f0\uacb0):\n *   DB          : D1  - WordPress \ub370\uc774\ud130\ubca0\uc774\uc2a4\n *   SITE_DB     : D1  - \ub3d9\uc77c DB \ubcc4\uce6d\n *   CACHE       : KV  - \ud398\uc774\uc9c0/\uc790\uc0b0 \uce90\uc2dc\n *   KV          : KV  - \uc124\uce58 \uc0c1\ud0dc / \uc138\uc158\n *   SITE_ID     : plain_text\n *   GITHUB_OWNER: plain_text\n *   GITHUB_REPO : plain_text\n *   GITHUB_TOKEN: secret_text\n *   JWT_SECRET  : secret_text\n */\n\n// \u2500\u2500\u2500 \ud50c\ub808\uc774\uc2a4\ud640\ub354 (sites.js\uac00 \uce58\ud658) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst _INJECTED_SITE_ID      = \"%%SITE_ID%%\";\nconst _INJECTED_GITHUB_OWNER = \"%%GITHUB_OWNER%%\";\nconst _INJECTED_GITHUB_REPO  = \"%%GITHUB_REPO%%\";\n\n// \u2500\u2500\u2500 WordPress \uacf5\uc2dd \ucf54\uc5b4 \uc18c\uc2a4 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst WP_VER         = \"6.7.2\";\nconst WP_CORE_CDN    = `https://cdn.jsdelivr.net/npm/wordpress-static@${WP_VER}`;\nconst WP_GITHUB_RAW  = \"https://raw.githubusercontent.com/WordPress/WordPress/master\";\n\n// \u2500\u2500\u2500 \uc815\uc801 \ud30c\uc77c \ud655\uc7a5\uc790 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip|pdf|mp4|mp3|ogg|wav|webm|avif)$/i;\n\n// \u2500\u2500\u2500 CORS \ud5e4\ub354 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst CORS = {\n  \"Access-Control-Allow-Origin\":  \"*\",\n  \"Access-Control-Allow-Methods\": \"GET,POST,PUT,DELETE,PATCH,OPTIONS\",\n  \"Access-Control-Allow-Headers\": \"Content-Type,Authorization,X-Requested-With,X-WP-Nonce,X-WP-Nonce-Preview\",\n};\n\n// \u2500\u2500\u2500 \uc720\ud2f8 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nfunction siteId(env) { return env.SITE_ID || _INJECTED_SITE_ID; }\nfunction ghOwner(env) { return env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER; }\nfunction ghRepo(env)  { return env.GITHUB_REPO  || _INJECTED_GITHUB_REPO;  }\nfunction db(env)      { return env.DB || env.SITE_DB; }\nfunction kv(env)      { return env.CACHE || env.KV; }\n\nasync function kvGet(env, key) {\n  try { return await kv(env)?.get(key); } catch { return null; }\n}\nasync function kvSet(env, key, val, ttl = 3600) {\n  try { await kv(env)?.put(key, val, { expirationTtl: ttl }); } catch {}\n}\nasync function kvDel(env, key) {\n  try { await kv(env)?.delete(key); } catch {}\n}\n\nfunction json(data, status = 200, extra = {}) {\n  return new Response(JSON.stringify(data), {\n    status,\n    headers: { ...CORS, \"Content-Type\": \"application/json; charset=utf-8\", ...extra },\n  });\n}\nfunction html(body, status = 200, extra = {}) {\n  return new Response(body, {\n    status,\n    headers: { ...CORS, \"Content-Type\": \"text/html; charset=utf-8\", ...extra },\n  });\n}\nfunction respond(body, status = 200, ct = \"text/plain\", extra = {}) {\n  return new Response(body, { status, headers: { ...CORS, \"Content-Type\": ct, ...extra } });\n}\n\n// \u2500\u2500\u2500 \uac04\ub2e8\ud55c JWT (HS256) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nasync function jwtSign(payload, secret) {\n  const header  = btoa(JSON.stringify({ alg: \"HS256\", typ: \"JWT\" })).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  const body    = btoa(JSON.stringify(payload)).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  const data    = `${header}.${body}`;\n  const key     = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(secret), { name:\"HMAC\", hash:\"SHA-256\" }, false, [\"sign\"]);\n  const sig     = await crypto.subtle.sign(\"HMAC\", key, new TextEncoder().encode(data));\n  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  return `${data}.${sigB64}`;\n}\n\nasync function jwtVerify(token, secret) {\n  try {\n    const [h, b, s] = token.split(\".\");\n    const data = `${h}.${b}`;\n    const key  = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(secret), { name:\"HMAC\", hash:\"SHA-256\" }, false, [\"verify\"]);\n    const sig  = Uint8Array.from(atob(s.replace(/-/g,\"+\").replace(/_/g,\"/\")), c => c.charCodeAt(0));\n    const ok   = await crypto.subtle.verify(\"HMAC\", key, sig, new TextEncoder().encode(data));\n    if (!ok) return null;\n    const payload = JSON.parse(atob(b.replace(/-/g,\"+\").replace(/_/g,\"/\")));\n    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;\n    return payload;\n  } catch { return null; }\n}\n\nfunction getJwtSecret(env) {\n  return env.JWT_SECRET || \"cloudpress-fallback-secret-change-me\";\n}\n\nasync function getAuthUser(request, env) {\n  // 1) Authorization: Bearer <token>\n  const authHeader = request.headers.get(\"Authorization\") || \"\";\n  let token = authHeader.startsWith(\"Bearer \") ? authHeader.slice(7) : null;\n  // 2) Cookie: wp_token=<token>\n  if (!token) {\n    const cookie = request.headers.get(\"Cookie\") || \"\";\n    const m = cookie.match(/(?:^|;\\s*)wp_token=([^;]+)/);\n    if (m) token = decodeURIComponent(m[1]);\n  }\n  if (!token) return null;\n  return jwtVerify(token, getJwtSecret(env));\n}\n\n// \u2500\u2500\u2500 MD5 pure-JS \uad6c\ud604 (Cloudflare Workers\ub294 crypto.subtle.digest(\"MD5\") \ubbf8\uc9c0\uc6d0) \u2500\u2500\n// RFC 1321 \uae30\ubc18 MD5. phpass($P$) \uac80\uc99d/\uc0dd\uc131\uc5d0 \uc0ac\uc6a9.\n\nfunction md5Hash(data) {\n  const bytes = typeof data === \"string\" ? new TextEncoder().encode(data) : data;\n  // MD5 constants\n  const T = new Uint32Array(64);\n  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;\n  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,\n             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,\n             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,\n             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];\n  // Padding\n  const msgLen = bytes.length;\n  const bitLen = msgLen * 8;\n  const padLen = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);\n  const padded = new Uint8Array(msgLen + padLen + 8);\n  padded.set(bytes);\n  padded[msgLen] = 0x80;\n  const view = new DataView(padded.buffer);\n  view.setUint32(msgLen + padLen,     bitLen >>> 0,        true);\n  view.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);\n  // Process\n  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;\n  for (let i = 0; i < padded.length; i += 64) {\n    const M = new Uint32Array(16);\n    for (let j = 0; j < 16; j++) M[j] = view.getUint32(i + j * 4, true);\n    let [a, b, c, d] = [a0, b0, c0, d0];\n    for (let j = 0; j < 64; j++) {\n      let f, g;\n      if      (j < 16) { f = (b & c) | (~b & d);           g = j; }\n      else if (j < 32) { f = (d & b) | (~d & c);           g = (5*j+1)%16; }\n      else if (j < 48) { f = b ^ c ^ d;                    g = (3*j+5)%16; }\n      else             { f = c ^ (b | ~d);                  g = (7*j)%16; }\n      f = (f + a + T[j] + M[g]) >>> 0;\n      a = d; d = c; c = b;\n      b = (b + ((f << S[j]) | (f >>> (32 - S[j])))) >>> 0;\n    }\n    a0=(a0+a)>>>0; b0=(b0+b)>>>0; c0=(c0+c)>>>0; d0=(d0+d)>>>0;\n  }\n  const out = new Uint8Array(16);\n  const ov  = new DataView(out.buffer);\n  ov.setUint32(0,  a0, true); ov.setUint32(4,  b0, true);\n  ov.setUint32(8,  c0, true); ov.setUint32(12, d0, true);\n  return out;\n}\n\n// \u2500\u2500\u2500 phpass \ud638\ud658 \ube44\ubc00\ubc88\ud638 \uac80\uc99d/\uc0dd\uc131 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nconst ITOA64 = \"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\";\n\nfunction encode64(src, count) {\n  let output = \"\";\n  let i = 0;\n  while (i < count) {\n    let value = src[i++];\n    output += ITOA64[value & 0x3f];\n    if (i < count) value |= src[i] << 8;\n    output += ITOA64[(value >> 6) & 0x3f];\n    if (i++ >= count) break;\n    if (i < count) value |= src[i] << 16;\n    output += ITOA64[(value >> 12) & 0x3f];\n    if (i++ >= count) break;\n    output += ITOA64[(value >> 18) & 0x3f];\n  }\n  return output;\n}\n\nfunction phpassCheck(password, hash) {\n  if (hash.startsWith(\"$P$\") || hash.startsWith(\"$H$\")) {\n    const countLog2 = ITOA64.indexOf(hash[3]);\n    const salt      = hash.slice(4, 12);\n    let count       = 1 << countLog2;\n    const passBytes = new TextEncoder().encode(password);\n    let h = md5Hash(salt + password);\n    while (count--) {\n      const c = new Uint8Array(h.length + passBytes.length);\n      c.set(h); c.set(passBytes, h.length);\n      h = md5Hash(c);\n    }\n    return (hash.slice(0, 12) + encode64(h, 16)) === hash;\n  }\n  // MD5 plain (legacy)\n  if (hash.length === 32 && /^[0-9a-f]{32}$/.test(hash)) {\n    const h = md5Hash(password);\n    return Array.from(h).map(b => b.toString(16).padStart(2,\"0\")).join(\"\") === hash;\n  }\n  return false;\n}\n\nfunction phpassCreate(password) {\n  const countLog2 = 8; // 2^8 = 256 iterations\n  const chars = \"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./\";\n  const rnd   = new Uint8Array(8);\n  crypto.getRandomValues(rnd);\n  let salt = \"\";\n  for (const b of rnd) salt += chars[b % chars.length];\n  const prefix    = `$P$${ITOA64[countLog2]}${salt}`;\n  let count       = 1 << countLog2;\n  const passBytes = new TextEncoder().encode(password);\n  let h = md5Hash(salt + password);\n  while (count--) {\n    const c = new Uint8Array(h.length + passBytes.length);\n    c.set(h); c.set(passBytes, h.length);\n    h = md5Hash(c);\n  }\n  return prefix + encode64(h, 16);\n}\n\n// \u2500\u2500\u2500 WordPress \uc124\uce58 \ud655\uc778 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nasync function isWpInstalled(env) {\n  const flag = await kvGet(env, `wp:installed:${siteId(env)}`);\n  if (flag === \"1\") return true;\n  const d = db(env);\n  if (!d) return false;\n  try {\n    const r = await d.prepare(\"SELECT option_value FROM wp_options WHERE option_name='siteurl' LIMIT 1\").first();\n    if (r?.option_value) {\n      await kvSet(env, `wp:installed:${siteId(env)}`, \"1\", 86400);\n      return true;\n    }\n  } catch {}\n  return false;\n}\n\n// \u2500\u2500\u2500 WordPress DB \uc790\ub3d9 \ucd08\uae30\ud654 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n// DB\uac00 \uc5f0\uacb0\ub3fc \uc788\uc9c0\ub9cc \ud14c\uc774\ube14\uc774 \uc5c6\uc744 \ub54c \uc790\ub3d9\uc73c\ub85c \uc2a4\ud0a4\ub9c8+\uae30\ubcf8 \ub370\uc774\ud130\ub97c \uc0bd\uc785\ud569\ub2c8\ub2e4.\n\nasync function autoInstallWordPress(env, url) {\n  const d = db(env);\n  if (!d) return false; // DB \ubc14\uc778\ub529 \uc790\uccb4\uac00 \uc5c6\uc73c\uba74 \ubd88\uac00\n\n  const siteUrl   = `${url.protocol}//${url.host}`;\n  const sid       = siteId(env);\n  const now       = new Date().toISOString().replace(\"T\", \" \").slice(0, 19);\n  // \uc0ac\uc6a9\uc790\uac00 \ud638\uc2a4\ud305 \uc0dd\uc131 \uc2dc \uc785\ub825\ud55c \uad00\ub9ac\uc790 \uc815\ubcf4\ub97c Worker \ud658\uacbd\ubcc0\uc218\uc5d0\uc11c \uc77d\uc74c\n  const adminUser  = env.WP_ADMIN_USER  || \"admin\";\n  const adminPass  = env.WP_ADMIN_PASS  || crypto.randomUUID().slice(0, 12);\n  const adminEmail = env.WP_ADMIN_EMAIL || `admin@${url.host}`;\n\n  try {\n    // \u2500\u2500 1. \ud14c\uc774\ube14 \uc0dd\uc131 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    const schema = [\n      `CREATE TABLE IF NOT EXISTS wp_options (\n        option_id   INTEGER PRIMARY KEY AUTOINCREMENT,\n        option_name TEXT UNIQUE NOT NULL,\n        option_value TEXT NOT NULL DEFAULT '',\n        autoload    TEXT NOT NULL DEFAULT 'yes'\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_users (\n        ID            INTEGER PRIMARY KEY AUTOINCREMENT,\n        user_login    TEXT NOT NULL DEFAULT '',\n        user_pass     TEXT NOT NULL DEFAULT '',\n        user_nicename TEXT NOT NULL DEFAULT '',\n        user_email    TEXT NOT NULL DEFAULT '',\n        user_url      TEXT NOT NULL DEFAULT '',\n        user_registered TEXT NOT NULL DEFAULT '',\n        user_activation_key TEXT NOT NULL DEFAULT '',\n        user_status   INTEGER NOT NULL DEFAULT 0,\n        display_name  TEXT NOT NULL DEFAULT ''\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_usermeta (\n        umeta_id  INTEGER PRIMARY KEY AUTOINCREMENT,\n        user_id   INTEGER NOT NULL DEFAULT 0,\n        meta_key  TEXT,\n        meta_value TEXT\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_posts (\n        ID                    INTEGER PRIMARY KEY AUTOINCREMENT,\n        post_author           INTEGER NOT NULL DEFAULT 0,\n        post_date             TEXT NOT NULL DEFAULT '',\n        post_date_gmt         TEXT NOT NULL DEFAULT '',\n        post_content          TEXT NOT NULL DEFAULT '',\n        post_title            TEXT NOT NULL DEFAULT '',\n        post_excerpt          TEXT NOT NULL DEFAULT '',\n        post_status           TEXT NOT NULL DEFAULT 'publish',\n        comment_status        TEXT NOT NULL DEFAULT 'open',\n        ping_status           TEXT NOT NULL DEFAULT 'open',\n        post_password         TEXT NOT NULL DEFAULT '',\n        post_name             TEXT NOT NULL DEFAULT '',\n        to_ping               TEXT NOT NULL DEFAULT '',\n        pinged                TEXT NOT NULL DEFAULT '',\n        post_modified         TEXT NOT NULL DEFAULT '',\n        post_modified_gmt     TEXT NOT NULL DEFAULT '',\n        post_content_filtered TEXT NOT NULL DEFAULT '',\n        post_parent           INTEGER NOT NULL DEFAULT 0,\n        guid                  TEXT NOT NULL DEFAULT '',\n        menu_order            INTEGER NOT NULL DEFAULT 0,\n        post_type             TEXT NOT NULL DEFAULT 'post',\n        post_mime_type        TEXT NOT NULL DEFAULT '',\n        comment_count         INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_postmeta (\n        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        post_id    INTEGER NOT NULL DEFAULT 0,\n        meta_key   TEXT,\n        meta_value TEXT\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_terms (\n        term_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        name       TEXT NOT NULL DEFAULT '',\n        slug       TEXT NOT NULL DEFAULT '',\n        term_group INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (\n        term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        term_id          INTEGER NOT NULL DEFAULT 0,\n        taxonomy         TEXT NOT NULL DEFAULT '',\n        description      TEXT NOT NULL DEFAULT '',\n        parent           INTEGER NOT NULL DEFAULT 0,\n        count            INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_term_relationships (\n        object_id        INTEGER NOT NULL DEFAULT 0,\n        term_taxonomy_id INTEGER NOT NULL DEFAULT 0,\n        term_order       INTEGER NOT NULL DEFAULT 0,\n        PRIMARY KEY (object_id, term_taxonomy_id)\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_comments (\n        comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,\n        comment_post_ID      INTEGER NOT NULL DEFAULT 0,\n        comment_author       TEXT NOT NULL DEFAULT '',\n        comment_author_email TEXT NOT NULL DEFAULT '',\n        comment_author_url   TEXT NOT NULL DEFAULT '',\n        comment_author_IP    TEXT NOT NULL DEFAULT '',\n        comment_date         TEXT NOT NULL DEFAULT '',\n        comment_date_gmt     TEXT NOT NULL DEFAULT '',\n        comment_content      TEXT NOT NULL DEFAULT '',\n        comment_karma        INTEGER NOT NULL DEFAULT 0,\n        comment_approved     TEXT NOT NULL DEFAULT '1',\n        comment_agent        TEXT NOT NULL DEFAULT '',\n        comment_type         TEXT NOT NULL DEFAULT 'comment',\n        comment_parent       INTEGER NOT NULL DEFAULT 0,\n        user_id              INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_commentmeta (\n        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        comment_id INTEGER NOT NULL DEFAULT 0,\n        meta_key   TEXT,\n        meta_value TEXT\n      )`,\n    ];\n\n    for (const sql of schema) {\n      await d.prepare(sql).run();\n    }\n\n    // \u2500\u2500 2. \uad00\ub9ac\uc790 \uc0ac\uc6a9\uc790 \uc0dd\uc131 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    // phpassCreate()\ub85c \uc815\uc0c1 WordPress \ud638\ud658 \ud574\uc2dc \uc0dd\uc131\n    const hashedPass = phpassCreate(adminPass);\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_users\n        (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name)\n       VALUES (?,?,?,?,?,?,0,?)`\n    ).bind(adminUser, hashedPass, adminUser, adminEmail, siteUrl, now, adminUser).run();\n\n    const adminRow = await d.prepare(\"SELECT ID FROM wp_users WHERE user_login='admin' LIMIT 1\").first();\n    const adminId  = adminRow?.ID || 1;\n\n    // \uc0ac\uc6a9\uc790 \uba54\ud0c0 (\uc5ed\ud560)\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"wp_capabilities\", `a:1:{s:13:\"administrator\";b:1;}`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"wp_user_level\", \"10\").run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"admin_color\", \"fresh\").run();\n\n    // \u2500\u2500 3. WordPress \uae30\ubcf8 \uc635\uc158 \uc0bd\uc785 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    const options = [\n      [\"siteurl\",          siteUrl],\n      [\"blogname\",         \"\ub0b4 WordPress \uc0ac\uc774\ud2b8\"],\n      [\"blogdescription\",  \"CloudPress\ub85c \ub9cc\ub4e0 WordPress\"],\n      [\"admin_email\",      adminEmail],\n      [\"blogpublic\",       \"1\"],\n      [\"blog_charset\",     \"UTF-8\"],\n      [\"date_format\",      \"Y\ub144 n\uc6d4 j\uc77c\"],\n      [\"time_format\",      \"A g:i\"],\n      [\"start_of_week\",    \"0\"],\n      [\"timezone_string\",  \"Asia/Seoul\"],\n      [\"permalink_structure\", \"/%postname%/\"],\n      [\"template\",         \"twentytwentyfour\"],\n      [\"stylesheet\",       \"twentytwentyfour\"],\n      [\"current_theme\",    \"Twenty Twenty-Four\"],\n      [\"active_plugins\",   \"a:0:{}\"],\n      [\"wp_user_roles\",    `a:1:{s:13:\"administrator\";a:2:{s:4:\"name\";s:13:\"Administrator\";s:12:\"capabilities\";a:1:{s:13:\"administrator\";b:1;}}}`],\n      [\"wp_installed_version\", \"6.7.2\"],\n      [\"db_version\",       \"57155\"],\n      [\"initial_db_version\", \"57155\"],\n      [\"_site_transient_update_core\", \"\"],\n      [\"cp_auto_installed\", \"1\"],\n      [\"cp_installed_at\",  now],\n      [\"cp_admin_pass\",    adminPass],\n      [\"cp_admin_user\",    adminUser],\n      [\"cp_admin_email\",   adminEmail],\n    ];\n\n    for (const [k, v] of options) {\n      await d.prepare(\n        `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES (?,?,'yes')`\n      ).bind(k, v).run();\n    }\n\n    // \u2500\u2500 4. \uae30\ubcf8 \uac8c\uc2dc\ubb3c/\ud398\uc774\uc9c0 \uc0dd\uc131 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    const helloPostId = await d.prepare(\n      `INSERT OR IGNORE INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,\n         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      adminId, now, now,\n      \"WordPress\uc5d0 \uc624\uc2e0 \uac83\uc744 \ud658\uc601\ud569\ub2c8\ub2e4! CloudPress\ub85c \uad6c\ub3d9\ub418\ub294 \uc774 \uc0ac\uc774\ud2b8\ub97c \uc790\uc720\ub86d\uac8c \uc218\uc815\ud558\uace0 \uafb8\uba70\ubcf4\uc138\uc694.\",\n      \"\uc548\ub155\ud558\uc138\uc694!\", \"publish\", \"hello-world\", now, now, \"post\",\n      `${siteUrl}/?p=1`, \"open\", \"open\"\n    ).run();\n\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,\n         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      adminId, now, now,\n      \"\uc774 \ud398\uc774\uc9c0\ub294 \uc0d8\ud50c \ud398\uc774\uc9c0\uc785\ub2c8\ub2e4. CloudPress \uad00\ub9ac\uc790 \ud328\ub110\uc5d0\uc11c \uc790\uc720\ub86d\uac8c \uc218\uc815\ud558\uc138\uc694.\",\n      \"\uc0d8\ud50c \ud398\uc774\uc9c0\", \"publish\", \"sample-page\", now, now, \"page\",\n      `${siteUrl}/?page_id=2`, \"closed\", \"open\"\n    ).run();\n\n    // \u2500\u2500 5. \uae30\ubcf8 \uce74\ud14c\uace0\ub9ac \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    await d.prepare(`INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1,'\ubbf8\ubd84\ub958','uncategorized',0)`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1,1,'category','',0,1)`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id) VALUES (1,1)`).run();\n\n    // \u2500\u2500 6. \uc0d8\ud50c \ub313\uae00 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_comments\n        (comment_post_ID, comment_author, comment_author_email, comment_author_url,\n         comment_content, comment_date, comment_date_gmt, comment_approved, comment_type, user_id)\n       VALUES (?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      1, \"CloudPress\", \"support@cloudpress.com\", \"https://cloudpress.com\",\n      \"WordPress \uc0ac\uc774\ud2b8\uac00 \uc131\uacf5\uc801\uc73c\ub85c \uc0dd\uc131\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc774 \ub313\uae00\uc744 \uc0ad\uc81c\ud558\uace0 \uc0c8 \uae00\uc744 \uc791\uc131\ud574\ubcf4\uc138\uc694!\",\n      now, now, \"1\", \"comment\", 0\n    ).run();\n\n    // \u2500\u2500 7. \uc124\uce58 \uc644\ub8cc \ud50c\ub798\uadf8 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    await kvSet(env, `wp:installed:${sid}`, \"1\", 86400 * 30);\n\n    console.log(`[CloudPress] WordPress \uc790\ub3d9 \uc124\uce58 \uc644\ub8cc (site: ${sid}, url: ${siteUrl})`);\n    return true;\n\n  } catch (e) {\n    console.error(\"[CloudPress] \uc790\ub3d9 \uc124\uce58 \uc2e4\ud328:\", e.message);\n    return false;\n  }\n}\n\n// \u2500\u2500\u2500 WP Option \ud5ec\ud37c \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nasync function getOption(env, name) {\n  try {\n    const r = await db(env).prepare(\"SELECT option_value FROM wp_options WHERE option_name=? LIMIT 1\").bind(name).first();\n    return r?.option_value ?? null;\n  } catch { return null; }\n}\n\nasync function setOption(env, name, value) {\n  try {\n    await db(env).prepare(\"INSERT INTO wp_options(option_name,option_value,autoload) VALUES(?,?,'yes') ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value\").bind(name, value).run();\n    await kvDel(env, `opt:${name}`);\n  } catch {}\n}\n\n// \u2500\u2500\u2500 GitHub \uc790\uc0b0 \uc11c\ube59 (\ud14c\ub9c8/\ud50c\ub7ec\uadf8\uc778 from \uac1c\uc778 \ub808\ud3ec) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nasync function serveGithubAsset(env, repoPath) {\n  const owner = ghOwner(env);\n  const repo  = ghRepo(env);\n  if (!owner || !repo) return null;\n  const token = env.GITHUB_TOKEN || \"\";\n  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;\n  const headers = { \"User-Agent\": \"CloudPress/6.0\" };\n  if (token) headers[\"Authorization\"] = `Bearer ${token}`;\n  const res = await fetch(url, { headers, cf: { cacheEverything: true, cacheTtl: 3600 } });\n  if (!res.ok) return null;\n  const ct   = res.headers.get(\"Content-Type\") || \"application/octet-stream\";\n  const body = await res.arrayBuffer();\n  return new Response(body, {\n    headers: { ...CORS, \"Content-Type\": ct, \"Cache-Control\": \"public, max-age=3600\", \"X-Source\": \"github-user-repo\" },\n  });\n}\n\n// \u2500\u2500\u2500 WordPress \ucf54\uc5b4 \uc815\uc801 \uc790\uc0b0 \uc11c\ube59 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n// \ud30c\uc77c \ud655\uc7a5\uc790\ub85c \uc62c\ubc14\ub978 Content-Type \uacb0\uc815\nfunction mimeByExt(path) {\n  if (path.endsWith(\".css\"))   return \"text/css; charset=utf-8\";\n  if (path.endsWith(\".js\"))    return \"application/javascript; charset=utf-8\";\n  if (path.endsWith(\".svg\"))   return \"image/svg+xml\";\n  if (path.endsWith(\".png\"))   return \"image/png\";\n  if (path.endsWith(\".jpg\") || path.endsWith(\".jpeg\")) return \"image/jpeg\";\n  if (path.endsWith(\".gif\"))   return \"image/gif\";\n  if (path.endsWith(\".webp\"))  return \"image/webp\";\n  if (path.endsWith(\".ico\"))   return \"image/x-icon\";\n  if (path.endsWith(\".woff\"))  return \"font/woff\";\n  if (path.endsWith(\".woff2\")) return \"font/woff2\";\n  if (path.endsWith(\".ttf\"))   return \"font/ttf\";\n  if (path.endsWith(\".json\"))  return \"application/json; charset=utf-8\";\n  if (path.endsWith(\".xml\"))   return \"application/xml; charset=utf-8\";\n  return null; // \uc11c\ubc84 \uc751\ub2f5 \uadf8\ub300\ub85c \uc0ac\uc6a9\n}\n\nasync function serveCoreAsset(filePath) {\n  // jsDelivr CDN \uc6b0\uc120 (\ube60\ub984) - \uc62c\ubc14\ub978 Content-Type \uc11c\ube59\n  // raw.githubusercontent.com\uc740 text/plain\uc73c\ub85c \uc751\ub2f5\ud574 CSS/JS\uac00 \uc801\uc6a9 \uc548 \ub428\n  const urls = [\n    `${WP_CORE_CDN}/${filePath}`,\n    `${WP_GITHUB_RAW}/${filePath}`,\n  ];\n  for (const url of urls) {\n    try {\n      const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });\n      if (res.ok) {\n        const body = await res.arrayBuffer();\n        // \ud655\uc7a5\uc790 \uae30\ubc18 Content-Type \uac15\uc81c \uc124\uc815 (raw.githubusercontent.com \ub300\uc751)\n        const ct = mimeByExt(filePath) || res.headers.get(\"Content-Type\") || \"application/octet-stream\";\n        return new Response(body, {\n          headers: {\n            ...CORS, \"Content-Type\": ct,\n            \"Cache-Control\": \"public, max-age=86400, immutable\",\n            \"X-Source\": \"wp-core-cdn\",\n          },\n        });\n      }\n    } catch {}\n  }\n  return null;\n}\n\n// \u2500\u2500\u2500 WordPress REST API v2 \uad6c\ud604 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nclass WpRestApi {\n  constructor(env, user) {\n    this.env  = env;\n    this.user = user; // authenticated user payload or null\n    this.d    = db(env);\n  }\n\n  // \u2500\u2500 Posts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getPosts(params = {}) {\n    const {\n      per_page = 10, page = 1, status = \"publish\",\n      type = \"post\", search = \"\", author = 0,\n      categories = \"\", tags = \"\", orderby = \"date\", order = \"desc\",\n      slug = \"\", _fields = \"\",\n    } = params;\n\n    const offset = (parseInt(page)-1) * parseInt(per_page);\n    const conditions = [];\n    const binds = [];\n\n    if (status === \"any\") {\n      conditions.push(\"post_status NOT IN ('auto-draft','trash')\");\n    } else {\n      const statuses = status.split(\",\").map(s => s.trim()).filter(Boolean);\n      if (statuses.length === 1) {\n        conditions.push(\"post_status=?\"); binds.push(statuses[0]);\n      } else {\n        conditions.push(`post_status IN (${statuses.map(()=>\"?\").join(\",\")})`);\n        binds.push(...statuses);\n      }\n    }\n    conditions.push(\"post_type=?\"); binds.push(type);\n\n    if (slug) { conditions.push(\"post_name=?\"); binds.push(slug); }\n    if (search) { conditions.push(\"(post_title LIKE ? OR post_content LIKE ?)\"); binds.push(`%${search}%`, `%${search}%`); }\n    if (author) { conditions.push(\"post_author=?\"); binds.push(parseInt(author)); }\n\n    const where = conditions.length ? \"WHERE \" + conditions.join(\" AND \") : \"\";\n    const orderSql = `ORDER BY ${orderby === \"title\" ? \"post_title\" : \"post_date\"} ${order.toUpperCase() === \"ASC\" ? \"ASC\" : \"DESC\"}`;\n\n    const countRow = await this.d.prepare(`SELECT COUNT(*) as cnt FROM wp_posts ${where}`).bind(...binds).first();\n    const total = countRow?.cnt || 0;\n\n    const rows = await this.d.prepare(\n      `SELECT * FROM wp_posts ${where} ${orderSql} LIMIT ? OFFSET ?`\n    ).bind(...binds, parseInt(per_page), offset).all();\n\n    const posts = await Promise.all((rows.results || []).map(p => this._formatPost(p)));\n    return { posts, total, pages: Math.ceil(total / parseInt(per_page)) };\n  }\n\n  async getPost(id) {\n    const isSlug = isNaN(parseInt(id));\n    const row = isSlug\n      ? await this.d.prepare(\"SELECT * FROM wp_posts WHERE post_name=? LIMIT 1\").bind(id).first()\n      : await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=? LIMIT 1\").bind(parseInt(id)).first();\n    if (!row) return null;\n    return this._formatPost(row);\n  }\n\n  async createPost(data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const {\n      title = \"\", content = \"\", excerpt = \"\", status = \"draft\",\n      type = \"post\", slug = \"\", comment_status = \"open\",\n      ping_status = \"open\", categories = [1], tags = [], meta = {},\n      featured_media = 0, parent = 0, menu_order = 0,\n      date = now, template = \"\",\n    } = data;\n\n    const postName = slug || this._slugify(title || \"post\");\n    const res = await this.d.prepare(\n      `INSERT INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,\n         post_status, comment_status, ping_status, post_name, post_type,\n         post_modified, post_modified_gmt, guid, menu_order, post_parent)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      this.user.id || 1, date, date, content, title, excerpt,\n      status, comment_status, ping_status, postName, type,\n      now, now, \"\", menu_order, parent\n    ).run();\n\n    const postId = res.meta?.last_row_id;\n    if (!postId) throw new Error(\"Insert failed\");\n\n    // Update guid\n    const siteUrl = await getOption(this.env, \"siteurl\") || \"\";\n    await this.d.prepare(\"UPDATE wp_posts SET guid=? WHERE ID=?\").bind(`${siteUrl}/?p=${postId}`, postId).run();\n\n    // Categories\n    for (const catId of (Array.isArray(categories) ? categories : [1])) {\n      const tt = await this.d.prepare(\"SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy='category'\").bind(catId).first();\n      if (tt) {\n        await this.d.prepare(\"INSERT OR IGNORE INTO wp_term_relationships(object_id,term_taxonomy_id) VALUES(?,?)\").bind(postId, tt.term_taxonomy_id).run();\n        await this.d.prepare(\"UPDATE wp_term_taxonomy SET count=count+1 WHERE term_taxonomy_id=?\").bind(tt.term_taxonomy_id).run();\n      }\n    }\n\n    // Meta\n    for (const [k, v] of Object.entries(meta)) {\n      await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(postId, k, String(v)).run();\n    }\n\n    await this._invalidateCache();\n    return this.getPost(postId);\n  }\n\n  async updatePost(id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const existing = await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=?\").bind(parseInt(id)).first();\n    if (!existing) throw new Error(\"Not Found\");\n\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const updates = {};\n    if (data.title   !== undefined) updates.post_title   = data.title;\n    if (data.content !== undefined) updates.post_content = data.content;\n    if (data.excerpt !== undefined) updates.post_excerpt = data.excerpt;\n    if (data.status  !== undefined) updates.post_status  = data.status;\n    if (data.slug    !== undefined) updates.post_name    = data.slug || this._slugify(data.title || existing.post_title);\n    if (data.date    !== undefined) updates.post_date    = data.date;\n    if (data.comment_status !== undefined) updates.comment_status = data.comment_status;\n    updates.post_modified     = now;\n    updates.post_modified_gmt = now;\n\n    const keys = Object.keys(updates);\n    const vals = Object.values(updates);\n    await this.d.prepare(\n      `UPDATE wp_posts SET ${keys.map(k=>`${k}=?`).join(\",\")} WHERE ID=?`\n    ).bind(...vals, parseInt(id)).run();\n\n    // Meta\n    if (data.meta) {\n      for (const [k, v] of Object.entries(data.meta)) {\n        await this.d.prepare(\n          \"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING\"\n        ).bind(parseInt(id), k, String(v)).run();\n      }\n    }\n\n    await this._invalidateCache();\n    return this.getPost(id);\n  }\n\n  async deletePost(id, force = false) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    if (force) {\n      await this.d.prepare(\"DELETE FROM wp_posts WHERE ID=?\").bind(parseInt(id)).run();\n      await this.d.prepare(\"DELETE FROM wp_postmeta WHERE post_id=?\").bind(parseInt(id)).run();\n      await this.d.prepare(\"DELETE FROM wp_term_relationships WHERE object_id=?\").bind(parseInt(id)).run();\n    } else {\n      await this.d.prepare(\"UPDATE wp_posts SET post_status='trash' WHERE ID=?\").bind(parseInt(id)).run();\n    }\n    await this._invalidateCache();\n    return { deleted: true, id: parseInt(id) };\n  }\n\n  async _formatPost(row) {\n    if (!row) return null;\n    const siteUrl = await getOption(this.env, \"siteurl\") || \"\";\n\n    // Meta\n    const metaRows = await this.d.prepare(\"SELECT meta_key,meta_value FROM wp_postmeta WHERE post_id=?\").bind(row.ID).all();\n    const meta = {};\n    for (const m of (metaRows.results || [])) meta[m.meta_key] = m.meta_value;\n\n    // Categories\n    const catRows = await this.d.prepare(\n      `SELECT t.term_id, t.name, t.slug\n       FROM wp_terms t\n       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id\n       WHERE tr.object_id=? AND tt.taxonomy='category'`\n    ).bind(row.ID).all();\n\n    // Tags\n    const tagRows = await this.d.prepare(\n      `SELECT t.term_id, t.name, t.slug\n       FROM wp_terms t\n       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id\n       WHERE tr.object_id=? AND tt.taxonomy='post_tag'`\n    ).bind(row.ID).all();\n\n    // Author\n    const author = await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(row.post_author).first();\n\n    const slug     = row.post_name || String(row.ID);\n    const postLink = `${siteUrl}/${slug}/`;\n\n    return {\n      id:             row.ID,\n      date:           row.post_date,\n      date_gmt:       row.post_date_gmt,\n      modified:       row.post_modified,\n      modified_gmt:   row.post_modified_gmt,\n      slug,\n      status:         row.post_status,\n      type:           row.post_type,\n      link:           postLink,\n      title:          { rendered: row.post_title || \"\" },\n      content:        { rendered: this._renderBlocks(row.post_content || \"\"), raw: row.post_content || \"\", protected: false },\n      excerpt:        { rendered: row.post_excerpt || \"\", protected: false },\n      author:         row.post_author,\n      featured_media: parseInt(meta._thumbnail_id || 0),\n      comment_status: row.comment_status,\n      ping_status:    row.ping_status,\n      format:         \"standard\",\n      meta,\n      sticky:         false,\n      template:       meta._wp_page_template || \"\",\n      categories:     (catRows.results || []).map(c => c.term_id),\n      tags:           (tagRows.results || []).map(t => t.term_id),\n      _embedded: {\n        author: author ? [this._formatUser(author)] : [],\n        \"wp:term\": [\n          (catRows.results || []).map(c => ({ id: c.term_id, name: c.name, slug: c.slug, taxonomy: \"category\" })),\n          (tagRows.results || []).map(t => ({ id: t.term_id, name: t.name, slug: t.slug, taxonomy: \"post_tag\" })),\n        ],\n      },\n    };\n  }\n\n  // \u2500\u2500 Gutenberg \ube14\ub85d \ub80c\ub354\ub9c1 (\uae30\ubcf8 \ube14\ub85d\ub9cc) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  _renderBlocks(content) {\n    if (!content) return \"\";\n    // \uc774\ubbf8 HTML\uc774\uba74 \uadf8\ub300\ub85c \ubc18\ud658, \ube14\ub85d \ucf54\uba58\ud2b8 \uc81c\uac70\n    return content\n      .replace(/<!-- wp:[^>]+ \\/-->/g, \"\")\n      .replace(/<!-- wp:[^\\n]* -->/g, \"\")\n      .replace(/<!-- \\/wp:[^\\n]* -->/g, \"\")\n      .trim();\n  }\n\n  _slugify(text) {\n    return text\n      .toLowerCase()\n      .replace(/[^a-z0-9\uac00-\ud7a3\u3131-\u314e\u314f-\u3163\\s-]/g, \"\")\n      .replace(/\\s+/g, \"-\")\n      .replace(/-+/g, \"-\")\n      .slice(0, 200) || `post-${Date.now()}`;\n  }\n\n  // \u2500\u2500 Users \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  _formatUser(row) {\n    return {\n      id:          row.ID,\n      name:        row.display_name || row.user_login,\n      url:         row.user_url || \"\",\n      description: \"\",\n      link:        \"\",\n      slug:        row.user_nicename || row.user_login,\n      avatar_urls: { 96: `https://www.gravatar.com/avatar/${row.user_email ? this._md5str(row.user_email) : \"\"}?s=96&d=mm` },\n    };\n  }\n\n  _md5str(s) {\n    // \uac04\ub2e8 Gravatar\uc6a9 - \uc2e4\uc81c MD5 \ubd88\ud544\uc694, \uc774\uba54\uc77c \ud574\uc2dc\n    return s.trim().toLowerCase();\n  }\n\n  async getUsers(params = {}) {\n    const { per_page = 10, page = 1 } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const rows = await this.d.prepare(\"SELECT * FROM wp_users ORDER BY ID LIMIT ? OFFSET ?\").bind(parseInt(per_page), offset).all();\n    return (rows.results || []).map(u => this._formatUser(u));\n  }\n\n  async getUser(id) {\n    const row = id === \"me\"\n      ? (this.user ? await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(this.user.id).first() : null)\n      : await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(parseInt(id)).first();\n    if (!row) return null;\n    const caps = await this.d.prepare(\"SELECT meta_value FROM wp_usermeta WHERE user_id=? AND meta_key='wp_capabilities'\").bind(row.ID).first();\n    const roles = caps?.meta_value?.includes(\"administrator\") ? [\"administrator\"] : [\"subscriber\"];\n    return { ...this._formatUser(row), roles, capabilities: Object.fromEntries(roles.map(r=>[r,true])) };\n  }\n\n  async updateUser(id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const userId = id === \"me\" ? this.user.id : parseInt(id);\n    if (this.user.id !== userId && this.user.role !== \"administrator\") throw new Error(\"Forbidden\");\n\n    const updates = {};\n    if (data.name)         updates.display_name   = data.name;\n    if (data.email)        updates.user_email      = data.email;\n    if (data.url)          updates.user_url        = data.url;\n    if (data.description)  updates.user_url        = data.url; // store in meta\n    if (data.password) {\n      updates.user_pass = phpassCreate(data.password);\n      // Invalidate sessions\n      await this.d.prepare(\"DELETE FROM wp_usermeta WHERE user_id=? AND meta_key='session_tokens'\").bind(userId).run();\n    }\n    if (Object.keys(updates).length) {\n      const keys = Object.keys(updates);\n      await this.d.prepare(`UPDATE wp_users SET ${keys.map(k=>`${k}=?`).join(\",\")} WHERE ID=?`).bind(...Object.values(updates), userId).run();\n    }\n    if (data.description !== undefined) {\n      await this.d.prepare(\"INSERT INTO wp_usermeta(user_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING\").bind(userId, \"description\", data.description).run();\n    }\n    return this.getUser(id);\n  }\n\n  // \u2500\u2500 Terms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getTerms(taxonomy, params = {}) {\n    const { per_page = 100, page = 1, hide_empty = false, orderby = \"name\", order = \"asc\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond = hide_empty ? \"WHERE tt.taxonomy=? AND tt.count>0\" : \"WHERE tt.taxonomy=?\";\n    const rows = await this.d.prepare(\n      `SELECT t.*, tt.term_taxonomy_id, tt.count, tt.parent, tt.description\n       FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       ${cond}\n       ORDER BY t.${orderby===\"id\"?\"term_id\":\"name\"} ${order.toUpperCase()===\"ASC\"?\"ASC\":\"DESC\"}\n       LIMIT ? OFFSET ?`\n    ).bind(taxonomy, parseInt(per_page), offset).all();\n    return (rows.results || []).map(t => ({\n      id: t.term_id, count: t.count, description: t.description || \"\",\n      link: \"\", name: t.name, slug: t.slug, taxonomy,\n      parent: t.parent || 0, meta: [],\n    }));\n  }\n\n  async createTerm(taxonomy, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const { name, slug = \"\", description = \"\", parent = 0 } = data;\n    const termSlug = slug || this._slugify(name);\n    const existing = await this.d.prepare(\"SELECT term_id FROM wp_terms WHERE slug=?\").bind(termSlug).first();\n    if (existing) {\n      // Check if taxonomy entry exists\n      const tt = await this.d.prepare(\"SELECT * FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?\").bind(existing.term_id, taxonomy).first();\n      if (tt) return { id: existing.term_id, name, slug: termSlug, taxonomy, count: tt.count, description: tt.description || \"\", parent: tt.parent || 0 };\n    }\n    const termRes = existing\n      ? { meta: { last_row_id: existing.term_id } }\n      : await this.d.prepare(\"INSERT INTO wp_terms(name,slug,term_group) VALUES(?,?,0)\").bind(name, termSlug).run();\n    const termId = existing?.term_id || termRes.meta?.last_row_id;\n    const ttRes = await this.d.prepare(\"INSERT INTO wp_term_taxonomy(term_id,taxonomy,description,parent,count) VALUES(?,?,?,?,0)\").bind(termId, taxonomy, description, parseInt(parent)).run();\n    return { id: termId, name, slug: termSlug, taxonomy, count: 0, description, parent: parseInt(parent) };\n  }\n\n  async updateTerm(taxonomy, id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const { name, slug, description, parent } = data;\n    if (name || slug)        await this.d.prepare(\"UPDATE wp_terms SET name=COALESCE(?,name), slug=COALESCE(?,slug) WHERE term_id=?\").bind(name||null, slug||null, parseInt(id)).run();\n    if (description !== undefined || parent !== undefined) {\n      await this.d.prepare(\"UPDATE wp_term_taxonomy SET description=COALESCE(?,description), parent=COALESCE(?,parent) WHERE term_id=? AND taxonomy=?\")\n        .bind(description??null, parent??null, parseInt(id), taxonomy).run();\n    }\n    const t = await this.d.prepare(\"SELECT t.*, tt.count, tt.description, tt.parent FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE t.term_id=? AND tt.taxonomy=?\").bind(parseInt(id), taxonomy).first();\n    return t ? { id: t.term_id, name: t.name, slug: t.slug, taxonomy, count: t.count, description: t.description||\"\", parent: t.parent||0 } : null;\n  }\n\n  async deleteTerm(taxonomy, id) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    await this.d.prepare(\"DELETE FROM wp_term_relationships WHERE term_taxonomy_id IN (SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?)\").bind(parseInt(id), taxonomy).run();\n    await this.d.prepare(\"DELETE FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?\").bind(parseInt(id), taxonomy).run();\n    await this.d.prepare(\"DELETE FROM wp_terms WHERE term_id=? AND NOT EXISTS (SELECT 1 FROM wp_term_taxonomy WHERE term_id=?)\").bind(parseInt(id), parseInt(id)).run();\n    return { deleted: true, previous: { id: parseInt(id) } };\n  }\n\n  // \u2500\u2500 Media \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getMedia(params = {}) {\n    const { per_page = 10, page = 1, media_type = \"\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond = media_type ? \"AND post_mime_type LIKE ?\" : \"\";\n    const binds = media_type ? [`${media_type}%`] : [];\n    const rows = await this.d.prepare(\n      `SELECT * FROM wp_posts WHERE post_type='attachment' ${cond} ORDER BY post_date DESC LIMIT ? OFFSET ?`\n    ).bind(...binds, parseInt(per_page), offset).all();\n    return (rows.results || []).map(m => this._formatMedia(m));\n  }\n\n  async uploadMedia(env, request) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const ct = request.headers.get(\"Content-Type\") || \"\";\n    const cd = request.headers.get(\"Content-Disposition\") || \"\";\n    const filenamem = cd.match(/filename[^;=\\n]*=((['\"]).*?\\2|[^;\\n]*)/);\n    const filename = filenamem ? filenamem[1].replace(/['\"]/g, \"\") : `upload-${Date.now()}`;\n\n    const body = await request.arrayBuffer();\n    const mimeType = ct.split(\";\")[0].trim() || \"application/octet-stream\";\n\n    // GitHub\uc5d0 \ud30c\uc77c \uc800\uc7a5\n    const owner = ghOwner(env);\n    const repo  = ghRepo(env);\n    const token = env.GITHUB_TOKEN;\n\n    const now = new Date();\n    const year = now.getFullYear();\n    const month = String(now.getMonth()+1).padStart(2,\"0\");\n    const repoPath = `wp-content/uploads/${year}/${month}/${filename}`;\n    let fileUrl = \"\";\n\n    if (owner && repo && token) {\n      const b64 = btoa(String.fromCharCode(...new Uint8Array(body)));\n      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`, {\n        method: \"PUT\",\n        headers: {\n          \"Authorization\": `Bearer ${token}`,\n          \"Content-Type\": \"application/json\",\n          \"User-Agent\": \"CloudPress/6.0\",\n        },\n        body: JSON.stringify({ message: `Upload ${filename}`, content: b64 }),\n      });\n      if (res.ok) {\n        const data = await res.json();\n        fileUrl = data.content?.download_url || `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;\n      }\n    }\n\n    const siteUrl = await getOption(env, \"siteurl\") || \"\";\n    const now2 = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n\n    const res = await this.d.prepare(\n      `INSERT INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,\n         post_status, comment_status, ping_status, post_name, post_type, post_mime_type,\n         post_modified, post_modified_gmt, guid, menu_order)\n       VALUES (?,?,?,?,?,?,'inherit','open','open',?,?,'attachment',?,?,?,0) `\n    ).bind(this.user.id||1, now2, now2, \"\", filename, \"\", filename, \"attachment\", now2, now2, fileUrl || `${siteUrl}/${repoPath}`, now2).run();\n\n    const mediaId = res.meta?.last_row_id;\n    await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(mediaId, \"_wp_attached_file\", repoPath).run();\n    await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(mediaId, \"_wp_attachment_metadata\", JSON.stringify({ file: repoPath })).run();\n\n    const row = await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=?\").bind(mediaId).first();\n    return this._formatMedia(row);\n  }\n\n  _formatMedia(row) {\n    if (!row) return null;\n    return {\n      id: row.ID,\n      date: row.post_date,\n      slug: row.post_name,\n      status: row.post_status,\n      type: \"attachment\",\n      link: row.guid,\n      title: { rendered: row.post_title },\n      author: row.post_author,\n      caption: { rendered: row.post_excerpt || \"\" },\n      alt_text: \"\",\n      media_type: (row.post_mime_type || \"\").startsWith(\"image\") ? \"image\" : \"file\",\n      mime_type: row.post_mime_type || \"application/octet-stream\",\n      media_details: {},\n      source_url: row.guid || \"\",\n    };\n  }\n\n  // \u2500\u2500 Comments \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getComments(params = {}) {\n    const { post = 0, per_page = 10, page = 1, status = \"approve\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond = post ? \"WHERE comment_post_ID=? AND comment_approved=?\" : \"WHERE comment_approved=?\";\n    const binds = post ? [parseInt(post), status === \"approve\" ? \"1\" : status] : [status === \"approve\" ? \"1\" : status];\n    const rows = await this.d.prepare(\n      `SELECT * FROM wp_comments ${cond} ORDER BY comment_date DESC LIMIT ? OFFSET ?`\n    ).bind(...binds, parseInt(per_page), offset).all();\n    return (rows.results || []).map(c => this._formatComment(c));\n  }\n\n  async createComment(data) {\n    const { post, content, author_name = \"Anonymous\", author_email = \"\", author_url = \"\", parent = 0 } = data;\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const res = await this.d.prepare(\n      `INSERT INTO wp_comments\n        (comment_post_ID, comment_author, comment_author_email, comment_author_url,\n         comment_content, comment_date, comment_date_gmt, comment_approved, comment_parent, user_id)\n       VALUES (?,?,?,?,?,?,?,?,?,?)`\n    ).bind(parseInt(post), author_name, author_email, author_url, content, now, now, \"1\", parseInt(parent), this.user?.id||0).run();\n    const id = res.meta?.last_row_id;\n    await this.d.prepare(\"UPDATE wp_posts SET comment_count=comment_count+1 WHERE ID=?\").bind(parseInt(post)).run();\n    const row = await this.d.prepare(\"SELECT * FROM wp_comments WHERE comment_ID=?\").bind(id).first();\n    return this._formatComment(row);\n  }\n\n  _formatComment(row) {\n    return {\n      id: row.comment_ID,\n      post: row.comment_post_ID,\n      parent: row.comment_parent,\n      author: row.user_id || 0,\n      author_name: row.comment_author,\n      author_email: row.comment_author_email,\n      author_url: row.comment_author_url,\n      date: row.comment_date,\n      content: { rendered: row.comment_content },\n      status: row.comment_approved === \"1\" ? \"approved\" : \"hold\",\n    };\n  }\n\n  // \u2500\u2500 Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getSettings() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const opts = await this.d.prepare(\n      \"SELECT option_name,option_value FROM wp_options WHERE option_name IN (?,?,?,?,?,?,?,?,?,?,?,?,?)\"\n    ).bind(\"siteurl\",\"home\",\"blogname\",\"blogdescription\",\"admin_email\",\"posts_per_page\",\n      \"permalink_structure\",\"timezone_string\",\"date_format\",\"time_format\",\n      \"default_category\",\"template\",\"stylesheet\").all();\n    const s = {};\n    for (const r of (opts.results||[])) s[r.option_name] = r.option_value;\n    return {\n      title:              s.blogname || \"\",\n      description:        s.blogdescription || \"\",\n      url:                s.siteurl || \"\",\n      email:              s.admin_email || \"\",\n      timezone:           s.timezone_string || \"Asia/Seoul\",\n      date_format:        s.date_format || \"Y\ub144 n\uc6d4 j\uc77c\",\n      time_format:        s.time_format || \"A g:i\",\n      posts_per_page:     parseInt(s.posts_per_page) || 10,\n      default_category:   parseInt(s.default_category) || 1,\n      default_post_format:\"standard\",\n      language:           \"ko_KR\",\n      use_smilies:        true,\n      template:           s.template || \"twentytwentyfour\",\n      stylesheet:         s.stylesheet || \"twentytwentyfour\",\n      permalink_structure: s.permalink_structure || \"/%postname%/\",\n    };\n  }\n\n  async updateSettings(data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const map = {\n      title:           \"blogname\",\n      description:     \"blogdescription\",\n      email:           \"admin_email\",\n      timezone:        \"timezone_string\",\n      date_format:     \"date_format\",\n      time_format:     \"time_format\",\n      posts_per_page:  \"posts_per_page\",\n      default_category:\"default_category\",\n      permalink_structure:\"permalink_structure\",\n    };\n    for (const [k,v] of Object.entries(data)) {\n      if (map[k]) await setOption(this.env, map[k], String(v));\n    }\n    return this.getSettings();\n  }\n\n  // \u2500\u2500 Plugins \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getPlugins() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    let active = [];\n    // Parse PHP serialized array (simple)\n    const m = raw.match(/s:\\d+:\"([^\"]+)\"/g);\n    if (m) active = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean);\n\n    // Also list from GitHub repo\n    const owner = ghOwner(this.env);\n    const repo  = ghRepo(this.env);\n    const plugins = [];\n\n    if (owner && repo) {\n      try {\n        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/plugins`, {\n          headers: { \"Authorization\": `Bearer ${this.env.GITHUB_TOKEN}`, \"User-Agent\": \"CloudPress/6.0\" },\n        });\n        if (res.ok) {\n          const items = await res.json();\n          for (const item of (Array.isArray(items) ? items : [])) {\n            if (item.type === \"dir\") {\n              plugins.push({\n                plugin:      `${item.name}/${item.name}.php`,\n                status:      active.includes(`${item.name}/${item.name}.php`) ? \"active\" : \"inactive\",\n                name:        item.name,\n                plugin_uri:  \"\",\n                author:      \"\",\n                author_uri:  \"\",\n                description: { rendered: \"\" },\n                version:     \"\",\n                network_only:false,\n                requires_wp: \"6.0\",\n                requires_php:\"8.0\",\n                textdomain:  item.name,\n              });\n            }\n          }\n        }\n      } catch {}\n    }\n\n    // Add active plugins not in repo\n    for (const p of active) {\n      if (!plugins.find(x => x.plugin === p)) {\n        plugins.push({ plugin: p, status: \"active\", name: p.split(\"/\")[0], description: { rendered: \"\" }, version: \"\" });\n      }\n    }\n    return plugins;\n  }\n\n  async activatePlugin(plugin) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    let raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    const m = raw.match(/s:\\d+:\"[^\"]+\"/g) || [];\n    const current = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean);\n    if (!current.includes(plugin)) {\n      current.push(plugin);\n      const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:\"${p}\";`).join(\"\")}}`;\n      await setOption(this.env, \"active_plugins\", serialized);\n    }\n    return { plugin, status: \"active\" };\n  }\n\n  async deactivatePlugin(plugin) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    let raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    const m = raw.match(/s:\\d+:\"[^\"]+\"/g) || [];\n    const current = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean).filter(p => p !== plugin);\n    const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:\"${p}\";`).join(\"\")}}`;\n    await setOption(this.env, \"active_plugins\", serialized);\n    return { plugin, status: \"inactive\" };\n  }\n\n  // \u2500\u2500 Themes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async getThemes() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const activeTemplate  = await getOption(this.env, \"template\")   || \"twentytwentyfour\";\n    const activeStylesheet = await getOption(this.env, \"stylesheet\") || \"twentytwentyfour\";\n    const themes = [];\n\n    const owner = ghOwner(this.env);\n    const repo  = ghRepo(this.env);\n    if (owner && repo) {\n      try {\n        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/themes`, {\n          headers: { \"Authorization\": `Bearer ${this.env.GITHUB_TOKEN}`, \"User-Agent\": \"CloudPress/6.0\" },\n        });\n        if (res.ok) {\n          const items = await res.json();\n          for (const item of (Array.isArray(items) ? items : [])) {\n            if (item.type === \"dir\") {\n              themes.push({\n                stylesheet:      item.name,\n                template:        item.name,\n                name:            { rendered: item.name },\n                description:     { rendered: \"\" },\n                author:          { rendered: \"\" },\n                screenshot:      \"\",\n                status:          item.name === activeStylesheet ? \"active\" : \"inactive\",\n                is_block_theme:  false,\n                textdomain:      item.name,\n              });\n            }\n          }\n        }\n      } catch {}\n    }\n\n    // Always include active theme\n    if (!themes.find(t => t.stylesheet === activeStylesheet)) {\n      themes.unshift({\n        stylesheet: activeStylesheet,\n        template:   activeTemplate,\n        name:       { rendered: activeStylesheet },\n        description:{ rendered: \"\" },\n        author:     { rendered: \"\" },\n        screenshot: \"\",\n        status:     \"active\",\n        is_block_theme: false,\n        textdomain: activeStylesheet,\n      });\n    }\n    return themes;\n  }\n\n  async activateTheme(stylesheet) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    await setOption(this.env, \"stylesheet\", stylesheet);\n    await setOption(this.env, \"template\", stylesheet);\n    await this._invalidateCache();\n    return { stylesheet, template: stylesheet, status: \"active\" };\n  }\n\n  // \u2500\u2500 Cache invalidation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  async _invalidateCache() {\n    try {\n      // Delete page cache keys\n      const cache = kv(this.env);\n      if (!cache) return;\n      const list = await cache.list({ prefix: \"page:\" });\n      for (const key of (list.keys||[])) {\n        await cache.delete(key.name);\n      }\n    } catch {}\n  }\n}\n\n// \u2500\u2500\u2500 REST API \u30eb\u30fc\u30c6\u30a3\u30f3\u30b0 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\nasync function handleRestApi(request, env, url) {\n  const method = request.method.toUpperCase();\n  const path   = url.pathname.replace(/^\\/wp-json\\/wp\\/v2/, \"\").replace(/\\/$/, \"\") || \"/\";\n  const params  = Object.fromEntries(url.searchParams.entries());\n\n  const user = await getAuthUser(request, env);\n  const api  = new WpRestApi(env, user);\n\n  let body = {};\n  if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n    try {\n      const ct = request.headers.get(\"Content-Type\") || \"\";\n      if (ct.includes(\"application/json\")) {\n        body = await request.json();\n      } else if (ct.includes(\"multipart/form-data\") || ct.includes(\"application/x-www-form-urlencoded\")) {\n        const fd = await request.formData();\n        for (const [k,v] of fd.entries()) body[k] = v;\n      }\n    } catch {}\n  }\n\n  try {\n    // \u2500\u2500 /posts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    if (path === \"/posts\" || path === \"\") {\n      if (method === \"GET\") {\n        const { posts, total, pages } = await api.getPosts({ ...params, type: params.type || \"post\" });\n        return json(posts, 200, { \"X-WP-Total\": String(total), \"X-WP-TotalPages\": String(pages) });\n      }\n      if (method === \"POST\") {\n        if (!user) return json({ code: \"rest_not_logged_in\", message: \"Sorry, you are not allowed to create posts.\" }, 401);\n        const post = await api.createPost({ ...body, type: \"post\" });\n        return json(post, 201);\n      }\n    }\n\n    const postMatch = path.match(/^\\/posts\\/(\\d+)$/);\n    if (postMatch) {\n      const id = postMatch[1];\n      if (method === \"GET\")    return json(await api.getPost(id));\n      if (method === \"POST\" || method === \"PUT\" || method === \"PATCH\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updatePost(id, body));\n      }\n      if (method === \"DELETE\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.deletePost(id, params.force === \"true\"));\n      }\n    }\n\n    // \u2500\u2500 /pages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    if (path === \"/pages\") {\n      if (method === \"GET\") {\n        const { posts, total, pages } = await api.getPosts({ ...params, type: \"page\" });\n        return json(posts, 200, { \"X-WP-Total\": String(total), \"X-WP-TotalPages\": String(pages) });\n      }\n      if (method === \"POST\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        const page = await api.createPost({ ...body, type: \"page\" });\n        return json(page, 201);\n      }\n    }\n    const pageMatch = path.match(/^\\/pages\\/(\\d+)$/);\n    if (pageMatch) {\n      const id = pageMatch[1];\n      if (method === \"GET\")    return json(await api.getPost(id));\n      if (method === \"POST\" || method === \"PUT\" || method === \"PATCH\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updatePost(id, body));\n      }\n      if (method === \"DELETE\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.deletePost(id, params.force === \"true\"));\n      }\n    }\n\n    // \u2500\u2500 /media \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n    if (path === \"/media\") {\n      if (method === \"GET\") return json(await api.getMedia(params));\n      if (method === \"POST\") {\n        if (!user) return json({ cod
