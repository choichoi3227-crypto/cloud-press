// functions/api/image.js → GET/POST /api/image
// Pages Functions-compatible handler for the AI(flux) + headless-card fallback image API.

import { CORS_HEADERS } from "../../search-core.js";
import { handleImage } from "../../image-core.js";

export async function onRequestGet({ request, env }) {
  return handleImage(request, env);
}

export async function onRequestPost({ request, env }) {
  return handleImage(request, env);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
