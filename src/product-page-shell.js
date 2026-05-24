/** 상품 마케팅 페이지 공통 섹션 헬퍼 (인라인 스크립트에서 사용) */

// 토스 결제 연동
const TOKEN = localStorage.getItem('admin_token');
const AUTH_HEADERS = TOKEN
  ? { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  : { 'Content-Type': 'application/json' };

let tossInstance = null;

async function initTossPayments() {
  if (!TOKEN || tossInstance) return;
  try {
    const res = await fetch('/api/payment/client-key', { headers: AUTH_HEADERS });
    if (!res.ok) return;
    const data = await res.json();
    if (data.client_key && window.TossPayments) {
      tossInstance = TossPayments(data.client_key);
    }
  } catch {}
}

// 상품 구독 여부 확인
async function checkSubscription(productType) {
  if (!TOKEN) return null;
  try {
    const res = await fetch('/api/products/subscriptions', { headers: AUTH_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const subs = data.subscriptions || [];
    return subs.find(s => s.product_type === productType && s.status === 'active') || null;
  } catch { return null; }
}

/**
 * @param {Array} plans - 플랜 배열
 * @param {string} containerId - 렌더링 컨테이너 ID
 * @param {string} productType - cpdb | cp3 | cachecloud
 */
window.renderProductPricing = async function (plans, containerId, productType) {
  const el = document.getElementById(containerId);
  if (!el) return;

  await initTossPayments();

  // 현재 구독 상태 조회
  const activeSub = productType ? await checkSubscription(productType) : null;

  el.innerHTML = plans.map((p) => {
    const isCurrentPlan = activeSub && activeSub.plan === (p.plan || p.name.toLowerCase());
    return `
    <div class="plan-card p-8 bg-[#111] border border-white/10 rounded-3xl ${p.popular ? 'plan-popular' : ''}">
      ${p.popular ? '<div class="text-xs text-blue-400 font-bold mb-2">인기</div>' : ''}
      ${isCurrentPlan ? '<div class="text-xs text-green-400 font-bold mb-2 flex items-center gap-1"><i class="fas fa-check-circle"></i> 현재 구독 중</div>' : ''}
      <h3 class="text-xl font-bold mb-1">${p.name}</h3>
      <div class="text-3xl font-black mb-1">${p.price}<span class="text-sm text-gray-500 font-normal">/월</span></div>
      <div class="text-xs text-gray-500 mb-4">연간 결제 시 20% 할인</div>
      <ul class="space-y-2 text-sm text-gray-400 mb-6">${(p.features || []).map((f) => `<li class="flex gap-2"><i class="fas fa-check text-green-400 mt-0.5"></i>${f}</li>`).join('')}</ul>
      ${isCurrentPlan
        ? `<div class="block text-center py-3 rounded-xl font-bold bg-green-900/30 border border-green-500/30 text-green-400">구독 중</div>`
        : TOKEN
          ? `<button onclick="subscribeProduct('${productType}','${p.plan || p.name.toLowerCase()}','${p.price}')" class="w-full block text-center py-3 rounded-xl font-bold ${p.popular ? 'bg-blue-600 hover:bg-blue-500' : 'border border-white/20 hover:bg-white/5'} transition">${p.cta || '구독하기'}</button>`
          : `<a href="/signup" class="block text-center py-3 rounded-xl font-bold ${p.popular ? 'bg-blue-600 hover:bg-blue-500' : 'border border-white/20 hover:bg-white/5'} transition">${p.cta || '시작하기'}</a>`
      }
    </div>`;
  }).join('');
};

// 상품 결제 요청
window.subscribeProduct = async function(productType, plan, priceDisplay) {
  if (!TOKEN) { window.location.href = '/login'; return; }

  const billing = confirm(`연간 결제를 선택하시겠습니까?\n연간 결제 시 20% 할인됩니다.`) ? 'yearly' : 'monthly';

  try {
    // 결제 요청 생성
    const res = await fetch('/api/payment/request', {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ product_type: productType, plan, billing_cycle: billing }),
    });
    const data = await res.json();
    if (!res.ok || !data.order_id) {
      alert(data.error || '결제 요청 생성에 실패했습니다.');
      return;
    }

    if (!tossInstance) {
      alert('결제 시스템을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    // 토스 결제창 열기
    await tossInstance.requestPayment('카드', {
      amount: data.amount,
      orderId: data.order_id,
      orderName: data.order_name,
      customerEmail: data.customer_email,
      customerName: data.customer_name,
      successUrl: `${window.location.origin}/payment-success?product_type=${productType}`,
      failUrl: `${window.location.origin}/payment?fail=1`,
    });
  } catch (e) {
    if (e.code !== 'USER_CANCEL') {
      alert('결제 중 오류가 발생했습니다: ' + (e.message || e));
    }
  }
};
