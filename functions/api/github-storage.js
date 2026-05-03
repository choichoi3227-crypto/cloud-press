// functions/api/github-storage.js
// GitHub 기반 스토리지 관리 API
// GET    /api/github-storage?action=tokens          → 저장된 토큰 목록 (마스킹)
// POST   /api/github-storage?action=add_token       → 토큰 추가
// DELETE /api/github-storage?action=remove_token&id= → 토큰 삭제
// GET    /api/github-storage?action=repo&site_id=   → 사이트 repo 정보
// POST   /api/github-storage?action=upload_wp&site_id= → WordPress 파일 업로드 트리거

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// ── GitHub API 헬퍼 ───────────────────────────────────────────────────────

export async function ghReq(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization:            `Bearer ${token}`,
      Accept:                   "application/vnd.github+json",
      "X-GitHub-Api-Version":   "2022-11-28",
      "Content-Type":           "application/json",
      "User-Agent":             "CloudPress-Hosting/3.1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ── 딜레이 유틸 ───────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Rate Limit 안전 대기 ──────────────────────────────────────────────────

async function waitForRateLimit(token, minRemaining = 5) {
  const { data } = await ghReq("GET", "/rate_limit", token);
  const remaining = data?.rate?.remaining ?? 60;
  const reset     = data?.rate?.reset     ?? 0;

  if (remaining < minRemaining) {
    const now     = Math.floor(Date.now() / 1000);
    const waitSec = Math.max(reset - now + 5, 60);
    console.warn(`[github] rate limit low (${remaining}), waiting ${waitSec}s`);
    await delay(waitSec * 1000);
  }
}

// ── 사용 가능한 토큰 선택 ─────────────────────────────────────────────────

export async function pickGithubToken(env) {
  let tokens = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, token FROM github_tokens WHERE active = 1 ORDER BY last_used_at ASC"
    ).all();
    tokens = results || [];
  } catch {}

  if (env.GITHUB_TOKEN) {
    tokens = [{ id: "env", token: env.GITHUB_TOKEN }, ...tokens];
  }

  if (!tokens.length) return null;

  for (const t of tokens) {
    const { data } = await ghReq("GET", "/rate_limit", t.token);
    const remaining = data?.rate?.remaining ?? 0;
    if (remaining > 10) {
      if (t.id !== "env") {
        await env.DB.prepare(
          "UPDATE github_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(t.id).run().catch(() => {});
      }
      return t.token;
    }
  }

  return tokens[0]?.token || null;
}

// ── 사이트 repo 이름 생성 ─────────────────────────────────────────────────

export function getRepoName(siteId) {
  const shortId = siteId.replace(/-/g, "").slice(0, 12);
  return `cloudpress-site-${shortId}`;
}

// ── GitHub repo 생성 ──────────────────────────────────────────────────────

export async function createGithubRepo(token, repoName, description) {
  const { data: user } = await ghReq("GET", "/user", token);
  if (!user?.login) return { error: "GitHub 토큰이 유효하지 않습니다." };

  const owner = user.login;

  const { status: checkStatus } = await ghReq("GET", `/repos/${owner}/${repoName}`, token);
  if (checkStatus === 200) {
    return { owner, repoName, exists: true };
  }

  const { ok, data } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: description || "CloudPress WordPress site storage",
    private:     true,
    auto_init:   true,
  });

  if (!ok) {
    return { error: data?.message || "GitHub repo 생성 실패" };
  }

  return { owner, repoName, repoUrl: data.html_url, created: true };
}

// ── 파일 업로드 (GitHub Contents API) ────────────────────────────────────

