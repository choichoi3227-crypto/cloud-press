/**
 * DNS 플래너 — GitHub 레포 풀 헬스체크 · 가중치 라우팅 (Route53 스타일)
 */

export async function ghHealthCheck({ owner, repo, token }) {
  if (!owner || !repo || !token) {
    return { status: "unhealthy", message: "owner/repo/token 누락" };
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "CloudPress-DNS/1.0",
      },
    });
    if (!res.ok) {
      return { status: "unhealthy", message: `GitHub ${res.status}` };
    }
    const data = await res.json();
    if (data.disabled) return { status: "unhealthy", message: "레포 비활성" };
    return { status: "healthy", message: "OK" };
  } catch (e) {
    return { status: "unhealthy", message: e.message || "연결 실패" };
  }
}

/** 가중치 기반 DNS 플랜 생성 (healthy 노드만) */
export function buildDnsPlan(servers) {
  const healthy = (servers || []).filter(
    (s) => s.enabled !== 0 && s.enabled !== false && s.health_status === "healthy"
  );
  const total = healthy.reduce((sum, s) => sum + Math.max(0, Number(s.weight) || 0), 0) || 1;
  const entries = healthy.map((s) => ({
    server_id:    s.id,
    name:         s.name,
    github_owner: s.github_owner,
    github_repo:  s.github_repo,
    weight:       Number(s.weight) || 0,
    weight_percent: Math.round(((Number(s.weight) || 0) / total) * 100),
  }));
  let pct = entries.reduce((a, e) => a + e.weight_percent, 0);
  if (entries.length && pct !== 100) {
    entries[entries.length - 1].weight_percent += 100 - pct;
  }
  return {
    version:      Date.now(),
    generated_at: new Date().toISOString(),
    total_servers: servers.length,
    healthy_count: healthy.length,
    entries,
  };
}

/** 사용자/사이트 ID → 결정적 서버 선택 (가중치 구간) */
export function pickServerFromPlan(plan, seed) {
  const entries = plan?.entries || [];
  if (!entries.length) return null;
  const str = String(seed || "default");
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  const bucket = hash % 100;
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.weight_percent || 0;
    if (bucket < cumulative) return entry;
  }
  return entries[entries.length - 1];
}

export function storagePathForAssignment(productType, userId, siteId) {
  if (productType === "cpdb") {
    return `databases/${userId}/${siteId}`;
  }
  if (productType === "cp3") {
    return `storage/${userId}/${siteId}`;
  }
  return `misc/${userId}/${siteId}`;
}
