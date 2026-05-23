/**
 * 마케팅 페이지 공통 네비 — "상품" 드롭다운
 */
(function () {
  const PRODUCTS = [
    { href: "/pricing", label: "WordPress 호스팅", icon: "fa-server" },
    { href: "/product-cachecloud", label: "CacheCloud", icon: "fa-bolt" },
    { href: "/product-cp3", label: "CP3", icon: "fa-cube" },
    { href: "/product-cloudpressdb", label: "CloudPressDB", icon: "fa-database" },
  ];

  function productDropdownHtml(activePath) {
    const isProduct = PRODUCTS.some((p) => activePath.startsWith(p.href.replace(/^\//, "")) || activePath === p.href);
    return `
    <div class="relative group" id="nav-products-wrap">
      <button type="button" class="flex items-center gap-1 hover:text-white transition ${isProduct ? 'text-white' : ''}">
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

  function patchNav() {
    const path = window.location.pathname;
    document.querySelectorAll("header nav.hidden.md\\:flex, header nav.md\\:flex").forEach((nav) => {
      const pricingLink = nav.querySelector('a[href="/pricing"]');
      if (!pricingLink || nav.querySelector("#nav-products-wrap")) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = productDropdownHtml(path);
      pricingLink.replaceWith(wrap.firstElementChild);
    });
    document.querySelectorAll('#mobileMenu a[href="/pricing"]').forEach((a) => {
      if (a.dataset.productsPatched) return;
      a.dataset.productsPatched = "1";
      a.textContent = "WordPress 호스팅";
      const parent = a.parentElement;
      PRODUCTS.filter((p) => p.href !== "/pricing").forEach((p) => {
        const link = document.createElement("a");
        link.href = p.href;
        link.className = "flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-white/5 transition text-gray-400";
        link.innerHTML = `<i class="fas ${p.icon} w-5"></i> ${p.label}`;
        parent.insertBefore(link, a.nextSibling);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", patchNav);
  } else {
    patchNav();
  }
})();