export async function uploadFileToGithub(token, owner, repo, filePath, content, message) {
  let base64Content;
  if (typeof content === "string") {
    const bytes = new TextEncoder().encode(content);
    // btoa 안전하게 처리 (대용량 문자열)
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64Content = btoa(binary);
  } else if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
    const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64Content = btoa(binary);
  } else {
    base64Content = content;
  }

  // 기존 파일 SHA 조회
  let sha;
  const { data: existing } = await ghReq("GET", `/repos/${owner}/${repo}/contents/${filePath}`, token);
  if (existing?.sha) sha = existing.sha;

  const body = {
    message: message || `Upload ${filePath}`,
    content: base64Content,
  };
  if (sha) body.sha = sha;

  const { ok, data } = await ghReq("PUT", `/repos/${owner}/${repo}/contents/${filePath}`, token, body);
  if (!ok) return { error: data?.message || "업로드 실패" };
  return { success: true, path: filePath, sha: data?.content?.sha };
}

// ── 배치 업로드 (타임아웃 방지 - 파일 목록을 청크로 나눠서 업로드) ──────

async function uploadBatch(token, owner, repo, files, log, batchSize = 3, delayMs = 500) {
  const results = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);

    // 배치 내 파일들을 순차 업로드
    for (const file of batch) {
      try {
        const r = await uploadFileToGithub(
          token, owner, repo,
          file.path, file.content,
          file.message || `add ${file.path}`
        );
        if (r.error) {
          results.failed++;
          results.errors.push({ path: file.path, error: r.error });
          console.warn(`[upload] 실패: ${file.path} — ${r.error}`);
        } else {
          results.success++;
        }
      } catch (e) {
        results.failed++;
        results.errors.push({ path: file.path, error: e.message });
      }

      // 파일 간 딜레이 (rate limit 방지)
      await delay(delayMs);
    }

    // 배치 간 딜레이 (더 긴 대기)
    if (i + batchSize < files.length) {
      await delay(delayMs * 3);
    }

    // Rate limit 확인
    if (i % (batchSize * 5) === 0 && i > 0) {
      await waitForRateLimit(token, 10);
    }

    if (log) {
      await log(
        `GitHub 업로드 진행: ${Math.min(i + batchSize, files.length)}/${files.length} 파일`
      ).catch(() => {});
    }
  }

  return results;
}

// ── WordPress 핵심 파일 생성 (실제 WP 없이 동작하는 최소 구조) ───────────
// 실제 WordPress.org에서 직접 다운로드가 불가한 환경에서
// 동작하는 최소한의 WordPress 호환 파일을 생성합니다.

// ── WordPress 공식 GitHub Actions 기반 설치 워크플로우 생성 ─────────────────
// WordPress/WordPress (github.com/WordPress/WordPress) 공식 레포를 사용
// GitHub Actions로 파일을 가져오므로 Worker의 직접 업로드가 필요없음

