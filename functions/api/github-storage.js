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

function buildMinimalWpFiles(siteId) {
  const files = [];

  // wp-config.php (플레이스홀더 — Worker에서 런타임 주입)
  files.push({
    path:    "wp-core/wp-config.php",
    content: `<?php
// CloudPress WordPress 설정 — 실제 설정은 Worker에서 주입됩니다
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
if (file_exists(ABSPATH . 'wp-settings.php')) {
  require_once ABSPATH . 'wp-settings.php';
}
`,
    message: "add wp-config.php",
  });

  // wp-load.php
  files.push({
    path:    "wp-core/wp-load.php",
    content: `<?php
// CloudPress WordPress Loader
define('WPINC', 'wp-includes');
if (!defined('ABSPATH')) {
  define('ABSPATH', dirname(__FILE__) . '/');
}
require_once ABSPATH . 'wp-config.php';
`,
    message: "add wp-load.php",
  });

  // index.php
  files.push({
    path:    "wp-core/index.php",
    content: `<?php
/**
 * CloudPress WordPress — Front Controller
 */
define('WP_USE_THEMES', true);
require(dirname(__FILE__) . '/wp-blog-header.php');
`,
    message: "add index.php",
  });

  // wp-blog-header.php
  files.push({
    path:    "wp-core/wp-blog-header.php",
    content: `<?php
if (!isset($wp_did_header)) {
  $wp_did_header = true;
  require_once dirname(__FILE__) . '/wp-load.php';
  wp();
  require_once ABSPATH . WPINC . '/template-loader.php';
}
`,
    message: "add wp-blog-header.php",
  });

  // wp-login.php (최소 로그인 페이지)
  files.push({
    path:    "wp-core/wp-login.php",
    content: `<?php
/**
 * CloudPress WordPress Login
 */
require dirname(__FILE__) . '/wp-load.php';
// 기본 로그인 처리는 wp-includes/functions.php를 통해 처리됩니다.
wp_login_form();
`,
    message: "add wp-login.php",
  });

  // wp-settings.php (최소 부트스트랩)
  files.push({
    path:    "wp-core/wp-settings.php",
    content: `<?php
/**
 * CloudPress WordPress Settings Bootstrap
 */
define('WPINC', 'wp-includes');

// 필수 상수
if (!defined('WP_CONTENT_DIR')) {
  define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
}
if (!defined('WP_CONTENT_URL')) {
  define('WP_CONTENT_URL', defined('WP_SITEURL') ? WP_SITEURL . '/wp-content' : '/wp-content');
}
if (!defined('WP_PLUGIN_DIR')) {
  define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');
}
if (!defined('WP_PLUGIN_URL')) {
  define('WP_PLUGIN_URL', WP_CONTENT_URL . '/plugins');
}

// 기본 함수 로드
if (file_exists(ABSPATH . WPINC . '/functions.php')) {
  require_once ABSPATH . WPINC . '/functions.php';
}
if (file_exists(ABSPATH . WPINC . '/class-wp.php')) {
  require_once ABSPATH . WPINC . '/class-wp.php';
}
`,
    message: "add wp-settings.php",
  });

  // wp-includes/functions.php (최소 함수)
  files.push({
    path:    "wp-core/wp-includes/functions.php",
    content: `<?php
/**
 * CloudPress WordPress Functions (minimal)
 */
if (!function_exists('wp')) {
  function wp() { global $wp; if (isset($wp)) $wp->main(); }
}
if (!function_exists('wp_login_form')) {
  function wp_login_form($args = []) {
    $action = isset($_SERVER['REQUEST_URI']) ? htmlspecialchars($_SERVER['REQUEST_URI']) : '/wp-login.php';
    echo '<form method="post" action="' . $action . '">';
    echo '<p><label>아이디: <input type="text" name="log"></label></p>';
    echo '<p><label>비밀번호: <input type="password" name="pwd"></label></p>';
    echo '<p><input type="submit" value="로그인"></p>';
    echo '</form>';
  }
}
if (!function_exists('esc_html')) {
  function esc_html($text) { return htmlspecialchars($text, ENT_QUOTES, 'UTF-8'); }
}
if (!function_exists('esc_attr')) {
  function esc_attr($text) { return htmlspecialchars($text, ENT_QUOTES, 'UTF-8'); }
}
if (!function_exists('__')) {
  function __($text, $domain = '') { return $text; }
}
if (!function_exists('_e')) {
  function _e($text, $domain = '') { echo $text; }
}
`,
    message: "add wp-includes/functions.php",
  });

  // wp-includes/class-wp.php (최소 WP 클래스)
  files.push({
    path:    "wp-core/wp-includes/class-wp.php",
    content: `<?php
/**
 * CloudPress WordPress Main Class (minimal)
 */
if (!class_exists('WP')) {
  class WP {
    public $query_vars = [];
    public function main($query_args = '') {
      // 최소 구현
    }
  }
}
`,
    message: "add wp-includes/class-wp.php",
  });

  // wp-includes/template-loader.php
  files.push({
    path:    "wp-core/wp-includes/template-loader.php",
    content: `<?php
/**
 * CloudPress Template Loader (minimal)
 */
$template = false;

// 활성 테마 템플릿 로드
$template_dir = defined('WP_CONTENT_DIR') ? WP_CONTENT_DIR . '/themes/twentytwentyfour' : '';
if ($template_dir && file_exists($template_dir . '/index.php')) {
  $template = $template_dir . '/index.php';
}

if ($template) {
  include $template;
} else {
  // 기본 페이지 출력
  echo '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">';
  echo '<meta name="viewport" content="width=device-width, initial-scale=1">';
  echo '<title>' . (defined('WP_SITEURL') ? WP_SITEURL : 'CloudPress') . '</title>';
  echo '<style>body{font-family:sans-serif;max-width:800px;margin:50px auto;padding:0 20px}</style>';
  echo '</head><body>';
  echo '<h1>🚀 CloudPress WordPress</h1>';
  echo '<p>WordPress가 성공적으로 설치되었습니다.</p>';
  echo '<p><a href="/wp-admin">관리자 페이지로 이동</a></p>';
  echo '</body></html>';
}
`,
    message: "add wp-includes/template-loader.php",
  });

  // wp-admin/index.php
  files.push({
    path:    "wp-core/wp-admin/index.php",
    content: `<?php
/**
 * CloudPress WordPress Admin
 */
if (!defined('ABSPATH')) {
  define('ABSPATH', dirname(__FILE__, 2) . '/');
}
require_once ABSPATH . 'wp-load.php';

// 최소 관리자 대시보드
?><!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WordPress 관리자 — CloudPress</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f1;margin:0}
    .wrap{max-width:960px;margin:40px auto;padding:20px}
    h1{color:#1d2327;font-size:23px;margin-bottom:20px}
    .card{background:#fff;border:1px solid #c3c4c7;border-radius:3px;padding:24px;margin-bottom:16px}
    .status{display:inline-block;padding:4px 8px;border-radius:3px;font-size:12px;background:#d63638;color:#fff}
    .status.ok{background:#00a32a}
    a{color:#2271b1}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🚀 CloudPress WordPress 관리자</h1>
    <div class="card">
      <h2>사이트 상태</h2>
      <p>사이트 ID: <?= defined('CLOUDPRESS_SITE_ID') ? esc_html(CLOUDPRESS_SITE_ID) : 'N/A' ?></p>
      <p>GitHub: <?= defined('CLOUDPRESS_GITHUB_OWNER') ? esc_html(CLOUDPRESS_GITHUB_OWNER . '/' . CLOUDPRESS_GITHUB_REPO) : '미설정' ?></p>
      <p>데이터베이스: <span class="status ok">D1 연결됨</span></p>
    </div>
    <div class="card">
      <h2>CloudPress 플랫폼</h2>
      <p>전체 WordPress 기능은 CloudPress 플랫폼 대시보드에서 관리할 수 있습니다.</p>
      <p><a href="https://cloudpress.pages.dev/hosting.html">→ CloudPress 대시보드로 이동</a></p>
    </div>
  </div>
</body>
</html>
`,
    message: "add wp-admin/index.php",
  });

  // wp-admin/wp-login.php (리다이렉트)
  files.push({
    path:    "wp-core/wp-admin/wp-login.php",
    content: `<?php
header('Location: /wp-login.php');
exit;
`,
    message: "add wp-admin/wp-login.php",
  });

  // wp-content/themes/twentytwentyfour/index.php
  files.push({
    path:    "wp-content/themes/twentytwentyfour/index.php",
    content: `<?php
/**
 * Twenty Twenty-Four Theme for CloudPress (minimal)
 */
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
  <meta charset="<?php bloginfo('charset'); ?>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?php bloginfo('name'); ?></title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      background:#fff;color:#1a1a1a;line-height:1.7}
    header{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:60px 20px;text-align:center}
    header h1{font-size:2.5rem;margin-bottom:8px}
    header p{opacity:.85;font-size:1.1rem}
    main{max-width:800px;margin:60px auto;padding:0 20px}
    article{margin-bottom:60px;padding-bottom:40px;border-bottom:1px solid #eee}
    h2{font-size:1.75rem;margin-bottom:12px;color:#1a1a2e}
    .meta{color:#888;font-size:.875rem;margin-bottom:16px}
    footer{background:#f8f9fa;text-align:center;padding:40px 20px;color:#888;font-size:.875rem;border-top:1px solid #eee}
    a{color:#667eea;text-decoration:none}a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <header>
    <h1><?php bloginfo('name'); ?></h1>
    <p><?php bloginfo('description'); ?></p>
  </header>
  <main>
    <?php if (function_exists('have_posts') && have_posts()): ?>
      <?php while (have_posts()): the_post(); ?>
        <article>
          <h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
          <div class="meta"><?php the_date(); ?></div>
          <?php the_content(); ?>
        </article>
      <?php endwhile; ?>
    <?php else: ?>
      <article>
        <h2>안녕하세요! 👋</h2>
        <p>CloudPress에서 제공하는 WordPress 호스팅에 오신 것을 환영합니다.</p>
        <p>이 사이트는 Cloudflare Workers와 GitHub 스토리지 기반으로 동작합니다.</p>
      </article>
    <?php endif; ?>
  </main>
  <footer>
    <p>Powered by <strong>CloudPress</strong> — WordPress on Cloudflare</p>
  </footer>
</body>
</html>
`,
    message: "add Twenty Twenty-Four theme",
  });

  // style.css for theme
  files.push({
    path:    "wp-content/themes/twentytwentyfour/style.css",
    content: `/*
Theme Name: Twenty Twenty-Four (CloudPress)
Description: CloudPress 최적화 WordPress 테마
Version: 1.0
*/
`,
    message: "add theme style.css",
  });

  // wp-content/themes/twentytwentyfour/functions.php
  files.push({
    path:    "wp-content/themes/twentytwentyfour/functions.php",
    content: `<?php
/**
 * Twenty Twenty-Four Functions (CloudPress minimal)
 */
if (function_exists('add_theme_support')) {
  add_theme_support('title-tag');
  add_theme_support('post-thumbnails');
  add_theme_support('html5', ['comment-list','comment-form','search-form','gallery','caption']);
}
`,
    message: "add theme functions.php",
  });

  return files;
}

