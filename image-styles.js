/**
 * image-styles.js — 스타일별 "AI 아트 디렉터" 프롬프트.
 *
 * 설계 원칙
 *  1) 색상·오브젝트를 스타일이 정하지 않는다.
 *     각 스타일은 "시각 언어(구조·기법·재질·위계)"만 규정하고, 팔레트·소재·상징·구도의 세부는
 *     주제의 의미(research)를 읽은 AI가 매번 스스로 결정한다. (같은 스타일이라도 주제가 다르면
 *     색과 소재가 달라지고, 스타일이 다르면 구조 자체가 달라진다.)
 *  2) 프롬프트 "형식"부터 스타일마다 다르다.
 *     poster=스펙시트, minimal=규칙집, typography=활자 견본 브리프, branding=캠페인 브리프,
 *     gradient=레시피, infographic=ASCII 와이어프레임, isometric=기하 스펙(수식),
 *     neon=라이트 레시피, papercut=레이어 스택 표, blueprint=제도 규격.
 *     하나의 템플릿에서 단어만 바꾸는 방식이 아니다.
 *  3) 제목은 이미지 안에 정확히 한 번만 그려지게 한다.
 *     (플러그인은 더 이상 canvas로 제목을 덧그리지 않는다.) 제목 줄바꿈·글자 폭 계산은 여기서 해서
 *     프롬프트에 수치로 넘기고, image-core.js가 결과를 검수·보정한다.
 *
 * 이 파일은 순수 함수만 export 한다(네트워크·AI 호출 없음).
 */

export const SVG_STYLE_KEYS = [
	'poster', 'minimal', 'typography', 'branding',
	'gradient', 'infographic', 'isometric', 'neon', 'papercut', 'blueprint',
];
export const PHOTO_STYLE_KEYS = [ 'photo_realistic' ];
export const STYLE_KEYS = [ ...SVG_STYLE_KEYS, ...PHOTO_STYLE_KEYS ];

export const STYLE_LABELS = {
	poster: '포스터', minimal: '미니멀', typography: '타이포그래피', branding: '브랜딩',
	gradient: '그라디언트', infographic: '인포그래픽', isometric: '아이소메트릭 3D',
	neon: '네온', papercut: '페이퍼컷', blueprint: '블루프린트', photo_realistic: '사실적 사진',
};

export const isSvgStyle = ( key ) => SVG_STYLE_KEYS.includes( key );

// 화면에 실제로 그려지는 요소 수의 최소치(스타일 복잡도에 맞춘 "너무 빈약한 결과" 컷오프).
export const STYLE_MIN_DRAWN = {
	poster: 8, minimal: 4, typography: 5, branding: 14,
	gradient: 10, infographic: 28, isometric: 36, neon: 22, papercut: 26, blueprint: 36,
};

// 스타일별 샘플링 온도(구조가 엄격한 스타일은 낮게, 표현 자유도가 큰 스타일은 높게).
export const STYLE_TEMPERATURE = {
	poster: 0.8, minimal: 0.6, typography: 0.9, branding: 0.8,
	gradient: 0.85, infographic: 0.6, isometric: 0.55, neon: 0.8, papercut: 0.75, blueprint: 0.5,
};

// ──────────────────────────────────────────────────────────────
// 제목 계획: 글자 폭 추정 → 줄바꿈 → 폰트 크기 상한
// (Noto Sans KR Bold 기준. 한글/한자 ≈ 1em, 숫자 ≈ .58em, 라틴 ≈ .56~.68em)
// ──────────────────────────────────────────────────────────────
export function charUnits( ch ) {
	const c = ch.codePointAt( 0 );
	if ( ch === ' ' ) return 0.3;
	if ( ( c >= 0xAC00 && c <= 0xD7A3 ) || ( c >= 0x3130 && c <= 0x318F ) || ( c >= 0x4E00 && c <= 0x9FFF ) || ( c >= 0x3040 && c <= 0x30FF ) || ( c >= 0xFF00 && c <= 0xFFEF ) ) return 1.0;
	if ( c >= 0x30 && c <= 0x39 ) return 0.58;
	if ( c >= 0x41 && c <= 0x5A ) return 0.68;
	if ( c >= 0x61 && c <= 0x7A ) return 0.56;
	if ( '.,:;!\'"|`'.includes( ch ) ) return 0.32;
	if ( '-–—_/\\()[]{}~·' .includes( ch ) ) return 0.45;
	return 0.8;
}
export function textUnits( str ) {
	let u = 0;
	for ( const ch of String( str ) ) u += charUnits( ch );
	return u;
}

