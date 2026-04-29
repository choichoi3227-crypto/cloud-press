// src/auth-frontend.js
function logout() {
    localStorage.removeItem('admin_token');
    window.location.href = '/login.html';
}

// JWT 토큰에서 페이로드 디코딩 (클라이언트 측에서만 사용, 보안에 민감한 정보는 백엔드에서 처리)
function decodeJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (e) {
        return null;
    }
}

// ── 모바일 반응형 사이드바 ──────────────────────────────────────────────────
function initMobileSidebar() {
    const sidebar = document.querySelector('aside.dash-sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    const menuBtn = document.querySelector('.mobile-menu-btn');
    if (!sidebar || !overlay || !menuBtn) return;

    menuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    });

    // 사이드바 링크 클릭 시 자동 닫기 (모바일)
    sidebar.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    });
}

// 페이지 로드 시 사용자 이메일 표시 (dashboard.html 등에서 사용)
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('admin_token');
    if (token) {
        const payload = decodeJwt(token);
        if (payload && payload.email) {
            const userEmailSpan = document.getElementById('user-email');
            if (userEmailSpan) userEmailSpan.innerText = payload.email;
            const userDisplay = document.getElementById('user-display');
            if (userDisplay) userDisplay.innerHTML = `환영합니다, <span class="font-bold">${payload.email}</span>!`;
        }
    }

    // 모바일 사이드바 초기화
    initMobileSidebar();
});
