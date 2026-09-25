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
 * 문자 1개의 대략적인 렌더 폭을 "em(폰트 크기 대비 배수)" 단위로 추정한다.
 * Cloudflare Workers 런타임에는 실제 폰트 metrics를 측정할 방법이 없으므로,
 * 문자 종류별 평균 폭을 근사값으로 사용한다.
 *   - 한글(가-힣)·전각 기호: 대체로 정사각형에 가까움 → 1.05em
 *   - 영문 대문자/숫자: 중간 폭 → 0.68em
 *   - 영문 소문자: 조금 더 좁음 → 0.60em
 *   - 공백: 0.30em
 *   - 그 외(문장부호 등): 0.55em
 * ⚠️ 2026-08(v7) 조정: 제목은 font-weight 800(볼드)로 렌더링되어 일반
 * 굵기보다 실제 문자 폭이 넓다. 렌더러(SVG 래스터라이저)마다 폴백 폰트의
 * 실제 glyph 폭이 이 추정치와 조금씩 다를 수 있으므로, 계산에 쓰는 값을
 * 실제 평균보다 넉넉히 잡아 "폭 추정이 살짝 어긋나도 항상 넘치는 대신
 * 한 줄이 조금 일찍 접히는" 방향으로만 오차가 나게 한다(안전 마진).
 */