function buildWordPressInstallWorkflow(siteId, owner, repo) {
  return `name: CloudPress — WordPress Install & Sync

on:
  push:
    branches: [ main ]
  workflow_dispatch:
    inputs:
      action:
        description: '작업 선택'
        required: false
        default: 'sync'
        type: choice
        options:
          - sync
          - reinstall
          - validate
          - cleanup

concurrency:
  group: cloudpress-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  setup:
    name: WordPress 환경 설정
    runs-on: ubuntu-latest
    outputs:
      site-id: \${{ steps.info.outputs.site_id }}
    steps:
      - name: Site Info
        id: info
        run: |
          echo "site_id=${siteId}" >> \$GITHUB_OUTPUT
          echo "🏗️ CloudPress Site: ${siteId}"
          echo "📦 Repo: ${owner}/${repo}"

  validate-structure:
    name: 저장소 구조 검증
    runs-on: ubuntu-latest
    needs: setup
    steps:
      - uses: actions/checkout@v4

      - name: Ensure required directories
        run: |
          mkdir -p wp-content/themes
          mkdir -p wp-content/plugins
          mkdir -p wp-content/mu-plugins
          mkdir -p uploads
          echo "✅ 디렉터리 구조 확인 완료"

      - name: Validate wp-content structure
        run: |
          echo "📁 wp-content 구조:"
          find wp-content -maxdepth 2 -type d | sort
          echo ""
          echo "📤 uploads 구조:"
          find uploads -maxdepth 3 -type d | sort || echo "(비어 있음)"

      - name: Check theme validity
        run: |
          for theme_dir in wp-content/themes/*/; do
            [ -d "\$theme_dir" ] || continue
            theme=\$(basename "\$theme_dir")
            if [ -f "\$theme_dir/style.css" ]; then
              name=\$(grep -m1 "^Theme Name:" "\$theme_dir/style.css" | sed 's/Theme Name://' | xargs)
              echo "✅ 테마: \$theme (\${name:-이름 없음})"
            else
              echo "⚠️ 테마 \$theme: style.css 없음 (WordPress 테마가 아닐 수 있음)"
            fi
          done

      - name: Check plugin validity
        run: |
          for plugin_dir in wp-content/plugins/*/; do
            [ -d "\$plugin_dir" ] || continue
            plugin=\$(basename "\$plugin_dir")
            main=\$(find "\$plugin_dir" -maxdepth 1 -name "*.php" | head -1)
            if [ -n "\$main" ]; then
              name=\$(grep -m1 "Plugin Name:" "\$main" | sed 's/.*Plugin Name://' | xargs || echo "")
              echo "✅ 플러그인: \$plugin (\${name:-이름 없음})"
            else
              echo "⚠️ 플러그인 \$plugin: 메인 PHP 파일 없음"
            fi
          done

  sync-to-cloudpress:
    name: CloudPress 서버 동기화
    runs-on: ubuntu-latest
    needs: [setup, validate-structure]
    if: always()
    steps:
      - uses: actions/checkout@v4

      - name: Calculate changed files
        id: changes
        run: |
          if git rev-parse HEAD~1 >/dev/null 2>&1; then
            CHANGED=\$(git diff --name-only HEAD~1 HEAD | head -50)
          else
            CHANGED="Initial commit - all files"
          fi
          echo "changed<<EOF" >> \$GITHUB_OUTPUT
          echo "\$CHANGED" >> \$GITHUB_OUTPUT
          echo "EOF" >> \$GITHUB_OUTPUT
          echo "파일 변경 목록:"
          echo "\$CHANGED"

      - name: Notify CloudPress webhook
        env:
          WEBHOOK_URL: \${{ secrets.CLOUDPRESS_WEBHOOK_URL }}
        run: |
          if [ -n "\$WEBHOOK_URL" ]; then
            PAYLOAD=\$(cat <<JSONEOF
          {
            "site_id": "${siteId}",
            "event": "push",
            "ref": "\$GITHUB_REF",
            "sha": "\$GITHUB_SHA",
            "actor": "\$GITHUB_ACTOR",
            "repo": "${owner}/${repo}"
          }
          JSONEOF
          )
            HTTP_STATUS=\$(curl -s -o /dev/null -w "%{http_code}" \\
              -X POST "\$WEBHOOK_URL" \\
              -H "Content-Type: application/json" \\
              -H "X-CloudPress-Event: push" \\
              -H "X-CloudPress-Site: ${siteId}" \\
              -d "\$PAYLOAD")
            echo "Webhook 응답: \$HTTP_STATUS"
          else
            echo "ℹ️ CLOUDPRESS_WEBHOOK_URL 시크릿 미설정 (선택사항)"
          fi

  file-manager-report:
    name: 파일 관리 리포트
    runs-on: ubuntu-latest
    needs: [validate-structure]
    if: always()
    steps:
      - uses: actions/checkout@v4

      - name: Generate storage report
        run: |
          echo "## 📊 CloudPress 저장소 리포트" >> \$GITHUB_STEP_SUMMARY
          echo "" >> \$GITHUB_STEP_SUMMARY
          echo "**Site ID:** \`${siteId}\`" >> \$GITHUB_STEP_SUMMARY
          echo "**Timestamp:** \$(date -u '+%Y-%m-%d %H:%M:%S UTC')" >> \$GITHUB_STEP_SUMMARY
          echo "" >> \$GITHUB_STEP_SUMMARY

          echo "### 📁 디렉터리 크기" >> \$GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> \$GITHUB_STEP_SUMMARY
          du -sh wp-content/ uploads/ 2>/dev/null || echo "디렉터리 없음"
          du -sh wp-content/ uploads/ 2>/dev/null >> \$GITHUB_STEP_SUMMARY || true
          echo "\`\`\`" >> \$GITHUB_STEP_SUMMARY

          echo "### 🎨 설치된 테마" >> \$GITHUB_STEP_SUMMARY
          for d in wp-content/themes/*/; do
            [ -d "\$d" ] || continue
            echo "- \$(basename \$d)" >> \$GITHUB_STEP_SUMMARY
          done

          echo "### 🔌 설치된 플러그인" >> \$GITHUB_STEP_SUMMARY
          for d in wp-content/plugins/*/; do
            [ -d "\$d" ] || continue
            echo "- \$(basename \$d)" >> \$GITHUB_STEP_SUMMARY
          done

          echo "" >> \$GITHUB_STEP_SUMMARY
          echo "### 📷 최근 업로드" >> \$GITHUB_STEP_SUMMARY
          find uploads -type f \\( -name "*.jpg" -o -name "*.png" -o -name "*.gif" -o -name "*.webp" \\) 2>/dev/null | tail -10 | while read f; do
            echo "- \$f" >> \$GITHUB_STEP_SUMMARY
          done || echo "- (없음)" >> \$GITHUB_STEP_SUMMARY
`;
}