/**
 * 제목을 1~3줄로 균형 있게 나눈다. 공백 단위로 우선 나누고, 공백이 없으면 글자 단위로 나눈다.
 * @returns {{lines:string[], units:number[], maxUnits:number, safeMaxSize:number, total:number}}
 */
export function planTitle( title, width, height ) {
	const text = String( title || '' ).replace( /\s+/g, ' ' ).trim();
	if ( ! text ) return { lines: [], units: [], maxUnits: 0, safeMaxSize: 0, total: 0 };
	const total = textUnits( text );
	const usable = width * 0.88;
	const words = text.split( ' ' );

	const splitWords = ( n ) => {
		// n줄로 쪼개되 각 줄의 폭 합이 비슷해지도록 그리디로 채운다.
		const target = total / n;
		const lines = [];
		let cur = '';
		for ( const w of words ) {
			const next = cur ? `${ cur } ${ w }` : w;
			if ( cur && textUnits( next ) > target * 1.12 && lines.length < n - 1 ) { lines.push( cur ); cur = w; } else cur = next;
		}
		if ( cur ) lines.push( cur );
		return lines;
	};
	const splitChars = ( n ) => {
		const chars = Array.from( text );
		const target = total / n;
		const lines = [];
		let cur = '', acc = 0;
		for ( const ch of chars ) {
			acc += charUnits( ch );
			cur += ch;
			if ( acc >= target && lines.length < n - 1 ) { lines.push( cur.trim() ); cur = ''; acc = 0; }
		}
		if ( cur.trim() ) lines.push( cur.trim() );
		return lines;
	};

	// 목표: 가장 긴 줄이 한 변의 약 14~16em 이내(너무 긴 한 줄은 글자가 작아진다).
	const idealCols = height > width ? 8 : 12;
	let n = 1;
	if ( total > idealCols * 1.15 ) n = 2;
	if ( total > idealCols * 2.3 ) n = 3;
	let lines = ( words.length >= n ) ? splitWords( n ) : splitChars( n );
	if ( lines.length < n && words.length < n ) lines = splitChars( n );
	lines = lines.filter( Boolean );

	const units = lines.map( textUnits );
	const maxUnits = Math.max( ...units );
	return { lines, units, maxUnits, total, safeMaxSize: Math.floor( usable / Math.max( maxUnits, 1 ) ) };
}

// ──────────────────────────────────────────────────────────────
// 공통 조각
// ──────────────────────────────────────────────────────────────
function signalsOf( ctx ) {
	const r = ctx.research || {};
	const keys = Array.isArray( r.key_visuals ) ? r.key_visuals.filter( Boolean ).slice( 0, 6 ) : [];
	return {
		topic: ctx.title || '',
		meaning: String( r.actual_meaning || '' ).trim(),
		visual: String( r.visual_context || '' ).trim(),
		mood: String( r.emotional_tone || '' ).trim(),
		colorMood: String( r.color_mood || '' ).trim(),
		category: String( r.category || '' ).trim(),
		keys,
		wrong: String( r.wrong_interpretation || '' ).trim(),
		brief: String( ctx.brief || '' ).trim().slice( 0, 700 ),
	};
}

function titleFacts( ctx ) {
	const p = ctx.plan;
	if ( ! p.lines.length ) return null;
	return {
		exact: ctx.title,
		lines: p.lines,
		longest: p.maxUnits.toFixed( 1 ),
		safeMax: p.safeMaxSize,
		count: p.lines.length,
	};
}

/** 모든 SVG 스타일이 반드시 지켜야 하는 기술 계약(형식은 스타일마다 다르게 렌더링한다). */
function contractFacts( ctx ) {
	const { width: W, height: H } = ctx;
	const t = titleFacts( ctx );
	return {
		root: `<svg xmlns="http://www.w3.org/2000/svg" width="${ W }" height="${ H }" viewBox="0 0 ${ W } ${ H }">`,
		output: 'Output ONLY the SVG markup: it must start with <svg and end with </svg>. No explanation, no markdown fences.',
		font: 'The only available font is bold "Noto Sans KR" — always write font-family="Noto Sans KR, sans-serif" and use font-weight 700–900 (no italics, no other family names). Hangul glyphs are ≈1.0×font-size wide, digits ≈0.58×, Latin ≈0.6×.',
		banned: 'Never use <script>, <image>, <foreignObject>, <filter>/blur, <animate>, @import, <style> blocks, external URLs or xlink to anything but "#id" — they are stripped or break rendering.',
		xml: 'Valid XML: escape & < > as &amp; &lt; &gt;, close every tag, never repeat an attribute on one tag, give every shape an explicit fill or stroke.',
		titleRule: t
			? `The headline is exactly "${ t.exact }". Write it with <text> elements (one <text> per line, no <tspan>), spelled exactly as given — never translate, shorten, re-spell or add words. Suggested line breaks: ${ t.lines.map( ( l ) => `「${ l }」` ).join( ' / ' ) } (the longest line is ≈${ t.longest }em wide, so font-size must stay ≤ ${ t.safeMax }px or it will leave the canvas). The headline appears in the picture exactly ONCE: never repeat it as a watermark, caption, shadow copy at another position, or alternate version. The very first child inside <svg> is <title> holding the same headline.`
			: 'There is no headline: do not put any text anywhere in the image.',
		margin: `Keep all text at least ${ Math.round( W * 0.04 ) }px away from every canvas edge.`,
	};
}

