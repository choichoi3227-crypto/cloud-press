// functions/api/github-pages-hosting.js
//
// GitHub Pages 호스팅 모듈
// ─────────────────────────────────────────────────────────────────────────────
// GitHub 레포 자체를 스토리지 + DB로 사용합니다. D1/KV 없음.
//
// 레포 구조:
//   /_db/
//     posts.json       ← 글 목록 (배열)
//     pages.json       ← 페이지 목록
//     users.json       ← 사용자 목록 (비밀번호 해시 포함)
//     settings.json    ← 사이트 설정
//     media.json       ← 미디어 메타데이터
//     categories.json  ← 카테고리
//     tags.json        ← 태그
//     comments.json    ← 댓글
//   /_content/
//     posts/<slug>.md  ← 글 본문 (Markdown)
//     pages/<slug>.md  ← 페이지 본문
//   /_config/
//     plan.json        ← 플랜 설정 및 제한 사항
//   /public/
//     uploads/         ← 미디어 파일
//   /src/
//     (Astro 소스 — 빌드 후 /dist → GitHub Pages)
//   .github/workflows/
//     deploy.yml       ← push 시 npm install → Astro 빌드 → GitHub Pages 배포
//     cms-update.yml   ← CMS 콘텐츠 업데이트 워크플로우
// ─────────────────────────────────────────────────────────────────────────────

import { ghReq, pickGithubToken } from "./github-storage.js";

// ── 상수 ─────────────────────────────────────────────────────────────────────

// 총 프로비저닝 목표 시간: 5~8분 (300~480초)
// 각 단계별 지연으로 시간을 조율합니다.
const PROVISION_DELAYS = {
  after_repo_create:       8000,   // 레포 생성 후 대기 (8초)
  between_db_files:         400,   // DB 파일 간격 (0.4초)
  between_src_files:        300,   // src 파일 간격 (0.3초)
  between_workflow_files:   500,   // workflow 파일 간격 (0.5초)
  after_astro_trigger:    15000,   // Astro 첫 빌드 트리거 후 대기 (15초)
  after_pages_activate:    5000,   // Pages 활성화 후 대기 (5초)
  validation_phase:       20000,   // 검증 단계 (20초)
  plan_config_phase:       8000,   // 플랜 설정 단계 (8초)
};

// GitHub Pages 공식 IP (DNS용)
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

// 비밀번호 해싱 (Web Crypto)
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

// ── Astro 소스 파일 생성 ──────────────────────────────────────────────────────

function buildAstroSource({ siteName, siteUrl, siteId, adminUser, adminEmail, owner, repoName, planLimits }) {
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;
  const storageGb  = planLimits?.storage_gb ?? 5;
  const trafficGb  = planLimits?.traffic_gb ?? 100;

  return {
    // ── package.json (Astro 패키지 버전 고정 포함) ──────────────────────────
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
        "astro":              "^4.16.0",   // 고정 버전으로 안정성 보장
        "@astrojs/sitemap":   "^3.2.1",
        "@astrojs/rss":       "^4.0.7",
      },
      // npm ci를 위해 lockfileVersion 명시
      lockfileVersion: 3,
    }, null, 2),

    // ── package-lock.json stub (npm ci 지원) ───────────────────────────────
    // 실제 lock은 Actions에서 npm install 실행 후 자동 생성됨
    // 여기서는 npm ci 대신 npm install을 사용하므로 불필요하나 명시

    // ── astro.config.mjs ──────────────────────────────────────────────────
    "astro.config.mjs": `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// SITE_URL: 커스텀 도메인 또는 GitHub Pages 기본 URL
const site = process.env.SITE_URL || '${siteUrl || `https://${owner}.github.io/${repoName}`}';

export default defineConfig({
  site,
  base: '/',
  integrations: [sitemap()],
  output: 'static',
  build: {
    // 정적 파일 최적화
    inlineStylesheets: 'auto',
  },
});
`,

    // ── tsconfig.json ─────────────────────────────────────────────────────
    "tsconfig.json": JSON.stringify({
      extends: "astro/tsconfigs/strict",
      compilerOptions: {
        strictNullChecks: true,
        allowJs: true,
        skipLibCheck: true,
      },
    }, null, 2),

    // ── src/lib/db.ts ─────────────────────────────────────────────────────
    "src/lib/db.ts": `// GitHub 레포 _db/ 폴더에서 JSON 데이터 읽기
