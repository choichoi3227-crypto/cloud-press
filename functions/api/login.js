// functions/api/login.js  →  POST /api/login
import {
  jsonOk, jsonErr,
  hashPassword, generateJWT,
  dbGetUserByEmail, sessionCreate,
  checkBindings,
} from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const missing = checkBindings(env, ["DB", "SESSIONS"]);
  if (missing.length) return jsonErr(`바인딩 누락: ${missing.join(", ")}`, 503);

  let body;
  try { body = await request.json(); }
  catch { return jsonErr("요청 형식이 올바르지 않습니다 (JSON 파싱 실패).", 400); }

  const { email, password } = body;
  if (!email || !password) return jsonErr("이메일과 비밀번호를 입력해주세요.", 400);

  try {
    const user = await dbGetUserByEmail(env.DB, email);
    if (!user) return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

    const hash = await hashPassword(password);
    if (hash !== user.password_hash)
      return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

    const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
    const token  = await generateJWT(
      { id: user.id, email: user.email, role: user.role },
      secret
    );

    await sessionCreate(env.SESSIONS, user.id, user.email, user.role);

    return jsonOk({ success: true, token });
  } catch (e) {
    console.error("[login]", e);
    return jsonErr("로그인 오류: " + e.message, 500);
  }
}

export const onRequestGet = () => jsonErr("Method Not Allowed", 405);
