import { AuthManager } from './auth.js';
import { WordPressEngine } from './wp-engine.js';
import { AdminAPI } from './admin-api.js';
import { AutoHealing } from './auto-healing.js';
import { CloudflareSaaS } from './cloudflare-saas.js'; // New import

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = request.headers.get("host");

    // 1. 보안 미들웨어 (JWT & 2FA)
    if (url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/api/user/")) {
      const auth = await AuthManager.verifyRequest(request, env);
      if (!auth) return new Response("Unauthorized", { status: 401 });
    }

    // 2. 관리자 API 라우팅
    if (host === env.ADMIN_DOMAIN) return AdminAPI.handle(request, env);

    // 3. 사용자 API 라우팅 (대시보드 기능)
    if (url.pathname.startsWith("/api/user/")) {
      // 예시: 도메인 추가 API
      if (url.pathname === "/api/user/add-domain" && request.method === "POST") {
        const { siteId, domain } = await request.json();
        const cfSaaS = new CloudflareSaaS(env);
        try {
          const cfResult = await cfSaaS.addCustomHostname(domain);
          await env.DB.prepare(`
            INSERT INTO domain_aliases (site_id, domain, is_primary, cf_custom_hostname_id, cf_ssl_status, cf_cname_target, cf_cname_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(siteId, domain, 0, cfResult.id, cfResult.ssl.status, cfResult.ownership_verification.cname_target, cfResult.ownership_verification.cname_name).run();
          return new Response(JSON.stringify({ success: true, cfResult }), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
      // 예시: SSL 상태 확인 API
      if (url.pathname === "/api/user/check-ssl-status" && request.method === "POST") {
        const { domainId } = await request.json();
        const domainAlias = await env.DB.prepare("SELECT * FROM domain_aliases WHERE id = ?").bind(domainId).first();
        if (!domainAlias || !domainAlias.cf_custom_hostname_id) return new Response("Domain not found or not managed by Cloudflare SaaS", { status: 404 });

        const cfSaaS = new CloudflareSaaS(env);
        const cfStatus = await cfSaaS.getCustomHostnameStatus(domainAlias.cf_custom_hostname_id);
        await env.DB.prepare("UPDATE domain_aliases SET cf_ssl_status = ? WHERE id = ?")
          .bind(cfStatus.ssl.status, domainId).run();
        return new Response(JSON.stringify({ success: true, status: cfStatus.ssl.status }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 4. 워드프레스 엔진 실행
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
