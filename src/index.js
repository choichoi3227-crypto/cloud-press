import { AuthManager } from './auth.js';
// ... 기존 import 생략 ...

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = request.headers.get("host");

    // 1. 회원가입 API (/api/signup)
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { email, password } = await request.json();
        
        // 중복 이메일 체크
        const existingUser = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existingUser) {
          return new Response(JSON.stringify({ error: "Email already registered" }), { status: 409 });
        }

        const msgUint8 = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)"
        ).bind(crypto.randomUUID(), email, passwordHash).run();

        return new Response(JSON.stringify({ success: true }), { 
          status: 200, 
          headers: { "Content-Type": "application/json" } 
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Signup failed: " + e.message }), { status: 400 });
      }
    }

    // 2. 로그인 API (/api/login)
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { email, password, otp } = await request.json();
      
      const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
      if (!user) return new Response("Invalid credentials", { status: 401 });

      const msgUint8 = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
      const inputHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      if (inputHash === user.password_hash) {
        // 2FA 활성화된 경우 OTP 체크
        if (user.two_factor_secret) {
          const isOTPValid = await AuthManager.verifyOTP(user.two_factor_secret, otp);
          if (!isOTPValid) return new Response("2FA Failed", { status: 401 });
        }

        // JWT 페이로드에 사용자 ID와 이메일 포함
        const token = await AuthManager.generateJWT({ id: user.id, email: user.email, role: user.role || 'user' }, env.JWT_SECRET);
        return new Response(JSON.stringify({ token }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Invalid credentials", { status: 401 });
    }

    // 3. API 보호 미들웨어 (JWT 검증)
    if (url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/api/user/")) {
      const auth = await AuthManager.verifyRequest(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
      
      // JWT 페이로드를 request에 추가하여 하위 핸들러에서 사용 가능하도록
      request.user = auth; 
    }

    // 4. 관리자 API 라우팅
    if (host === env.ADMIN_DOMAIN || url.pathname.startsWith("/api/admin/")) {
      // 관리자 권한 체크 (request.user.role === 'admin') 추가 가능
      return AdminAPI.handle(request, env);
    }

    // 5. 사용자 API 라우팅 (대시보드 기능)
    if (url.pathname.startsWith("/api/user/")) {
      // 예시: 사용자 정보 가져오기
      if (url.pathname === "/api/user/profile" && request.method === "GET") {
        return new Response(JSON.stringify({ email: request.user.email, id: request.user.id }), { headers: { 'Content-Type': 'application/json' } });
      }
      // ... 기타 사용자 API (도메인 추가, SSL 상태 등) ...
    }

    // 6. 워드프레스 엔진 실행
    const site = await env.DB.prepare("SELECT * FROM sites WHERE primary_domain = ?").bind(host).first();
    if (!site) return new Response("Not Found", { status: 404 });

    const wp = new WordPressEngine(env, site);
    return await wp.run(request);
  },

  async scheduled(event, env, ctx) {
    // 5분 주기 자가 치유 및 최적화 크론
    const healer = new AutoHealing(env);
    await healer.monitorAndHeal();
  }
};
