export class AuthManager {
  static async generateJWT(payload, secret) {
    const header = { alg: "HS256", typ: "JWT" };
    // exp, id, email, role 등 포함
    const encodedHeader = btoa(JSON.stringify(header));
    const encodedPayload = btoa(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 }));
    
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  }

  static async verifyJWT(token, secret) { /* ... 기존 로직 ... */ }
  static async verifyOTP(secret, code) { /* ... 기존 로직 ... */ }

  static async verifyRequest(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    
    const token = authHeader.split(" ")[1];
    const secret = env.JWT_SECRET;
    return await AuthManager.verifyJWT(token, secret);
  }
}