// ── WordPress 저장소 초기화 파일 목록 ─────────────────────────────────────
// wp-content와 uploads만 저장 (WordPress 코어는 WordPress/WordPress 공식 레포 사용)

function buildInitFiles(siteId, owner, repo) {
  const workflow = buildWordPressInstallWorkflow(siteId, owner, repo);

  return [
    // WordPress 테마 (기본 Twenty Twenty-Four 스타일 — 공식 테마는 WP core에 있음)
    {
      path: "wp-content/themes/twentytwentyfour/style.css",
      content: `/*
Theme Name: Twenty Twenty-Four
Theme URI: https://wordpress.org/themes/twentytwentyfour/
Author: the WordPress team
Author URI: https://wordpress.org
Description: Twenty Twenty-Four is designed to be flexible, versatile and applicable to any website. Its collection of templates and patterns tailor to different needs, such as presenting a business, blogging and writing or showcasing work. A multitude of possibilities open up with just a few adjustments to color and typography. Twenty Twenty-Four comes with style variations and full site editing to help you build any site imaginable.
Requires at least: 6.4
Tested up to: 6.7
Requires PHP: 7.0
Version: 1.2
License: GNU General Public License v2 or later
License URI: http://www.gnu.org/licenses/gpl-2.0.html
Text Domain: twentytwentyfour
Tags: one-column, custom-colors, custom-menu, custom-logo, editor-style, featured-images, full-site-editing, block-patterns, rtl-language-support, sticky-post, threaded-comments, translation-ready, wide-blocks, block-editor-patterns, full-width-template
*/
`,
      message: "init: Twenty Twenty-Four theme style.css",
    },
    {
      path: "wp-content/themes/twentytwentyfour/theme.json",
      content: JSON.stringify({
        "$schema": "https://schemas.wp.org/trunk/theme.json",
        "version": 3,
        "settings": {
          "appearanceTools": true,
          "color": {
            "palette": [
              { "slug": "base", "color": "#ffffff", "name": "Base" },
              { "slug": "base-2", "color": "#f9f9f9", "name": "Base / Two" },
              { "slug": "contrast", "color": "#111111", "name": "Contrast" },
              { "slug": "accent-1", "color": "#cfcabe", "name": "Accent / One" },
              { "slug": "accent-2", "color": "#c77b2f", "name": "Accent / Two" },
              { "slug": "accent-3", "color": "#816c5b", "name": "Accent / Three" },
              { "slug": "accent-4", "color": "#33231e", "name": "Accent / Four" },
              { "slug": "accent-5", "color": "#543a28", "name": "Accent / Five" },
            ]
          },
          "typography": {
            "fontFamilies": [
              {
                "fontFamily": "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen-Sans,Ubuntu,Cantarell,'Helvetica Neue',sans-serif",
                "slug": "system-font",
                "name": "System Font"
              }
            ]
          },
          "layout": { "contentSize": "620px", "wideSize": "1280px" }
        }
      }, null, 2),
      message: "init: Twenty Twenty-Four theme.json",
    },
    {
      path: "wp-content/plugins/.gitkeep",
      content: "",
      message: "init: plugins directory",
    },
    {
      path: "wp-content/mu-plugins/.gitkeep",
      content: "",
      message: "init: mu-plugins directory",
    },
    {
      path: "uploads/.gitkeep",
      content: "",
      message: "init: uploads directory",
    },
    // GitHub Actions 워크플로우 (파일 관리자 자동화)
    {
      path: ".github/workflows/cloudpress-file-manager.yml",
      content: workflow,
      message: "init: GitHub Actions file manager workflow",
    },
    // README
    {
      path: "README.md",
      content: `# CloudPress WordPress Site

> Site ID: \`${siteId}\`

## 개요

이 저장소는 CloudPress WordPress 사이트의 **wp-content** (테마/플러그인/업로드)를 저장합니다.

WordPress 코어는 [WordPress/WordPress](https://github.com/WordPress/WordPress) 공식 레포지토리에서 직접 서빙됩니다.

## 디렉터리 구조

\`\`\`
/
├── .github/
│   └── workflows/
│       └── cloudpress-file-manager.yml  ← 파일 관리 자동화
├── wp-content/
│   ├── themes/         ← WordPress 테마
│   │   └── twentytwentyfour/
│   ├── plugins/        ← WordPress 플러그인
│   └── mu-plugins/     ← 필수 플러그인 (자동 로드)
└── uploads/            ← 미디어 업로드 파일
\`\`\`

## 사용 방법

### 테마 추가

\`wp-content/themes/<테마명>/\` 디렉터리에 테마 파일을 업로드하세요.

### 플러그인 추가

\`wp-content/plugins/<플러그인명>/\` 디렉터리에 플러그인 파일을 업로드하세요.

### GitHub Actions 자동화

이 저장소에 파일을 push하면 GitHub Actions가 자동으로:
1. WordPress 파일 구조를 검증합니다
2. 테마/플러그인 유효성을 검사합니다
3. CloudPress 서버에 변경 사항을 알립니다

### Webhook 설정 (선택사항)

파일 변경 시 서버 자동 알림을 받으려면:
Repository → Settings → Secrets and variables → Actions → \`CLOUDPRESS_WEBHOOK_URL\` 추가

---
*Powered by [CloudPress](https://cloudpress.pages.dev) — WordPress on Cloudflare*
`,
      message: "init: README.md",
    },
  ];
}

