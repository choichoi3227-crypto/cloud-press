// src/sidebar.js
// 공통 사이드바 — 접기/펼치기 지원, 다크모드 토글 없음

(function () {
  const path = window.location.pathname;

  // ── 사이드바 접힘 상태 (localStorage 유지) ──────────────────────────────
  let isCollapsed = localStorage.getItem('cp-sidebar-collapsed') === 'true';

  function setCollapsed(val) {
    isCollapsed = val;
    localStorage.setItem('cp-sidebar-collapsed', String(val));
    applyCollapsed();
  }

  function applyCollapsed() {
    const sidebar = document.getElementById('cp-sidebar');
    const main    = document.getElementById('cp-main');
    const overlay = document.getElementById('cp-sidebar-overlay');

    if (!sidebar) return;

    if (isCollapsed) {
      sidebar.setAttribute('data-collapsed', 'true');
      if (main) main.style.marginLeft = '64px';
    } else {
      sidebar.removeAttribute('data-collapsed');
      if (main) main.style.marginLeft = 'var(--cp-sidebar-width)';
    }
  }

  // ── 활성 메뉴 판별 ────────────────────────────────────────────────────────
  function isActive(href) {
    if (href === '/dashboard') return path === '/dashboard' || path === '/' || path === '';
    return path === href || path.startsWith(href + '.') || path.startsWith(href + '/');
  }

  // ── 사용자 정보 로드 ──────────────────────────────────────────────────────
  async function loadUserInfo() {
    try {
      const token = localStorage.getItem('admin_token');
      if (!token) return null;
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── 토스트 ────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    let container = document.getElementById('cp-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'cp-toast-container';
      document.body.appendChild(container);
    }
    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const toast = document.createElement('div');
    toast.className = `cp-toast cp-toast-${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info} cp-toast-icon"></i><span class="cp-toast-msg">${msg}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 220);
    }, 4000);
  }
  window.cpToast = showToast;

  // ── 사이드바 HTML ─────────────────────────────────────────────────────────
  function buildSidebar(user) {
    const email    = user?.email || '';
    const name     = user?.name  || email.split('@')[0] || '사용자';
    const role     = user?.role;
    const initials = name.charAt(0).toUpperCase();
    const isAdmin  = role === 'admin';

    const navItems = [
      { href: '/dashboard', icon: 'fas fa-chart-pie',   label: '대시보드' },
      { href: '/hosting',   icon: 'fas fa-server',       label: '호스팅 관리' },
      { href: '/domains',   icon: 'fas fa-globe',        label: '도메인 관리' },
      { href: '/storage',   icon: 'fas fa-hdd',          label: '스토리지' },
      { href: '/traffic',   icon: 'fas fa-chart-line',   label: '트래픽' },
      { href: '/services',  icon: 'fas fa-th-large',     label: '전체 서비스' },
      { href: '/account',   icon: 'fas fa-user-circle',  label: '내 정보 관리' },
      { href: '/payment',   icon: 'fas fa-credit-card',  label: '결제 관리' },
    ];

    const adminItems = isAdmin ? [
      { href: '/admin',          icon: 'fas fa-shield-alt', label: '관리자 패널' },
      { href: '/admin-settings', icon: 'fas fa-cog',        label: '플랫폼 설정' },
    ] : [];

    const renderItem = ({ href, icon, label }) => {
      const active = isActive(href);
      return `
      <a href="${href}" class="cp-sidebar-link${active ? ' active' : ''}" title="${label}">
        <i class="${icon}"></i>
        <span class="cp-sidebar-link-label">${label}</span>
      </a>`;
    };

    return `
    <aside id="cp-sidebar" class="cp-sidebar"${isCollapsed ? ' data-collapsed="true"' : ''}>

      <!-- 로고 + 접기 버튼 -->
      <div class="cp-sidebar-logo">
        <a href="/dashboard" class="cp-sidebar-logo-text" title="CloudPress 홈">
          CLOUD<span>PRESS</span>
        </a>
        <button id="cp-collapse-btn"
          onclick="window.cpToggleSidebar()"
          class="cp-sidebar-collapse-btn"
          aria-label="${isCollapsed ? '사이드바 펼치기' : '사이드바 접기'}"
          title="${isCollapsed ? '펼치기' : '접기'}">
          <i id="cp-collapse-icon" class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-left'}"></i>
        </button>
      </div>

      <!-- 네비게이션 -->
      <nav class="cp-sidebar-nav" role="navigation" aria-label="메인 네비게이션">
        <div class="cp-sidebar-section">서비스</div>
        ${navItems.map(renderItem).join('')}

        ${isAdmin ? `
        <div class="cp-sidebar-section">관리자</div>
        ${adminItems.map(renderItem).join('')}
        ` : ''}
      </nav>

      <!-- 하단: 사용자 프로필 -->
      <div class="cp-sidebar-footer">
        <div style="position:relative;">
          <button id="cp-user-btn"
            onclick="window.cpToggleUserMenu()"
            class="cp-sidebar-link cp-sidebar-user-btn"
            style="width:100%;background:none;border:none;text-align:left;"
            aria-haspopup="true" aria-expanded="false"
            title="${name}">
            <div class="cp-sidebar-avatar">${initials}</div>
            <div class="cp-sidebar-link-label cp-sidebar-user-info">
              <div class="cp-sidebar-user-name">${name}</div>
              <div class="cp-sidebar-user-email">${email}</div>
            </div>
            <i class="fas fa-chevron-up cp-sidebar-link-label" style="font-size:0.625rem;opacity:0.45;margin-left:auto;"></i>
          </button>

          <!-- 사용자 드롭다운 -->
          <div id="cp-user-menu" class="cp-user-menu hidden" role="menu">
            <a href="/account" class="cp-user-menu-item" role="menuitem">
              <i class="fas fa-user-circle"></i> 내 정보 관리
            </a>
            <a href="/payment" class="cp-user-menu-item" role="menuitem">
              <i class="fas fa-credit-card"></i> 결제 관리
            </a>
            <hr class="cp-user-menu-divider">
            <button onclick="window.cpLogout()" class="cp-user-menu-item cp-user-menu-logout" role="menuitem">
              <i class="fas fa-sign-out-alt"></i> 로그아웃
            </button>
          </div>
        </div>
      </div>
    </aside>

    <!-- 모바일 오버레이 -->
    <div id="cp-sidebar-overlay" class="cp-sidebar-overlay" onclick="window.cpCloseSidebar()"></div>
    `;
  }

  // ── 사이드바 삽입 ─────────────────────────────────────────────────────────
  function insertSidebar(user) {
    document.getElementById('cp-sidebar')?.remove();
    document.getElementById('cp-sidebar-overlay')?.remove();

    const mount = document.getElementById('cp-sidebar-mount') || document.body;
    mount.insertAdjacentHTML('afterbegin', buildSidebar(user));

    // margin 초기 적용
    applyCollapsed();

    // 툴팁: 접혔을 때 hover 시 label 표시 (CSS로도 처리하나 동적 title 보완)
    document.querySelectorAll('.cp-sidebar-link').forEach(link => {
      link.addEventListener('mouseenter', () => {
        if (isCollapsed) link.setAttribute('title', link.querySelector('.cp-sidebar-link-label')?.textContent?.trim() || '');
      });
    });
  }

  // ── 전역 함수 ─────────────────────────────────────────────────────────────

  window.cpToggleSidebar = function () {
    setCollapsed(!isCollapsed);
    const icon = document.getElementById('cp-collapse-icon');
    const btn  = document.getElementById('cp-collapse-btn');
    if (icon) icon.className = isCollapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-left';
    if (btn)  btn.setAttribute('aria-label', isCollapsed ? '사이드바 펼치기' : '사이드바 접기');
    if (btn)  btn.setAttribute('title',      isCollapsed ? '펼치기' : '접기');
  };

  window.cpToggleUserMenu = function () {
    const menu = document.getElementById('cp-user-menu');
    const btn  = document.getElementById('cp-user-btn');
    if (!menu) return;
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn?.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) {
      const close = e => {
        if (!menu.contains(e.target) && !btn?.contains(e.target)) {
          menu.classList.add('hidden');
          btn?.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  };

  // 모바일: 사이드바 열기/닫기
  window.cpOpenSidebar = function () {
    document.getElementById('cp-sidebar')?.classList.add('open');
    document.getElementById('cp-sidebar-overlay')?.classList.add('visible');
  };

  window.cpCloseSidebar = function () {
    document.getElementById('cp-sidebar')?.classList.remove('open');
    document.getElementById('cp-sidebar-overlay')?.classList.remove('visible');
  };

  window.cpLogout = async function () {
    try {
      const token = localStorage.getItem('admin_token');
      if (token) await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch {}
    localStorage.removeItem('admin_token');
    localStorage.removeItem('user_data');
    window.location.href = '/login';
  };

  // ── 초기화 ────────────────────────────────────────────────────────────────
  async function init() {
    const user = await loadUserInfo();
    insertSidebar(user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
