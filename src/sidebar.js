// src/sidebar.js
// 공통 사이드바 + 프로필 드롭다운 (라이트/다크 테마 지원)

(function () {
  const path = window.location.pathname;

  function isActive(href) {
    if (href === '/dashboard') return path === '/dashboard' || path === '/' || path === '';
    return path === href || path.startsWith(href + '.');
  }

  // 다크모드 상태
  let isDark = localStorage.getItem('cp-theme') === 'dark';
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    document.body.classList.toggle('dark', isDark);
  }
  applyTheme();

  // 사용자 정보 로드
  async function loadUserInfo() {
    try {
      const token = localStorage.getItem('admin_token');
      if (!token) return null;
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // 토스트 알림
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

  // 사이드바 HTML 생성
  function buildSidebar(user) {
    const email    = user?.email || '';
    const name     = user?.name  || email.split('@')[0] || '사용자';
    const role     = user?.role;
    const initials = name.charAt(0).toUpperCase();
    const isAdmin  = role === 'admin';

    const navItems = [
      { href: '/dashboard',  icon: 'fas fa-chart-pie',    label: '대시보드' },
      { href: '/hosting',    icon: 'fas fa-server',        label: '호스팅 관리' },
      { href: '/domains',    icon: 'fas fa-globe',         label: '도메인 관리' },
      { href: '/storage',    icon: 'fas fa-hdd',           label: '스토리지' },
      { href: '/traffic',    icon: 'fas fa-chart-line',    label: '트래픽' },
      { href: '/services',   icon: 'fas fa-th-large',      label: '전체 서비스' },
      { href: '/account',    icon: 'fas fa-user-circle',   label: '내 정보 관리' },
      { href: '/payment',    icon: 'fas fa-credit-card',   label: '결제 관리' },
    ];

    const adminItems = isAdmin ? [
      { href: '/admin',          icon: 'fas fa-shield-alt',  label: '관리자 패널' },
      { href: '/admin-settings', icon: 'fas fa-cog',         label: '플랫폼 설정' },
    ] : [];

    const renderItem = (item) => {
      const active = isActive(item.href);
      return `<a href="${item.href}" class="cp-sidebar-link${active ? ' active' : ''}">
        <i class="${item.icon}"></i>
        <span>${item.label}</span>
      </a>`;
    };

    return `
    <aside id="cp-sidebar" class="cp-sidebar">
      <!-- 로고 -->
      <div class="cp-sidebar-logo">
        <a href="/dashboard">CLOUD<span>PRESS</span></a>
      </div>

      <!-- 네비게이션 -->
      <nav class="cp-sidebar-nav" role="navigation" aria-label="메인 네비게이션">
        <div class="cp-sidebar-section">서비스</div>
        ${navItems.map(renderItem).join('')}

        ${isAdmin ? `
        <div class="cp-sidebar-section" style="margin-top:0.75rem;">관리자</div>
        ${adminItems.map(renderItem).join('')}
        ` : ''}
      </nav>

      <!-- 하단 영역 -->
      <div class="cp-sidebar-footer">
        <!-- 다크모드 토글 -->
        <button id="cp-theme-toggle" onclick="window.cpToggleTheme()"
          class="cp-sidebar-link" style="width:100%;background:none;border:none;text-align:left;"
          aria-label="테마 전환">
          <i class="${isDark ? 'fas fa-sun' : 'fas fa-moon'}"></i>
          <span id="cp-theme-label">${isDark ? '라이트 모드' : '다크 모드'}</span>
        </button>

        <!-- 사용자 프로필 -->
        <div style="position:relative;margin-top:0.5rem;">
          <button id="cp-user-btn" onclick="window.cpToggleUserMenu()"
            class="cp-sidebar-link" style="width:100%;background:none;border:none;text-align:left;"
            aria-haspopup="true" aria-expanded="false">
            <div style="width:28px;height:28px;border-radius:50%;background:var(--cp-primary);
              color:#fff;display:flex;align-items:center;justify-content:center;
              font-size:0.75rem;font-weight:700;flex-shrink:0;">${initials}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.8125rem;font-weight:600;color:var(--cp-sidebar-active);
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
              <div style="font-size:0.6875rem;color:var(--cp-sidebar-text);
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${email}</div>
            </div>
            <i class="fas fa-chevron-up" style="font-size:0.6875rem;opacity:0.5;"></i>
          </button>

          <!-- 사용자 드롭다운 -->
          <div id="cp-user-menu" class="hidden"
            style="position:absolute;bottom:100%;left:0;right:0;margin-bottom:4px;
              background:var(--cp-surface);border:1px solid var(--cp-border);
              border-radius:var(--cp-radius-md);box-shadow:var(--cp-shadow-md);
              overflow:hidden;z-index:100;">
            <a href="/account" style="display:flex;align-items:center;gap:0.625rem;
              padding:0.625rem 1rem;font-size:0.8125rem;color:var(--cp-text);
              transition:background var(--cp-transition);"
              onmouseover="this.style.background='var(--cp-surface-alt)'"
              onmouseout="this.style.background=''">
              <i class="fas fa-user-circle" style="color:var(--cp-primary);width:14px;"></i> 내 정보 관리
            </a>
            <a href="/payment" style="display:flex;align-items:center;gap:0.625rem;
              padding:0.625rem 1rem;font-size:0.8125rem;color:var(--cp-text);
              transition:background var(--cp-transition);"
              onmouseover="this.style.background='var(--cp-surface-alt)'"
              onmouseout="this.style.background=''">
              <i class="fas fa-credit-card" style="color:var(--cp-primary);width:14px;"></i> 결제 관리
            </a>
            <hr style="border:none;border-top:1px solid var(--cp-border);margin:0.25rem 0;">
            <button onclick="window.cpLogout()"
              style="display:flex;align-items:center;gap:0.625rem;
                padding:0.625rem 1rem;font-size:0.8125rem;color:#EF4444;width:100%;
                text-align:left;background:none;border:none;cursor:pointer;font-family:inherit;
                transition:background var(--cp-transition);"
              onmouseover="this.style.background='var(--cp-danger-bg)'"
              onmouseout="this.style.background=''">
              <i class="fas fa-sign-out-alt" style="width:14px;"></i> 로그아웃
            </button>
          </div>
        </div>
      </div>
    </aside>

    <!-- 모바일 오버레이 -->
    <div id="cp-sidebar-overlay" class="cp-sidebar-overlay" onclick="window.cpCloseSidebar()"></div>
    `;
  }

  // 모바일 햄버거 버튼 HTML
  function buildMobileMenuBtn() {
    return `
    <button id="cp-mobile-menu-btn" class="cp-mobile-menu-btn btn btn-ghost btn-icon"
      onclick="window.cpOpenSidebar()" aria-label="메뉴 열기"
      style="display:none;">
      <i class="fas fa-bars"></i>
    </button>`;
  }

  // 사이드바 삽입
  function insertSidebar(user) {
    // 기존 사이드바 제거
    document.getElementById('cp-sidebar')?.remove();
    document.getElementById('cp-sidebar-overlay')?.remove();

    const sidebarHtml = buildSidebar(user);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = sidebarHtml;

    const target = document.getElementById('cp-sidebar-mount') || document.body;
    target.insertAdjacentHTML('afterbegin', sidebarHtml);
  }

  // 전역 함수
  window.cpToggleTheme = function () {
    isDark = !isDark;
    localStorage.setItem('cp-theme', isDark ? 'dark' : 'light');
    applyTheme();
    const btn = document.getElementById('cp-theme-toggle');
    const label = document.getElementById('cp-theme-label');
    if (btn) {
      const icon = btn.querySelector('i');
      if (icon) { icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon'; }
    }
    if (label) label.textContent = isDark ? '라이트 모드' : '다크 모드';
  };

  window.cpToggleUserMenu = function () {
    const menu = document.getElementById('cp-user-menu');
    const btn  = document.getElementById('cp-user-btn');
    if (!menu) return;
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn?.setAttribute('aria-expanded', String(!isOpen));

    if (!isOpen) {
      // 외부 클릭 시 닫기
      const close = (e) => {
        if (!menu.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
          menu.classList.add('hidden');
          btn?.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  };

  window.cpOpenSidebar = function () {
    const sidebar = document.getElementById('cp-sidebar');
    const overlay = document.getElementById('cp-sidebar-overlay');
    sidebar?.classList.add('open');
    overlay?.classList.add('visible');
  };

  window.cpCloseSidebar = function () {
    const sidebar = document.getElementById('cp-sidebar');
    const overlay = document.getElementById('cp-sidebar-overlay');
    sidebar?.classList.remove('open');
    overlay?.classList.remove('visible');
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

  // DOM 준비 후 사이드바 삽입
  async function init() {
    const user = await loadUserInfo();
    if (!user) {
      // 인증되지 않은 경우 로그인 페이지로
      const publicPages = ['/login', '/signup', '/index', '/', '/pricing', '/features', '/about', '/contact', '/faq', '/terms', '/privacy', '/services'];
      const isPublic = publicPages.some(p => path === p || path.startsWith(p + '.'));
      if (!isPublic && !path.includes('login') && !path.includes('signup') && !path.includes('.html')) {
        // window.location.href = '/login';
      }
    }
    insertSidebar(user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
