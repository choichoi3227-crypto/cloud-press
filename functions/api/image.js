// functions/api/image.js → GET/POST /api/image
// Pages Functions-compatible handler for the self-contained prompt-to-SVG image API.

import { CORS_HEADERS } from "../../search-core.js";
import { handleImage } from "../../image-core.js";

export async function onRequestGet({ request }) {
  return handleImage(request);
}

export async function onRequestPost({ request }) {
  return handleImage(request);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
