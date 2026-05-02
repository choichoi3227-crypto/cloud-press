// src/auth-header.js
// 공개 페이지 헤더에서 로그인 상태를 감지하여 프로필 드롭다운을 표시합니다.
//
// 사용법:
// HTML 헤더에 id="nav-guest"(비로그인), id="nav-user"(로그인) 요소 준비 후
// <script src="/src/auth-header.js"></script> 삽입
//
// 필요한 HTML 구조 (pricing.html 참조):
//   - #nav-guest         : 비로그인 시 표시 (로그인/회원가입 버튼)
//   - #nav-user          : 로그인 시 표시 (프로필 드롭다운)
//   - #profile-btn       : 드롭다운 토글 버튼
//   - #profile-dropdown  : 드롭다운 메뉴
//   - #nav-email         : 이메일 표시
//   - #dropdown-email    : 드롭다운 내 이메일
//   - #avatar-circle     : 아바타 이니셜
//   - #mobile-guest      : 모바일 비로그인 섹션
//   - #mobile-user       : 모바일 로그인 섹션

(function () {
  const TOKEN   = localStorage.getItem('admin_token');
  if (!TOKEN) return; // 비로그인 - 기본 상태 유지

  const HEADERS = { Authorization: `Bearer ${TOKEN}` };

  async function init() {
    try {
      const res  = await fetch('/api/me', { headers: HEADERS });
      if (!res.ok) return;
      const text = await res.text();
      let user;
      try { user = JSON.parse(text); } catch { return; }
      if (!user?.id) return;

      applyLoggedInState(user.email);
    } catch {}
  }

  function applyLoggedInState(email) {
    const guestEl   = document.getElementById('nav-guest');
    const userEl    = document.getElementById('nav-user');
    const emailEl   = document.getElementById('nav-email');
    const ddEmail   = document.getElementById('dropdown-email');
    const avatar    = document.getElementById('avatar-circle');
    const mGuest    = document.getElementById('mobile-guest');
    const mUser     = document.getElementById('mobile-user');

    if (guestEl)  guestEl.classList.add('hidden');
    if (userEl)   userEl.classList.remove('hidden');
    if (emailEl)  emailEl.textContent = email;
    if (ddEmail)  ddEmail.textContent = email;
    if (avatar)   avatar.textContent  = email ? email[0].toUpperCase() : '?';
    if (mGuest)   mGuest.classList.add('hidden');
    if (mUser)    mUser.classList.remove('hidden');
  }

  // 드롭다운 토글
  window.toggleProfileMenu = function () {
    const menu = document.getElementById('profile-dropdown');
    if (menu) menu.classList.toggle('open');
  };

  // 외부 클릭 닫기
  document.addEventListener('click', function (e) {
    const btn  = document.getElementById('profile-btn');
    const menu = document.getElementById('profile-dropdown');
    if (menu && btn && !btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // 로그아웃
  window.doLogout = async function () {
    try { await fetch('/api/logout', { method: 'POST', headers: HEADERS }); } catch {}
    localStorage.removeItem('admin_token');
    window.location.href = '/login.html';
  };

  init();
})();