function ownerDirection( ctx ) {
	const d = String( ctx.customDirection || '' ).trim().slice( 0, 700 );
	return d ? `\n\nOWNER'S EXTRA DIRECTION (follow it unless it breaks a hard limit above): ${ d }` : '';
}

function retryNote( ctx ) {
	return ctx.note ? `\n\nPREVIOUS ATTEMPT WAS REJECTED — ${ ctx.note } Fix exactly that and output the complete SVG again.` : '';
}

function userMessage( ctx, shape ) {
	// 사용자 메시지도 스타일마다 모양이 다르다(shape가 스타일별로 서로 다른 머리말/구성을 넘긴다).
	return `${ shape }${ retryNote( ctx ) }${ ownerDirection( ctx ) }\n\nVariation token (use it only to avoid repeating a previous answer): ${ ctx.seed }`;
}

const ln = ( arr ) => arr.filter( Boolean ).join( '\n' );
const opt = ( label, v ) => ( v ? `${ label }: ${ v }` : '' );

// ──────────────────────────────────────────────────────────────
// 1) POSTER — 스펙시트 형식 (번호가 매겨진 "ZONE" 명세)
// ──────────────────────────────────────────────────────────────
function posterMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are the art director of a Korean online-media poster desk (policy, benefit, event and issue explainers). Your posters are typographic, loud and instantly legible at thumbnail size — they look like real printed notice posters, not app promos and not illustrations.',
		'',
		`══ POSTER SPEC SHEET · ${ ctx.width }×${ ctx.height } ══`,
		'ZONE A · FIELD — ONE dominant background field: a flat colour or a very restrained tonal gradient. You choose the hue from the emotion and meaning of the topic; do not default to a "safe" blue.',
		'ZONE B · HEADLINE — the headline is the hero. Its widest line spans roughly 70–88% of the canvas width, weight 800–900, line-height 1.12–1.25, at most 3 lines, optically centred in the field (a different alignment is fine only if the whole layout is built around it). The headline block occupies about 30–55% of the canvas height. Contrast against the field ≥ 7:1.',
		'ZONE C · FRAME DEVICE — one graphic device that frames or locks onto the headline (for example brackets, rules, a plate, a stamp-like outline, tick marks, a ribbon band). Invent it for this topic; it must feel like print design.',
		'ZONE D · EDGE ACCENTS — 2–5 bold abstract shapes (swooshes, ribbons, bursts, stripes, arcs, blocks) anchored to the edges or corners, partially cropped by the canvas, in tones related to the field. They add energy but never enter the headline safe zone (keep ≥ 6% padding around the headline).',
		'ZONE E · SUPPORT — optional: one tiny supporting line or one small simplified symbol if the topic has an unmistakable one. Skip it when in doubt. No photographs, no detailed illustration, no clutter.',
		'',
		'ORIGINALITY: two different topics must produce visibly different fields, devices and accents. Never reuse the same arrangement mechanically.',
		'',
		'══ HARD LIMITS ══',
		`✗ ${ c.output }`,
		`✗ Canvas: ${ c.root } and nothing else as the root.`,
		`✗ ${ c.font }`,
		`✗ ${ c.titleRule }`,
		`✗ ${ c.banned }`,
		`✗ ${ c.xml }`,
		`✗ ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		'[TOPIC BRIEF]',
		`Headline: ${ s.topic }`,
		opt( 'What it really means', s.meaning ),
		opt( 'Feeling to deliver', s.mood ),
		opt( 'Visual hints from research (optional)', s.keys.join( ', ' ) ),
		opt( 'Colour mood suggested by research (optional, you decide)', s.colorMood ),
		opt( 'Do NOT misread it as', s.wrong ),
		opt( 'Extra notes', s.brief ),
		'',
		'Design the poster now and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 2) MINIMAL — 규칙집 형식 (짧은 계율)
// ──────────────────────────────────────────────────────────────
function minimalMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You design minimalist cover images. The craft here is subtraction.',
		'',
		'THE RULES OF EMPTINESS',
		'1. At least 65% of the canvas is plain, untouched background.',
		'2. One idea only. Express it with at most 5 simple shapes (circle, line, arc, rectangle, a single-stroke path) in total, excluding text.',
		'3. At most two hues plus one neutral. Pick them from what the topic feels like; keep saturation controlled.',
		'4. No gradients except one very soft tonal wash; no shadows, no textures, no outlines on everything.',
		'5. The headline is small-to-medium (its font-size ≈ 5–9% of the canvas height), placed on a deliberate grid position (rule of thirds or an exact margin), never dead centre by habit.',
		'6. Space is part of the composition: make the empty area feel intentional by aligning the shapes and the headline on shared axes.',
		'7. No icons made of many parts, no decoration, no frames, no ornaments, no background pattern.',
		'',
		'TECHNICAL:',
		`${ c.output } Root: ${ c.root }.`,
		c.font,
		c.titleRule,
		c.banned,
		c.xml,
		c.margin,
	] );
	const user = userMessage( ctx, ln( [
		`Topic: ${ s.topic }`,
		opt( 'Meaning', s.meaning ),
		opt( 'Mood', s.mood ),
		opt( 'Notes', s.brief ),
		'',
		'Find the single most telling abstract gesture for this topic, then output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 3) TYPOGRAPHY — 활자 견본 브리프 (번호 기법 목록)
// ──────────────────────────────────────────────────────────────
function typographyMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are a type designer composing a kinetic type specimen. The letters ARE the artwork; there is no illustration.',
		'',
		'SPECIMEN BRIEF — choose and combine techniques (numbered so you can reference them):',
		'  T1. Scale contrast: give the lines very different sizes (largest ≥ 2.2× the smallest) so one word dominates.',
		'  T2. Weight/texture play: a heavy filled line against a line drawn with stroke only (use stroke on that same <text>, fill="none").',
		'  T3. Rhythm: tight or generous letter-spacing (letter-spacing attribute) chosen per line; a deliberate baseline stagger is allowed.',
		'  T4. Cropping: one line may bleed past an edge by up to 12% ONLY if every character stays readable.',
		'  T5. Structure marks: hairline rules, dots, bars, arrows or index numerals (1, 2, 3) as typographic punctuation.',
		'  T6. Colour: a flat ground and one or two ink colours — decide them from the topic; no gradients behind letters.',
		'Use at least three of T1–T6. Up to three tiny extra labels (≤ 8 Hangul characters each, derived from the topic, no numbers or claims) are allowed as texture; they must never repeat the headline.',
		'',
		'LIMITS:',
		`  1) ${ c.output } Root: ${ c.root }.`,
		`  2) ${ c.font }`,
		`  3) ${ c.titleRule } Each headline line exists once only — create outline or shadow effects with stroke on that same element, never with a duplicate element.`,
		`  4) ${ c.banned }`,
		`  5) ${ c.xml }`,
		`  6) ${ c.margin } (T4 is the only exception.)`,
	] );
	const user = userMessage( ctx, ln( [
		`SPECIMEN SUBJECT → ${ s.topic }`,
		opt( 'Tone of voice', s.mood ),
		opt( 'Meaning', s.meaning ),
		opt( 'Notes', s.brief ),
		'',
		'Compose the specimen and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 4) BRANDING — 캠페인 브리프 (키비주얼 / 로크업 / CTA)
// ──────────────────────────────────────────────────────────────
function brandingMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'ROLE: creative lead at a premium brand agency.',
		'DELIVERABLE: one campaign key visual for the topic given, as SVG.',
		'',
		'CAMPAIGN BRIEF',
		'  Positioning  : the topic is treated like a product/service being launched — confident, polished, desirable.',
		'  Layout       : three clearly separated areas — (1) a key-visual zone made of refined geometric forms that symbolise the topic, (2) a copy zone holding the headline and one short supporting line, (3) a call-to-action zone.',
		'  Hierarchy    : headline > key visual > supporting line > call-to-action. The eye must travel along one path from visual to headline to action.',
		'  Brand mark   : a small abstract monogram built from simple shapes only (no letters, no real logos).',
		'  Supporting   : one Korean line (≤ 16 characters) that expresses the benefit in plain words — no numbers, prices, dates or claims you cannot know.',
		'  CTA          : a rounded pill or arrow button containing a Korean verb phrase of 3–7 characters. No URLs.',
		'  Finish       : generous outer margin (≥ 6%), consistent corner radius, a tight palette of 2–3 hues plus tints. Choose the palette and the symbolic forms yourself from the meaning of the topic.',
		'',
		'COMPLIANCE TABLE',
		`  output   | ${ c.output } Root ${ c.root }`,
		`  font     | ${ c.font }`,
		`  headline | ${ c.titleRule } The supporting line and the CTA are separate, shorter texts; neither may repeat the headline.`,
		`  banned   | ${ c.banned }`,
		`  xml      | ${ c.xml }`,
		`  margins  | ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		'CLIENT INPUT',
		`  topic    : ${ s.topic }`,
		opt( '  meaning  ', s.meaning ),
		opt( '  feeling  ', s.mood ),
		opt( '  hints    ', s.keys.join( ', ' ) ),
		opt( '  notes    ', s.brief ),
		'',
		'Present the key visual.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 5) GRADIENT — 레시피 형식 (번호 단계)
