export async function makeCacheKey(endpoint: string, body: unknown): Promise<string> {
  const data = new TextEncoder().encode(endpoint + JSON.stringify(body));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `cache:${hex}`;
}
