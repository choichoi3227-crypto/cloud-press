// functions/api/signup.js  →  POST /api/signup
import { jsonOk, jsonErr, hashPassword, dbGetUserByEmail, dbCreateUser, checkBindings } from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  // DB, SESSIONS만 필수 체크 (CACHE는 선택적)
  const missing = checkBindings(env, ["DB", "SESSIONS"]);
  if (missing.length) return jsonErr(`바인딩 누락: ${missing.join(", ")}`, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다 (JSON 파싱 실패).", 400); }

  const { email, password } = body;
  if (!email || !password)       return jsonErr("이메일과 비밀번호를 입력해주세요.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr("올바른 이메일 형식이 아닙니다.", 400);
  if (password.length < 8)       return jsonErr("비밀번호는 8자 이상이어야 합니다.", 400);

  try {
    const existing = await dbGetUserByEmail(env.DB, email);
    if (existing) return jsonErr("이미 사용 중인 이메일입니다.", 409);

    await dbCreateUser(env.DB, {
      id:           crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role:         "user",
    });

    return jsonOk({ success: true, message: "회원가입이 완료되었습니다." });
  } catch (e) {
    console.error("[signup]", e);
    return jsonErr("회원가입 오류: " + e.message, 500);
  }
}

export const onRequestGet = () => jsonErr("Method Not Allowed", 405);
