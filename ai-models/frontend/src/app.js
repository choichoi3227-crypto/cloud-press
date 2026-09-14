(() => {
  "use strict";

  const { API_BASE_URL, DEMO_API_KEY } = window.CLOUD_PRESS_CONFIG;

  function apiHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEMO_API_KEY}`,
    };
  }

  // ---------- 헬스체크: 두 모델의 온라인 상태 표시 ----------
  async function checkHealth() {
    const textBadge = document.getElementById("text-status");
    const imageBadge = document.getElementById("image-status");
    try {
      const res = await fetch(`${API_BASE_URL}/v1/health`);
      const data = await res.json();
      const models = data?.inference_server?.loaded_models ?? {};

      setBadge(textBadge, models.flash_texter?.ready);
      setBadge(imageBadge, models.nano_tech_artist?.ready);
    } catch (err) {
      setBadge(textBadge, false);
      setBadge(imageBadge, false);
    }
  }

  function setBadge(el, ready) {
    if (!el) return;
    if (ready) {
      el.textContent = "온라인";
      el.className = "status-badge online";
    } else {
      el.textContent = "오프라인 (더미 응답)";
      el.className = "status-badge offline";
    }
  }

  // ---------- Flash Texter ----------
  const textForm = document.getElementById("text-form");
  const textInput = document.getElementById("text-input");
  const textOutput = document.getElementById("text-output");
  const textSubmit = document.getElementById("text-submit");

  async function submitText(prompt) {
    if (!prompt.trim()) return;

    textSubmit.disabled = true;
    textOutput.innerHTML = `<p class="placeholder">생각하는 중…</p>`;

    try {
      const res = await fetch(`${API_BASE_URL}/v1/text/generate`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ prompt, max_tokens: 128 }),
      });
      const data = await res.json();

      if (!res.ok) {
        textOutput.innerHTML = `<p class="error-line">${escapeHtml(data.error ?? "요청을 처리할 수 없어요.")}</p>`;
        return;
      }
      textOutput.innerHTML = `<p class="response-line">${escapeHtml(data.text)}</p>`;
    } catch (err) {
      textOutput.innerHTML = `<p class="error-line">서버에 연결할 수 없어요. API 서버가 켜져 있는지 확인해 주세요.</p>`;
    } finally {
      textSubmit.disabled = false;
    }
  }

  textForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitText(textInput.value);
  });

  document.querySelectorAll(".example-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const example = chip.dataset.example;
      textInput.value = example;
      submitText(example);
    });
  });

  // ---------- Nano-Tech Artist ----------
  const imageForm = document.getElementById("image-form");
  const colorSelect = document.getElementById("color-select");
  const shapeSelect = document.getElementById("shape-select");
  const imageOutput = document.getElementById("image-output");
  const imageSubmit = document.getElementById("image-submit");

  async function submitImage() {
    const color = colorSelect.value;
    const shape = shapeSelect.value;

    imageSubmit.disabled = true;
    imageOutput.innerHTML = `<p class="placeholder">그리는 중…</p>`;

    try {
      const res = await fetch(`${API_BASE_URL}/v1/image/generate`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ prompt_type: "condition", color, shape }),
      });
      const data = await res.json();

      if (!res.ok) {
        imageOutput.innerHTML = `<p class="error-line">${escapeHtml(data.error ?? "이미지를 생성할 수 없어요.")}</p>`;
        return;
      }
      const img = document.createElement("img");
      img.src = `data:image/${data.format};base64,${data.image_base64}`;
      img.alt = `${color} ${shape}`;
      imageOutput.innerHTML = "";
      imageOutput.appendChild(img);
    } catch (err) {
      imageOutput.innerHTML = `<p class="error-line">서버에 연결할 수 없어요. API 서버가 켜져 있는지 확인해 주세요.</p>`;
    } finally {
      imageSubmit.disabled = false;
    }
  }

  imageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitImage();
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  checkHealth();
})();
