/**
 * image-core.js
 * /api/image — 썸네일/포스터 이미지 생성 엔드포인트.
 *
 * ⚠️ 2026-08(v6) 전면 재작성:
 * 이전 버전(v3~v5)은 외부 의존성 없이 프롬프트를 해시값으로 바꿔 좌표별로
 * sin/cos/tanh 수식을 계산하는 "절차적 노이즈 비트맵" 생성기였다. 이는
 * 텍스트·레이아웃이 있는 실제 카드가 아니라 의미 없는 추상 색상 패턴만
 * 만들어낼 뿐이라, zorlinq32 플러그인의 "헤드리스 브라우저(HTML/CSS 카드를
 * 그대로 스크린샷)" 방식과는 결과물이 근본적으로 달랐다. 이번 개편에서
 * 완전히 새로운 2단계 파이프라인으로 교체한다.
 *
 * 우선순위:
 *   ① AI 이용 — Cloudflare Workers AI 바인딩(env.AI)이 설정되어 있으면
 *      @cf/black-forest-labs/flux-1-schnell(무료 티어에서 가장 가벼운 이미지
 *      모델)을 요청당 딱 1회만 호출해 실제 텍스트-투-이미지 생성을 시도한다.
 *      실패(바인딩 없음/오류/타임아웃)하면 즉시 ②로 폴백한다.
 *      뉴런 남용 방지: 재시도 없이 1회만 호출하고, 스텝 수도 schnell 모델의
 *      권장값(4 steps)을 넘기지 않는다.
 *   ② 헤드리스 브라우저 방식 — zorlinq32 플러그인이 로컬 Chrome/Chromium으로
 *      HTML/CSS 카드를 스크린샷 찍던 것과 동일한 레이아웃(배경 그라디언트,
 *      블러 처리된 원형/캡슐 도형, 유리질(glassmorphism) 패널, 상단 배지,
 *      제목/부제목 타이포그래피)을 이 워커 안에서 SVG로 직접 합성한다.
 *      외부 API·브라우저 바인딩이 전혀 필요 없어 항상 성공한다.
 *
 * 응답은 항상 { success, provider, format, mime_type, data_url, ... } 형태이며,
 * WordPress 플러그인은 provider 필드로 어느 경로에서 만들어졌는지 판별한다.
 */

import { CORS_HEADERS, json } from "./search-core.js";

const MAX_PROMPT_LENGTH = 900;

/* ────────────────────────────────────────────────────────────
   공통 유틸
──────────────────────────────────────────────────────────── */

function sanitizePrompt(prompt) {
  return String(prompt || "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROMPT_LENGTH);
}

function escapeXml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * 긴 텍스트를 카드 폭에 맞춰 여러 줄로 나눈다. 한글/영문 혼용을 고려해
 * 글자 수 기준(대략치)으로 감아준다 — 워커 안에는 실제 폰트 metrics를
 * 측정할 방법이 없으므로, 폰트 크기 대비 평균 문자 폭을 근사값으로 사용한다.
 */
function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) lines.push("");
  // 마지막 줄이 잘렸으면 말줄임표 표기
  if (words.join(" ").length > lines.join(" ").length) {
    const last = lines[lines.length - 1];
    if (!last.endsWith("…")) lines[lines.length - 1] = last.replace(/.{1,3}$/, "…");
  }
  return lines;
}

/* ────────────────────────────────────────────────────────────
   ② 헤드리스 브라우저 방식(카드 SVG 합성)
   — zorlinq32 플러그인 build_headless_image_html()과 동일한 디자인 언어
──────────────────────────────────────────────────────────── */

const STYLE_THEMES = {
  poster: {
    background: "#0f172a", accent: "#38bdf8", accent2: "#f97316",
    text: "#f8fafc", panel: "rgba(255,255,255,0.08)", shape: "rgba(56,189,248,0.28)",
  },
  minimal: {
    background: "#f8fafc", accent: "#2563eb", accent2: "#111827",
    text: "#111827", panel: "rgba(17,24,39,0.05)", shape: "rgba(37,99,235,0.16)",
  },
  typography: {
    background: "#111827", accent: "#fb923c", accent2: "#f8fafc",
    text: "#f8fafc", panel: "rgba(255,255,255,0.08)", shape: "rgba(251,146,60,0.24)",
  },
  branding: {
    background: "#090e18", accent: "#f43f5e", accent2: "#a855f7",
    text: "#ffffff", panel: "rgba(255,255,255,0.08)", shape: "rgba(244,63,94,0.22)",
  },
  photo_realistic: {
    background: "#1f2937", accent: "#22c55e", accent2: "#38bdf8",
    text: "#ecfccb", panel: "rgba(255,255,255,0.08)", shape: "rgba(34,197,94,0.2)",
  },
};