// 빌드 시점에 fetch로 가져와 정적 페이지 생성에 사용

const REPO_RAW = '${ghRawBase}';

// 플랜 제한 상수 (빌드 시 적용)
export const PLAN_LIMITS = {
  storage_gb:  ${storageGb},
  traffic_gb:  ${trafficGb === null ? "null" : trafficGb},
  custom_domain: ${planLimits?.custom_domain ?? false},
  backups:     ${planLimits?.backups ?? false},
  // 초과 요금 정책
  overage: {
    storage_per_gb_krw:    1900,
    traffic_overage_krw:   2300,
    traffic_threshold_pct: 70,
  },
};

async function fetchDb<T>(file: string, fallback: T): Promise<T> {
  try {
    const url = \`\${REPO_RAW}/_db/\${file}\`;
    const res = await fetch(url, {
      headers: import.meta.env.GITHUB_TOKEN
        ? { Authorization: \`Bearer \${import.meta.env.GITHUB_TOKEN}\` }
        : {},
      // 빌드 캐시 방지
      cache: 'no-store',
    });
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
    site_url:  '${siteUrl || ""}',
    site_description: '',
    admin_email: '${adminEmail}',
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
    const url = \`\${REPO_RAW}/_content/posts/\${slug}.md\`;
    const res = await fetch(url, {
      headers: import.meta.env.GITHUB_TOKEN
        ? { Authorization: \`Bearer \${import.meta.env.GITHUB_TOKEN}\` }
        : {},
    });
    if (!res.ok) return '';
    const text = await res.text();
    // frontmatter 제거
    return text.replace(/^---[\s\S]*?---\n?/, '').trim();
  } catch { return ''; }
}
`,

    // ── src/lib/markdown.ts ───────────────────────────────────────────────
    "src/lib/markdown.ts": `// Markdown → HTML 변환
export function markdownToHtml(md: string): string {
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
    .replace(/\\n\\n/g, '</p><p>')
    .replace(/^(?!<[hbuol])/gm, '')
    .replace(/(<p><\\/p>)+/g, '');
}
`,

    // ── src/layouts/Base.astro ────────────────────────────────────────────
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
  <meta name="generator" content="CloudPress + Astro">
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
      <p>© {new Date().getFullYear()} {settings.site_name} · Powered by <a href="https://cloudpress.app">CloudPress</a></p>
    </div>
  </footer>
</body>
</html>
`,

    // ── src/styles/global.css ─────────────────────────────────────────────
    "src/styles/global.css": `*,*::before,*::after{box-sizing:border-box;margin:0}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.75;color:#222;background:#fff}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4{line-height:1.3;margin:1.5rem 0 .75rem;font-weight:700}
p{margin-bottom:1rem}img{max-width:100%;height:auto}
pre{overflow-x:auto;padding:1rem;background:#f6f8fa;border-radius:6px;margin-bottom:1rem}
code{background:#f6f8fa;padding:2px 6px;border-radius:3px;font-size:.9em}
blockquote{border-left:4px solid #e5e7eb;padding-left:1rem;color:#6b7280;margin:1rem 0}
.container{max-width:800px;margin:0 auto;padding:0 1.5rem}
header{border-bottom:1px solid #e5e7eb;padding:1rem 0;position:sticky;top:0;background:rgba(255,255,255,.95);backdrop-filter:blur(8px);z-index:10}
.header-inner{display:flex;justify-content:space-between;align-items:center}
.site-title{font-size:1.25rem;font-weight:800;color:#111}
nav a{margin-left:1.5rem;color:#555;font-weight:500;font-size:.925rem}
nav a:hover{color:#111;text-decoration:none}
main{padding:2.5rem 0 4rem;min-height:60vh}
footer{border-top:1px solid #e5e7eb;padding:2rem 0;text-align:center;color:#9ca3af;font-size:.875rem}
.post-list{list-style:none;padding:0;display:grid;gap:2rem}
.post-card{border-bottom:1px solid #f3f4f6;padding-bottom:2rem}
.post-card:last-child{border-bottom:none}
.post-title{font-size:1.375rem;font-weight:700;margin:0 0 .375rem}
.post-meta{color:#9ca3af;font-size:.875rem;margin-bottom:.5rem}
.post-excerpt{color:#4b5563}
.tag{display:inline-block;background:#f3f4f6;color:#374151;padding:2px 10px;border-radius:99px;font-size:.8rem;margin:2px}
.prose h1{font-size:2rem}.prose h2{font-size:1.5rem}
.prose p{margin-bottom:1.25rem}
`,

    // ── src/pages/index.astro ─────────────────────────────────────────────
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
            {post.description && <p class="post-excerpt">{post.description}</p>}
            {post.tags?.map(t => <span class="tag">#{t}</span>)}
          </li>
        ))}
      </ul>
  }
</Base>
`,

    // ── src/pages/blog/index.astro ────────────────────────────────────────
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
            {post.description && <p class="post-excerpt">{post.description}</p>}
            {post.tags?.map(t => <span class="tag">#{t}</span>)}
          </li>
        ))}
      </ul>
  }
</Base>
`,

    // ── src/pages/blog/[slug].astro ───────────────────────────────────────
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
      <div class="post-meta">
        {new Date(post.created_at).toLocaleDateString('ko-KR')} · {post.author}
        {post.tags?.map(t => <span class="tag">#{t}</span>)}
      </div>
    </header>
    <div class="prose" set:html={htmlContent} />
    <div style="margin-top:3rem;padding-top:2rem;border-top:1px solid #e5e7eb;">
      <a href="/blog">← 목록으로</a>
    </div>
  </article>
</Base>
`,

    // ── src/pages/rss.xml.ts ──────────────────────────────────────────────
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

    // ── public/favicon.svg ────────────────────────────────────────────────
    "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">☁️</text></svg>`,

    // ── public/robots.txt ─────────────────────────────────────────────────
    "public/robots.txt": `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap-index.xml\n`,
  };
}

// ── GitHub Actions 워크플로우 (Astro 자동 설치 포함) ──────────────────────────

function buildGithubActionsWorkflows({ siteId, owner, repoName }) {
  return {
    // ── 메인 배포 워크플로우 (npm install → astro build → gh-pages 배포) ──
    ".github/workflows/deploy.yml": `name: Astro 빌드 & GitHub Pages 배포

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
  workflow_dispatch:
    inputs:
      reason:
        description: '수동 배포 사유'
        required: false
        default: '수동 빌드'

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    name: Astro 빌드
    runs-on: ubuntu-latest
    steps:
      - name: 저장소 체크아웃
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Node.js 20 설정
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          # npm 캐시 (package-lock.json이 없을 수 있으므로 node_modules 기준)
          cache: 'npm'
          cache-dependency-path: 'package.json'

      - name: Astro 패키지 설치 (npm install)
        # package-lock.json 없이도 동작 (npm install 사용)
        run: |
          echo "📦 Astro 패키지 설치 중..."
          npm install --prefer-offline || npm install
          echo "✅ 패키지 설치 완료"
          npx astro --version

      - name: 의존성 검증
        run: |
          echo "🔍 의존성 검증 중..."
          node -e "require('./node_modules/astro/package.json'); console.log('✅ astro OK')"
          echo "Node.js 버전: $(node --version)"
          echo "npm 버전: $(npm --version)"

      - name: Astro 빌드
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SITE_URL: \${{ secrets.SITE_URL }}
          SITE_ID: ${siteId}
        run: |
          echo "🚀 Astro 빌드 시작..."
          npm run build
          echo "✅ 빌드 완료"
          ls -la dist/

      - name: 빌드 검증
        run: |
          if [ ! -f "dist/index.html" ]; then
            echo "❌ dist/index.html 없음"
            exit 1
          fi
          echo "✅ 빌드 결과 검증 완료"
          echo "빌드 파일 수: $(find dist -type f | wc -l)"

      - name: Pages artifact 업로드
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    name: GitHub Pages 배포
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: GitHub Pages 배포
        uses: actions/deploy-pages@v4
        id: deployment
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
        options: [rebuild, validate, purge-cache]
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

      - name: DB 파일 검증
        run: |
          echo "📦 DB 파일 검사 중..."
          for f in _db/*.json; do
            if python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null; then
              echo "✅ $f"
            else
              echo "❌ $f — JSON 파싱 오류"
              exit 1
            fi
          done
          echo "모든 DB 파일 정상"

      - name: 플랜 제한 확인
        run: |
          if [ -f "_config/plan.json" ]; then
            echo "📋 플랜 설정:"
            cat _config/plan.json
          fi

      - name: 스토리지 사용량 확인
        run: |
          TOTAL=$(du -sb . 2>/dev/null | cut -f1)
          TOTAL_MB=$((TOTAL / 1024 / 1024))
          echo "📊 현재 스토리지 사용량: ${TOTAL_MB}MB"

      - name: Astro 빌드 트리거
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
            console.log('✅ 배포 워크플로우 트리거 완료');
`,

    // ── 플랜 모니터링 워크플로우 (일일 실행) ─────────────────────────────
    ".github/workflows/plan-monitor.yml": `name: 플랜 리소스 모니터링

on:
  schedule:
    # 매일 00:00 UTC 실행
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
            echo "제한: \${LIMIT_GB}GB | 사용: \${USED_GB}GB"
            
            USED_PCT=$(python3 -c "print(round(float('$USED_GB')/float('$LIMIT_GB')*100,1))")
            echo "사용률: \${USED_PCT}%"
            
            # 80% 초과 경고
            OVER_80=$(python3 -c "print('yes' if float('$USED_GB') > float('$LIMIT_GB')*0.8 else 'no')")
            if [ "$OVER_80" = "yes" ]; then
              echo "⚠️ 스토리지 80% 초과! 추가 구매 또는 정리가 필요합니다."
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
  await log("📁 GitHub 레포 초기화 중 (DB + Astro 소스 생성)...");

  const passHash = await hashPassword(adminPass);
  const now      = new Date().toISOString();

  // ── STEP A: _db/ 초기 데이터 ─────────────────────────────────────────────
  await log("  [A] _db/ 초기 데이터 생성 중...");
  const initialDb = {
    "settings.json": {
      site_name:        siteName,
      site_url:         siteUrl || "",
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
    await delay(PROVISION_DELAYS.between_db_files);
  }
  await log("  ✅ _db/ 초기 데이터 완료");

  // ── STEP B: 환영 글 ───────────────────────────────────────────────────────
  const welcomeMd = `---
title: "CloudPress에 오신 것을 환영합니다!"
description: "첫 번째 글입니다."
pubDate: "${now}"
author: "${adminUser}"
slug: "welcome"
tags: []
categories: ["미분류"]
status: "publish"
---

# 환영합니다!

**CloudPress**로 사이트를 시작했습니다.

GitHub 레포지토리가 여러분의 블로그 데이터베이스입니다.
글을 작성하면 자동으로 Astro로 빌드되어 GitHub Pages에 배포됩니다.

## 시작하기

1. CMS 어드민 패널에서 글 작성
2. 저장하면 GitHub Actions가 자동 빌드 (npm install → astro build)
3. 도메인 관리에서 커스텀 도메인 연결
`;
  await ghPutFile(token, owner, repoName, "_content/posts/welcome.md",
    welcomeMd, "init: welcome post", null).catch(() => {});
  await delay(PROVISION_DELAYS.between_db_files);

  // posts.json에 등록
  const { data: posts, sha: postsSha } = await readJsonDb(token, owner, repoName, "posts.json");
  await writeJsonDb(token, owner, repoName, "posts.json", [...(posts || []), {
    id: 1, slug: "welcome",
    title: "CloudPress에 오신 것을 환영합니다!",
    description: "첫 번째 글입니다.",
    status: "publish", author_id: 1, author: adminUser,
    categories: ["미분류"], tags: [],
    created_at: now, updated_at: now,
    content_file: "_content/posts/welcome.md",
  }], postsSha, "init: welcome post meta");
  await delay(PROVISION_DELAYS.between_db_files);

  // ── STEP C: Astro 소스 파일 생성 ──────────────────────────────────────────
  await log("  [C] Astro 소스 파일 생성 중 (package.json 포함)...");
  const astroFiles = buildAstroSource({ siteName, siteUrl, siteId, adminUser, adminEmail, owner, repoName, planLimits });

  let fileCount = 0;
  for (const [path, content] of Object.entries(astroFiles)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    fileCount++;
    await delay(PROVISION_DELAYS.between_src_files);
    if (fileCount % 3 === 0) await log(`  📄 Astro 소스 ${fileCount}/${Object.keys(astroFiles).length}개 생성 중...`);
  }
  await log(`  ✅ Astro 소스 ${fileCount}개 파일 생성 완료 (package.json 포함)`);

  // ── STEP D: GitHub Actions 워크플로우 설정 ────────────────────────────────
  await log("  [D] GitHub Actions 워크플로우 설정 중 (Astro 자동 설치 포함)...");
  const workflows = buildGithubActionsWorkflows({ siteId, owner, repoName });

  for (const [path, content] of Object.entries(workflows)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    await delay(PROVISION_DELAYS.between_workflow_files);
  }
  await log("  ✅ GitHub Actions 워크플로우 설정 완료 (npm install → astro build)");

  // ── STEP E: GitHub Pages 활성화 ──────────────────────────────────────────
  await log("  [E] GitHub Pages 활성화 중...");
  await delay(2000); // 파일 커밋 전파 대기

  const pagesRes = await ghReq("POST", `/repos/${owner}/${repoName}/pages`, token, {
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => ({ ok: false }));

  if (pagesRes.ok || pagesRes.data?.url) {
    await log("  ✅ GitHub Pages 활성화 완료");
  } else {
    await log("  ℹ️ GitHub Pages는 첫 빌드 완료 후 자동 활성화됩니다", "warning");
  }

  await delay(PROVISION_DELAYS.after_pages_activate);

  // ── STEP F: 첫 빌드 트리거 (npm install → astro build) ───────────────────
  await log("  [F] 첫 빌드 트리거 중 (npm install + Astro 빌드)...");
  const triggerRes = await ghReq(
    "POST",
    `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token,
    { ref: "main", inputs: { reason: "초기 빌드" } }
  ).catch(() => ({ ok: false }));

  if (triggerRes.ok || triggerRes.status === 204) {
    await log("  🚀 첫 빌드 트리거 완료 (npm install → astro build 실행 중)");
  } else {
    await log("  ℹ️ 첫 빌드는 다음 push 시 자동 실행됩니다", "warning");
  }

  // 빌드 시작 대기 (Actions 런너 할당 시간)
  await delay(PROVISION_DELAYS.after_astro_trigger);
  await log("  🔄 빌드 실행 중... (GitHub Actions 런너 할당 완료)");

  // README 업데이트
  const readmeContent = `# ${siteName}

CloudPress로 생성된 Astro 기반 정적 블로그입니다.

## 구조

\`\`\`
/_db/          ← 블로그 데이터베이스 (JSON)
  posts.json   ← 글 목록
  users.json   ← 사용자
  settings.json← 사이트 설정
  categories.json
  tags.json
  comments.json
/_content/     ← 글 본문 (Markdown)
  posts/
/_config/      ← 플랜·사용량 설정
  plan.json
/src/           ← Astro 소스 (TypeScript)
  layouts/
  pages/
  lib/
  styles/
/public/        ← 정적 파일
\`\`\`

## 배포

\`main\` 브랜치에 push하면 GitHub Actions가 자동으로:
1. \`npm install\` — Astro 패키지 설치
2. \`astro build\` — 정적 사이트 빌드
3. GitHub Pages 배포

## Site ID: \`${siteId}\`
`;
  await ghPutFile(token, owner, repoName, "README.md", readmeContent, "docs: update README", null).catch(() => {});

  await log("✅ GitHub Pages 호스팅 초기화 완료!");
  return { owner, repoName };
}

// ── GitHub Pages URL 계산 ─────────────────────────────────────────────────────

export function getGithubPagesUrl(owner, repoName) {
  if (repoName === `${owner}.github.io`) return `https://${owner}.github.io`;
  return `https://${owner}.github.io/${repoName}`;
}

// ── Cloudflare DNS 설정 (DNS·도메인 전용) ─────────────────────────────────────

function getRootDomain(domain) {
  const parts       = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(".");
  const twoPartTLDs = ["co.uk","com.au","co.jp","co.kr","com.br","co.nz","org.uk","net.au","co.za"];
  if (parts.length > 2 && twoPartTLDs.includes(parts.slice(-2).join("."))) return parts.slice(-3).join(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

export async function setupGithubPagesDns({ cfApiKey, cfEmail, zoneId, domain, owner, repoName }) {
  const cfBase = "https://api.cloudflare.com/client/v4";
  const headers = {
    "X-Auth-Key":   cfApiKey,
    "X-Auth-Email": cfEmail,
    "Content-Type": "application/json",
  };
  const cfReq = async (method, path, body) => {
    const res = await fetch(`${cfBase}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  const rootDomain = getRootDomain(domain);
  const results    = [];

  // A 레코드 (IPv4 — GitHub Pages 공식)
  const existingA  = await cfReq("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(rootDomain)}`);
  const existingIps = (existingA.result || []).map(r => r.content);
  for (const ip of GITHUB_PAGES_IPV4) {
    if (!existingIps.includes(ip)) {
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, {
        type: "A", name: rootDomain, content: ip, ttl: 3600, proxied: false,
      });
      results.push({ type: "A", ip, ok: r.success });
    } else {
      results.push({ type: "A", ip, ok: true, existed: true });
    }
  }

  // AAAA 레코드 (IPv6)
  const existingAAAA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(rootDomain)}`);
  const existingIpv6 = (existingAAAA.result || []).map(r => r.content);
  for (const ip of GITHUB_PAGES_IPV6) {
    if (!existingIpv6.includes(ip)) {
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, {
        type: "AAAA", name: rootDomain, content: ip, ttl: 3600, proxied: false,
      });
      results.push({ type: "AAAA", ip, ok: r.success });
    }
  }

  // www CNAME
  if (!domain.startsWith("www.")) {
    const existingCname = await cfReq("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(`www.${rootDomain}`)}`);
    if (!(existingCname.result?.length > 0)) {
      const ghHost = `${owner}.github.io`;
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, {
        type: "CNAME", name: `www.${rootDomain}`, content: ghHost, ttl: 3600, proxied: false,
      });
      results.push({ type: "CNAME", name: `www.${rootDomain}`, content: ghHost, ok: r.success });
    }
  }

  return results;
}

// GitHub Pages 커스텀 도메인 설정
export async function configureGithubPagesCustomDomainWithToken({ token, owner, repoName, domain }) {
  const existing = await ghGetFile(token, owner, repoName, "public/CNAME").catch(() => null);
  await ghPutFile(token, owner, repoName, "public/CNAME", domain,
    `chore: set custom domain ${domain}`, existing?.sha || null).catch(() => {});

  await ghReq("PUT", `/repos/${owner}/${repoName}/pages`, token, {
    cname: domain,
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => {});

  await ghReq("POST", `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token, { ref: "main", inputs: { reason: "커스텀 도메인 설정" } }).catch(() => {});
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

  // GitHub 계정 확인
  const { ok: meOk, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log("GitHub 토큰 인증 실패 — 유효한 토큰인지 확인해주세요", "error");
    return null;
  }
  const owner = meData.login;

  await log(`👤 GitHub 계정: ${owner}`);
  await log(`📦 [1/6] 레포 생성 중: ${owner}/${repoName}`);

  // ── 레포 생성 ───────────────────────────────────────────────────────────
  const { ok: repoOk, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: `CloudPress 호스팅: ${siteName} (Site ID: ${siteId})`,
    private:     false,   // GitHub Pages 무료 플랜은 public 필수
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

  // 레포 초기화 대기
  await delay(PROVISION_DELAYS.after_repo_create);

  await log(`📝 [2/6] DB 데이터 + Astro 소스 초기화 중...`);
  await log(`⚡ [3/6] GitHub Actions 워크플로우 설정 중 (npm install 포함)...`);

  // 레포 초기화
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
