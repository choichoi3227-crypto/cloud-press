import { Hono } from "hono";
import { Env, HonoBindings } from "../env";

const githubProxy = new Hono<HonoBindings>();

/**
 * WordPress의 cloud-press-deploy 플러그인이 GitHub 저장소 정보를 조회할 때
 * 경유하는 프록시 (docs/12 5절 참조). 이 엔드포인트를 두는 이유:
 *
 *   1) GitHub 토큰을 WordPress 서버가 아니라 Worker의 시크릿으로만 보관
 *   2) Cloudflare의 캐싱/rate-limit을 그대로 활용
 *   3) 화이트리스트 검사를 이중으로 둠 — WordPress 쪽 검사가 우회되더라도
 *      Worker가 한 번 더 막는 2차 방어선 역할
 *
 * 텍스트/이미지 생성 API의 사용자 인증과는 별개로, X-Deploy-Proxy-Key 헤더로만
 * 인증한다. 이 프록시는 저장소 "조회"만 담당하며, 실제 배포 승인/반영은 전적으로
 * WordPress 쪽 cloud-press-deploy 플러그인의 다중 승인 로직이 담당한다 — Worker는
 * 배포를 실행하지 않는다.
 */
function isWhitelisted(owner: string, repo: string, env: Env): boolean {
  const whitelist = (env.DEPLOY_REPO_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return whitelist.includes(`${owner}/${repo}`);
}

githubProxy.use("/*", async (c, next) => {
  const key = c.req.header("X-Deploy-Proxy-Key");
  if (!key || key !== c.env.DEPLOY_PROXY_KEY) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

githubProxy.get("/repo-info/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();

  if (!isWhitelisted(owner, repo, c.env)) {
    return c.json({ error: "repo_not_whitelisted" }, 403);
  }

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
      "User-Agent": "cloud-press-deploy-proxy",
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    return c.json({ error: "github_api_error", status: res.status }, 502);
  }

  return c.json(await res.json());
});

githubProxy.get("/latest-commit/:owner/:repo/:branch", async (c) => {
  const { owner, repo, branch } = c.req.param();

  if (!isWhitelisted(owner, repo, c.env)) {
    return c.json({ error: "repo_not_whitelisted" }, 403);
  }

  // 브랜치도 main 또는 release/* 패턴만 허용 (임의 브랜치 허용 시 화이트리스트가 무의미해짐)
  if (branch !== "main" && !/^release\/[\w.-]+$/.test(branch)) {
    return c.json({ error: "branch_not_allowed" }, 403);
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
        "User-Agent": "cloud-press-deploy-proxy",
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!res.ok) {
    return c.json({ error: "github_api_error", status: res.status }, 502);
  }

  return c.json(await res.json());
});

export default githubProxy;
