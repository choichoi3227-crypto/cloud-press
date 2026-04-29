// src/dashboard-logic.js
async function loadDashboardData() {
    const token = localStorage.getItem('admin_token');
    if (!token) return; // 이미 auth-frontend.js에서 리다이렉트되지만, 안전 장치

    // 사용자 활성 호스팅 수 로드
    // const hostingRes = await fetch('/api/user/active-hostings', { headers: { 'Authorization': `Bearer ${token}` } });
    // const hostingData = await hostingRes.json();
    document.getElementById('active-hostings').innerText = '5'; // 더미 데이터

    // 월간 트래픽 로드
    // const trafficRes = await fetch('/api/user/monthly-traffic', { headers: { 'Authorization': `Bearer ${token}` } });
    // const trafficData = await trafficRes.json();
    document.getElementById('monthly-traffic').innerText = '120 GB'; // 더미 데이터

    // 잔여 스토리지 로드
    // const storageRes = await fetch('/api/user/remaining-storage', { headers: { 'Authorization': `Bearer ${token}` } });
    // const storageData = await storageRes.json();
    document.getElementById('remaining-storage').innerText = '15.3'; // 더미 데이터

    // 긴급 알림 바 상태 업데이트 (src/auth-frontend.js의 checkSystemHealth 호출)
    // checkSystemHealth(); 

    // 트래픽 차트 렌더링 (더미 데이터)
    const ctx = document.getElementById('trafficChart').getContext('2d');
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'],
            datasets: [{
                label: '요청 수',
                data: [120, 150, 130, 200, 220, 250, 300, 280, 350, 320, 400, 380],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } }
            }
        }
    });
}
loadDashboardData();
