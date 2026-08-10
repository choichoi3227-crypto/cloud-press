/**
 * research-core.js
 * "주제 조사" JSON을 생성한다: actual_meaning, visual_context, hero_shot,
 * color_mood, key_visuals, category, wrong_interpretation, emotional_tone,
 * text_color_hex, accent_color_hex.
 *
 * 설계 원칙(요청사항 반영):
 *   - 기본은 100% 규칙 기반(사전/키워드 매칭)이다. Cloudflare AI 바인딩이 전혀
 *     없어도 항상 동작하며, 별도 계정·과금·모델 승인 없이 그대로 배포된다.
 *   - Cloudflare Workers AI 바인딩(env.AI)이 "존재하는 경우에 한해서만" 선택적으로
 *     사용한다. 그마저도 검색 결과 스니펫을 바탕으로 한 번(1 request)만 아주
 *     짧은 프롬프트로 호출해 actual_meaning/visual_context 등 정성적 필드만
 *     보강하고, 실패하거나 시간이 걸리면 즉시 규칙 기반 결과로 폴백한다.
 *     즉, AI 바인딩은 "있으면 품질을 살짝 더 올려주는 선택 사항"이지 필수
 *     의존성이 아니다. 과다 호출을 막기 위해 요청당 최대 1회, 토큰 상한도
 *     짧게 제한한다.
 */

const COLOR_LEXICON = [
  { words: ["빨강", "레드", "붉은", "다홍", "적색"], mood: "정열적이고 강렬한 붉은 톤", text: "#FFFFFF", accent: "#E4342F" },
  { words: ["파랑", "블루", "푸른", "청색", "네이비"], mood: "차분하고 신뢰감 있는 파란 톤", text: "#FFFFFF", accent: "#2F6FE4" },
  { words: ["초록", "그린", "녹색", "연두"], mood: "자연스럽고 신선한 초록 톤", text: "#FFFFFF", accent: "#2FA84F" },
  { words: ["노랑", "옐로", "황색", "골드", "금색"], mood: "밝고 경쾌한 노란/골드 톤", text: "#1A1A1A", accent: "#FFD400" },
  { words: ["보라", "퍼플", "바이올렛", "라벤더"], mood: "신비롭고 세련된 보라 톤", text: "#FFFFFF", accent: "#8B5CF6" },
  { words: ["분홍", "핑크", "로즈"], mood: "부드럽고 따뜻한 핑크 톤", text: "#1A1A1A", accent: "#F472B6" },
  { words: ["주황", "오렌지"], mood: "활기차고 따뜻한 주황 톤", text: "#1A1A1A", accent: "#FB923C" },
  { words: ["검정", "블랙", "다크"], mood: "묵직하고 고급스러운 다크 톤", text: "#FFFFFF", accent: "#F2F2F2" },
  { words: ["흰색", "화이트", "미니멀"], mood: "깨끗하고 여백이 넓은 화이트 톤", text: "#1A1A1A", accent: "#111111" },
];

const CATEGORY_LEXICON = [
  { words: ["다이어트", "식단", "칼로리", "체중", "운동", "헬스", "건강", "영양"], category: "건강/피트니스", tone: "energetic" },
  { words: ["여행", "관광", "숙소", "항공", "호텔", "국내여행", "해외여행"], category: "여행", tone: "warm" },
  { words: ["재테크", "투자", "주식", "부동산", "적금", "대출", "금융", "경제"], category: "재테크/금융", tone: "trustworthy" },
  { words: ["요리", "레시피", "음식", "맛집", "카페", "디저트"], category: "푸드", tone: "warm" },
  { words: ["뷰티", "화장품", "스킨케어", "메이크업", "헤어"], category: "뷰티", tone: "elegant" },
  { words: ["반려동물", "강아지", "고양이", "펫"], category: "반려동물", tone: "warm" },
  { words: ["앱", "다운로드", "설치", "업데이트", "프로그램", "소프트웨어", "pc버전"], category: "IT/소프트웨어", tone: "modern" },
  { words: ["보안", "백신", "해킹", "개인정보", "피싱"], category: "보안", tone: "serious" },
  { words: ["교육", "공부", "학습", "자격증", "시험"], category: "교육", tone: "trustworthy" },
  { words: ["육아", "출산", "아기", "임신"], category: "육아", tone: "warm" },
  { words: ["부업", "창업", "사업", "마케팅"], category: "비즈니스", tone: "energetic" },
  { words: ["정책", "지원금", "제도", "신청", "혜택", "복지"], category: "정책/제도", tone: "trustworthy" },
];

const PEOPLE_WORDS = /\b(person|people|woman|women|man|men|girl|boy|human|face|portrait|model)\b/i;
const PEOPLE_WORDS_KO = /(사람|인물|모델|여성|남성|얼굴)/;

function pickColor(text) {
  for (const entry of COLOR_LEXICON) {
    if (entry.words.some((w) => text.includes(w))) return entry;
  }
  return null;
}

function pickCategory(text) {
  for (const entry of CATEGORY_LEXICON) {
    if (entry.words.some((w) => text.includes(w))) return entry;
  }
  return null;
}

