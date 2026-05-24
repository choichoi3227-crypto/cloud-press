// functions/api/signup.js  →  POST /api/signup
import {
  jsonOk, jsonErr,
  hashPassword, dbGetUserByEmail, dbCreateUser,
  checkBindings, isAdminEmail,
  validateEmail, sanitizeString,
} from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = checkBindings(env, ["DB", "SESSIONS"]);
  if (missing.length) return jsonErr(`바인딩 누락: ${missing.join(", ")}`, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다 (JSON 파싱 실패).", 400); }

  // ── 입력 정제 ──────────────────────────────────────────────────────────────
  const rawEmail    = sanitizeString(body?.email,    254);
  const rawPassword = sanitizeString(body?.password, 200);

  if (!rawEmail || !rawPassword)
    return jsonErr("이메일과 비밀번호를 입력해주세요.", 400);

  // 백엔드 이메일 검증 (프론트 우회 차단)
  if (!validateEmail(rawEmail))
    return jsonErr("올바른 이메일 형식이 아닙니다.", 400);

  if (rawPassword.length < 8)
    return jsonErr("비밀번호는 8자 이상이어야 합니다.", 400);

  try {
    const existing = await dbGetUserByEmail(env.DB, rawEmail);
    if (existing) return jsonErr("이미 사용 중인 이메일입니다.", 409);

    await dbCreateUser(env.DB, {
      id:           crypto.randomUUID(),
      email:        rawEmail,
      passwordHash: await hashPassword(rawPassword),
    });

    return jsonOk({ success: true, message: "회원가입이 완료되었습니다." });
  } catch (e) {
    console.error("[signup]", e);
    return jsonErr("회원가입 처리 중 오류가 발생했습니다.", 500);
  }
}

export const onRequestGet = () => jsonErr("Method Not Allowed", 405);
