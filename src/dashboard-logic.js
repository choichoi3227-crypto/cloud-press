// src/dashboard-logic.js — 대시보드 실제 데이터 로드 및 차트

async function loadDashboardData() {
  const token = localStorage.getItem('admin_token');
  if (!token) {
    window.location.href = '/login';
    return;
  }

  const headers = { 'Authorization': `Bearer ${token}` };

  // ── 사이트 목록 로드 ──────────────────────────────────────────────────
  try {
    const res = await fetch('/api/sites', { headers });
    if (res.status === 401) {
      localStorage.removeItem('admin_token');
      window.location.href = '/login';
      return;
    }
    const data = await res.json();
    if (data.success && Array.isArray(data.sites)) {
      const activeSites = data.sites.filter(s => s.status === 'active').length;
      const el = document.getElementById('active-hostings');
      if (el) el.textContent = activeSites;
    }
  } catch (e) {
    console.error('[dashboard] 사이트 로드 실패:', e);
  }

  // ── 계정 정보 로드 ────────────────────────────────────────────────────
  try {
    const res = await fetch('/api/account', { headers });
    if (res.ok) {
      const data = await res.json();
      const emailEl = document.getElementById('user-email');
      if (emailEl && data.email) emailEl.textContent = data.email;
      const displayEl = document.getElementById('user-display');
      if (displayEl && data.email) {
        displayEl.innerHTML = `환영합니다, <span class="font-bold">${data.email}</span>!`;
      }
    }
  } catch (e) {
    console.error('[dashboard] 계정 정보 로드 실패:', e);
  }

  // ── 스토리지/트래픽 표시 (플랜 기반 정적 표시) ────────────────────────
  const trafficEl = document.getElementById('monthly-traffic');
  if (trafficEl) trafficEl.textContent = '— GB';
  const storageEl = document.getElementById('remaining-storage');
  if (storageEl) storageEl.textContent = '— GB';

  // ── 긴급 알림 바 (스토리지 임계치) ────────────────────────────────────
  // 실제 스토리지 API가 연결되면 조건부로 표시
  // const alertBar = document.getElementById('emergency-alert');
  // if (alertBar && remainingGB < 1) alertBar.classList.remove('hidden');

  // ── 트래픽 차트 ────────────────────────────────────────────────────────
  const canvas = document.getElementById('trafficChart');
  if (canvas && window.Chart) {
    const ctx = canvas.getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['00:00','02:00','04:00','06:00','08:00','10:00',
                 '12:00','14:00','16:00','18:00','20:00','22:00'],
        datasets: [{
          label: '요청 수',
          data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          fill: true,
          tension: 0.4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' } },
          y: { grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#94a3b8' }, beginAtZero: true },
        },
      },
    });
  }
}

loadDashboardData();
  // "제공 예정" 알림 제거 및 페이지 이동 처리
  window.createHosting = function() {
      location.href = '/hosting-create';
  };

  // 호스팅 상세 페이지로 이동
  window.viewSiteDetails = function(siteId) {
      location.href = `/hosting-detail?id=${siteId}`;
  };