function stripPeopleWords(s) {
  if (!s) return s;
  return s.replace(PEOPLE_WORDS_KO, "").replace(PEOPLE_WORDS, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * 검색 결과(제목+스니펫)를 규칙 기반으로 분석해 research JSON을 만든다.
 * AI 바인딩이 전혀 없어도 항상 이 결과를 반환할 수 있다.
 */
export function buildRuleBasedResearch(topic, providers) {
  const allResults = (providers || []).flatMap((p) => p.results || []);
  const corpus = [topic, ...allResults.slice(0, 8).flatMap((r) => [r.title, r.snippet])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const colorEntry = pickColor(corpus);
  const categoryEntry = pickCategory(corpus);

  const topTitles = allResults.slice(0, 5).map((r) => r.title).filter(Boolean);
  const topSnippets = allResults.slice(0, 3).map((r) => r.snippet).filter(Boolean);

  // actual_meaning: 검색 결과 제목 중 가장 정보량이 많아 보이는 것(길이 상한 내)을 우선 채택,
  // 없으면 topic 그대로 사용.
  const bestTitle = topTitles.find((t) => t.length >= 6 && t.length <= 60) || topTitles[0] || "";
  const actualMeaning = bestTitle ? `${topic} — ${bestTitle}` : topic;

  const visualContext = topSnippets[0]
    ? stripPeopleWords(topSnippets[0]).slice(0, 160)
    : stripPeopleWords(topTitles.slice(0, 3).join(", ")).slice(0, 160) || topic;

  const keyVisuals = Array.from(new Set(
    topTitles
      .join(" ")
      .split(/[\s,·|\-\/]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && w.length <= 12 && !PEOPLE_WORDS_KO.test(w))
      .slice(0, 6)
  )).slice(0, 5);

  return {
    actual_meaning: actualMeaning.slice(0, 160),
    visual_context: visualContext || topic,
    hero_shot: keyVisuals[0] ? `${keyVisuals[0]}을(를) 중심으로 한 상징적 장면` : `${topic}을(를) 상징하는 오브젝트 중심 장면`,
    color_mood: colorEntry ? colorEntry.mood : "주제와 어울리는 현대적이고 선명한 톤",
    key_visuals: keyVisuals.length ? keyVisuals : [topic],
    category: categoryEntry ? categoryEntry.category : "일반",
    wrong_interpretation: "",
    emotional_tone: categoryEntry ? categoryEntry.tone : "dynamic",
    text_color_hex: colorEntry ? colorEntry.text : "#FFFFFF",
    accent_color_hex: colorEntry ? colorEntry.accent : "#FFD400",
    research_engine: "rule_based",
  };
}

/**
 * (선택적) Cloudflare Workers AI로 규칙 기반 결과를 보강한다.
 * env.AI가 없거나 호출이 실패/시간초과되면 항상 규칙 기반 결과를 그대로 반환한다.
 * 요청당 최대 1회만 호출하며, 짧은 프롬프트 + 짧은 max_tokens로 사용량을 최소화한다.
 */
export async function enhanceWithWorkersAI(env, topic, providers, ruleBased) {
  if (!env || !env.AI) return ruleBased; // 바인딩 미설정 시 완전히 건너뜀 (기본 동작)

  const snippets = (providers || [])
    .flatMap((p) => p.results || [])
    .slice(0, 5)
    .map((r) => `- ${r.title || ""}: ${(r.snippet || "").slice(0, 120)}`)
    .join("\n");

  if (!snippets) return ruleBased; // 참고할 검색 결과가 없으면 AI를 호출할 이유가 없음

  const prompt = `다음은 "${topic}"에 대한 검색 결과 요약이다. 아래 JSON 스키마로만, 마크다운이나 설명 없이 응답하라.
검색 결과:
${snippets}

스키마:
{"actual_meaning":"주제의 실제 의미(최대 40자)","visual_context":"이미지로 표현할 시각적 장면(최대 60자)","hero_shot":"핵심 장면 한 문장","color_mood":"어울리는 색상 분위기","category":"카테고리 한 단어","emotional_tone":"영어 한 단어(예: warm, dynamic, trustworthy)"}
인물/사람을 시각 요소로 넣지 말 것.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("ai_timeout"), 6000);
    let result;
    try {
      // 저비용 소형 텍스트 모델 1회 호출. max_tokens을 짧게 제한해 사용량을 최소화한다.
      result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 220,
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const raw = typeof result === "string" ? result : (result?.response || "");
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return ruleBased;
    const parsed = JSON.parse(match[0]);

    return {
      ...ruleBased,
      actual_meaning: parsed.actual_meaning ? String(parsed.actual_meaning).slice(0, 160) : ruleBased.actual_meaning,
      visual_context: parsed.visual_context ? stripPeopleWords(String(parsed.visual_context)).slice(0, 200) : ruleBased.visual_context,
      hero_shot: parsed.hero_shot ? stripPeopleWords(String(parsed.hero_shot)).slice(0, 200) : ruleBased.hero_shot,
      color_mood: parsed.color_mood ? String(parsed.color_mood).slice(0, 100) : ruleBased.color_mood,
      category: parsed.category ? String(parsed.category).slice(0, 40) : ruleBased.category,
      emotional_tone: parsed.emotional_tone ? String(parsed.emotional_tone).slice(0, 30) : ruleBased.emotional_tone,
      research_engine: "workers_ai+rule_based",
    };
  } catch {
    // AI 호출이 실패하거나 시간 초과되면 조용히 규칙 기반 결과를 그대로 사용한다.
    return ruleBased;
  }
}
