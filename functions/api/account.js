// functions/api/account.js
// GET  /api/account           → 내 계정 정보 조회
// PUT  /api/account           → CF API 키 + 이메일 저장
// POST /api/account           → 비밀번호 변경 (sub: "password")
// POST /api/account/password  → 비밀번호 변경 (직접 경로)

import {
  jsonOk, jsonErr, requireAuth,
  dbGetUserById, dbUpdateUserCfKey, fetchCfAccountInfo,
  hashPassword,
} from "../_shared.js";

function getSubPath(request) {
  const url = new URL(request.url);
  return url.pathname
    .replace(/^.*\/api\/account\/?/, "")
    .replace(/\?.*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

// ── GET /api/account ─────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  try {
    const user = await dbGetUserById(env.DB, payload.id);
    if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);
    return jsonOk({
      id:          user.id,
      email:       user.email,
      role:        user.role,
      plan:        user.plan || "free",
      hasCfKey:      !!user.cf_global_api_key,
      cfEmail:       user.cf_email      || "",
      cfAccountId:   user.cf_account_id || "",
      cfAccountName: user.cf_account_name || "",
    });
  } catch (e) {
    return jsonErr("계정 조회 오류: " + e.message, 500);
  }
}

// ── PUT /api/account → CF API 키 저장 ────────────────────────────────────────
export async function onRequestPut(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

  const { cf_api_key, cf_email } = body;
  if (!cf_api_key) return jsonErr("API 키를 입력해주세요.", 400);
  // cf_email은 Global API Key 방식일 때만 필수, API Token 방식은 선택
  if (cf_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cf_email))
    return jsonErr("올바른 이메일 형식이 아닙니다.", 400);

  // CF API로 검증 + Account ID 자동 수집
  const cfInfo = await fetchCfAccountInfo(cf_api_key, cf_email || null);
  if (!cfInfo.valid)
    return jsonErr("Cloudflare API 키 또는 이메일이 올바르지 않습니다. 키를 다시 확인해주세요.", 400);

  try {
    // 이메일은 CF에서 가져온 값 우선 사용
    const resolvedEmail = cfInfo.userEmail || cf_email || "";
    await dbUpdateUserCfKey(env.DB, payload.id, cf_api_key, resolvedEmail, cfInfo.accountId, cfInfo.accountName);
    return jsonOk({
      success:     true,
      message:     "Cloudflare 계정이 연동되었습니다.",
      accountId:   cfInfo.accountId,
      accountName: cfInfo.accountName,
      userEmail:   resolvedEmail,
      authType:    cfInfo.authType,
    });
  } catch (e) {
    return jsonErr("저장 오류: " + e.message, 500);
  }
}

// ── POST /api/account  또는  /api/account/password ───────────────────────────
// account.html은 fetch('/api/account/password', { method:'POST' })로 호출함.
// CF Pages Functions는 account.js가 /api/account 만 담당하므로
// sub-path를 직접 파싱해서 처리한다.
export async function onRequestPost(context) {
  const { request, env } = context;
  const payload = await requireAuth(request, env);
  if (!payload) return jsonErr("인증이 필요합니다.", 401);

  const sub = getSubPath(request);

  // POST /api/account/password
  if (sub === "password" || sub === "") {
    let body;
    try { body = await request.json(); }
    catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }

    const { current_password, new_password } = body;
    if (!current_password) return jsonErr("현재 비밀번호를 입력해주세요.", 400);
    if (!new_password)      return jsonErr("새 비밀번호를 입력해주세요.", 400);
    if (new_password.length < 8)
      return jsonErr("새 비밀번호는 8자 이상이어야 합니다.", 400);

    try {
      const user = await env.DB.prepare(
        "SELECT id, password_hash FROM users WHERE id = ?"
      ).bind(payload.id).first();
      if (!user) return jsonErr("사용자를 찾을 수 없습니다.", 404);

      const currentHash = await hashPassword(current_password);
      if (user.password_hash !== currentHash)
        return jsonErr("현재 비밀번호가 올바르지 않습니다.", 400);

      const newHash = await hashPassword(new_password);
      await env.DB.prepare(
        "UPDATE users SET password_hash = ? WHERE id = ?"
      ).bind(newHash, payload.id).run();

      return jsonOk({ success: true, message: "비밀번호가 변경되었습니다." });
    } catch (e) {
      return jsonErr("비밀번호 변경 오류: " + e.message, 500);
    }
  }

  return jsonErr("알 수 없는 경로입니다.", 404);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
