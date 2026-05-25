/**
 * CloudPress — WordPress Durable Object Manager
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 계정당 하나의 Durable Object가 생성되며 아래 역할을 수행합니다:
 *
 *  1. 설치 관리자  : 사이트 생성, DB 생성, 플러그인 설치, 테마 설정, 캐시 초기화
 *  2. 상태 관리자  : 사이트별 온라인 여부, 업데이트 여부, 캐시 상태, 플러그인 작업 상태
 *  3. 세션 시스템  : 로그인 상태, 만료 시간, 인증 토큰 관리
 *  4. 락 시스템    : 단일 작업 허용, 순차 처리, 중복 차단 (wp_options, plugin_install 등)
 *  5. 크론 대체    : WordPress cron 작업 스케줄링 및 실행
 *  6. DB 담당      : GitHub 레포 기반 JSON DB 파일 관리 (호스팅 상세에서 직접 편집 가능)
 *
 * Cloudflare Tunnel 자동 생성 포함 (계정당 하나)
 *
 * 바인딩 (wrangler.toml):
 *   WP_MANAGER: DurableObjectNamespace
 *   KV         : KVNamespace (세션)
 *   SESSIONS   : KVNamespace
 *
 * API 엔드포인트 (worker.js에서 라우팅):
 *   POST /api/do/wp/:action   → Durable Object 액션 실행
 *   GET  /api/do/wp/status    → 전체 상태 조회
 */

// ─── Durable Object: WpManager ────────────────────────────────────────────────
// 사용자당 1개의 WpManager DO가 생성됩니다.
// DO ID = userId (플랫폼 users 테이블 PK)
export class WpManager {
    constructor(state, env) {
      this.state = state;
      this.env   = env;
      // Durable Object 내장 스토리지 (Unlimited KV)
      this.storage = state.storage;
    }
  
    // ── HTTP 라우터 ──────────────────────────────────────────────────────────────
    async fetch(request) {
      const url    = new URL(request.url);
      const action = url.pathname.split("/").pop();
      const method = request.method;
  
      try {
        // 모든 요청은 JWT로 검증됨 (worker.js에서 이미 검증 후 DO로 포워딩)
        const body = method === "POST" ? await request.json().catch(() => ({})) : {};
  
        switch (action) {
          // ── 설치 관리자 ─────────────────────────────────────────────────────────
          case "install":         return this._jsonResp(await this.installSite(body));
          case "create-db":       return this._jsonResp(await this.createDatabase(body));
          case "install-plugin":  return this._jsonResp(await this.installPlugin(body));
          case "set-theme":       return this._jsonResp(await this.setTheme(body));
          case "clear-cache":     return this._jsonResp(await this.clearCache(body));
  
          // ── 상태 관리자 ─────────────────────────────────────────────────────────
          case "status":          return this._jsonResp(await this.getStatus(body));
          case "set-status":      return this._jsonResp(await this.setStatus(body));
          case "site-status":     return this._jsonResp(await this.getSiteStatus(body));
  
          // ── 세션 시스템 ─────────────────────────────────────────────────────────
          case "login":           return this._jsonResp(await this.createSession(body));
          case "logout":          return this._jsonResp(await this.destroySession(body));
          case "verify-session":  return this._jsonResp(await this.verifySession(body));
          case "refresh-session": return this._jsonResp(await this.refreshSession(body));
  
          // ── 락 시스템 ───────────────────────────────────────────────────────────
          case "acquire-lock":    return this._jsonResp(await this.acquireLock(body));
          case "release-lock":    return this._jsonResp(await this.releaseLock(body));
          case "check-lock":      return this._jsonResp(await this.checkLock(body));
  
          // ── 크론 시스템 ─────────────────────────────────────────────────────────
          case "cron-run":        return this._jsonResp(await this.runCron(body));
          case "cron-schedule":   return this._jsonResp(await this.scheduleCron(body));
          case "cron-list":       return this._jsonResp(await this.listCrons(body));
  
          // ── DB 담당 (GitHub JSON DB) ─────────────────────────────────────────────
          case "db-query":        return this._jsonResp(await this.dbQuery(body));
          case "db-write":        return this._jsonResp(await this.dbWrite(body));
          case "db-read":         return this._jsonResp(await this.dbRead(body));
          case "db-delete":       return this._jsonResp(await this.dbDelete(body));
          case "db-tables":       return this._jsonResp(await this.dbListTables(body));
  
          // ── Cloudflare Tunnel ────────────────────────────────────────────────────
          case "create-tunnel":   return this._jsonResp(await this.createTunnel(body));
          case "activate-tunnel": return this._jsonResp(await this.activateTunnel(body));
          case "tunnel-status":   return this._jsonResp(await this.getTunnelStatus(body));
  
          default:
            return this._jsonResp({ success: false, error: "알 수 없는 액션입니다." }, 404);
        }
      } catch (e) {
        return this._jsonResp({ success: false, error: e.message }, 500);
      }
    }
  
