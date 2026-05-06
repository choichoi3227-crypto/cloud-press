// functions/api/admin/cms-settings.js
// GET    /api/admin/cms-settings  → CMS 설정 조회 (zip 존재 여부, 레포, 마지막 배포 등)
// POST   /api/admin/cms-settings  → CMS zip 업로드 또는 레포/토큰 저장

import { jsonOk, jsonErr, requireAuth } from "../../_shared.js";

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  if (!payload) return null;
  if (payload.role !== "admin") return null;
  return payload;
}

// ── 테이블 초기화 ─────────────────────────────────────────────────────────
async function ensureTables(env) {
  // CMS 메타데이터 (설정값)
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cms_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `).run().catch(() => {});

  // CMS zip 파일 청크 저장 (D1 blob 한도 ~1MB → 청크 분할)
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cms_zip_chunks (
      chunk_index INTEGER NOT NULL,
      data        TEXT    NOT NULL,
      PRIMARY KEY (chunk_index)
    )
  `).run().catch(() => {});
}

// ── 설정 키/값 헬퍼 ──────────────────────────────────────────────────────
async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM cms_settings WHERE key = ?")
    .bind(key).first().catch(() => null);
  return row?.value ?? null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO cms_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

// ── GET: 설정 조회 ────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  await ensureTables(env);

  const [repo, zipFilename, zipSize, lastDeploy, updatedAt, hasToken] = await Promise.all([
    getSetting(env, "cms_github_repo"),
    getSetting(env, "cms_zip_filename"),
    getSetting(env, "cms_zip_size"),
    getSetting(env, "cms_last_deploy"),
    getSetting(env, "cms_updated_at"),
    getSetting(env, "cms_github_token").then(v => !!v),
  ]);

  // zip 청크가 실제로 있는지 확인
  const chunkCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cms_zip_chunks")
    .first().catch(() => ({ cnt: 0 }));
  const hasZip = (chunkCount?.cnt ?? 0) > 0;

  return jsonOk({
    cms_github_repo: repo,
    has_zip:         hasZip,
    has_token:       hasToken,
    zip_filename:    zipFilename,
    zip_size:        zipSize ? Number(zipSize) : null,
    last_deploy:     lastDeploy,
    updated_at:      updatedAt,
  });
}

// ── POST: zip 업로드 or 설정 저장 ────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const admin = await requireAdmin(request, env);
  if (!admin) return jsonErr("관리자 권한이 필요합니다.", 403);

  await ensureTables(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonErr("요청 본문을 파싱할 수 없습니다.", 400);
  }

  const action = body.action;

  // ── zip 업로드 ──────────────────────────────────────────────────────────
  if (action === "upload_zip") {
    const { filename, size, data } = body;
    if (!filename || !data) return jsonErr("filename과 data가 필요합니다.", 400);
    if (!filename.endsWith(".zip")) return jsonErr("zip 파일만 허용됩니다.", 400);
    if (size > 50 * 1024 * 1024) return jsonErr("파일 크기가 50MB를 초과합니다.", 400);

    // 청크 분할 저장 (D1 단일 row ~900KB 제한 고려 → 500KB 단위로 분할)
    const CHUNK_SIZE = 500_000; // base64 문자 기준 500KB
    const totalChunks = Math.ceil(data.length / CHUNK_SIZE);

    // 기존 청크 삭제
    await env.DB.prepare("DELETE FROM cms_zip_chunks").run().catch(() => {});

    // 청크별 INSERT (배치 처리)
    for (let i = 0; i < totalChunks; i++) {
      const chunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await env.DB.prepare(
        "INSERT INTO cms_zip_chunks (chunk_index, data) VALUES (?, ?)"
      ).bind(i, chunk).run();
    }

    // 메타데이터 저장
    const now = new Date().toISOString();
    await setSetting(env, "cms_zip_filename", filename);
    await setSetting(env, "cms_zip_size",     String(size));
    await setSetting(env, "cms_updated_at",   now);

    return jsonOk({
      message:      `CMS zip 업로드 완료 (${totalChunks}개 청크)`,
      filename,
      size,
      chunks:       totalChunks,
      uploaded_at:  now,
    });
  }

  // ── 레포 / 토큰 저장 ───────────────────────────────────────────────────
  if (action === "save_repo") {
    const saved = [];

    if (body.cms_github_repo) {
      const repo = String(body.cms_github_repo).trim();
      if (!repo.includes("/")) return jsonErr("레포 형식이 올바르지 않습니다. (owner/repo)", 400);
      await setSetting(env, "cms_github_repo", repo);
      saved.push("cms_github_repo");
    }

    if (body.cms_github_token) {
      const tok = String(body.cms_github_token).trim();
      if (!tok.startsWith("ghp_") && !tok.startsWith("github_pat_") && !tok.startsWith("gho_")) {
        return jsonErr("올바른 GitHub 토큰 형식이 아닙니다.", 400);
      }
      await setSetting(env, "cms_github_token", tok);
      saved.push("cms_github_token");
    }

    if (!saved.length) return jsonErr("저장할 항목이 없습니다.", 400);

    await setSetting(env, "cms_updated_at", new Date().toISOString());

    return jsonOk({ message: `${saved.length}개 항목이 저장되었습니다.`, saved });
  }

  return jsonErr("알 수 없는 action입니다.", 400);
}

// ── OPTIONS (CORS) ────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// ── 내부 헬퍼: CMS zip base64 전체 조합 (sites.js에서 import해서 사용) ──
// zip 청크를 순서대로 읽어서 하나의 base64 문자열로 반환합니다.
export async function getCmsZipBase64(env) {
  const { results } = await env.DB.prepare(
    "SELECT chunk_index, data FROM cms_zip_chunks ORDER BY chunk_index ASC"
  ).all();
  if (!results || results.length === 0) return null;
  return results.map(r => r.data).join("");
}
