// Cloudflare Pages 호스팅 프로비저닝 전담 모듈
// GitHub Tree API로 배치 push → 타임아웃 방지

import { pickGithubToken } from "./github-storage.js";

// ── GitHub API 헬퍼 (github-storage.js와 동일, 로컬 정의로 'not defined' 방지) ──
async function ghReq(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization:           `Bearer ${token}`,
      Accept:                  "application/vnd.github+json",
      "X-GitHub-Api-Version":  "2022-11-28",
      "Content-Type":          "application/json",
      "User-Agent":            "CloudPress-Hosting/6.1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

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
      content: `# CloudPress WordPress Worker 배포 설정
name              = "${slugify(siteName) || "cloudpress-site"}"
main              = "worker-wp.js"
compatibility_date = "2025-04-01"

${d1Id ? `[[d1_databases]]
binding       = "DB"
database_name = "cp-${siteId.slice(0,8)}-db"
database_id   = "${d1Id}"

[[d1_databases]]
binding       = "SITE_DB"
database_name = "cp-${siteId.slice(0,8)}-db"
database_id   = "${d1Id}"` : "# D1: Cloudflare 대시보드에서 바인딩 설정"}

${kvSessionsId ? `[[kv_namespaces]]
binding = "SESSIONS"
id      = "${kvSessionsId}"

[[kv_namespaces]]
binding = "KV"
id      = "${kvSessionsId}"` : "# KV SESSIONS: Cloudflare 대시보드에서 설정"}

${kvCacheId ? `[[kv_namespaces]]
binding = "CACHE"
id      = "${kvCacheId}"` : "# KV CACHE: Cloudflare 대시보드에서 설정"}

[vars]
SITE_ID    = "${siteId}"
SITE_NAME  = "${siteName}"
`,
    },
    {
      path: ".github/workflows/deploy.yml",
      content: `name: CloudPress WordPress Worker 배포

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: wrangler deploy
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
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



// ── Cloudflare Worker 생성 + D1/KV 바인딩 + Secrets ──────────────────────────
// worker-wp.js 소스를 GitHub 레포에서 읽어 Cloudflare Workers API로 배포
async function createCfWorkerWithBindings({
  cfToken, cfAccountId, cfEmail,
  workerName, d1Id, d1DbName, kvSessionsId, kvCacheId,
  siteId, ghOwner, ghRepo, ghToken,
  adminUser, adminPass, adminEmail,
  log,
}) {
  if (!cfToken || !cfAccountId) {
    await log("  Worker 배포 스킵 (CF 토큰 없음)");
    return null;
  }

  // ── worker-wp.js 소스 읽기 (GitHub 레포에서) ─────────────────────────────
  // GitHub 레포에 이미 push된 worker-wp.js를 읽음
  await log("  Worker 소스 읽는 중...");
  let workerSource = null;

  // 1차: GitHub 레포 (개인 레포의 worker-wp.js)
  if (ghOwner && ghRepo && ghToken) {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${ghOwner}/${ghRepo}/main/worker-wp.js`;
      const res = await fetch(rawUrl, {
        headers: { "Authorization": `Bearer ${ghToken}`, "User-Agent": "CloudPress/6.1" },
      });
      if (res.ok) {
        workerSource = await res.text();
        await log("  Worker 소스: GitHub 레포에서 읽기 완료");
      }
    } catch (e) {
      await log(`  Worker 소스 GitHub 읽기 실패: ${e.message}`, "warn");
    }
  }

  // 2차: 공식 CloudPress 릴리즈 (GitHub 공개 레포)
  if (!workerSource) {
    try {
      const res = await fetch(
        "https://raw.githubusercontent.com/cloudpress-io/cloudpress/main/worker-wp.js",
        { headers: { "User-Agent": "CloudPress/6.1" } }
      );
      if (res.ok) {
        workerSource = await res.text();
        await log("  Worker 소스: CloudPress 공식 릴리즈에서 읽기 완료");
      }
    } catch {}
  }

  // 소스 없으면 Worker 배포 불가 → 에러 반환
  if (!workerSource) {
    await log("  ❌ Worker 소스를 가져올 수 없습니다. GitHub 레포에 worker-wp.js가 있는지 확인하세요.", "error");
    return null;
  }

  // ── Cloudflare Workers API 배포 (multipart/form-data) ────────────────────
  await log(`  Worker 배포 중: ${workerName}`);

  const metadataObj = {
    main_module: "worker-wp.js",
    compatibility_date: "2025-04-01",
    bindings: [
      ...(d1Id ? [
        { type: "d1", name: "DB",      database_id: d1Id },
        { type: "d1", name: "SITE_DB", database_id: d1Id },
      ] : []),
      ...(kvSessionsId ? [
        { type: "kv_namespace", name: "SESSIONS", namespace_id: kvSessionsId },
        { type: "kv_namespace", name: "KV",       namespace_id: kvSessionsId },
      ] : []),
      ...(kvCacheId ? [
        { type: "kv_namespace", name: "CACHE", namespace_id: kvCacheId },
      ] : []),
      { type: "plain_text", name: "SITE_ID",      text: siteId   },
      { type: "plain_text", name: "GITHUB_OWNER", text: ghOwner || "" },
      { type: "plain_text", name: "GITHUB_REPO",  text: ghRepo  || "" },
    ],
  };

  const boundary = `------CloudPressBoundary${Math.random().toString(36).slice(2)}`;

  const metaPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadataObj) + `\r\n`;

  const scriptPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="worker-wp.js"; filename="worker-wp.js"\r\n` +
    `Content-Type: application/javascript+module\r\n\r\n` +
    workerSource + `\r\n`;

  const closingPart = `--${boundary}--\r\n`;

  const body = new TextEncoder().encode(metaPart + scriptPart + closingPart);

  const cfHeaders = { "Content-Type": `multipart/form-data; boundary=----${boundary.slice(2)}` };
  if (cfEmail) {
    cfHeaders["X-Auth-Email"] = cfEmail;
    cfHeaders["X-Auth-Key"]   = cfToken;
  } else {
    cfHeaders["Authorization"] = `Bearer ${cfToken}`;
  }

  // multipart boundary를 올바르게 설정
  const boundaryVal = `----${boundary.slice(2)}`;
  const metaPartFixed =
    `--${boundaryVal}\r\n` +
    `Content-Disposition: form-data; name="metadata"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(metadataObj) + `\r\n`;

  const scriptPartFixed =
    `--${boundaryVal}\r\n` +
    `Content-Disposition: form-data; name="worker-wp.js"; filename="worker-wp.js"\r\n` +
    `Content-Type: application/javascript+module\r\n\r\n` +
    workerSource + `\r\n`;

  const closingFixed = `--${boundaryVal}--\r\n`;
  const bodyFixed = new TextEncoder().encode(metaPartFixed + scriptPartFixed + closingFixed);

  const deployRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundaryVal}`,
        ...(cfEmail
          ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
          : { "Authorization": `Bearer ${cfToken}` }),
      },
      body: bodyFixed,
    }
  );

  const deployData = await deployRes.json().catch(() => ({}));
  if (!deployRes.ok) {
    const errMsg = JSON.stringify(deployData?.errors || deployData?.error || deployData);
    await log(`  Worker 배포 실패 (${deployRes.status}): ${errMsg}`, "error");
    return null;
  }
  await log(`  ✅ Worker 배포 완료: ${workerName}`);

  // ── Secrets 설정 ──────────────────────────────────────────────────────────
  const secrets = [];
  if (ghToken)    secrets.push({ name: "GITHUB_TOKEN", text: ghToken });
  if (adminPass)  secrets.push({ name: "WP_ADMIN_PASS",  text: adminPass });
  if (adminUser)  secrets.push({ name: "WP_ADMIN_USER",  text: adminUser });
  if (adminEmail) secrets.push({ name: "WP_ADMIN_EMAIL", text: adminEmail });

  // JWT_SECRET 생성
  const jwtSecret = btoa(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b) => s + String.fromCharCode(b), ""));
  secrets.push({ name: "JWT_SECRET", text: jwtSecret });

  for (const secret of secrets) {
    const sRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/secrets`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(cfEmail
            ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
            : { "Authorization": `Bearer ${cfToken}` }),
        },
        body: JSON.stringify({ name: secret.name, text: secret.text, type: "secret_text" }),
      }
    );
    if (sRes.ok) {
      await log(`  Secret 설정: ${secret.name}`);
    } else {
      const sd = await sRes.json().catch(() => ({}));
      await log(`  Secret 실패 (${secret.name}): ${JSON.stringify(sd?.errors)}`, "warn");
    }
  }

  // ── Worker 서브도메인 조회 ─────────────────────────────────────────────────
  let workerDomain = null;
  try {
    const subRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfEmail
            ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
            : { "Authorization": `Bearer ${cfToken}` }),
        },
        body: JSON.stringify({ enabled: true }),
      }
    );
    if (subRes.ok) {
      const subData = await subRes.json();
      const subdomain = subData?.result?.subdomain;
      if (subdomain) {
        workerDomain = `https://${workerName}.${subdomain}.workers.dev`;
        await log(`  Worker 도메인: ${workerDomain}`);
      }
    }
  } catch {}

  return { workerName, workerDomain };
}

// ── GitHub 레포 생성 ──────────────────────────────────────────────────────────
async function createGitHubRepo({ ghToken, owner, repoName, isOrg = false, log }) {
  await log(`  GitHub 레포 생성 중: ${owner}/${repoName}`);
  const endpoint = isOrg
    ? `/orgs/${owner}/repos`
    : "/user/repos";
  const res = await ghReq("POST", endpoint, ghToken, {
    name: repoName, private: true, auto_init: true,
    description: "CloudPress WordPress 사이트 (자동 생성)",
  });
  if (!res.ok && res.status !== 422) {
    await log(`  GitHub 레포 생성 실패 (${res.status}): ${JSON.stringify(res.data)}`, "error");
    return false;
  }
  if (res.status === 422) {
    await log(`  GitHub 레포 이미 존재, 기존 사용`);
  } else {
    await log(`  GitHub 레포 생성 완료`);
  }
  // 레포 초기화 대기
  await delay(2000);
  return true;
}

// ── Cloudflare Pages 프로젝트 생성 ────────────────────────────────────────────
async function createCfPagesProject({ cfToken, cfAccountId, cfEmail, projName, owner, repoName, log }) {
  if (!cfToken || !cfAccountId) {
    await log("  CF Pages 스킵 (CF 토큰 없음)");
    return null;
  }
  await log(`  CF Pages 프로젝트 생성 중: ${projName}`);
  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/pages/projects`, {
    name: projName,
    production_branch: "main",
    source: {
      type: "github",
      config: {
        owner, repo_name: repoName,
        production_branch: "main",
        pr_comments_enabled: false,
        deployments_enabled: true,
      },
    },
    build_config: {
      build_command:       "npm install && npm run build",
      destination_dir:     "dist",
      root_dir:            "",
    },
    deployment_configs: {
      production: {
        env_vars: {
          NODE_VERSION: { value: "20" },
        },
      },
    },
  }, cfEmail);

  if (!res.ok && res.status !== 409) {
    await log(`  CF Pages 생성 실패 (${res.status}): ${JSON.stringify(res.data?.errors)}`, "warn");
    return null;
  }
  const subdomain = res.data?.result?.subdomain;
  const pagesUrl  = subdomain ? `https://${subdomain}` : null;
  await log(`  CF Pages 생성 완료: ${pagesUrl || projName}`);
  return { projName, pagesUrl };
}

