/**
 * 마케팅/공개 페이지 공통 헤더 + 상품 드롭다운 + 로그인 프로필 (pricing.html 동일)
 */
(function () {
  const PRODUCTS = [
    { href: "/pricing", label: "WordPress 호스팅", icon: "fa-server" },
    { href: "/product-cachecloud", label: "CacheCloud", icon: "fa-bolt" },
    { href: "/product-cp3", label: "CP3", icon: "fa-cube" },
    { href: "/product-cloudpressdb", label: "CloudPressDB", icon: "fa-database" },
  ];

  const NAV_LINKS = [
    { href: "/features", label: "기능" },
    { href: "/pricing", label: "상품", isProducts: true },
    { href: "/about", label: "소개" },
    { href: "/faq", label: "FAQ" },
    { href: "/contact", label: "문의하기" },
    { href: "/notices", label: "공지사항", optional: true },
  ];

  function injectStyles() {
    if (document.getElementById("cp-marketing-styles")) return;
    const s = document.createElement("style");
    s.id = "cp-marketing-styles";
    s.textContent = `
      #profile-dropdown { display: none; }
      #profile-dropdown.open { display: block; }
      #cp-top-profile-bar #profile-dropdown { display: none; }
      #cp-top-profile-bar #profile-dropdown.open { display: block; }
    `;
    document.head.appendChild(s);
  }

  function productDropdownHtml(isActive) {
    return `
    <div class="relative group" id="nav-products-wrap">
      <button type="button" class="flex items-center gap-1 hover:text-white transition ${isActive ? "text-white" : ""}">
        상품 <i class="fas fa-chevron-down text-[10px] opacity-60"></i>
      </button>
      <div class="absolute left-0 top-full pt-2 hidden group-hover:block z-[100] min-w-[220px]">
        <div class="bg-[#111] border border-white/10 rounded-xl shadow-2xl py-2 overflow-hidden">
          ${PRODUCTS.map((p) => `
            <a href="${p.href}" class="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition">
              <i class="fas ${p.icon} w-4 text-blue-400"></i>${p.label}
            </a>`).join("")}
        </div>
      </div>
    </div>`;
  }

  function authBlockHtml() {
    return `
    <div id="nav-guest" class="flex items-center gap-3">
      <a href="/login" class="hover:text-white transition">로그인</a>
      <a href="/signup" class="bg-blue-600 px-5 py-2 rounded-full text-white font-bold hover:bg-blue-500 transition">무료 시작</a>
    </div>
    <div id="nav-user" class="hidden relative">
      <button id="profile-btn" type="button"
        class="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full pl-3 pr-4 py-2 transition">
        <div id="avatar-circle"
          class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0"></div>
        <span id="nav-email" class="text-sm text-white max-w-[120px] truncate"></span>
        <i class="fas fa-chevron-down text-xs text-gray-400 ml-1"></i>
      </button>
      <div id="profile-dropdown"
        class="absolute right-0 top-full mt-2 w-52 bg-[#111] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-[200]">
        <div class="px-4 py-3 border-b border-white/5">
          <div class="text-xs text-gray-500">로그인됨</div>
          <div id="dropdown-email" class="text-sm font-medium text-white mt-0.5 truncate"></div>
        </div>
        <div class="py-1">
          <a href="/dashboard" class="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition">
            <i class="fas fa-tachometer-alt w-4 text-blue-400"></i> 콘솔 이동하기
          </a>
          <a href="/services" class="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition">
            <i class="fas fa-th-large w-4 text-violet-400"></i> 전체 서비스
          </a>
          <a href="/account" class="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition">
            <i class="fas fa-user-circle w-4 text-gray-400"></i> 내 정보 관리
          </a>
          <a href="/payment" class="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-white/5 hover:text-white transition">
            <i class="fas fa-credit-card w-4 text-gray-400"></i> 결제수단 관리
          </a>
        </div>
        <div class="border-t border-white/5 py-1">
          <button type="button" id="cp-logout-btn"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-900/20 transition">
            <i class="fas fa-sign-out-alt w-4"></i> 로그아웃
          </button>
        </div>
      </div>
    </div>`;
  }

  function buildHeaderHtml(activePath) {
    const isProductActive = PRODUCTS.some((p) => activePath === p.href || activePath.startsWith(p.href));
    const navItems = NAV_LINKS.filter((l) => !l.optional || activePath === "/notices").map((l) => {
      if (l.isProducts) return productDropdownHtml(isProductActive);
      const active = activePath === l.href ? "text-white" : "hover:text-white transition";
      return `<a href="${l.href}" class="${active}">${l.label}</a>`;
    }).join("");

    return `
    <header class="cp-marketing-header p-5 border-b border-white/10 sticky top-0 bg-[#050505]/90 backdrop-blur-lg z-50">
      <div class="max-w-7xl mx-auto flex justify-between items-center">
        <a href="/" class="text-2xl font-black tracking-tighter text-blue-500">CLOUD<span class="text-white">PRESS</span></a>
        <nav class="hidden md:flex gap-8 items-center text-sm font-medium text-gray-400">
          ${navItems}
          ${authBlockHtml()}
        </nav>
        <button id="mobileMenuBtn" type="button" class="md:hidden text-gray-400 hover:text-white p-2" aria-label="메뉴">
          <i class="fas fa-bars text-xl"></i>
        </button>
      </div>
      <div id="mobileMenu" class="hidden md:hidden border-t border-white/10 mt-3 pt-3 pb-2 px-4 space-y-1">
        <a href="/features" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">기능</a>
        <a href="/pricing" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">WordPress 호스팅</a>
        <a href="/product-cachecloud" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">CacheCloud</a>
        <a href="/product-cp3" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">CP3</a>
        <a href="/product-cloudpressdb" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">CloudPressDB</a>
        <a href="/about" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">소개</a>
        <a href="/faq" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">FAQ</a>
        <a href="/contact" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">문의하기</a>
        <a href="/notices" class="block px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5">공지사항</a>
        <div class="border-t border-white/10 pt-2 mt-2 space-y-1" id="mobile-guest">
          <a href="/login" class="block px-3 py-2 text-gray-400 hover:text-white text-sm">로그인</a>
          <a href="/signup" class="block px-3 py-2 bg-blue-600 text-white rounded-xl font-bold text-center text-sm">무료 시작</a>
        </div>
        <div class="border-t border-white/10 pt-2 mt-2 space-y-1 hidden" id="mobile-user">
          <a href="/dashboard" class="block px-3 py-2 text-gray-300 text-sm"><i class="fas fa-tachometer-alt mr-2 text-blue-400"></i>콘솔</a>
          <a href="/services" class="block px-3 py-2 text-gray-300 text-sm"><i class="fas fa-th-large mr-2 text-violet-400"></i>전체 서비스</a>
          <a href="/account" class="block px-3 py-2 text-gray-300 text-sm"><i class="fas fa-user-circle mr-2"></i>내 정보</a>
          <a href="/payment" class="block px-3 py-2 text-gray-300 text-sm"><i class="fas fa-credit-card mr-2"></i>결제수단</a>
          <button type="button" id="cp-mobile-logout" class="w-full text-left px-3 py-2 text-red-400 text-sm"><i class="fas fa-sign-out-alt mr-2"></i>로그아웃</button>
        </div>
      </div>
    </header>`;
  }

  function upgradeExistingHeader(header, path) {
    const nav = header.querySelector("nav.hidden.md\\:flex, nav.md\\:flex");
    if (!nav) return false;
    if (!nav.querySelector("#nav-guest")) {
      const loginLink = nav.querySelector('a[href="/login"]');
      const signupLink = nav.querySelector('a[href="/signup"]');
      if (loginLink) loginLink.remove();
      if (signupLink) signupLink.remove();
      nav.insertAdjacentHTML("beforeend", authBlockHtml());
    }
    if (!nav.querySelector("#nav-products-wrap")) {
      const pricingLink = nav.querySelector('a[href="/pricing"]');
      if (pricingLink) {
        const wrap = document.createElement("div");
        wrap.innerHTML = productDropdownHtml(PRODUCTS.some((p) => path.startsWith(p.href)));
        pricingLink.replaceWith(wrap.firstElementChild);
      }
    }
    if (!header.querySelector("#mobileMenu")) {
      const btn = header.querySelector("#mobileMenuBtn");
      if (btn) {
        btn.insertAdjacentHTML("afterend", document.createElement("div").innerHTML); // skip complex
      }
    } else {
      upgradeMobileMenu(header);
    }
    if (!header.querySelector("#mobileMenuBtn")) {
      const inner = header.querySelector(".max-w-7xl, .flex.justify-between");
      if (inner) {
        inner.insertAdjacentHTML("beforeend",
          '<button id="mobileMenuBtn" type="button" class="md:hidden text-gray-400 hover:text-white p-2"><i class="fas fa-bars text-xl"></i></button>');
      }
    }
    header.classList.add("cp-marketing-header");
    return true;
  }

  function upgradeMobileMenu(header) {
    const menu = header.querySelector("#mobileMenu");
    if (!menu || menu.querySelector("#mobile-guest")) return;
    menu.insertAdjacentHTML("beforeend", `
      <div class="border-t border-white/10 pt-2 mt-2 space-y-1" id="mobile-guest">
        <a href="/login" class="block px-3 py-2 text-gray-400 text-sm">로그인</a>
        <a href="/signup" class="block px-3 py-2 bg-blue-600 text-white rounded-xl font-bold text-center text-sm">무료 시작</a>
      </div>
      <div class="border-t border-white/10 pt-2 mt-2 space-y-1 hidden" id="mobile-user">
        <a href="/dashboard" class="block px-3 py-2 text-gray-300 text-sm">콘솔 이동</a>
        <a href="/account" class="block px-3 py-2 text-gray-300 text-sm">내 정보</a>
        <button type="button" id="cp-mobile-logout" class="w-full text-left px-3 py-2 text-red-400 text-sm">로그아웃</button>
      </div>`);
  }

  function replaceHeader(path) {
    const old = document.querySelector("header.cp-marketing-header, body > header:first-of-type");
    if (!old) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = buildHeaderHtml(path);
    old.replaceWith(tmp.firstElementChild);
  }

  function setupMobileMenu() {
    const btn = document.getElementById("mobileMenuBtn");
    const menu = document.getElementById("mobileMenu");
    if (btn && menu) {
      btn.addEventListener("click", () => menu.classList.toggle("hidden"));
    }
  }

  function bindProfileEvents() {
    const btn = document.getElementById("profile-btn");
    const menu = document.getElementById("profile-dropdown");
    if (btn && menu) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.classList.toggle("open");
      });
    }
    document.addEventListener("click", (e) => {
      if (!menu || !btn) return;
      if (!btn.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.remove("open");
      }
    });
    document.getElementById("cp-logout-btn")?.addEventListener("click", doLogout);
    document.getElementById("cp-mobile-logout")?.addEventListener("click", doLogout);
  }

  window.toggleProfileMenu = function () {
    document.getElementById("profile-dropdown")?.classList.toggle("open");
  };

  window.doLogout = async function () {
    const token = localStorage.getItem("admin_token");
    try {
      if (token) {
        await fetch("/api/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {}
    localStorage.removeItem("admin_token");
    sessionStorage.clear();
    window.location.href = "/login";
  };

  function showLoggedIn(email) {
    document.getElementById("nav-guest")?.classList.add("hidden");
    document.getElementById("nav-user")?.classList.remove("hidden");
    const e = email || "";
    document.getElementById("nav-email") && (document.getElementById("nav-email").textContent = e);
    document.getElementById("dropdown-email") && (document.getElementById("dropdown-email").textContent = e);
    const av = document.getElementById("avatar-circle");
    if (av) av.textContent = e ? e[0].toUpperCase() : "?";
    document.getElementById("mobile-guest")?.classList.add("hidden");
    document.getElementById("mobile-user")?.classList.remove("hidden");
    syncTopProfileBar(email);
  }

  function syncTopProfileBar(email) {
    const bar = document.getElementById("cp-top-profile-bar");
    if (!bar) return;
    bar.querySelector("#nav-guest")?.classList.add("hidden");
    bar.querySelector("#nav-user")?.classList.remove("hidden");
    const e = email || "";
    const ne = bar.querySelector("#nav-email");
    const de = bar.querySelector("#dropdown-email");
    const av = bar.querySelector("#avatar-circle");
    if (ne) ne.textContent = e;
    if (de) de.textContent = e;
    if (av) av.textContent = e ? e[0].toUpperCase() : "?";
  }

  async function checkAuth() {
    const token = localStorage.getItem("admin_token");
    if (!token) return;
    try {
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.email || data?.id) showLoggedIn(data.email || "");
    } catch {}
  }

  function isConsoleLayout() {
    return document.body.classList.contains("cp-console")
      || /^\/(dashboard|hosting|traffic|storage|account|payment|payments|domains|dns|services|hosting-create|hosting-detail)(\/|$)/.test(location.pathname);
  }

  function isAdminLayout() {
    return document.body.classList.contains("cp-admin")
      || /^\/admin/.test(location.pathname);
  }

  function injectConsoleTopProfile() {
    if (!isConsoleLayout() && !isAdminLayout()) return;
    if (document.getElementById("cp-top-profile-bar")) return;
    const wrap = document.createElement("div");
    wrap.id = "cp-top-profile-bar";
    wrap.className = "hidden md:block fixed top-4 right-6 z-[60]";
    wrap.innerHTML = `<div class="relative">${authBlockHtml()}</div>`;
    document.body.appendChild(wrap);
    bindProfileEvents();
    checkAuth();
  }

  function init() {
    injectStyles();
    const path = window.location.pathname;

    const authOnlyPages = /^\/(login|signup|payment-success)(\/|$)/.test(path);

    if (isConsoleLayout() || isAdminLayout() || authOnlyPages) {
      injectConsoleTopProfile();
      if (isConsoleLayout() || isAdminLayout() || authOnlyPages) return;
    }

    if (document.body.dataset.cpMarketing === "false") return;

    const header = document.querySelector("body > header:first-of-type");
    const simpleNav = header && !header.querySelector("#nav-guest") && header.querySelector('a[href="/login"]');

    if (simpleNav || document.body.dataset.cpMarketing === "replace-header") {
      replaceHeader(path);
    } else if (header) {
      upgradeExistingHeader(header, path);
      upgradeMobileMenu(header);
    } else if (document.body.dataset.cpMarketing === "true") {
      document.body.insertAdjacentHTML("afterbegin", buildHeaderHtml(path));
    }

    setupMobileMenu();
    bindProfileEvents();
    checkAuth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("load", () => {
    setTimeout(injectConsoleTopProfile, 100);
  });
})();
