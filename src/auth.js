// src/auth.js — JWT 유틸리티 (클라이언트 번들에서도 사용 가능한 순수 함수)

function padBase64(s) {
  return s + "=".repeat((4 - s.length % 4) % 4);
}

export class AuthManager {
  // JWT 생성 (HS256, URL-safe base64)
  static async generateJWT(payload, secret) {
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const body = btoa(JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const encodedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    return `${data}.${encodedSig}`;
  }

  // JWT 검증 (만료 체크 포함)
  static async verifyJWT(token, secret) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [header, body, sig] = parts;
      const data = `${header}.${body}`;
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
      );
      const sigBytes = Uint8Array.from(
        atob(padBase64(sig.replace(/-/g, "+").replace(/_/g, "/"))),
        c => c.charCodeAt(0)
      );
      const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
      if (!valid) return null;
      const payload = JSON.parse(atob(padBase64(body.replace(/-/g, "+").replace(/_/g, "/"))));
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch { return null; }
  }

  // 요청의 Authorization 헤더에서 JWT 검증
  static async verifyRequest(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token  = authHeader.slice(7);
    const secret = env.JWT_SECRET || "cp_dev_secret_change_me";
    return await AuthManager.verifyJWT(token, secret);
  }
}
