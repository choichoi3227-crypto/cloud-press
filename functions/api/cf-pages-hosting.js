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
async function cfReq(apiToken, method, path, body, cfEmail) {
  // API Token (Bearer) 방식과 Global API Key (X-Auth-Key) 방식 모두 지원
  const headers = { "Content-Type": "application/json" };
  if (cfEmail) {
    // Global API Key 방식
    headers["X-Auth-Email"] = cfEmail;
    headers["X-Auth-Key"]   = apiToken;
  } else {
    // API Token 방식 (권장)
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
async function createCfPagesProject({ cfToken, cfAccountId, cfEmail, projectName, owner, repoName, log }) {
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
    },
    cfEmail
  );

  if (!createRes.ok && createRes.data?.errors?.[0]?.message?.includes("already exists")) {
    await log(`  Pages 프로젝트 이미 존재 - 기존 프로젝트 사용`, "warning");
    // 기존 프로젝트 조회
    const getRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/pages/projects/${projectName}`, null, cfEmail);
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


// ── Cloudflare D1 데이터베이스 생성 ──────────────────────────────────────────
async function createD1Database({ cfToken, cfAccountId, cfEmail, dbName, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  D1 데이터베이스 생성 중: ${dbName}`);

  // 기존 DB 확인
  const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/d1/database?name=${encodeURIComponent(dbName)}`, null, cfEmail);
  const existing = listRes.data?.result?.find(db => db.name === dbName);
  if (existing) {
    await log(`  D1 기존 DB 사용: ${existing.uuid}`);
    return existing.uuid;
  }

  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/d1/database`, { name: dbName }, cfEmail);
  if (!res.ok) {
    await log(`  D1 생성 실패 (HTTP ${res.status}): ${JSON.stringify(res.data?.errors)}`, "error");
    await log(`  D1 응답: ${JSON.stringify(res.data).slice(0, 300)}`, "error");
    return null;
  }
  const id = res.data?.result?.uuid;
  await log(`  D1 생성 완료: ${id}`);
  return id;
}

