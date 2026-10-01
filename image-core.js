/**
 * image-core.js — POST/GET /api/image
 *
 * zorlinq32(WordPress 플러그인)가 보내는
 *   { topic, style, research?, prompt?, custom_direction?, width?, height? }
 * 를 받아 이미지를 만들어
 *   { data_url, mime_type, format, width, height, provider, model_used, style, text_included, attempts }
 * 로 돌려준다.
 *
 * ── 동작 원칙 ───────────────────────────────────────────────────────────
 * 1) 스타일마다 AI "아트 디렉터"가 따로 있다 (image-styles.js).
 *    - 포스터/미니멀/타이포그래피/브랜딩/그라디언트/인포그래픽/아이소메트릭/네온/페이퍼컷/블루프린트
 *      → LLM(Workers AI)이 스타일 전용 지시서를 받아 SVG를 직접 디자인한다.
 *    - 사실적 사진 → LLM이 영문 사진 프롬프트를 쓰고 FLUX/SDXL 계열 이미지 모델이 그린다(글자 없음).
 * 2) 색상·오브젝트·소재는 코드가 정하지 않는다. 주제의 의미(research)를 읽은 AI가 정한다.
 *    (과거의 오브젝트 라이브러리 / 스타일별 고정 팔레트 / 자동 조립 폴백은 제거되었다.)
 * 3) 제목은 이미지 안에 정확히 한 번만 그려진다(text_included=true). 호출자는 제목을 다시 합성하면 안 된다.
 *    결과는 svg-audit.js가 검수한다: 제목 누락·중복이면 이유를 알려 재시도하고, 글자가 넘치면 크기를 줄인다.
 * 4) AI가 끝내 유효한 결과를 못 내면 "그럴듯한 기본 카드"로 얼버무리지 않고 오류(HTTP 502)를 돌려준다.
 *    AI 바인딩(env.AI)이 없으면 503. 호출자는 사용자에게 재시도를 안내하면 된다.
 * 5) SVG 결과는 @cf-wasm/resvg로 PNG 변환을 시도한다(실패 시 SVG 그대로, FORCE_SVG_ONLY=true면 항상 SVG).
 *
 * 환경 변수(선택)
 *   SVG_MODELS        쉼표로 구분한 LLM 모델 ID 목록(앞에서부터 사용). 기본: Llama 3.3 70B → Qwen2.5-Coder 32B
 *   IMAGE_BUDGET_MS   한 요청의 AI 호출 총 예산(기본 110000)
 *   FORCE_SVG_ONLY    "true"면 PNG 변환을 건너뜀
 */

import { CORS_HEADERS, json } from './search-core.js';
import { finalizeSvg, svgToDataUrl, countDrawn } from './svg-safe.js';
import { auditTitle, fitTextOverflow, stripAllText } from './svg-audit.js';
import {
	STYLE_KEYS, isSvgStyle, planTitle, buildDesignMessages, buildPhotoPromptMessages,
	STYLE_MIN_DRAWN, STYLE_TEMPERATURE, PHOTO_NEGATIVE_PROMPT,
} from './image-styles.js';
import KOREAN_FONT_TTF from './assets/fonts/NotoSansKR-Bold.ttf';

