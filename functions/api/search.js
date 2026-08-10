// functions/api/search.js → GET /api/search
// Pages Functions-compatible handler for the Cloudflare search API.
// Logic lives in ../../search-core.js so this stays in sync with worker-search.js.

import { CORS_HEADERS, handleSearch } from "../../search-core.js";

export async function onRequestGet({ request }) {
  return handleSearch(request);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
