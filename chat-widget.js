/**
 * CloudPress 챗봇 위젯 v1.0
 * 모든 페이지 </body> 전에 <script src="/chat-widget.js"></script> 로 추가
 */
(function () {
  "use strict";

  // 이미 초기화됐으면 중복 실행 방지
  if (window.__cpChatLoaded) return;
  window.__cpChatLoaded = true;

  /* ── 스타일 주입 ─────────────────────────────────────────────── */
  const CSS = `
  #cp-chat-btn {
    position: fixed; bottom: 28px; right: 28px; z-index: 9998;
    width: 58px; height: 58px; border-radius: 50%;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    border: none; cursor: pointer; box-shadow: 0 4px 24px rgba(99,102,241,.5);
    display: flex; align-items: center; justify-content: center;
    transition: transform .2s, box-shadow .2s;
  }
  #cp-chat-btn:hover { transform: scale(1.08); box-shadow: 0 6px 32px rgba(99,102,241,.65); }
  #cp-chat-btn svg { width: 26px; height: 26px; fill: #fff; }
  #cp-chat-badge {
    position: absolute; top: -4px; right: -4px;
    background: #ef4444; color: #fff; font-size: 10px; font-weight: 700;
    width: 18px; height: 18px; border-radius: 50%; display: none;
    align-items: center; justify-content: center; border: 2px solid #050505;
  }
  #cp-chat-panel {
    position: fixed; bottom: 100px; right: 28px; z-index: 9999;
    width: 380px; max-width: calc(100vw - 40px);
    background: #0f0f0f; border: 1px solid rgba(255,255,255,.1);
    border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.6);
    display: flex; flex-direction: column; overflow: hidden;
    transform: scale(.9) translateY(20px); opacity: 0;
    transition: transform .25s cubic-bezier(.34,1.56,.64,1), opacity .2s;
    pointer-events: none; height: 520px;
  }
  #cp-chat-panel.open {
    transform: scale(1) translateY(0); opacity: 1; pointer-events: all;
  }
  /* 헤더 */
  #cp-chat-header {
    background: linear-gradient(135deg,#1e3a5f,#1e1b4b);
    padding: 14px 18px; display: flex; align-items: center; gap: 10px;
    border-bottom: 1px solid rgba(255,255,255,.08); flex-shrink: 0;
  }
  .cp-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: linear-gradient(135deg,#3b82f6,#6366f1);
    display: flex; align-items: center; justify-content: center; font-size: 18px;
  }
  #cp-chat-header .cp-title { flex: 1; }
  #cp-chat-header .cp-title strong { display: block; font-size: 14px; color: #fff; }
  #cp-chat-header .cp-title span { font-size: 11px; color: #34d399; }
  #cp-chat-close {
    background: none; border: none; color: rgba(255,255,255,.5);
    cursor: pointer; font-size: 18px; line-height: 1; padding: 4px;
    transition: color .15s;
  }
  #cp-chat-close:hover { color: #fff; }
  /* 탭 */
  #cp-chat-tabs {
    display: flex; border-bottom: 1px solid rgba(255,255,255,.08); flex-shrink: 0;
  }
  .cp-tab {
    flex: 1; padding: 10px; text-align: center; font-size: 12px; font-weight: 600;
    color: rgba(255,255,255,.4); cursor: pointer; border: none; background: none;
    border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
  }
  .cp-tab.active { color: #3b82f6; border-bottom-color: #3b82f6; }
  /* 메시지 영역 */
  #cp-chat-messages {
    flex: 1; overflow-y: auto; padding: 14px; display: flex;
    flex-direction: column; gap: 10px; scroll-behavior: smooth;
  }
  #cp-chat-messages::-webkit-scrollbar { width: 4px; }
  #cp-chat-messages::-webkit-scrollbar-track { background: transparent; }
  #cp-chat-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 2px; }
  .cp-msg { display: flex; gap: 8px; align-items: flex-end; max-width: 100%; }
  .cp-msg.user { flex-direction: row-reverse; }
  .cp-bubble {
    max-width: 80%; padding: 10px 14px; border-radius: 16px;
    font-size: 13px; line-height: 1.55; word-break: break-word;
  }
  .cp-msg.bot .cp-bubble {
    background: rgba(255,255,255,.07); color: #e5e7eb; border-bottom-left-radius: 4px;
  }
  .cp-msg.user .cp-bubble {
    background: linear-gradient(135deg,#3b82f6,#6366f1); color: #fff; border-bottom-right-radius: 4px;
  }
  .cp-bubble a { color: #60a5fa; text-decoration: underline; }
  .cp-bubble strong { color: #fff; }
  .cp-bubble code { background: rgba(255,255,255,.1); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  /* 빠른 답변 칩 */
  #cp-quick-chips {
    padding: 6px 14px 10px; display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0;
  }
  .cp-chip {
    background: rgba(59,130,246,.15); border: 1px solid rgba(59,130,246,.3);
    color: #93c5fd; border-radius: 100px; padding: 5px 12px; font-size: 11px;
    cursor: pointer; white-space: nowrap; transition: background .15s;
  }
  .cp-chip:hover { background: rgba(59,130,246,.3); }
  /* 입력 영역 */
  #cp-chat-input-area {
    padding: 12px 14px; border-top: 1px solid rgba(255,255,255,.08);
    display: flex; gap: 8px; flex-shrink: 0;
  }
  #cp-chat-input {
    flex: 1; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1);
    border-radius: 12px; padding: 10px 14px; color: #fff; font-size: 13px;
    outline: none; resize: none; max-height: 80px; transition: border-color .15s;
    font-family: inherit;
  }
  #cp-chat-input:focus { border-color: #3b82f6; }
  #cp-chat-input::placeholder { color: rgba(255,255,255,.3); }
  #cp-send-btn {
    width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
    background: linear-gradient(135deg,#3b82f6,#6366f1); border: none;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: opacity .15s; align-self: flex-end;
  }
  #cp-send-btn:disabled { opacity: .4; cursor: not-allowed; }
  #cp-send-btn svg { width: 16px; height: 16px; fill: #fff; }
  /* 로딩 닷 */
  .cp-typing { display: flex; gap: 4px; align-items: center; padding: 4px 0; }
  .cp-typing span {
    width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.4);
    animation: cpDot .9s ease-in-out infinite;
  }
  .cp-typing span:nth-child(2) { animation-delay: .15s; }
  .cp-typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes cpDot { 0%,80%,100% { transform: scale(.8); opacity:.4; } 40% { transform: scale(1); opacity:1; } }
  /* 문의 폼 탭 */
  #cp-inquiry-tab {
    flex: 1; overflow-y: auto; padding: 16px; display: none; flex-direction: column; gap: 10px;
  }
  #cp-inquiry-tab.active { display: flex; }
  #cp-chat-tab-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
  .cp-field label { display: block; font-size: 11px; color: rgba(255,255,255,.5); margin-bottom: 4px; }
  .cp-field input, .cp-field textarea, .cp-field select {
    width: 100%; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
    border-radius: 10px; padding: 9px 12px; color: #fff; font-size: 13px;
    outline: none; transition: border-color .15s; font-family: inherit;
  }
  .cp-field input:focus, .cp-field textarea:focus { border-color: #3b82f6; }
  .cp-field textarea { min-height: 80px; resize: none; }
  #cp-inquiry-submit {
    background: linear-gradient(135deg,#3b82f6,#6366f1); border: none; border-radius: 12px;
    color: #fff; font-weight: 700; font-size: 14px; padding: 12px;
    cursor: pointer; transition: opacity .15s; width: 100%;
  }
  #cp-inquiry-submit:disabled { opacity: .5; cursor: not-allowed; }
  #cp-inquiry-alert { font-size: 12px; text-align: center; padding: 8px; border-radius: 8px; display: none; }
  `;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ── HTML 주입 ─────────────────────────────────────────────────── */
  const markup = `
  <button id="cp-chat-btn" title="CloudPress 지원 채팅">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 10H6v-2h12v2zm0-3H6V7h12v2z"/>
    </svg>
    <div id="cp-chat-badge">!</div>
  </button>

  <div id="cp-chat-panel">
    <div id="cp-chat-header">
      <div class="cp-avatar">☁️</div>
      <div class="cp-title">
        <strong>CloudPress 지원</strong>
        <span>● 온라인</span>
      </div>
      <button id="cp-chat-close" title="닫기">✕</button>
    </div>

    <div id="cp-chat-tabs">
      <button class="cp-tab active" data-tab="chat">💬 채팅 상담</button>
      <button class="cp-tab" data-tab="inquiry">✉️ 직접 문의</button>
    </div>

    <div id="cp-chat-tab-content">
      <!-- 채팅 탭 -->
      <div id="cp-chat-view" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
        <div id="cp-chat-messages"></div>
        <div id="cp-quick-chips"></div>
        <div id="cp-chat-input-area">
          <textarea id="cp-chat-input" placeholder="무엇이든 물어보세요..." rows="1"></textarea>
          <button id="cp-send-btn" title="전송">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

      <!-- 직접 문의 탭 -->
      <div id="cp-inquiry-tab">
        <p style="font-size:12px;color:rgba(255,255,255,.5);margin-bottom:4px;">
          담당자가 이메일로 직접 답변드립니다. (평일 기준 1영업일 이내)
        </p>
        <div class="cp-field">
          <label>이름 *</label>
          <input type="text" id="cp-inq-name" placeholder="홍길동">
        </div>
        <div class="cp-field">
          <label>이메일 *</label>
          <input type="email" id="cp-inq-email" placeholder="your@email.com">
        </div>
        <div class="cp-field">
          <label>문의 제목</label>
          <input type="text" id="cp-inq-subject" placeholder="예: 결제 오류 문의">
        </div>
        <div class="cp-field">
          <label>문의 내용 *</label>
          <textarea id="cp-inq-message" placeholder="구체적인 상황을 설명해주세요. 빠르게 도와드리겠습니다."></textarea>
        </div>
        <div id="cp-inquiry-alert"></div>
        <button id="cp-inquiry-submit">문의 보내기</button>
      </div>
    </div>
  </div>`;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = markup;
  document.body.appendChild(wrapper);

  /* ── 빠른 질문 칩 정의 ──────────────────────────────────────────── */
  const QUICK_CHIPS = [
    { label: "💰 요금 안내", text: "요금 플랜이 어떻게 되나요?" },
    { label: "🚀 사이트 생성", text: "WordPress 사이트 어떻게 만들어요?" },
    { label: "🌐 도메인 연결", text: "커스텀 도메인 연결 방법 알려주세요" },
    { label: "🐱 GitHub 연동", text: "GitHub 토큰 연동 방법이 궁금해요" },
    { label: "💳 결제 문의", text: "결제 및 환불 정책이 궁금해요" },
  ];

  /* ── 상태 ──────────────────────────────────────────────────────── */
  let isOpen = false;
  let isLoading = false;
  let activeTab = "chat";
  const history = []; // { role, content }

  /* ── DOM refs ────────────────────────────────────────────────── */
  const panel = document.getElementById("cp-chat-panel");
  const btn = document.getElementById("cp-chat-btn");
  const closeBtn = document.getElementById("cp-chat-close");
  const msgArea = document.getElementById("cp-chat-messages");
  const input = document.getElementById("cp-chat-input");
  const sendBtn = document.getElementById("cp-send-btn");
  const chipsArea = document.getElementById("cp-quick-chips");
  const tabs = document.querySelectorAll(".cp-tab");
  const chatView = document.getElementById("cp-chat-view");
  const inquiryTab = document.getElementById("cp-inquiry-tab");
  const badge = document.getElementById("cp-chat-badge");
  const inqSubmit = document.getElementById("cp-inquiry-submit");
  const inqAlert = document.getElementById("cp-inquiry-alert");

  /* ── 마크다운 경량 파싱 ───────────────────────────────────────── */
  function md(text) {
    return text
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
      .replace(/`(.+?)`/g,"<code>$1</code>")
      .replace(/\[(.+?)\]\((.+?)\)/g,'<a href="$2" target="_blank">$1</a>')
      .replace(/\n/g,"<br>")
      .replace(/^• /gm, "• ");
  }

  /* ── 메시지 추가 ───────────────────────────────────────────────── */
  function addMsg(role, content, isTyping = false) {
    const div = document.createElement("div");
    div.className = `cp-msg ${role}`;
    if (isTyping) {
      div.id = "cp-typing-indicator";
      div.innerHTML = `<div class="cp-bubble"><div class="cp-typing"><span></span><span></span><span></span></div></div>`;
    } else {
      div.innerHTML = `<div class="cp-bubble">${md(content)}</div>`;
    }
    msgArea.appendChild(div);
    msgArea.scrollTop = msgArea.scrollHeight;
    return div;
  }

  /* ── 환영 메시지 ────────────────────────────────────────────────── */
  function showWelcome() {
    if (msgArea.children.length > 0) return;
    addMsg("bot", "안녕하세요! ☁️ **CloudPress** 지원 챗봇입니다.\n\n궁금한 점을 입력하시거나, 아래 버튼을 눌러 빠르게 확인해보세요!");
    renderChips();
  }

  function renderChips() {
    chipsArea.innerHTML = "";
    QUICK_CHIPS.forEach(chip => {
      const el = document.createElement("button");
      el.className = "cp-chip";
      el.textContent = chip.label;
      el.onclick = () => { sendMessage(chip.text); };
      chipsArea.appendChild(el);
    });
  }

  /* ── 메시지 전송 ────────────────────────────────────────────────── */
  async function sendMessage(text) {
    text = (text || input.value).trim();
    if (!text || isLoading) return;
    input.value = "";
    chipsArea.innerHTML = ""; // 칩 숨김

    addMsg("user", text);
    history.push({ role: "user", content: text });

    isLoading = true;
    sendBtn.disabled = true;
    const typingEl = addMsg("bot", "", true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(-6) }),
      });
      const data = await res.json();
      typingEl.remove();

      const answer = data.answer || "죄송합니다, 응답을 가져올 수 없었습니다. 직접 문의 탭을 이용해주세요.";
      addMsg("bot", answer);
      history.push({ role: "assistant", content: answer });

      // 직접 문의 유도 힌트 (3번째 AI 응답 이후)
      if (history.filter(h => h.role === "assistant").length === 3) {
        setTimeout(() => {
          addMsg("bot", "💡 원하시는 답변을 찾지 못하셨나요? **직접 문의** 탭에서 담당자에게 문의하시면 1영업일 내 답변드립니다.");
          badge.style.display = "flex";
        }, 800);
      }
    } catch (e) {
      typingEl.remove();
      addMsg("bot", "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    }

    isLoading = false;
    sendBtn.disabled = false;
    input.focus();
  }

  /* ── 탭 전환 ────────────────────────────────────────────────────── */
  function switchTab(tab) {
    activeTab = tab;
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    if (tab === "chat") {
      chatView.style.display = "flex";
      inquiryTab.classList.remove("active");
      badge.style.display = "none";
    } else {
      chatView.style.display = "none";
      inquiryTab.classList.add("active");
      // 로그인 정보 자동 채우기
      try {
        const u = JSON.parse(localStorage.getItem("user") || "{}");
        if (u.email) document.getElementById("cp-inq-email").value = u.email;
        if (u.name) document.getElementById("cp-inq-name").value = u.name;
      } catch {}
    }
  }

  /* ── 패널 토글 ──────────────────────────────────────────────────── */
  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle("open", isOpen);
    if (isOpen) { showWelcome(); input.focus(); }
  }

  /* ── 직접 문의 전송 ──────────────────────────────────────────────── */
  async function submitInquiry() {
    const name = document.getElementById("cp-inq-name").value.trim();
    const email = document.getElementById("cp-inq-email").value.trim();
    const subject = document.getElementById("cp-inq-subject").value.trim();
    const message = document.getElementById("cp-inq-message").value.trim();

    if (!name || !email || !message) {
      showInqAlert("이름, 이메일, 문의 내용은 필수입니다.", "error");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showInqAlert("올바른 이메일 주소를 입력해주세요.", "error");
      return;
    }

    inqSubmit.disabled = true;
    inqSubmit.textContent = "전송 중...";

    try {
      let user_id = null;
      try { user_id = JSON.parse(localStorage.getItem("user") || "{}").id || null; } catch {}
      const token = localStorage.getItem("token") || localStorage.getItem("admin_token") || "";

      const res = await fetch("/api/chat/inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name, email, subject, message, user_id }),
      });
      const data = await res.json();
      if (data.success) {
        showInqAlert("✅ 문의가 접수되었습니다! 빠른 시일 내에 답변드리겠습니다.", "success");
        document.getElementById("cp-inq-subject").value = "";
        document.getElementById("cp-inq-message").value = "";
      } else {
        showInqAlert(data.error || "전송에 실패했습니다.", "error");
      }
    } catch (e) {
      showInqAlert("네트워크 오류가 발생했습니다.", "error");
    }

    inqSubmit.disabled = false;
    inqSubmit.textContent = "문의 보내기";
  }

  function showInqAlert(msg, type) {
    inqAlert.style.display = "block";
    inqAlert.style.background = type === "success" ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)";
    inqAlert.style.color = type === "success" ? "#34d399" : "#f87171";
    inqAlert.style.border = `1px solid ${type === "success" ? "rgba(34,197,94,.3)" : "rgba(239,68,68,.3)"}`;
    inqAlert.textContent = msg;
    setTimeout(() => { inqAlert.style.display = "none"; }, 5000);
  }

  /* ── 이벤트 바인딩 ─────────────────────────────────────────────── */
  btn.addEventListener("click", togglePanel);
  closeBtn.addEventListener("click", () => { isOpen = false; panel.classList.remove("open"); });

  tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  sendBtn.addEventListener("click", () => sendMessage());
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 80) + "px";
  });

  inqSubmit.addEventListener("click", submitInquiry);

  // 패널 외부 클릭 시 닫기
  document.addEventListener("click", e => {
    if (isOpen && !panel.contains(e.target) && !btn.contains(e.target)) {
      isOpen = false;
      panel.classList.remove("open");
    }
  });
})();
