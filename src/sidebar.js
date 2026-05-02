// src/sidebar.js
// 공통 사이드바 + 프로필 드롭다운 컴포넌트

(function () {
  // ── 현재 페이지 감지 ──────────────────────────────────────────
  const path = window.location.pathname;

  function isActive(href) {
    if (href === '/dashboard.html') return path === '/dashboard.html' || path === '/';
    return path.startsWith(href.replace('.html', ''));
  }

  // 서비스 메뉴 항목 중 활성화 여부
  const servicePages = ['/hosting.html', '/hosting-create.html', '/hosting-detail.html',
    '/domains.html', '/dns.html', '/payment.html', '/account.html'];
  const isServiceActive = servicePages.some(p => path.startsWith(p.replace('.html', '')));

  // ── 사용자 정보 로드 ─────────────────────────────────────────
  async function loadUserInfo() {
    try {
      const token = localStorage.getItem('admin_token');
      if (!token) return null;
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── 사이드바 HTML 생성 ────────────────────────────────────────
  function buildSidebar(user) {
    const email = user?.email || '사용자';
    const name = user?.name || email.split('@')[0];
    const role = user?.role;
    const initials = name.charAt(0).toUpperCase();

    const navItems = [
      { href: '/dashboard.html', icon: 'fas fa-tachometer-alt', label: '대시보드' },
      { href: '/traffic.html', icon: 'fas fa-chart-line', label: '트래픽' },
      { href: '/storage.html', icon: 'fas fa-hdd', label: '스토리지' },
    ];

    const serviceItems = [
      { href: '/hosting.html', icon: 'fas fa-server', label: '호스팅 관리' },
      { href: '/domains.html', icon: 'fas fa-globe', label: '도메인 관리' },
      { href: '/payment.html', icon: 'fas fa-credit-card', label: '결제 수단 관리' },
      { href: '/account.html', icon: 'fas fa-user-circle', label: '내 정보 관리' },
    ];

    return `
    <aside id="cp-sidebar" class="w-64 border-r border-white/10 flex flex-col flex-shrink-0 hidden md:flex" style="background:#07090f;">
      <!-- 로고 -->
      <div class="px-6 pt-7 pb-5 border-b border-white/5">
        <a href="/dashboard.html" class="text-2xl font-black text-blue-500 tracking-tight">CLOUD<span class="text-white">PRESS</span></a>
      </div>

      <!-- 네비게이션 -->
      <nav class="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        ${navItems.map(item => `
          <a href="${item.href}" class="sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-sm font-medium ${isActive(item.href) ? 'bg-blue-600/20 text-blue-400 font-semibold' : 'text-gray-400 hover:bg-white/5 hover:text-white'}">
            <i class="${item.icon} w-4 text-center opacity-80"></i>
            ${item.label}
          </a>
        `).join('')}

        <!-- 서비스 드롭다운 -->
        <div class="mt-1">
          <button id="service-toggle" onclick="toggleServiceMenu()" class="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl transition-all text-sm font-medium ${isServiceActive ? 'bg-blue-600/20 text-blue-400 font-semibold' : 'text-gray-400 hover:bg-white/5 hover:text-white'}">
            <span class="flex items-center gap-3">
              <i class="fas fa-th-large w-4 text-center opacity-80"></i>
              서비스
            </span>
            <i id="service-chevron" class="fas fa-chevron-${isServiceActive ? 'down' : 'right'} text-xs opacity-60 transition-transform duration-200"></i>
          </button>
          <div id="service-submenu" class="${isServiceActive ? '' : 'hidden'} pl-3 mt-0.5 space-y-0.5">
            ${serviceItems.map(item => `
              <a href="${item.href}" class="sidebar-link flex items-center gap-3 px-3 py-2 rounded-xl transition-all text-sm ${isActive(item.href) ? 'bg-white/10 text-white font-semibold' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'}">
                <i class="${item.icon} w-4 text-center text-xs opacity-70"></i>
                ${item.label}
              </a>
            `).join('')}
          </div>
        </div>
      </nav>

      <!-- 어드민 링크 (어드민만) -->
      ${role === 'admin' ? `
      <div class="px-3 pb-2">
        <a href="/admin.html" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-purple-400 hover:bg-purple-900/20 transition-all">
          <i class="fas fa-shield-alt w-4 text-center"></i>
          관리자 패널
        </a>
      </div>` : ''}

      <!-- 프로필 섹션 -->
      <div class="px-3 pb-4 border-t border-white/5 pt-3">
        <div class="relative">
          <button id="profile-btn" onclick="toggleProfileDropdown()" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-all group">
            <div class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold flex-shrink-0">${initials}</div>
            <div class="flex-1 text-left min-w-0">
              <div class="text-sm font-semibold text-white truncate">${name}</div>
              <div class="text-xs text-gray-500 truncate">${email}</div>
            </div>
            <i class="fas fa-ellipsis-h text-xs text-gray-600 group-hover:text-gray-400 transition-colors"></i>
          </button>
          <!-- 프로필 드롭다운 -->
          <div id="profile-dropdown" class="hidden absolute bottom-full left-0 right-0 mb-2 bg-[#111] border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50">
            <div class="px-4 py-3 border-b border-white/5">
              <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">계정</div>
              <div class="text-sm text-white font-medium mt-0.5 truncate">${email}</div>
            </div>
            <div class="p-1">
              <a href="/account.html" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-all">
                <i class="fas fa-user-circle w-4 text-center text-gray-500"></i> 내 정보 관리
              </a>
              <a href="/payment.html" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-white/5 hover:text-white transition-all">
                <i class="fas fa-credit-card w-4 text-center text-gray-500"></i> 결제 수단
              </a>
              ${role === 'admin' ? `
              <a href="/admin.html" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-purple-400 hover:bg-purple-900/20 transition-all">
                <i class="fas fa-shield-alt w-4 text-center"></i> 관리자 패널
              </a>` : ''}
            </div>
            <div class="p-1 border-t border-white/5">
              <button onclick="logout()" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-900/20 transition-all">
                <i class="fas fa-sign-out-alt w-4 text-center"></i> 로그아웃
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>`;
  }

  // ── 모바일 헤더 HTML 생성 ─────────────────────────────────────
  function buildMobileHeader(user) {
    const email = user?.email || '사용자';
    const name = user?.name || email.split('@')[0];
    const initials = name.charAt(0).toUpperCase();
    const role = user?.role;

    const allLinks = [
      { href: '/dashboard.html', icon: 'fas fa-tachometer-alt', label: '대시보드' },
      { href: '/traffic.html', icon: 'fas fa-chart-line', label: '트래픽' },
      { href: '/storage.html', icon: 'fas fa-hdd', label: '스토리지' },
      { href: '/hosting.html', icon: 'fas fa-server', label: '호스팅 관리' },
      { href: '/domains.html', icon: 'fas fa-globe', label: '도메인 관리' },
      { href: '/payment.html', icon: 'fas fa-credit-card', label: '결제 수단' },
      { href: '/account.html', icon: 'fas fa-user-circle', label: '내 정보 관리' },
    ];

    return `
    <header id="cp-mobile-header" class="md:hidden sticky top-0 z-50 border-b border-white/10" style="background:#07090f;">
      <div class="flex justify-between items-center px-4 py-3">
        <a href="/dashboard.html" class="text-xl font-black text-blue-500">CLOUD<span class="text-white">PRESS</span></a>
        <div class="flex items-center gap-2">
          <button id="mobile-profile-btn" onclick="toggleMobileProfileDropdown()" class="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold">
            ${initials}
          </button>
          <button id="mobileMenuBtn" class="text-gray-400 hover:text-white p-2">
            <i class="fas fa-bars text-xl"></i>
          </button>
        </div>
      </div>

      <!-- 모바일 프로필 드롭다운 -->
      <div id="mobile-profile-dropdown" class="hidden border-t border-white/10 py-2 px-2">
        <div class="px-3 py-2 mb-1">
          <div class="text-sm font-semibold text-white">${name}</div>
          <div class="text-xs text-gray-500">${email}</div>
        </div>
        <a href="/account.html" class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 text-sm text-gray-300"><i class="fas fa-user-circle w-4"></i> 내 정보 관리</a>
        <a href="/payment.html" class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/5 text-sm text-gray-300"><i class="fas fa-credit-card w-4"></i> 결제 수단</a>
        ${role === 'admin' ? `<a href="/admin.html" class="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-purple-900/20 text-sm text-purple-400"><i class="fas fa-shield-alt w-4"></i> 관리자 패널</a>` : ''}
        <button onclick="logout()" class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-red-400 hover:bg-red-900/20 text-sm"><i class="fas fa-sign-out-alt w-4"></i> 로그아웃</button>
      </div>

      <!-- 모바일 내비게이션 메뉴 -->
      <div id="mobileMenu" class="hidden border-t border-white/10 py-2 px-2 space-y-0.5">
        ${allLinks.map(item => `
          <a href="${item.href}" class="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition text-sm ${path.startsWith(item.href.replace('.html', '')) ? 'bg-white/10 font-bold text-white' : 'text-gray-400'}">
            <i class="${item.icon} w-5 text-center"></i> ${item.label}
          </a>
        `).join('')}
      </div>
    </header>`;
  }

  // ── DOM 삽입 ───────────────────────────────────────────────────
  function inject(user) {
    const body = document.body;

    // 기존 사이드바/헤더 제거
    document.querySelectorAll('aside, #cp-sidebar, #cp-mobile-header').forEach(el => {
      // 기존 aside 중 nav가 포함된 것만 제거
      if (el.querySelector('nav') || el.id === 'cp-sidebar') el.remove();
    });
    document.querySelectorAll('header.md\\:hidden, #cp-mobile-header').forEach(el => el.remove());

    // body에 모바일 헤더 삽입
    body.insertAdjacentHTML('afterbegin', buildMobileHeader(user));

    // body flex에 사이드바 삽입 (모바일 헤더 다음)
    const mobileHeader = document.getElementById('cp-mobile-header');
    mobileHeader.insertAdjacentHTML('afterend', buildSidebar(user));

    // 모바일 메뉴 토글
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('mobileMenu').classList.toggle('hidden');
      document.getElementById('mobile-profile-dropdown').classList.add('hidden');
    });

    // 모바일 링크 클릭시 닫기
    document.querySelectorAll('#mobileMenu a').forEach(a => {
      a.addEventListener('click', () => document.getElementById('mobileMenu').classList.add('hidden'));
    });

    // 외부 클릭 시 드롭다운 닫기
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#profile-btn') && !e.target.closest('#profile-dropdown')) {
        document.getElementById('profile-dropdown')?.classList.add('hidden');
      }
      if (!e.target.closest('#mobile-profile-btn') && !e.target.closest('#mobile-profile-dropdown')) {
        document.getElementById('mobile-profile-dropdown')?.classList.add('hidden');
      }
    });
  }

  // ── 전역 함수 ─────────────────────────────────────────────────
  window.toggleServiceMenu = function () {
    const submenu = document.getElementById('service-submenu');
    const chevron = document.getElementById('service-chevron');
    submenu.classList.toggle('hidden');
    const isOpen = !submenu.classList.contains('hidden');
    chevron.className = `fas fa-chevron-${isOpen ? 'down' : 'right'} text-xs opacity-60 transition-transform duration-200`;
  };

  window.toggleProfileDropdown = function () {
    document.getElementById('profile-dropdown').classList.toggle('hidden');
  };

  window.toggleMobileProfileDropdown = function () {
    const pd = document.getElementById('mobile-profile-dropdown');
    const menu = document.getElementById('mobileMenu');
    pd.classList.toggle('hidden');
    menu.classList.add('hidden');
  };

  // ── 초기화 ────────────────────────────────────────────────────
  async function init() {
    const user = await loadUserInfo();
    inject(user);

    // 헤더의 사용자 이름 표시 업데이트
    const emailEl = document.getElementById('user-email');
    if (emailEl && user?.email) emailEl.textContent = user.email;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
