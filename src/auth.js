export class AuthManager {
  static async generateJWT(payload, secret) { /* ... 기존 로직 ... */ }
  static async verifyJWT(token, secret) { /* ... 기존 로직 ... */ }
  static async verifyOTP(secret, code) { /* ... 기존 로직 ... */ }

  static async verifyRequest(request, env) {
    const token = request.headers.get("Authorization")?.split(" ")[1];
    if (!token) return null;
    const secret = env.JWT_SECRET; // wrangler.toml에서 직접 로드
    return await AuthManager.verifyJWT(token, secret);
  }
}
