export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS 프리플라이트(OPTIONS) 요청 처리 (필요 시)
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 회원가입 API 처리
    if (url.pathname === "/api/signup") {
      if (method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), { 
          status: 405, 
          headers: { "Content-Type": "application/json" } 
        });
      }

      try {
        const { email, password } = await request.json();
        
        // 이메일 중복 체크
        const existingUser = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (existingUser) {
          return new Response(JSON.stringify({ error: "이미 존재하는 이메일입니다." }), { 
            status: 409, 
            headers: { "Content-Type": "application/json" } 
          });
        }

        // 비밀번호 해싱
        const msgUint8 = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        // DB 저장
        await env.DB.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
          .bind(crypto.randomUUID(), email, passwordHash).run();

        return new Response(JSON.stringify({ success: true }), { 
          status: 200, 
          headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" 
          } 
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Internal Server Error: " + e.message }), { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 그 외 요청은 정적 자산으로 넘기거나 404 처리
    return new Response("Not Found", { status: 404 });
  }
};