// ── 메인 프로비저닝 함수 ──────────────────────────────────────────────────────
export async function provisionCloudflarePagesHosting({
  env, siteId, siteName,
  adminUser, adminPass, adminEmail,
  plan, planLimits,
  cfToken, cfAccountId, cfEmail,
  initialDomain,
  userId, isAdmin,
  log,
}) {
  const shortId    = siteId.replace(/-/g, "").slice(0, 8);
  const safeSlug   = slugify(siteName) || `site-${shortId}`;
  const workerName = `cp-${shortId}-wp`;
  const d1DbName   = `cp-${shortId}-db`;
  const kvSessName = `cp-${shortId}-sessions`;
  const kvCacheName= `cp-${shortId}-cache`;
  const repoName   = `cp-${shortId}-${safeSlug}`.slice(0, 100);
  const projName   = `cp-${shortId}-${safeSlug}`.slice(0, 100);

  await log(`사이트 ID  : ${siteId}`);
  await log(`Worker 명  : ${workerName}`);
  await log(`D1 DB 명   : ${d1DbName}`);
  await log(`GitHub 레포: ${repoName}`);

  // ── 1. GitHub 토큰 선택 ───────────────────────────────────────────────────
  const ghToken = await pickGithubToken(env).catch(() => null);
  let owner     = null;
  let ghUserInfo = null;

  if (ghToken) {
    try {
      const userRes = await ghReq("GET", "/user", ghToken);
      if (userRes.ok) {
        ghUserInfo = userRes.data;
        owner = ghUserInfo.login;
        await log(`GitHub 사용자: ${owner}`);
      }
    } catch (e) {
      await log(`GitHub 사용자 조회 실패: ${e.message}`, "warn");
    }
  }

  if (!owner) {
    // CF만으로도 Worker 배포는 가능 (GitHub 없이)
    await log("GitHub 토큰 없음 — GitHub 레포 생성 스킵", "warn");
  }

  // ── 2. D1 데이터베이스 생성 ───────────────────────────────────────────────
  let d1Id = null;
  if (cfToken && cfAccountId) {
    d1Id = await createD1Database({ cfToken, cfAccountId, cfEmail, dbName: d1DbName, log });
  }

  // ── 3. KV 네임스페이스 생성 ───────────────────────────────────────────────
  let kvSessionsId = null;
  let kvCacheId    = null;
  if (cfToken && cfAccountId) {
    [kvSessionsId, kvCacheId] = await Promise.all([
      createKVNamespace({ cfToken, cfAccountId, cfEmail, title: kvSessName,  log }),
      createKVNamespace({ cfToken, cfAccountId, cfEmail, title: kvCacheName, log }),
    ]);
  }

  // ── 4. GitHub 레포 생성 및 파일 push ─────────────────────────────────────
  let repoCreated = false;
  if (ghToken && owner) {
    repoCreated = await createGitHubRepo({ ghToken, owner, repoName, log });
  }

  if (repoCreated && ghToken && owner) {
    // 4-1. wrangler.toml, worker-wp.js, _db/, Astro 파일 등 일괄 push
    await log("  GitHub 파일 push 중...");

    const workerWpSource = getWorkerWpSource();
    const configFiles    = buildConfigFiles({ siteId, siteName, cfAccountId, d1Id, kvSessionsId, kvCacheId, projName });
    const dbFiles        = await buildDbFiles({ siteId, siteName, adminUser, adminPass, adminEmail });
    const astroFiles     = buildAstroFiles({ siteName, siteId, owner, repoName, planLimits });
    const wpConvertFiles = buildWordPressConvertScript();

    const allFiles = [
      // worker-wp.js — Cloudflare Worker 메인 소스
      { path: "worker-wp.js", content: workerWpSource },
      // GitHub Actions: Worker 자동 배포
      ...configFiles,
      // DB 초기 데이터
      ...dbFiles,
      // Astro 프론트엔드 (Pages용)
      ...astroFiles,
      // WordPress 변환 스크립트
      ...wpConvertFiles,
      // README
      {
        path: "README.md",
        content: `# ${siteName}\n\nCloudPress로 생성된 WordPress 사이트입니다.\n\n- **Worker**: ${workerName}\n- **D1**: ${d1DbName}\n- **Site ID**: ${siteId}\n\n## 관리\n\n사이트는 CloudPress 대시보드에서 관리하세요: https://cloudpress.site\n`,
      },
    ];

    const pushed = await ghBatchPush(ghToken, owner, repoName, allFiles, "🚀 CloudPress 초기 프로비저닝");
    if (pushed) {
      await log(`  ✅ GitHub 파일 push 완료 (${allFiles.length}개 파일)`);
    } else {
      await log("  GitHub push 실패 (부분 진행 가능)", "warn");
    }
  }

  // ── 5. Cloudflare Worker 배포 ─────────────────────────────────────────────
  await log("▶ Cloudflare Worker 배포 중...");
  const workerResult = await createCfWorkerWithBindings({
    cfToken, cfAccountId, cfEmail,
    workerName, d1Id, d1DbName, kvSessionsId, kvCacheId,
    siteId, ghOwner: owner, ghRepo: repoName, ghToken,
    adminUser, adminPass, adminEmail,
    log,
  });

  const workerDomain = workerResult?.workerDomain || null;

  // ── 6. CF Pages 프로젝트 생성 (선택적, GitHub 연동시) ────────────────────
  let pagesUrl     = null;
  let pagesProject = null;
  if (repoCreated && cfToken && cfAccountId && owner) {
    const pagesResult = await createCfPagesProject({
      cfToken, cfAccountId, cfEmail, projName, owner, repoName, log,
    });
    if (pagesResult) {
      pagesUrl     = pagesResult.pagesUrl;
      pagesProject = pagesResult.projName;
    }
  }

  // ── 7. D1에 WordPress 스키마 초기화 ──────────────────────────────────────
  if (d1Id && cfToken && cfAccountId) {
    await log("▶ D1 WordPress 스키마 초기화 중...");
    const passHash = hashPassword(adminPass);
    const now      = new Date().toISOString().replace("T", " ").slice(0, 19);

    const schemaSqls = [
      `CREATE TABLE IF NOT EXISTS wp_options (
        option_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        option_name TEXT UNIQUE NOT NULL,
        option_value TEXT NOT NULL DEFAULT '',
        autoload TEXT NOT NULL DEFAULT 'yes'
      )`,
      `CREATE TABLE IF NOT EXISTS wp_users (
        ID INTEGER PRIMARY KEY AUTOINCREMENT,
        user_login TEXT NOT NULL DEFAULT '',
        user_pass TEXT NOT NULL DEFAULT '',
        user_nicename TEXT NOT NULL DEFAULT '',
        user_email TEXT NOT NULL DEFAULT '',
        user_url TEXT NOT NULL DEFAULT '',
        user_registered TEXT NOT NULL DEFAULT '',
        user_activation_key TEXT NOT NULL DEFAULT '',
        user_status INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS wp_usermeta (
        umeta_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        meta_key TEXT,
        meta_value TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS wp_posts (
        ID INTEGER PRIMARY KEY AUTOINCREMENT,
        post_author INTEGER NOT NULL DEFAULT 0,
        post_date TEXT NOT NULL DEFAULT '',
        post_date_gmt TEXT NOT NULL DEFAULT '',
        post_content TEXT NOT NULL DEFAULT '',
        post_title TEXT NOT NULL DEFAULT '',
        post_excerpt TEXT NOT NULL DEFAULT '',
        post_status TEXT NOT NULL DEFAULT 'publish',
        comment_status TEXT NOT NULL DEFAULT 'open',
        ping_status TEXT NOT NULL DEFAULT 'open',
        post_password TEXT NOT NULL DEFAULT '',
        post_name TEXT NOT NULL DEFAULT '',
        to_ping TEXT NOT NULL DEFAULT '',
        pinged TEXT NOT NULL DEFAULT '',
        post_modified TEXT NOT NULL DEFAULT '',
        post_modified_gmt TEXT NOT NULL DEFAULT '',
        post_content_filtered TEXT NOT NULL DEFAULT '',
        post_parent INTEGER NOT NULL DEFAULT 0,
        guid TEXT NOT NULL DEFAULT '',
        menu_order INTEGER NOT NULL DEFAULT 0,
        post_type TEXT NOT NULL DEFAULT 'post',
        post_mime_type TEXT NOT NULL DEFAULT '',
        comment_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS wp_postmeta (
        meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL DEFAULT 0,
        meta_key TEXT,
        meta_value TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS wp_terms (
        term_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL DEFAULT '',
        term_group INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
        term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
        term_id INTEGER NOT NULL DEFAULT 0,
        taxonomy TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        parent INTEGER NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS wp_term_relationships (
        object_id INTEGER NOT NULL DEFAULT 0,
        term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
        term_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (object_id, term_taxonomy_id)
      )`,
      `CREATE TABLE IF NOT EXISTS wp_comments (
        comment_ID INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_post_ID INTEGER NOT NULL DEFAULT 0,
        comment_author TEXT NOT NULL DEFAULT '',
        comment_author_email TEXT NOT NULL DEFAULT '',
        comment_author_url TEXT NOT NULL DEFAULT '',
        comment_author_IP TEXT NOT NULL DEFAULT '',
        comment_date TEXT NOT NULL DEFAULT '',
        comment_date_gmt TEXT NOT NULL DEFAULT '',
        comment_content TEXT NOT NULL DEFAULT '',
        comment_karma INTEGER NOT NULL DEFAULT 0,
        comment_approved TEXT NOT NULL DEFAULT '1',
        comment_agent TEXT NOT NULL DEFAULT '',
        comment_type TEXT NOT NULL DEFAULT 'comment',
        comment_parent INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS wp_commentmeta (
        meta_id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL DEFAULT 0,
        meta_key TEXT,
        meta_value TEXT
      )`,
    ];

    // ── CF D1 Batch API: 모든 SQL을 단 1회 fetch로 실행 (subrequest 절약) ──
    const d1Batch = async (sqls) => {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${d1Id}/raw`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cfEmail
              ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
              : { "Authorization": `Bearer ${cfToken}` }),
          },
          // /raw 엔드포인트는 sql에 여러 문장을 세미콜론으로 이어서 한 번에 처리
          body: JSON.stringify({ sql: sqls.join(";\n") }),
        }
      );
      return r.json().catch(() => ({}));
    };

    // WordPress 기본 데이터 삽입
    const siteUrl = workerDomain || pagesUrl || `https://${workerName}.workers.dev`;

    // 스키마 + 데이터를 한 번에 전송 (fetch 1회 = subrequest 1개)
    const allSqls = [
      ...schemaSqls,
      `INSERT OR IGNORE INTO wp_users (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name) VALUES ('${adminUser}', '${passHash.replace(/'/g,"''")}', '${adminUser}', '${adminEmail}', '${siteUrl}', '${now}', 0, '${adminUser}')`,
      `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
      `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (1, 'wp_user_level', '10')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('siteurl', '${siteUrl}', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('home', '${siteUrl}', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blogname', '${siteName.replace(/'/g,"''")}', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blogdescription', 'CloudPress로 만든 WordPress', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('admin_email', '${adminEmail}', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('template', 'twentytwentyfour', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('stylesheet', 'twentytwentyfour', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('permalink_structure', '/%postname%/', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('active_plugins', 'a:0:{}', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('timezone_string', 'Asia/Seoul', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('blog_charset', 'UTF-8', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('wp_installed_version', '6.7.2', 'yes')`,
      `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES ('cp_auto_installed', '1', 'yes')`,
      `INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1, '미분류', 'uncategorized', 0)`,
      `INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1, 1, 'category', '', 0, 1)`,
      `INSERT OR IGNORE INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_status, post_name, post_type, post_modified, post_modified_gmt, guid, comment_status, ping_status) VALUES (1, '${now}', '${now}', 'WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.', '안녕하세요!', 'publish', 'hello-world', 'post', '${now}', '${now}', '${siteUrl}/?p=1', 'open', 'open')`,
      `INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id) VALUES (1, 1)`,
    ];

    const batchRes = await d1Batch(allSqls);
    if (batchRes?.errors?.length) {
      await log(`  D1 배치 오류 (일부 무시 가능): ${JSON.stringify(batchRes.errors[0])}`, "warn");
    }
    await log("  ✅ D1 WordPress 스키마 초기화 완료 (배치 1회)");
  }

  // ── 8. GitHub Actions 시크릿 설정 ────────────────────────────────────────
  if (ghToken && owner && repoName && cfToken) {
    await log("▶ GitHub Actions 시크릿 설정 중...");
    try {
      // 공개키 조회
      const pkRes = await ghReq("GET", `/repos/${owner}/${repoName}/actions/secrets/public-key`, ghToken);
      if (pkRes.ok && pkRes.data?.key) {
        // CF_API_TOKEN 시크릿 설정 (암호화 생략 → plain text 방식은 미지원이므로 안내만)
        await log("  GitHub Actions에 CF_API_TOKEN 시크릿을 수동으로 설정해 주세요.");
        await log(`  레포: https://github.com/${owner}/${repoName}/settings/secrets/actions`);
      }
    } catch {}
  }

  const cfDomain = workerDomain;

  await log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await log(`✅ 프로비저닝 완료!`);
  await log(`Worker URL : ${workerDomain || "(없음 - CF 토큰 필요)"}`);
  await log(`Pages URL  : ${pagesUrl    || "(없음 - GitHub+CF 연동 필요)"}`);
  await log(`GitHub     : ${owner ? `https://github.com/${owner}/${repoName}` : "(없음)"}`);
  await log(`D1 ID      : ${d1Id        || "(없음)"}`);
  await log(`KV Sess ID : ${kvSessionsId || "(없음)"}`);
  await log(`KV Cache ID: ${kvCacheId   || "(없음)"}`);
  await log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return {
    owner:        owner    || "",
    repoName:     repoName || "",
    pagesUrl:     pagesUrl || workerDomain || null,
    pagesProject: pagesProject || null,
    cfDomain:     cfDomain || null,
    d1Id:         d1Id || null,
    kvSessionsId: kvSessionsId || null,
    kvCacheId:    kvCacheId || null,
    workerName:   workerName || null,
  };
}

// ── worker-wp.js 소스 가져오기 (프로비저닝 시 GitHub에 push용) ───────────────
// 이 함수는 CloudPress 공식 GitHub에서 최신 worker-wp.js를 가져옴
// worker-wp.js 전체 소스 내장 — 외부 URL 의존 없이 항상 진짜 WordPress Worker 반환
function getWorkerWpSource() {
  return "/**\n * CloudPress WordPress Worker v6.1\n * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n * PHP-FREE WordPress SaaS Engine\n * - D1(SQLite) 기반 완전한 WordPress REST API 구현\n * - WordPress 코어 정적 자산 → WordPress/WordPress 공식 GitHub CDN\n * - 사용자 테마/플러그인 → 개인 GitHub 레포 or jsDelivr CDN\n * - 관리자 UI → WordPress 공식 관리자 UI와 100% 동일한 레이아웃\n * - 모든 플러그인/테마 설치 가능 (GitHub 레포 연동)\n * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n *\n * 바인딩 (sites.js createCfWorkerWithBindings에서 자동 연결):\n *   DB          : D1  - WordPress 데이터베이스\n *   SITE_DB     : D1  - 동일 DB 별칭\n *   CACHE       : KV  - 페이지/자산 캐시\n *   KV          : KV  - 설치 상태 / 세션\n *   SITE_ID     : plain_text\n *   GITHUB_OWNER: plain_text\n *   GITHUB_REPO : plain_text\n *   GITHUB_TOKEN: secret_text\n *   JWT_SECRET  : secret_text\n */\n\n// ─── 플레이스홀더 (sites.js가 치환) ─────────────────────────────────────────\nconst _INJECTED_SITE_ID      = \"%%SITE_ID%%\";\nconst _INJECTED_GITHUB_OWNER = \"%%GITHUB_OWNER%%\";\nconst _INJECTED_GITHUB_REPO  = \"%%GITHUB_REPO%%\";\n\n// ─── WordPress 공식 코어 소스 ────────────────────────────────────────────────\nconst WP_VER        = \"6.7.2\";\nconst WP_CORE_CDN   = `https://cdn.jsdelivr.net/npm/wordpress-static@${WP_VER}`;\nconst WP_GITHUB_RAW = \"https://raw.githubusercontent.com/WordPress/WordPress/master\";\n\n// ─── 정적 파일 확장자 ────────────────────────────────────────────────────────\nconst STATIC_EXT = /\\.(css|js|jpg|jpeg|png|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|txt|xml|json|zip|pdf|mp4|mp3|ogg|wav|webm|avif)$/i;\n\n// ─── CORS 헤더 ───────────────────────────────────────────────────────────────\nconst CORS = {\n  \"Access-Control-Allow-Origin\":  \"*\",\n  \"Access-Control-Allow-Methods\": \"GET,POST,PUT,DELETE,PATCH,OPTIONS\",\n  \"Access-Control-Allow-Headers\": \"Content-Type,Authorization,X-Requested-With,X-WP-Nonce,X-WP-Nonce-Preview\",\n};\n\n// ─── 유틸 ────────────────────────────────────────────────────────────────────\nfunction siteId(env) { return env.SITE_ID || _INJECTED_SITE_ID; }\nfunction ghOwner(env) { return env.GITHUB_OWNER || _INJECTED_GITHUB_OWNER; }\nfunction ghRepo(env)  { return env.GITHUB_REPO  || _INJECTED_GITHUB_REPO; }\nfunction db(env)      { return env.DB || env.SITE_DB; }\nfunction kv(env)      { return env.CACHE || env.KV; }\n\nasync function kvGet(env, key) {\n  try { return await kv(env)?.get(key); } catch { return null; }\n}\nasync function kvSet(env, key, val, ttl = 3600) {\n  try { await kv(env)?.put(key, val, { expirationTtl: ttl }); } catch {}\n}\nasync function kvDel(env, key) {\n  try { await kv(env)?.delete(key); } catch {}\n}\n\nfunction json(data, status = 200, extra = {}) {\n  return new Response(JSON.stringify(data), {\n    status,\n    headers: { ...CORS, \"Content-Type\": \"application/json; charset=utf-8\", ...extra },\n  });\n}\nfunction html(body, status = 200, extra = {}) {\n  return new Response(body, {\n    status,\n    headers: { ...CORS, \"Content-Type\": \"text/html; charset=utf-8\", ...extra },\n  });\n}\n\n// ─── 간단한 JWT (HS256) ──────────────────────────────────────────────────────\nasync function jwtSign(payload, secret) {\n  const header = btoa(JSON.stringify({ alg: \"HS256\", typ: \"JWT\" })).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  const body   = btoa(JSON.stringify(payload)).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  const data   = `${header}.${body}`;\n  const key    = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(secret), { name:\"HMAC\", hash:\"SHA-256\" }, false, [\"sign\"]);\n  const sig    = await crypto.subtle.sign(\"HMAC\", key, new TextEncoder().encode(data));\n  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,\"\").replace(/\\+/g,\"-\").replace(/\\//g,\"_\");\n  return `${data}.${sigB64}`;\n}\n\nasync function jwtVerify(token, secret) {\n  try {\n    const [h, b, s] = token.split(\".\");\n    const data = `${h}.${b}`;\n    const key  = await crypto.subtle.importKey(\"raw\", new TextEncoder().encode(secret), { name:\"HMAC\", hash:\"SHA-256\" }, false, [\"verify\"]);\n    const sig  = Uint8Array.from(atob(s.replace(/-/g,\"+\").replace(/_/g,\"/\")), c => c.charCodeAt(0));\n    const ok   = await crypto.subtle.verify(\"HMAC\", key, sig, new TextEncoder().encode(data));\n    if (!ok) return null;\n    const payload = JSON.parse(atob(b.replace(/-/g,\"+\").replace(/_/g,\"/\")));\n    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;\n    return payload;\n  } catch { return null; }\n}\n\nfunction getJwtSecret(env) {\n  return env.JWT_SECRET || \"cloudpress-fallback-secret-change-me\";\n}\n\nasync function getAuthUser(request, env) {\n  const authHeader = request.headers.get(\"Authorization\") || \"\";\n  let token = authHeader.startsWith(\"Bearer \") ? authHeader.slice(7) : null;\n  if (!token) {\n    const cookie = request.headers.get(\"Cookie\") || \"\";\n    const m = cookie.match(/(?:^|;\\s*)wp_token=([^;]+)/);\n    if (m) token = decodeURIComponent(m[1]);\n  }\n  if (!token) return null;\n  return jwtVerify(token, getJwtSecret(env));\n}\n\n// ─── MD5 pure-JS (Cloudflare Workers는 crypto.subtle.digest(\"MD5\") 미지원) ──\nfunction md5Hash(data) {\n  const bytes = typeof data === \"string\" ? new TextEncoder().encode(data) : data;\n  const T = new Uint32Array(64);\n  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;\n  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,\n             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,\n             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,\n             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];\n  const msgLen = bytes.length;\n  const bitLen = msgLen * 8;\n  const padLen = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);\n  const padded = new Uint8Array(msgLen + padLen + 8);\n  padded.set(bytes);\n  padded[msgLen] = 0x80;\n  const view = new DataView(padded.buffer);\n  view.setUint32(msgLen + padLen,     bitLen >>> 0,        true);\n  view.setUint32(msgLen + padLen + 4, Math.floor(bitLen / 0x100000000), true);\n  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;\n  for (let i = 0; i < padded.length; i += 64) {\n    const M = new Uint32Array(16);\n    for (let j = 0; j < 16; j++) M[j] = view.getUint32(i + j * 4, true);\n    let [a, b, c, d] = [a0, b0, c0, d0];\n    for (let j = 0; j < 64; j++) {\n      let f, g;\n      if      (j < 16) { f = (b & c) | (~b & d);  g = j; }\n      else if (j < 32) { f = (d & b) | (~d & c);  g = (5*j+1)%16; }\n      else if (j < 48) { f = b ^ c ^ d;             g = (3*j+5)%16; }\n      else             { f = c ^ (b | ~d);           g = (7*j)%16; }\n      f = (f + a + T[j] + M[g]) >>> 0;\n      a = d; d = c; c = b;\n      b = (b + ((f << S[j]) | (f >>> (32 - S[j])))) >>> 0;\n    }\n    a0=(a0+a)>>>0; b0=(b0+b)>>>0; c0=(c0+c)>>>0; d0=(d0+d)>>>0;\n  }\n  const out = new Uint8Array(16);\n  const ov  = new DataView(out.buffer);\n  ov.setUint32(0,  a0, true); ov.setUint32(4,  b0, true);\n  ov.setUint32(8,  c0, true); ov.setUint32(12, d0, true);\n  return out;\n}\n\n// ─── phpass 호환 비밀번호 검증/생성 ─────────────────────────────────────────\nconst ITOA64 = \"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\";\n\nfunction encode64(src, count) {\n  let output = \"\";\n  let i = 0;\n  while (i < count) {\n    let value = src[i++];\n    output += ITOA64[value & 0x3f];\n    if (i < count) value |= src[i] << 8;\n    output += ITOA64[(value >> 6) & 0x3f];\n    if (i++ >= count) break;\n    if (i < count) value |= src[i] << 16;\n    output += ITOA64[(value >> 12) & 0x3f];\n    if (i++ >= count) break;\n    output += ITOA64[(value >> 18) & 0x3f];\n  }\n  return output;\n}\n\nfunction phpassCheck(password, hash) {\n  if (hash.startsWith(\"$P$\") || hash.startsWith(\"$H$\")) {\n    const countLog2 = ITOA64.indexOf(hash[3]);\n    const salt      = hash.slice(4, 12);\n    let count       = 1 << countLog2;\n    const passBytes = new TextEncoder().encode(password);\n    let h = md5Hash(salt + password);\n    while (count--) {\n      const c = new Uint8Array(h.length + passBytes.length);\n      c.set(h); c.set(passBytes, h.length);\n      h = md5Hash(c);\n    }\n    return (hash.slice(0, 12) + encode64(h, 16)) === hash;\n  }\n  if (hash.length === 32 && /^[0-9a-f]{32}$/.test(hash)) {\n    const h = md5Hash(password);\n    return Array.from(h).map(b => b.toString(16).padStart(2,\"0\")).join(\"\") === hash;\n  }\n  return false;\n}\n\nfunction phpassCreate(password) {\n  const countLog2 = 8;\n  const chars = \"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./\";\n  const rnd   = new Uint8Array(8);\n  crypto.getRandomValues(rnd);\n  let salt = \"\";\n  for (const b of rnd) salt += chars[b % chars.length];\n  const prefix    = `$P$${ITOA64[countLog2]}${salt}`;\n  let count       = 1 << countLog2;\n  const passBytes = new TextEncoder().encode(password);\n  let h = md5Hash(salt + password);\n  while (count--) {\n    const c = new Uint8Array(h.length + passBytes.length);\n    c.set(h); c.set(passBytes, h.length);\n    h = md5Hash(c);\n  }\n  return prefix + encode64(h, 16);\n}\n\n// ─── WordPress 설치 확인 ──────────────────────────────────────────────────────\nasync function isWpInstalled(env) {\n  const flag = await kvGet(env, `wp:installed:${siteId(env)}`);\n  if (flag === \"1\") return true;\n  const d = db(env);\n  if (!d) return false;\n  try {\n    const r = await d.prepare(\"SELECT option_value FROM wp_options WHERE option_name='siteurl' LIMIT 1\").first();\n    if (r?.option_value) {\n      await kvSet(env, `wp:installed:${siteId(env)}`, \"1\", 86400);\n      return true;\n    }\n  } catch {}\n  return false;\n}\n\n// ─── WordPress DB 자동 초기화 ────────────────────────────────────────────────\nasync function autoInstallWordPress(env, url) {\n  const d = db(env);\n  if (!d) return false;\n\n  const siteUrl    = `${url.protocol}//${url.host}`;\n  const sid        = siteId(env);\n  const now        = new Date().toISOString().replace(\"T\", \" \").slice(0, 19);\n  const adminUser  = env.WP_ADMIN_USER  || \"admin\";\n  const adminPass  = env.WP_ADMIN_PASS  || crypto.randomUUID().slice(0, 12);\n  const adminEmail = env.WP_ADMIN_EMAIL || `admin@${url.host}`;\n\n  try {\n    const schema = [\n      `CREATE TABLE IF NOT EXISTS wp_options (\n        option_id   INTEGER PRIMARY KEY AUTOINCREMENT,\n        option_name TEXT UNIQUE NOT NULL,\n        option_value TEXT NOT NULL DEFAULT '',\n        autoload    TEXT NOT NULL DEFAULT 'yes'\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_users (\n        ID            INTEGER PRIMARY KEY AUTOINCREMENT,\n        user_login    TEXT NOT NULL DEFAULT '',\n        user_pass     TEXT NOT NULL DEFAULT '',\n        user_nicename TEXT NOT NULL DEFAULT '',\n        user_email    TEXT NOT NULL DEFAULT '',\n        user_url      TEXT NOT NULL DEFAULT '',\n        user_registered TEXT NOT NULL DEFAULT '',\n        user_activation_key TEXT NOT NULL DEFAULT '',\n        user_status   INTEGER NOT NULL DEFAULT 0,\n        display_name  TEXT NOT NULL DEFAULT ''\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_usermeta (\n        umeta_id  INTEGER PRIMARY KEY AUTOINCREMENT,\n        user_id   INTEGER NOT NULL DEFAULT 0,\n        meta_key  TEXT,\n        meta_value TEXT\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_posts (\n        ID                    INTEGER PRIMARY KEY AUTOINCREMENT,\n        post_author           INTEGER NOT NULL DEFAULT 0,\n        post_date             TEXT NOT NULL DEFAULT '',\n        post_date_gmt         TEXT NOT NULL DEFAULT '',\n        post_content          TEXT NOT NULL DEFAULT '',\n        post_title            TEXT NOT NULL DEFAULT '',\n        post_excerpt          TEXT NOT NULL DEFAULT '',\n        post_status           TEXT NOT NULL DEFAULT 'publish',\n        comment_status        TEXT NOT NULL DEFAULT 'open',\n        ping_status           TEXT NOT NULL DEFAULT 'open',\n        post_password         TEXT NOT NULL DEFAULT '',\n        post_name             TEXT NOT NULL DEFAULT '',\n        to_ping               TEXT NOT NULL DEFAULT '',\n        pinged                TEXT NOT NULL DEFAULT '',\n        post_modified         TEXT NOT NULL DEFAULT '',\n        post_modified_gmt     TEXT NOT NULL DEFAULT '',\n        post_content_filtered TEXT NOT NULL DEFAULT '',\n        post_parent           INTEGER NOT NULL DEFAULT 0,\n        guid                  TEXT NOT NULL DEFAULT '',\n        menu_order            INTEGER NOT NULL DEFAULT 0,\n        post_type             TEXT NOT NULL DEFAULT 'post',\n        post_mime_type        TEXT NOT NULL DEFAULT '',\n        comment_count         INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_postmeta (\n        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        post_id    INTEGER NOT NULL DEFAULT 0,\n        meta_key   TEXT,\n        meta_value TEXT\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_terms (\n        term_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        name       TEXT NOT NULL DEFAULT '',\n        slug       TEXT NOT NULL DEFAULT '',\n        term_group INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_term_taxonomy (\n        term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        term_id          INTEGER NOT NULL DEFAULT 0,\n        taxonomy         TEXT NOT NULL DEFAULT '',\n        description      TEXT NOT NULL DEFAULT '',\n        parent           INTEGER NOT NULL DEFAULT 0,\n        count            INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_term_relationships (\n        object_id        INTEGER NOT NULL DEFAULT 0,\n        term_taxonomy_id INTEGER NOT NULL DEFAULT 0,\n        term_order       INTEGER NOT NULL DEFAULT 0,\n        PRIMARY KEY (object_id, term_taxonomy_id)\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_comments (\n        comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,\n        comment_post_ID      INTEGER NOT NULL DEFAULT 0,\n        comment_author       TEXT NOT NULL DEFAULT '',\n        comment_author_email TEXT NOT NULL DEFAULT '',\n        comment_author_url   TEXT NOT NULL DEFAULT '',\n        comment_author_IP    TEXT NOT NULL DEFAULT '',\n        comment_date         TEXT NOT NULL DEFAULT '',\n        comment_date_gmt     TEXT NOT NULL DEFAULT '',\n        comment_content      TEXT NOT NULL DEFAULT '',\n        comment_karma        INTEGER NOT NULL DEFAULT 0,\n        comment_approved     TEXT NOT NULL DEFAULT '1',\n        comment_agent        TEXT NOT NULL DEFAULT '',\n        comment_type         TEXT NOT NULL DEFAULT 'comment',\n        comment_parent       INTEGER NOT NULL DEFAULT 0,\n        user_id              INTEGER NOT NULL DEFAULT 0\n      )`,\n      `CREATE TABLE IF NOT EXISTS wp_commentmeta (\n        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,\n        comment_id INTEGER NOT NULL DEFAULT 0,\n        meta_key   TEXT,\n        meta_value TEXT\n      )`,\n    ];\n\n    for (const sql of schema) {\n      await d.prepare(sql).run();\n    }\n\n    const hashedPass = phpassCreate(adminPass);\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_users\n        (user_login, user_pass, user_nicename, user_email, user_url, user_registered, user_status, display_name)\n       VALUES (?,?,?,?,?,?,0,?)`\n    ).bind(adminUser, hashedPass, adminUser, adminEmail, siteUrl, now, adminUser).run();\n\n    const adminRow = await d.prepare(\"SELECT ID FROM wp_users WHERE user_login=? LIMIT 1\").bind(adminUser).first();\n    const adminId  = adminRow?.ID || 1;\n\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"wp_capabilities\", `a:1:{s:13:\"administrator\";b:1;}`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"wp_user_level\", \"10\").run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?,?,?)`).bind(adminId, \"admin_color\", \"fresh\").run();\n\n    const options = [\n      [\"siteurl\",          siteUrl],\n      [\"home\",             siteUrl],\n      [\"blogname\",         \"내 WordPress 사이트\"],\n      [\"blogdescription\",  \"CloudPress로 만든 WordPress\"],\n      [\"admin_email\",      adminEmail],\n      [\"blogpublic\",       \"1\"],\n      [\"blog_charset\",     \"UTF-8\"],\n      [\"date_format\",      \"Y년 n월 j일\"],\n      [\"time_format\",      \"A g:i\"],\n      [\"start_of_week\",    \"0\"],\n      [\"timezone_string\",  \"Asia/Seoul\"],\n      [\"permalink_structure\", \"/%postname%/\"],\n      [\"template\",         \"twentytwentyfour\"],\n      [\"stylesheet\",       \"twentytwentyfour\"],\n      [\"current_theme\",    \"Twenty Twenty-Four\"],\n      [\"active_plugins\",   \"a:0:{}\"],\n      [\"wp_user_roles\",    `a:1:{s:13:\"administrator\";a:2:{s:4:\"name\";s:13:\"Administrator\";s:12:\"capabilities\";a:1:{s:13:\"administrator\";b:1;}}}`],\n      [\"wp_installed_version\", \"6.7.2\"],\n      [\"db_version\",       \"57155\"],\n      [\"initial_db_version\", \"57155\"],\n      [\"cp_auto_installed\", \"1\"],\n      [\"cp_installed_at\",  now],\n      [\"cp_admin_pass\",    adminPass],\n      [\"cp_admin_user\",    adminUser],\n      [\"cp_admin_email\",   adminEmail],\n    ];\n\n    for (const [k, v] of options) {\n      await d.prepare(\n        `INSERT OR IGNORE INTO wp_options (option_name, option_value, autoload) VALUES (?,?,'yes')`\n      ).bind(k, v).run();\n    }\n\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,\n         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      adminId, now, now,\n      \"WordPress에 오신 것을 환영합니다! CloudPress로 구동되는 이 사이트를 자유롭게 수정하고 꾸며보세요.\",\n      \"안녕하세요!\", \"publish\", \"hello-world\", now, now, \"post\",\n      `${siteUrl}/?p=1`, \"open\", \"open\"\n    ).run();\n\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_status,\n         post_name, post_modified, post_modified_gmt, post_type, guid, comment_status, ping_status)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      adminId, now, now,\n      \"이 페이지는 샘플 페이지입니다. CloudPress 관리자 패널에서 자유롭게 수정하세요.\",\n      \"샘플 페이지\", \"publish\", \"sample-page\", now, now, \"page\",\n      `${siteUrl}/?page_id=2`, \"closed\", \"open\"\n    ).run();\n\n    await d.prepare(`INSERT OR IGNORE INTO wp_terms (term_id, name, slug, term_group) VALUES (1,'미분류','uncategorized',0)`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_term_taxonomy (term_taxonomy_id, term_id, taxonomy, description, parent, count) VALUES (1,1,'category','',0,1)`).run();\n    await d.prepare(`INSERT OR IGNORE INTO wp_term_relationships (object_id, term_taxonomy_id) VALUES (1,1)`).run();\n\n    await d.prepare(\n      `INSERT OR IGNORE INTO wp_comments\n        (comment_post_ID, comment_author, comment_author_email, comment_author_url,\n         comment_content, comment_date, comment_date_gmt, comment_approved, comment_type, user_id)\n       VALUES (?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      1, \"CloudPress\", \"support@cloudpress.com\", \"https://cloudpress.com\",\n      \"WordPress 사이트가 성공적으로 생성되었습니다. 이 댓글을 삭제하고 새 글을 작성해보세요!\",\n      now, now, \"1\", \"comment\", 0\n    ).run();\n\n    await kvSet(env, `wp:installed:${sid}`, \"1\", 86400 * 30);\n    console.log(`[CloudPress] WordPress 자동 설치 완료 (site: ${sid}, url: ${siteUrl})`);\n    return true;\n\n  } catch (e) {\n    console.error(\"[CloudPress] 자동 설치 실패:\", e.message);\n    return false;\n  }\n}\n\n// ─── WP Option 헬퍼 ──────────────────────────────────────────────────────────\nasync function getOption(env, name) {\n  try {\n    const r = await db(env).prepare(\"SELECT option_value FROM wp_options WHERE option_name=? LIMIT 1\").bind(name).first();\n    return r?.option_value ?? null;\n  } catch { return null; }\n}\n\nasync function setOption(env, name, value) {\n  try {\n    await db(env).prepare(\"INSERT INTO wp_options(option_name,option_value,autoload) VALUES(?,?,'yes') ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value\").bind(name, value).run();\n    await kvDel(env, `opt:${name}`);\n  } catch {}\n}\n\n// ─── Content-Type 결정 ───────────────────────────────────────────────────────\nfunction mimeByExt(path) {\n  if (path.endsWith(\".css\"))   return \"text/css; charset=utf-8\";\n  if (path.endsWith(\".js\"))    return \"application/javascript; charset=utf-8\";\n  if (path.endsWith(\".svg\"))   return \"image/svg+xml\";\n  if (path.endsWith(\".png\"))   return \"image/png\";\n  if (path.endsWith(\".jpg\") || path.endsWith(\".jpeg\")) return \"image/jpeg\";\n  if (path.endsWith(\".gif\"))   return \"image/gif\";\n  if (path.endsWith(\".webp\"))  return \"image/webp\";\n  if (path.endsWith(\".ico\"))   return \"image/x-icon\";\n  if (path.endsWith(\".woff\"))  return \"font/woff\";\n  if (path.endsWith(\".woff2\")) return \"font/woff2\";\n  if (path.endsWith(\".ttf\"))   return \"font/ttf\";\n  if (path.endsWith(\".json\"))  return \"application/json; charset=utf-8\";\n  if (path.endsWith(\".xml\"))   return \"application/xml; charset=utf-8\";\n  return null;\n}\n\n// ─── GitHub 자산 서빙 (테마/플러그인 from 개인 레포) ─────────────────────────\nasync function serveGithubAsset(env, repoPath) {\n  const owner = ghOwner(env);\n  const repo  = ghRepo(env);\n  if (!owner || !repo) return null;\n  const token = env.GITHUB_TOKEN || \"\";\n  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;\n  const headers = { \"User-Agent\": \"CloudPress/6.1\" };\n  if (token) headers[\"Authorization\"] = `Bearer ${token}`;\n  try {\n    const res = await fetch(url, { headers, cf: { cacheEverything: true, cacheTtl: 3600 } });\n    if (!res.ok) return null;\n    const ct   = mimeByExt(repoPath) || res.headers.get(\"Content-Type\") || \"application/octet-stream\";\n    const body = await res.arrayBuffer();\n    return new Response(body, {\n      headers: { ...CORS, \"Content-Type\": ct, \"Cache-Control\": \"public, max-age=3600\", \"X-Source\": \"github-user-repo\" },\n    });\n  } catch { return null; }\n}\n\n// ─── WordPress 코어 정적 자산 서빙 ──────────────────────────────────────────\nasync function serveCoreAsset(filePath) {\n  const urls = [\n    `${WP_CORE_CDN}/${filePath}`,\n    `${WP_GITHUB_RAW}/${filePath}`,\n  ];\n  for (const url of urls) {\n    try {\n      const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 86400 } });\n      if (res.ok) {\n        const body = await res.arrayBuffer();\n        const ct = mimeByExt(filePath) || res.headers.get(\"Content-Type\") || \"application/octet-stream\";\n        return new Response(body, {\n          headers: {\n            ...CORS, \"Content-Type\": ct,\n            \"Cache-Control\": \"public, max-age=86400, immutable\",\n            \"X-Source\": \"wp-core-cdn\",\n          },\n        });\n      }\n    } catch {}\n  }\n  return null;\n}\n\n// ─── WordPress REST API v2 구현 ───────────────────────────────────────────────\nclass WpRestApi {\n  constructor(env, user) {\n    this.env  = env;\n    this.user = user;\n    this.d    = db(env);\n  }\n\n  async getPosts(params = {}) {\n    const {\n      per_page = 10, page = 1, status = \"publish\",\n      type = \"post\", search = \"\", author = 0,\n      orderby = \"date\", order = \"desc\", slug = \"\",\n    } = params;\n\n    const offset = (parseInt(page)-1) * parseInt(per_page);\n    const conditions = [];\n    const binds = [];\n\n    if (status === \"any\") {\n      conditions.push(\"post_status NOT IN ('auto-draft','trash')\");\n    } else {\n      const statuses = status.split(\",\").map(s => s.trim()).filter(Boolean);\n      if (statuses.length === 1) {\n        conditions.push(\"post_status=?\"); binds.push(statuses[0]);\n      } else {\n        conditions.push(`post_status IN (${statuses.map(()=>\"?\").join(\",\")})`);\n        binds.push(...statuses);\n      }\n    }\n    conditions.push(\"post_type=?\"); binds.push(type);\n    if (slug)   { conditions.push(\"post_name=?\"); binds.push(slug); }\n    if (search) { conditions.push(\"(post_title LIKE ? OR post_content LIKE ?)\"); binds.push(`%${search}%`, `%${search}%`); }\n    if (author) { conditions.push(\"post_author=?\"); binds.push(parseInt(author)); }\n\n    const where    = conditions.length ? \"WHERE \" + conditions.join(\" AND \") : \"\";\n    const orderSql = `ORDER BY ${orderby === \"title\" ? \"post_title\" : \"post_date\"} ${order.toUpperCase() === \"ASC\" ? \"ASC\" : \"DESC\"}`;\n\n    const countRow = await this.d.prepare(`SELECT COUNT(*) as cnt FROM wp_posts ${where}`).bind(...binds).first();\n    const total    = countRow?.cnt || 0;\n    const rows     = await this.d.prepare(`SELECT * FROM wp_posts ${where} ${orderSql} LIMIT ? OFFSET ?`).bind(...binds, parseInt(per_page), offset).all();\n\n    const posts = await Promise.all((rows.results || []).map(p => this._formatPost(p)));\n    return { posts, total, pages: Math.ceil(total / parseInt(per_page)) };\n  }\n\n  async getPost(id) {\n    const isSlug = isNaN(parseInt(id));\n    const row = isSlug\n      ? await this.d.prepare(\"SELECT * FROM wp_posts WHERE post_name=? LIMIT 1\").bind(id).first()\n      : await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=? LIMIT 1\").bind(parseInt(id)).first();\n    if (!row) return null;\n    return this._formatPost(row);\n  }\n\n  async createPost(data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const {\n      title = \"\", content = \"\", excerpt = \"\", status = \"draft\",\n      type = \"post\", slug = \"\", comment_status = \"open\",\n      ping_status = \"open\", categories = [1], tags = [], meta = {},\n      parent = 0, menu_order = 0, date = now,\n    } = data;\n\n    const postName = slug || this._slugify(title || \"post\");\n    const res = await this.d.prepare(\n      `INSERT INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,\n         post_status, comment_status, ping_status, post_name, post_type,\n         post_modified, post_modified_gmt, guid, menu_order, post_parent)\n       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`\n    ).bind(\n      this.user.id || 1, date, date, content, title, excerpt,\n      status, comment_status, ping_status, postName, type,\n      now, now, \"\", menu_order, parent\n    ).run();\n\n    const postId  = res.meta?.last_row_id;\n    if (!postId) throw new Error(\"Insert failed\");\n    const siteUrl = await getOption(this.env, \"siteurl\") || \"\";\n    await this.d.prepare(\"UPDATE wp_posts SET guid=? WHERE ID=?\").bind(`${siteUrl}/?p=${postId}`, postId).run();\n\n    for (const catId of (Array.isArray(categories) ? categories : [1])) {\n      const tt = await this.d.prepare(\"SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy='category'\").bind(catId).first();\n      if (tt) {\n        await this.d.prepare(\"INSERT OR IGNORE INTO wp_term_relationships(object_id,term_taxonomy_id) VALUES(?,?)\").bind(postId, tt.term_taxonomy_id).run();\n        await this.d.prepare(\"UPDATE wp_term_taxonomy SET count=count+1 WHERE term_taxonomy_id=?\").bind(tt.term_taxonomy_id).run();\n      }\n    }\n    for (const [k, v] of Object.entries(meta)) {\n      await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(postId, k, String(v)).run();\n    }\n    await this._invalidateCache();\n    return this.getPost(postId);\n  }\n\n  async updatePost(id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const existing = await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=?\").bind(parseInt(id)).first();\n    if (!existing) throw new Error(\"Not Found\");\n\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const updates = {};\n    if (data.title   !== undefined) updates.post_title   = data.title;\n    if (data.content !== undefined) updates.post_content = data.content;\n    if (data.excerpt !== undefined) updates.post_excerpt = data.excerpt;\n    if (data.status  !== undefined) updates.post_status  = data.status;\n    if (data.slug    !== undefined) updates.post_name    = data.slug || this._slugify(data.title || existing.post_title);\n    if (data.date    !== undefined) updates.post_date    = data.date;\n    if (data.comment_status !== undefined) updates.comment_status = data.comment_status;\n    updates.post_modified     = now;\n    updates.post_modified_gmt = now;\n\n    const keys = Object.keys(updates);\n    const vals = Object.values(updates);\n    await this.d.prepare(`UPDATE wp_posts SET ${keys.map(k=>`${k}=?`).join(\",\")} WHERE ID=?`).bind(...vals, parseInt(id)).run();\n\n    if (data.meta) {\n      for (const [k, v] of Object.entries(data.meta)) {\n        await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING\").bind(parseInt(id), k, String(v)).run();\n      }\n    }\n    await this._invalidateCache();\n    return this.getPost(id);\n  }\n\n  async deletePost(id, force = false) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    if (force) {\n      await this.d.prepare(\"DELETE FROM wp_posts WHERE ID=?\").bind(parseInt(id)).run();\n      await this.d.prepare(\"DELETE FROM wp_postmeta WHERE post_id=?\").bind(parseInt(id)).run();\n      await this.d.prepare(\"DELETE FROM wp_term_relationships WHERE object_id=?\").bind(parseInt(id)).run();\n    } else {\n      await this.d.prepare(\"UPDATE wp_posts SET post_status='trash' WHERE ID=?\").bind(parseInt(id)).run();\n    }\n    await this._invalidateCache();\n    return { deleted: true, id: parseInt(id) };\n  }\n\n  async _formatPost(row) {\n    if (!row) return null;\n    const siteUrl = await getOption(this.env, \"siteurl\") || \"\";\n    const metaRows = await this.d.prepare(\"SELECT meta_key,meta_value FROM wp_postmeta WHERE post_id=?\").bind(row.ID).all();\n    const meta = {};\n    for (const m of (metaRows.results || [])) meta[m.meta_key] = m.meta_value;\n\n    const catRows = await this.d.prepare(\n      `SELECT t.term_id, t.name, t.slug FROM wp_terms t\n       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id\n       WHERE tr.object_id=? AND tt.taxonomy='category'`\n    ).bind(row.ID).all();\n\n    const tagRows = await this.d.prepare(\n      `SELECT t.term_id, t.name, t.slug FROM wp_terms t\n       JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       JOIN wp_term_relationships tr ON tt.term_taxonomy_id=tr.term_taxonomy_id\n       WHERE tr.object_id=? AND tt.taxonomy='post_tag'`\n    ).bind(row.ID).all();\n\n    const author  = await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(row.post_author).first();\n    const slug    = row.post_name || String(row.ID);\n    const postLink = `${siteUrl}/${slug}/`;\n\n    return {\n      id: row.ID, date: row.post_date, date_gmt: row.post_date_gmt,\n      modified: row.post_modified, modified_gmt: row.post_modified_gmt,\n      slug, status: row.post_status, type: row.post_type, link: postLink,\n      title:   { rendered: row.post_title || \"\" },\n      content: { rendered: this._renderBlocks(row.post_content || \"\"), raw: row.post_content || \"\", protected: false },\n      excerpt: { rendered: row.post_excerpt || \"\", protected: false },\n      author: row.post_author,\n      featured_media: parseInt(meta._thumbnail_id || 0),\n      comment_status: row.comment_status, ping_status: row.ping_status,\n      format: \"standard\", meta, sticky: false,\n      template: meta._wp_page_template || \"\",\n      categories: (catRows.results || []).map(c => c.term_id),\n      tags:       (tagRows.results || []).map(t => t.term_id),\n      _embedded: {\n        author: author ? [this._formatUser(author)] : [],\n        \"wp:term\": [\n          (catRows.results || []).map(c => ({ id: c.term_id, name: c.name, slug: c.slug, taxonomy: \"category\" })),\n          (tagRows.results || []).map(t => ({ id: t.term_id, name: t.name, slug: t.slug, taxonomy: \"post_tag\" })),\n        ],\n      },\n    };\n  }\n\n  _renderBlocks(content) {\n    if (!content) return \"\";\n    return content\n      .replace(/<!-- wp:[^>]+ \\/-->/g, \"\")\n      .replace(/<!-- wp:[^\\n]* -->/g, \"\")\n      .replace(/<!-- \\/wp:[^\\n]* -->/g, \"\")\n      .trim();\n  }\n\n  _slugify(text) {\n    return text\n      .toLowerCase()\n      .replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ\\s-]/g, \"\")\n      .replace(/\\s+/g, \"-\")\n      .replace(/-+/g, \"-\")\n      .slice(0, 200) || `post-${Date.now()}`;\n  }\n\n  _formatUser(row) {\n    return {\n      id: row.ID, name: row.display_name || row.user_login,\n      url: row.user_url || \"\", description: \"\", link: \"\",\n      slug: row.user_nicename || row.user_login,\n      avatar_urls: { 96: `https://www.gravatar.com/avatar/${(row.user_email||\"\").trim().toLowerCase()}?s=96&d=mm` },\n    };\n  }\n\n  async getUsers(params = {}) {\n    const { per_page = 10, page = 1 } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const rows = await this.d.prepare(\"SELECT * FROM wp_users ORDER BY ID LIMIT ? OFFSET ?\").bind(parseInt(per_page), offset).all();\n    return (rows.results || []).map(u => this._formatUser(u));\n  }\n\n  async getUser(id) {\n    const row = id === \"me\"\n      ? (this.user ? await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(this.user.id).first() : null)\n      : await this.d.prepare(\"SELECT * FROM wp_users WHERE ID=?\").bind(parseInt(id)).first();\n    if (!row) return null;\n    const caps  = await this.d.prepare(\"SELECT meta_value FROM wp_usermeta WHERE user_id=? AND meta_key='wp_capabilities'\").bind(row.ID).first();\n    const roles = caps?.meta_value?.includes(\"administrator\") ? [\"administrator\"] : [\"subscriber\"];\n    return { ...this._formatUser(row), roles, capabilities: Object.fromEntries(roles.map(r=>[r,true])) };\n  }\n\n  async updateUser(id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const userId = id === \"me\" ? this.user.id : parseInt(id);\n    if (this.user.id !== userId && this.user.role !== \"administrator\") throw new Error(\"Forbidden\");\n\n    const updates = {};\n    if (data.name)     updates.display_name = data.name;\n    if (data.email)    updates.user_email   = data.email;\n    if (data.url)      updates.user_url     = data.url;\n    if (data.password) {\n      updates.user_pass = phpassCreate(data.password);\n      await this.d.prepare(\"DELETE FROM wp_usermeta WHERE user_id=? AND meta_key='session_tokens'\").bind(userId).run();\n    }\n    if (Object.keys(updates).length) {\n      const keys = Object.keys(updates);\n      await this.d.prepare(`UPDATE wp_users SET ${keys.map(k=>`${k}=?`).join(\",\")} WHERE ID=?`).bind(...Object.values(updates), userId).run();\n    }\n    if (data.description !== undefined) {\n      await this.d.prepare(\"INSERT INTO wp_usermeta(user_id,meta_key,meta_value) VALUES(?,?,?) ON CONFLICT DO NOTHING\").bind(userId, \"description\", data.description).run();\n    }\n    return this.getUser(id);\n  }\n\n  async getTerms(taxonomy, params = {}) {\n    const { per_page = 100, page = 1, hide_empty = false, orderby = \"name\", order = \"asc\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond = hide_empty ? \"WHERE tt.taxonomy=? AND tt.count>0\" : \"WHERE tt.taxonomy=?\";\n    const rows = await this.d.prepare(\n      `SELECT t.*, tt.term_taxonomy_id, tt.count, tt.parent, tt.description\n       FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id\n       ${cond}\n       ORDER BY t.${orderby===\"id\"?\"term_id\":\"name\"} ${order.toUpperCase()===\"ASC\"?\"ASC\":\"DESC\"}\n       LIMIT ? OFFSET ?`\n    ).bind(taxonomy, parseInt(per_page), offset).all();\n    return (rows.results || []).map(t => ({\n      id: t.term_id, count: t.count, description: t.description || \"\",\n      link: \"\", name: t.name, slug: t.slug, taxonomy,\n      parent: t.parent || 0, meta: [],\n    }));\n  }\n\n  async createTerm(taxonomy, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const { name, slug = \"\", description = \"\", parent = 0 } = data;\n    const termSlug = slug || this._slugify(name);\n    const existing = await this.d.prepare(\"SELECT term_id FROM wp_terms WHERE slug=?\").bind(termSlug).first();\n    if (existing) {\n      const tt = await this.d.prepare(\"SELECT * FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?\").bind(existing.term_id, taxonomy).first();\n      if (tt) return { id: existing.term_id, name, slug: termSlug, taxonomy, count: tt.count, description: tt.description || \"\", parent: tt.parent || 0 };\n    }\n    const termRes = existing\n      ? { meta: { last_row_id: existing.term_id } }\n      : await this.d.prepare(\"INSERT INTO wp_terms(name,slug,term_group) VALUES(?,?,0)\").bind(name, termSlug).run();\n    const termId = existing?.term_id || termRes.meta?.last_row_id;\n    await this.d.prepare(\"INSERT INTO wp_term_taxonomy(term_id,taxonomy,description,parent,count) VALUES(?,?,?,?,0)\").bind(termId, taxonomy, description, parseInt(parent)).run();\n    return { id: termId, name, slug: termSlug, taxonomy, count: 0, description, parent: parseInt(parent) };\n  }\n\n  async updateTerm(taxonomy, id, data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const { name, slug, description, parent } = data;\n    if (name || slug) await this.d.prepare(\"UPDATE wp_terms SET name=COALESCE(?,name), slug=COALESCE(?,slug) WHERE term_id=?\").bind(name||null, slug||null, parseInt(id)).run();\n    if (description !== undefined || parent !== undefined) {\n      await this.d.prepare(\"UPDATE wp_term_taxonomy SET description=COALESCE(?,description), parent=COALESCE(?,parent) WHERE term_id=? AND taxonomy=?\")\n        .bind(description??null, parent??null, parseInt(id), taxonomy).run();\n    }\n    const t = await this.d.prepare(\"SELECT t.*, tt.count, tt.description, tt.parent FROM wp_terms t JOIN wp_term_taxonomy tt ON t.term_id=tt.term_id WHERE t.term_id=? AND tt.taxonomy=?\").bind(parseInt(id), taxonomy).first();\n    return t ? { id: t.term_id, name: t.name, slug: t.slug, taxonomy, count: t.count, description: t.description||\"\", parent: t.parent||0 } : null;\n  }\n\n  async deleteTerm(taxonomy, id) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    await this.d.prepare(\"DELETE FROM wp_term_relationships WHERE term_taxonomy_id IN (SELECT term_taxonomy_id FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?)\").bind(parseInt(id), taxonomy).run();\n    await this.d.prepare(\"DELETE FROM wp_term_taxonomy WHERE term_id=? AND taxonomy=?\").bind(parseInt(id), taxonomy).run();\n    await this.d.prepare(\"DELETE FROM wp_terms WHERE term_id=? AND NOT EXISTS (SELECT 1 FROM wp_term_taxonomy WHERE term_id=?)\").bind(parseInt(id), parseInt(id)).run();\n    return { deleted: true, previous: { id: parseInt(id) } };\n  }\n\n  async getMedia(params = {}) {\n    const { per_page = 10, page = 1, media_type = \"\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond  = media_type ? \"AND post_mime_type LIKE ?\" : \"\";\n    const binds = media_type ? [`${media_type}%`] : [];\n    const rows  = await this.d.prepare(\n      `SELECT * FROM wp_posts WHERE post_type='attachment' ${cond} ORDER BY post_date DESC LIMIT ? OFFSET ?`\n    ).bind(...binds, parseInt(per_page), offset).all();\n    return (rows.results || []).map(m => this._formatMedia(m));\n  }\n\n  async uploadMedia(env, request) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const ct  = request.headers.get(\"Content-Type\") || \"\";\n    const cd  = request.headers.get(\"Content-Disposition\") || \"\";\n    const fnm = cd.match(/filename[^;=\\n]*=((['\"]).*?\\2|[^;\\n]*)/);\n    const filename = fnm ? fnm[1].replace(/['\"]/g, \"\") : `upload-${Date.now()}`;\n\n    const body     = await request.arrayBuffer();\n    const owner    = ghOwner(env);\n    const repo     = ghRepo(env);\n    const token    = env.GITHUB_TOKEN;\n    const now      = new Date();\n    const year     = now.getFullYear();\n    const month    = String(now.getMonth()+1).padStart(2,\"0\");\n    const repoPath = `wp-content/uploads/${year}/${month}/${filename}`;\n    let fileUrl    = \"\";\n\n    if (owner && repo && token) {\n      const b64 = btoa(String.fromCharCode(...new Uint8Array(body)));\n      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${repoPath}`, {\n        method: \"PUT\",\n        headers: { \"Authorization\": `Bearer ${token}`, \"Content-Type\": \"application/json\", \"User-Agent\": \"CloudPress/6.1\" },\n        body: JSON.stringify({ message: `Upload ${filename}`, content: b64 }),\n      });\n      if (res.ok) {\n        const data = await res.json();\n        fileUrl = data.content?.download_url || `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`;\n      }\n    }\n\n    const siteUrl = await getOption(env, \"siteurl\") || \"\";\n    const now2    = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const res = await this.d.prepare(\n      `INSERT INTO wp_posts\n        (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,\n         post_status, comment_status, ping_status, post_name, post_type, post_mime_type,\n         post_modified, post_modified_gmt, guid, menu_order)\n       VALUES (?,?,?,?,?,?,'inherit','open','open',?,'attachment',?,?,?,?,0)`\n    ).bind(this.user.id||1, now2, now2, \"\", filename, \"\", filename, ct.split(\";\")[0].trim()||\"application/octet-stream\", now2, now2, fileUrl||`${siteUrl}/${repoPath}`).run();\n\n    const mediaId = res.meta?.last_row_id;\n    await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(mediaId, \"_wp_attached_file\", repoPath).run();\n    await this.d.prepare(\"INSERT INTO wp_postmeta(post_id,meta_key,meta_value) VALUES(?,?,?)\").bind(mediaId, \"_wp_attachment_metadata\", JSON.stringify({ file: repoPath })).run();\n    const row = await this.d.prepare(\"SELECT * FROM wp_posts WHERE ID=?\").bind(mediaId).first();\n    return this._formatMedia(row);\n  }\n\n  _formatMedia(row) {\n    if (!row) return null;\n    return {\n      id: row.ID, date: row.post_date, slug: row.post_name,\n      status: row.post_status, type: \"attachment\", link: row.guid,\n      title: { rendered: row.post_title },\n      author: row.post_author,\n      caption: { rendered: row.post_excerpt || \"\" },\n      alt_text: \"\",\n      media_type: (row.post_mime_type || \"\").startsWith(\"image\") ? \"image\" : \"file\",\n      mime_type: row.post_mime_type || \"application/octet-stream\",\n      media_details: {}, source_url: row.guid || \"\",\n    };\n  }\n\n  async getComments(params = {}) {\n    const { post = 0, per_page = 10, page = 1, status = \"approve\" } = params;\n    const offset = (parseInt(page)-1)*parseInt(per_page);\n    const cond  = post ? \"WHERE comment_post_ID=? AND comment_approved=?\" : \"WHERE comment_approved=?\";\n    const binds = post ? [parseInt(post), status === \"approve\" ? \"1\" : status] : [status === \"approve\" ? \"1\" : status];\n    const rows  = await this.d.prepare(`SELECT * FROM wp_comments ${cond} ORDER BY comment_date DESC LIMIT ? OFFSET ?`).bind(...binds, parseInt(per_page), offset).all();\n    return (rows.results || []).map(c => this._formatComment(c));\n  }\n\n  async createComment(data) {\n    const { post, content, author_name = \"Anonymous\", author_email = \"\", author_url = \"\", parent = 0 } = data;\n    const now = new Date().toISOString().slice(0,19).replace(\"T\",\" \");\n    const res = await this.d.prepare(\n      `INSERT INTO wp_comments\n        (comment_post_ID, comment_author, comment_author_email, comment_author_url,\n         comment_content, comment_date, comment_date_gmt, comment_approved, comment_parent, user_id)\n       VALUES (?,?,?,?,?,?,?,?,?,?)`\n    ).bind(parseInt(post), author_name, author_email, author_url, content, now, now, \"1\", parseInt(parent), this.user?.id||0).run();\n    const id = res.meta?.last_row_id;\n    await this.d.prepare(\"UPDATE wp_posts SET comment_count=comment_count+1 WHERE ID=?\").bind(parseInt(post)).run();\n    const row = await this.d.prepare(\"SELECT * FROM wp_comments WHERE comment_ID=?\").bind(id).first();\n    return this._formatComment(row);\n  }\n\n  _formatComment(row) {\n    return {\n      id: row.comment_ID, post: row.comment_post_ID, parent: row.comment_parent,\n      author: row.user_id || 0, author_name: row.comment_author,\n      author_email: row.comment_author_email, author_url: row.comment_author_url,\n      date: row.comment_date, content: { rendered: row.comment_content },\n      status: row.comment_approved === \"1\" ? \"approved\" : \"hold\",\n    };\n  }\n\n  async getSettings() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const opts = await this.d.prepare(\n      \"SELECT option_name,option_value FROM wp_options WHERE option_name IN (?,?,?,?,?,?,?,?,?,?,?,?,?)\"\n    ).bind(\"siteurl\",\"home\",\"blogname\",\"blogdescription\",\"admin_email\",\"posts_per_page\",\n      \"permalink_structure\",\"timezone_string\",\"date_format\",\"time_format\",\n      \"default_category\",\"template\",\"stylesheet\").all();\n    const s = {};\n    for (const r of (opts.results||[])) s[r.option_name] = r.option_value;\n    return {\n      title:              s.blogname || \"\",\n      description:        s.blogdescription || \"\",\n      url:                s.siteurl || \"\",\n      email:              s.admin_email || \"\",\n      timezone:           s.timezone_string || \"Asia/Seoul\",\n      date_format:        s.date_format || \"Y년 n월 j일\",\n      time_format:        s.time_format || \"A g:i\",\n      posts_per_page:     parseInt(s.posts_per_page) || 10,\n      default_category:   parseInt(s.default_category) || 1,\n      default_post_format:\"standard\",\n      language:           \"ko_KR\",\n      use_smilies:        true,\n      template:           s.template || \"twentytwentyfour\",\n      stylesheet:         s.stylesheet || \"twentytwentyfour\",\n      permalink_structure: s.permalink_structure || \"/%postname%/\",\n    };\n  }\n\n  async updateSettings(data) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const map = {\n      title:\"blogname\", description:\"blogdescription\", email:\"admin_email\",\n      timezone:\"timezone_string\", date_format:\"date_format\", time_format:\"time_format\",\n      posts_per_page:\"posts_per_page\", default_category:\"default_category\",\n      permalink_structure:\"permalink_structure\",\n    };\n    for (const [k,v] of Object.entries(data)) {\n      if (map[k]) await setOption(this.env, map[k], String(v));\n    }\n    return this.getSettings();\n  }\n\n  async getPlugins() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    const m   = raw.match(/s:\\d+:\"([^\"]+)\"/g) || [];\n    const active = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean);\n    const plugins = [];\n    const owner = ghOwner(this.env);\n    const repo  = ghRepo(this.env);\n    if (owner && repo) {\n      try {\n        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/plugins`, {\n          headers: { \"Authorization\": `Bearer ${this.env.GITHUB_TOKEN}`, \"User-Agent\": \"CloudPress/6.1\" },\n        });\n        if (res.ok) {\n          const items = await res.json();\n          for (const item of (Array.isArray(items) ? items : [])) {\n            if (item.type === \"dir\") {\n              plugins.push({\n                plugin: `${item.name}/${item.name}.php`,\n                status: active.includes(`${item.name}/${item.name}.php`) ? \"active\" : \"inactive\",\n                name: item.name, plugin_uri: \"\", author: \"\", author_uri: \"\",\n                description: { rendered: \"\" }, version: \"\", network_only: false,\n                requires_wp: \"6.0\", requires_php: \"8.0\", textdomain: item.name,\n              });\n            }\n          }\n        }\n      } catch {}\n    }\n    for (const p of active) {\n      if (!plugins.find(x => x.plugin === p)) {\n        plugins.push({ plugin: p, status: \"active\", name: p.split(\"/\")[0], description: { rendered: \"\" }, version: \"\" });\n      }\n    }\n    return plugins;\n  }\n\n  async activatePlugin(plugin) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    const m   = raw.match(/s:\\d+:\"[^\"]+\"/g) || [];\n    const current = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean);\n    if (!current.includes(plugin)) {\n      current.push(plugin);\n      const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:\"${p}\";`).join(\"\")}}`;\n      await setOption(this.env, \"active_plugins\", serialized);\n    }\n    return { plugin, status: \"active\" };\n  }\n\n  async deactivatePlugin(plugin) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const raw = await getOption(this.env, \"active_plugins\") || \"a:0:{}\";\n    const m   = raw.match(/s:\\d+:\"[^\"]+\"/g) || [];\n    const current = m.map(x => x.match(/s:\\d+:\"([^\"]+)\"/)?.[1]).filter(Boolean).filter(p => p !== plugin);\n    const serialized = `a:${current.length}:{${current.map((p,i)=>`i:${i};s:${p.length}:\"${p}\";`).join(\"\")}}`;\n    await setOption(this.env, \"active_plugins\", serialized);\n    return { plugin, status: \"inactive\" };\n  }\n\n  async getThemes() {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    const activeTemplate   = await getOption(this.env, \"template\")   || \"twentytwentyfour\";\n    const activeStylesheet = await getOption(this.env, \"stylesheet\") || \"twentytwentyfour\";\n    const themes = [];\n    const owner = ghOwner(this.env);\n    const repo  = ghRepo(this.env);\n    if (owner && repo) {\n      try {\n        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/wp-content/themes`, {\n          headers: { \"Authorization\": `Bearer ${this.env.GITHUB_TOKEN}`, \"User-Agent\": \"CloudPress/6.1\" },\n        });\n        if (res.ok) {\n          const items = await res.json();\n          for (const item of (Array.isArray(items) ? items : [])) {\n            if (item.type === \"dir\") {\n              themes.push({\n                stylesheet: item.name, template: item.name,\n                name: { rendered: item.name }, description: { rendered: \"\" },\n                author: { rendered: \"\" }, screenshot: \"\",\n                status: item.name === activeStylesheet ? \"active\" : \"inactive\",\n                is_block_theme: false, textdomain: item.name,\n              });\n            }\n          }\n        }\n      } catch {}\n    }\n    if (!themes.find(t => t.stylesheet === activeStylesheet)) {\n      themes.unshift({\n        stylesheet: activeStylesheet, template: activeTemplate,\n        name: { rendered: activeStylesheet }, description: { rendered: \"\" },\n        author: { rendered: \"\" }, screenshot: \"\", status: \"active\",\n        is_block_theme: false, textdomain: activeStylesheet,\n      });\n    }\n    return themes;\n  }\n\n  async activateTheme(stylesheet) {\n    if (!this.user) throw new Error(\"Unauthorized\");\n    await setOption(this.env, \"stylesheet\", stylesheet);\n    await setOption(this.env, \"template\", stylesheet);\n    await this._invalidateCache();\n    return { stylesheet, template: stylesheet, status: \"active\" };\n  }\n\n  async _invalidateCache() {\n    try {\n      const cache = kv(this.env);\n      if (!cache) return;\n      const list = await cache.list({ prefix: \"page:\" });\n      for (const key of (list.keys||[])) await cache.delete(key.name);\n    } catch {}\n  }\n}\n\n// ─── REST API 라우팅 ─────────────────────────────────────────────────────────\nasync function handleRestApi(request, env, url) {\n  const method = request.method.toUpperCase();\n  const path   = url.pathname.replace(/^\\/wp-json\\/wp\\/v2/, \"\").replace(/\\/$/, \"\") || \"/\";\n  const params = Object.fromEntries(url.searchParams.entries());\n  const user   = await getAuthUser(request, env);\n  const api    = new WpRestApi(env, user);\n\n  let body = {};\n  if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n    try {\n      const ct = request.headers.get(\"Content-Type\") || \"\";\n      if (ct.includes(\"application/json\")) {\n        body = await request.json();\n      } else if (ct.includes(\"multipart/form-data\") || ct.includes(\"application/x-www-form-urlencoded\")) {\n        const fd = await request.formData();\n        for (const [k,v] of fd.entries()) body[k] = v;\n      }\n    } catch {}\n  }\n\n  try {\n    // /posts\n    if (path === \"/posts\" || path === \"\") {\n      if (method === \"GET\") {\n        const { posts, total, pages } = await api.getPosts({ ...params, type: params.type || \"post\" });\n        return json(posts, 200, { \"X-WP-Total\": String(total), \"X-WP-TotalPages\": String(pages) });\n      }\n      if (method === \"POST\") {\n        if (!user) return json({ code: \"rest_not_logged_in\", message: \"Sorry, you are not allowed to create posts.\" }, 401);\n        return json(await api.createPost({ ...body, type: \"post\" }), 201);\n      }\n    }\n    const postMatch = path.match(/^\\/posts\\/(\\d+)$/);\n    if (postMatch) {\n      const id = postMatch[1];\n      if (method === \"GET\") return json(await api.getPost(id));\n      if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updatePost(id, body));\n      }\n      if (method === \"DELETE\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.deletePost(id, params.force === \"true\"));\n      }\n    }\n\n    // /pages\n    if (path === \"/pages\") {\n      if (method === \"GET\") {\n        const { posts, total, pages } = await api.getPosts({ ...params, type: \"page\" });\n        return json(posts, 200, { \"X-WP-Total\": String(total), \"X-WP-TotalPages\": String(pages) });\n      }\n      if (method === \"POST\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.createPost({ ...body, type: \"page\" }), 201);\n      }\n    }\n    const pageMatch = path.match(/^\\/pages\\/(\\d+)$/);\n    if (pageMatch) {\n      const id = pageMatch[1];\n      if (method === \"GET\") return json(await api.getPost(id));\n      if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updatePost(id, body));\n      }\n      if (method === \"DELETE\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.deletePost(id, params.force === \"true\"));\n      }\n    }\n\n    // /media\n    if (path === \"/media\") {\n      if (method === \"GET\") return json(await api.getMedia(params));\n      if (method === \"POST\") {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.uploadMedia(env, request), 201);\n      }\n    }\n\n    // /comments\n    if (path === \"/comments\") {\n      if (method === \"GET\")  return json(await api.getComments(params));\n      if (method === \"POST\") return json(await api.createComment(body), 201);\n    }\n\n    // /users\n    if (path === \"/users\") {\n      if (method === \"GET\") return json(await api.getUsers(params));\n    }\n    const userMatch = path.match(/^\\/users\\/(me|\\d+)$/);\n    if (userMatch) {\n      if (method === \"GET\") return json(await api.getUser(userMatch[1]));\n      if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updateUser(userMatch[1], body));\n      }\n    }\n\n    // /categories /tags\n    for (const [endpoint, taxonomy] of [[\"categories\",\"category\"],[\"tags\",\"post_tag\"]]) {\n      if (path === `/${endpoint}`) {\n        if (method === \"GET\")  return json(await api.getTerms(taxonomy, params));\n        if (method === \"POST\") {\n          if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n          return json(await api.createTerm(taxonomy, body), 201);\n        }\n      }\n      const termMatch = path.match(new RegExp(`^\\\\/${endpoint}\\\\/(\\\\d+)$`));\n      if (termMatch) {\n        if (method === \"GET\") return json((await api.getTerms(taxonomy, { per_page: 1 }))[0] || null);\n        if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n          if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n          return json(await api.updateTerm(taxonomy, termMatch[1], body));\n        }\n        if (method === \"DELETE\") {\n          if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n          return json(await api.deleteTerm(taxonomy, termMatch[1]));\n        }\n      }\n    }\n\n    // /settings\n    if (path === \"/settings\") {\n      if (method === \"GET\") return json(await api.getSettings());\n      if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        return json(await api.updateSettings(body));\n      }\n    }\n\n    // /plugins\n    if (path === \"/plugins\") {\n      if (method === \"GET\") return json(await api.getPlugins());\n    }\n    const pluginMatch = path.match(/^\\/plugins\\/(.+)$/);\n    if (pluginMatch) {\n      const pluginFile = decodeURIComponent(pluginMatch[1]);\n      if ([\"PUT\",\"POST\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        if (body.status === \"active\")   return json(await api.activatePlugin(pluginFile));\n        if (body.status === \"inactive\") return json(await api.deactivatePlugin(pluginFile));\n      }\n    }\n\n    // /themes\n    if (path === \"/themes\") {\n      if (method === \"GET\") return json(await api.getThemes());\n    }\n    const themeMatch = path.match(/^\\/themes\\/(.+)$/);\n    if (themeMatch) {\n      if ([\"POST\",\"PUT\",\"PATCH\"].includes(method)) {\n        if (!user) return json({ code: \"rest_not_logged_in\" }, 401);\n        if (body.status === \"active\") return json(await api.activateTheme(decodeURIComponent(themeMatch[1])));\n      }\n    }\n\n    // /types /taxonomies /statuses\n    if (path === \"/types\") return json({ post:{slug:\"post\",name:\"Posts\",rest_base:\"posts\"}, page:{slug:\"page\",name:\"Pages\",rest_base:\"pages\"}, attachment:{slug:\"attachment\",name:\"Media\",rest_base:\"media\"} });\n    if (path === \"/taxonomies\") return json({ category:{slug:\"category\",name:\"Categories\",rest_base:\"categories\"}, post_tag:{slug:\"post_tag\",name:\"Tags\",rest_base:\"tags\"} });\n    if (path === \"/statuses\") return json({ publish:{name:\"Published\",public:true,queryable:true,slug:\"publish\"}, draft:{name:\"Draft\",public:false,queryable:false,slug:\"draft\"}, private:{name:\"Private\",public:false,queryable:false,slug:\"private\"}, trash:{name:\"Trash\",public:false,queryable:false,slug:\"trash\"} });\n\n    // /wp-json root\n    const siteUrl = await getOption(env, \"siteurl\") || `${url.protocol}//${url.host}`;\n    if (url.pathname === \"/wp-json\" || url.pathname === \"/wp-json/\") {\n      return json({\n        name: await getOption(env, \"blogname\") || \"WordPress 사이트\",\n        description: await getOption(env, \"blogdescription\") || \"\",\n        url: siteUrl, home: siteUrl, gmt_offset: 9,\n        timezone_string: await getOption(env, \"timezone_string\") || \"Asia/Seoul\",\n        namespaces: [\"wp/v2\", \"cloudpress/v1\"],\n        authentication: {},\n        routes: {\n          \"/wp/v2/posts\":      { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/pages\":      { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/media\":      { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/users\":      { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/settings\":   { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/plugins\":    { namespace: \"wp/v2\", methods: [\"GET\",\"POST\",\"PUT\",\"DELETE\"] },\n          \"/wp/v2/themes\":     { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/categories\": { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n          \"/wp/v2/tags\":       { namespace: \"wp/v2\", methods: [\"GET\",\"POST\"] },\n        },\n      });\n    }\n\n    // CloudPress 전용 API\n    if (url.pathname.startsWith(\"/wp-json/cloudpress/v1/\")) {\n      return handleCloudPressApi(request, env, url, user, body, params);\n    }\n\n    return json({ code: \"rest_no_route\", message: \"No route found matching the URL and request method.\", data: { status: 404 } }, 404);\n\n  } catch(e) {\n    console.error(\"[rest-api]\", e);\n    const isAuth = e.message === \"Unauthorized\" || e.message === \"Forbidden\";\n    return json({ code: isAuth ? \"rest_forbidden\" : \"rest_error\", message: e.message }, isAuth ? 403 : 500);\n  }\n}\n\n// ─── CloudPress 전용 REST API ────────────────────────────────────────────────\nasync function handleCloudPressApi(request, env, url, user, body, params) {\n  const path = url.pathname.replace(/^\\/wp-json\\/cloudpress\\/v1/, \"\").replace(/\\/$/, \"\");\n\n  if (path === \"/token\" && request.method === \"POST\") {\n    const { username, password } = body;\n    if (!username || !password) return json({ code: \"missing_credentials\", message: \"아이디와 비밀번호를 입력하세요.\" }, 400);\n    const d = db(env);\n    const u = await d.prepare(\"SELECT * FROM wp_users WHERE user_login=? OR user_email=? LIMIT 1\").bind(username, username).first();\n    if (!u) return json({ code: \"invalid_username\", message: \"존재하지 않는 사용자입니다.\" }, 401);\n    const ok = phpassCheck(password, u.user_pass);\n    if (!ok) return json({ code: \"incorrect_password\", message: \"비밀번호가 올바르지 않습니다.\" }, 401);\n\n    const capsRow = await d.prepare(\"SELECT meta_value FROM wp_usermeta WHERE user_id=? AND meta_key='wp_capabilities'\").bind(u.ID).first();\n    const role    = capsRow?.meta_value?.includes(\"administrator\") ? \"administrator\" : \"subscriber\";\n    const exp     = Math.floor(Date.now()/1000) + 86400 * 30;\n    const token   = await jwtSign({ id: u.ID, login: u.user_login, email: u.user_email, role, exp }, getJwtSecret(env));\n\n    return json({\n      token, user_email: u.user_email,\n      user_nicename: u.user_nicename || u.user_login,\n      user_display_name: u.display_name || u.user_login,\n      roles: [role],\n    }, 200, { \"Set-Cookie\": `wp_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });\n  }\n\n  if (path === \"/token/logout\" && [\"POST\",\"DELETE\"].includes(request.method)) {\n    return json({ message: \"로그아웃 완료\" }, 200, { \"Set-Cookie\": \"wp_token=; Path=/; HttpOnly; Max-Age=0\" });\n  }\n\n  if (path === \"/token/validate\" && request.method === \"POST\") {\n    if (!user) return json({ code: \"jwt_auth_invalid_token\", message: \"유효하지 않은 토큰입니다.\" }, 401);\n    return json({ code: \"jwt_auth_valid_token\", data: { status: 200 } });\n  }\n\n  if (path === \"/github-upload\" && request.method === \"POST\") {\n    if (!user || user.role !== \"administrator\") return json({ code: \"rest_forbidden\" }, 403);\n    const { file_path, content_base64, commit_message = \"Upload via CloudPress\" } = body;\n    if (!file_path || !content_base64) return json({ code: \"missing_params\" }, 400);\n    const owner = ghOwner(env);\n    const repo  = ghRepo(env);\n    const token = env.GITHUB_TOKEN;\n    if (!owner || !repo || !token) return json({ code: \"github_not_configured\", message: \"GitHub 저장소가 설정되지 않았습니다.\" }, 503);\n    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file_path}`, {\n      method: \"PUT\",\n      headers: { \"Authorization\": `Bearer ${token}`, \"Content-Type\": \"application/json\", \"User-Agent\": \"CloudPress/6.1\" },\n      body: JSON.stringify({ message: commit_message, content: content_base64 }),\n    });\n    if (!res.ok) {\n      const e = await res.json();\n      return json({ code: \"github_error\", message: e.message }, 500);\n    }\n    return json({ success: true, file_path });\n  }\n\n  return json({ code: \"not_found\" }, 404);\n}\n\n// ─── WordPress 관리자 UI 렌더링 ──────────────────────────────────────────────\nasync function buildAdminPage(env, url, user) {\n  const siteUrl  = await getOption(env, \"siteurl\") || `${url.protocol}//${url.host}`;\n  const blogname = await getOption(env, \"blogname\") || \"WordPress 사이트\";\n\n  return `<!DOCTYPE html>\n<html lang=\"ko\" class=\"wp-toolbar\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>${blogname} — WordPress</title>\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"/wp-admin/css/wp-admin.min.css\">\n<link rel=\"stylesheet\" href=\"/wp-admin/css/colors/fresh/colors.min.css\">\n<link rel=\"stylesheet\" href=\"/wp-admin/css/common.min.css\">\n<style>\n:root { --wp-admin-theme-color: #2271b1; --wp-admin-theme-color--rgb: 34,113,177; }\n#wpadminbar { position:fixed; top:0; left:0; right:0; z-index:99999; }\n#adminmenuwrap { position:fixed; top:32px; bottom:0; width:160px; }\n#wpcontent, #wpfooter { margin-left:160px; }\n@media screen and (max-width:782px) {\n  #adminmenuwrap { position:static; width:100%; }\n  #wpcontent { margin-left:0; }\n}\n.notice { background:#fff; border-left:4px solid #2271b1; padding:12px; margin:20px 0; }\n.notice-success { border-left-color:#00a32a; }\n.notice-error   { border-left-color:#d63638; }\n#wp-auth-check-wrap { display:none; }\n#cp-loading { position:fixed; inset:0; background:rgba(255,255,255,.8); z-index:999998; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; font-size:14px; color:#1d2327; }\n#cp-loading.hidden { display:none; }\n</style>\n</head>\n<body class=\"wp-core-ui js auto-fold branch-6-7 version-6-7-2 locale-ko_KR\">\n<div id=\"cp-loading\">\n  <div style=\"width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#2271b1;border-radius:50%;animation:spin .7s linear infinite;\"></div>\n  <span>WordPress 불러오는 중...</span>\n</div>\n<style>@keyframes spin{to{transform:rotate(360deg)}}</style>\n\n<div id=\"wpadminbar\" style=\"height:32px;background:#1d2327;color:#fff;display:flex;align-items:center;padding:0 16px;gap:16px;font-size:13px;\">\n  <a href=\"${siteUrl}\" target=\"_blank\" style=\"color:#a7aaad;text-decoration:none;\">🏠 사이트 보기</a>\n  <span style=\"color:#a7aaad;\">|</span>\n  <span style=\"color:#fff;font-weight:600;\">${blogname}</span>\n  <span style=\"flex:1\"></span>\n  <a href=\"#\" id=\"wp-logout-btn\" style=\"color:#a7aaad;text-decoration:none;font-size:12px;\">로그아웃</a>\n</div>\n\n<div id=\"adminmenuwrap\" style=\"background:#1d2327;padding-top:8px;overflow-y:auto;\">\n  <ul id=\"adminmenu\" style=\"list-style:none;margin:0;padding:0;\">\n    ${[\n      [\"index.php\",\"📊\",\"알림판\"],\n      [\"edit.php\",\"📝\",\"글\"],\n      [\"edit.php?post_type=page\",\"📄\",\"페이지\"],\n      [\"upload.php\",\"🖼\",\"미디어\"],\n      [\"edit-comments.php\",\"💬\",\"댓글\"],\n      [\"themes.php\",\"🎨\",\"외모\"],\n      [\"plugins.php\",\"🔌\",\"플러그인\"],\n      [\"users.php\",\"👥\",\"사용자\"],\n      [\"options-general.php\",\"⚙️\",\"설정\"],\n    ].map(([href, icon, label]) =>\n      `<li><a href=\"/wp-admin/${href}\" style=\"display:flex;align-items:center;gap:10px;padding:8px 16px;color:#a7aaad;text-decoration:none;font-size:13px;\">${icon} ${label}</a></li>`\n    ).join(\"\")}\n  </ul>\n</div>\n\n<div id=\"wpcontent\" style=\"padding-top:32px;\">\n  <div id=\"wpbody\">\n    <div id=\"wpbody-content\" style=\"padding:20px;\">\n      <div id=\"cp-admin-app\"></div>\n    </div>\n  </div>\n</div>\n\n<script>\nconst WP_API = '/wp-json';\nconst CP_API = '/wp-json/cloudpress/v1';\nconst siteUrl = '${siteUrl}';\n\n// 인증 토큰 가져오기\nfunction getToken() {\n  return document.cookie.match(/(?:^|;\\\\s*)wp_token=([^;]+)/)?.[1];\n}\n\nasync function apiFetch(path, opts = {}) {\n  const token = getToken();\n  const res = await fetch(path, {\n    ...opts,\n    headers: {\n      'Content-Type': 'application/json',\n      ...(token ? { 'Authorization': 'Bearer ' + decodeURIComponent(token) } : {}),\n      ...(opts.headers || {}),\n    },\n  });\n  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);\n  return res.json();\n}\n\n// 현재 페이지 감지\nconst page = location.pathname.replace(/^\\\\/wp-admin\\\\//, '') || 'index.php';\nconst searchP = new URLSearchParams(location.search);\n\nasync function renderPage() {\n  const app = document.getElementById('cp-admin-app');\n  document.getElementById('cp-loading').classList.add('hidden');\n\n  if (page === 'index.php' || page === '') {\n    const [posts, pages, comments] = await Promise.all([\n      apiFetch(WP_API + '/wp/v2/posts?per_page=5').catch(() => []),\n      apiFetch(WP_API + '/wp/v2/pages?per_page=5').catch(() => []),\n      apiFetch(WP_API + '/wp/v2/comments?per_page=5').catch(() => []),\n    ]);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>알림판</h1>\n        <div style=\"display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:20px 0;\">\n          <div style=\"background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;\">\n            <div style=\"font-size:2rem;font-weight:700;color:#2271b1;\">\\${posts.length}</div>\n            <div style=\"color:#646970;\">최근 글</div>\n          </div>\n          <div style=\"background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;\">\n            <div style=\"font-size:2rem;font-weight:700;color:#2271b1;\">\\${pages.length}</div>\n            <div style=\"color:#646970;\">페이지</div>\n          </div>\n          <div style=\"background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;\">\n            <div style=\"font-size:2rem;font-weight:700;color:#2271b1;\">\\${comments.length}</div>\n            <div style=\"color:#646970;\">댓글</div>\n          </div>\n        </div>\n        <div style=\"background:#fff;padding:20px;border:1px solid #c3c4c7;border-radius:4px;margin-top:16px;\">\n          <h2 style=\"font-size:14px;margin:0 0 12px;\">최근 글</h2>\n          \\${posts.map(p => \\`<div style=\"padding:8px 0;border-bottom:1px solid #f0f0f1;\"><a href=\"\\${p.link}\" target=\"_blank\">\\${p.title.rendered}</a> — <span style=\"color:#646970;font-size:12px;\">\\${p.date?.slice(0,10)}</span></div>\\`).join('') || '<p style=\"color:#646970;\">글이 없습니다.</p>'}\n        </div>\n      </div>\\`;\n  }\n  else if (page === 'edit.php' || page.startsWith('edit.php')) {\n    const postType = searchP.get('post_type') || 'post';\n    const endpoint = postType === 'page' ? 'pages' : 'posts';\n    const items = await apiFetch(\\`\\${WP_API}/wp/v2/\\${endpoint}?per_page=20&status=any\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>\\${postType === 'page' ? '페이지 목록' : '글 목록'}\n          <a href=\"/wp-admin/post-new.php\\${postType === 'page' ? '?post_type=page' : ''}\" style=\"margin-left:12px;font-size:13px;background:#2271b1;color:#fff;padding:4px 12px;border-radius:3px;text-decoration:none;\">새로 추가</a>\n        </h1>\n        <table style=\"width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;\">\n          <thead><tr style=\"background:#f6f7f7;\"><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">제목</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">상태</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">날짜</th><th style=\"padding:8px 12px;border-bottom:1px solid #c3c4c7;\">작업</th></tr></thead>\n          <tbody>\n            \\${items.map(p => \\`<tr>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\"><a href=\"/wp-admin/post.php?post=\\${p.id}&action=edit\">\\${p.title.rendered || '(제목 없음)'}</a></td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${p.status}</td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${(p.date||'').slice(0,10)}</td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\n                <a href=\"/wp-admin/post.php?post=\\${p.id}&action=edit\" style=\"margin-right:8px;\">수정</a>\n                <a href=\"\\${p.link}\" target=\"_blank\">보기</a>\n              </td>\n            </tr>\\`).join('') || '<tr><td colspan=\"4\" style=\"padding:20px;text-align:center;color:#646970;\">항목이 없습니다.</td></tr>'}\n          </tbody>\n        </table>\n      </div>\\`;\n  }\n  else if (page === 'post-new.php' || (page === 'post.php' && searchP.get('action') === 'edit')) {\n    const postId  = searchP.get('post');\n    const postType = searchP.get('post_type') || 'post';\n    let existing = { title: { rendered: '' }, content: { raw: '' }, status: 'draft' };\n    if (postId) {\n      const ep = postType === 'page' ? 'pages' : 'posts';\n      existing = await apiFetch(\\`\\${WP_API}/wp/v2/\\${ep}/\\${postId}\\`).catch(() => existing);\n    }\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>\\${postId ? '글 수정' : '새 글 추가'}</h1>\n        <div style=\"display:grid;grid-template-columns:1fr 280px;gap:16px;margin-top:16px;\">\n          <div>\n            <input id=\"post-title\" type=\"text\" value=\"\\${existing.title.rendered}\" placeholder=\"제목 입력...\" style=\"width:100%;padding:12px;font-size:20px;border:1px solid #8c8f94;border-radius:4px;margin-bottom:12px;box-sizing:border-box;\">\n            <textarea id=\"post-content\" style=\"width:100%;height:400px;padding:12px;border:1px solid #8c8f94;border-radius:4px;font-size:14px;font-family:monospace;box-sizing:border-box;\">\\${existing.content?.raw || ''}</textarea>\n          </div>\n          <div>\n            <div style=\"background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:16px;margin-bottom:16px;\">\n              <h2 style=\"font-size:14px;margin:0 0 12px;\">공개 설정</h2>\n              <select id=\"post-status\" style=\"width:100%;padding:6px;margin-bottom:12px;\">\n                <option value=\"publish\" \\${existing.status==='publish'?'selected':''}>공개</option>\n                <option value=\"draft\"   \\${existing.status==='draft'  ?'selected':''}>임시글</option>\n                <option value=\"private\" \\${existing.status==='private'?'selected':''}>비공개</option>\n              </select>\n              <button id=\"save-post\" style=\"width:100%;padding:8px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;\">\\${existing.status === 'publish' ? '업데이트' : '발행'}</button>\n            </div>\n          </div>\n        </div>\n      </div>\\`;\n\n    document.getElementById('save-post').onclick = async () => {\n      const title   = document.getElementById('post-title').value;\n      const content = document.getElementById('post-content').value;\n      const status  = document.getElementById('post-status').value;\n      const ep = postType === 'page' ? 'pages' : 'posts';\n      try {\n        const saved = postId\n          ? await apiFetch(\\`\\${WP_API}/wp/v2/\\${ep}/\\${postId}\\`, { method:'POST', body: JSON.stringify({title,content,status}) })\n          : await apiFetch(\\`\\${WP_API}/wp/v2/\\${ep}\\`, { method:'POST', body: JSON.stringify({title,content,status}) });\n        alert('저장되었습니다!');\n        location.href = \\`/wp-admin/post.php?post=\\${saved.id}&action=edit\\`;\n      } catch(e) { alert('저장 실패: ' + e.message); }\n    };\n  }\n  else if (page === 'upload.php') {\n    const media = await apiFetch(\\`\\${WP_API}/wp/v2/media?per_page=20\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>미디어 라이브러리</h1>\n        <input type=\"file\" id=\"media-upload\" accept=\"image/*,video/*,audio/*\" style=\"margin:16px 0;\">\n        <button onclick=\"uploadMedia()\" style=\"padding:6px 16px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;\">업로드</button>\n        <div style=\"display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:20px;\">\n          \\${media.map(m => \\`<div style=\"border:1px solid #c3c4c7;border-radius:4px;overflow:hidden;\">\n            \\${m.media_type==='image' ? \\`<img src=\"\\${m.source_url}\" style=\"width:100%;height:120px;object-fit:cover;\">\\` : \\`<div style=\"height:120px;background:#f6f7f7;display:flex;align-items:center;justify-content:center;font-size:32px;\">📄</div>\\`}\n            <div style=\"padding:8px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\">\\${m.title.rendered}</div>\n          </div>\\`).join('') || '<p style=\"color:#646970;\">미디어가 없습니다.</p>'}\n        </div>\n      </div>\\`;\n\n    window.uploadMedia = async () => {\n      const file = document.getElementById('media-upload').files[0];\n      if (!file) return;\n      const token = getToken();\n      const res   = await fetch(\\`\\${WP_API}/wp/v2/media\\`, {\n        method: 'POST',\n        headers: { 'Authorization': 'Bearer ' + decodeURIComponent(token), 'Content-Disposition': \\`attachment; filename=\"\\${file.name}\"\\`, 'Content-Type': file.type },\n        body: file,\n      });\n      if (res.ok) { alert('업로드 완료!'); location.reload(); }\n      else alert('업로드 실패');\n    };\n  }\n  else if (page === 'edit-comments.php') {\n    const comments = await apiFetch(\\`\\${WP_API}/wp/v2/comments?per_page=20\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>댓글</h1>\n        <table style=\"width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;\">\n          <thead><tr style=\"background:#f6f7f7;\"><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">작성자</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">내용</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">날짜</th></tr></thead>\n          <tbody>\n            \\${comments.map(c => \\`<tr><td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${c.author_name}</td><td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${c.content.rendered}</td><td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${(c.date||'').slice(0,10)}</td></tr>\\`).join('') || '<tr><td colspan=\"3\" style=\"padding:20px;text-align:center;color:#646970;\">댓글이 없습니다.</td></tr>'}\n          </tbody>\n        </table>\n      </div>\\`;\n  }\n  else if (page === 'options-general.php') {\n    const settings = await apiFetch(\\`\\${WP_API}/wp/v2/settings\\`).catch(() => ({}));\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>일반 설정</h1>\n        <table style=\"background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;width:100%;max-width:700px;margin-top:16px;\">\n          \\${[\n            ['사이트 제목','title','text',settings.title||''],\n            ['태그라인','description','text',settings.description||''],\n            ['관리자 이메일','email','email',settings.email||''],\n            ['타임존','timezone','text',settings.timezone||'Asia/Seoul'],\n            ['페이지당 글 수','posts_per_page','number',settings.posts_per_page||10],\n          ].map(([label,name,type,val]) => \\`<tr>\n            <th style=\"padding:12px 16px;text-align:left;border-bottom:1px solid #f0f0f1;width:200px;background:#f6f7f7;\">\\${label}</th>\n            <td style=\"padding:12px 16px;border-bottom:1px solid #f0f0f1;\"><input type=\"\\${type}\" id=\"s-\\${name}\" value=\"\\${val}\" style=\"padding:6px;border:1px solid #8c8f94;border-radius:4px;width:300px;\"></td>\n          </tr>\\`).join('')}\n        </table>\n        <p style=\"margin-top:16px;\"><button id=\"save-settings\" style=\"padding:8px 16px;background:#2271b1;color:#fff;border:none;border-radius:4px;cursor:pointer;\">변경 사항 저장</button></p>\n      </div>\\`;\n\n    document.getElementById('save-settings').onclick = async () => {\n      const data = {};\n      ['title','description','email','timezone','posts_per_page'].forEach(k => {\n        const el = document.getElementById('s-' + k);\n        if (el) data[k] = k === 'posts_per_page' ? parseInt(el.value) : el.value;\n      });\n      try {\n        await apiFetch(\\`\\${WP_API}/wp/v2/settings\\`, { method:'POST', body: JSON.stringify(data) });\n        alert('저장되었습니다!');\n      } catch(e) { alert('저장 실패: ' + e.message); }\n    };\n  }\n  else if (page === 'themes.php') {\n    const themes = await apiFetch(\\`\\${WP_API}/wp/v2/themes\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>테마</h1>\n        <div style=\"display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px;\">\n          \\${themes.map(t => \\`<div style=\"background:#fff;border:\\${t.status==='active'?'2px solid #2271b1':'1px solid #c3c4c7'};border-radius:4px;overflow:hidden;\">\n            <div style=\"padding:16px;\">\n              <div style=\"font-weight:700;\">\\${t.name.rendered}</div>\n              \\${t.status==='active' ? '<div style=\"color:#2271b1;font-size:12px;margin-top:4px;\">✓ 활성화됨</div>' : \\`<button onclick=\"activateTheme('\\${t.stylesheet}')\" style=\"margin-top:8px;padding:4px 12px;background:#f0f0f1;border:1px solid #c3c4c7;border-radius:3px;cursor:pointer;font-size:12px;\">활성화</button>\\`}\n            </div>\n          </div>\\`).join('') || '<p style=\"color:#646970;\">테마가 없습니다.</p>'}\n        </div>\n      </div>\\`;\n\n    window.activateTheme = async (stylesheet) => {\n      try {\n        await apiFetch(\\`\\${WP_API}/wp/v2/themes/\\${stylesheet}\\`, { method:'POST', body: JSON.stringify({status:'active'}) });\n        alert('테마가 활성화되었습니다!');\n        location.reload();\n      } catch(e) { alert('실패: ' + e.message); }\n    };\n  }\n  else if (page === 'plugins.php') {\n    const plugins = await apiFetch(\\`\\${WP_API}/wp/v2/plugins\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>플러그인</h1>\n        <table style=\"width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;\">\n          <thead><tr style=\"background:#f6f7f7;\"><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">플러그인</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">상태</th><th style=\"padding:8px 12px;border-bottom:1px solid #c3c4c7;\">작업</th></tr></thead>\n          <tbody>\n            \\${plugins.map(p => \\`<tr>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;font-weight:600;\">\\${p.name}</td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${p.status === 'active' ? '<span style=\"color:#00a32a;\">활성화됨</span>' : '<span style=\"color:#646970;\">비활성화됨</span>'}</td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\n                \\${p.status === 'active'\n                  ? \\`<button onclick=\"togglePlugin('\\${encodeURIComponent(p.plugin)}','inactive')\" style=\"padding:4px 12px;cursor:pointer;\">비활성화</button>\\`\n                  : \\`<button onclick=\"togglePlugin('\\${encodeURIComponent(p.plugin)}','active')\" style=\"padding:4px 12px;background:#2271b1;color:#fff;border:none;border-radius:3px;cursor:pointer;\">활성화</button>\\`}\n              </td>\n            </tr>\\`).join('') || '<tr><td colspan=\"3\" style=\"padding:20px;text-align:center;color:#646970;\">플러그인이 없습니다. GitHub 레포에 wp-content/plugins/ 폴더를 추가하세요.</td></tr>'}\n          </tbody>\n        </table>\n      </div>\\`;\n\n    window.togglePlugin = async (plugin, status) => {\n      try {\n        await apiFetch(\\`\\${WP_API}/wp/v2/plugins/\\${plugin}\\`, { method:'PUT', body: JSON.stringify({status}) });\n        location.reload();\n      } catch(e) { alert('실패: ' + e.message); }\n    };\n  }\n  else if (page === 'users.php') {\n    const users = await apiFetch(\\`\\${WP_API}/wp/v2/users\\`).catch(() => []);\n    app.innerHTML = \\`\n      <div class=\"wrap\">\n        <h1>사용자</h1>\n        <table style=\"width:100%;background:#fff;border:1px solid #c3c4c7;border-collapse:collapse;margin-top:16px;\">\n          <thead><tr style=\"background:#f6f7f7;\"><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">사용자</th><th style=\"padding:8px 12px;text-align:left;border-bottom:1px solid #c3c4c7;\">이름</th></tr></thead>\n          <tbody>\n            \\${users.map(u => \\`<tr>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${u.slug}</td>\n              <td style=\"padding:8px 12px;border-bottom:1px solid #f0f0f1;\">\\${u.name}</td>\n            </tr>\\`).join('')}\n          </tbody>\n        </table>\n      </div>\\`;\n  }\n  else {\n    app.innerHTML = \\`<div class=\"wrap\"><h1>페이지를 찾을 수 없습니다</h1><p><a href=\"/wp-admin/\">알림판으로 이동</a></p></div>\\`;\n  }\n}\n\n// 로그아웃\ndocument.getElementById('wp-logout-btn').onclick = async (e) => {\n  e.preventDefault();\n  await fetch(CP_API + '/token/logout', { method:'POST' });\n  location.href = '/wp-login.php';\n};\n\n// 인증 확인 후 렌더링\nfetch(CP_API + '/token/validate', {\n  method: 'POST',\n  headers: getToken() ? { 'Authorization': 'Bearer ' + decodeURIComponent(getToken()) } : {},\n}).then(r => r.json()).then(d => {\n  if (d.code !== 'jwt_auth_valid_token') {\n    location.href = '/wp-login.php?redirect_to=' + encodeURIComponent(location.href);\n  } else {\n    renderPage().catch(e => {\n      console.error(e);\n      document.getElementById('cp-loading').classList.add('hidden');\n      document.getElementById('cp-admin-app').innerHTML = '<div class=\"wrap\"><div class=\"notice notice-error\"><p>오류: ' + e.message + '</p></div></div>';\n    });\n  }\n}).catch(() => { location.href = '/wp-login.php'; });\n</script>\n</body>\n</html>`;\n}\n\n// ─── WordPress 로그인 페이지 ─────────────────────────────────────────────────\nfunction buildLoginPage(siteUrl, blogname, error = \"\") {\n  return `<!DOCTYPE html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>로그인 — ${blogname}</title>\n<link rel=\"stylesheet\" href=\"/wp-admin/css/wp-admin.min.css\">\n<style>\nbody { background:#f0f0f1; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; font-family:-apple-system,BlinkMacSystemFont,sans-serif; }\n#login { width:320px; }\n#login h1 a { display:block; text-align:center; font-size:24px; font-weight:800; color:#1d2327; text-decoration:none; margin-bottom:20px; }\n#loginform { background:#fff; padding:26px; border:1px solid #c3c4c7; border-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,.04); }\n#loginform label { display:block; font-size:14px; font-weight:600; margin-bottom:4px; }\n#loginform input[type=text],\n#loginform input[type=password] { width:100%; padding:8px; border:1px solid #8c8f94; border-radius:4px; font-size:15px; margin-bottom:14px; box-sizing:border-box; }\n#wp-submit { width:100%; padding:10px; background:#2271b1; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:14px; font-weight:600; }\n#wp-submit:hover { background:#135e96; }\n.login-error { background:#fff; border-left:4px solid #d63638; padding:12px; margin-bottom:16px; border-radius:4px; font-size:14px; }\n</style>\n</head>\n<body>\n<div id=\"login\">\n  <h1><a href=\"${siteUrl}\">${blogname}</a></h1>\n  ${error ? `<div class=\"login-error\">${error}</div>` : \"\"}\n  <form id=\"loginform\" method=\"post\">\n    <label for=\"user_login\">아이디 또는 이메일</label>\n    <input id=\"user_login\" type=\"text\" name=\"log\" autocomplete=\"username\" autofocus>\n    <label for=\"user_pass\">비밀번호</label>\n    <input id=\"user_pass\" type=\"password\" name=\"pwd\" autocomplete=\"current-password\">\n    <input id=\"wp-submit\" type=\"submit\" value=\"로그인\">\n  </form>\n</div>\n<script>\ndocument.getElementById('loginform').addEventListener('submit', async function(e) {\n  e.preventDefault();\n  const username = document.getElementById('user_login').value;\n  const password = document.getElementById('user_pass').value;\n  const btn      = document.getElementById('wp-submit');\n  btn.value = '로그인 중...'; btn.disabled = true;\n  try {\n    const res = await fetch('/wp-json/cloudpress/v1/token', {\n      method:'POST',\n      headers:{'Content-Type':'application/json'},\n      body: JSON.stringify({username, password}),\n    });\n    const data = await res.json();\n    if (!res.ok) throw new Error(data.message || '로그인 실패');\n    const redirect = new URLSearchParams(location.search).get('redirect_to') || '/wp-admin/';\n    location.href = redirect;\n  } catch(err) {\n    document.querySelector('.login-error')?.remove();\n    const errDiv = document.createElement('div');\n    errDiv.className = 'login-error';\n    errDiv.textContent = err.message;\n    document.getElementById('loginform').before(errDiv);\n    btn.value = '로그인'; btn.disabled = false;\n  }\n});\n</script>\n</body>\n</html>`;\n}\n\n// ─── 프론트엔드 WordPress 렌더링 ─────────────────────────────────────────────\nasync function buildFrontPage(env, url) {\n  const siteUrl   = await getOption(env, \"siteurl\")         || `${url.protocol}//${url.host}`;\n  const blogname  = await getOption(env, \"blogname\")        || \"WordPress 사이트\";\n  const blogdesc  = await getOption(env, \"blogdescription\") || \"\";\n\n  const path    = url.pathname.replace(/\\/$/, \"\") || \"/\";\n  const d       = db(env);\n\n  // 특정 페이지 slug 체크\n  if (path !== \"/\" && d) {\n    const post = await d.prepare(\n      \"SELECT * FROM wp_posts WHERE post_name=? AND post_status='publish' LIMIT 1\"\n    ).bind(path.replace(/^\\//, \"\")).first().catch(() => null);\n    if (post) {\n      return buildPostHtml(post, siteUrl, blogname, blogdesc);\n    }\n  }\n\n  // 메인 페이지: 최근 글 목록\n  const posts = d ? (await d.prepare(\n    \"SELECT * FROM wp_posts WHERE post_status='publish' AND post_type='post' ORDER BY post_date DESC LIMIT 10\"\n  ).all().catch(() => ({ results: [] }))).results || [] : [];\n\n  const postsHtml = posts.length === 0\n    ? `<p style=\"color:#6b7280;padding:40px;text-align:center;\">아직 작성된 글이 없습니다.</p>`\n    : posts.map(p => `\n        <article style=\"background:#fff;border-radius:8px;padding:24px;border:1px solid #e5e7eb;margin-bottom:16px;\">\n          <h2 style=\"margin:0 0 8px;\"><a href=\"/${p.post_name}/\" style=\"color:#1d2327;text-decoration:none;\">${p.post_title}</a></h2>\n          <div style=\"color:#6b7280;font-size:13px;margin-bottom:12px;\">${(p.post_date||\"\").slice(0,10)}</div>\n          <div style=\"color:#374151;line-height:1.6;\">${(p.post_excerpt || p.post_content || \"\").slice(0,200).replace(/<[^>]*>/g,\"\")}${p.post_content?.length > 200 ? \"...\" : \"\"}</div>\n          <a href=\"/${p.post_name}/\" style=\"display:inline-block;margin-top:12px;color:#2271b1;text-decoration:none;font-size:14px;\">더 읽기 →</a>\n        </article>`\n    ).join(\"\");\n\n  return `<!DOCTYPE html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>${blogname}</title>\n<meta name=\"description\" content=\"${blogdesc}\">\n<link rel=\"stylesheet\" href=\"/wp-includes/css/dist/block-library/style.min.css\">\n<style>\n*{box-sizing:border-box}\nbody{margin:0;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:#f9fafb;color:#1d2327;}\nheader{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 0;}\n.container{max-width:800px;margin:0 auto;padding:0 16px;}\nnav a{color:#2271b1;text-decoration:none;margin-right:16px;font-size:14px;}\nnav a:hover{text-decoration:underline;}\nmain{padding:32px 0;}\nfooter{background:#fff;border-top:1px solid #e5e7eb;padding:16px;text-align:center;color:#6b7280;font-size:13px;margin-top:40px;}\n</style>\n</head>\n<body>\n<header>\n  <div class=\"container\" style=\"display:flex;align-items:center;justify-content:space-between;\">\n    <a href=\"/\" style=\"font-size:20px;font-weight:700;color:#1d2327;text-decoration:none;\">${blogname}</a>\n    <nav>\n      <a href=\"/\">홈</a>\n      <a href=\"/wp-admin/\">관리자</a>\n    </nav>\n  </div>\n</header>\n<main>\n  <div class=\"container\">\n    ${blogdesc ? `<p style=\"color:#6b7280;margin-bottom:24px;\">${blogdesc}</p>` : \"\"}\n    ${postsHtml}\n  </div>\n</main>\n<footer>\n  <p>${blogname} &mdash; Powered by <a href=\"https://cloudpress.site\" style=\"color:#2271b1;\">CloudPress</a></p>\n</footer>\n</body>\n</html>`;\n}\n\nfunction buildPostHtml(post, siteUrl, blogname, blogdesc) {\n  return `<!DOCTYPE html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>${post.post_title} — ${blogname}</title>\n<link rel=\"stylesheet\" href=\"/wp-includes/css/dist/block-library/style.min.css\">\n<style>\n*{box-sizing:border-box}\nbody{margin:0;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:#f9fafb;color:#1d2327;}\nheader{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 0;}\n.container{max-width:800px;margin:0 auto;padding:0 16px;}\nnav a{color:#2271b1;text-decoration:none;margin-right:16px;font-size:14px;}\narticle{background:#fff;border-radius:8px;padding:32px;border:1px solid #e5e7eb;margin-top:24px;line-height:1.8;}\narticle h1{margin-top:0;}\n.post-meta{color:#6b7280;font-size:13px;margin-bottom:24px;}\nfooter{background:#fff;border-top:1px solid #e5e7eb;padding:16px;text-align:center;color:#6b7280;font-size:13px;margin-top:40px;}\n</style>\n</head>\n<body>\n<header>\n  <div class=\"container\" style=\"display:flex;align-items:center;justify-content:space-between;\">\n    <a href=\"/\" style=\"font-size:20px;font-weight:700;color:#1d2327;text-decoration:none;\">${blogname}</a>\n    <nav><a href=\"/\">홈</a><a href=\"/wp-admin/\">관리자</a></nav>\n  </div>\n</header>\n<div class=\"container\">\n  <article>\n    <h1>${post.post_title}</h1>\n    <div class=\"post-meta\">${(post.post_date||\"\").slice(0,10)}</div>\n    <div>${post.post_content || \"\"}</div>\n  </article>\n  <p style=\"margin-top:16px;\"><a href=\"/\" style=\"color:#2271b1;text-decoration:none;\">← 목록으로</a></p>\n</div>\n<footer>\n  <p>${blogname} &mdash; Powered by <a href=\"https://cloudpress.site\" style=\"color:#2271b1;\">CloudPress</a></p>\n</footer>\n</body>\n</html>`;\n}\n\n// ─── 메인 fetch 핸들러 ────────────────────────────────────────────────────────\nexport default {\n  async fetch(request, env, ctx) {\n    const url    = new URL(request.url);\n    const path   = url.pathname;\n    const method = request.method.toUpperCase();\n\n    // CORS Preflight\n    if (method === \"OPTIONS\") {\n      return new Response(null, { status: 204, headers: CORS });\n    }\n\n    // ── WordPress 코어 정적 자산 (wp-admin/*, wp-includes/*) ────────────────\n    if (STATIC_EXT.test(path)) {\n      // 1) 사용자 GitHub 레포에서 서빙 (테마/플러그인)\n      if (path.startsWith(\"/wp-content/\")) {\n        const repoPath = path.replace(/^\\//, \"\");\n        const ghRes    = await serveGithubAsset(env, repoPath);\n        if (ghRes) return ghRes;\n      }\n      // 2) WordPress 공식 코어에서 서빙\n      const corePath = path.replace(/^\\//, \"\");\n      const coreRes  = await serveCoreAsset(corePath);\n      if (coreRes) return coreRes;\n\n      return new Response(\"Not Found\", { status: 404, headers: CORS });\n    }\n\n    // ── REST API ─────────────────────────────────────────────────────────────\n    if (path.startsWith(\"/wp-json\")) {\n      // DB가 없으면 아직 프로비저닝 중\n      const d = db(env);\n      if (!d) return json({ error: \"Database not ready. Please wait for provisioning to complete.\" }, 503);\n\n      // DB 있고 WordPress 미설치시 자동 설치\n      const installed = await isWpInstalled(env);\n      if (!installed) {\n        const ok = await autoInstallWordPress(env, url);\n        if (!ok) return json({ error: \"WordPress installation failed.\" }, 500);\n      }\n      return handleRestApi(request, env, url);\n    }\n\n    // ── WordPress 관리자 ──────────────────────────────────────────────────────\n    if (path.startsWith(\"/wp-admin\")) {\n      const d = db(env);\n      if (!d) return html(`<html><body><h1>프로비저닝 중...</h1><p>잠시 후 다시 시도해 주세요.</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>`);\n\n      const installed = await isWpInstalled(env);\n      if (!installed) {\n        const ok = await autoInstallWordPress(env, url);\n        if (!ok) return html(`<html><body><h1>WordPress 초기화 실패</h1><p>D1 데이터베이스 바인딩을 확인해 주세요.</p></body></html>`, 500);\n      }\n\n      const user = await getAuthUser(request, env);\n      const page = await buildAdminPage(env, url, user);\n      return html(page);\n    }\n\n    // ── WordPress 로그인 ──────────────────────────────────────────────────────\n    if (path === \"/wp-login.php\" || path === \"/wp-login\") {\n      const siteUrl  = `${url.protocol}//${url.host}`;\n      const blogname = await getOption(env, \"blogname\").catch(() => \"WordPress\");\n      return html(buildLoginPage(siteUrl, blogname || \"WordPress\"));\n    }\n\n    // ── 사이트맵 ─────────────────────────────────────────────────────────────\n    if (path === \"/sitemap.xml\" || path === \"/sitemap\") {\n      const siteUrl = `${url.protocol}//${url.host}`;\n      const d = db(env);\n      const posts = d ? (await d.prepare(\"SELECT post_name, post_modified FROM wp_posts WHERE post_status='publish' ORDER BY post_modified DESC LIMIT 100\").all().catch(() => ({ results: [] }))).results || [] : [];\n      const urls = posts.map(p => `  <url><loc>${siteUrl}/${p.post_name}/</loc><lastmod>${(p.post_modified||\"\").slice(0,10)}</lastmod></url>`).join(\"\\n\");\n      return new Response(`<?xml version=\"1.0\" encoding=\"UTF-8\"?>\\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\\n  <url><loc>${siteUrl}/</loc></url>\\n${urls}\\n</urlset>`, {\n        headers: { \"Content-Type\": \"application/xml; charset=utf-8\" },\n      });\n    }\n\n    // ── 프론트엔드 WordPress ─────────────────────────────────────────────────\n    const d = db(env);\n    if (!d) {\n      return html(`<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>CloudPress</title></head><body style=\"font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb;\">\n      <div style=\"text-align:center;\"><h1 style=\"color:#2271b1;\">🚀 CloudPress</h1><p style=\"color:#6b7280;\">사이트를 준비 중입니다. 잠시 후 다시 시도해 주세요.</p><script>setTimeout(()=>location.reload(),10000)</script></div></body></html>`);\n    }\n\n    const installed = await isWpInstalled(env);\n    if (!installed) {\n      await autoInstallWordPress(env, url);\n    }\n\n    const frontPage = await buildFrontPage(env, url);\n    return html(frontPage);\n  },\n};\n";
}
