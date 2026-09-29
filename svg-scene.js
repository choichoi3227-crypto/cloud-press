/**
 * svg-scene.js — 프롬프트/주제에 맞는 오브젝트로 채워진 SVG 씬 생성기.
 *
 * 기존 방식(LLM이 SVG 전체를 자유롭게 작성)은 결과가 들쭉날쭉하고 XML이 자주
 * 깨졌으며, 주제와 상관없는 추상 도형으로 채워지는 일이 많았다. 이 모듈은
 * 역할을 나눈다.
 *
 *   1) 기획(planScene): 주제·프롬프트를 분석해 "어떤 사물을 그릴지"만 결정한다.
 *      - Workers AI(LLM)가 있으면 JSON 한 줄(hero + support)로 고르게 하고,
 *      - 없거나 실패하면 한/영 키워드 사전으로 결정한다(AI 바인딩 없이도 동작).
 *   2) 작화(composeSceneSvg): svg-objects.js의 검증된 벡터 오브젝트를 배치해
 *      배경·조명·그림자·제목 텍스트까지 결정적으로 조립한다.
 *
 * 결과 SVG는 항상 well-formed 이므로 렌더링 오류가 나지 않고, 같은 입력이면
 * 같은 결과가 나온다(재현 가능).
 */

import { OBJECTS, OBJECT_KEYS, makePalette, hslToHex, lighten, darken } from './svg-objects.js';
import { escapeXml, cleanXmlChars } from './svg-safe.js';