// ── WordPress 파일 업로드 (백그라운드) ───────────────────────────────────
// 공식 WordPress/WordPress 레포 기반 — wp-content와 uploads만 사용자 레포에 저장
// 코어 파일은 Worker에서 WordPress/WordPress 레포를 직접 참조

export async function uploadWordPressFilesBackground(token, owner, repo, siteId, log) {
  try {
    if (log) await log("WordPress 파일 초기화 시작 (공식 WordPress/WordPress 기반)...").catch(() => {});

    const initFiles = buildInitFiles(siteId, owner, repo);

    if (log) await log(`총 ${initFiles.length}개 초기화 파일 업로드 예정`).catch(() => {});

    await waitForRateLimit(token, 20);

    const results = await uploadBatch(token, owner, repo, initFiles, log, 2, 400);

    if (log) {
      await log(
        `WordPress 저장소 초기화 완료: 성공 ${results.success}개, 실패 ${results.failed}개`
      ).catch(() => {});
    }

    // 설치 완료 마커
    await uploadFileToGithub(
      token, owner, repo,
      ".cloudpress-init",
      JSON.stringify({
        version:    "5.0",
        site_id:    siteId,
        wp_core:    "WordPress/WordPress (official)",
        init_at:    new Date().toISOString(),
        files:      results.success,
      }),
      "init: CloudPress installation marker"
    ).catch(() => {});

    if (log) await log("✅ WordPress 저장소 초기화 완료! GitHub Actions가 활성화되었습니다.").catch(() => {});
    return results;

  } catch (e) {
    console.error("[uploadWordPressFiles] 오류:", e.message);
    if (log) await log(`WordPress 파일 초기화 오류: ${e.message}`, "error").catch(() => {});
    throw e;
  }
}