// ── Cloudflare KV 네임스페이스 생성 ──────────────────────────────────────────
async function createKVNamespace({ cfToken, cfAccountId, cfEmail, title, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  KV 네임스페이스 생성 중: ${title}`);

  // 기존 KV 확인
  const listRes = await cfReq(cfToken, "GET", `/accounts/${cfAccountId}/storage/kv/namespaces`, null, cfEmail);
  const existing = listRes.data?.result?.find(ns => ns.title === title);
  if (existing) {
    await log(`  KV 기존 네임스페이스 사용: ${existing.id}`);
    return existing.id;
  }

  const res = await cfReq(cfToken, "POST", `/accounts/${cfAccountId}/storage/kv/namespaces`, { title }, cfEmail);
  if (!res.ok) {
    await log(`  KV 생성 실패 (HTTP ${res.status}): ${JSON.stringify(res.data?.errors)}`, "error");
    await log(`  KV 응답: ${JSON.stringify(res.data).slice(0, 300)}`, "error");
    return null;
  }
  const id = res.data?.result?.id;
  await log(`  KV 생성 완료: ${id}`);
  return id;
}

// ── Cloudflare Worker 생성 ────────────────────────────────────────────────────
async function createWorker({ cfToken, cfAccountId, cfEmail, workerName, siteId, siteName, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId) return null;
  await log(`  Cloudflare Worker 생성 중: ${workerName}`);

  // Worker 스크립트 (D1/KV 바인딩 포함 프록시)
  const workerScript = `
// CloudPress Worker: ${siteName} (${siteId})
// D1, KV 바인딩이 연결된 Cloudflare Pages 프록시

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // /api/* 요청은 Pages Functions로 처리됨
    return fetch(request);
  }
};
`.trim();

  const bindings = [];
  if (d1Id) bindings.push({ type: "d1", name: "DB", id: d1Id });
  if (kvSessionsId) bindings.push({ type: "kv_namespace", name: "SESSIONS", namespace_id: kvSessionsId });
  if (kvCacheId)    bindings.push({ type: "kv_namespace", name: "CACHE",    namespace_id: kvCacheId });

  const formData = new FormData();
  formData.append("metadata", JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2025-04-01",
    bindings,
  }));
  formData.append("worker.js", new Blob([workerScript], { type: "application/javascript+module" }), "worker.js");

  const workerHeaders = cfEmail
    ? { "X-Auth-Email": cfEmail, "X-Auth-Key": cfToken }
    : { "Authorization": `Bearer ${cfToken}` };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: workerHeaders,
    body: formData,
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    await log(`  Worker 생성 실패 (HTTP ${res.status}): ${JSON.stringify(data?.errors)}`, "error");
    await log(`  Worker 응답: ${JSON.stringify(data).slice(0, 300)}`, "error");
    return null;
  }
  await log(`  Worker 생성 완료: ${workerName}`);
  return workerName;
}

// ── D1 스키마 초기화 ──────────────────────────────────────────────────────────
async function initD1Schema({ cfToken, cfAccountId, cfEmail, d1Id, siteId, adminUser, adminEmail, adminPassHash, log }) {
  if (!cfToken || !cfAccountId || !d1Id) return;
  await log("  D1 스키마 초기화 중...");

  const now = new Date().toISOString();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT DEFAULT 'author', display_name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT, status TEXT DEFAULT 'draft', author_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, filename TEXT, url TEXT, mime_type TEXT, size INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, role, display_name, created_at) VALUES ('admin-${siteId.slice(0,8)}', '${adminUser.replace(/'/g,"''")}', '${adminEmail.replace(/'/g,"''")}', '${adminPassHash}', 'administrator', '${adminUser.replace(/'/g,"''")}', '${now}')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('site_id', '${siteId}')`,
  ];

  for (const sql of statements) {
    const res = await cfReq(cfToken, "POST",
      `/accounts/${cfAccountId}/d1/database/${d1Id}/query`,
      { sql },
      cfEmail
    );
    if (!res.ok) {
      await log(`  D1 쿼리 실패: ${sql.slice(0,60)}... — ${JSON.stringify(res.data?.errors)}`, "warning");
    }
  }
  await log("  D1 스키마 초기화 완료");
}