// ──────────────────────────────────────────────────────────────
// 1. 키워드 사전 (한국어 + 영어). 라틴 토큰은 단어 경계로 매칭한다.
// ──────────────────────────────────────────────────────────────
const KEYWORDS = {
	laptop:    [ '노트북', '컴퓨터', '코딩', '개발자', '개발', '프로그래', '웹사이트', '웹 사이트', '홈페이지', '워드프레스', '블로그', '티스토리', '사이트', '재택', '프리랜서', '소프트웨어', '노션', 'laptop', 'computer', 'coding', 'developer', 'programming', 'website', 'wordpress', 'blog', 'software', 'freelance', 'desk', 'workspace', 'office', 'remote work' ],
	phone:     [ '스마트폰', '핸드폰', '휴대폰', '아이폰', '갤럭시', '모바일', '앱', '어플', '통신사', '요금제', '알뜰폰', 'smartphone', 'iphone', 'android', 'mobile', 'app', 'phone' ],
	coffee:    [ '커피', '카페', '라떼', '아메리카노', '원두', '티타임', '디저트', '브런치', '차 ', '음료', 'coffee', 'cafe', 'latte', 'espresso', 'tea', 'barista' ],
	plant:     [ '식물', '화분', '원예', '정원', '가드닝', '인테리어 소품', '반려식물', '꽃', '텃밭', '다육', 'plant', 'garden', 'gardening', 'flower', 'houseplant', 'botanical', 'eco' ],
	book:      [ '책', '독서', '공부', '학습', '시험', '수능', '자격증', '영어', '토익', '교재', '도서', '서평', '글쓰기', '강의', 'book', 'reading', 'study', 'exam', 'learning', 'library', 'textbook', 'novel' ],
	chart:     [ '주식', '투자', '매출', '성장', '마케팅', '통계', '분석', '수익', '재테크', '코인', '비트코인', '펀드', 'etf', '배당', '실적', '전략', '지표', '트래픽', '방문자', '광고', '애드센스', '수입', 'stock', 'invest', 'growth', 'marketing', 'analytics', 'revenue', 'profit', 'trading', 'crypto', 'seo', 'traffic', 'statistics', 'business' ],
	house:     [ '집', '부동산', '아파트', '이사', '전세', '월세', '청약', '주택', '인테리어', '분양', '건축', '리모델링', '대출 이자', 'house', 'home', 'real estate', 'apartment', 'mortgage', 'property', 'interior', 'housing' ],
	car:       [ '자동차', '중고차', '운전', '렌트', '리스료', '자동차 리스', '전기차', '주차', '자동차 보험', '차량', '세차', '타이어', '신차', 'car', 'auto', 'vehicle', 'driving', 'ev', 'sedan', 'automotive' ],
	mountain:  [ '자연', '산', '등산', '캠핑', '숲', '풍경', '트레킹', '힐링', '국립공원', '계곡', '낚시', '아웃도어', '일출', 'nature', 'mountain', 'hiking', 'camping', 'forest', 'landscape', 'outdoor', 'scenery', 'trail' ],
	globe:     [ '세계', '해외', '글로벌', '국제', '인터넷', '네트워크', '환율', '유학', '이민', '다국어', '번역', 'world', 'global', 'international', 'internet', 'network', 'earth', 'worldwide', 'translation' ],
	bulb:      [ '아이디어', '꿀팁', '노하우', '창업', '발명', '창의', '영감', '팁', '비법', '방법', '가이드', '해결', 'idea', 'tips', 'tip', 'creative', 'innovation', 'startup', 'inspiration', 'how to', 'guide', 'solution' ],
	coins:     [ '돈', '절약', '대출', '금융', '보험', '세금', '연말정산', '지원금', '환급', '카드', '적금', '예금', '연금', '저축', '월급', '급여', '소득', '용돈', '현금', '통장', '이자', '환급금', 'money', 'saving', 'loan', 'finance', 'tax', 'insurance', 'cash', 'budget', 'salary', 'income', 'pension', 'bank', 'credit' ],
	bag:       [ '쇼핑', '쿠팡', '할인', '쇼핑몰', '구매', '최저가', '세일', '직구', '패션', '옷', '가방', '브랜드', '선물', '택배', '리뷰', '제품', '추천템', 'shopping', 'sale', 'discount', 'fashion', 'store', 'retail', 'ecommerce', 'purchase', 'gift', 'brand' ],
	camera:    [ '사진', '촬영', '카메라', '영상', '유튜브', '유튜버', '여행 사진', '편집', '브이로그', '릴스', '인스타', '콘텐츠', 'photo', 'photography', 'camera', 'video', 'youtube', 'vlog', 'filming', 'instagram', 'content creator' ],
	health:    [ '건강', '병원', '다이어트', '영양', '의료', '약', '질환', '증상', '치료', '예방', '면역', '비타민', '수면', '스트레스', '검진', '한의원', '통증', '혈압', '당뇨', 'health', 'medical', 'hospital', 'diet', 'nutrition', 'wellness', 'symptom', 'therapy', 'vitamin', 'sleep', 'doctor' ],
	food:      [ '음식', '맛집', '요리', '레시피', '식당', '밥', '라면', '국수', '반찬', '점심', '저녁', '야식', '간식', '배달', '한식', '집밥', '먹거리', 'food', 'recipe', 'restaurant', 'cooking', 'meal', 'dinner', 'lunch', 'noodle', 'kitchen', 'dish' ],
	shield:    [ '보안', '해킹', '개인정보', '백신', '안전', '보호', '사기', '피싱', '랜섬', '방화벽', '비밀번호', '인증', '보증', 'security', 'hacking', 'privacy', 'safety', 'protect', 'phishing', 'antivirus', 'firewall', 'password', 'vpn', 'cyber' ],
	airplane:  [ '여행', '항공', '비행기', '해외여행', '휴가', '관광', '호텔', '숙소', '공항', '항공권', '패키지', '출장', '투어', '리조트', 'travel', 'flight', 'airplane', 'airline', 'vacation', 'trip', 'tourism', 'hotel', 'airport', 'holiday' ],
	chip:      [ '인공지능', '챗gpt', '챗봇', '로봇', '반도체', '머신러닝', '딥러닝', '자동화', '스마트', '테크', '기술', '데이터', '알고리즘', '프롬프트', 'ai', 'artificial intelligence', 'chatgpt', 'gpt', 'robot', 'chip', 'machine learning', 'automation', 'tech', 'technology', 'gemini', 'llm', 'algorithm' ],
	calendar:  [ '일정', '시간', '마감', '스케줄', '계획', '달력', '예약', '기한', '신청 기간', '접수', '기간', '일주일', '루틴', '습관', '연휴', 'schedule', 'calendar', 'deadline', 'planning', 'plan', 'time management', 'routine', 'appointment', 'timeline' ],
	dumbbell:  [ '운동', '헬스', '근력', '홈트', '피트니스', '러닝', '요가', '필라테스', '체력', '스포츠', '근육', '스트레칭', 'gym', 'workout', 'fitness', 'exercise', 'strength', 'training', 'muscle', 'sport', 'running' ],
	cap:       [ '학교', '대학', '취업', '졸업', '입시', '대학원', '학위', '장학금', '교육', '학원', '채용', '면접', '이력서', '진로', '신입', 'school', 'university', 'college', 'graduation', 'education', 'scholarship', 'career', 'job', 'interview', 'resume', 'degree' ],
	document:  [ '서류', '신청', '계약', '후기', '양식', '문서', '증명서', '등록', '발급', '절차', '제출', '민원', '복지', '지원 대상', '자격 요건', '조건', '정책', '법', 'document', 'contract', 'application', 'form', 'paperwork', 'certificate', 'policy', 'legal', 'law', 'checklist', 'report' ],
	cloud:     [ '클라우드', '서버', '호스팅', '도메인', '백업', '스토리지', '클라우드플레어', 'cloudflare', '트래픽 관리', 'cdn', '워커', 'saas', 'cloud', 'server', 'hosting', 'domain', 'backup', 'storage', 'database', 'deploy', 'api', 'aws' ],
	magnifier: [ '검색', '키워드', '조회', '찾기', '비교', '리서치', '조사', '순위', '노출', '검색엔진', '구글', '네이버', '최적화', '상위노출', '탐색', 'search', 'keyword', 'research', 'compare', 'ranking', 'google', 'naver', 'optimization', 'find', 'discover' ],
};

// 주 오브젝트와 함께 놓으면 어울리는 조연 후보 (키워드로 조연이 모자랄 때 채운다).
const SUPPORT_DEFAULTS = {
	laptop: [ 'coffee', 'bulb' ], phone: [ 'chart', 'bag' ], coffee: [ 'book', 'plant' ], plant: [ 'book', 'coffee' ],
	book: [ 'coffee', 'bulb' ], chart: [ 'coins', 'laptop' ], house: [ 'plant', 'coins' ], car: [ 'shield', 'coins' ],
	mountain: [ 'camera', 'plant' ], globe: [ 'airplane', 'phone' ], bulb: [ 'book', 'laptop' ], coins: [ 'chart', 'document' ],
	bag: [ 'phone', 'coins' ], camera: [ 'laptop', 'plant' ], health: [ 'plant', 'dumbbell' ], food: [ 'coffee', 'plant' ],
	shield: [ 'laptop', 'cloud' ], airplane: [ 'globe', 'camera' ], chip: [ 'laptop', 'cloud' ], calendar: [ 'coffee', 'bulb' ],
	dumbbell: [ 'health', 'food' ], cap: [ 'book', 'document' ], document: [ 'coins', 'calendar' ], cloud: [ 'laptop', 'shield' ],
	magnifier: [ 'chart', 'laptop' ],
};

const GENERIC_HEROES = [ 'bulb', 'laptop', 'chart', 'globe', 'document', 'magnifier' ];

