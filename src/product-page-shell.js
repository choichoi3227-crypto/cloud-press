/** 상품 마케팅 페이지 공통 섹션 헬퍼 (인라인 스크립트에서 사용) */
window.renderProductPricing = function (plans, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = plans.map((p) => `
    <div class="plan-card p-8 bg-[#111] border border-white/10 rounded-3xl ${p.popular ? 'plan-popular' : ''}">
      ${p.popular ? '<div class="text-xs text-blue-400 font-bold mb-2">인기</div>' : ''}
      <h3 class="text-xl font-bold mb-1">${p.name}</h3>
      <div class="text-3xl font-black mb-4">${p.price}<span class="text-sm text-gray-500 font-normal">/월</span></div>
      <ul class="space-y-2 text-sm text-gray-400 mb-6">${(p.features || []).map((f) => `<li class="flex gap-2"><i class="fas fa-check text-green-400 mt-0.5"></i>${f}</li>`).join("")}</ul>
      <a href="/signup" class="block text-center py-3 rounded-xl font-bold ${p.popular ? 'bg-blue-600 hover:bg-blue-500' : 'border border-white/20 hover:bg-white/5'} transition">${p.cta || "시작하기"}</a>
    </div>`).join("");
};
