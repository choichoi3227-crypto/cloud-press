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

// ── worker-wp.js 소스 로드 (GitHub 레포에서) ─────────────────────────────────
// worker-wp.js는 배포된 Pages 레포의 루트에 있거나, 공개 레포에서 가져옴
// 빌드 시점에 번들링된 내용을 사용
async function fetchWorkerWpScript(log) {
  // worker-wp.js는 현재 배포된 Pages 사이트(cloud-press)의 공개 URL에서 가져옴
  // 환경에 따라 다를 수 있으므로 여러 소스를 시도
  const sources = [
    // 1) 같은 Pages 프로젝트에 배포된 worker-wp.js
    "https://raw.githubusercontent.com/cloudpress-io/cloud-press/main/worker-wp.js",
    // 2) 자기 자신의 Pages URL (cloud-press.co.kr)
    "https://cloud-press.co.kr/worker-wp.js",
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { cf: { cacheEverything: false } });
      if (res.ok) {
        const text = await res.text();
        if (text.includes("CloudPress WordPress Worker")) return text;
      }
    } catch {}
  }
  await log("  worker-wp.js 원격 로드 실패 — 인라인 스크립트 사용", "warning");
  return null;
}

// ── Cloudflare Worker 생성 (worker-wp.js 기반 실제 WordPress Worker) ──────────
async function createWorker({ cfToken, cfAccountId, cfEmail, workerName, siteId, githubOwner, githubRepo, githubToken, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  Worker 생성 중: ${workerName}`);

  // worker-wp.js를 원격에서 가져와서 플레이스홀더 치환
  let script = await fetchWorkerWpScript(log);

  if (script) {
    // %%SITE_ID%%, %%GITHUB_OWNER%%, %%GITHUB_REPO%% 치환
    script = script
      .replace(/%%SITE_ID%%/g,      siteId       || "")
      .replace(/%%GITHUB_OWNER%%/g, githubOwner  || "")
      .replace(/%%GITHUB_REPO%%/g,  githubRepo   || "");
  } else {
    // 원격 로드 실패 시: 최소 동작하는 폴백 (설정 안내 페이지 표시)
    script = `// CloudPress WordPress Worker (fallback) - site: ${siteId}
// worker-wp.js 로드 실패로 인한 폴백 스크립트
// 다음 환경변수가 Worker에 바인딩되어야 합니다:
//   DB (D1), CACHE (KV), SITE_ID, GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/_health") {
      return new Response(JSON.stringify({ status: "ok", version: "fallback", site_id: env.SITE_ID || "${siteId}", db: !!(env.DB), kv: !!(env.CACHE) }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WordPress 준비 중</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f0f1;">
<h1 style="color:#2271b1;">☁️ CloudPress</h1>
<p>WordPress Worker가 설치 중입니다.</p>
<p style="color:#666;font-size:13px;">잠시 후 새로고침 해주세요.</p>
<p style="color:#999;font-size:11px;">Site: ${siteId}</p>
</body></html>\`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
};`;
  }

  // Cloudflare Workers API 바인딩 스펙 (올바른 형식)
  const bindings = [];
  if (d1Id) {
    // D1 바인딩: database_id 필드 사용
    bindings.push({ type: "d1", name: "DB",      database_id: d1Id });
  }
  if (kvSessionsId) {
    bindings.push({ type: "kv_namespace", name: "SESSIONS", namespace_id: kvSessionsId });
  }
  if (kvCacheId) {
    bindings.push({ type: "kv_namespace", name: "CACHE",    namespace_id: kvCacheId });
  }
  // plain_text 환경변수 바인딩
  bindings.push({ type: "plain_text", name: "SITE_ID",      text: siteId       || "" });
  bindings.push({ type: "plain_text", name: "GITHUB_OWNER", text: githubOwner  || "" });
  bindings.push({ type: "plain_text", name: "GITHUB_REPO",  text: githubRepo   || "" });
  // GitHub 토큰은 secret_text로
  if (githubToken) {
    bindings.push({ type: "secret_text", name: "GITHUB_TOKEN", text: githubToken });
  }

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

// ── D1 스키마 초기화 (WordPress wp_* 테이블) ──────────────────────────────────
// worker-wp.js가 기대하는 실제 WordPress DB 스키마로 초기화
// autoInstallWordPress()와 동일한 구조를 CF API로 미리 생성
async function initD1Schema({ cfToken, cfAccountId, cfEmail, d1Id, siteId, adminUser, adminEmail, adminPassHash, log }) {
  if (!d1Id) return;
  await log("  D1 스키마 초기화 중...");

  // D1 REST API는 세미콜론으로 구분된 multi-statement를 지원하지 않으므로
  // /raw endpoint의 queries 배열 사용 (batch 방식)
  const sqls = [
    // ── 테이블 생성 ───────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wp_options (
      option_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      option_name TEXT UNIQUE NOT NULL,
      option_value TEXT NOT NULL DEFAULT '',
      autoload    TEXT NOT NULL DEFAULT 'yes'
    )`,
    `CREATE TABLE IF NOT EXISTS wp_users (
      ID            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_login    TEXT NOT NULL DEFAULT '',
      user_pass     TEXT NOT NULL DEFAULT '',
      user_nicename TEXT NOT NULL DEFAULT '',
      user_email    TEXT NOT NULL DEFAULT '',
      user_url      TEXT NOT NULL DEFAULT '',
      user_registered TEXT NOT NULL DEFAULT '',
      user_activation_key TEXT NOT NULL DEFAULT '',
      user_status   INTEGER NOT NULL DEFAULT 0,
      display_name  TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS wp_usermeta (
      umeta_id  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL DEFAULT 0,
      meta_key  TEXT,
      meta_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wp_posts (
      ID                    INTEGER PRIMARY KEY AUTOINCREMENT,
      post_author           INTEGER NOT NULL DEFAULT 0,
      post_date             TEXT NOT NULL DEFAULT '',
      post_date_gmt         TEXT NOT NULL DEFAULT '',
      post_content          TEXT NOT NULL DEFAULT '',
      post_title            TEXT NOT NULL DEFAULT '',
      post_excerpt          TEXT NOT NULL DEFAULT '',
      post_status           TEXT NOT NULL DEFAULT 'publish',
      comment_status        TEXT NOT NULL DEFAULT 'open',
      ping_status           TEXT NOT NULL DEFAULT 'open',
      post_password         TEXT NOT NULL DEFAULT '',
      post_name             TEXT NOT NULL DEFAULT '',
      to_ping               TEXT NOT NULL DEFAULT '',
      pinged                TEXT NOT NULL DEFAULT '',
      post_modified         TEXT NOT NULL DEFAULT '',
      post_modified_gmt     TEXT NOT NULL DEFAULT '',
      post_content_filtered TEXT NOT NULL DEFAULT '',
      post_parent           INTEGER NOT NULL DEFAULT 0,
      guid                  TEXT NOT NULL DEFAULT '',
      menu_order            INTEGER NOT NULL DEFAULT 0,
      post_type             TEXT NOT NULL DEFAULT 'post',
      post_mime_type        TEXT NOT NULL DEFAULT '',
      comment_count         INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_postmeta (
      meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL DEFAULT 0,
      meta_key   TEXT,
      meta_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS wp_terms (
      term_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL DEFAULT '',
      slug       TEXT NOT NULL DEFAULT '',
      term_group INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
      term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id          INTEGER NOT NULL DEFAULT 0,
      taxonomy         TEXT NOT NULL DEFAULT '',
      description      TEXT NOT NULL DEFAULT '',
      parent           INTEGER NOT NULL DEFAULT 0,
      count            INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_term_relationships (
      object_id        INTEGER NOT NULL DEFAULT 0,
      term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
      term_order       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (object_id, term_taxonomy_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wp_comments (
      comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_post_ID      INTEGER NOT NULL DEFAULT 0,
      comment_author       TEXT NOT NULL DEFAULT '',
      comment_author_email TEXT NOT NULL DEFAULT '',
      comment_author_url   TEXT NOT NULL DEFAULT '',
      comment_author_IP    TEXT NOT NULL DEFAULT '',
      comment_date         TEXT NOT NULL DEFAULT '',
      comment_date_gmt     TEXT NOT NULL DEFAULT '',
      comment_content      TEXT NOT NULL DEFAULT '',
      comment_karma        INTEGER NOT NULL DEFAULT 0,
      comment_approved     TEXT NOT NULL DEFAULT '1',
      comment_agent        TEXT NOT NULL DEFAULT '',
      comment_type         TEXT NOT NULL DEFAULT 'comment',
      comment_parent       INTEGER NOT NULL DEFAULT 0,
      user_id              INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS wp_commentmeta (
      meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL DEFAULT 0,
      meta_key   TEXT,
      meta_value TEXT
    )`,
  ];

  // D1 Batch API (/raw endpoint) 사용 — 테이블 생성은 한 번에
  const batchRes = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database/${d1Id}/raw`, {
    params: [],
    sql: sqls.join(";\n"),
  }, cfEmail);

  if (!batchRes.ok) {
    // fallback: 개별 실행
    await log("  D1 batch 실패, 개별 실행으로 재시도...", "warning");
    for (const sql of sqls) {
      const r = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database/${d1Id}/query`, { sql }, cfEmail);
      if (!r.ok) await log(`  D1 DDL 실패: ${sql.slice(0, 60).replace(/\s+/g, " ")}`, "warning");
    }
  }

  // ── 기본 데이터 삽입 (D1 /query endpoint — 파라미터 바인딩 지원) ──────────
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const shortSiteId = siteId.slice(0, 8);

  const inserts = [
    // 관리자 사용자 (adminPassHash는 phpass 형식 또는 SHA-256)
    {
      sql: `INSERT OR IGNORE INTO wp_users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_activation_key, user_status, display_name) VALUES (?, ?, ?, ?, '', ?, '', 0, ?)`,
      params: [adminUser, adminPassHash, adminUser, adminEmail, now, adminUser],
    },
    // 사용자 메타 — 역할
    { sql: `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_user_level', '10')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'admin_color', 'fresh')`, params: [] },
    // 기본 카테고리
    { sql: `INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0)`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 1)`, params: [] },
    // WordPress 기본 옵션
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('siteurl', '', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blogname', '내 WordPress 사이트', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blogdescription', 'CloudPress로 만든 WordPress', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('admin_email', ?, 'yes')`, params: [adminEmail] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('template', 'twentytwentyfour', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('stylesheet', 'twentytwentyfour', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('current_theme', 'Twenty Twenty-Four', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('active_plugins', 'a:0:{}', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('permalink_structure', '/%postname%/', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('wp_installed_version', '6.7.2', 'no')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('db_version', '57155', 'no')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('timezone_string', 'Asia/Seoul', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blog_charset', 'UTF-8', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blogpublic', '1', 'yes')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('cp_auto_installed', '1', 'no')`, params: [] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('cp_admin_user', ?, 'no')`, params: [adminUser] },
    { sql: `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('cp_site_id', ?, 'no')`, params: [siteId] },
    // 환영 게시물
    { sql: `INSERT OR IGNORE INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_name, post_type, post_modified, post_modified_gmt, guid, menu_order) VALUES (1, ?, ?, ?, '안녕하세요!', '', 'publish', 'open', 'open', 'hello-world', 'post', ?, ?, '', 0)`, params: [now, now, "WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.", now, now] },
    { sql: `INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id, term_order) VALUES (1, 1, 0)`, params: [] },
  ];

  for (const { sql, params } of inserts) {
    const r = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database/${d1Id}/query`, { sql, params }, cfEmail);
    if (!r.ok) await log(`  D1 INSERT 실패: ${sql.slice(0, 60).replace(/\s+/g, " ")}`, "warning");
  }

  await log("  D1 스키마 초기화 완료 (WordPress wp_* 테이블)");
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
    workerName   = await createWorker({ cfToken, cfAccountId, cfEmail, workerName: prefix, siteId, githubOwner: owner, githubRepo: repoName, githubToken: token, d1Id, kvSessionsId, kvCacheId, log });

    if (d1Id) {
      const passHash = hashPassword(adminPass);
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
