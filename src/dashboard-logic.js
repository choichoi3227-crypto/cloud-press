// dashboard.html에서 사용될 JavaScript 로직
async function updateQuotaMonitor() { /* ... 기존 로직 ... */ }
async function loadSites() {
    // 사용자 사이트 목록 로드 및 UI 렌더링
    // 각 사이트별 도메인 및 SSL 상태 표시
}
async function addDomainToSite(siteId) {
    const domain = prompt("추가할 도메인을 입력하세요:");
    if (!domain) return;
    const res = await fetch('/api/user/add-domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, domain })
    });
    const data = await res.json();
    if (data.success) {
        alert(`도메인 ${domain}이 추가되었습니다. Cloudflare DNS에 다음 CNAME 레코드를 추가하세요:\n이름: ${data.cfResult.ownership_verification.cname_name}\n값: ${data.cfResult.ownership_verification.cname_target}`);
        loadSites(); // 목록 새로고침
    } else {
        alert(`도메인 추가 실패: ${data.error}`);
    }
}
async function checkSslStatus(domainId) {
    const res = await fetch('/api/user/check-ssl-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainId })
    });
    const data = await res.json();
    if (data.success) {
        alert(`SSL 상태: ${data.status}`);
        loadSites();
    } else {
        alert(`SSL 상태 확인 실패: ${data.error}`);
    }
}
// ... 기타 대시보드 관련 로직 ...