// ── 파일 다운로드 ─────────────────────────────────────────────────────────

export async function downloadFileFromGithub(token, owner, repo, filePath) {
  const { ok, data } = await ghReq("GET", `/repos/${owner}/${repo}/contents/${filePath}`, token);
  if (!ok || !data?.content) return null;
  return atob(data.content.replace(/\n/g, ""));
}

// ── 디렉터리 목록 ─────────────────────────────────────────────────────────

export async function listFilesInGithub(token, owner, repo, dirPath = "") {
  const path = dirPath
    ? `/repos/${owner}/${repo}/contents/${dirPath}`
    : `/repos/${owner}/${repo}/contents`;
  const { ok, data } = await ghReq("GET", path, token);
  if (!ok) return [];
  return Array.isArray(data) ? data : [];
}

// ── 대용량 파일 청크 업로드 ───────────────────────────────────────────────

export async function uploadLargeFileChunked(
  token, owner, repo, filePath,
  totalChunks, chunkIndex, chunkContent, totalSize
) {
  const chunkPath = `${filePath}.chunk.${String(chunkIndex).padStart(4, "0")}`;
  const result = await uploadFileToGithub(
    token, owner, repo, chunkPath, chunkContent,
    `chunk ${chunkIndex + 1}/${totalChunks} of ${filePath}`
  );
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// API 핸들러
// ────────────────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);
  if (payload.role !== "admin") return jsonErr("관리자 권한이 필요합니다.", 403);

  const url    = new URL(request.url);
  const action = url.searchParams.get("action");

  if (action === "tokens") {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, label, masked_token, active, created_at, last_used_at FROM github_tokens ORDER BY id DESC"
      ).all();
      return jsonOk({ success: true, tokens: results || [] });
    } catch {
      return jsonOk({ success: true, tokens: [] });
    }
  }

  if (action === "repo") {
    const siteId = url.searchParams.get("site_id");
    if (!siteId) return jsonErr("site_id가 필요합니다.", 400);
    const site = await env.DB.prepare(
      "SELECT id, github_repo_owner, github_repo_name FROM sites WHERE id = ?"
    ).bind(siteId).first();
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
    return jsonOk({ success: true, owner: site.github_repo_owner, repo: site.github_repo_name });
  }

  if (action === "upload_status") {
    const siteId = url.searchParams.get("site_id");
    if (!siteId) return jsonErr("site_id가 필요합니다.", 400);
    const site = await env.DB.prepare(
      "SELECT github_repo_owner, github_repo_name FROM sites WHERE id = ?"
    ).bind(siteId).first();
    if (!site?.github_repo_owner) return jsonOk({ success: true, installed: false, status: "no_repo" });

    const token = await pickGithubToken(env);
    if (!token) return jsonOk({ success: false, installed: false, status: "no_token" });

    const { ok, data } = await ghReq(
      "GET",
      `/repos/${site.github_repo_owner}/${site.github_repo_name}/contents/wp-core/.cloudpress-installed`,
      token
    );
    if (ok && data?.content) {
      const meta = JSON.parse(atob(data.content.replace(/\n/g, "")));
      return jsonOk({ success: true, installed: true, meta });
    }
    return jsonOk({ success: true, installed: false, status: "uploading" });
  }

  return jsonErr("action이 필요합니다.", 400);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);
  if (payload.role !== "admin") return jsonErr("관리자 권한이 필요합니다.", 403);

  const url    = new URL(request.url);
  const action = url.searchParams.get("action");

  // 토큰 추가
  if (!action || action === "add_token") {
    let body;
    try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

    const { token, label } = body;
    if (!token) return jsonErr("GitHub Personal Access Token을 입력해주세요.", 400);

    const { ok, data: user } = await ghReq("GET", "/user", token);
    if (!ok || !user?.login) return jsonErr("유효하지 않은 GitHub 토큰입니다.", 400);

    const masked = token.length > 12
      ? token.slice(0, 8) + "****" + token.slice(-4)
      : "****";

    try {
      await env.DB.prepare(
        "INSERT INTO github_tokens (token, masked_token, label, active, created_at) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)"
      ).bind(token, masked, label || `@${user.login}`).run();

      return jsonOk({
        success:     true,
        message:     `GitHub 토큰이 추가되었습니다. (계정: @${user.login})`,
        github_user: user.login,
        masked,
      });
    } catch (e) {
      return jsonErr("토큰 저장 오류: " + e.message, 500);
    }
  }

  // WordPress 파일 수동 업로드 트리거
  if (action === "upload_wp") {
    const siteId = url.searchParams.get("site_id");
    let body = {};
    try { body = await request.json(); } catch {}

    if (!siteId) return jsonErr("site_id가 필요합니다.", 400);

    const site = await env.DB.prepare(
      "SELECT github_repo_owner, github_repo_name FROM sites WHERE id = ?"
    ).bind(siteId).first();

    if (!site?.github_repo_owner || !site?.github_repo_name) {
      return jsonErr("사이트에 GitHub 저장소가 연결되어 있지 않습니다.", 400);
    }

    const token = await pickGithubToken(env);
    if (!token) return jsonErr("사용 가능한 GitHub 토큰이 없습니다.", 400);

    const log = async (msg, level = "info") => {
      await env.DB.prepare(
        "INSERT INTO php_logs (site_id, message, level) VALUES (?, ?, ?)"
      ).bind(siteId, msg, level).run().catch(() => {});
    };

    // 백그라운드에서 업로드
    if (context.waitUntil) {
      context.waitUntil(
        uploadWordPressFilesBackground(
          token, site.github_repo_owner, site.github_repo_name, siteId, log
        )
      );
    } else {
      uploadWordPressFilesBackground(
        token, site.github_repo_owner, site.github_repo_name, siteId, log
      ).catch(console.error);
    }

    return jsonOk({
      success: true,
      message: "WordPress 파일 업로드가 백그라운드에서 시작되었습니다. 로그에서 진행 상황을 확인해주세요.",
      repo:    `${site.github_repo_owner}/${site.github_repo_name}`,
    });
  }

  return jsonErr("action이 필요합니다.", 400);
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);
  if (payload.role !== "admin") return jsonErr("관리자 권한이 필요합니다.", 403);

  const url = new URL(request.url);
  const id  = url.searchParams.get("id");
  if (!id) return jsonErr("id가 필요합니다.", 400);

  await env.DB.prepare("DELETE FROM github_tokens WHERE id = ?").bind(id).run();
  return jsonOk({ success: true, message: "토큰이 삭제되었습니다." });
}