// ──────────────────────────────────────────────────────────────
function gradientMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are a motion-graphics designer making a gradient-mesh cover. Follow this RECIPE in order (back to front).',
		'',
		'STEP 1  Base: one full-canvas <rect> with a <linearGradient> (userSpaceOnUse). The base may be dark or light — decide from the mood of the topic.',
		'STEP 2  Mesh: 4–6 full-canvas <rect>s, each filled by its own <radialGradient gradientUnits="userSpaceOnUse"> whose centre is placed at a different spot (some near the corners, some mid-canvas), radius 35–75% of the canvas width, stop-opacity running from 0.85–1 at the centre to 0 at the edge. Their overlap forms the mesh. Use 3–5 clearly different hues that belong together for this topic; no muddy greys.',
		'STEP 3  Flow: 1–3 long smooth <path> ribbons (stroke with low opacity or a gradient fill) sweeping across the canvas to give direction.',
		'STEP 4  Glass: one frosted-glass panel behind or around the headline — rounded <rect> (rx 3–6% of the width) filled white at 8–22% opacity with a 1.5–2.5px white stroke at ≈35% opacity, plus a small bright highlight arc along one edge. A second smaller glass disc or pill is optional.',
		'STEP 5  Form: one abstract translucent 3D-feeling form (sphere, torus-like ring, folded ribbon…) that hints at the topic, built only from gradients and opacity — no outlines, no clip-art.',
		'STEP 6  Sparkle: 8–20 tiny circles (r 1–4px) with varied opacity.',
		'STEP 7  Headline on the glass, in white or near-black — whichever gives ≥ 4.5:1 contrast against what is under it.',
		'',
		`[ ] ${ c.output } Root ${ c.root }`,
		`[ ] ${ c.font }`,
		`[ ] ${ c.titleRule }`,
		`[ ] ${ c.banned }`,
		`[ ] ${ c.xml }`,
		`[ ] ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		`topic: ${ s.topic }`,
		opt( 'feeling', s.mood ),
		opt( 'meaning', s.meaning ),
		opt( 'colour mood hint (optional)', s.colorMood ),
		opt( 'notes', s.brief ),
		'Run the recipe and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 6) INFOGRAPHIC — ASCII 와이어프레임 + 콘텐츠 슬롯
// ──────────────────────────────────────────────────────────────
function infographicMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const wire = ctx.height > ctx.width
		? [
			'┌──────────────────────────┐',
			'│ HEADER BAND  (headline)  │ ← top 20%',
			'├──────────────────────────┤',
			'│     ( HERO ICON )        │ ← large circle/rounded badge',
			'├──────────────────────────┤',
			'│ [1] card  ── mini-viz    │',
			'│ [2] card  ── mini-viz    │ ← 2–3 stacked cards',
			'│ [3] card  ── mini-viz    │',
			'└──────────────────────────┘',
		]
		: [
			'┌────────────────────────────────────────────┐',
			'│ HEADER BAND  (headline)                    │ ← top 22–28%',
			'├──────────────┬─────────────────────────────┤',
			'│  ( HERO      │ [1] card ── mini-viz        │',
			'│    ICON )    │ [2] card ── mini-viz        │ ← 2–3 cards, aligned grid',
			'│              │ [3] card ── mini-viz        │',
			'└──────────────┴─────────────────────────────┘',
		];
	const system = ln( [
		'You build clean information-graphic covers for explainer articles.',
		'',
		'WIREFRAME (adapt proportions, keep the structure):',
		...wire,
		'',
		'CONTENT SLOTS',
		'  HEADER      : a solid colour band carrying the headline.',
		'  HERO ICON   : a simple flat icon of the topic assembled from primitives (circles, rects, paths) inside a circular or rounded badge.',
		'  CARDS       : 2–3 white rounded cards. Each has a numbered badge (1, 2, 3 — the only digits allowed), a flat icon, and a Korean label of ≤ 10 characters naming one real aspect of the topic that you infer from the meaning provided.',
		'  MINI-VIZ    : each card carries a decorative bar set, donut arc or progress bar drawn with shapes. NEVER write statistics, percentages, prices, dates or other numbers — the charts are shape-only.',
		'',
		'STYLE: flat vector, even grid, consistent corner radius and padding, soft card shadows made from an offset translucent rect. Pick a base colour family and one accent from the topic\'s character; the background is light or tinted, never photographic.',
		'',
		'QA CHECKLIST',
		`  • ${ c.output } Root ${ c.root }`,
		`  • ${ c.font }`,
		`  • ${ c.titleRule } Card labels are the only other texts and they must not repeat the headline.`,
		`  • ${ c.banned }`,
		`  • ${ c.xml }`,
		`  • ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		`TOPIC: ${ s.topic }`,
		opt( 'MEANING', s.meaning ),
		opt( 'VISUAL CONTEXT', s.visual ),
		opt( 'ASPECTS WORTH SHOWING', s.keys.join( ', ' ) ),
		opt( 'NOTES', s.brief ),
		'',
		'Fill the slots and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 7) ISOMETRIC — 기하 스펙(수식)