function pickTheme(style) {
  return STYLE_THEMES[style] || STYLE_THEMES.poster;
}

// 한글이 네모(□)로 깨지지 않도록, 서버/브라우저에 흔히 설치되어 있는 한글
// 웹폰트를 우선순위대로 나열한다. 시스템 폰트 렌더러(SVG rasterizer, 브라우저,
// WordPress 미디어 라이브러리 썸네일 등)는 목록의 첫 번째로 발견되는 폰트를
// 사용하므로, 하나라도 있으면 깨지지 않는다.
const FONT_STACK = "'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";

/**
 * 헤드리스 브라우저(HTML/CSS 카드)와 시각적으로 동일한 결과를 내는 SVG를
 * 직접 합성한다. Cloudflare Workers 런타임에는 실제 브라우저 렌더링 엔진이
 * 없으므로, blur 필터·둥근 도형·유리질 패널·타이포그래피를 SVG 프리미티브로
 * 재현해 사실상 동일한 레이아웃을 만든다. SVG는 img 태그로 바로 표시되고
 * WordPress 미디어 라이브러리에도 그대로 업로드할 수 있다.
 */
function renderCardSvg({ topic, subtitle, style, width = 1600, height = 900 }) {
  const theme = pickTheme(style);
  const seed = hashString(`${topic}|${style}`);

  const titleLines = wrapText(topic, 16, 3);
  const subtitleLines = wrapText(subtitle && subtitle !== topic ? subtitle : `Visual concept for ${topic}`, 44, 2);

  const titleFontSize = titleLines.length >= 3 ? 64 : titleLines.length === 2 ? 76 : 92;
  const titleLineHeight = titleFontSize * 1.08;

  const badgeLabel = `${style.charAt(0).toUpperCase()}${style.slice(1)} style thumbnail`;

  // shape 위치는 seed로 살짝 변주해 스타일이 같아도 매번 완전히 동일하진 않게 한다.
  const shapeOffsetX = -120 + (seed % 60);
  const shapeOffsetY = 120 + ((seed >> 4) % 60);

  const panelX = 80, panelY = 80, panelW = width - 160, panelH = height - 160;
  const panelInnerPad = 48;

  const titleTspans = titleLines
    .map((line, i) => `<tspan x="${panelX + panelInnerPad}" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const subtitleY = panelY + panelH - panelInnerPad - (subtitleLines.length - 1) * 44 - 40;
  const subtitleTspans = subtitleLines
    .map((line, i) => `<tspan x="${panelX + panelInnerPad}" dy="${i === 0 ? 0 : 44}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="blurLg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55"/></filter>
    <filter id="blurMd" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="36"/></filter>
    <filter id="panelShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="24" stdDeviation="34" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.background}"/>
      <stop offset="100%" stop-color="${theme.background}" stop-opacity="0.92"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgGrad)"/>

  <circle cx="${shapeOffsetX}" cy="${shapeOffsetY}" r="340" fill="${theme.shape}" filter="url(#blurLg)"/>
  <ellipse cx="${width - 100}" cy="${height - 80}" rx="260" ry="240" fill="${theme.accent}" opacity="0.22" filter="url(#blurMd)" transform="rotate(22 ${width - 100} ${height - 80})"/>
  <rect x="220" y="${height * 0.58}" width="660" height="220" rx="120" fill="${theme.accent2}" opacity="0.14" filter="url(#blurMd)"/>

  <rect x="${width - 320}" y="80" width="240" height="60" rx="28" fill="rgba(255,255,255,0.1)"/>
  <text x="${width - 200}" y="118" text-anchor="middle" font-family="${FONT_STACK}" font-size="16" letter-spacing="2" fill="${theme.text}" fill-opacity="0.9" font-weight="600">${escapeXml(badgeLabel.toUpperCase())}</text>

  <g filter="url(#panelShadow)">
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="36" fill="${theme.panel}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  </g>

  <rect x="${panelX + panelInnerPad}" y="${panelY + panelInnerPad}" width="${Math.min(360, [...topic].length * 22 + 60)}" height="52" rx="26" fill="rgba(255,255,255,0.08)"/>
  <text x="${panelX + panelInnerPad + 20}" y="${panelY + panelInnerPad + 34}" font-family="${FONT_STACK}" font-size="18" letter-spacing="1" fill="${theme.text}" fill-opacity="0.9">${escapeXml(topic.slice(0, 24))}</text>

  <text x="${panelX + panelInnerPad}" y="${panelY + panelInnerPad + 130}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="800" letter-spacing="-1" fill="${theme.text}">${titleTspans}</text>

  <text x="${panelX + panelInnerPad}" y="${subtitleY}" font-family="${FONT_STACK}" font-size="30" fill="${theme.text}" fill-opacity="0.85">${subtitleTspans}</text>

  <text x="${panelX + panelInnerPad}" y="${panelY + panelH - 20}" font-family="${FONT_STACK}" font-size="15" fill="${theme.text}" fill-opacity="0.6">cloud-press · headless card renderer</text>
</svg>`;

  return svg;
}

function generateHeadlessCard({ prompt, topic, subtitle, style, width, height }) {
  const effectiveTopic = sanitizePrompt(topic || prompt).slice(0, 80) || "Untitled";
  const svg = renderCardSvg({
    topic: effectiveTopic,
    subtitle: sanitizePrompt(subtitle || "").slice(0, 140),
    style: style || "poster",
    width: width || 1600,
    height: height || 900,
  });
  const svgBase64 = bytesToBase64(new TextEncoder().encode(svg));

  return {
    success: true,
    provider: "headless-card",
    engine: "cloud-press-svg-card-renderer",
    generation_mode: "headless_browser_equivalent_svg_card",
    model: "local-svg-card",
    external_ai_used: false,
    cost_usd: 0,
    format: "svg",
    mime_type: "image/svg+xml",
    encoding: "base64",
    width: width || 1600,
    height: height || 900,
    image: svgBase64,
    image_base64: svgBase64,
    data_url: `data:image/svg+xml;base64,${svgBase64}`,
    svg,
    style: style || "poster",
    prompt: sanitizePrompt(prompt || effectiveTopic),
  };
}

/* ────────────────────────────────────────────────────────────
   ① AI 이용 — Cloudflare Workers AI (다중 모델 체인)
   ─────────────────────────────────────────────────────────────
   ⚠️ 확장(2026-08): flux-1-schnell 단일 모델 호출을 스타일별 다중 모델
   체인으로 교체한다. 모델마다 입력 파라미터·프롬프트 문법·강점이 크게
   다르므로, 모델별 프롬프트 빌더(buildModelPrompt)와 파라미터 빌더
   (buildModelInput)를 두어 "모델에 맞는 프롬프트"를 구성한 뒤 호출한다.
   체인의 각 모델은 1회씩만 시도하고(재시도 없음, 뉴런 남용 방지),
   실패하면 즉시 다음 모델로 넘어가며, 체인 전체가 실패하면 ②(헤드리스
   카드)로 폴백해 항상 성공을 보장한다.
──────────────────────────────────────────────────────────── */

const AI_MODELS = {
  FLUX_SCHNELL: "@cf/black-forest-labs/flux-1-schnell",
  FLUX2_DEV: "@cf/black-forest-labs/flux-2-dev",
  SDXL_BASE: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  SDXL_LIGHTNING: "@cf/bytedance/stable-diffusion-xl-lightning",
  DREAMSHAPER: "@cf/lykon/dreamshaper-8-lcm",
};

// 스타일별 모델 체인. 스타일의 시각적 성격에 맞춰 우선순위를 다르게 둔다.
//  - poster/branding: SDXL Lightning(빠르고 대비가 강한 포스터풍) → flux-schnell → dreamshaper
//  - minimal/typography: flux-schnell(깔끔한 지시 이행) → SDXL base → dreamshaper
//  - photo_realistic: dreamshaper(사실적 렌더링에 강함) → flux-2-dev → SDXL base
const STYLE_MODEL_CHAIN = {
  poster: [AI_MODELS.SDXL_LIGHTNING, AI_MODELS.FLUX_SCHNELL, AI_MODELS.DREAMSHAPER],
  branding: [AI_MODELS.SDXL_LIGHTNING, AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_BASE],
  minimal: [AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_BASE, AI_MODELS.DREAMSHAPER],
  typography: [AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_LIGHTNING, AI_MODELS.SDXL_BASE],
  photo_realistic: [AI_MODELS.DREAMSHAPER, AI_MODELS.FLUX2_DEV, AI_MODELS.SDXL_BASE, AI_MODELS.FLUX_SCHNELL],
};

function getModelChainForStyle(style) {
  return STYLE_MODEL_CHAIN[style] || STYLE_MODEL_CHAIN.poster;
}

/**
 * 모델별 프롬프트 문법이 다르므로, 공통 프롬프트를 모델에 맞게 가공한다.
 *   - FLUX 계열: 짧은 태그 나열보다 자연스러운 한두 문장 묘사를 선호하고,
 *     (word:1.4) 가중치 문법·negative_prompt 파라미터를 지원하지 않는다.
 *   - SDXL 계열(base/lightning): A1111식 가중치 문법과 negative_prompt를
 *     지원하며, 품질 향상 태그(4k, highly detailed 등)를 덧붙이면 효과가 있다.
 *   - dreamshaper(LCM): 소수 스텝(4~8)에 최적화된 체크포인트로, 과도하게
 *     긴 프롬프트보다 핵심 묘사 위주가 안정적이다.
 */
function buildModelPrompt(model, basePrompt, style) {
  const clean = sanitizePrompt(basePrompt);
  switch (model) {
    case AI_MODELS.SDXL_BASE:
    case AI_MODELS.SDXL_LIGHTNING:
      return `${clean}, professional commercial ${style} design, sharp focus, high detail, studio quality lighting, 4k`;
    case AI_MODELS.DREAMSHAPER:
      return `${clean}, clean composition, balanced lighting, crisp detail`;
    case AI_MODELS.FLUX2_DEV:
    case AI_MODELS.FLUX_SCHNELL:
    default:
      return clean;
  }
}

function buildModelNegativePrompt(model) {
  switch (model) {
    case AI_MODELS.SDXL_BASE:
    case AI_MODELS.SDXL_LIGHTNING:
      // SDXL 계열만 negative_prompt 파라미터를 지원한다.
      return "blurry, low quality, watermark, text artifacts, distorted, extra limbs, deformed";
    default:
      return null;
  }
}

function buildModelInput(model, prompt, style) {
  const shapedPrompt = buildModelPrompt(model, prompt, style);
  const negative = buildModelNegativePrompt(model);

  switch (model) {
    case AI_MODELS.SDXL_BASE:
      return { prompt: shapedPrompt, ...(negative ? { negative_prompt: negative } : {}), num_steps: 20, guidance: 7.5 };
    case AI_MODELS.SDXL_LIGHTNING:
      return { prompt: shapedPrompt, ...(negative ? { negative_prompt: negative } : {}), num_steps: 8 };
    case AI_MODELS.DREAMSHAPER:
      return { prompt: shapedPrompt, num_steps: 6, guidance: 2 };
    case AI_MODELS.FLUX2_DEV:
      return { prompt: shapedPrompt, steps: 20 };
    case AI_MODELS.FLUX_SCHNELL:
    default:
      // schnell 모델 권장값(4 steps)을 넘기지 않는다 — 뉴런 남용 방지.
      return { prompt: shapedPrompt, steps: 4 };
  }
}

/**
 * Workers AI 응답을 base64로 정규화한다. 모델/런타임에 따라
 * { image: "<base64>" } / Uint8Array / ArrayBuffer / ReadableStream /
 * { response: "<base64>" } 등 형태가 다르므로 방어적으로 처리한다.
 */
async function normalizeAiResult(result) {
  if (!result) return null;
  if (typeof result.image === "string" && result.image.length > 100) return result.image;
  if (result instanceof Uint8Array) return bytesToBase64(result);
  if (result instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(result));
  if (result && typeof result.response === "string" && result.response.length > 100) return result.response;
  if (result && typeof result.getReader === "function") {
    // ReadableStream — 전체를 모아 바이트 배열로 변환.
    const reader = result.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    if (total === 0) return null;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return bytesToBase64(merged);
  }
  return null;
}

/**
 * env.AI 바인딩으로 스타일에 맞는 모델 체인을 순서대로 1회씩 시도한다.
 * 각 모델 호출은 개별 타임아웃을 두고, 실패(바인딩 없음/예외/타임아웃/
 * 빈 응답)하면 즉시 다음 모델로 넘어간다. 체인 전체가 실패하면 null을
 * 반환해 헤드리스 카드 폴백으로 넘어가게 한다(예외를 던지지 않음).
 */
async function tryWorkersAiChain(env, prompt, style) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return null;

  const cleanPrompt = sanitizePrompt(prompt);
  if (!cleanPrompt) return null;

  const chain = getModelChainForStyle(style);

  for (const model of chain) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const input = buildModelInput(model, cleanPrompt, style);
      const result = await env.AI.run(model, input, { signal: controller.signal });
      clearTimeout(timeout);

      const base64 = await normalizeAiResult(result);
      if (!base64) continue; // 이 모델은 빈 응답 — 다음 모델로 폴백

      return {
        success: true,
        provider: "workers-ai-flux", // WordPress 플러그인이 이 값으로 "AI 생성 성공"을 판별하므로 하위 호환을 위해 고정 유지
        engine: model,
        generation_mode: "text_to_image_ai_model",
        model,
        model_chain_position: chain.indexOf(model) + 1,
        model_chain_length: chain.length,
        external_ai_used: true,
        cloudflare_ai_binding_used: true,
        cost_usd: 0,
        format: "jpeg",
        mime_type: "image/jpeg",
        encoding: "base64",
        image: base64,
        image_base64: base64,
        data_url: `data:image/jpeg;base64,${base64}`,
        prompt: cleanPrompt,
        prompt_used_for_model: buildModelPrompt(model, cleanPrompt, style),
      };
    } catch (err) {
      // 이 모델이 없거나(계정에서 미지원), 무료 티어 뉴런 한도 초과, 타임아웃 등
      // — 조용히 다음 모델로 폴백. 체인 전체가 실패해야만 헤드리스로 넘어간다.
      continue;
    }
  }

  return null;
}

/* ────────────────────────────────────────────────────────────
   진입점
──────────────────────────────────────────────────────────── */

export async function generatePromptImage(payload = {}, env = null) {
  const prompt = sanitizePrompt(payload.prompt || payload.q || "");
  const topic = sanitizePrompt(payload.topic || prompt);
  const subtitle = sanitizePrompt(payload.subtitle || payload.hero_shot || payload.visual_context || "");
  const style = String(payload.style || "poster").toLowerCase();
  const width = Math.max(512, Math.min(2048, parseInt(payload.width, 10) || 1600));
  const height = Math.max(512, Math.min(2048, parseInt(payload.height, 10) || 900));

  // ① AI 이용 우선 시도 (스타일별 모델 체인, 모델당 1회만)
  const preferHeadless = payload.provider === "headless" || payload.force_headless === true || payload.force_headless === "true";
  if (!preferHeadless) {
    const aiResult = await tryWorkersAiChain(env, prompt || topic, style);
    if (aiResult) return aiResult;
  }

  // ② 헤드리스 브라우저 방식(SVG 카드) — 항상 성공하는 최종 경로
  return generateHeadlessCard({ prompt, topic, subtitle, style, width, height });
}

export async function handleImage(request, env) {
  let payload = {};
  try {
    payload = request.method === "GET"
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json();
  } catch {
    return json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }

  const prompt = sanitizePrompt(payload.prompt || payload.q || "");
  const topic = sanitizePrompt(payload.topic || "");
  if (!prompt && !topic) {
    return json({
      error: "prompt 또는 topic이 필요합니다.",
      endpoint: "POST /api/image { prompt, topic?, subtitle?, style?, width?, height? }",
    }, 400);
  }

  try {
    const result = await generatePromptImage(payload, env);
    return json(result);
  } catch (error) {
    // generatePromptImage 내부의 AI 체인은 이미 모든 예외를 삼키고 헤드리스
    // 카드로 폴백하므로, 여기까지 예외가 올라오는 경우는 헤드리스 카드 생성
    // 자체가 실패한 것뿐이다(예: sanitizePrompt 전 잘못된 payload 타입 등).
    // 그런 경우에도 완전히 빈 손으로 500을 반환하지 않도록, 최소한의 안전
    // 헤드리스 카드를 한 번 더 직접 시도한 뒤에만 최종 오류로 넘어간다.
    try {
      const safeStyle = String(payload && payload.style || "poster").toLowerCase();
      const fallback = generateHeadlessCard({
        prompt: sanitizePrompt(payload && (payload.prompt || payload.q) || "이미지"),
        topic: sanitizePrompt(payload && (payload.topic || payload.prompt) || "이미지"),
        subtitle: "",
        style: safeStyle,
        width: 1600,
        height: 900,
      });
      return json(fallback);
    } catch (innerError) {
      return json({ error: String(error?.message || error), success: false }, 500);
    }
  }
}

export { CORS_HEADERS };
