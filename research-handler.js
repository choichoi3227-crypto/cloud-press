/**
 * research-handler.js
 * POST /api/research
 * body: { query: string, max_results?: number, country?: string, secret?: string }
 * (WordPress 플러그인 zorlinq32는 body의 "query"와 헤더 X-AIBP-Secret을 함께 보낸다.
 *  기존 groq 기반 검색 그라운딩 Worker의 요청/응답 스펙과 100% 호환되도록 맞췄다.)
 *
 * 응답:
 * {
 *   query, engine: "all", providers: [...],   // /api/search와 동일한 형태(호환용)
 *   summary: "...",                            // 검색 요약 텍스트(그라운딩용)
 *   results: [{title,url,snippet}, ...],       // 평탄화된 검색 결과(그라운딩용)
 *   research: { actual_meaning, visual_context, hero_shot, color_mood,
 *               key_visuals, category, wrong_interpretation, emotional_tone,
 *               text_color_hex, accent_color_hex }
 * }
 */

import { CORS_HEADERS, json, fetchAllEngines } from "./search-core.js";
import { buildRuleBasedResearch, enhanceWithWorkersAI } from "./research-core.js";

function checkSecret(request, env) {
  const required = (env && env.AIBP_SHARED_SECRET) ? String(env.AIBP_SHARED_SECRET) : "";
  if (!required) return true; // Secret 미설정 시 검증 생략(기존 Worker와 동일한 선택적 인증)
  const provided = request.headers.get("X-AIBP-Secret") || "";
  return provided === required;
}

function buildSummary(providers) {
  const lines = [];
  for (const p of providers || []) {
    for (const r of (p.results || []).slice(0, 3)) {
      if (r.title) lines.push(r.title);
    }
  }
  return lines.slice(0, 6).join(" / ");
}

export async function handleResearch(request, env) {
  if (!checkSecret(request, env)) {
    return json({ error: "인증 실패: X-AIBP-Secret이 올바르지 않습니다." }, 401);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }

  const query = String(payload.query || payload.q || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  const maxResults = Math.max(1, Math.min(10, parseInt(payload.max_results, 10) || 8));

  if (!query) {
    return json({ error: "query가 필요합니다.", endpoint: "POST /api/research { query, max_results? }" }, 400);
  }

  const providers = await fetchAllEngines(query, 0, ["google", "naver"]);
  const flatResults = providers.flatMap((p) => p.results || []).slice(0, maxResults);
  const summary = buildSummary(providers);

  const ruleBased = buildRuleBasedResearch(query, providers);
  // Cloudflare AI 바인딩이 있을 때만(그리고 검색 결과가 있을 때만) 아주 짧게 1회 보강 호출.
  // 바인딩이 없으면 즉시 규칙 기반 결과를 그대로 사용 — 기본값은 AI 미사용.
  const research = await enhanceWithWorkersAI(env, query, providers, ruleBased);

  return json({
    query,
    engine: "all",
    providers,
    summary,
    results: flatResults,
    research,
  });
}

export { CORS_HEADERS };