function hashString( str ) {
	let h = 2166136261;
	for ( let i = 0; i < str.length; i++ ) {
		h ^= str.charCodeAt( i );
		h = Math.imul( h, 16777619 );
	}
	return h >>> 0;
}

function mulberry32( seed ) {
	let a = seed >>> 0;
	return () => {
		a = ( a + 0x6D2B79F5 ) >>> 0;
		let t = a;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}

const TOKEN_CACHE = {};
const WORD_START = '(?:^|[\\s,.·!?()\\[\\]"\'“”‘’\\-/+])';
// 너무 일반적이라 주제를 특정하지 못하는 단어는 가중치를 낮춘다.
const GENERIC_TOKENS = new Set( [ '방법', '가이드', '팁', '꿀팁', '비법', '해결', '기술', '스마트', '정책', '조건', '기간', '계획', '리뷰', '제품', '브랜드', '데이터', '추천템', '분석', '전략', '지표', '콘텐츠', '교육', '제품', 'guide', 'tips', 'tip', 'business', 'tech', 'plan', 'brand', 'content creator', 'solution', 'how to', 'find', 'report', 'policy', 'law', 'legal' ] );

function tokenMatches( text, token ) {
	const key = token;
	if ( ! TOKEN_CACHE[ key ] ) {
		const esc = token.trim().replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		if ( /^[a-z0-9 ]+$/.test( token ) ) {
			// 영어: 단어 경계 + 복수/ing 허용
			TOKEN_CACHE[ key ] = new RegExp( '(?:^|[^a-z0-9])' + esc + '(?:s|es|ing)?(?:$|[^a-z0-9])' );
		} else if ( Array.from( token.trim() ).length === 1 ) {
			// 한 글자 한글('산','집','약'...)은 "연말정산"·"집에서" 같은 오탐이 많아
			// 단어 시작 위치에서만 인정한다.
			TOKEN_CACHE[ key ] = new RegExp( WORD_START + esc );
		} else {
			TOKEN_CACHE[ key ] = new RegExp( esc );
		}
	}
	return TOKEN_CACHE[ key ].test( text );
}

function tokenWeight( token ) {
	return Array.from( token.trim() ).length === 1 || GENERIC_TOKENS.has( token.trim() ) ? 0.5 : 1;
}

/** 키워드 사전으로 오브젝트별 점수를 계산한다. 제목 3점 / 부제 2점 / 프롬프트 1점. */
export function scoreByKeywords( { topic = '', subtitle = '', prompt = '' } ) {
	const parts = [ [ String( topic ).toLowerCase(), 3 ], [ String( subtitle ).toLowerCase(), 2 ], [ String( prompt ).toLowerCase(), 2 ] ];
	const scores = {};
	for ( const key of OBJECT_KEYS ) {
		let score = 0;
		for ( const [ text, weight ] of parts ) {
			if ( ! text ) continue;
			for ( const token of KEYWORDS[ key ] || [] ) {
				if ( tokenMatches( text, token ) ) score += weight * tokenWeight( token );
			}
		}
		if ( score > 0 ) scores[ key ] = score;
	}
	return scores;
}

function planFromKeywords( input ) {
	const scores = scoreByKeywords( input );
	const ranked = Object.entries( scores ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).map( ( e ) => e[ 0 ] );
	const seedText = `${ input.topic }|${ input.subtitle }|${ input.prompt }`;
	const hero = ranked[ 0 ] || GENERIC_HEROES[ hashString( seedText ) % GENERIC_HEROES.length ];
	// 조연은 충분히 뚜렷한 키워드 근거(2점 이상)가 있을 때만 키워드로 고르고, 나머지는 어울리는 기본 조합으로 채운다.
	const supports = ranked.slice( 1 ).filter( ( k ) => scores[ k ] >= 2 ).slice( 0, 3 );
	for ( const d of SUPPORT_DEFAULTS[ hero ] || [] ) {
		if ( supports.length >= 2 ) break;
		if ( d !== hero && ! supports.includes( d ) ) supports.push( d );
	}
	return { hero, supports: supports.slice( 0, 3 ), planner: 'keyword', matched: !! ranked[ 0 ] };
}

// ──────────────────────────────────────────────────────────────
// 2. LLM 기획 (선택). 그림을 그리게 하지 않고 "무엇을 그릴지"만 고르게 한다.
// ──────────────────────────────────────────────────────────────
const PLAN_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function extractJson( text ) {
	if ( ! text ) return null;
	if ( typeof text === 'object' ) return text;
	const s = String( text );
	const a = s.indexOf( '{' ), b = s.lastIndexOf( '}' );
	if ( a === -1 || b <= a ) return null;
	try { return JSON.parse( s.slice( a, b + 1 ) ); } catch ( e ) { return null; }
}

async function planWithLLM( env, input ) {
	if ( ! env || ! env.AI || typeof env.AI.run !== 'function' ) return null;
	const menu = OBJECT_KEYS.map( ( k ) => `${ k }(${ OBJECTS[ k ].label })` ).join( ', ' );
	const system =
		'You are an art director choosing physical objects for a blog thumbnail illustration. ' +
		'Read the topic and pick the ONE object that best represents the topic literally (hero), ' +
		'plus up to two related supporting objects. Choose ONLY from this list of keys: ' + menu + '. ' +
		'Answer with a single JSON object and nothing else, exactly like: {"hero":"laptop","support":["coffee","chart"]}';
	const user = [
		input.topic ? `Title: ${ input.topic }` : '',
		input.subtitle ? `Subtitle: ${ input.subtitle }` : '',
		input.prompt ? `Image prompt: ${ input.prompt.slice( 0, 500 ) }` : '',
	].filter( Boolean ).join( '\n' );

	try {
		const run = env.AI.run( PLAN_MODEL, {
			messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
			max_tokens: 80,
			temperature: 0.2,
		} );
		const result = await Promise.race( [ run, new Promise( ( _, rej ) => setTimeout( () => rej( new Error( 'plan timeout' ) ), 8000 ) ) ] );
		const parsed = extractJson( result && result.response );
		if ( ! parsed || ! OBJECTS[ parsed.hero ] ) return null;
		const supports = ( Array.isArray( parsed.support ) ? parsed.support : [] )
			.filter( ( k ) => OBJECTS[ k ] && k !== parsed.hero )
			.filter( ( k, i, arr ) => arr.indexOf( k ) === i )
			.slice( 0, 3 );
		return { hero: parsed.hero, supports, planner: 'llm' };
	} catch ( err ) {
		console.warn( `[svg-scene] LLM 기획 실패(키워드로 대체): ${ err && err.message ? err.message : err }` );
		return null;
	}
}

/**
 * 어떤 오브젝트를 그릴지 결정한다. LLM이 있으면 LLM 판단을 우선하되, 조연이 부족하면
 * 키워드 결과와 기본 조합으로 채운다. 항상 유효한 계획을 돌려준다.
 */
export async function planScene( env, body ) {
	const input = {
		topic: cleanXmlChars( body.topic || '' ),
		subtitle: cleanXmlChars( body.subtitle || '' ),
		prompt: cleanXmlChars( body.prompt || '' ),
	};
	const keyword = planFromKeywords( input );
	const llm = await planWithLLM( env, input );
	if ( ! llm ) return keyword;

	const supports = llm.supports.slice();
	for ( const k of [ ...keyword.supports.filter( ( x ) => x !== llm.hero ), ...( SUPPORT_DEFAULTS[ llm.hero ] || [] ) ] ) {
		if ( supports.length >= 2 ) break;
		if ( k !== llm.hero && ! supports.includes( k ) ) supports.push( k );
	}
	return { hero: llm.hero, supports: supports.slice( 0, 2 ), planner: 'llm' };
}

// ──────────────────────────────────────────────────────────────
// 3. 텍스트 측정/줄바꿈 (Noto Sans KR Bold 기준 근사)
// ──────────────────────────────────────────────────────────────
function charWidth( ch, size ) {
	const c = ch.codePointAt( 0 );
	if ( c >= 0x1100 ) return size * 0.98;              // 한글·한자·전각
	if ( ch === ' ' ) return size * 0.28;
	if ( /[A-Z]/.test( ch ) ) return size * 0.68;
	if ( /[a-z]/.test( ch ) ) return size * 0.58;
	if ( /[0-9]/.test( ch ) ) return size * 0.6;
	return size * 0.4;
}

function measure( text, size ) {
	let w = 0;
	for ( const ch of text ) w += charWidth( ch, size );
	return w;
}

function wrapLines( text, maxWidth, size ) {
	const lines = [];
	let line = '';
	let lineW = 0;
	const words = text.split( /(\s+)/ ).filter( ( x ) => x.length );
	const push = () => { if ( line.trim() ) lines.push( line.trim() ); line = ''; lineW = 0; };
	for ( const word of words ) {
		const ww = measure( word, size );
		if ( lineW + ww <= maxWidth ) { line += word; lineW += ww; continue; }
		if ( /^\s+$/.test( word ) ) { push(); continue; }
		if ( ww <= maxWidth ) { push(); line = word; lineW = ww; continue; }
		// 단어 하나가 한 줄보다 길면 글자 단위로 자른다(한국어는 대부분 이 경우).
		for ( const ch of word ) {
			const cw = charWidth( ch, size );
			if ( lineW + cw > maxWidth ) push();
			line += ch;
			lineW += cw;
		}
	}
	push();
	return lines;
}

function fitText( text, maxWidth, maxLines, startSize, minSize ) {
	for ( let size = startSize; size >= minSize; size -= 2 ) {
		const lines = wrapLines( text, maxWidth, size );
		if ( lines.length <= maxLines ) return { size, lines };
	}
	let lines = wrapLines( text, maxWidth, minSize );
	if ( lines.length > maxLines ) {
		lines = lines.slice( 0, maxLines );
		const last = lines[ maxLines - 1 ];
		let cut = last;
		while ( cut.length > 1 && measure( cut + '…', minSize ) > maxWidth ) cut = cut.slice( 0, -1 );
		lines[ maxLines - 1 ] = cut + '…';
	}
	return { size: minSize, lines };
}

// 번들 폰트(Noto Sans KR)에 없는 이모지·특수 기호는 resvg에서 네모(□)로 나오므로 제거한다.
function toRenderable( str ) {
	return cleanXmlChars( str || '' )
		.replace( /[\u{10000}-\u{10FFFF}]/gu, '' )
		.replace( /[\u2190-\u2BFF\uFE00-\uFE0F\u200B-\u200F\u2060\u20A9]/g, '' )
		.replace( /\s+/g, ' ' )
		.trim();
}

const FONT = "Noto Sans KR, Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

// 프롬프트에 색이 명시되면 씬의 주조색으로 삼는다.
const COLOR_WORDS = [
	[ 0, /(?:^|[^a-z])(?:red|crimson|scarlet)(?:$|[^a-z])|빨간|빨강|붉은|레드/ ],
	[ 28, /(?:^|[^a-z])(?:orange|amber|sunset)(?:$|[^a-z])|주황|오렌지|노을/ ],
	[ 48, /(?:^|[^a-z])(?:yellow|golden|gold)(?:$|[^a-z])|노란|노랑|황금|골드/ ],
	[ 140, /(?:^|[^a-z])(?:green|forest|emerald)(?:$|[^a-z])|초록|녹색|그린|숲/ ],
	[ 178, /(?:^|[^a-z])(?:teal|turquoise|cyan|aqua)(?:$|[^a-z])|청록|민트|하늘색/ ],
	[ 216, /(?:^|[^a-z])(?:blue|navy|ocean|sea)(?:$|[^a-z])|파란|파랑|블루|바다/ ],
	[ 272, /(?:^|[^a-z])(?:purple|violet|lavender)(?:$|[^a-z])|보라|퍼플/ ],
	[ 332, /(?:^|[^a-z])(?:pink|rose|magenta)(?:$|[^a-z])|분홍|핑크/ ],
];

function hueFromText( text ) {
	const t = String( text || '' ).toLowerCase();
	for ( const [ hue, re ] of COLOR_WORDS ) if ( re.test( t ) ) return hue;
	return null;
}

const MOTIFS = [ 'disc', 'rings', 'blob', 'stripes', 'grid', 'waves', 'burst', 'arch' ];

/** 오브젝트 뒤 배경 모티프. 시드로 골라 카드마다 인상이 달라지게 한다. */
function motifSvg( kind, cx, cy, r, color, alpha, rand, W, H ) {
	const f = ( n ) => n.toFixed( 1 );
	switch ( kind ) {
		case 'rings':
			return [ 1, 0.8, 0.6 ].map( ( k, i ) => `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( r * 1.15 * k ) }" fill="${ i === 2 ? color : 'none' }" stroke="${ color }" stroke-width="${ f( Math.max( 3, H * 0.006 ) ) }" opacity="${ i === 2 ? alpha : alpha * 1.6 }"/>` ).join( '' );
		case 'blob': {
			const pts = [ ...Array( 9 ).keys() ].map( ( i ) => { const a = i / 9 * Math.PI * 2; const rr = r * ( 0.86 + rand() * 0.3 ); return [ cx + Math.cos( a ) * rr, cy + Math.sin( a ) * rr ]; } );
			let d = `M${ f( ( pts[ 0 ][ 0 ] + pts[ 8 ][ 0 ] ) / 2 ) } ${ f( ( pts[ 0 ][ 1 ] + pts[ 8 ][ 1 ] ) / 2 ) }`;
			for ( let i = 0; i < 9; i++ ) { const a = pts[ i ], b = pts[ ( i + 1 ) % 9 ]; d += ` Q${ f( a[ 0 ] ) } ${ f( a[ 1 ] ) } ${ f( ( a[ 0 ] + b[ 0 ] ) / 2 ) } ${ f( ( a[ 1 ] + b[ 1 ] ) / 2 ) }`; }
			return `<path d="${ d } Z" fill="${ color }" opacity="${ alpha }"/>`;
		}
		case 'stripes': {
			const n = 7, w = r * 2.1 / n;
			return [ ...Array( n ).keys() ].map( ( i ) => `<rect x="${ f( cx - r * 1.05 + i * w ) }" y="${ f( cy - r * 1.1 ) }" width="${ f( w * 0.55 ) }" height="${ f( r * 2.2 ) }" fill="${ color }" opacity="${ alpha }" transform="rotate(14 ${ f( cx ) } ${ f( cy ) })"/>` ).join( '' );
		}
		case 'grid': {
			const n = 6, g = r * 2 / n; let out = '';
			for ( let i = 0; i <= n; i++ ) out += `<path d="M${ f( cx - r + i * g ) } ${ f( cy - r ) } V${ f( cy + r ) } M${ f( cx - r ) } ${ f( cy - r + i * g ) } H${ f( cx + r ) }" stroke="${ color }" stroke-width="2" opacity="${ alpha * 1.6 }"/>`;
			return `<rect x="${ f( cx - r ) }" y="${ f( cy - r ) }" width="${ f( r * 2 ) }" height="${ f( r * 2 ) }" rx="${ f( r * 0.12 ) }" fill="${ color }" opacity="${ alpha * 0.5 }"/>` + out;
		}
		case 'waves':
			return [ 0, 1, 2 ].map( ( i ) => { const y = cy + r * ( 0.35 + i * 0.28 ); return `<path d="M${ f( cx - r * 1.3 ) } ${ f( y ) } Q${ f( cx - r * 0.65 ) } ${ f( y - r * 0.18 ) } ${ f( cx ) } ${ f( y ) } T${ f( cx + r * 1.3 ) } ${ f( y ) } V${ f( H ) } H${ f( cx - r * 1.3 ) } Z" fill="${ color }" opacity="${ alpha * ( 0.6 + i * 0.35 ) }"/>`; } ).join( '' ) + `<circle cx="${ f( cx ) }" cy="${ f( cy - r * 0.2 ) }" r="${ f( r * 0.62 ) }" fill="${ color }" opacity="${ alpha }"/>`;
		case 'burst':
			return [ ...Array( 16 ).keys() ].map( ( i ) => { const a = i / 16 * Math.PI * 2, a2 = a + 0.13; return `<path d="M${ f( cx ) } ${ f( cy ) } L${ f( cx + Math.cos( a ) * r * 1.25 ) } ${ f( cy + Math.sin( a ) * r * 1.25 ) } L${ f( cx + Math.cos( a2 ) * r * 1.25 ) } ${ f( cy + Math.sin( a2 ) * r * 1.25 ) } Z" fill="${ color }" opacity="${ alpha }"/>`; } ).join( '' );
		case 'arch':
			return `<path d="M${ f( cx - r * 0.8 ) } ${ f( cy + r * 0.95 ) } V${ f( cy - r * 0.1 ) } A${ f( r * 0.8 ) } ${ f( r * 0.8 ) } 0 0 1 ${ f( cx + r * 0.8 ) } ${ f( cy - r * 0.1 ) } V${ f( cy + r * 0.95 ) } Z" fill="${ color }" opacity="${ alpha }"/>`;
		default:
			return `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( r ) }" fill="${ color }" opacity="${ alpha }"/>`;
	}
}

// ──────────────────────────────────────────────────────────────
// 4. 씬 합성
// ──────────────────────────────────────────────────────────────
const DARK_STYLES = new Set( [ 'photo_realistic', 'typography', 'poster' ] );

/**
 * @param {{hero:string, supports:string[]}} plan
 * @param {{topic?:string, subtitle?:string, prompt?:string, style:string, width:number, height:number}} opts
 * @returns {string} well-formed SVG 문자열
 */
export function composeSceneSvg( plan, opts ) {
	const { style, width: W, height: H } = opts;
	const topic = toRenderable( opts.topic );
	const subtitle = toRenderable( opts.subtitle );
	const promptText = toRenderable( opts.prompt );
	// 제목이 없고 프롬프트만 있으면 프롬프트 문장을 제목으로 찍지 않고, 그림만 크게 보여 준다.
	const title = topic || subtitle;
	const sub = topic ? subtitle : '';
	const noText = ! title;

	const heroDef = OBJECTS[ plan.hero ] || OBJECTS.bulb;
	const rand = mulberry32( hashString( `${ topic }|${ subtitle }|${ promptText }|${ style }` ) );
	// 씬 주조색: 프롬프트에 색이 있으면 그 색, 없으면 주연 사물의 색에 시드별 변주를 준다.
	const namedHue = hueFromText( `${ promptText } ${ topic } ${ subtitle }` );
	const hueShift = Math.round( ( rand() - 0.5 ) * 70 );
	const sceneHue = namedHue !== null ? namedHue : heroDef.hue + hueShift;
	const P = makePalette( sceneHue );
	const motif = MOTIFS[ Math.floor( rand() * MOTIFS.length ) ];
	const flip = rand() < 0.5;            // 텍스트 좌/우 배치
	const tilt = ( rand() - 0.5 ) * 10;   // 주연 기울기(도)
	const dark = DARK_STYLES.has( style );
	const textColor = dark ? '#ffffff' : darken( P.dark, 0.1 );
	const subColor = dark ? '#ffffff' : P.dark;

	let counter = 0;
	const u = ( name ) => `${ name }${ ++counter }`;

	const defs = [];
	const layers = [];

	// ── 레이아웃 ─────────────────────────────────────────────
	const portrait = W / H < 1.15;
	const typo = style === 'typography';
	let heroS, cx, cy, textX, textW, textCenterY;
	if ( noText ) {
		heroS = portrait ? Math.min( W * 0.78, H * 0.6 ) : Math.min( W * 0.42, H * 0.74 );
		cx = W * 0.5; cy = H * 0.5;
		textX = 0; textW = 0; textCenterY = H * 0.5;
	} else if ( portrait ) {
		heroS = Math.min( W * 0.66, H * 0.42 ) * ( typo ? 0.8 : 1 );
		cx = W * 0.5; cy = H * 0.33;
		textX = W * 0.08; textW = W * 0.84; textCenterY = H * 0.75;
	} else {
		heroS = Math.min( W * 0.32, H * 0.62 ) * ( typo ? 0.78 : 1 );
		const heroX = typo ? 0.78 : 0.72;
		cx = W * ( flip && ! typo ? 1 - heroX : heroX ); cy = H * ( typo ? 0.6 : 0.5 );
		textW = W * ( typo ? 0.62 : 0.44 );
		textX = flip && ! typo ? W * 0.93 - textW : W * 0.07;
		textCenterY = H * 0.5;
	}
	const floorY = cy + heroS * 0.5;

	// ── 배경 ────────────────────────────────────────────────
	const bgId = u( 'bg' );
	const vg = u( 'vg' );
	const spot = u( 'spot' );
	const fl = u( 'fl' );
	const bokeh = u( 'bok' );

	if ( style === 'photo_realistic' ) {
		defs.push( `<linearGradient id="${ bgId }" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ hslToHex( P.hue, 38, 9 ) }"/><stop offset="1" stop-color="${ hslToHex( P.hue, 32, 20 ) }"/></linearGradient>` );
		defs.push( `<radialGradient id="${ spot }" gradientUnits="userSpaceOnUse" cx="${ cx }" cy="${ cy - heroS * 0.05 }" r="${ heroS * 1.25 }"><stop offset="0" stop-color="${ hslToHex( P.hue, 75, 60 ) }" stop-opacity="0.55"/><stop offset="1" stop-color="${ hslToHex( P.hue, 75, 60 ) }" stop-opacity="0"/></radialGradient>` );
		defs.push( `<radialGradient id="${ bokeh }"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` );
		defs.push( `<linearGradient id="${ fl }" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ hslToHex( P.hue, 30, 24 ) }"/><stop offset="1" stop-color="${ hslToHex( P.hue, 35, 6 ) }"/></linearGradient>` );
		defs.push( `<radialGradient id="${ vg }" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bgId })"/>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ spot })"/>` );
		for ( let i = 0; i < 9; i++ ) {
			const r = H * ( 0.04 + rand() * 0.09 );
			layers.push( `<circle cx="${ ( rand() * W ).toFixed( 1 ) }" cy="${ ( rand() * floorY * 0.95 ).toFixed( 1 ) }" r="${ r.toFixed( 1 ) }" fill="url(#${ bokeh })"/>` );
		}
		layers.push( motifSvg( motif, cx, cy, heroS * 0.8, hslToHex( P.hue, 70, 62 ), 0.10, rand, W, H ) );
		layers.push( `<rect x="0" y="${ floorY - 2 }" width="${ W }" height="${ H - floorY + 2 }" fill="url(#${ fl })"/>` );
		layers.push( `<rect x="0" y="${ floorY - 2 }" width="${ W }" height="2" fill="#fff" opacity="0.1"/>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ vg })"/>` );
	} else if ( style === 'poster' ) {
		const pat = u( 'dots' );
		defs.push( `<linearGradient id="${ bgId }" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ P.c1 }"/><stop offset="1" stop-color="${ darken( P.c2, 0.25 ) }"/></linearGradient>` );
		defs.push( `<pattern id="${ pat }" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="2.6" fill="#fff" opacity="0.22"/></pattern>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bgId })"/>` );
		layers.push( `<rect x="0" y="0" width="${ W * 0.55 }" height="${ H }" fill="url(#${ pat })"/>` );
		layers.push( `<polygon points="${ W * 0.5 },0 ${ W },0 ${ W },${ H } ${ W * 0.38 },${ H }" fill="#000" opacity="0.14"/>` );
		layers.push( motifSvg( motif, cx, cy, heroS * 0.72, P.acc, 0.92, rand, W, H ) );
		layers.push( `<circle cx="${ cx }" cy="${ cy }" r="${ heroS * 0.86 }" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 12" opacity="0.5"/>` );
	} else if ( style === 'typography' ) {
		defs.push( `<linearGradient id="${ bgId }" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ hslToHex( P.hue, 40, 10 ) }"/><stop offset="1" stop-color="${ hslToHex( P.hue + 20, 45, 20 ) }"/></linearGradient>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bgId })"/>` );
		const glyph = Array.from( title )[ 0 ] || '';
		if ( glyph ) layers.push( `<text x="${ -W * 0.015 }" y="${ H * 1.0 }" text-anchor="start" font-family="${ FONT }" font-weight="700" font-size="${ H * 1.15 }" fill="#fff" opacity="0.045">${ escapeXml( glyph ) }</text>` );
		layers.push( motifSvg( motif, cx, cy, heroS * 0.74, P.c1, 0.24, rand, W, H ) );
		if ( ! noText ) layers.push( `<rect x="${ textX }" y="${ H * 0.12 }" width="${ W * 0.05 }" height="${ Math.max( 5, H * 0.008 ) }" fill="${ P.acc }"/>` );
	} else if ( style === 'branding' ) {
		defs.push( `<linearGradient id="${ bgId }" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${ lighten( P.c1, 0.86 ) }"/></linearGradient>` );
		defs.push( `<radialGradient id="${ spot }" gradientUnits="userSpaceOnUse" cx="${ cx }" cy="${ cy - heroS * 0.1 }" r="${ heroS * 0.7 }"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${ lighten( P.c1, 0.8 ) }"/></radialGradient>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bgId })"/>` );
		layers.push( `<rect x="0" y="0" width="${ W * 0.014 }" height="${ H }" fill="${ P.c1 }"/>` );
		layers.push( motifSvg( motif, cx, cy, heroS * 0.74, P.c1, 0.16, rand, W, H ) );
		layers.push( `<circle cx="${ cx }" cy="${ cy }" r="${ heroS * 0.6 }" fill="url(#${ spot })" stroke="${ P.c1 }" stroke-opacity="0.25" stroke-width="2"/>` );
		layers.push( `<circle cx="${ cx }" cy="${ cy }" r="${ heroS * 0.84 }" fill="none" stroke="${ P.c1 }" stroke-opacity="0.15" stroke-width="1.5"/>` );
		if ( ! noText ) layers.push( `<path d="M${ W * 0.07 } ${ H * 0.9 } H${ W * 0.2 }" stroke="${ P.c1 }" stroke-width="3" opacity="0.6"/>` );
	} else { // minimal
		defs.push( `<linearGradient id="${ bgId }" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ hslToHex( P.hue, 30, 97 ) }"/><stop offset="1" stop-color="${ hslToHex( P.hue, 34, 91 ) }"/></linearGradient>` );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bgId })"/>` );
		layers.push( motifSvg( motif, cx, cy, heroS * 0.72, P.c1, 0.16, rand, W, H ) );
		layers.push( `<circle cx="${ cx + heroS * 0.55 }" cy="${ cy - heroS * 0.5 }" r="${ heroS * 0.16 }" fill="${ P.acc }" opacity="0.5"/>` );
	}

	// ── 오브젝트 배치 ────────────────────────────────────────
	const shadowId = u( 'shd' );
	defs.push( `<radialGradient id="${ shadowId }"><stop offset="0" stop-color="#000" stop-opacity="${ dark ? 0.6 : 0.3 }"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` );

	const place = ( key, x, y, s, rot = 0 ) => {
		x = Math.min( Math.max( x, s * 0.52 + W * 0.02 ), W - s * 0.52 - W * 0.02 );   // 화면 밖으로 잘리지 않게
		const def = OBJECTS[ key ];
		// 사물마다 자기 색(커피=갈색, 식물=초록 ...)을 쓰되, 씬 주조색이 명시됐으면 주연에만 반영한다.
		const OP = key === plan.hero || namedHue === null ? makePalette( key === plan.hero ? sceneHue : def.hue ) : makePalette( def.hue );
		const { defs: d, body } = def.draw( OP, u );
		defs.push( d );
		const out = [];
		if ( ! def.floating ) out.push( `<ellipse cx="${ x.toFixed( 1 ) }" cy="${ ( y + s * 0.5 ).toFixed( 1 ) }" rx="${ ( s * 0.46 ).toFixed( 1 ) }" ry="${ ( s * 0.065 ).toFixed( 1 ) }" fill="url(#${ shadowId })"/>` );
		else out.push( `<ellipse cx="${ x.toFixed( 1 ) }" cy="${ ( y + s * 0.62 ).toFixed( 1 ) }" rx="${ ( s * 0.3 ).toFixed( 1 ) }" ry="${ ( s * 0.04 ).toFixed( 1 ) }" fill="url(#${ shadowId })" opacity="0.6"/>` );
		out.push( `<g transform="translate(${ x.toFixed( 1 ) } ${ y.toFixed( 1 ) }) rotate(${ rot.toFixed( 1 ) }) scale(${ ( s / 100 ).toFixed( 4 ) })">${ body }</g>` );
		return out.join( '' );
	};

	// 조연은 주연 앞쪽에 시드별로 다른 배열(양옆 / 한쪽 모음 / 뒤쪽 높은 위치)로 배치한다.
	const sup = ( plan.supports || [] ).filter( ( k ) => OBJECTS[ k ] ).slice( 0, 3 );
	const arrange = Math.floor( rand() * 3 );
	const mirror = flip && ! portrait && ! typo && ! noText ? -1 : 1;   // 텍스트가 오른쪽이면 조연 x 방향도 반대로
	const slots = [
		[ [ -0.5, 0.29, 0.42 ], [ 0.5, 0.31, 0.36 ], [ 0.05, 0.4, 0.26 ] ],
		[ [ 0.5, 0.3, 0.4 ], [ 0.72, 0.36, 0.3 ], [ -0.52, 0.32, 0.32 ] ],
		[ [ -0.52, 0.06, 0.34 ], [ 0.54, 0.02, 0.32 ], [ 0.0, 0.42, 0.28 ] ],
	][ arrange ];
	// 뒤쪽 배치(arrange 2)는 주연 뒤에서 먼저 그려 깊이감을 준다.
	if ( arrange === 2 ) sup.slice( 0, 2 ).forEach( ( k, i ) => layers.push( place( k, cx + heroS * slots[ i ][ 0 ] * mirror * ( portrait ? 1.05 : 1 ), cy + heroS * slots[ i ][ 1 ], heroS * slots[ i ][ 2 ], ( i ? 1 : -1 ) * ( 4 + rand() * 6 ) ) ) );
	layers.push( place( plan.hero, cx, cy, heroS, tilt ) );
	sup.forEach( ( k, i ) => {
		if ( arrange === 2 && i < 2 ) return;
		const sl = slots[ i ];
		layers.push( place( k, cx + heroS * sl[ 0 ] * mirror * ( portrait ? 1.05 : 1 ), cy + heroS * sl[ 1 ], heroS * sl[ 2 ], ( rand() - 0.5 ) * 8 ) );
	} );

	// ── 텍스트 ──────────────────────────────────────────────
	if ( title ) {
		const startTitle = Math.round( H * ( portrait ? 0.058 : 0.088 ) * ( typo ? 1.15 : 1 ) );
		const minTitle = Math.round( H * 0.04 );
		const t = fitText( title, textW, 3, startTitle, minTitle );
		const tLead = t.size * 1.22;
		let s = null;
		if ( sub ) s = fitText( sub, textW, 2, Math.round( t.size * 0.5 ), Math.round( H * 0.026 ) );
		const sLead = s ? s.size * 1.45 : 0;
		const gap = s ? t.size * 0.35 : 0;
		const blockH = t.lines.length * tLead + gap + ( s ? s.lines.length * sLead : 0 );
		let y = textCenterY - blockH / 2 + t.size * 0.95;

		if ( dark && ! typo && style !== 'poster' ) {
			layers.push( `<rect x="${ textX - W * 0.02 }" y="${ textCenterY - blockH / 2 - H * 0.04 }" width="${ textW + W * 0.04 }" height="${ blockH + H * 0.08 }" rx="${ H * 0.02 }" fill="#000" opacity="0.28"/>` );
		}
		if ( ! typo ) layers.push( `<rect x="${ textX }" y="${ ( textCenterY - blockH / 2 - H * 0.03 ).toFixed( 1 ) }" width="${ ( W * 0.05 ).toFixed( 1 ) }" height="${ Math.max( 5, H * 0.008 ).toFixed( 1 ) }" rx="2" fill="${ P.acc }"/>` );

		const shadow = dark ? ' style="paint-order:stroke"' : '';
		t.lines.forEach( ( line, i ) => {
			layers.push( `<text x="${ textX.toFixed( 1 ) }" y="${ ( y + i * tLead ).toFixed( 1 ) }" font-family="${ FONT }" font-size="${ t.size }" font-weight="700" fill="${ textColor }"${ shadow }>${ escapeXml( line ) }</text>` );
		} );
		y += ( t.lines.length - 1 ) * tLead;
		if ( s ) {
			y += gap + s.size * 0.95 + t.size * 0.3;
			s.lines.forEach( ( line, i ) => {
				layers.push( `<text x="${ textX.toFixed( 1 ) }" y="${ ( y + i * sLead ).toFixed( 1 ) }" font-family="${ FONT }" font-size="${ s.size }" font-weight="400" fill="${ subColor }" opacity="0.85">${ escapeXml( line ) }</text>` );
			} );
		}
	}

	const label = escapeXml( title || heroDef.label );
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ W }" height="${ H }" viewBox="0 0 ${ W } ${ H }" role="img" aria-label="${ label }">
<title>${ label }</title>
<desc>${ escapeXml( `${ heroDef.label } 중심 일러스트 (${ style })` ) }</desc>
<defs>${ defs.join( '' ) }</defs>
${ layers.join( '\n' ) }
</svg>`;
}