// ──────────────────────────────────────────────────────────────
function isometricMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are a technical illustrator producing an isometric 3D diorama as pure SVG geometry.',
		'',
		'GEOMETRY SPEC',
		'  axes   : x → (+0.866, +0.5) · y → (−0.866, +0.5) · z → (0, −1)   (exact 30° isometric, NO perspective, parallel edges stay parallel)',
		'  project: for a point (x, y, z) with unit length u:   sx = cx + (x − y)·0.866·u    sy = cy + (x + y)·0.5·u − z·u',
		'  solid  : every box is 3 visible faces — TOP (rhombus), LEFT, RIGHT — written as three <path> with explicit absolute coordinates computed from the formula above.',
		'  shading: per solid take ONE hue; TOP = lightest, LEFT = medium, RIGHT = darkest (flat fills, no gradients on faces). Different solids may use different hues from one coherent family.',
		'  order  : painter\'s algorithm — draw by increasing (x + y), then increasing z, so nothing is overlapped wrongly.',
		'  ground : a thick isometric slab/platform as the base (two side faces + top), a soft translucent shadow polygon on the floor.',
		'',
		'SCENE: a compact diorama on that platform with 4–8 solids and small props whose shapes and arrangement SYMBOLISE the topic (you choose the objects from its meaning: stacks, bars, buildings, devices, containers, steps…). Keep it readable at thumbnail size.',
		'BACKGROUND: calm and uncluttered; choose its tone from the topic. The headline sits flat (not skewed) in a clear area or on a flat banner and never overlaps the diorama.',
		'',
		'VALIDATION',
		`  - ${ c.output } Root ${ c.root }`,
		`  - ${ c.font }`,
		`  - ${ c.titleRule }`,
		`  - ${ c.banned }`,
		`  - ${ c.xml }`,
		`  - ${ c.margin }`,
		'  - Use <g> only for grouping; do not rely on matrix transforms for the solids — write coordinates explicitly.',
	] );
	const user = userMessage( ctx, ln( [
		`topic = ${ JSON.stringify( s.topic ) }`,
		opt( 'meaning', s.meaning ),
		opt( 'symbols to consider', s.keys.join( ', ' ) ),
		opt( 'notes', s.brief ),
		'Compute the coordinates, then output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 8) NEON — 라이트 레시피
// ──────────────────────────────────────────────────────────────
function neonMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are a lighting artist painting with neon tubes on a night scene. Everything luminous is a LINE; everything else is darkness.',
		'',
		'LIGHT RECIPE',
		'  ground  : the canvas is nearly black with a faint cool or warm gradient (decide from the topic) and a few dim stars/dust points.',
		'  tube    : every glowing line is drawn as THREE stacked copies of the same path — halo (stroke-width 14–22, opacity 0.06–0.10), glow (6–9, opacity 0.22–0.3), core (2–3.5, opacity 1, lighter tint of the hue). stroke-linecap="round".',
		'  hues    : 2–3 saturated neon hues that suit the topic; one hue per object, a second hue for accents.',
		'  forms   : outline-only symbolic forms for the topic (sign, emblem, device, landscape, architecture…), a large ring or frame behind the hero, optional perspective floor grid converging to a horizon, thin arcs and corner brackets. No filled bodies except very dark plates behind the lines.',
		'  reflect : a faint, low-opacity mirrored echo under a horizon line is welcome.',
		'  text    : the headline is ONE <text> per line, fill near-white; make its glow with stroke on that same element (stroke = neon hue, stroke-opacity 0.35, stroke-width 8–12, paint-order="stroke fill", stroke-linejoin="round"). Never create the glow with duplicate text elements.',
		'',
		'DON\'T',
		`  ✗ ${ c.output } Root ${ c.root }`,
		`  ✗ ${ c.font }`,
		`  ✗ ${ c.titleRule }`,
		`  ✗ ${ c.banned } (so the glow is built from stacked strokes, never from blur).`,
		`  ✗ ${ c.xml }`,
		`  ✗ ${ c.margin }`,
		'  ✗ no pastel or daylight look, no flat bright backgrounds.',
	] );
	const user = userMessage( ctx, ln( [
		`SUBJECT: ${ s.topic }`,
		opt( 'ENERGY', s.mood ),
		opt( 'MEANING', s.meaning ),
		opt( 'IDEAS', s.keys.join( ', ' ) ),
		opt( 'NOTES', s.brief ),
		'Light it up and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 9) PAPERCUT — 레이어 스택 표
// ──────────────────────────────────────────────────────────────
function papercutMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You craft layered paper-cut dioramas. Depth comes ONLY from stacked sheets and the shadows they cast.',
		'',
		'LAYER STACK (back → front)',
		'| # | role                         | how to draw it                                                                    |',
		'|---|------------------------------|-----------------------------------------------------------------------------------|',
		'| 1 | backdrop sheet               | full-canvas rect, flat matte colour                                               |',
		'| 2–4 | landscape / wave sheets    | 3 large organic closed paths with wavy or serrated cut edges, each lower & nearer |',
		'| 5 | focal discs                  | 2–3 concentric circles or rounded shapes forming a stage for the subject         |',
		'| 6 | subject cut-out              | a simplified silhouette of the topic\'s subject built from 2–4 separate paper pieces |',
		'| 7 | small cut accents            | clouds, stars, leaves, dots, confetti — each a separate sheet                      |',
		'| 8 | label strip                  | a paper strip (rounded rect, rotated ≤ 2.5°) that carries the headline            |',
		'',
		'SHADOW RULE (applies to every sheet from #2 on): before drawing a sheet, draw the SAME path once more filled #000 at opacity 0.10–0.16, translated by (0, +6…+14) — and another at opacity 0.06, translated by (0, +16…+24). This duplicate-then-offset trick is what makes it look like paper. Also add a 1–1.5px lighter stroke along the top edge of each sheet.',
		'MATERIAL: flat matte colours, no gradients on the paper itself, no outlines, no glossy highlights, no neon. Choose a palette of 4–6 related hues from the topic; lighter sheets recede, saturated sheets come forward.',
		'',
		'FILE REQUIREMENTS',
		`  ${ c.output } Root ${ c.root }`,
		`  ${ c.font }`,
		`  ${ c.titleRule } (Shadows are applied to shapes, never to text: do not duplicate the headline for a shadow.)`,
		`  ${ c.banned }`,
		`  ${ c.xml }`,
		`  ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		`topic → ${ s.topic }`,
		opt( 'meaning →', s.meaning ),
		opt( 'subject ideas →', s.keys.join( ', ' ) ),
		opt( 'mood →', s.mood ),
		opt( 'notes →', s.brief ),
		'Build the stack and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

// ──────────────────────────────────────────────────────────────
// 10) BLUEPRINT — 제도 규격
// ──────────────────────────────────────────────────────────────
function blueprintMessages( ctx ) {
	const c = contractFacts( ctx ), s = signalsOf( ctx );
	const system = ln( [
		'You are a drafting engineer issuing a technical drawing sheet. Obey the drafting standard below.',
		'',
		'DRAFTING STANDARD DS-01',
		'§1 Sheet     : cyanotype-style drafting paper (a deep blue family is the classic look; another drafting-paper tone is acceptable only if the topic strongly calls for it). Fine square grid built with one <pattern> (minor lines every 20px at ≈8% opacity, major lines every 100px at ≈16%).',
		'§2 Border    : double border — outer line 3px, inner line 1.2px — with 4–6 zone ticks along the edges.',
		'§3 Lines     : three weights only — object lines 3.5–4px, dimension/leader lines 1.8px, centre lines 1.4px dash-dot (stroke-dasharray="16 5 3 5"). Line colour: near-white, with one cyan-like accent colour for leaders.',
		'§4 Subject   : an orthographic line drawing (front or side view, optionally an exploded or detail circle) of the thing that best represents the topic — you decide what that is from its meaning. Hatching (45° parallel lines) may mark cut surfaces. Fills are forbidden except pale tracing-paper discs.',
		'§5 Dimensions: at least two dimension lines with arrowheads on both ends and a small Latin capital letter (A, B…) in a gap of the line.',
		'§6 Callouts  : 2–4 numbered balloons (circled digits 1–4) with leader lines pointing at parts; next to each, a Korean part name of ≤ 8 characters derived from the topic.',
		'§7 Title block: a ruled box in the lower-right corner with small fields such as a sheet number and a scale like 1:1. It must NOT contain the headline.',
		'§8 Headline  : the headline is the sheet title, set large and flat in the open area at the top-left or left.',
		'',
		'SUBMISSION CHECK',
		`  ${ c.output } Root ${ c.root }`,
		`  ${ c.font }`,
		`  ${ c.titleRule } (Callout names and title-block fields are the only other texts; none may repeat the headline.)`,
		`  ${ c.banned } (<pattern> and stroke-dasharray are fine.)`,
		`  ${ c.xml }`,
		`  ${ c.margin }`,
	] );
	const user = userMessage( ctx, ln( [
		`SHEET TITLE: ${ s.topic }`,
		opt( 'SUBJECT (meaning)', s.meaning ),
		opt( 'PARTS TO LABEL (ideas)', s.keys.join( ', ' ) ),
		opt( 'NOTES', s.brief ),
		'Draw the sheet and output the SVG.',
	] ) );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

const BUILDERS = {
	poster: posterMessages, minimal: minimalMessages, typography: typographyMessages, branding: brandingMessages,
	gradient: gradientMessages, infographic: infographicMessages, isometric: isometricMessages,
	neon: neonMessages, papercut: papercutMessages, blueprint: blueprintMessages,
};

/**
 * SVG 스타일 하나의 LLM 메시지를 만든다.
 * @param {string} style  SVG_STYLE_KEYS 중 하나
 * @param {{title:string, plan:object, width:number, height:number, research?:object, brief?:string, customDirection?:string, note?:string, seed?:string}} ctx
 */
export function buildDesignMessages( style, ctx ) {
	const build = BUILDERS[ style ];
	if ( ! build ) throw new Error( `SVG 스타일이 아님: ${ style }` );
	return build( { ...ctx, seed: ctx.seed || Math.random().toString( 36 ).slice( 2, 8 ) } );
}

// ──────────────────────────────────────────────────────────────
// 11) PHOTO_REALISTIC — 확산 모델용 영문 사진 프롬프트를 LLM이 쓴다(글자 없음)
// ──────────────────────────────────────────────────────────────
export function buildPhotoPromptMessages( ctx ) {
	const s = signalsOf( ctx );
	const system = ln( [
		'You are a commercial photographer\'s creative director. Write ONE English prompt for a photorealistic text-to-image model (FLUX class).',
		'Format: a single flowing paragraph of 45–75 words, no lists, no quotes, no markdown, no parentheses weights.',
		'Order: the concrete subject and setting that make this topic instantly understandable → camera and lens (focal length, aperture, angle) → light (direction, quality, time of day) → colour grade and mood → one sentence of fine texture/material detail.',
		'Decide the subject, setting, light and colour yourself from the meaning of the topic. A different topic must give a different scene. Prefer scenes without recognisable people or faces unless the topic is about people; never depict real named individuals.',
		'The picture contains no text, letters, numbers, logos, signs with readable writing, watermarks or UI screens with readable writing — describe such surfaces as blank or out of focus.',
		'Output only the paragraph.',
	] );
	const user = ln( [
		`Topic: ${ s.topic }`,
		opt( 'Meaning', s.meaning ),
		opt( 'Visual context', s.visual ),
		opt( 'Mood', s.mood ),
		opt( 'Do not misread as', s.wrong ),
		opt( 'Notes', s.brief ),
		ctx.note ? `Previous output was unusable: ${ ctx.note }` : '',
		ctx.customDirection ? `Owner's extra direction: ${ String( ctx.customDirection ).slice( 0, 500 ) }` : '',
	] );
	return [ { role: 'system', content: system }, { role: 'user', content: user } ];
}

/** 사진 스타일 공통 negative prompt(글자·왜곡 배제). 색·오브젝트는 지정하지 않는다. */
export const PHOTO_NEGATIVE_PROMPT =
	'text, letters, numbers, watermark, logo, signature, caption, blurry, low quality, distorted, deformed, ' +
	'extra limbs, bad anatomy, jpeg artifacts, oversaturated, noisy, cropped, duplicate, illustration, cartoon, 3d render, cgi';