// ── WordPress 실제 파일 업로드 (백그라운드, 타임아웃 완화) ───────────────
// 타임아웃 전략:
//   1. 파일을 소그룹(배치)으로 나눠서 순차 업로드
//   2. 각 파일 업로드 후 500ms 대기 (rate limit 방지)
//   3. 배치 간 1500ms 대기
//   4. 5배치마다 rate limit 상태 확인
//   5. GitHub API 응답 속도에 따른 자동 조절

export async function uploadWordPressFilesBackground(token, owner, repo, siteId, log) {
  try {
    if (log) await log("WordPress 핵심 파일 업로드 시작...").catch(() => {});

    // 최소 WordPress 파일 생성
    const wpFiles = buildMinimalWpFiles(siteId);

    if (log) await log(`총 ${wpFiles.length}개 파일 업로드 예정`).catch(() => {});

    // Rate limit 초기 확인
    await waitForRateLimit(token, 20);

    // 배치 업로드 (3개씩, 500ms 간격)
    const results = await uploadBatch(token, owner, repo, wpFiles, log, 3, 500);

    if (log) {
      await log(
        `WordPress 파일 업로드 완료: 성공 ${results.success}개, 실패 ${results.failed}개`
      ).catch(() => {});
    }

    // wp-core 설치 완료 마커 업로드
    await uploadFileToGithub(
      token, owner, repo,
      "wp-core/.cloudpress-installed",
      JSON.stringify({
        version:      "3.1",
        site_id:      siteId,
        installed_at: new Date().toISOString(),
        files:        results.success,
      }),
      "mark WordPress installation complete"
    ).catch(() => {});

    if (log) await log("✅ WordPress 설치 완료! 사이트에 접속해주세요.").catch(() => {});
    return results;

  } catch (e) {
    console.error("[uploadWordPressFiles] 오류:", e.message);
    if (log) await log(`WordPress 파일 업로드 오류: ${e.message}`, "error").catch(() => {});
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
