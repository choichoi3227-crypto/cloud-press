// functions/api/health.js  →  GET /api/health
// 바인딩/Supabase 연결 상태를 한눈에 확인
import { jsonOk } from "../_shared.js";

export async function onRequestGet(context) {
  const { env } = context;
  return jsonOk({
    status: "ok",
    bindings: {
      DB:       !!env.DB,
      SESSIONS: !!env.SESSIONS,
      CACHE:    !!env.CACHE,
    },
    secrets: {
      JWT_SECRET:    !!env.JWT_SECRET,
      SUPABASE_URL:  !!env.SUPABASE_URL,
      SUPABASE_URL2: !!env.SUPABASE_URL2,
      PURGE_KEY:     !!env.PURGE_KEY,
      ENCRYPTION_KEY:!!env.ENCRYPTION_KEY,
    },
    ts: new Date().toISOString(),
  });
}