// ──────────────────────────────────────────────────────────────────────
// 1. 이미지 모델 카탈로그(사실적 사진 스타일 전용): 각 모델의 정확한 ID와 요청 형식(JSON vs multipart).
//    전부 Cloudflare 공식 문서 기준으로 확인된 값이다.
// ──────────────────────────────────────────────────────────────────────
const IMAGE_MODELS = {
	FLUX_SCHNELL: {
		id: '@cf/black-forest-labs/flux-1-schnell',
		label: 'FLUX.1 Schnell',
		format: 'json',
		// FLUX.1 schnell은 negative_prompt/steps 파라미터를 받지 않는다(4스텝 고정).
		supportsNegative: false,
		buildInput( prompt ) {
			return { prompt };
		},
	},
	FLUX2_KLEIN_4B: {
		id: '@cf/black-forest-labs/flux-2-klein-4b',
		label: 'FLUX.2 Klein 4B',
		format: 'multipart',
		supportsNegative: false,
		// distilled 모델이라 steps는 4로 고정, 조정 불가.
		buildForm( prompt, width, height ) {
			return { prompt, width: String( width ), height: String( height ) };
		},
	},
	FLUX2_KLEIN_9B: {
		id: '@cf/black-forest-labs/flux-2-klein-9b',
		label: 'FLUX.2 Klein 9B',
		format: 'multipart',
		supportsNegative: false,
		buildForm( prompt, width, height ) {
			return { prompt, width: String( width ), height: String( height ) };
		},
	},
	FLUX2_DEV: {
		id: '@cf/black-forest-labs/flux-2-dev',
		label: 'FLUX.2 Dev',
		format: 'multipart',
		supportsNegative: false,
		// 가장 느리고 가장 고품질. steps 조정 가능(기본 25 권장).
		buildForm( prompt, width, height ) {
			return { prompt, width: String( width ), height: String( height ), steps: '25' };
		},
	},
	PHOENIX: {
		id: '@cf/leonardo/phoenix-1.0',
		label: 'Phoenix 1.0',
		format: 'json',
		supportsNegative: true,
		buildInput( prompt, width, height, negative ) {
			return {
				prompt, width, height,
				steps: 25,        // 1-50, 기본 25
				guidance: 2,       // 2-10, 기본 2
				negative_prompt: negative,
			};
		},
	},
	LUCID_ORIGIN: {
		id: '@cf/leonardo/lucid-origin',
		label: 'Lucid Origin',
		format: 'json',
		supportsNegative: true,
		buildInput( prompt, width, height, negative ) {
			return {
				prompt, width, height,
				num_steps: 30,     // 1-40
				guidance: 4.5,      // 0-10, 기본 4.5
				negative_prompt: negative,
			};
		},
	},
	DREAMSHAPER: {
		id: '@cf/lykon/dreamshaper-8-lcm',
		label: 'DreamShaper 8 LCM',
		format: 'json',
		supportsNegative: true,
		buildInput( prompt, width, height, negative ) {
			return {
				prompt, width, height,
				num_steps: 8,       // LCM 계열이라 적은 스텝으로도 충분(최대 20)
				guidance: 2,         // LCM류는 낮은 guidance 권장
				negative_prompt: negative,
			};
		},
	},
	SDXL_LIGHTNING: {
		id: '@cf/bytedance/stable-diffusion-xl-lightning',
		label: 'SDXL Lightning',
		format: 'json',
		supportsNegative: true,
		buildInput( prompt, width, height, negative ) {
			return {
				prompt, width, height,
				num_steps: 6,        // Lightning은 2~8스텝이면 충분(최대 20)
				guidance: 2,
				negative_prompt: negative,
			};
		},
	},
	SDXL_BASE: {
		id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
		label: 'Stable Diffusion XL Base 1.0',
		format: 'json',
		supportsNegative: true,
		buildInput( prompt, width, height, negative ) {
			return {
				prompt, width, height,
				num_steps: 20,       // 최대 20
				guidance: 7.5,
				negative_prompt: negative,
			};
		},
	},
};

// ──────────────────────────────────────────────────────────────────────
// 2. 사실적 사진 스타일의 모델 시도 순서(무작위 시작점 + 실패 시 다음 모델).
//    다른 스타일은 이미지 모델을 쓰지 않는다(확산 모델은 한글 제목을 그리지 못하므로).
// ──────────────────────────────────────────────────────────────────────
const PHOTO_MODEL_POOL = [ 'FLUX2_DEV', 'LUCID_ORIGIN', 'SDXL_BASE', 'PHOENIX' ];

function pickModelOrder() {
	const shuffled = PHOTO_MODEL_POOL.slice();
	for ( let i = shuffled.length - 1; i > 0; i-- ) {
		const j = Math.floor( Math.random() * ( i + 1 ) );
		[ shuffled[ i ], shuffled[ j ] ] = [ shuffled[ j ], shuffled[ i ] ];
	}
	return shuffled;
}

