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
   ① AI 이용 — Cloudflare Workers AI (flux-1-schnell)
──────────────────────────────────────────────────────────── */

const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/**
 * env.AI 바인딩으로 flux-1-schnell을 딱 1회 호출한다. 실패하면 null을
 * 반환해 헤드리스 카드 폴백으로 넘어가게 한다(예외를 던지지 않음).
 * 뉴런 남용 방지를 위해 재시도하지 않고, schnell 모델 권장 스텝(4)을
 * 그대로 사용한다.
 */
async function tryFluxImage(env, prompt) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return null;

  const cleanPrompt = sanitizePrompt(prompt);
  if (!cleanPrompt) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const result = await env.AI.run(
      FLUX_MODEL,
      { prompt: cleanPrompt, steps: 4 },
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    // Workers AI의 flux-1-schnell은 { image: "<base64 jpeg>" } 형태이거나
    // 런타임에 따라 ReadableStream/Uint8Array로 올 수도 있어 방어적으로 처리한다.
    let base64 = null;
    if (result && typeof result.image === "string" && result.image.length > 100) {
      base64 = result.image;
    } else if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
      base64 = bytesToBase64(result instanceof ArrayBuffer ? new Uint8Array(result) : result);
    } else if (result && result.response && typeof result.response === "string") {
      base64 = result.response;
    }

    if (!base64) return null;

    return {
      success: true,
      provider: "workers-ai-flux",
      engine: FLUX_MODEL,
      generation_mode: "text_to_image_ai_model",
      model: FLUX_MODEL,
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
    };
  } catch (err) {
    // AI 바인딩이 없거나, 무료 티어 뉴런 한도 초과, 타임아웃 등 — 조용히 폴백.
    return null;
  }
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

  // ① AI 이용 우선 시도 (flux-1-schnell, 요청당 1회만)
  const preferHeadless = payload.provider === "headless" || payload.force_headless === true || payload.force_headless === "true";
  if (!preferHeadless) {
    const fluxResult = await tryFluxImage(env, prompt || topic);
    if (fluxResult) return fluxResult;
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
    // 예외적인 경우에도 최종적으로 헤드리스 카드는 성공해야 하므로, 여기까지
    // 오면 그 자체가 심각한 버그다 — 원인을 그대로 노출한다.
    return json({ error: String(error?.message || error), success: false }, 500);
  }
}

export { CORS_HEADERS };
