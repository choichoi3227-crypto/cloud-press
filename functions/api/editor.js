// functions/api/editor.js
// GET  /api/editor/read?path=&site_id=       → 파일 내용 읽기
// POST /api/editor/save                      → 파일 저장 (스냅샷 자동 생성)
// POST /api/editor/analyze-php               → PHP 코드 AI 분석
// GET  /api/editor/snapshots?path=&site_id=  → 스냅샷 목록
// POST /api/editor/rollback                  → 스냅샷으로 롤백

import { jsonOk, jsonErr, requireAuth } from "../_shared.js";
import {
  downloadFileFromGithub,
  uploadFileToGithub,
  pickGithubToken,
} from "./github-storage.js";

// sub-path 추출
function subPath(context) {
  const url = new URL(context.request.url);
  return url.pathname
    .replace(/^.*\/api\/editor\/?/, "")
    .replace(/\?.*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

// ── GET ────────────────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const url     = new URL(request.url);
  const sub     = subPath(context);
  const siteId  = url.searchParams.get("site_id") || "";
  const path    = url.searchParams.get("path") || "";

  // ── GET /api/editor/read ──────────────────────────────────────────────
  if (sub === "read") {
    if (!siteId) return jsonErr("site_id가 필요합니다.", 400);
    if (!path)   return jsonErr("path가 필요합니다.", 400);

    // 사이트 소유권 확인
    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
    ).bind(siteId, payload.id, payload.role).first().catch(() => null);
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    const token = await pickGithubToken(env);
    if (!token) return jsonErr("GitHub 토큰이 설정되지 않았습니다.", 503);

    const owner = site.github_repo_owner;
    const repo  = site.github_repo_name;
    if (!owner || !repo) return jsonErr("GitHub 레포지토리가 연결되지 않았습니다.", 404);

    const content = await downloadFileFromGithub(token, owner, repo, path);
    if (content === null) return jsonErr("파일을 찾을 수 없습니다: " + path, 404);

    return jsonOk({ success: true, content, path });
  }

  // ── GET /api/editor/snapshots ─────────────────────────────────────────
  if (sub === "snapshots") {
    if (!siteId) return jsonErr("site_id가 필요합니다.", 400);
    if (!path)   return jsonErr("path가 필요합니다.", 400);

    const site = await env.DB.prepare(
      "SELECT id FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
    ).bind(siteId, payload.id, payload.role).first().catch(() => null);
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    // editor_snapshots 테이블이 없으면 빈 배열 반환
    const snapshots = await env.DB.prepare(
      "SELECT id, path, created_at FROM editor_snapshots WHERE site_id = ? AND path = ? ORDER BY id DESC LIMIT 20"
    ).bind(siteId, path).all()
      .then(r => r.results || [])
      .catch(() => []);

    return jsonOk({ success: true, snapshots });
  }

  return jsonErr("에디터 경로를 찾을 수 없습니다.", 404);
}

