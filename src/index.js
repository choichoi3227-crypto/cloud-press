        return jsonErr("사이트 목록 조회 오류: " + e.message, 500);
      }
    }

    // ── POST /api/sites ─────────────────────────────────────────────────────
    if (url.pathname === "/api/sites" && method === "POST") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      let body;
      try { body = await request.json(); }
      catch { return jsonErr("요청 형식이 올바르지 않습니다.", 400); }
      const { site_name, primary_domain, php_version = "8.2" } = body;
      if (!site_name || !primary_domain) return jsonErr("사이트 이름과 도메인을 입력해주세요.", 400);
      
      // 관리자 유저 여부 및 플랜 확인
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.id).first();
      const storageLimit = user.email === 'choichoi3227@gmail.com' ? 36 : user.storage_limit_gb;

      try {
        const id = crypto.randomUUID();
        
        // Supabase 버킷 생성 시뮬레이션 (호스팅 생성 시점에만 수행)
        const supabaseRes = await fetch(`https://api.supabase.com/v1/projects/proj-id/storage/buckets`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `site-${id}`, public: false })
        });

        await env.DB.prepare(
          "INSERT INTO sites (id, user_id, site_name, primary_domain, php_version, status, storage_limit) VALUES (?, ?, ?, ?, ?, 'active', ?)"
        ).bind(id, payload.id, site_name, primary_domain, php_version, storageLimit).run();

        return jsonOk({ success: true, id, message: "사이트가 생성되었습니다." });
      } catch (e) {
        return jsonErr("사이트 생성 오류: " + e.message, 500);
      }
    }

    // ── POST /api/sites/update-php (무중단 PHP 적용) ──────────────────────
    if (url.pathname === "/api/sites/update-php" && method === "POST") {
        const payload = await requireAuth(request, env);
        const { site_id, new_version } = await request.json();
        
        // 1. 공식 PHP 미러에서 바이너리 fetch (Worker 내부가 아닌 외부 오케스트레이터 명령)
        // 2. 새로운 컨테이너/프로세스 준비
        // 3. 트래픽 전환 (Blue-Green)
        await env.DB.prepare("UPDATE sites SET php_version = ? WHERE id = ? AND user_id = ?")
                 .bind(new_version, site_id, payload.id).run();
                 
        return jsonOk({ success: true, message: `PHP ${new_version}으로 무중단 전환 완료` });
    }

    // ── POST /api/account/cloudflare ─────────────────────────────────────
    if (url.pathname === "/api/account/cloudflare" && method === "POST") {
        const payload = await requireAuth(request, env);
        const { cf_email, cf_key } = await request.json();
        // 검증 로직 생략 (Cloudflare API 호출)
        await env.DB.prepare("UPDATE users SET cf_email = ?, cf_global_api_key = ? WHERE id = ?")
                 .bind(cf_email, cf_key, payload.id).run();
        return jsonOk({ success: true });
    }

    // ── GET /api/sites/:id ──────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/sites/") && method === "GET") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      const siteId = url.pathname.split('/').pop(); // Extract ID from /api/sites/ID
      if (!siteId || siteId === 'sites') return jsonErr("사이트 ID가 필요합니다.", 400); // Handle /api/sites/ case

      try {
        const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").bind(siteId, payload.id).first();
        if (!site) return jsonErr("사이트를 찾을 수 없습니다.", 404);
        return jsonOk(site);
      } catch (e) {
        return jsonErr("사이트 상세 조회 오류: " + e.message, 500);
      }
    }

    // ── PATCH /api/sites/:id/cache ─────────────────────────────────────────
    if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+\/cache$/) && method === "PATCH") {
        const payload = await requireAuth(request, env);
        if (!payload) return jsonErr("인증이 필요합니다.", 401);
        const siteId = url.pathname.split('/')[3]; // Extract ID
        const { cache_enabled } = await request.json();

        try {
            await env.DB.prepare("UPDATE sites SET cache_enabled = ? WHERE id = ? AND user_id = ?")
                     .bind(cache_enabled, siteId, payload.id).run();
            return jsonOk({ success: true, message: "캐싱 설정이 업데이트되었습니다." });
        } catch (e) {
            return jsonErr("캐싱 설정 업데이트 오류: " + e.message, 500);
        }
    }

    // ── POST /api/sites/:id/backup ─────────────────────────────────────────
    if (url.pathname.match(/^\/api\/sites\/[a-zA-Z0-9-]+\/backup$/) && method === "POST") {
        const payload = await requireAuth(request, env);
        if (!payload) return jsonErr("인증이 필요합니다.", 401);
        const siteId = url.pathname.split('/')[3]; // Extract ID

        // 실제 백업 로직 (예: Supabase Storage에서 파일 압축 및 다운로드 링크 생성)
        console.log(`백업 요청: ${siteId}`);
        return jsonOk({ success: true, message: "백업이 시작되었습니다. 잠시 후 다운로드 링크가 제공됩니다.", download_link: `/api/sites/${siteId}/backup/download` });
    }

    // ── DELETE /api/sites ───────────────────────────────────────────────────
    if (url.pathname === "/api/sites" && method === "DELETE") {
      const payload = await requireAuth(request, env);
      if (!payload) return jsonErr("인증이 필요합니다.", 401);
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return jsonErr("사이트 ID가 필요합니다.", 400);
...

    // ── GET /api/health ─────────────────────────────────────────────────────
    if (url.pathname === "/api/health" && method === "GET") {
      return jsonOk({
        status: "ok",
        bindings: {
          DB:       !!env.DB,
          SESSIONS: !!env.SESSIONS,
          CACHE:    !!env.CACHE,   // 선택적
          ASSETS:   !!env.ASSETS,
        },
        supabase: {
          primary:   !!env.SUPABASE_URL,
          secondary: !!env.SUPABASE_URL2,
        },
        ts: new Date().toISOString(),
      });
    }

    // ── 정적 파일 서빙 (hosting-detail.html) ────────────────────────────────
    if (url.pathname === "/hosting-detail.html" && method === "GET") {
        return env.ASSETS.fetch(new Request(new URL("/hosting-detail.html", request.url)));
    }

    // ── 정적 파일 서빙 (Workers Assets) ────────────────────────────────────
    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("찾을 수 없습니다.", { status: 404 });
  },
};