/**
 * 선택된 모델 하나를 실제로 호출한다.
 * 성공 시 { ok: true, base64, mime, modelKey, modelId, modelLabel } 반환.
 * 실패 시 { ok: false, nsfw: boolean } 반환해 호출부가 다음 모델로 넘어가거나,
 * NSFW 오탐이면 완화된 프롬프트로 재시도할지 판단할 수 있게 한다.
 */
async function callOneModel( env, modelKey, prompt, width, height ) {
	const model = IMAGE_MODELS[ modelKey ];
	if ( ! model ) return { ok: false, nsfw: false };

	try {
		let result;

		if ( 'multipart' === model.format ) {
			// FLUX.2 계열: multipart/form-data, negative_prompt 미지원.
			// ⚠️ FormData를 env.AI.run에 그대로 넘기면 안 된다 — Content-Type에
			// boundary가 없어 Cloudflare가 파싱하지 못한다. Response 생성자를
			// 거쳐 실제 바이트 스트림과 boundary가 포함된 contentType을 뽑아내
			// 넘기는 것이 Cloudflare 공식 예제의 정확한 방식이다.
			const fields = model.buildForm( prompt, width, height );
			const form = new FormData();
			for ( const [ k, v ] of Object.entries( fields ) ) {
				form.append( k, v );
			}
			const formResponse = new Response( form );
			const formStream = formResponse.body;
			const formContentType = formResponse.headers.get( 'content-type' );
			result = await env.AI.run( model.id, { multipart: { body: formStream, contentType: formContentType } } );
		} else {
			// JSON 계열(SDXL/DreamShaper/Leonardo/FLUX schnell).
			const negative = model.supportsNegative ? PHOTO_NEGATIVE_PROMPT : undefined;
			const input = model.buildInput( prompt, width, height, negative );
			result = await env.AI.run( model.id, input );
		}

		if ( ! result ) return { ok: false, nsfw: false };

		// Workers AI 이미지 모델은 대개 ReadableStream(바이너리 이미지) 또는
		// { image: base64 } 형태를 반환한다. 두 경우를 모두 처리한다.
		if ( result instanceof ReadableStream ) {
			const buf = await new Response( result ).arrayBuffer();
			const base64 = arrayBufferToBase64( buf );
			return { ok: true, base64, mime: 'image/png', modelKey, modelId: model.id, modelLabel: model.label };
		}
		if ( result.image ) {
			return { ok: true, base64: result.image, mime: 'image/jpeg', modelKey, modelId: model.id, modelLabel: model.label };
		}

		return { ok: false, nsfw: false };
	} catch ( err ) {
		const msg = err && err.message ? err.message : String( err );
		// NSFW 오탐(에러 코드 3030)은 Cloudflare Flux 계열에서 알려진 이슈로,
		// "hamburger" 같은 무해한 단어에도 오발동한다. 이 경우 재시도해도
		// 같은 프롬프트로는 다시 걸릴 가능성이 높으므로, 원인을 구분해
		// 로그로 남겨 "모델이 실제로 망가진 것"과 구별할 수 있게 한다.
		const isNsfwFalsePositive = /3030|nsfw/i.test( msg );
		console.warn(
			`[image-core] 모델 실패: ${ model.id }` +
			( isNsfwFalsePositive ? ' (NSFW 필터 오탐 가능성)' : '' ) +
			` — ${ msg }`
		);
		return { ok: false, nsfw: isNsfwFalsePositive };
	}
}

function arrayBufferToBase64( input ) {
	// Uint8Array 뷰가 넘어오면 그 뷰의 범위만 인코딩해야 한다. 예전에는 pngBuffer.buffer(뷰가
	// 가리키는 "전체" ArrayBuffer)를 넘겨, 뷰가 offset을 가진 경우 PNG가 깨질 수 있었다.
	const bytes = input instanceof Uint8Array ? input : new Uint8Array( input );
	let binary = '';
	const chunkSize = 0x8000;
	for ( let i = 0; i < bytes.length; i += chunkSize ) {
		binary += String.fromCharCode.apply( null, bytes.subarray( i, i + chunkSize ) );
	}
	return btoa( binary );
}