function estCharWidthEm(ch) {
  if (/[가-힣]/.test(ch)) return 1.05;
  if (/[A-Z0-9]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.60;
  if (ch === " ") return 0.30;
  return 0.55;
}

function estTextWidthEm(text) {
  let total = 0;
  for (const ch of String(text || "")) total += estCharWidthEm(ch);
  return total;
}

// 폭 추정치와 실제 렌더러(폰트/래스터라이저)의 오차를 흡수하기 위한 전역
// 안전 계수. 계산된 사용 가능 폭에 곱해 실제보다 살짝 더 좁게 취급한다.
const WIDTH_SAFETY_FACTOR = 0.92;

/**
 * 긴 텍스트를 "실제 폭(em)" 기준으로 여러 줄로 나눈다. maxWidthEm은 한 줄의
 * 최대 폭(폰트 크기 배수, 예: 10.5 = 10.5em)이다. 단어 단위로 우선 나누고,
 * 단어 하나가 이미 maxWidthEm을 넘으면(예: 공백 없는 긴 한글/URL) 문자
 * 단위로 강제 절단해 절대 한 줄이 폭을 넘지 않도록 보장한다.
 */
function wrapTextByWidth(text, maxWidthEm, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  let currentWidth = 0;
  let truncated = false;

  const pushLine = () => {
    if (current) lines.push(current);
    current = "";
    currentWidth = 0;
  };

  outer:
  for (const word of words) {
    if (lines.length >= maxLines) { truncated = true; break; }

    const wordWidth = estTextWidthEm(word);
    const sepWidth = current ? estCharWidthEm(" ") : 0;

    if (currentWidth + sepWidth + wordWidth <= maxWidthEm) {
      current = current ? `${current} ${word}` : word;
      currentWidth += sepWidth + wordWidth;
      continue;
    }

    // 현재 줄이 이미 차 있다면 줄바꿈부터 시도
    if (current) {
      pushLine();
      if (lines.length >= maxLines) { truncated = true; break; }
    }

    // 단어 자체가 한 줄 폭을 넘는 경우(붙어있는 긴 한글 구절 등) → 문자 단위 강제 절단
    if (wordWidth > maxWidthEm) {
      let chunk = "";
      let chunkWidth = 0;
      for (const ch of word) {
        const chW = estCharWidthEm(ch);
        if (chunkWidth + chW > maxWidthEm && chunk) {
          lines.push(chunk);
          if (lines.length >= maxLines) { truncated = true; break outer; }
          chunk = ch;
          chunkWidth = chW;
        } else {
          chunk += ch;
          chunkWidth += chW;
        }
      }
      current = chunk;
      currentWidth = chunkWidth;
    } else {
      current = word;
      currentWidth = wordWidth;
    }
  }

  if (lines.length < maxLines) {
    if (current) lines.push(current);
  } else if (current) {
    truncated = true;
  }

  if (lines.length === 0) lines.push("");

  // 원문이 다 들어가지 못했으면 마지막 줄 끝에 말줄임표 표기 (폭 초과 방지를
  // 위해 마지막 줄 자체도 필요하면 살짝 잘라낸다).
  const consumedLength = lines.join(" ").length;
  const isTruncated = truncated || String(text || "").length > consumedLength + words.length;
  if (isTruncated) {
    let last = lines[lines.length - 1] || "";
    const ellipsisWidth = estCharWidthEm("…");
    while (last.length > 0 && estTextWidthEm(last) + ellipsisWidth > maxWidthEm) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last.replace(/[…\s]+$/, "") + "…";
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

/**
 * 스타일별 레이아웃 구조. 색상(STYLE_THEMES)만으로는 스타일 간 차이가
 * 옅어(패널 위치·크기·정렬이 전부 동일하면 결국 "색만 다른 같은 카드"가
 * 됨), 각 스타일의 실제 디자인 철학에 맞춰 패널 기하·타이포 스케일·
 * 장식 요소 유무 자체를 다르게 정의한다.
 *
 *  - poster: 화면 대부분을 차지하는 대형 중앙 패널, 큰 타이틀 — 실제
 *    인쇄 포스터처럼 강한 존재감.
 *  - minimal: 좌상단의 작은 텍스트 블록 + 나머지는 여백 — 도형 하나만
 *    남기는 절제된 구성. 타이틀 최대 크기도 다른 스타일보다 작게 제한.
 *  - typography: 텍스트가 화면 대부분을 차지하는 초대형 폰트, 글리프도
 *    끄고 액센트 바만 살짝 — "텍스트가 곧 비주얼"인 스타일.
 *  - branding: 좌하단 정렬 + 상단에 짧은 액센트 바(CTA 느낌), 패널은
 *    화면 하단 60%만 차지.
 *  - photo_realistic: 유리질 패널 자체를 없애고(showPanel:false) 배경
 *    전체에 텍스트를 얹어 사진 위에 캡션이 있는 듯한 느낌.
 *
 * 모든 스타일 공통: showBadge/showWatermark 항목 자체가 없다 — 스타일명이나
 * 정형 문구를 이미지에 넣는 로직을 완전히 제거했기 때문이다.
 */
const STYLE_LAYOUTS = {
  poster: {
    panelX: (w) => w * 0.08, panelY: (h) => h * 0.10,
    panelW: (w) => w * 0.72, panelH: (h) => h * 0.80,
    pad: 56, panelRadius: 40, showPanel: true,
    maxTitleLines: 3, maxTitleFont: 100, minTitleFont: 44, titleOffsetY: 170,
    subtitleFont: 32, showGlyph: true, glyphSize: 130, glyphOpacity: 0.18, glyphAlign: "right",
    showAccentBar: false, reserveGlyph: true, bigShapeR: 360,
  },
  minimal: {
    panelX: (w) => w * 0.10, panelY: (h) => h * 0.14,
    panelW: (w) => w * 0.55, panelH: (h) => h * 0.34,
    pad: 40, panelRadius: 28, showPanel: false,
    maxTitleLines: 2, maxTitleFont: 60, minTitleFont: 32, titleOffsetY: 60,
    subtitleFont: 24, showGlyph: true, glyphSize: 64, glyphOpacity: 0.5, glyphAlign: "left",
    showAccentBar: false, reserveGlyph: false, bigShapeR: 260,
  },
  typography: {
    panelX: (w) => w * 0.09, panelY: (h) => h * 0.20,
    panelW: (w) => w * 0.82, panelH: (h) => h * 0.62,
    pad: 40, panelRadius: 0, showPanel: false,
    maxTitleLines: 3, maxTitleFont: 128, minTitleFont: 52, titleOffsetY: 140,
    subtitleFont: 30, showGlyph: false, glyphSize: 0, glyphOpacity: 0, glyphAlign: "left",
    showAccentBar: true, reserveGlyph: false, bigShapeR: 300,
  },
  branding: {
    panelX: (w) => w * 0.08, panelY: (h) => h * 0.42,
    panelW: (w) => w * 0.62, panelH: (h) => h * 0.46,
    pad: 48, panelRadius: 32, showPanel: true,
    maxTitleLines: 2, maxTitleFont: 80, minTitleFont: 40, titleOffsetY: 100,
    subtitleFont: 28, showGlyph: true, glyphSize: 100, glyphOpacity: 0.22, glyphAlign: "right",
    showAccentBar: true, reserveGlyph: true, bigShapeR: 320,
  },
  photo_realistic: {
    panelX: (w) => w * 0.08, panelY: (h) => h * 0.55,
    panelW: (w) => w * 0.84, panelH: (h) => h * 0.32,
    pad: 44, panelRadius: 0, showPanel: false,
    maxTitleLines: 2, maxTitleFont: 72, minTitleFont: 36, titleOffsetY: 60,
    subtitleFont: 26, showGlyph: true, glyphSize: 90, glyphOpacity: 0.14, glyphAlign: "right",
    showAccentBar: false, reserveGlyph: true, bigShapeR: 420,
  },
};

// 한글이 네모(□)로 깨지지 않도록, 서버/브라우저에 흔히 설치되어 있는 한글
// 웹폰트를 우선순위대로 나열한다. 시스템 폰트 렌더러(SVG rasterizer, 브라우저,
// WordPress 미디어 라이브러리 썸네일 등)는 목록의 첫 번째로 발견되는 폰트를
// 사용하므로, 하나라도 있으면 깨지지 않는다.
const FONT_STACK = "'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";

/**
 * ⚠️ 카테고리별 심볼(glyph) — 이 카드는 실제 사진/일러스트를 생성하지
 * 못하는 최후의 안전망이므로, 최소한 주제의 "종류"를 시각적으로 구분되게
 * 표시해 모든 주제가 완전히 동일한 카드로 보이는 문제를 완화한다. 각 항목은
 * SVG path 데이터(24x24 grid 기준)이며 카드 우측 하단에 큼직하게 배치된다.
 */
const CATEGORY_GLYPHS = {
  messenger: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  device: "M6 3h9a2 2 0 0 1 2 2v13H4V5a2 2 0 0 1 2-2zM3 20h16M9 6h3",
  finance: "M4 19V10M10 19V5M16 19v-7M2 19h20M4 10l6-5 6 4 4-4",
  food: "M6 3v7a3 3 0 0 0 6 0V3M9 10v11M17 3c-2 2-2 5 0 8v10",
  travel: "M2 16l7-2 4-9 2 1-3 8 6-1 2 2-8 4-2 5-2-1 1-5-7 2-1-2 3-2z",
  health: "M12 21s-7-4.4-9.5-8.6C.6 8.8 2.4 5 6 5c2 0 3.4 1.1 4 2.3C10.6 6.1 12 5 14 5c3.6 0 5.4 3.8 3.5 7.4C19 16.6 12 21 12 21z",
  education: "M2 8l10-4 10 4-10 4-10-4zM6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 8v6",
  beauty: "M12 3c1.5 2 1.5 4 0 6 1.5 2 1.5 4 0 6M6 6c1.5 1.5 1.5 3.5 0 5M18 6c-1.5 1.5-1.5 3.5 0 5M4 15c2 3 5 5 8 6 3-1 6-3 8-6",
  business: "M4 20V10l8-6 8 6v10M9 20v-6h6v6",
  environment: "M12 2c4 3 7 7 7 11a7 7 0 0 1-14 0c0-4 3-8 7-11z",
  entertainment: "M4 4l16 8-16 8V4z",
  legal: "M12 3v18M6 7h12M4 7l3 6H1l3-6zM17 7l3 6h-6l3-6z",
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  tech: "M4 4h16v12H4zM9 20h6M12 16v4M7 8h10M7 11h6",
  default: "M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.6L6 22l1.5-7.2L2 10l7.1-1.1z",
};

// 주제 문자열에서 카테고리를 추정한다 (플러그인의 topic_to_visual_concept와
// 유사한 목적이지만, 이 워커는 독립 배포이므로 자체적으로 가벼운 사전을 둔다).
const CATEGORY_KEYWORDS = [
  [/카카오톡|카톡|kakaotalk|라인|line\s*app|왓츠앱|whatsapp|텔레그램|telegram|디스코드|discord|메신저|messenger|채팅/iu, "messenger"],
  [/pc\s*버전|pc용|다운로드|download|설치|install|업데이트|update|갤럭시|galaxy|아이폰|iphone|아이패드|ipad|맥북|macbook|노트북|laptop|태블릿|모니터|스마트폰/iu, "device"],
  [/재테크|투자|주식|펀드|자산|금융|은행|대출|부동산|아파트|주택|청약|세금|회계/iu, "finance"],
  [/요리|레시피|음식|맛집|카페|커피|베이커리/iu, "food"],
  [/여행|관광|trip|해외여행|여행지|기차|열차|ktx|srt|항공권|비행기표|숙소|호텔|펜션|리조트/iu, "travel"],
  [/건강|병원|치료|영양제|비타민|다이어트|운동|헬스|피트니스/iu, "health"],
  [/교육|학습|공부|강의|수업|자격증|합격|취업준비/iu, "education"],
  [/뷰티|화장품|스킨케어|패션/iu, "beauty"],
  [/창업|스타트업|마케팅|비즈니스|취업|직장|커리어|채용|면접/iu, "business"],
  [/환경|기후|생태|반려동물|강아지|고양이/iu, "environment"],
  [/게임|gaming|e스포츠|영화|드라마|스트리밍|음악|아이돌/iu, "entertainment"],
  [/법률|계약서|보험|소송/iu, "legal"],
  [/인테리어|이사|부동산\s*매물|가전/iu, "home"],
  [/ai|인공지능|머신러닝|딥러닝|소프트웨어|프로그래밍|코딩|개발|it\b/iu, "tech"],
];

function detectCategory(text) {
  const haystack = String(text || "");
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(haystack)) return category;
  }
  return "default";
}

function categoryGlyphPath(category) {
  return CATEGORY_GLYPHS[category] || CATEGORY_GLYPHS.default;
}

/**
 * 주어진 폰트 크기(px)에서 titleLines가 실제로 패널 폭을 넘지 않는지
 * 확인하고, 넘지 않는 가장 큰 폰트 크기를 찾는다. wrapTextByWidth의 폭
 * 추정치를 그대로 사용해 "줄바꿈 계산에 쓴 폭 가정"과 "실제 그리는 폰트
 * 크기"가 항상 일치하도록 만든다 — 이전 버전은 이 둘이 따로 놀아서
 * (고정 charsPerLine vs 가변 fontSize) 긴 제목이 패널 밖으로 넘치는
 * 버그가 있었다.
 */
function fitTitle(topic, panelInnerWidth, maxLines, maxFontSize, minFontSize) {
  let fontSize = maxFontSize;
  let lines = [];
  const safeWidth = panelInnerWidth * WIDTH_SAFETY_FACTOR;
  while (fontSize >= minFontSize) {
    const maxWidthEm = safeWidth / fontSize;
    lines = wrapTextByWidth(topic, maxWidthEm, maxLines);
    // 모든 줄이 실제로 폭 안에 들어오는지 재확인 (wrapTextByWidth는 강제
    // 절단으로 보장하지만, 이중 안전장치로 한 번 더 검증).
    const allFit = lines.every((line) => estTextWidthEm(line) * fontSize <= safeWidth + 0.5);
    if (allFit) break;
    fontSize -= 4;
  }
  if (fontSize < minFontSize) fontSize = minFontSize;
  return { fontSize, lines };
}

/**
 * 헤드리스 브라우저(HTML/CSS 카드)와 시각적으로 동일한 결과를 내는 SVG를
 * 직접 합성한다. Cloudflare Workers 런타임에는 실제 브라우저 렌더링 엔진이
 * 없으므로, blur 필터·둥근 도형·유리질 패널·타이포그래피를 SVG 프리미티브로
 * 재현해 사실상 동일한 레이아웃을 만든다. SVG는 img 태그로 바로 표시되고
 * WordPress 미디어 라이브러리에도 그대로 업로드할 수 있다.
 *
 * ⚠️ 2026-08(v7) 버그 수정: 이전 버전은 wrapText()가 "글자 수" 기준으로
 * 줄바꿈을 계산하면서 실제로 그리는 titleFontSize(최대 92px)와 전혀
 * 연동되지 않아, 한글처럼 문자 폭이 넓은 텍스트나 긴 제목이 패널/캔버스
 * 경계를 넘어 잘려 보이는 문제가 있었다(사용자 제보 스크린샷 재현 완료).
 * fitTitle()로 교체해 "실제 그릴 폭"을 기준으로 폰트 크기를 먼저 맞추므로
 * 어떤 길이의 주제여도 항상 패널 안에 들어온다.
 */
function renderCardSvg({ topic, subtitle, style, width = 1600, height = 900 }) {
  const theme = pickTheme(style);
  const seed = hashString(`${topic}|${style}`);
  const category = detectCategory(`${topic} ${subtitle}`);
  const glyphPath = categoryGlyphPath(category);
  const layout = STYLE_LAYOUTS[style] || STYLE_LAYOUTS.poster;

  // shape 위치는 seed로 살짝 변주해 스타일이 같아도 매번 완전히 동일하진 않게 한다.
  const shapeOffsetX = -120 + (seed % 60);
  const shapeOffsetY = 120 + ((seed >> 4) % 60);

  // ⚠️ 이미지에 들어가는 텍스트는 오직 "실제 주제(topic)"와, 있는 경우
  // "실제 조사된 부제(subtitle)"만 사용한다. "Poster style thumbnail" 같은
  // 스타일명 배지나 "Visual concept for X" 같은 정형 문구, 하단 워터마크
  // 문구는 주제와 무관한 상투어라 절대 넣지 않는다 — 주제가 있는 그대로
  // 화면을 채우도록 배지/워터마크 자체를 레이아웃에서 제거했다(아래
  // layout.showBadge / layout.showWatermark가 항상 false).
  const panelX = layout.panelX(width);
  const panelY = layout.panelY(height);
  const panelW = layout.panelW(width);
  const panelH = layout.panelH(height);
  const panelInnerPad = layout.pad;
  const titleAvailableWidth = panelW - panelInnerPad * 2 - (layout.reserveGlyph ? 40 : 0);

  const { fontSize: titleFontSize, lines: titleLines } = fitTitle(
    topic, titleAvailableWidth, layout.maxTitleLines, layout.maxTitleFont, layout.minTitleFont
  );
  const titleLineHeight = titleFontSize * 1.12;

  const subtitleAvailableWidth = (panelW - panelInnerPad * 2) * WIDTH_SAFETY_FACTOR;
  const subtitleFontSize = layout.subtitleFont;
  // 실제로 조사된 부제가 없으면, 정형 문구를 채워 넣는 대신 부제 자체를
  // 생략한다(빈 문장을 억지로 만들어내지 않음 — 주제와 무관한 텍스트를
  // 이미지에 넣지 않는다는 원칙을 부제에도 동일하게 적용).
  const hasRealSubtitle = Boolean(subtitle && subtitle.trim() && subtitle.trim() !== topic.trim());
  const subtitleLines = hasRealSubtitle
    ? wrapTextByWidth(subtitle, subtitleAvailableWidth / subtitleFontSize, 2)
    : [];

  const titleTspans = titleLines
    .map((line, i) => `<tspan x="${panelX + panelInnerPad}" dy="${i === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const subtitleLineGap = subtitleFontSize * 1.45;
  const titleBlockHeight = titleLines.length * titleLineHeight;
  const titleY = panelY + layout.titleOffsetY;
  const subtitleY = titleY + titleBlockHeight + subtitleFontSize + 8;
  const subtitleTspans = subtitleLines
    .map((line, i) => `<tspan x="${panelX + panelInnerPad}" dy="${i === 0 ? 0 : subtitleLineGap}">${escapeXml(line)}</tspan>`)
    .join("");

  const glyphSize = layout.glyphSize;
  const glyphX = layout.glyphAlign === "left" ? panelX + panelInnerPad : width - 100 - glyphSize;
  const glyphY = height - 100 - glyphSize;

  const panelRect = layout.showPanel
    ? `<g filter="url(#panelShadow)"><rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="${layout.panelRadius}" fill="${theme.panel}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/></g>`
    : "";

  const accentBar = layout.showAccentBar
    ? `<rect x="${panelX + panelInnerPad}" y="${titleY - titleFontSize - 24}" width="72" height="6" rx="3" fill="${theme.accent}"/>`
    : "";

  const glyphMarkup = layout.showGlyph
    ? `<g transform="translate(${glyphX}, ${glyphY})" opacity="${layout.glyphOpacity}">
    <rect x="0" y="0" width="${glyphSize}" height="${glyphSize}" rx="28" fill="${theme.accent}"/>
    <g transform="translate(${glyphSize * 0.2}, ${glyphSize * 0.2}) scale(${(glyphSize * 0.6) / 24})">
      <path d="${glyphPath}" fill="none" stroke="${theme.text}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
  </g>`
    : "";

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

  <circle cx="${shapeOffsetX}" cy="${shapeOffsetY}" r="${layout.bigShapeR}" fill="${theme.shape}" filter="url(#blurLg)"/>
  <ellipse cx="${width - 100}" cy="${height - 80}" rx="260" ry="240" fill="${theme.accent}" opacity="0.22" filter="url(#blurMd)" transform="rotate(22 ${width - 100} ${height - 80})"/>
  <rect x="220" y="${height * 0.58}" width="660" height="220" rx="120" fill="${theme.accent2}" opacity="0.14" filter="url(#blurMd)"/>

  ${panelRect}

  <!-- 카테고리 심볼: 주제의 종류를 시각적으로 구분해, 모든 주제가 동일한
       카드로 보이는 문제를 완화한다 (예: 메신저/기기/여행/금융 등). -->
  ${glyphMarkup}

  ${accentBar}

  <text x="${panelX + panelInnerPad}" y="${titleY}" font-family="${FONT_STACK}" font-size="${titleFontSize}" font-weight="800" letter-spacing="-1" fill="${theme.text}">${titleTspans}</text>

  ${hasRealSubtitle ? `<text x="${panelX + panelInnerPad}" y="${subtitleY}" font-family="${FONT_STACK}" font-size="${subtitleFontSize}" fill="${theme.text}" fill-opacity="0.85">${subtitleTspans}</text>` : ""}
</svg>`;

  return svg;
}

function generateHeadlessCard({ prompt, topic, subtitle, style, width, height }) {
  // ⚠️ 2026-08(v7) 버그 수정: 이전에는 여기서 topic을 80자로 미리 잘라냈다.
  // fitTitle()/wrapTextByWidth()는 이미 "패널에 실제로 들어가는 만큼만
  // 보여주고 나머지는 …으로 표시"하는 로직을 자체적으로 갖추고 있으므로,
  // 여기서 먼저 80자로 자르면 단어 중간이 잘린 원문("...lines w")이
  // wrapTextByWidth에 그대로 전달되어 "이미 다 들어간 문장"으로 오인되고
  // 말줄임표(…)가 붙지 않는 문제가 있었다(사용자 제보 스크린샷과 동일 증상).
  // 원문 길이 제한은 fitTitle 한 곳에서만 담당하도록 사전 절단을 제거한다.
  const effectiveTopic = sanitizePrompt(topic || prompt) || "Untitled";
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
   ⚠️ 개편(2026-09, v9): Cloudflare 계정에서 실제 사용 가능이 확인된
   11개 모델(텍스트→이미지 9개 + 인페인팅 1개 + 이미지 변환 1개)로
   카탈로그를 전면 교체했다. 이번 요청에서 텍스트→이미지가 아닌
   인페인팅/이미지 변환 모델(SD 1.5 Inpainting, SD 1.5 Img2Img)은
   "topic으로부터 새 이미지를 생성"하는 이 엔드포인트의 목적(입력
   이미지/마스크가 없음)과 근본적으로 맞지 않아 텍스트→이미지 체인에는
   포함하지 않는다. 대신 향후 이미지 편집 엔드포인트를 위해 모델
   슬러그만 AI_MODELS에 등록해 둔다(EDIT_MODELS 참고).

   ⚠️ 단일 모델 금지 원칙: 모든 스타일 체인은 최소 3개 이상의 서로 다른
   모델로 구성하고, 인접한 두 스타일이라도 1순위 모델이 겹치지 않도록
   섞는다 — 스타일별로 결과물의 "모델 지문"이 고정되지 않게 해 품질과
   다양성을 함께 높인다. 각 모델은 요청당 1회만 시도(재시도 없음)하고,
   실패하면 즉시 다음 모델로 넘어가며, 체인 전체가 실패하면 ②(헤드리스
   카드)로 폴백해 항상 성공을 보장한다.

   ⚠️ Neuron 최소화 원칙: 각 스타일 체인의 1번 자리는 항상 저스텝·저비용
   모델(schnell/lightning/klein-4b/dreamshaper 계열)로 고정한다. 대부분의
   요청이 1번에서 바로 성공하므로 실사용 뉴런 소모는 최소 비용 모델에
   집중된다. 고스텝/고품질 모델(dev, klein-9b, base 계열)은 항상 체인
   뒤쪽(안전망)에 배치한다.
──────────────────────────────────────────────────────────── */

const AI_MODELS = {
  // 텍스트 → 이미지 (9개, 계정에서 사용 가능 확인됨)
  FLUX_SCHNELL: "@cf/black-forest-labs/flux-1-schnell",              // 4 steps, 최저 비용, 자연문 지시 이행 우수
  FLUX2_KLEIN_4B: "@cf/black-forest-labs/flux-2-klein-4b",            // FLUX.2 경량 세대, 저비용·빠른 응답
  FLUX2_KLEIN_9B: "@cf/black-forest-labs/flux-2-klein-9b",            // FLUX.2 경량 세대 대형, 4B보다 디테일↑
  FLUX2_DEV: "@cf/black-forest-labs/flux-2-dev",                      // FLUX.2 최신 고품질, 스텝多·고비용
  PHOENIX: "@cf/leonardo/phoenix-1.0",                                 // Leonardo Phoenix, 사실적 조명·구도 강점
  LUCID_ORIGIN: "@cf/leonardo/lucid-origin",                           // Leonardo Lucid Origin, 선명한 색·타이포 표현 강점
  DREAMSHAPER: "@cf/lykon/dreamshaper-8-lcm",                          // 6 steps, 사실적 렌더링, 저비용
  SDXL_LIGHTNING: "@cf/bytedance/stable-diffusion-xl-lightning",       // 8 steps, 빠르고 대비 강함, negative_prompt 지원
  SDXL_BASE: "@cf/stabilityai/stable-diffusion-xl-base-1.0",           // 20 steps, 고품질/고비용, negative_prompt 지원

  // 이미지 편집(인페인팅/변환) — 이 엔드포인트(텍스트→이미지)의 체인에는
  // 포함하지 않음. 입력 이미지/마스크가 있는 별도 편집 플로우에서만 사용.
  SD15_INPAINTING: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
  SD15_IMG2IMG: "@cf/runwayml/stable-diffusion-v1-5-img2img",
};

// 텍스트→이미지 체인에서만 순회 대상이 되는 모델 목록(편집 전용 모델 제외).
const TEXT_TO_IMAGE_MODELS = new Set([
  AI_MODELS.FLUX_SCHNELL, AI_MODELS.FLUX2_KLEIN_4B, AI_MODELS.FLUX2_KLEIN_9B,
  AI_MODELS.FLUX2_DEV, AI_MODELS.PHOENIX, AI_MODELS.LUCID_ORIGIN,
  AI_MODELS.DREAMSHAPER, AI_MODELS.SDXL_LIGHTNING, AI_MODELS.SDXL_BASE,
]);

// 이미지 편집 전용 모델(이 파일의 다른 엔드포인트/향후 확장을 위해 노출).
const EDIT_MODELS = {
  INPAINTING: AI_MODELS.SD15_INPAINTING,
  IMG2IMG: AI_MODELS.SD15_IMG2IMG,
};

// 스타일별 모델 체인. 각 스타일의 "기본 철학"(zorlinq32 플러그인 스타일
// 정의 기준)에 맞춰 우선순위를 다르게 둔다. 1번 자리는 항상 저비용 모델,
// 뒤로 갈수록 고비용/고디테일 모델이 안전망으로 붙는다. 모든 체인은
// 최소 3개 이상의 서로 다른 모델을 섞어 "단일 모델 고정"을 방지한다.
const STYLE_MODEL_CHAIN = {
  // poster: "실제 인쇄 광고 포스터처럼 주제마다 완전히 다른 구도"가 철학.
  // 강한 대비의 Lightning을 1순위로, 구도 표현력이 다른 FLUX.2/Phoenix/
  // Dreamshaper를 두루 섞어 매번 다른 "느낌"의 포스터가 나오게 한다.
  poster: [
    AI_MODELS.SDXL_LIGHTNING, AI_MODELS.FLUX2_KLEIN_4B, AI_MODELS.PHOENIX,
    AI_MODELS.DREAMSHAPER, AI_MODELS.FLUX2_DEV,
  ],
  // branding: "프리미엄 브랜드 캠페인, CTA 구역으로 시선 유도"가 철학.
  // Phoenix의 사실적 조명·구도로 브랜드 무드를 잡고, Lucid Origin의 선명한
  // 색감, Klein 9B의 디테일을 안전망으로 배치한다.
  branding: [
    AI_MODELS.PHOENIX, AI_MODELS.LUCID_ORIGIN, AI_MODELS.FLUX2_KLEIN_9B,
    AI_MODELS.SDXL_BASE, AI_MODELS.FLUX2_DEV,
  ],
  // minimal: "최대 여백, 최소 시각 노이즈, 단 하나의 극도로 단순화된 실루엣"이
  // 철학. 저스텝·깔끔한 지시 이행 모델(schnell/klein-4b/lightning) 위주로만
  // 짧게 구성해 과도한 디테일 생성을 피한다.
  minimal: [
    AI_MODELS.FLUX_SCHNELL, AI_MODELS.FLUX2_KLEIN_4B, AI_MODELS.SDXL_LIGHTNING,
  ],
  // typography: "배경은 순수하게 텍스트를 위한 무대, 경쟁하는 디테일 없음"이
  // 철학. 단순한 배경에 강한 저비용 모델을 우선하되, Lucid Origin의 선명한
  // 색조 표현력(타이포그래피 배경에 유리)을 안전망으로 포함한다.
  typography: [
    AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_LIGHTNING, AI_MODELS.LUCID_ORIGIN,
    AI_MODELS.FLUX2_KLEIN_4B,
  ],
  // photo_realistic: "실제 사진과 구분 불가능한 사실성"이 철학. 사실적
  // 렌더링에 강한 Dreamshaper·Phoenix를 앞세우고, 디테일이 뛰어난 고품질
  // 모델(Klein 9B, FLUX.2 Dev, SDXL Base) 순으로 폭넓게 안전망을 둔다
  // (가장 많은 폴백 단계를 허용 — 사실성 실패 시 품질 저하가 가장 두드러짐).
  photo_realistic: [
    AI_MODELS.DREAMSHAPER, AI_MODELS.PHOENIX, AI_MODELS.SDXL_LIGHTNING,
    AI_MODELS.FLUX2_KLEIN_9B, AI_MODELS.FLUX2_DEV, AI_MODELS.SDXL_BASE,
    AI_MODELS.FLUX_SCHNELL,
  ],
};

function getModelChainForStyle(style) {
  return STYLE_MODEL_CHAIN[style] || STYLE_MODEL_CHAIN.poster;
}

/**
 * 한국어 프롬프트 최적화.
 * 모든 이미지 모델의 학습 데이터는 절대다수가 영어 캡션이라, 한국어
 * 프롬프트를 그대로 넣으면 지시 이행률이 크게 떨어진다(특히 SD 계열).
 * 완전한 번역 API 없이도 지시 이행률을 끌어올리기 위해, 프롬프트에
 * 한글이 포함된 경우 모델이 "이것은 한국어로 된 주제 설명이며, 사진/
 * 그래픽으로서 한국적 맥락(인물 외형·간판·소품 등)을 자연스럽게
 * 반영해 달라"는 취지의 짧은 영어 메타 지시를 앞에 붙인다. 원문 한글
 * 프롬프트 자체는 보존해 모델이 고유명사·브랜드명 등을 그대로 참고할
 * 수 있게 한다.
 */
function containsKorean(text) {
  return /[가-힣]/.test(String(text || ""));
}

function localizeForModel(basePrompt) {
  const clean = sanitizePrompt(basePrompt);
  if (!containsKorean(clean)) return clean;
  // "Korean-context" 접두: 인물/장소/소품을 한국적 맥락으로 자연스럽게
  // 렌더링하도록 유도하고, 원문 한글 주제는 그대로 뒤에 남겨 고유명사를
  // 보존한다. 과도하게 길게 만들지 않아 모델별 프롬프트 길이 제한을 압박하지 않는다.
  return `Korean context, natural Korean setting and subjects reflecting the topic "${clean}"`;
}

/**
 * 모델별 프롬프트 문법이 다르므로, 공통 프롬프트를 모델에 맞게 가공한다.
 *   - FLUX 계열(schnell/klein-4b/klein-9b/dev): 짧은 태그 나열보다 자연스러운
 *     한두 문장 묘사를 선호하고, (word:1.4) 가중치 문법·negative_prompt를
 *     지원하지 않는다.
 *   - Leonardo 계열(Phoenix/Lucid Origin): 사진 촬영 지시어(카메라 앵글,
 *     조명, 렌즈감)와 스타일 형용사를 덧붙이면 효과가 좋다.
 *   - Stable Diffusion 계열(SDXL base/lightning): A1111식 가중치 문법과
 *     negative_prompt를 지원하며, 품질 향상 태그(4k, highly detailed 등)를
 *     덧붙이면 효과가 있다.
 *   - dreamshaper(LCM): 소수 스텝(4~8)에 최적화된 체크포인트로, 과도하게
 *     긴 프롬프트보다 핵심 묘사 위주가 안정적이다.
 * 모든 분기 이전에 localizeForModel()로 한국어 맥락 보정을 선적용한다.
 */
function buildModelPrompt(model, basePrompt, style) {
  const clean = localizeForModel(basePrompt);
  switch (model) {
    case AI_MODELS.SDXL_BASE:
    case AI_MODELS.SDXL_LIGHTNING:
      return `${clean}, professional commercial ${style} design, sharp focus, high detail, studio quality lighting, 4k`;
    case AI_MODELS.PHOENIX:
    case AI_MODELS.LUCID_ORIGIN:
      return `${clean}, professional photography, cinematic lighting, rich color grading, ${style} composition, highly detailed`;
    case AI_MODELS.DREAMSHAPER:
      return `${clean}, clean composition, balanced lighting, crisp detail`;
    case AI_MODELS.FLUX2_KLEIN_9B:
    case AI_MODELS.FLUX2_KLEIN_4B:
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
      // Stable Diffusion 계열만 negative_prompt 파라미터를 지원한다.
      return "blurry, low quality, watermark, text artifacts, distorted, extra limbs, deformed";
    case AI_MODELS.PHOENIX:
    case AI_MODELS.LUCID_ORIGIN:
      // Leonardo 계열도 negative_prompt를 지원한다.
      return "blurry, low quality, watermark, distorted, extra limbs, deformed, oversaturated noise";
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
    case AI_MODELS.PHOENIX:
      // Leonardo Phoenix — 고정 스텝 없이 프롬프트/네거티브 중심 API로 추정.
      return { prompt: shapedPrompt, ...(negative ? { negative_prompt: negative } : {}), guidance: 7 };
    case AI_MODELS.LUCID_ORIGIN:
      return { prompt: shapedPrompt, ...(negative ? { negative_prompt: negative } : {}), guidance: 7 };
    case AI_MODELS.FLUX2_DEV:
      // FLUX.2 Dev — 고품질 목적의 고스텝 모델(안전망 자리에만 배치되어 실사용 빈도 낮음).
      return { prompt: shapedPrompt, steps: 20 };
    case AI_MODELS.FLUX2_KLEIN_9B:
      // Klein 9B — Klein 4B보다 디테일이 필요할 때의 안전망, 스텝을 소폭 늘림.
      return { prompt: shapedPrompt, steps: 8 };
    case AI_MODELS.FLUX2_KLEIN_4B:
      // Klein 4B — FLUX.2 경량 모델, schnell과 유사하게 저스텝으로 충분.
      return { prompt: shapedPrompt, steps: 4 };
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

  const chain = getModelChainForStyle(style).filter((model) => TEXT_TO_IMAGE_MODELS.has(model));

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

export { CORS_HEADERS, AI_MODELS, EDIT_MODELS };
