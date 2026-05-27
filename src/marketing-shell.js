/**
 * marketing-shell.js v2.1
 * 마케팅/공개 페이지 공통 헤더 (라이트 모드 전용)
 * index.html, pricing.html, features.html, about.html, faq.html, contact.html 등에서 사용
 */
(function () {
  const PRODUCTS = [
    { href: '/pricing',              label: 'WordPress 호스팅', icon: 'fa-server'   },
    { href: '/product-cachecloud',   label: 'CacheCloud',       icon: 'fa-bolt'     },
    { href: '/product-cp3',          label: 'CP3 스토리지',     icon: 'fa-cube'     },
    { href: '/product-cloudpressdb', label: 'CloudPressDB',     icon: 'fa-database' },
  ];

  const NAV_LINKS = [
    { href: '/features', label: '기능'    },
    { href: '/pricing',  label: '상품',    isProducts: true },
    { href: '/about',    label: '소개'    },
    { href: '/faq',      label: 'FAQ'     },
    { href: '/contact',  label: '문의하기' },
  ];

  const path = window.location.pathname;

  function navbarHtml() {
    const links = NAV_LINKS.map(link => {
      if (link.isProducts) {
        const isAct = PRODUCTS.some(p => path === p.href);
        return `
        <div class="cp-nav-dropdown-wrap" style="position:relative;">
          <button type="button" class="cp-nav-dropdown-btn"
            style="background:none;border:none;cursor:pointer;font-family:inherit;
              display:flex;align-items:center;gap:4px;
              color:${isAct ? '#2563EB' : '#475569'};
              font-size:0.9rem;font-weight:500;padding:0;transition:color 150ms;"
            aria-haspopup="true" aria-expanded="false"
            onmouseover="this.style.color='#0F172A'"
            onmouseout="this.style.color='${isAct ? '#2563EB' : '#475569'}'">
            상품 <i class="fas fa-chevron-down" style="font-size:0.625rem;opacity:0.55;"></i>
          </button>
          <div class="cp-nav-dropdown" style="display:none;position:absolute;left:0;top:calc(100%+10px);
            min-width:220px;background:#fff;border:1px solid #E2E8F0;
            border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.1);
            padding:6px;z-index:200;">
            ${PRODUCTS.map(p => `
              <a href="${p.href}"
                style="display:flex;align-items:center;gap:10px;padding:9px 12px;
                  border-radius:8px;font-size:0.875rem;color:#334155;text-decoration:none;
                  transition:background 120ms;"
                onmouseover="this.style.background='#F8FAFC'"
                onmouseout="this.style.background=''">
                <i class="fas ${p.icon}" style="color:#2563EB;width:16px;text-align:center;font-size:0.875rem;"></i>
                ${p.label}
              </a>`).join('')}
          </div>
        </div>`;
      }
      const isAct = path === link.href;
      return `<a href="${link.href}"
        style="font-size:0.9rem;font-weight:500;color:${isAct ? '#2563EB' : '#475569'};
          text-decoration:none;transition:color 150ms;"
        onmouseover="this.style.color='#0F172A'"
        onmouseout="this.style.color='${isAct ? '#2563EB' : '#475569'}'"
        >${link.label}</a>`;
    }).join('');

    return `
    <header id="cp-marketing-header" role="banner"
      style="background:#fff;border-bottom:1px solid #E2E8F0;
        position:sticky;top:0;z-index:100;">
      <nav style="max-width:1280px;margin:0 auto;padding:0 1.5rem;
        height:68px;display:flex;align-items:center;justify-content:space-between;"
        role="navigation" aria-label="메인 네비게이션">

        <!-- 로고 -->
        <a href="/" style="font-size:1.35rem;font-weight:900;letter-spacing:-0.03em;
          color:#0F172A;text-decoration:none;flex-shrink:0;" aria-label="CloudPress 홈">
          CLOUD<span style="color:#2563EB;">PRESS</span>
        </a>

        <!-- 데스크탑 링크 -->
        <div id="cp-nav-desktop" style="display:flex;align-items:center;gap:1.75rem;">
          ${links}
        </div>

        <!-- 우측: 인증 버튼 -->
        <div style="display:flex;align-items:center;gap:0.75rem;flex-shrink:0;">

          <!-- 비로그인 -->
          <div id="nav-guest" style="display:flex;align-items:center;gap:0.5rem;">
            <a href="/login"
              style="font-size:0.875rem;font-weight:600;color:#475569;
                padding:7px 14px;border-radius:8px;text-decoration:none;transition:background 150ms;"
              onmouseover="this.style.background='#F1F5F9'"
              onmouseout="this.style.background=''">로그인</a>
            <a href="/signup"
              style="font-size:0.875rem;font-weight:700;color:#fff;
                background:#2563EB;padding:8px 18px;border-radius:8px;
                text-decoration:none;transition:background 150ms;box-shadow:0 1px 3px rgba(37,99,235,0.3);"
              onmouseover="this.style.background='#1D4ED8'"
              onmouseout="this.style.background='#2563EB'">무료 시작</a>
          </div>

          <!-- 로그인 후 프로필 -->
          <div id="nav-user" style="display:none;position:relative;">
            <button id="mkt-profile-btn" type="button"
              onclick="window.cpMktToggleProfile()"
              aria-haspopup="true" aria-expanded="false"
              style="display:flex;align-items:center;gap:8px;padding:5px 10px 5px 5px;
                border-radius:24px;border:1px solid #E2E8F0;background:#F8FAFC;
                cursor:pointer;font-family:inherit;transition:background 150ms;"
              onmouseover="this.style.background='#F1F5F9'"
              onmouseout="this.style.background='#F8FAFC'">
              <div id="mkt-avatar" style="width:28px;height:28px;border-radius:50%;
                background:#2563EB;color:#fff;font-size:0.75rem;font-weight:700;
                display:flex;align-items:center;justify-content:center;flex-shrink:0;">U</div>
              <span id="mkt-username" style="font-size:0.875rem;font-weight:600;color:#334155;
                max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
              <i class="fas fa-chevron-down" style="font-size:0.625rem;color:#94A3B8;"></i>
            </button>

            <div id="mkt-profile-dropdown" style="display:none;position:absolute;right:0;top:calc(100%+8px);
              min-width:188px;background:#fff;border:1px solid #E2E8F0;
              border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.1);padding:5px;z-index:200;">
              <a href="/dashboard" style="display:flex;align-items:center;gap:8px;padding:9px 12px;
                border-radius:8px;font-size:0.875rem;color:#334155;text-decoration:none;transition:background 120ms;"
                onmouseover="this.style.background='#F8FAFC'"
                onmouseout="this.style.background=''">
                <i class="fas fa-chart-pie" style="color:#2563EB;width:14px;text-align:center;"></i>대시보드
              </a>
              <a href="/account" style="display:flex;align-items:center;gap:8px;padding:9px 12px;
                border-radius:8px;font-size:0.875rem;color:#334155;text-decoration:none;transition:background 120ms;"
                onmouseover="this.style.background='#F8FAFC'"
                onmouseout="this.style.background=''">
                <i class="fas fa-user-circle" style="color:#2563EB;width:14px;text-align:center;"></i>내 정보
              </a>
              <hr style="border:none;border-top:1px solid #F1F5F9;margin:3px 0;">
              <button onclick="window.cpLogout()"
                style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;
                  font-size:0.875rem;color:#EF4444;width:100%;text-align:left;background:none;
                  border:none;cursor:pointer;font-family:inherit;transition:background 120ms;"
                onmouseover="this.style.background='#FEF2F2'"
                onmouseout="this.style.background=''">
                <i class="fas fa-sign-out-alt" style="width:14px;text-align:center;"></i>로그아웃
              </button>
            </div>
          </div>

          <!-- 모바일 햄버거 -->
          <button id="cp-mkt-mobile-btn" onclick="window.cpMktToggleMobile()"
            aria-label="모바일 메뉴"
            style="display:none;background:none;border:none;cursor:pointer;
              color:#475569;font-size:1.125rem;padding:6px;border-radius:6px;transition:background 150ms;"
            onmouseover="this.style.background='#F1F5F9'"
            onmouseout="this.style.background=''">
            <i class="fas fa-bars"></i>
          </button>
        </div>
      </nav>

      <!-- 모바일 드롭다운 메뉴 -->
      <div id="cp-mkt-mobile-menu" style="display:none;border-top:1px solid #F1F5F9;
        background:#fff;padding:0.75rem 1.5rem 1.25rem;">
        ${NAV_LINKS.filter(l => !l.isProducts).map(l => `
          <a href="${l.href}" style="display:block;padding:10px 0;font-size:0.9rem;
            font-weight:500;color:#475569;text-decoration:none;
            border-bottom:1px solid #F8FAFC;"
          >${l.label}</a>`).join('')}
        <div style="margin-top:0.875rem;display:grid;grid-template-columns:1fr 1fr;gap:0.625rem;">
          <a href="/login" style="text-align:center;padding:10px;border-radius:8px;
            border:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#475569;
            text-decoration:none;">로그인</a>
          <a href="/signup" style="text-align:center;padding:10px;border-radius:8px;
            background:#2563EB;font-size:0.875rem;font-weight:700;color:#fff;
            text-decoration:none;">무료 시작</a>
        </div>
      </div>
    </header>`;
  }

  function inject() {
    const mount = document.getElementById('cp-nav-mount');
    if (mount) {
      mount.innerHTML = navbarHtml();
    } else {
      document.body.insertAdjacentHTML('afterbegin', navbarHtml());
    }
    initDropdowns();
    checkAuth();
    handleResize();
    window.addEventListener('resize', handleResize);
  }

  function initDropdowns() {
    document.querySelectorAll('.cp-nav-dropdown-btn').forEach(btn => {
      const wrap = btn.closest('.cp-nav-dropdown-wrap');
      const dd   = wrap?.querySelector('.cp-nav-dropdown');
      if (!dd) return;
      btn.addEventListener('click', () => {
        const open = dd.style.display === 'block';
        dd.style.display = open ? 'none' : 'block';
        btn.setAttribute('aria-expanded', String(!open));
      });
      document.addEventListener('click', e => {
        if (!wrap.contains(e.target)) {
          dd.style.display = 'none';
          btn.setAttribute('aria-expanded', 'false');
        }
      });
    });
  }

  function handleResize() {
    const mobile    = window.innerWidth < 768;
    const desktop   = document.getElementById('cp-nav-desktop');
    const mobileBtn = document.getElementById('cp-mkt-mobile-btn');
    if (desktop)   desktop.style.display   = mobile ? 'none' : 'flex';
    if (mobileBtn) mobileBtn.style.display = mobile ? 'block' : 'none';
  }

  async function checkAuth() {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const user = await res.json();
      const name = user.name || user.email?.split('@')[0] || '사용자';
      const guestEl = document.getElementById('nav-guest');
      const userEl  = document.getElementById('nav-user');
      if (guestEl) guestEl.style.display = 'none';
      if (userEl)  userEl.style.display  = 'block';
      const avatar   = document.getElementById('mkt-avatar');
      const username = document.getElementById('mkt-username');
      if (avatar)   avatar.textContent   = name.charAt(0).toUpperCase();
      if (username) username.textContent = name;
    } catch {}
  }

  window.cpMktToggleProfile = function () {
    const dd  = document.getElementById('mkt-profile-dropdown');
    const btn = document.getElementById('mkt-profile-btn');
    if (!dd) return;
    const open = dd.style.display === 'block';
    dd.style.display = open ? 'none' : 'block';
    btn?.setAttribute('aria-expanded', String(!open));
    if (!open) {
      const close = e => {
        if (!dd.contains(e.target) && !btn?.contains(e.target)) {
          dd.style.display = 'none';
          btn?.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  };

  window.cpMktToggleMobile = function () {
    const menu = document.getElementById('cp-mkt-mobile-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  if (!window.cpLogout) {
    window.cpLogout = async function () {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('user_data');
      window.location.href = '/login';
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