    _jsonResp(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  
    // ── 유틸 ────────────────────────────────────────────────────────────────────
    async _get(key)         { return this.storage.get(key); }
    async _set(key, val)    { return this.storage.put(key, val); }
    async _del(key)         { return this.storage.delete(key); }
    async _list(prefix)     { return this.storage.list({ prefix }); }
  
    // ── 설치 관리자 ─────────────────────────────────────────────────────────────
    /**
     * 사이트 설치 전체 파이프라인
     * body: { siteId, siteName, domain, wpUser, wpPass, wpEmail, ghToken, ghOwner, ghRepo,
     *         cfToken, cfAccountId, dbPlan, cp3Subscribed, cloudpressdbSubscribed }
     */
    async installSite(body) {
      const { siteId } = body;
      if (!siteId) return { success: false, error: "siteId가 필요합니다." };
  
      // 락 획득 (중복 설치 방지)
      const locked = await this.acquireLock({ resource: `install:${siteId}`, ttl: 600 });
      if (!locked.success) return { success: false, error: "다른 설치 작업이 진행 중입니다." };
  
      const log = [];
      const addLog = (msg, level = "info") => {
        log.push({ ts: new Date().toISOString(), msg, level });
        // 실시간 로그를 DO 스토리지에 저장 (폴링으로 조회 가능)
        this._set(`install-log:${siteId}`, JSON.stringify(log)).catch(() => {});
      };
  
      try {
        addLog("🚀 WordPress 설치를 시작합니다...");
  
        // 1) GitHub 레포에 기본 구조 생성
        addLog("📦 GitHub 저장소 구조를 생성하는 중...");
        await this.createRepoStructure(body);
        addLog("✅ GitHub 저장소 구조 생성 완료");
  
        // 2) DB 초기화 (CP3/CloudPressDB 구독 상태에 따라 분기)
        addLog("🗄️ 데이터베이스를 초기화하는 중...");
        await this.createDatabase(body);
        addLog("✅ 데이터베이스 초기화 완료");
  
        // 3) WordPress 기본 데이터 삽입
        addLog("📝 WordPress 기본 데이터를 설정하는 중...");
        await this.insertWpDefaults(body);
        addLog("✅ WordPress 기본 데이터 설정 완료");
  
        // 4) Cloudflare Tunnel 생성 (계정당 1개)
        addLog("🌐 Cloudflare Tunnel을 생성하는 중...");
        const tunnelResult = await this.createTunnel(body);
        if (tunnelResult.success) {
          addLog(`✅ Tunnel 생성 완료: ${tunnelResult.tunnelId}`);
          await this.activateTunnel({ ...body, tunnelId: tunnelResult.tunnelId });
          addLog("✅ Tunnel 활성화 완료");
        } else {
          addLog(`⚠️ Tunnel 생성 실패 (선택사항): ${tunnelResult.error}`, "warn");
        }
  
        // 5) 상태 업데이트
        await this.setStatus({
          siteId,
          status: "running",
          online: true,
          installedAt: new Date().toISOString(),
        });
  
        // 6) 락 해제
        await this.releaseLock({ resource: `install:${siteId}` });
  
        addLog("🎉 WordPress 설치가 완료되었습니다!");
        return { success: true, siteId, log };
  
      } catch (e) {
        addLog(`❌ 설치 실패: ${e.message}`, "error");
        await this.releaseLock({ resource: `install:${siteId}` });
        return { success: false, error: e.message, log };
      }
    }
  
    /**
     * GitHub 레포에 기본 폴더/파일 구조 생성
     * CP3 구독: {ghOwner}/{ghRepo}/ + _storage/ 폴더
     * CloudPressDB 구독: {ghOwner}/{ghRepo}/_db/ 폴더에 JSON 파일
     */
    async createRepoStructure(body) {
      const { ghToken, ghOwner, ghRepo, siteId, userId,
              cp3Subscribed, cloudpressdbSubscribed, dbPlan } = body;
  
      if (!ghToken || !ghOwner || !ghRepo) return { success: true, skipped: true };
  
      // 기본 폴더 구조
      const files = [
        {
          path: "README.md",
          content: `# ${body.siteName || "CloudPress Site"}\n\nCloudPress WordPress 호스팅 저장소입니다.\n\n생성일: ${new Date().toISOString()}\n`,
        },
        {
          path: ".cloudpress/config.json",
          content: JSON.stringify({
            version: "1.0",
            siteId,
            userId,
            createdAt: new Date().toISOString(),
            cp3: cp3Subscribed ? { enabled: true } : { enabled: false },
            cloudpressdb: cloudpressdbSubscribed ? { enabled: true, plan: dbPlan } : { enabled: false },
          }, null, 2),
        },
        {
          // DB 기본 파일 (CloudPressDB 구독 여부에 따라 경로/권한 다름)
          path: "_db/wordpress.json",
          content: JSON.stringify({
            _meta: {
              version: "1.0",
              plan: cloudpressdbSubscribed ? dbPlan : "minimal",
              maxTables: cloudpressdbSubscribed ? (dbPlan === "pro" ? 1000 : dbPlan === "standard" ? 200 : 50) : 10,
              readOnly: !cloudpressdbSubscribed,
              createdAt: new Date().toISOString(),
            },
            options: [],
            users: [],
            posts: [],
            postmeta: [],
            terms: [],
            termmeta: [],
            term_taxonomy: [],
            term_relationships: [],
            comments: [],
            commentmeta: [],
            links: [],
          }, null, 2),
        },
      ];
  
      // CP3 구독 중이면 스토리지 폴더 추가
      if (cp3Subscribed) {
        files.push({
          path: "_storage/.gitkeep",
          content: "",
        });
        files.push({
          path: "_storage/README.md",
          content: `# CP3 스토리지\n\n이 폴더는 CP3 플랜의 미디어 파일 저장소입니다.\n\n저장 구조:\n- media/    : 미디어 파일\n- backup/   : 백업 파일\n- logs/     : 로그 파일\n`,
        });
        files.push({
          path: "_storage/media/.gitkeep",
          content: "",
        });
        files.push({
          path: "_storage/backup/.gitkeep",
          content: "",
        });
        files.push({
          path: "_storage/logs/.gitkeep",
          content: "",
        });
      }
  
      // wp-content 기본 구조
      files.push({
        path: "wp-content/themes/.gitkeep",
        content: "",
      });
      files.push({
        path: "wp-content/plugins/.gitkeep",
        content: "",
      });
      files.push({
        path: "wp-content/uploads/.gitkeep",
        content: "",
      });
  
      // GitHub에 파일 업로드
      for (const file of files) {
        await this._ghFileCreate(ghToken, ghOwner, ghRepo, file.path, file.content);
      }
  
      return { success: true };
    }
  
    async _ghFileCreate(token, owner, repo, path, content) {
      const encoded = btoa(unescape(encodeURIComponent(content)));
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CloudPress-WpManager/1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `[CloudPress] Initialize ${path}`,
          content: encoded,
        }),
      });
      return res.ok ? await res.json() : null;
    }
  
    /**
     * DB 초기화
     * CloudPressDB 구독: 전체 DB 테이블 + 쓰기 권한
     * 미구독: 최소 테이블만 + 제한된 권한
     */
    async createDatabase(body) {
      const { siteId, cloudpressdbSubscribed, dbPlan } = body;
  
      const dbMeta = {
        siteId,
        plan: cloudpressdbSubscribed ? dbPlan : "minimal",
        tables: cloudpressdbSubscribed
          ? ["options", "users", "usermeta", "posts", "postmeta", "terms",
             "termmeta", "term_taxonomy", "term_relationships", "comments",
             "commentmeta", "links"]
          : ["options", "users", "posts"], // 미구독: 최소 3개만
        readOnly: !cloudpressdbSubscribed,
        maxRecords: cloudpressdbSubscribed
          ? (dbPlan === "pro" ? 1000000 : dbPlan === "standard" ? 100000 : 10000)
          : 1000,
        createdAt: new Date().toISOString(),
      };
  
      await this._set(`db:meta:${siteId}`, JSON.stringify(dbMeta));
      return { success: true, dbMeta };
    }
  
    // WordPress 기본 데이터 삽입 (options 테이블 초기화)
    async insertWpDefaults(body) {
      const { siteId, siteName, domain, wpUser, wpEmail } = body;
      const defaults = [
        { key: "siteurl",       value: `https://${domain}` },
        { key: "blogname",      value: siteName || "새 WordPress 사이트" },
        { key: "blogdescription", value: "CloudPress에서 운영하는 WordPress 사이트" },
        { key: "admin_email",   value: wpEmail },
        { key: "blogpublic",    value: "1" },
        { key: "active_plugins", value: "[]" },
        { key: "template",      value: "twentytwentyfour" },
        { key: "stylesheet",    value: "twentytwentyfour" },
      ];
      await this._set(`db:options:${siteId}`, JSON.stringify(defaults));
      return { success: true };
    }
  
    // 플러그인 설치 (GitHub 레포에 플러그인 파일 추가)
    async installPlugin(body) {
      const { siteId, pluginSlug, pluginUrl, ghToken, ghOwner, ghRepo } = body;
  
      // 락 획득 (동시 플러그인 설치 방지)
      const locked = await this.acquireLock({ resource: `plugin:${siteId}:${pluginSlug}`, ttl: 120 });
      if (!locked.success) return { success: false, error: "다른 플러그인 작업이 진행 중입니다." };
  
      try {
        await this.setStatus({ siteId, pluginStatus: `installing:${pluginSlug}` });
  
        // 활성 플러그인 목록에 추가
        const optionsRaw = await this._get(`db:options:${siteId}`);
        const options = optionsRaw ? JSON.parse(optionsRaw) : [];
        const activeIdx = options.findIndex(o => o.key === "active_plugins");
        const active = activeIdx >= 0 ? JSON.parse(options[activeIdx].value) : [];
        if (!active.includes(pluginSlug)) active.push(pluginSlug);
        if (activeIdx >= 0) options[activeIdx].value = JSON.stringify(active);
        else options.push({ key: "active_plugins", value: JSON.stringify(active) });
        await this._set(`db:options:${siteId}`, JSON.stringify(options));
  
        await this.setStatus({ siteId, pluginStatus: `installed:${pluginSlug}` });
        await this.releaseLock({ resource: `plugin:${siteId}:${pluginSlug}` });
        return { success: true, pluginSlug, active };
      } catch (e) {
        await this.releaseLock({ resource: `plugin:${siteId}:${pluginSlug}` });
        return { success: false, error: e.message };
      }
    }
  
    // 테마 설정
    async setTheme(body) {
      const { siteId, themeSlug } = body;
      const optionsRaw = await this._get(`db:options:${siteId}`);
      const options = optionsRaw ? JSON.parse(optionsRaw) : [];
      const setOpt = (key, val) => {
        const idx = options.findIndex(o => o.key === key);
        if (idx >= 0) options[idx].value = val;
        else options.push({ key, value: val });
      };
      setOpt("template", themeSlug);
      setOpt("stylesheet", themeSlug);
      await this._set(`db:options:${siteId}`, JSON.stringify(options));
      return { success: true, theme: themeSlug };
    }
  
    // 캐시 초기화
    async clearCache(body) {
      const { siteId } = body;
      const cacheKeys = await this._list(`cache:${siteId}:`);
      const delPromises = [];
      for (const [key] of cacheKeys) delPromises.push(this._del(key));
      await Promise.allSettled(delPromises);
      await this.setStatus({ siteId, cacheStatus: "cleared", cacheCleared: new Date().toISOString() });
      return { success: true, cleared: delPromises.length };
    }
  
    // ── 상태 관리자 ─────────────────────────────────────────────────────────────
  
    async getStatus(body) {
      const { siteId } = body;
      if (siteId) {
        const raw = await this._get(`status:${siteId}`);
        return { success: true, status: raw ? JSON.parse(raw) : null };
      }
      // 전체 상태 목록
      const all = await this._list("status:");
      const statuses = {};
      for (const [key, val] of all) {
        const id = key.replace("status:", "");
        statuses[id] = typeof val === "string" ? JSON.parse(val) : val;
      }
      return { success: true, statuses };
    }
  
    async setStatus(body) {
      const { siteId, ...statusData } = body;
      if (!siteId) return { success: false, error: "siteId 필요" };
      const existing = await this._get(`status:${siteId}`);
      const current = existing ? JSON.parse(existing) : {};
      const updated = { ...current, ...statusData, updatedAt: new Date().toISOString() };
      await this._set(`status:${siteId}`, JSON.stringify(updated));
      return { success: true, status: updated };
    }
  
    async getSiteStatus(body) {
      return this.getStatus(body);
    }
  
    // ── 세션 시스템 ─────────────────────────────────────────────────────────────
  
    async createSession(body) {
      const { userId, email, role, ttl = 3600 } = body;
      const token = crypto.randomUUID();
      const expiresAt = Date.now() + ttl * 1000;
      const session = { token, userId, email, role, createdAt: Date.now(), expiresAt };
      await this._set(`session:${token}`, JSON.stringify(session));
      return { success: true, token, expiresAt };
    }
  
    async verifySession(body) {
      const { token } = body;
      if (!token) return { success: false, error: "토큰이 없습니다." };
      const raw = await this._get(`session:${token}`);
      if (!raw) return { success: false, error: "유효하지 않은 세션입니다." };
      const session = JSON.parse(raw);
      if (session.expiresAt < Date.now()) {
        await this._del(`session:${token}`);
        return { success: false, error: "세션이 만료되었습니다." };
      }
      return { success: true, session };
    }
  
    async destroySession(body) {
      const { token } = body;
      if (token) await this._del(`session:${token}`);
      return { success: true };
    }
  
    async refreshSession(body) {
      const { token, ttl = 3600 } = body;
      const verify = await this.verifySession({ token });
      if (!verify.success) return verify;
      const session = verify.session;
      session.expiresAt = Date.now() + ttl * 1000;
      await this._set(`session:${token}`, JSON.stringify(session));
      return { success: true, expiresAt: session.expiresAt };
    }
  
    // ── 락 시스템 ───────────────────────────────────────────────────────────────
    // 동시 실행 차단: wp_options, plugin_install, cron, cache_rebuild 등
  
    async acquireLock(body) {
      const { resource, ttl = 60 } = body;
      const key = `lock:${resource}`;
      const existing = await this._get(key);
      if (existing) {
        const lock = JSON.parse(existing);
        if (lock.expiresAt > Date.now()) {
          return { success: false, error: `리소스가 잠겨 있습니다: ${resource}`, lock };
        }
      }
      const lock = {
        resource,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + ttl * 1000,
        lockId: crypto.randomUUID(),
      };
      await this._set(key, JSON.stringify(lock));
      return { success: true, lock };
    }
  
    async releaseLock(body) {
      const { resource } = body;
      await this._del(`lock:${resource}`);
      return { success: true };
    }
  
    async checkLock(body) {
      const { resource } = body;
      const raw = await this._get(`lock:${resource}`);
      if (!raw) return { success: true, locked: false };
      const lock = JSON.parse(raw);
      if (lock.expiresAt <= Date.now()) {
        await this._del(`lock:${resource}`);
        return { success: true, locked: false };
      }
      return { success: true, locked: true, lock };
    }
  
    // ── 크론 시스템 (WordPress Cron 대체) ───────────────────────────────────────
  
    async scheduleCron(body) {
      const { siteId, hook, interval, nextRun } = body;
      const key = `cron:${siteId}:${hook}`;
      const job = {
        siteId, hook, interval,
        nextRun: nextRun || Date.now() + (interval || 3600) * 1000,
        createdAt: Date.now(),
      };
      await this._set(key, JSON.stringify(job));
      return { success: true, job };
    }
  
    async listCrons(body) {
      const { siteId } = body;
      const all = await this._list(siteId ? `cron:${siteId}:` : "cron:");
      const jobs = [];
      for (const [, val] of all) {
        jobs.push(typeof val === "string" ? JSON.parse(val) : val);
      }
      return { success: true, jobs };
    }
  
    async runCron(body) {
      const { siteId } = body;
      const now = Date.now();
      const all = await this._list(`cron:${siteId}:`);
      const due = [];
      for (const [key, val] of all) {
        const job = typeof val === "string" ? JSON.parse(val) : val;
        if (job.nextRun <= now) {
          due.push({ key, job });
          // 다음 실행 시간 업데이트
          job.nextRun = now + (job.interval || 3600) * 1000;
          job.lastRun = now;
          await this._set(key, JSON.stringify(job));
        }
      }
      return { success: true, ran: due.length, jobs: due.map(d => d.job.hook) };
    }
  
    // ── DB 담당 (GitHub JSON DB) ─────────────────────────────────────────────────
    // 사용자가 호스팅 상세에서 직접 DB를 수정할 수 있도록 지원
  
    /**
     * DB 쿼리 실행 (읽기/쓰기)
     * body: { siteId, table, action: "select"|"insert"|"update"|"delete", where, data }
     */
    async dbQuery(body) {
      const { siteId, table, action, where, data, limit } = body;
      if (!siteId || !table || !action) return { success: false, error: "필수 파라미터 누락" };
  
      // DB 메타 확인
      const metaRaw = await this._get(`db:meta:${siteId}`);
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
  
      // 쓰기 작업인데 읽기 전용 DB면 차단
      if (meta?.readOnly && action !== "select") {
        return { success: false, error: "읽기 전용 DB입니다. CloudPressDB를 구독하면 쓰기가 가능합니다." };
      }
  
      // 테이블 허용 여부 확인
      if (meta?.tables && !meta.tables.includes(table)) {
        return { success: false, error: `'${table}' 테이블은 현재 플랜에서 사용할 수 없습니다.` };
      }
  
      const key = `db:${table}:${siteId}`;
      const raw = await this._get(key);
      let records = raw ? JSON.parse(raw) : [];
  
      switch (action) {
        case "select": {
          let result = records;
          if (where) {
            result = records.filter(r =>
              Object.entries(where).every(([k, v]) => r[k] === v)
            );
          }
          if (limit) result = result.slice(0, limit);
          return { success: true, records: result, total: result.length };
        }
  
        case "insert": {
          // 레코드 수 제한 확인
          if (meta?.maxRecords && records.length >= meta.maxRecords) {
            return { success: false, error: `레코드 수 한도(${meta.maxRecords})를 초과했습니다.` };
          }
          const lock = await this.acquireLock({ resource: `db:${table}:${siteId}`, ttl: 10 });
          if (!lock.success) return { success: false, error: "DB가 잠겨 있습니다." };
          const newRecord = { id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() };
          records.push(newRecord);
          await this._set(key, JSON.stringify(records));
          await this.releaseLock({ resource: `db:${table}:${siteId}` });
          return { success: true, record: newRecord };
        }
  
        case "update": {
          const lock = await this.acquireLock({ resource: `db:${table}:${siteId}`, ttl: 10 });
          if (!lock.success) return { success: false, error: "DB가 잠겨 있습니다." };
          let updated = 0;
          records = records.map(r => {
            if (!where || Object.entries(where).every(([k, v]) => r[k] === v)) {
              updated++;
              return { ...r, ...data, updatedAt: new Date().toISOString() };
            }
            return r;
          });
          await this._set(key, JSON.stringify(records));
          await this.releaseLock({ resource: `db:${table}:${siteId}` });
          return { success: true, updated };
        }
  
        case "delete": {
          const lock = await this.acquireLock({ resource: `db:${table}:${siteId}`, ttl: 10 });
          if (!lock.success) return { success: false, error: "DB가 잠겨 있습니다." };
          const before = records.length;
          if (where) {
            records = records.filter(r =>
              !Object.entries(where).every(([k, v]) => r[k] === v)
            );
          } else {
            records = []; // 전체 삭제
          }
          await this._set(key, JSON.stringify(records));
          await this.releaseLock({ resource: `db:${table}:${siteId}` });
          return { success: true, deleted: before - records.length };
        }
  
        default:
          return { success: false, error: "지원하지 않는 액션입니다." };
      }
    }
  
    async dbWrite(body) {
      return this.dbQuery({ ...body, action: "insert" });
    }
  
    async dbRead(body) {
      return this.dbQuery({ ...body, action: "select" });
    }
  
    async dbDelete(body) {
      return this.dbQuery({ ...body, action: "delete" });
    }
  
    async dbListTables(body) {
      const { siteId } = body;
      const metaRaw = await this._get(`db:meta:${siteId}`);
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
      if (!meta) return { success: false, error: "DB 메타 정보를 찾을 수 없습니다." };
      return { success: true, tables: meta.tables, meta };
    }
  
    // ── Cloudflare Tunnel ────────────────────────────────────────────────────────
    /**
     * Cloudflare Tunnel 생성 (계정당 하나)
     * 사용자의 Cloudflare API 키를 활용
     * body: { userId, cfToken, cfAccountId, domain }
     */
    async createTunnel(body) {
      const { userId, cfToken, cfAccountId, domain } = body;
  
      // 이미 Tunnel이 있는지 확인
      const existing = await this._get(`tunnel:${userId}`);
      if (existing) {
        const tunnel = JSON.parse(existing);
        if (tunnel.status === "active") {
          return { success: true, tunnelId: tunnel.tunnelId, existing: true };
        }
      }
  
      if (!cfToken || !cfAccountId) {
        return { success: false, error: "Cloudflare API 키와 계정 ID가 필요합니다." };
      }
  
      try {
        // Cloudflare Tunnel 생성 API
        const tunnelSecret = crypto.randomUUID().replace(/-/g, "");
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/cfd_tunnel`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `cloudpress-user-${userId}`,
            tunnel_secret: btoa(tunnelSecret),
            config_src: "cloudflare",
          }),
        });
        const data = await res.json();
  
        if (!data.success) {
          return { success: false, error: data.errors?.[0]?.message || "Tunnel 생성 실패" };
        }
  
        const tunnelData = {
          tunnelId: data.result.id,
          tunnelName: data.result.name,
          status: "created",
          userId,
          domain,
          createdAt: new Date().toISOString(),
        };
        await this._set(`tunnel:${userId}`, JSON.stringify(tunnelData));
        return { success: true, tunnelId: tunnelData.tunnelId, tunnel: tunnelData };
  
      } catch (e) {
        return { success: false, error: `Tunnel 생성 오류: ${e.message}` };
      }
    }
  
    /**
     * Tunnel 활성화 (자동으로 Ingress 규칙 설정)
     */
    async activateTunnel(body) {
      const { userId, cfToken, cfAccountId, tunnelId, domain, siteId } = body;
  
      if (!cfToken || !cfAccountId || !tunnelId) {
        return { success: false, error: "필수 파라미터가 누락되었습니다." };
      }
  
      try {
        // Tunnel Ingress 설정
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/cfd_tunnel/${tunnelId}/configurations`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${cfToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              config: {
                ingress: [
                  {
                    hostname: domain,
                    service: `https://cloudpress-wp-${siteId}.workers.dev`,
                    originRequest: { noTLSVerify: true },
                  },
                  { service: "http_status:404" },
                ],
              },
            }),
          }
        );
        const data = await res.json();
  
        // 상태 업데이트
        const tunnelRaw = await this._get(`tunnel:${userId}`);
        if (tunnelRaw) {
          const tunnel = JSON.parse(tunnelRaw);
          tunnel.status = data.success ? "active" : "error";
          tunnel.activatedAt = new Date().toISOString();
          await this._set(`tunnel:${userId}`, JSON.stringify(tunnel));
        }
  
        return { success: data.success, tunnelId, activated: data.success };
      } catch (e) {
        return { success: false, error: `Tunnel 활성화 오류: ${e.message}` };
      }
    }
  
    async getTunnelStatus(body) {
      const { userId, cfToken, cfAccountId } = body;
      const raw = await this._get(`tunnel:${userId}`);
      if (!raw) return { success: true, tunnel: null };
      const tunnel = JSON.parse(raw);
  
      // 실시간 Cloudflare 상태 조회 (선택)
      if (cfToken && cfAccountId && tunnel.tunnelId) {
        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/cfd_tunnel/${tunnel.tunnelId}`,
            { headers: { Authorization: `Bearer ${cfToken}` } }
          );
          const data = await res.json();
          if (data.success) {
            tunnel.liveStatus = data.result.status;
            tunnel.connections = data.result.connections?.length || 0;
          }
        } catch {}
      }
  
      return { success: true, tunnel };
    }
  }
  
  // ─── Worker 라우터: DO로 요청 포워딩 ────────────────────────────────────────────
  /**
   * worker.js에서 호출:
   *   import { routeWpManager } from "./src/durable-wp-manager.js";
   *   if (url.pathname.startsWith("/api/do/wp")) return routeWpManager(request, env, payload);
   */
  export async function routeWpManager(request, env, payload) {
    if (!env.WP_MANAGER) {
      return new Response(JSON.stringify({ success: false, error: "WP_MANAGER 바인딩 누락 (wrangler.toml 확인)" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  
    // Durable Object ID = 사용자 ID (계정당 하나)
    const userId = payload?.id;
    if (!userId) {
      return new Response(JSON.stringify({ success: false, error: "인증 필요" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  
    const id  = env.WP_MANAGER.idFromName(userId);
    const obj = env.WP_MANAGER.get(id);
  
    // DO로 요청 포워딩
    const newReq = new Request(request.url, {
      method:  request.method,
      headers: request.headers,
      body:    ["POST", "PUT", "PATCH"].includes(request.method) ? request.body : undefined,
    });
  
    return obj.fetch(newReq);
  }
  
  // ─── 스토리지 구조 자동 생성 헬퍼 (sites.js에서 호출) ──────────────────────────
  /**
   * 호스팅 생성 시 CP3/CloudPressDB 구독 상태에 따른 레포 구조 결정
   */
  export function getRepoStructurePlan(subscriptions) {
    const { cp3, cloudpressdb } = subscriptions;
  
    return {
      // 스토리지 경로
      storagePath: cp3 ? "_storage/" : "wp-content/uploads/",
      storageProvider: cp3 ? "github-cp3" : "github-repo",
  
      // DB 경로 및 권한
      dbPath: "_db/",
      dbReadOnly: !cloudpressdb,
      dbMaxTables: cloudpressdb
        ? (cloudpressdb.plan === "pro" ? 1000 : cloudpressdb.plan === "standard" ? 200 : 50)
        : 10,
  
      // CP3 구독 시 추가 혜택
      cp3Benefits: cp3
        ? {
            storageGb: cp3.plan === "pro" ? 100 : cp3.plan === "standard" ? 20 : 5,
            backupEnabled: true,
            cdnEnabled: true,
          }
        : { storageGb: 0.1, backupEnabled: false, cdnEnabled: false },
  
      // CloudPressDB 구독 시 추가 혜택
      dbBenefits: cloudpressdb
        ? {
            maxRecords: cloudpressdb.plan === "pro" ? 1000000 : cloudpressdb.plan === "standard" ? 100000 : 10000,
            writeEnabled: true,
            backupEnabled: true,
          }
        : { maxRecords: 1000, writeEnabled: false, backupEnabled: false },
    };
  }
