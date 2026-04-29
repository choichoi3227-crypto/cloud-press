// src/index.js (회원가입 부분 발췌)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { email, password } = await request.json();

        if (!email || !password) {
          return new Response(JSON.stringify({ error: "이메일과 비밀번호를 입력해주세요." }), { 
            status: 400, headers: { "Content-Type": "application/json" } 
          });
        }

        // 1. 중복 사용자 체크
        const existingUser = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existingUser) {
          return new Response(JSON.stringify({ error: "이미 가입된 이메일입니다." }), { 
            status: 409, headers: { "Content-Type": "application/json" } 
          });
        }

        // 2. 비밀번호 해싱
        const msgUint8 = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        // 3. 사용자 인서트
        const userId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
        ).bind(userId, email, passwordHash, 'user').run();

        return new Response(JSON.stringify({ success: true, message: "가입이 완료되었습니다." }), { 
          status: 200, headers: { "Content-Type": "application/json" } 
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: "서버 오류: " + e.message }), { 
          status: 500, headers: { "Content-Type": "application/json" } 
        });
      }
    }
    
    // ... 나머지 라우팅 (Login, WP Engine 등)
  }
}
