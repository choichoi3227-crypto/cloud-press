// functions/api/github-storage.js
// GitHub 기반 스토리지 관리 API
// GET  /api/github-storage?action=tokens          → 저장된 토큰 목록 (마스킹)
// POST /api/github-storage?action=add_token       → 토큰 추가
// DELETE /api/github-storage?action=remove_token&id= → 토큰 삭제
// GET  /api/github-storage?action=repo&site_id=   → 사이트 repo 정보

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";

// ── GitHub API 헬퍼 ────────────────────────────────────────────────────────
export async function ghReq(method, path, token, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent":   "CloudPress-Hosting/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ── 사용 가능한 토큰 중 rate limit 여유 있는 것 선택 ─────────────────────
export async function pickGithubToken(env) {
  // DB에서 토큰 목록 가져오기
  let tokens = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, token FROM github_tokens WHERE active = 1 ORDER BY last_used_at ASC"
    ).all();
    tokens = results || [];
  } catch {
    // 테이블 없으면 빈 배열
  }

  // 환경변수 토큰도 포함
  if (env.GITHUB_TOKEN) {
    tokens = [{ id: "env", token: env.GITHUB_TOKEN }, ...tokens];
  }

  if (!tokens.length) return null;

  // Rate limit 확인하며 사용 가능한 토큰 선택
  for (const t of tokens) {
    const { data } = await ghReq("GET", "/rate_limit", t.token);
    const remaining = data?.rate?.remaining ?? 0;
    if (remaining > 10) {
      // 사용 기록
      if (t.id !== "env") {
        await env.DB.prepare(
          "UPDATE github_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(t.id).run().catch(() => {});
      }
      return t.token;
    }
  }

  // 모두 소진 → 첫 번째라도 반환
  return tokens[0]?.token || null;
}

// ── 사이트 repo 이름 생성 ─────────────────────────────────────────────────
export function getRepoName(siteId) {
  const shortId = siteId.replace(/-/g, "").slice(0, 12);
  return `cloudpress-site-${shortId}`;
}

// ── GitHub repo 생성 ──────────────────────────────────────────────────────
export async function createGithubRepo(token, repoName, description) {
  // 먼저 유저 정보 조회
  const { data: user } = await ghReq("GET", "/user", token);
  if (!user?.login) return { error: "GitHub 토큰이 유효하지 않습니다." };

  const owner = user.login;

  // repo 이미 존재하는지 확인
  const { status: checkStatus } = await ghReq("GET", `/repos/${owner}/${repoName}`, token);
  if (checkStatus === 200) {
    return { owner, repoName, exists: true };
  }

  // repo 생성
  const { ok, data } = await ghReq("POST", "/user/repos", token, {
    name:        repoName,
    description: description || `CloudPress WordPress site storage`,
    private:     true,
    auto_init:   true,  // README.md 자동 생성 (커밋 히스토리 초기화)
  });

  if (!ok) {
    return { error: data?.message || "GitHub repo 생성 실패" };
  }

  return { owner, repoName, repoUrl: data.html_url, created: true };
}

// ── 파일 업로드 (GitHub Contents API) ────────────────────────────────────
export async function uploadFileToGithub(token, owner, repo, filePath, content, message) {
  // base64 인코딩
  let base64Content;
  if (typeof content === "string") {
    // 텍스트 → base64
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    base64Content = btoa(String.fromCharCode(...bytes));
  } else if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
    // 바이너리 → base64
    const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content;
    base64Content = btoa(String.fromCharCode(...bytes));
  } else {
    base64Content = content; // 이미 base64
  }

  // 기존 파일 SHA 조회 (업데이트 시 필요)
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

// ── 파일 다운로드 (GitHub Contents API) ──────────────────────────────────
export async function downloadFileFromGithub(token, owner, repo, filePath) {
  const { ok, data } = await ghReq("GET", `/repos/${owner}/${repo}/contents/${filePath}`, token);
  if (!ok || !data?.content) return null;
  // base64 디코드
  const decoded = atob(data.content.replace(/\n/g, ""));
  return decoded;
}

// ── 디렉터리 목록 ─────────────────────────────────────────────────────────
export async function listFilesInGithub(token, owner, repo, dirPath = "") {
  const path = dirPath ? `/repos/${owner}/${repo}/contents/${dirPath}` : `/repos/${owner}/${repo}/contents`;
  const { ok, data } = await ghReq("GET", path, token);
  if (!ok) return [];
  return Array.isArray(data) ? data : [];
}

// ── 대용량 파일 청크 업로드 (타임아웃 방지) ──────────────────────────────
export async function uploadLargeFileChunked(token, owner, repo, filePath, totalChunks, chunkIndex, chunkContent, totalSize) {
  // 청크별로 별도 경로에 저장 후 나중에 합치기
  const chunkPath = `${filePath}.chunk.${String(chunkIndex).padStart(4, "0")}`;
  const result = await uploadFileToGithub(
    token, owner, repo, chunkPath, chunkContent,
    `chunk ${chunkIndex + 1}/${totalChunks} of ${filePath}`
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// API 핸들러
// ─────────────────────────────────────────────────────────────────────────

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

  return jsonErr("action이 필요합니다.", 400);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);
  if (payload.role !== "admin") return jsonErr("관리자 권한이 필요합니다.", 403);

  let body;
  try { body = await request.json(); } catch { return jsonErr("요청 형식 오류", 400); }

  const { token, label } = body;
  if (!token) return jsonErr("GitHub Personal Access Token을 입력해주세요.", 400);

  // 토큰 유효성 검증
  const { ok, data: user } = await ghReq("GET", "/user", token);
  if (!ok || !user?.login) return jsonErr("유효하지 않은 GitHub 토큰입니다. 토큰을 확인해주세요.", 400);

  // 마스킹 (앞 8자 + *** + 뒤 4자)
  const masked = token.length > 12
    ? token.slice(0, 8) + "****" + token.slice(-4)
    : "****";

  try {
    await env.DB.prepare(
      "INSERT INTO github_tokens (token, masked_token, label, active, created_at) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)"
    ).bind(token, masked, label || `@${user.login}`).run();

    return jsonOk({
      success: true,
      message: `GitHub 토큰이 추가되었습니다. (계정: @${user.login})`,
      github_user: user.login,
      masked,
    });
  } catch (e) {
    return jsonErr("토큰 저장 오류: " + e.message, 500);
  }
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