// 입력 문자열 정리(제어문자 제거·공백 정규화·길이 제한)
function sanitizeImageText( value, maxLength ) {
	return String( value || '' )
		.replace( /[\u0000-\u001F\u007F]/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim()
		.slice( 0, maxLength );
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * 5. SVG → PNG 래스터라이즈 (@cf-wasm/resvg, WASM 기반, 외부 API 호출 없음)
 * ──────────────────────────────────────────────────────────────────────
 *
 * ⚠️ 중요: @cf-wasm/resvg의 신버전 워크어드 빌드(import { Resvg } from
 * '@cf-wasm/resvg/workerd')는 woff2 폰트 버퍼를 로드하는 순간 WASM 내부에서
 * "unreachable" 패닉을 일으키는 것이 로컬 검증(Node 런타임 기준)에서
 * 확인되었다. 반면 TTF는 문제없이 로드·렌더링된다. 이 때문에 이 파일은
 * woff2가 아니라 TTF(한글 완성형 전체 서브셋, 약 2.4MB)를 번들한다.
 * legacy 엔트리포인트(@cf-wasm/resvg/legacy/workerd, 구 resvg-wasm 2.4.1)는
 * woff2 로드 자체는 크래시하지 않지만 실제 렌더링에서 텍스트가 통째로
 * 빠지는 현상이 확인되어 채택하지 않았다.
 *
 * Workers 무료 플랜은 CPU 10ms 제한이 있어 대형 카드(1600x900+, 레이어가
 * 많은 SVG)에서는 간헐적으로 시간 초과가 날 수 있다. 이 함수는 실패하면
 * null을 반환하고, 호출부(tryConvertToPng)가 원본 SVG를 그대로 반환한다.
 * (이 경우 응답의 format은 'svg'이며 제목은 SVG 안에 그대로 들어 있다.)
 */
let cachedResvgModule = null;
async function loadResvgModule() {
	if ( cachedResvgModule ) return cachedResvgModule;
	// 정적 문자열 리터럴로 import해야 Workers 번들러가 워크어드 전용
	// 엔트리포인트를 정확히 고른다(동적 경로 조합은 번들러가 처리 못 함).
	cachedResvgModule = await import( '@cf-wasm/resvg/workerd' );
	return cachedResvgModule;
}

/**
 * 주어진 SVG 원문을 PNG 바이트로 래스터라이즈한다.
 * 성공: { base64, mime: 'image/png' } / 실패(폰트 로드 실패, CPU 시간초과,
 * WASM 오류 등 무엇이든): null — 절대 예외를 던지지 않는다.
 */
async function rasterizeSvgToPng( svg, width, height ) {
	if ( ! svg ) return null;
	try {
		const { Resvg } = await loadResvgModule();
		const resvg = await Resvg.async( svg, {
			font: {
				fontBuffers: [ new Uint8Array( KOREAN_FONT_TTF ) ],
				loadSystemFonts: false,
				defaultFontFamily: 'Noto Sans KR',
			},
			fitTo: { mode: 'width', value: width },
			background: 'rgba(0,0,0,0)',
		} );
		const pngData = resvg.render();
		const pngBytes = pngData.asPng();
		// PNG 시그니처(89 50 4E 47)를 확인해, 비정상 바이트가 PNG로 둔갑해 나가지 않게 한다.
		if ( ! pngBytes || pngBytes.length < 8 || pngBytes[ 0 ] !== 0x89 || pngBytes[ 1 ] !== 0x50 || pngBytes[ 2 ] !== 0x4E || pngBytes[ 3 ] !== 0x47 ) {
			throw new Error( 'resvg가 유효한 PNG를 반환하지 않음' );
		}
		return { base64: arrayBufferToBase64( pngBytes ), mime: 'image/png' };
	} catch ( err ) {
		console.warn( `[image-core] SVG→PNG 래스터라이즈 실패(SVG로 폴백): ${ err && err.message ? err.message : err }` );
		return null;
	}
}

/**
 * generateImage가 만든 SVG 결과(raw_svg 포함)를 받아 PNG 변환을 시도하고,
 * 성공하면 결과를 PNG로 치환해 반환한다. env.FORCE_SVG_ONLY === 'true'면
 * 변환을 아예 건너뛴다(완전 무료 운영, CPU 여유 확보 목적).
 * 실패하거나 raw_svg가 없으면 입력을 그대로 반환한다.
 */
async function tryConvertToPng( env, result ) {
	if ( ! result || ! result.raw_svg ) return result;
	if ( env && String( env.FORCE_SVG_ONLY ).toLowerCase() === 'true' ) return result;

	const png = await rasterizeSvgToPng( result.raw_svg, result.width, result.height );
	if ( ! png ) return result; // 변환 실패 — 원본 SVG 결과를 그대로 반환(항상 성공 보장).

	const { raw_svg, ...rest } = result;
	return {
		...rest,
		data_url:  `data:${ png.mime };base64,${ png.base64 }`,
		mime_type: png.mime,
		format:    'png',
	};
}

// ──────────────────────────────────────────────────────────────────────
// 3. AI 디자인 파이프라인
// ──────────────────────────────────────────────────────────────────────

export class ImageError extends Error {
	constructor( code, status, message, details ) {
		super( message );
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

const DEFAULT_SVG_MODELS = [
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'@cf/qwen/qwen2.5-coder-32b-instruct',
];
const SVG_MAX_TOKENS = 6000;
const PER_CALL_TIMEOUT_MS = 80000;
const DEFAULT_BUDGET_MS = 110000;

function svgModels( env ) {
	const fromEnv = String( ( env && env.SVG_MODELS ) || '' ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
	return fromEnv.length ? fromEnv : DEFAULT_SVG_MODELS;
}

function hasAI( env ) {
	return !! ( env && env.AI && typeof env.AI.run === 'function' );
}

function withTimeout( promise, ms, label ) {
	let timer;
	const timeout = new Promise( ( _, reject ) => { timer = setTimeout( () => reject( new Error( `${ label } 시간 초과(${ ms }ms)` ) ), ms ); } );
	return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) );
}

/** 모델별로 다른 응답 모양(response / choices[].message.content)을 문자열로 통일한다. */
function textOfAiResult( result ) {
	if ( ! result ) return '';
	if ( typeof result === 'string' ) return result;
	if ( typeof result.response === 'string' ) return result.response;
	const c = result.choices && result.choices[ 0 ];
	if ( c && c.message && typeof c.message.content === 'string' ) return c.message.content;
	if ( c && typeof c.text === 'string' ) return c.text;
	if ( result.result && typeof result.result.response === 'string' ) return result.result.response;
	return '';
}

async function runLlm( env, model, messages, { temperature, maxTokens, timeoutMs } ) {
	const result = await withTimeout(
		env.AI.run( model, { messages, max_tokens: maxTokens, temperature, top_p: 0.92 } ),
		timeoutMs,
		model.split( '/' ).pop()
	);
	return textOfAiResult( result );
}

/** 코드펜스/설명문이 섞여 있어도 첫 <svg ...>부터 마지막 </svg>(또는 끝)까지만 뽑는다. */
export function extractSvgText( raw ) {
	let s = String( raw || '' ).replace( /```(?:svg|xml|html)?/gi, '' );
	const start = s.search( /<svg\b/i );
	if ( start < 0 ) return '';
	s = s.slice( start );
	const end = s.toLowerCase().lastIndexOf( '</svg>' );
	return end >= 0 ? s.slice( 0, end + 6 ) : s;
}

export function normalizeResearch( value ) {
	let r = value;
	if ( typeof r === 'string' ) { try { r = JSON.parse( r ); } catch ( e ) { r = null; } }
	if ( ! r || typeof r !== 'object' || Array.isArray( r ) ) return {};
	const str = ( v, n ) => sanitizeImageText( v, n );
	return {
		actual_meaning: str( r.actual_meaning, 400 ),
		visual_context: str( r.visual_context, 400 ),
		emotional_tone: str( r.emotional_tone, 160 ),
		color_mood: str( r.color_mood, 160 ),
		category: str( r.category, 60 ),
		wrong_interpretation: str( r.wrong_interpretation, 240 ),
		key_visuals: Array.isArray( r.key_visuals ) ? r.key_visuals.map( ( v ) => str( v, 40 ) ).filter( Boolean ).slice( 0, 8 ) : [],
	};
}

/**
 * SVG로 디자인하는 스타일(10종). 시도 계획:
 *   1) 1순위 모델  2) 같은 모델 + 거절 사유  3) 2순위 모델 + 거절 사유
 * 각 결과는 유효 XML → 최소 도형 수 → 제목 정확히 1회 → 글자 넘침 순으로 검수한다.
 */
async function generateDesigned( env, ctx ) {
	const { style, width, height, title, started, budget } = ctx;
	const models = svgModels( env );
	const minDrawn = STYLE_MIN_DRAWN[ style ] || 8;
	const plan = planTitle( title, width, height );
	const log = [];
	let note = '';

	const attemptModels = [ models[ 0 ], models[ 0 ], models[ 1 ] || models[ 0 ] ];

	for ( let i = 0; i < attemptModels.length; i++ ) {
		const remaining = budget - ( Date.now() - started );
		if ( remaining < 12000 ) { log.push( { attempt: i + 1, skipped: 'budget' } ); break; }
		const model = attemptModels[ i ];
		const messages = buildDesignMessages( style, {
			title, plan, width, height, research: ctx.research, brief: ctx.brief,
			customDirection: ctx.customDirection, note,
		} );

		let raw = '';
		try {
			raw = await runLlm( env, model, messages, {
				temperature: STYLE_TEMPERATURE[ style ] || 0.8,
				maxTokens: SVG_MAX_TOKENS,
				timeoutMs: Math.min( PER_CALL_TIMEOUT_MS, remaining ),
			} );
		} catch ( err ) {
			log.push( { attempt: i + 1, model, error: String( err && err.message ? err.message : err ).slice( 0, 160 ) } );
			note = 'The previous call failed; answer with a compact but complete SVG (fewer elements).';
			continue;
		}

		let svg = finalizeSvg( extractSvgText( raw ), width, height );
		if ( ! svg ) {
			log.push( { attempt: i + 1, model, rejected: 'invalid_svg', chars: raw.length } );
			note = 'It was not valid, complete SVG (check: exactly one root <svg>, all tags closed, & escaped, no forbidden elements, not cut off). Keep it under about 110 elements.';
			continue;
		}

		if ( ! title ) svg = stripAllText( svg );

		const drawn = countDrawn( svg );
		if ( drawn < minDrawn ) {
			log.push( { attempt: i + 1, model, rejected: 'too_sparse', drawn } );
			note = `It had only ${ drawn } drawn shapes; this style needs a fuller composition (at least ${ minDrawn }).`;
			continue;
		}

		const fit = fitTextOverflow( svg, width, height );
		svg = fit.svg;
		const audit = auditTitle( svg, title, plan, width );
		const issues = [ ...audit.issues ];
		if ( fit.unfixable.length ) issues.push( `Text runs outside the canvas and cannot be fitted: ${ fit.unfixable.join( ', ' ) }. Shrink it or move it inside the margins.` );

		if ( issues.length ) {
			log.push( { attempt: i + 1, model, rejected: 'text_audit', issues } );
			note = issues.join( ' ' );
			continue;
		}

		log.push( { attempt: i + 1, model, accepted: true, drawn, fitted: fit.fixed } );
		return {
			data_url: svgToDataUrl( svg ),
			mime_type: 'image/svg+xml',
			format: 'svg',
			width,
			height,
			provider: 'workers-ai-svg:' + model.split( '/' ).pop(),
			model_used: `AI 디자인 SVG (${ model.split( '/' ).pop() })`,
			fallback_used: i > 0,
			style,
			text_included: !! title,
			attempts: log,
			raw_svg: svg,
		};
	}
	throw new ImageError( 'design_failed', 502, 'AI가 조건에 맞는 이미지를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', log );
}

/** 사실적 사진: LLM이 영문 사진 프롬프트를 쓰고, 이미지 모델이 그린다(글자 없음). */
async function generatePhoto( env, ctx ) {
	const { width, height, started, budget } = ctx;
	const models = svgModels( env );
	const log = [];
	let prompt = '';

	for ( let i = 0; i < 2 && ! prompt; i++ ) {
		const remaining = budget - ( Date.now() - started );
		if ( remaining < 8000 ) break;
		try {
			const raw = await runLlm( env, models[ Math.min( i, models.length - 1 ) ], buildPhotoPromptMessages( {
				title: ctx.title, research: ctx.research, brief: ctx.brief, customDirection: ctx.customDirection,
				note: i ? 'It was too short or not English.' : '',
			} ), { temperature: 0.8, maxTokens: 400, timeoutMs: Math.min( 30000, remaining ) } );
			const cleaned = sanitizeImageText( String( raw ).replace( /^["'`\s]+|["'`\s]+$/g, '' ), 700 );
			if ( cleaned.length >= 40 && /[A-Za-z]{3,}/.test( cleaned ) ) prompt = cleaned;
			else log.push( { step: 'photo_prompt', attempt: i + 1, rejected: 'too_short_or_not_english' } );
		} catch ( err ) {
			log.push( { step: 'photo_prompt', attempt: i + 1, error: String( err && err.message ? err.message : err ).slice( 0, 160 ) } );
		}
	}
	if ( ! prompt ) {
		// 프롬프트 작성 AI가 실패했을 때만, 호출자가 보낸 영문 브리프를 그대로 쓴다.
		const brief = sanitizeImageText( ctx.brief, 700 );
		if ( brief && /[A-Za-z]{3,}/.test( brief ) ) prompt = brief;
	}
	if ( ! prompt ) throw new ImageError( 'photo_prompt_failed', 502, 'AI가 사진 장면 설명을 만들지 못했습니다. 다시 시도해 주세요.', log );

	const order = pickModelOrder();
	const runPool = async ( p ) => {
		let nsfw = false;
		for ( const modelKey of order ) {
			if ( budget - ( Date.now() - started ) < 6000 ) break;
			const picked = await callOneModel( env, modelKey, p, width, height );
			if ( picked.ok ) return { hit: picked };
			if ( picked.nsfw ) nsfw = true;
			log.push( { step: 'photo_model', model: modelKey, failed: true } );
		}
		return { hit: null, nsfw };
	};

	let pool = await runPool( prompt );
	if ( ! pool.hit && pool.nsfw ) {
		// 필터 오탐이 의심되면 수식어를 줄인 짧은 버전으로 한 번 더.
		pool = await runPool( prompt.split( /\s+/ ).slice( 0, 28 ).join( ' ' ) + ', plain natural photograph' );
	}
	if ( ! pool.hit ) throw new ImageError( 'photo_failed', 502, '사진 이미지 모델이 모두 실패했습니다. 잠시 후 다시 시도해 주세요.', log );

	const p = pool.hit;
	return {
		data_url: `data:${ p.mime };base64,${ p.base64 }`,
		mime_type: p.mime,
		format: p.mime === 'image/png' ? 'png' : 'jpeg',
		width,
		height,
		provider: 'workers-ai:' + p.modelKey.toLowerCase(),
		model_used: p.modelLabel,
		fallback_used: order[ 0 ] !== p.modelKey,
		style: 'photo_realistic',
		text_included: false, // 사진은 글자를 넣지 않는다.
		image_prompt: prompt,
		attempts: log,
	};
}

/**
 * 이 모듈의 진입점.
 * @param {object} env   Worker 환경(env.AI 필요)
 * @param {object} body  { topic, style, research?, prompt?, custom_direction?, width?, height? }
 * @throws {ImageError}  AI 바인딩 없음(503) / 모든 시도 실패(502)
 */
export async function generateImage( env, body ) {
	body = body && typeof body === 'object' ? body : {};
	const requested = String( body.style || 'poster' ).toLowerCase();
	const style  = STYLE_KEYS.includes( requested ) ? requested : 'poster';
	const width  = Math.min( Math.max( parseInt( body.width, 10 )  || 1600, 256 ), 2048 );
	const height = Math.min( Math.max( parseInt( body.height, 10 ) || 900,  256 ), 2048 );

	if ( ! hasAI( env ) ) {
		throw new ImageError( 'ai_binding_missing', 503, 'Workers AI 바인딩(env.AI)이 없습니다. wrangler 설정의 [ai] binding = "AI" 를 켜고 다시 배포해 주세요.' );
	}

	const research = normalizeResearch( body.research );
	const hasResearch = Object.values( research ).some( ( v ) => ( Array.isArray( v ) ? v.length > 0 : !! v ) );

	const ctx = {
		style, width, height,
		title: sanitizeImageText( body.topic, 90 ),
		research,
		// 호출자의 prompt는 조사 결과를 요약한 브리프라서, research가 있으면 중복이므로 쓰지 않는다.
		// (조사 결과 없이 prompt만 온 경우에만 보조 설명으로 쓴다.)
		brief: hasResearch ? '' : sanitizeImageText( body.prompt, 900 ),
		customDirection: sanitizeImageText( body.custom_direction, 700 ),
		started: Date.now(),
		budget: Math.max( 30000, parseInt( env && env.IMAGE_BUDGET_MS, 10 ) || DEFAULT_BUDGET_MS ),
	};

	if ( ! isSvgStyle( style ) ) return generatePhoto( env, ctx );
	return tryConvertToPng( env, await generateDesigned( env, ctx ) );
}

/**
 * /api/image의 HTTP 어댑터. Worker와 Pages Functions가 같은 입력 검증/JSON 응답을 쓰도록 여기서 제공한다.
 */
export async function handleImage( request, env ) {
	let body;
	try {
		body = request.method === 'GET'
			? Object.fromEntries( new URL( request.url ).searchParams )
			: await request.json();
	} catch ( err ) {
		return json( { error: '요청 본문이 유효한 JSON이 아닙니다.' }, 400 );
	}

	body = body && typeof body === 'object' && ! Array.isArray( body ) ? body : {};
	const topic = sanitizeImageText( body.topic || body.q, 90 );
	const prompt = sanitizeImageText( body.prompt, 1200 );
	if ( ! topic && ! prompt ) {
		return json( {
			error: 'topic 또는 prompt가 필요합니다.',
			endpoint: 'POST /api/image { topic, style?, research?, prompt?, custom_direction?, width?, height? }',
		}, 400 );
	}

	try {
		const result = await generateImage( env, { ...body, topic, prompt } );
		const { raw_svg, ...rest } = result; // SVG 원문은 data_url과 중복이라 응답에서 뺀다.
		return json( rest );
	} catch ( err ) {
		if ( err instanceof ImageError ) {
			console.warn( `[image-core] ${ err.code }: ${ err.message }`, JSON.stringify( err.details || [] ).slice( 0, 800 ) );
			return json( { success: false, error: err.code, message: err.message, details: err.details || [] }, err.status );
		}
		console.error( `[image-core] 이미지 생성 예외: ${ err && err.message ? err.message : err }` );
		return json( { success: false, error: 'image_generation_failed', message: '이미지 생성 중 오류가 발생했습니다.' }, 500 );
	}
}

export { CORS_HEADERS };
