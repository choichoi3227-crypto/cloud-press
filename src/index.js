// src/index.js - CloudPress 메인 라우터

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE, PUT",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

async function hashPassword(password) {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function generateJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + 86400, // 24시간
      iat: Math.floor(Date.now() / 1000),
    })
  );
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${data}.${encodedSig}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split(".");
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(sig.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(data)
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS 프리플라이트 처리
    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // D1 바인딩 확인
    if (!env.DB) {
      console.error("[CloudPress] D1 바인딩(DB)이 설정되지 않았습니다. wrangler.toml을 확인하세요.");
    }
    // KV 바인딩 확인
    if (!env.CONFIG_KV) {
      console.error("[CloudPress] KV 바인딩(CONFIG_KV)이 설정되지 않았습니다. wrangler.toml을 확인하세요.");
    }

    // ── 회원가입 ──────────────────────────────────────────────────────────
    if (url.pathname === "/api/signup" && method === "POST") {
      if (!env.DB) {
        return errorResponse("서버 데이터베이스가 연결되지 않았습니다. 관리자에게 문의하세요.", 503);
      }
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return errorResponse("요청 형식이 올바르지 않습니다.", 400);
        }

        const { email, password } = body;
        if (!email || !password) {
          return errorResponse("이메일과 비밀번호를 입력해주세요.", 400);
        }
        if (password.length < 8) {
          return errorResponse("비밀번호는 8자 이상이어야 합니다.", 400);
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        )
          .bind(email.toLowerCase().trim())
          .first();

        if (existing) {
          return errorResponse("이미 사용 중인 이메일입니다.", 409);
        }

        const passwordHash = await hashPassword(password);
        const userId = crypto.randomUUID();

        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
        )
          .bind(userId, email.toLowerCase().trim(), passwordHash, "user")
          .run();

        return jsonResponse({ success: true, message: "회원가입이 완료되었습니다." });
      } catch (e) {
        console.error("[signup] 오류:", e);
        return errorResponse("회원가입 처리 중 오류가 발생했습니다: " + e.message, 500);
      }
    }

    // ── 로그인 ────────────────────────────────────────────────────────────
    if (url.pathname === "/api/login" && method === "POST") {
      if (!env.DB) {
        return errorResponse("서버 데이터베이스가 연결되지 않았습니다.", 503);
      }
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return errorResponse("요청 형식이 올바르지 않습니다.", 400);
        }

        const { email, password } = body;
        if (!email || !password) {
          return errorResponse("이메일과 비밀번호를 입력해주세요.", 400);
        }

        const user = await env.DB.prepare(
          "SELECT id, email, password_hash, role FROM users WHERE email = ?"
        )
          .bind(email.toLowerCase().trim())
          .first();

        if (!user) {
          return errorResponse("이메일 또는 비밀번호가 올바르지 않습니다.", 401);
        }

        const passwordHash = await hashPassword(password);
        if (passwordHash !== user.password_hash) {
          return errorResponse("이메일 또는 비밀번호가 올바르지 않습니다.", 401);
        }

        const secret = env.JWT_SECRET || "cp_secure_secret_key";
        const token = await generateJWT(
          { id: user.id, email: user.email, role: user.role },
          secret
        );

        return jsonResponse({ success: true, token });
      } catch (e) {
        console.error("[login] 오류:", e);
        return errorResponse("로그인 처리 중 오류가 발생했습니다.", 500);
      }
    }

    // ── 현재 사용자 정보 ──────────────────────────────────────────────────
    if (url.pathname === "/api/me" && method === "GET") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return errorResponse("인증이 필요합니다.", 401);
      }
      const token = authHeader.slice(7);
      const secret = env.JWT_SECRET || "cp_secure_secret_key";
      const payload = await verifyJWT(token, secret);
      if (!payload) {
        return errorResponse("유효하지 않거나 만료된 토큰입니다.", 401);
      }
      return jsonResponse({ id: payload.id, email: payload.email, role: payload.role });
    }

    // ── 정적 파일 서빙 (Workers Assets 바인딩) ────────────────────────────
    // HTML, CSS, JS 등 모든 정적 파일을 ASSETS 바인딩을 통해 서빙한다.
    // 덕분에 signup.html / login.html 등이 Worker와 동일 오리진에서 제공되므로
    // fetch('/api/signup') 같은 상대 경로 요청이 정상적으로 이 Worker에 도달한다.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("찾을 수 없습니다.", { status: 404 });
  },
};
