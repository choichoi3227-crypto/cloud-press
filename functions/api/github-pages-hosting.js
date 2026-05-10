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
//   /public/
//     uploads/         ← 미디어 파일
//   /src/
//     (Astro 소스 — 빌드 후 /dist → GitHub Pages)
//   .github/workflows/
//     deploy.yml       ← push 시 Astro 빌드 + GitHub Pages 배포
//     cms-api.yml      ← CMS API 요청 처리 (workflow_dispatch)
// ─────────────────────────────────────────────────────────────────────────────

import { ghReq, pickGithubToken } from "./github-storage.js";

// ── 유틸 ─────────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "");
}

// 간단한 비밀번호 해싱 (Web Crypto — Workers 내장)
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
  const { status, ok, data } = await ghReq("GET", `/repos/${owner}/${repo}/contents/${path}`, token);
  if (!ok) return null;
  return {
    content: atob(data.content.replace(/\n/g, "")),
    sha:     data.sha,
    encoding: data.encoding,
  };
}

async function ghPutFile(token, owner, repo, path, content, message, sha) {
  const body = {
    message,
    content: toBase64(content),
    ...(sha ? { sha } : {}),
  };
  const { ok, data } = await ghReq("PUT", `/repos/${owner}/${repo}/contents/${path}`, token, body);
  return { ok, sha: data?.content?.sha };
}

// ── JSON DB 헬퍼 ─────────────────────────────────────────────────────────────

async function readJsonDb(token, owner, repo, file) {
  const f = await ghGetFile(token, owner, repo, `_db/${file}`);
  if (!f) return { data: [], sha: null };
  try {
    return { data: JSON.parse(f.content), sha: f.sha };
  } catch {
    return { data: [], sha: f.sha };
  }
}

async function writeJsonDb(token, owner, repo, file, data, sha, msg) {
  const content = JSON.stringify(data, null, 2);
  return ghPutFile(token, owner, repo, `_db/${file}`, content, msg || `db: update ${file}`, sha);
}

// ── 레포 초기화 ──────────────────────────────────────────────────────────────

