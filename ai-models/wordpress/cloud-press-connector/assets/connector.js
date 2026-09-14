/**
 * cloud-press-connector 프런트엔드 스크립트.
 * wp_localize_script로 주입되는 window.cpConnector = { ajaxUrl, restNonce } 를 사용한다.
 */
(function () {
  "use strict";

  function postAjax(action, formData) {
    formData.append("action", action);
    return fetch(window.cpConnector.ajaxUrl, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    }).then((res) => res.json());
  }

  function bindForm(formId, action, onSuccess) {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const messageEl = form.querySelector(".cp-form-message");
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      if (messageEl) messageEl.textContent = "";

      const formData = new FormData(form);
      // WordPress nonce 필드명을 액션별 표준 파라미터명(nonce)으로 매핑
      const nonceField = form.querySelector('input[name$="_nonce_field"]');
      if (nonceField) formData.append("nonce", nonceField.value);

      try {
        const data = await postAjax(action, formData);
        if (data.success) {
          if (messageEl) {
            messageEl.textContent = data.data.message;
            messageEl.classList.remove("cp-error");
            messageEl.classList.add("cp-success");
          }
          onSuccess && onSuccess(data.data);
        } else {
          if (messageEl) {
            messageEl.textContent = data.data.message;
            messageEl.classList.remove("cp-success");
            messageEl.classList.add("cp-error");
          }
        }
      } catch (err) {
        if (messageEl) {
          messageEl.textContent = "요청 중 오류가 발생했어요.";
          messageEl.classList.add("cp-error");
        }
      } finally {
        button.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindForm("cp-register-form", "cp_register", () => {
      window.location.reload();
    });
    bindForm("cp-login-form", "cp_login", () => {
      window.location.reload();
    });

    // 마이페이지 콘솔
    const textForm = document.getElementById("cp-text-form");
    if (textForm) {
      textForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const output = document.getElementById("cp-text-output");
        const formData = new FormData(textForm);
        const nonceField = textForm.querySelector('input[name$="_nonce_field"]');
        if (nonceField) formData.append("nonce", nonceField.value);

        output.textContent = "생각하는 중…";
        const data = await postAjax("cp_generate_text", formData);
        output.textContent = data.success ? data.data.text : data.data.message;
      });
    }

    const imageForm = document.getElementById("cp-image-form");
    if (imageForm) {
      imageForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const output = document.getElementById("cp-image-output");
        const formData = new FormData(imageForm);
        const nonceField = imageForm.querySelector('input[name$="_nonce_field"]');
        if (nonceField) formData.append("nonce", nonceField.value);

        output.textContent = "그리는 중…";
        const data = await postAjax("cp_generate_image", formData);
        if (data.success) {
          output.innerHTML = "";
          const img = document.createElement("img");
          img.src = `data:image/${data.data.format};base64,${data.data.image_base64}`;
          img.alt = "generated";
          output.appendChild(img);
        } else {
          output.textContent = data.data.message;
        }
      });
    }
  });
})();
