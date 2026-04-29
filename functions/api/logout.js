// functions/api/logout.js  →  POST /api/logout
import { jsonOk, sessionDelete } from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ") && env.SESSIONS) {
    await sessionDelete(env.SESSIONS, authHeader.slice(7));
  }
  return jsonOk({ success: true });
}