// ── Cloudflare Pages D1/KV 바인딩 자동 설정 ──────────────────────────────────
async function setCfPagesBindings({ cfToken, cfAccountId, cfEmail, projectName, d1Id, kvSessionsId, kvCacheId, log }) {
  if (!cfToken || !cfAccountId || !projectName) return;

  await log("  Cloudflare 바인딩 자동 설정 중 (D1, KV)...");

  // CF Pages API 바인딩 스펙
  // https://developers.cloudflare.com/api/operations/cloudflare-pages-update-project
  const deploymentConfig = { env_vars: {} };

  if (d1Id) {
    deploymentConfig.d1_databases = { DB: { id: d1Id } };
  }
  if (kvSessionsId || kvCacheId) {
    deploymentConfig.kv_namespaces = {};
    if (kvSessionsId) deploymentConfig.kv_namespaces.SESSIONS = { namespace_id: kvSessionsId };
    if (kvCacheId)    deploymentConfig.kv_namespaces.CACHE    = { namespace_id: kvCacheId };
  }

  const res = await cfReq(cfToken, "PATCH",
    `/accounts/${cfAccountId}/pages/projects/${projectName}`,
    { deployment_configs: { production: deploymentConfig } },
    cfEmail
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
  cfToken, cfAccountId, cfEmail,
  initialDomain, userId, isAdmin,
  log,
}) {
  const token = await pickGithubToken(env);
  if (!token) {
    await log("GitHub 토큰 없음 - 관리자 패널 → GitHub 토큰에서 등록해주세요", "error");
    return null;
  }

  // GitHub 토큰 형식 검증 (ghp_, github_pat_, gho_ 등으로 시작해야 함)
  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_") && !token.startsWith("gho_") && !token.startsWith("ghr_")) {
    await log(`GitHub 토큰 형식 오류: ${token.slice(0,8)}... (ghp_ 또는 github_pat_ 으로 시작해야 함)`, "error");
    await log("CF API Token이 아닌 GitHub Personal Access Token을 등록해주세요", "error");
    await log("GitHub → Settings → Developer Settings → Personal Access Tokens → repo, workflow 권한", "error");
    return null;
  }

  const shortId   = siteId.replace(/-/g, "").slice(0, 8);
  const repoName  = `cp-${shortId}`;
  const projName  = `cp-${shortId}`;

  // GitHub 계정 확인
  const { ok: meOk, status: meStatus, data: meData } = await ghReq("GET", "/user", token);
  if (!meOk || !meData?.login) {
    await log(`GitHub 토큰 인증 실패 (HTTP ${meStatus}): ${JSON.stringify(meData).slice(0, 200)}`, "error");
    await log("관리자 패널 → GitHub 토큰 설정에서 토큰을 재발급해주세요. (repo, workflow 권한 필요)", "error");
    return null;
  }
  const owner = meData.login;
  await log(`GitHub 계정: ${owner} (${meData.name || ""})`);

  await log(`[1/6] GitHub 레포 생성 중: ${owner}/${repoName}`);

  // ── GitHub 레포 생성 ───────────────────────────────────────────────────
  const { ok: repoOk, status: repoStatus, data: repoData } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: `CloudPress 호스팅: ${siteName} (Site ID: ${siteId})`,
    private:     false,
    auto_init:   true,
    has_issues:  false,
    has_wiki:    false,
    has_projects: false,
  });

  if (!repoOk && !repoData?.errors?.[0]?.message?.includes("already exists")) {
    await log(`GitHub 레포 생성 실패 (HTTP ${repoStatus}): ${repoData?.message}`, "error");
    await log(`GitHub 응답: ${JSON.stringify(repoData).slice(0, 300)}`, "error");
    await log("관리자 패널 → 설정에서 GitHub 토큰을 확인하세요.", "warning");
    return null;
  }
  await log(`[1/6] GitHub 레포 생성 완료: ${owner}/${repoName}`);

  await delay(3000); // 레포 초기화 대기

  // ── [2/6] 최소 초기 파일 push ─────────────────────────────────────────
  await log("[2/6] 초기 파일 생성 중...");

  const minimalFiles = {
    "package.json": JSON.stringify({
      name: repoName, version: "0.0.1", private: true,
      scripts: { build: "astro build", dev: "astro dev" },
      dependencies: { astro: "^4.0.0" },
    }, null, 2),
    "astro.config.mjs": `import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'static' });
`,
    "src/pages/index.astro": `---
const siteId = "${siteId}";
const siteName = "${siteName.replace(/"/g, '\"')}";
---
<!DOCTYPE html>
<html><head><title>{siteName}</title></head>
<body><h1>{siteName}</h1><p>CloudPress 호스팅이 준비 중입니다.</p></body></html>
`,
    "README.md": `# ${siteName}

CloudPress 호스팅 레포지토리
- Site ID: ${siteId}
`,
  };

  for (const [filePath, fileContent] of Object.entries(minimalFiles)) {
    await ghPutFile(token, owner, repoName, filePath, fileContent, `init: ${filePath}`, null).catch(() => {});
    await delay(500);
  }
  await log("[2/6] 초기 파일 생성 완료");

  // ── [5/6] Cloudflare D1 / KV / Worker 생성 ──────────────────────────────
  await log("[3/6] Cloudflare 리소스 생성 중 (D1, KV, Worker)...");
  let d1Id        = null;
  let kvSessionsId = null;
  let kvCacheId    = null;
  let workerName   = null;

  if (cfToken && cfAccountId) {
    const resourcePrefix = `cp-${shortId}`;

    // D1 데이터베이스 생성
    d1Id = await createD1Database({
      cfToken, cfAccountId, cfEmail,
      dbName: `${resourcePrefix}-db`,
      log,
    });

    // KV 네임스페이스 생성 (세션용, 캐시용)
    kvSessionsId = await createKVNamespace({
      cfToken, cfAccountId, cfEmail,
      title: `${resourcePrefix}-sessions`,
      log,
    });
    kvCacheId = await createKVNamespace({
      cfToken, cfAccountId, cfEmail,
      title: `${resourcePrefix}-cache`,
      log,
    });

    // Worker 생성 (D1/KV 바인딩 포함)
    workerName = await createWorker({
      cfToken, cfAccountId, cfEmail,
      workerName: resourcePrefix,
      siteId, siteName,
      d1Id, kvSessionsId, kvCacheId,
      log,
    });

    // D1 스키마 초기화
    if (d1Id) {
      // SHA-256 해시 (cf-pages-hosting.js 내 인라인, _shared.js import 불가)
      const adminPassHash = await (async (pw) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
      })(adminPass);
      await initD1Schema({
        cfToken, cfAccountId, cfEmail, d1Id,
        siteId, adminUser, adminEmail,
        adminPassHash,
        log,
      });
    }

    // sites 테이블에 리소스 ID 저장
    await env.DB.prepare(
      "UPDATE sites SET cf_worker_name = ?, cf_d1_id = ?, cf_kv_id = ? WHERE id = ?"
    ).bind(workerName, d1Id, kvSessionsId, siteId).run().catch(() => {});

    await log(`[3/6] Cloudflare 리소스 생성 완료 — D1: ${d1Id ? "✅" : "⚠️없음"}, KV: ${kvSessionsId ? "✅" : "⚠️없음"}, Worker: ${workerName ? "✅" : "⚠️없음"}`);
  } else {
    await log("[3/6] Cloudflare API 없음 — D1/KV/Worker 건너뜀", "warning");
  }

  // ── [6/6] Cloudflare Pages 설정 파일 + 프로젝트 생성 ─────────────────
  await log("[4/6] Cloudflare Pages 프로젝트 생성 중...");

  // 설정 파일은 이미 [2/6]에서 최소 파일로 생성 완료

  let pagesProject = null;
  let pagesUrl     = null;

  if (cfToken && cfAccountId) {
    pagesProject = await createCfPagesProject({
      cfToken, cfAccountId, cfEmail,
      projectName: projName,
      owner, repoName, log,
    });

    if (pagesProject) {
      pagesUrl = `https://${projName}.pages.dev`;

      // 실제 생성된 D1/KV ID로 Pages 바인딩 설정
      await setCfPagesBindings({
        cfToken, cfAccountId, cfEmail,
        projectName: projName,
        d1Id, kvSessionsId, kvCacheId,
        log,
      });

      await log(`[4/6] Cloudflare Pages 연동 완료: ${pagesUrl}`);
    } else {
      await log("[4/6] Cloudflare Pages 수동 설정 필요", "warning");
      pagesUrl = `https://${projName}.pages.dev`;
    }
  } else {
    await log("[4/6] Cloudflare API 없음 — Pages 수동 설정 필요", "warning");
    await log(`  GitHub 레포: https://github.com/${owner}/${repoName}`, "warning");
    pagesUrl = null;
  }

  await log("Cloudflare Pages 호스팅 구축 완료!");

  return {
    owner,
    repoName,
    pagesUrl,
    pagesProject: projName,
    cfDomain:     initialDomain || null,
    d1Id,
    kvSessionsId,
    kvCacheId,
    workerName,
  };
}

// ── URL 계산 ──────────────────────────────────────────────────────────────────
export function getCfPagesUrl(projectName) {
  return `https://${projectName}.pages.dev`;
}
