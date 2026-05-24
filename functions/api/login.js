// functions/api/login.js  →  POST /api/login
import {
  jsonOk, jsonErr,
  hashPassword, generateJWT,
  dbGetUserByEmail, sessionCreate,
  checkBindings,
  validateEmail, sanitizeString,
} from "../_shared.js";

// 일정한 시간 응답으로 타이밍 공격 방지
async function constantTimeResponse(successFn, failFn) {
  const minMs = 200;
  const start = Date.now();
  let result;
  try { result = await successFn(); }
  catch (e) { result = { _err: e }; }
  const elapsed = Date.now() - start;
  if (elapsed < minMs) await new Promise(r => setTimeout(r, minMs - elapsed));
  if (result && result._err) throw result._err;
  return result;
}

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

  // 백엔드 이메일 형식 검증 (프론트 우회 공격 차단)
  if (!validateEmail(rawEmail))
    return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

  try {
    const { user, hash } = await constantTimeResponse(async () => {
      const user = await dbGetUserByEmail(env.DB, rawEmail);
      const hash = await hashPassword(rawPassword);
      return { user, hash };
    });

    // 사용자 미존재/비밀번호 불일치 — 동일한 메시지로 enumerate 방지
    if (!user || hash !== user.password_hash)
      return jsonErr("이메일 또는 비밀번호가 올바르지 않습니다.", 401);

    const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
    const jwtToken = await generateJWT(
      { id: user.id, email: user.email, role: user.role },
      secret
    );

    await sessionCreate(env.SESSIONS, user.id, user.email, user.role).catch(() => {});

    return jsonOk({ success: true, token: jwtToken });
  } catch (e) {
    console.error("[login]", e);
    return jsonErr("로그인 처리 중 오류가 발생했습니다.", 500);
  }
}

export const onRequestGet = () => jsonErr("Method Not Allowed", 405);