// ── POST ───────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const sub = subPath(context);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  // ── POST /api/editor/save ─────────────────────────────────────────────
  if (sub === "save") {
    const { path, content, site_id } = body;
    if (!path)    return jsonErr("path가 필요합니다.", 400);
    if (!content && content !== "") return jsonErr("content가 필요합니다.", 400);
    if (!site_id) return jsonErr("site_id가 필요합니다.", 400);

    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
    ).bind(site_id, payload.id, payload.role).first().catch(() => null);
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    const token = await pickGithubToken(env);
    if (!token) return jsonErr("GitHub 토큰이 설정되지 않았습니다.", 503);

    const owner = site.github_repo_owner;
    const repo  = site.github_repo_name;
    if (!owner || !repo) return jsonErr("GitHub 레포지토리가 연결되지 않았습니다.", 404);

    // 기존 파일 SHA 조회 (업데이트에 필요)
    let existingSha;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization:          `Bearer ${token}`,
            Accept:                 "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent":           "CloudPress-Editor/1.0",
          },
        }
      );
      if (res.ok) {
        const data = await res.json();
        existingSha = data.sha;

        // 스냅샷 저장 (DB 테이블이 있을 때만)
        const oldContent = atob(data.content.replace(/\n/g, ""));
        await env.DB.prepare(
          `INSERT OR IGNORE INTO editor_snapshots (site_id, path, content, created_at)
           VALUES (?, ?, ?, datetime('now'))`
        ).bind(site_id, path, oldContent).run().catch(() => {});
      }
    } catch { /* 신규 파일인 경우 무시 */ }

    const ok = await uploadFileToGithub(
      token, owner, repo, path, content,
      `Edit ${path} via CloudPress Editor`,
      existingSha
    );

    if (!ok) return jsonErr("파일 저장 실패", 500);

    return jsonOk({ success: true, message: "파일이 저장되고 배포되었습니다." });
  }

  // ── POST /api/editor/analyze-php ─────────────────────────────────────
  if (sub === "analyze-php") {
    const { code } = body;
    if (!code) return jsonOk({ detected: false });

    // 간단한 PHP 8.x 호환성 패턴 검사
    const issues = [];

    const patterns = [
      { re: /\$[a-zA-Z_]\w*\s*=\s*&\s*new\s+/,     msg: "참조 할당(=& new)은 PHP 7+ 에서 제거됨" },
      { re: /split\s*\(/,                              msg: "split() 함수는 PHP 7에서 제거됨 → explode() 사용" },
      { re: /mysql_connect|mysql_query|mysql_fetch/,   msg: "mysql_* 함수는 PHP 7에서 제거됨 → PDO 또는 mysqli 사용" },
      { re: /ereg\s*\(|eregi\s*\(/,                   msg: "ereg/eregi는 PHP 7에서 제거됨 → preg_match() 사용" },
      { re: /\bcreate_function\s*\(/,                  msg: "create_function()은 PHP 7.2+에서 deprecated → 익명 함수 사용" },
      { re: /each\s*\(\s*\$/,                          msg: "each()는 PHP 7.2+에서 deprecated → foreach 사용" },
      { re: /\$HTTP_(GET|POST|SERVER|COOKIE)_VARS/,    msg: "$HTTP_*_VARS는 PHP 5.4+에서 제거됨 → $_GET, $_POST 등 사용" },
      { re: /\bpregmatch\b/,                           msg: "pregmatch → preg_match 확인" },
    ];

    for (const { re, msg } of patterns) {
      if (re.test(code)) issues.push(msg);
    }

    if (issues.length === 0) {
      return jsonOk({ detected: false });
    }

    return jsonOk({
      detected: true,
      diagnosis: issues.join("\n"),
      solution: "위 문제들은 PHP 7/8 호환성 이슈입니다. 각 항목의 대체 함수로 교체하거나 코드를 현대적인 방식으로 리팩토링해주세요.",
    });
  }

  // ── POST /api/editor/rollback ─────────────────────────────────────────
  if (sub === "rollback") {
    const { snapshotId, site_id } = body;
    if (!snapshotId) return jsonErr("snapshotId가 필요합니다.", 400);
    if (!site_id)    return jsonErr("site_id가 필요합니다.", 400);

    const site = await env.DB.prepare(
      "SELECT * FROM sites WHERE id = ? AND (user_id = ? OR ? = 'admin')"
    ).bind(site_id, payload.id, payload.role).first().catch(() => null);
    if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);

    const snapshot = await env.DB.prepare(
      "SELECT * FROM editor_snapshots WHERE id = ? AND site_id = ?"
    ).bind(snapshotId, site_id).first().catch(() => null);
    if (!snapshot) return jsonErr("스냅샷을 찾을 수 없습니다.", 404);

    const token = await pickGithubToken(env);
    if (!token) return jsonErr("GitHub 토큰이 설정되지 않았습니다.", 503);

    const owner = site.github_repo_owner;
    const repo  = site.github_repo_name;
    if (!owner || !repo) return jsonErr("GitHub 레포지토리가 연결되지 않았습니다.", 404);

    // 현재 SHA 조회
    let existingSha;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${snapshot.path}`,
        {
          headers: {
            Authorization:          `Bearer ${token}`,
            Accept:                 "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent":           "CloudPress-Editor/1.0",
          },
        }
      );
      if (res.ok) {
        const data = await res.json();
        existingSha = data.sha;
      }
    } catch { /* 무시 */ }

    const ok = await uploadFileToGithub(
      token, owner, repo, snapshot.path, snapshot.content,
      `Rollback ${snapshot.path} to snapshot #${snapshotId} via CloudPress Editor`,
      existingSha
    );

    if (!ok) return jsonErr("롤백 실패", 500);

    return jsonOk({ success: true, content: snapshot.content, message: "파일이 복원되었습니다." });
  }

  return jsonErr("에디터 경로를 찾을 수 없습니다.", 404);
}
