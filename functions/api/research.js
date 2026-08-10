// functions/api/research.js → POST /api/research
// Pages Functions-compatible handler for the topic-research API used by the
// zorlinq32 WordPress plugin's AI thumbnail feature (replaces the old Groq worker).
// Logic lives in ../../research-handler.js so this stays in sync with worker-search.js.
//
// Optional Cloudflare AI binding: to enable the small optional AI polish step,
// bind Workers AI as `AI` in your Pages project settings (Functions > Bindings).
// Without it, this endpoint still works fully via rule-based research.

import { CORS_HEADERS } from "../../search-core.js";
import { handleResearch } from "../../research-handler.js";

export async function onRequestPost({ request, env }) {
  return handleResearch(request, env);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