export async function initGithubPagesRepo({
  token, owner, repoName,
  siteId, siteName, siteUrl,
  adminUser, adminPass, adminEmail,
  log,
}) {
  await log("GitHub 레포 초기화 중 (DB + Astro 소스 생성)...");

  const passHash = await hashPassword(adminPass);
  const now      = new Date().toISOString();

  // ── _db/ 초기 데이터 ────────────────────────────────────────────────────
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
    "users.json": [
      {
        id:           1,
        username:     adminUser,
        email:        adminEmail,
        password:     passHash,
        role:         "administrator",
        display_name: adminUser,
        created_at:   now,
      },
    ],
    "posts.json":      [],
    "pages.json":      [],
    "media.json":      [],
    "categories.json": [{ id: 1, name: "미분류", slug: "uncategorized", description: "", parent: 0, count: 0 }],
    "tags.json":       [],
    "comments.json":   [],
  };

  for (const [file, data] of Object.entries(initialDb)) {
    const content = JSON.stringify(data, null, 2);
    await ghPutFile(token, owner, repoName, `_db/${file}`, content,
      `init: _db/${file}`, null).catch(() => {});
    await delay(300);
  }
  await log("_db/ 초기 데이터 생성 완료");

  // ── _content/ 디렉토리 ───────────────────────────────────────────────────
  const welcomePost = `---
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
2. 저장하면 GitHub Actions가 자동 빌드
3. 도메인 관리에서 커스텀 도메인 연결
`;
  await ghPutFile(token, owner, repoName, "_content/posts/welcome.md",
    welcomePost, "init: welcome post", null).catch(() => {});
  await delay(300);

  // 초기 posts.json에 welcome 글 등록
  const { data: posts, sha: postsSha } = await readJsonDb(token, owner, repoName, "posts.json");
  const newPosts = [...(posts || []), {
    id:          1,
    slug:        "welcome",
    title:       "CloudPress에 오신 것을 환영합니다!",
    description: "첫 번째 글입니다.",
    status:      "publish",
    author_id:   1,
    author:      adminUser,
    categories:  ["미분류"],
    tags:        [],
    created_at:  now,
    updated_at:  now,
    content_file: "_content/posts/welcome.md",
  }];
  await writeJsonDb(token, owner, repoName, "posts.json", newPosts, postsSha, "init: welcome post meta");
  await delay(300);

  // ── Astro 소스 생성 ─────────────────────────────────────────────────────
  await log("Astro 소스 파일 생성 중...");
  const astroFiles = buildAstroSource({ siteName, siteUrl, siteId, adminUser, adminEmail, owner, repoName });

  for (const [path, content] of Object.entries(astroFiles)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    await delay(250);
  }
  await log(`Astro 소스 ${Object.keys(astroFiles).length}개 파일 생성 완료`);

  // ── GitHub Actions 워크플로우 ────────────────────────────────────────────
  await log("GitHub Actions 워크플로우 설정 중...");
  const workflows = buildGithubActionsWorkflows({ siteId, owner, repoName });

  for (const [path, content] of Object.entries(workflows)) {
    await ghPutFile(token, owner, repoName, path, content, `init: ${path}`, null).catch(() => {});
    await delay(300);
  }
  await log("GitHub Actions 워크플로우 설정 완료");

  // ── GitHub Pages 활성화 ─────────────────────────────────────────────────
  await log("GitHub Pages 활성화 중...");
  const pagesRes = await ghReq("POST", `/repos/${owner}/${repoName}/pages`, token, {
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => ({ ok: false }));

  // gh-pages 브랜치가 없으면 Actions로 먼저 빌드 후 생성됨 → 에러 무시
  if (pagesRes.ok || pagesRes.data?.url) {
    await log(`GitHub Pages 활성화 완료`);
  } else {
    await log("GitHub Pages는 첫 번째 빌드 완료 후 자동 활성화됩니다", "warning");
  }

  // ── Actions workflow_dispatch로 첫 빌드 트리거 ──────────────────────────
  await delay(2000); // 파일 커밋 전파 대기
  const triggerRes = await ghReq(
    "POST",
    `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token,
    { ref: "main" }
  ).catch(() => ({ ok: false }));
  if (triggerRes.ok || triggerRes.status === 204) {
    await log("🚀 첫 빌드 트리거 완료 — GitHub Actions에서 빌드 중입니다");
  } else {
    await log("첫 빌드는 다음 push 시 자동 실행됩니다", "warning");
  }

  await log("✅ GitHub Pages 호스팅 초기화 완료!");
  return { owner, repoName };
}

// ── GitHub Pages URL 계산 ─────────────────────────────────────────────────────

export function getGithubPagesUrl(owner, repoName) {
  // {username}.github.io 레포이면 apex URL
  if (repoName === `${owner}.github.io`) return `https://${owner}.github.io`;
  return `https://${owner}.github.io/${repoName}`;
}

// ── Cloudflare DNS 자동 설정 (도메인 추가 시) ─────────────────────────────────
// GitHub Pages 공식 문서 기준 DNS 레코드
// https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

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

export async function setupGithubPagesDns({ cfApiKey, cfEmail, zoneId, domain, owner, repoName }) {
  const cfBase = "https://api.cloudflare.com/client/v4";
  const headers = {
    "X-Auth-Key":   cfApiKey,
    "X-Auth-Email": cfEmail,
    "Content-Type": "application/json",
  };
  const cfReq = async (method, path, body) => {
    const res = await fetch(`${cfBase}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  const rootDomain = getRootDomain(domain);
  const results    = [];

  // A 레코드 (루트 도메인)
  const existingA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(rootDomain)}`);
  const existingIps = (existingA.result || []).map((r) => r.content);
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

  // AAAA 레코드
  const existingAAAA = await cfReq("GET", `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(rootDomain)}`);
  const existingIpv6 = (existingAAAA.result || []).map((r) => r.content);
  for (const ip of GITHUB_PAGES_IPV6) {
    if (!existingIpv6.includes(ip)) {
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, {
        type: "AAAA", name: rootDomain, content: ip, ttl: 3600, proxied: false,
      });
      results.push({ type: "AAAA", ip, ok: r.success });
    }
  }

  // www CNAME → {owner}.github.io
  if (!domain.startsWith("www.")) {
    const existingCname = await cfReq("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(`www.${rootDomain}`)}`);
    if (!(existingCname.result?.length > 0)) {
      const ghPagesHost = `${owner}.github.io`;
      const r = await cfReq("POST", `/zones/${zoneId}/dns_records`, {
        type: "CNAME", name: `www.${rootDomain}`, content: ghPagesHost, ttl: 3600, proxied: false,
      });
      results.push({ type: "CNAME", name: `www.${rootDomain}`, content: ghPagesHost, ok: r.success });
    }
  }

  // GitHub Pages custom domain 설정 (CNAME 파일 + Pages API)
  await configureGithubPagesCustomDomain({ token: null, owner, repoName, domain: rootDomain });

  return results;
}

// GitHub 레포에 CNAME 파일 생성 + Pages API 커스텀 도메인 설정
async function configureGithubPagesCustomDomain({ token, owner, repoName, domain }) {
  if (!token) return; // 토큰 없으면 스킵 (account-domains.js에서 토큰 전달)
  // CNAME 파일 (gh-pages 브랜치에 있어야 함 — Actions에서 자동 처리)
  // 대신 레포에 CNAME 파일을 main 브랜치에 추가 (Astro 빌드 시 public/CNAME로 복사)
  await ghPutFile(token, owner, repoName, "public/CNAME", domain,
    `chore: set custom domain ${domain}`, null).catch(() => {});
}

export async function configureGithubPagesCustomDomainWithToken({ token, owner, repoName, domain }) {
  // public/CNAME 파일 업데이트
  const existing = await ghGetFile(token, owner, repoName, "public/CNAME").catch(() => null);
  await ghPutFile(token, owner, repoName, "public/CNAME", domain,
    `chore: set custom domain ${domain}`, existing?.sha || null).catch(() => {});

  // GitHub Pages API로 커스텀 도메인 설정
  await ghReq("PUT", `/repos/${owner}/${repoName}/pages`, token, {
    cname: domain,
    source: { branch: "gh-pages", path: "/" },
  }).catch(() => {});

  // 빌드 트리거
  await ghReq("POST", `/repos/${owner}/${repoName}/actions/workflows/deploy.yml/dispatches`,
    token, { ref: "main" }).catch(() => {});
}

function getRootDomain(domain) {
  const parts       = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").split(".");
  const twoPartTLDs = ["co.uk","com.au","co.jp","co.kr","com.br","co.nz","org.uk","net.au","co.za"];
  if (parts.length > 2 && twoPartTLDs.includes(parts.slice(-2).join("."))) return parts.slice(-3).join(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

// ── Astro 소스 파일 생성 ─────────────────────────────────────────────────────

function buildAstroSource({ siteName, siteUrl, siteId, adminUser, adminEmail, owner, repoName }) {
  const ghRawBase = `https://raw.githubusercontent.com/${owner}/${repoName}/main`;

  return {
    // package.json
    "package.json": JSON.stringify({
      name:    slugify(siteName) || "cloudpress-site",
      type:    "module",
      version: "1.0.0",
      scripts: {
        dev:     "astro dev",
        build:   "astro build",
        preview: "astro preview",
      },
      dependencies: {
        astro:               "^4.0.0",
        "@astrojs/sitemap":  "^3.0.0",
        "@astrojs/rss":      "^4.0.0",
      },
    }, null, 2),

    // astro.config.mjs
    "astro.config.mjs": `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// SITE_URL은 GitHub Pages 기본 URL 또는 커스텀 도메인
const site = process.env.SITE_URL || '${siteUrl || `https://${owner}.github.io/${repoName}`}';

export default defineConfig({
  site,
  base: '/',        // 커스텀 도메인 사용 시 '/'
  integrations: [sitemap()],
  output: 'static',
});
`,

    // tsconfig.json
    "tsconfig.json": JSON.stringify({
      extends: "astro/tsconfigs/base",
      compilerOptions: { strictNullChecks: true },
    }, null, 2),

    // src/lib/db.ts — GitHub 레포에서 JSON DB 읽기
    "src/lib/db.ts": `// GitHub 레포 _db/ 폴더에서 JSON 데이터 읽기
// 빌드 시점에 fetch로 가져와 정적 페이지 생성에 사용

const REPO_RAW = '${ghRawBase}';

async function fetchDb<T>(file: string, fallback: T): Promise<T> {
  try {
    const url = \`\${REPO_RAW}/_db/\${file}\`;
    const res = await fetch(url, {
      headers: {
        // GitHub Token은 빌드 환경변수로 주입 (Actions secret)
        ...(import.meta.env.GITHUB_TOKEN ? { Authorization: \`Bearer \${import.meta.env.GITHUB_TOKEN}\` } : {}),
      },
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
};

export type SiteSettings = {
  site_name: string; site_url: string; site_description: string;
  admin_email: string; posts_per_page: number; theme: string;
};

export async function getPosts(status = 'publish'): Promise<Post[]> {
  const posts = await fetchDb<Post[]>('posts.json', []);
  return posts.filter(p => status === 'all' || p.status === status)
              .sort((a, b) => new Date(b.created_at).valueOf() - new Date(a.created_at).valueOf());
}

export async function getPost(slug: string): Promise<Post | null> {
  const posts = await fetchDb<Post[]>('posts.json', []);
  return posts.find(p => p.slug === slug) ?? null;
}

export async function getSettings(): Promise<SiteSettings> {
  return fetchDb<SiteSettings>('settings.json', {
    site_name: '${siteName}', site_url: '${siteUrl || ""}',
    site_description: '', admin_email: '${adminEmail}',
    posts_per_page: 10, theme: 'default',
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
        ? { Authorization: \`Bearer \${import.meta.env.GITHUB_TOKEN}\` } : {},
    });
    if (!res.ok) return '';
    const text = await res.text();
    // frontmatter 제거
    return text.replace(/^---[\\s\\S]*?---\\n?/, '').trim();
  } catch { return ''; }
}
`,

    // src/lib/markdown.ts
    "src/lib/markdown.ts": `// 간단한 Markdown → HTML 변환 (빌드 시 사용)
export function markdownToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/\`(.+?)\`/g, '<code>$1</code>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\\/li>)/gs, '<ul>$1</ul>')
    .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2">$1</a>')
    .replace(/!\\[(.*)\\]\\((.+?)\\)/g, '<img alt="$1" src="$2">')
    .replace(/\\n\\n/g, '</p><p>')
    .replace(/^(?!<[h|u|o|l|b])/gm, '')
    .replace(/(<p><\\/p>)+/g, '');
}
`,

    // src/layouts/Base.astro
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
      <p>© {new Date().getFullYear()} {settings.site_name} · Powered by <a href="https://cloudpress.app">CloudPress</a></p>
    </div>
  </footer>
</body>
</html>
`,

    // src/styles/global.css
    "src/styles/global.css": `*, *::before, *::after { box-sizing: border-box; margin: 0; }
body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.75; color: #222; background: #fff; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
h1,h2,h3,h4 { line-height: 1.3; margin: 1.5rem 0 .75rem; font-weight: 700; }
p { margin-bottom: 1rem; }
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 1rem; background: #f6f8fa; border-radius: 6px; margin-bottom: 1rem; }
code { background: #f6f8fa; padding: 2px 6px; border-radius: 3px; font-size: .9em; }
blockquote { border-left: 4px solid #e5e7eb; padding-left: 1rem; color: #6b7280; margin: 1rem 0; }
.container { max-width: 800px; margin: 0 auto; padding: 0 1.5rem; }
header { border-bottom: 1px solid #e5e7eb; padding: 1rem 0; position: sticky; top: 0; background: rgba(255,255,255,.95); backdrop-filter: blur(8px); z-index: 10; }
.header-inner { display: flex; justify-content: space-between; align-items: center; }
.site-title { font-size: 1.25rem; font-weight: 800; color: #111; }
nav a { margin-left: 1.5rem; color: #555; font-weight: 500; font-size: .925rem; }
nav a:hover { color: #111; text-decoration: none; }
main { padding: 2.5rem 0 4rem; min-height: 60vh; }
footer { border-top: 1px solid #e5e7eb; padding: 2rem 0; text-align: center; color: #9ca3af; font-size: .875rem; }
.post-list { list-style: none; padding: 0; display: grid; gap: 2rem; }
.post-card { border-bottom: 1px solid #f3f4f6; padding-bottom: 2rem; }
.post-card:last-child { border-bottom: none; }
.post-title { font-size: 1.375rem; font-weight: 700; margin: 0 0 .375rem; }
.post-meta { color: #9ca3af; font-size: .875rem; margin-bottom: .5rem; }
.post-excerpt { color: #4b5563; }
.tag { display: inline-block; background: #f3f4f6; color: #374151; padding: 2px 10px; border-radius: 99px; font-size: .8rem; margin: 2px; }
.prose h1 { font-size: 2rem; } .prose h2 { font-size: 1.5rem; }
.prose p { margin-bottom: 1.25rem; }
.pagination { display: flex; gap: .5rem; justify-content: center; margin-top: 3rem; }
.pagination a { padding: .5rem 1rem; border: 1px solid #e5e7eb; border-radius: 6px; color: #374151; }
.pagination a:hover, .pagination .current { background: #2563eb; color: #fff; border-color: #2563eb; }
`,

    // src/pages/index.astro
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
  {posts.length >= settings.posts_per_page && <div style="text-align:center;margin-top:2rem;"><a href="/blog">모든 글 보기 →</a></div>}
</Base>
`,

    // src/pages/blog/index.astro
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

    // src/pages/blog/[slug].astro
    "src/pages/blog/[slug].astro": `---
import Base from '../../layouts/Base.astro';
import { getPosts, getPostContent } from '../../lib/db';
import { markdownToHtml } from '../../lib/markdown';

export async function getStaticPaths() {
  const posts = await getPosts();
  return posts.map(p => ({ params: { slug: p.slug }, props: { post: p } }));
}
const { post }   = Astro.props;
const mdContent  = await getPostContent(post.slug);
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

    // src/pages/rss.xml.ts
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
      title:   p.title,
      pubDate: new Date(p.created_at),
      description: p.description || '',
      link:    \`/blog/\${p.slug}/\`,
    })),
  });
}
`,

    // public/favicon.svg
    "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">☁️</text></svg>`,

    // README.md
    "README.md": `# ${siteName}

CloudPress로 생성된 Astro 기반 정적 블로그입니다.

## 구조

\`\`\`
/_db/          ← 블로그 데이터베이스 (JSON)
  posts.json   ← 글 목록
  users.json   ← 사용자
  settings.json← 사이트 설정
  ...
/_content/     ← 글 본문 (Markdown)
  posts/
/src/           ← Astro 소스
/public/        ← 정적 파일 (업로드 이미지 등)
\`\`\`

## 배포

\`main\` 브랜치에 push하면 GitHub Actions가 자동으로:
1. Astro 빌드 실행
2. GitHub Pages (\`gh-pages\` 브랜치)에 배포

## 커스텀 도메인

CloudPress 어드민 > 도메인 관리에서 설정하세요.
DNS는 자동으로 설정됩니다.

---
Site ID: \`${siteId}\`
`,
  };
}

// ── GitHub Actions 워크플로우 ──────────────────────────────────────────────────

function buildGithubActionsWorkflows({ siteId, owner, repoName }) {
  return {
    // 메인 배포 워크플로우
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

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: 의존성 설치
        run: npm ci

      - name: Astro 빌드
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SITE_URL: \${{ secrets.SITE_URL || '' }}
        run: npm run build

      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/deploy-pages@v4
        id: deployment
`,

    // DB 업데이트 워크플로우 (CMS에서 글 저장 시 호출)
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

      - name: DB 유효성 검사
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
            });
            console.log('배포 워크플로우 트리거 완료');
`,
  };
}

// ── 호스팅 생성 메인 함수 (sites.js의 provision()에서 호출) ──────────────────

export async function provisionGithubPagesHosting({
  env, siteId, siteName,
  adminUser, adminPass, adminEmail,
  log,
}) {
  const token = await pickGithubToken(env);
  if (!token) {
    await log("GitHub 토큰 없음 — 관리자 설정에서 GitHub 토큰을 추가해주세요", "error");
    return null;
  }

  // 레포 이름: cp-{shortId}
  const shortId  = siteId.replace(/-/g, "").slice(0, 8);
  const repoName = `cp-${shortId}`;

  // GitHub 사용자 정보 조회
  const { ok: meOk, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log("GitHub 토큰 인증 실패 — 유효한 토큰인지 확인해주세요", "error");
    return null;
  }
  const owner = meData.login;

  await log(`GitHub 계정: ${owner}`);
  await log(`레포 생성 중: ${owner}/${repoName}`);

  // 레포 생성
  const { ok: repoOk, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: `CloudPress 호스팅: ${siteName} (Site ID: ${siteId})`,
    private:     false, // GitHub Pages는 public 레포 필요 (무료 플랜)
    auto_init:   true,
    has_issues:  false,
    has_wiki:    false,
    has_projects: false,
  });

  if (!repoOk && repoData?.errors?.[0]?.message?.includes("already exists")) {
    await log(`레포 ${repoName} 이미 존재 — 기존 레포 사용`, "warning");
  } else if (!repoOk) {
    await log(`레포 생성 실패: ${repoData?.message || JSON.stringify(repoData)}`, "error");
    return null;
  } else {
    await log(`레포 생성 완료: ${owner}/${repoName}`);
  }

  // GitHub Pages URL (커스텀 도메인 설정 전 임시)
  const pagesUrl = getGithubPagesUrl(owner, repoName);

  await delay(1500); // 레포 초기화 대기

  // 레포 초기화 (DB + Astro 소스 + Actions)
  await initGithubPagesRepo({
    token, owner, repoName,
    siteId, siteName,
    siteUrl: pagesUrl,
    adminUser, adminPass, adminEmail,
    log,
  });

  return {
    owner,
    repoName,
    token,
    pagesUrl,
    // 도메인 미설정 시 GitHub Pages 기본 URL (커스텀 도메인 필수 안내)
    primaryDomain: null, // 도메인 설정 후 활성화
  };
}
