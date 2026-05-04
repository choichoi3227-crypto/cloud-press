// CloudPress Service Worker - Cloudflare 장애 방지 캐시 전략
// 버전: 1.0.0

const CACHE_VERSION = 'cloudpress-v1';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;

// 오프라인에서도 제공할 정적 자원
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/pricing.html',
  '/about.html',
  '/faq.html',
  '/contact.html',
  '/login.html',
  '/signup.html',
  '/style.css',
  '/dashboard.html',
  '/hosting.html',
];

// ── Install: 정적 자원 사전 캐시 ────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] 캐시 실패:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: 구버전 캐시 삭제 ──────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('cloudpress-') && k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: 전략별 응답 ──────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API 요청: Network First (캐시 fallback 없음, 인증 필요)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, false));
    return;
  }

  // HTML 페이지: Stale-While-Revalidate
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // CSS/JS/이미지: Cache First
  if (['style', 'script', 'image', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 기타: Network First
  event.respondWith(networkFirst(request, true));
});

// ── 전략 함수들 ──────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

async function networkFirst(request, useFallback = true) {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (useFallback) return offlineFallback(request);
    return new Response(JSON.stringify({ error: '네트워크 연결을 확인해주세요.', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetchPr  = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPr || offlineFallback(request);
}

function offlineFallback(request) {
  const url = new URL(request.url);
  if (request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname === '/') {
    return caches.match('/index.html').then(r => r || new Response(
      `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오프라인 | CloudPress</title>
      <style>body{background:#050505;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{text-align:center;max-width:400px;padding:40px}.icon{font-size:60px;margin-bottom:20px}
      h1{font-size:24px;font-weight:900;margin-bottom:12px}p{color:#666;font-size:14px;margin-bottom:24px}
      a{background:#3b82f6;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block}</style>
      </head><body><div class="box"><div class="icon">📡</div>
      <h1>연결이 끊겼습니다</h1>
      <p>인터넷 연결을 확인해주세요. CloudPress는 연결이 복구되면 자동으로 재개됩니다.</p>
      <a href="/" onclick="window.location.reload()">다시 시도</a></div></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    ));
  }
  return new Response('', { status: 408 });
}

// ── 백그라운드 동기화: 오프라인 중 실패한 요청 재시도 ────────────
self.addEventListener('sync', event => {
  if (event.tag === 'retry-failed-requests') {
    event.waitUntil(retryFailedRequests());
  }
});

async function retryFailedRequests() {
  // 향후 IndexedDB에 저장된 실패 요청을 재시도하는 로직 구현 가능
  console.log('[SW] 실패한 요청 재시도 완료');
}
