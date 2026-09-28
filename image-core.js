/**
 * image-core.js — cloud-press 검색/이미지 API Worker의 이미지 생성 모듈.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 이 파일의 역할
 * ════════════════════════════════════════════════════════════════════════
 * zorlinq32(WordPress 플러그인)가 POST /api/image로 보내는
 *   { prompt, topic, subtitle, style, width, height }
 * 를 받아, 스타일에 맞는 이미지를 만들어
 *   { data_url, mime_type, width, height, provider, model_used, fallback_used }
 * 형태로 돌려준다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 생성 경로 우선순위 (요청 사항 반영: SVG 경로가 1순위)
 * ════════════════════════════════════════════════════════════════════════
 * 1순위) SVG 필터 기반 생성 — Cloudflare Workers AI의 텍스트 모델(LLM)에게
 *        스타일별 프롬프트를 그대로 주고 SVG 마크업 자체를 만들게 한다.
 *        - 100% 벡터라 어떤 해상도로도 깨지지 않고, 한글 <text>도 그대로
 *          정확하게 렌더링된다(확산 모델처럼 글자가 깨지는 문제 자체가 없음).
 *        - 색상/좌표/도형을 그대로 텍스트(마크업)로 받기 때문에 후처리
 *          커스터마이징(굿즈화, 좌표 미세조정 등)이 이미지 모델보다 훨씬 쉽다.
 *        - 실패(모델이 유효한 SVG를 못 만들거나 파싱 오류)하면 2순위로 폴백.
 * 2순위) Cloudflare Workers AI 이미지 생성 모델 풀 — 스타일별로 3~4개씩
 *        묶은 풀에서 매번 무작위로 골라 시도하고, 실패하면 풀 안의 다음
 *        모델로 자동 폴백한다(고정된 단일 모델만 계속 쓰지 않는다).
 * 3순위) 이 파일 자체에 내장된 최종 SVG 카드 생성기(항상 성공) — 위 두
 *        경로가 전부 실패했을 때만 사용되는 안전망이다.
 *
 * ⚠️ 2순위(확산 모델) 경로에서는 제목/부제목 한국어 텍스트를 이미지 위에
 * 직접 그리지 않는다 — zorlinq32 쪽 브라우저 <canvas>가 웹폰트로 직접 그려
 * 배경 위에 합성하는 기존 구조를 그대로 쓴다(확산 모델은 한글 학습 데이터가
 * 부족해 텍스트를 직접 그리게 하면 깨지기 쉽다). 그래서 2순위로 보내는
 * 프롬프트도 "배경/분위기/구도" 묘사에 집중한다.
 * 반면 1순위(SVG) 경로는 벡터 텍스트라 깨질 걱정이 없으므로, 프롬프트에
 * 제목 문구를 그대로 포함시켜 텍스트가 있는 완성된 비주얼을 바로 만든다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 한국어 최적화
 * ════════════════════════════════════════════════════════════════════════
 * - 1순위(SVG, 텍스트 LLM): 한국어 프롬프트를 그대로 이해할 수 있는 모델
 *   (Llama 3.3 70B Instruct fp8 Fast — 8B 대비 한국어 지시 이행력·구조화
 *   능력이 크게 높고, 여전히 "fast" 계열이라 지연도 합리적이다)을 사용하므로
 *   topic/subtitle 원문 그대로 전달한다. 실패 시 1회 재시도한다.
 * - 2순위(이미지 모델): 전부 영어 중심 학습 모델이므로, zorlinq32가 이미
 *   만들어 보낸 영어 prompt를 그대로 쓰고, 비어 있을 때만 이 Worker가
 *   topic/subtitle을 바탕으로 카메라/구도/조명 지시어까지 포함한 영어 배경
 *   묘사를 스타일별로 세분화해 즉석에서 구성한다(완벽한 번역이 아니라
 *   "배경 생성 품질을 끌어올리는" 수준이 목표). negative prompt도 스타일별로
 *   나눠 각 스타일에서 흔한 실패 패턴을 겨냥한다.
 * - 3순위(내장 폴백 카드): 외부 모델이 전부 실패해도 스타일별 팔레트·장식
 *   레이어·타이포 계층을 갖춘 완성도 있는 카드를 생성한다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠️ img2img / inpainting 계열은 2순위 풀에 넣지 않는다
 * ════════════════════════════════════════════════════════════════════════
 * @cf/runwayml/stable-diffusion-v1-5-img2img 와
 * @cf/runwayml/stable-diffusion-v1-5-inpainting 은 반드시 입력 이미지(및
 * inpainting은 마스크)가 있어야 동작하는 모델이다(빠뜨리면 Cloudflare가
 * "missing required input" 오류를 반환한다). 이 Worker는 텍스트만으로 새
 * 이미지를 만드는 용도이므로 이 두 모델은 사용하지 않는다.
 */

import { CORS_HEADERS, json } from './search-core.js';

// ──────────────────────────────────────────────────────────────────────
// 1. 모델 카탈로그: 각 모델의 정확한 ID와 요청 형식(JSON vs multipart),
//    지원 파라미터. 전부 Cloudflare 공식 문서 기준으로 확인된 값이다.
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
// 2. 스타일별 모델 풀. zorlinq32의 5개 스타일 키(poster/minimal/
//    photo_realistic/typography/branding)에 맞춰 3~4개씩 배정한다.
//    배열의 순서 = 폴백 시도 순서이며, 실제 선택은 이 배열에서 무작위로
//    시작 인덱스를 고른 뒤 그 지점부터 실패 시 다음으로 넘어간다.
// ──────────────────────────────────────────────────────────────────────
const STYLE_MODEL_POOLS = {
	// 실제 사진 같은 리얼함이 최우선 — FLUX.2 Dev(최고 품질) 우선,
	// 느려도 되는 경우가 많은 스타일이라 무거운 모델을 앞에 둔다.
	photo_realistic: [ 'FLUX2_DEV', 'LUCID_ORIGIN', 'SDXL_BASE', 'PHOENIX' ],

	// 선명한 그래픽 디자인/포스터 레이아웃 — Lucid Origin이 정확히 이 용도로
	// 훈련된 모델이라 최우선. Klein 9B(멀티레퍼런스 고품질)를 다음으로.
	poster: [ 'LUCID_ORIGIN', 'FLUX2_KLEIN_9B', 'PHOENIX', 'SDXL_BASE' ],

	// 여백이 넉넉하고 단순한 배경이 핵심 — 빠른 모델 위주로, 과한 디테일이
	// 오히려 텍스트 가독성을 해치므로 저스텝 모델을 우선한다.
	minimal: [ 'FLUX_SCHNELL', 'FLUX2_KLEIN_4B', 'DREAMSHAPER' ],

	// 타이포그래피가 전경을 채우므로 배경은 더더욱 단순/저채도가 유리하다.
	// 가장 빠르고 배경이 과하게 복잡해지지 않는 모델 위주.
	typography: [ 'FLUX_SCHNELL', 'SDXL_LIGHTNING', 'DREAMSHAPER' ],

	// CTA/브랜드 캠페인 비주얼 — 고품질·프롬프트 순응도가 중요해 Klein 9B와
	// Phoenix(텍스트/로고 요소가 섞여도 안정적)를 우선한다.
	branding: [ 'FLUX2_KLEIN_9B', 'PHOENIX', 'LUCID_ORIGIN', 'SDXL_BASE' ],
};

const DEFAULT_POOL = [ 'FLUX_SCHNELL', 'SDXL_BASE', 'DREAMSHAPER' ];

// 확산 모델이 흔히 넣는 잡음성 아티팩트를 배제하는 공통 negative prompt.
// (텍스트/글자를 직접 그리지 않게 하려는 목적도 포함 — 텍스트는 캔버스가 담당하므로
// 모델이 자체적으로 알 수 없는 글자를 화면에 채워 넣는 것을 방지한다.)
const COMMON_NEGATIVE_PROMPT =
	'text, letters, watermark, logo, signature, blurry, low quality, distorted, ' +
	'extra limbs, deformed, ugly, jpeg artifacts, oversaturated, noisy, ' +
	'cropped, out of frame, duplicate, mutated, bad anatomy, worst quality, grainy';

// 스타일별로 흔히 나타나는 실패 패턴을 추가로 겨냥한 negative prompt.
// COMMON_NEGATIVE_PROMPT에 이어붙여 사용한다.
const STYLE_NEGATIVE_PROMPT = {
	photo_realistic: 'illustration, cartoon, painting, drawing, 3d render, cgi, plastic skin, uncanny valley, over-smoothed',
	poster: 'photorealistic, photograph, muddy colors, low contrast, cluttered composition, busy background',
	minimal: 'cluttered, busy, complex pattern, high detail, many objects, harsh contrast, loud colors',
	typography: 'cluttered, busy background, high detail, competing focal point, loud colors, complex texture',
	branding: 'amateur, cheap looking, cluttered, low production value, harsh lighting, inconsistent style',
};

function buildNegativePrompt( style ) {
	const extra = STYLE_NEGATIVE_PROMPT[ style ];
	return extra ? `${ COMMON_NEGATIVE_PROMPT }, ${ extra }` : COMMON_NEGATIVE_PROMPT;
}

/**
 * 스타일 키에 맞는 모델 풀을 무작위 시작점으로 섞어서 반환한다.
 * (배열 자체를 섞어 반환하므로, 호출부는 앞에서부터 순서대로 시도하면
 * 그것이 곧 "무작위 선택 + 실패 시 다음 폴백"이 된다.)
 */
function pickModelOrder( style ) {
	const pool = STYLE_MODEL_POOLS[ style ] || DEFAULT_POOL;
	const shuffled = pool.slice();
	for ( let i = shuffled.length - 1; i > 0; i-- ) {
		const j = Math.floor( Math.random() * ( i + 1 ) );
		[ shuffled[ i ], shuffled[ j ] ] = [ shuffled[ j ], shuffled[ i ] ];
	}
	return shuffled;
}

/**
 * zorlinq32가 이미 만들어 보낸 prompt(대개 영어, Gemini가 생성)가 있으면
 * 그대로 쓰고, 비어 있을 때만 topic/subtitle을 바탕으로 최소한의 영어
 * 배경 프롬프트를 즉석에서 구성한다. 완벽한 번역이 아니라 "모델이 이해할 수
 * 있는 배경 묘사"를 만드는 것이 목적이다.
 */
function buildBackgroundPrompt( prompt, topic, subtitle, style ) {
	if ( prompt && prompt.trim().length > 0 ) {
		return prompt.trim();
	}

	// 스타일별로 (1) 매체/기법, (2) 구도, (3) 조명/색감, (4) 품질 지시어를
	// 세분화해 확산 모델이 실제로 반응을 잘 하는 카메라·아트 용어를 직접 준다.
	const styleHint = {
		photo_realistic:
			'professional photography, shot on a full-frame camera, 50mm lens, shallow depth of field, ' +
			'natural directional lighting, realistic textures and materials, rule-of-thirds composition, ' +
			'true-to-life color grading',
		poster:
			'bold flat-color graphic design poster background, strong geometric shapes, high contrast ' +
			'2-3 color palette, confident negative space, print-poster composition, vector-style clean edges',
		minimal:
			'minimalist background, generous negative space, soft single-tone or duotone gradient, ' +
			'restrained composition, subtle texture only, calm and airy feel',
		typography:
			'abstract simple background built to sit behind large overlaid text, very low visual noise, ' +
			'soft gradient or gentle pattern, muted secondary color palette, wide open central area',
		branding:
			'premium commercial brand campaign visual, polished studio-quality look, refined color palette, ' +
			'balanced whitespace, consistent art direction, high production value',
	}[ style ] || 'clean background, high production quality';

	// topic/subtitle은 한국어일 가능성이 높으므로, 모델에는 주제를 "장면"으로
	// 변환한 general English framing만 넘기고 한글 원문 자체는 넣지 않는다
	// (확산 모델이 한글을 그대로 화면에 그리려 시도하는 것을 방지).
	const subjectHint = subtitle || topic || 'a relevant conceptual scene';
	return `A background image representing the concept of "${ subjectHint }" (described abstractly, no on-image text), ` +
		`${ styleHint }, no readable text or letters anywhere in the image, no people's faces in focus, ` +
		'masterfully composed, high resolution, sharp focus, 16:9 composition';
}

/**
 * 선택된 모델 하나를 실제로 호출한다.
 * 성공 시 { ok: true, base64, mime, modelKey, modelId, modelLabel } 반환.
 * 실패 시 { ok: false, nsfw: boolean } 반환해 호출부가 다음 모델로 넘어가거나,
 * NSFW 오탐이면 완화된 프롬프트로 재시도할지 판단할 수 있게 한다.
 */
async function callOneModel( env, modelKey, prompt, width, height, style ) {
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
			const negative = model.supportsNegative ? buildNegativePrompt( style ) : undefined;
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

function arrayBufferToBase64( buffer ) {
	let binary = '';
	const bytes = new Uint8Array( buffer );
	const chunkSize = 0x8000;
	for ( let i = 0; i < bytes.length; i += chunkSize ) {
		binary += String.fromCharCode.apply( null, bytes.subarray( i, i + chunkSize ) );
	}
	return btoa( binary );
}

/**
 * 2순위 경로: Cloudflare Workers AI 이미지 생성 모델 풀.
 * 스타일에 맞는 풀에서 무작위 순서로 하나씩 시도하고, 성공하면 즉시 반환한다.
 * 전부 실패하면 null을 반환해 호출부(generateImage)가 3순위로 넘어가게 한다.
 *
 * ⚠️ Flux 계열(flux-1-schnell, flux-2-klein-4b/9b)은 알려진 NSFW 필터
 * 오탐 이슈가 있다("hamburger" 같은 무해한 단어도 종종 걸림). 풀 전체가
 * 같은 프롬프트로 전부 이 오탐에 걸려 실패하면, 프롬프트에서 스타일
 * 수식어를 걷어낸 더 짧고 단순한 버전으로 한 번 더 전체 풀을 시도한다
 * (수식어가 많을수록 필터 오탐 표면적이 커지는 경향이 있기 때문).
 */
async function generateWithImageModelPool( env, body, style, width, height ) {
	if ( ! env || ! env.AI || typeof env.AI.run !== 'function' ) return null;
	const prompt = buildBackgroundPrompt( body.prompt, body.topic, body.subtitle, style );
	const order  = pickModelOrder( style );

	const runPool = async ( promptToUse ) => {
		let sawNsfwFalsePositive = false;
		for ( const modelKey of order ) {
			const picked = await callOneModel( env, modelKey, promptToUse, width, height, style );
			if ( picked.ok ) {
				return {
					hit: {
						data_url:      `data:${ picked.mime };base64,${ picked.base64 }`,
						mime_type:     picked.mime,
						width,
						height,
						provider:      'workers-ai:' + picked.modelKey.toLowerCase(),
						model_used:    picked.modelLabel,
						fallback_used: order[ 0 ] !== modelKey,
					},
				};
			}
			if ( picked.nsfw ) sawNsfwFalsePositive = true;
		}
		return { hit: null, sawNsfwFalsePositive };
	};

	const first = await runPool( prompt );
	if ( first.hit ) return first.hit;

	// 풀 전체가 실패했고 그중 NSFW 오탐이 하나라도 있었다면, 수식어를 걷어낸
	// 더 짧고 단순한 프롬프트로 전체 풀을 한 번 더 시도한다.
	if ( first.sawNsfwFalsePositive ) {
		const subjectHint = body.subtitle || body.topic || 'a relevant conceptual scene';
		const simplifiedPrompt = `A simple abstract background related to "${ subjectHint }", no text, no readable letters, clean composition`;
		console.warn( '[image-core] NSFW 오탐으로 전체 풀 실패 — 단순화된 프롬프트로 재시도' );
		const retry = await runPool( simplifiedPrompt );
		if ( retry.hit ) return retry.hit;
	}

	return null;
}

// ──────────────────────────────────────────────────────────────────────
// 3. 1순위 경로: SVG 필터 기반 생성 (텍스트 LLM이 SVG 마크업을 직접 작성).
//    한글 텍스트가 벡터로 정확히 렌더링되고, 색상/레이아웃 커스터마이징이
//    쉬운 것이 핵심 장점이다. 스타일별 프롬프트(요청하신 그대로)를 시스템
//    프롬프트로 사용해 톤을 맞춘다.
// ──────────────────────────────────────────────────────────────────────

// llama-3.1-8b-instruct는 2026-05-30부로 Cloudflare에서 deprecated 처리됨.
// 3.3 70B는 8B 대비 한국어 지시 이행력·복잡한 구조 요구사항 준수력이
// 훨씬 높고, fp8-fast 양자화라 지연도 8B와 크게 다르지 않다.
const SVG_TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// 기존 이미지 모델 프롬프트에서 이미 확립된 스타일별 톤을 재사용하되,
// 색상 팔레트·구성 요소·레이어 지시를 구체화해 모델이 매번 비슷한
// 결과로 수렴하지 않고 스타일 간 차별성이 뚜렷하게 나오도록 강화했다.
const SVG_STYLE_DIRECTIVES = {
	photo_realistic:
		'사실적인 사진처럼 보이는 장면을 벡터 도형(그라디언트, 다중 레이어 도형, 은은한 그림자, ' +
		'빛 번짐용 blur 필터)으로 표현하라. 인물의 얼굴을 세밀하게 그리려 하지 말고, 실루엣과 ' +
		'조명감(역광, 그림자 대비, 하이라이트)으로 사실적 분위기를 낸다. 색상은 저채도의 자연스러운 ' +
		'톤(피부톤·하늘색·대지색 계열)을 기본으로 하고, 최소 4단계 이상의 명암 레이어로 깊이감을 준다.',
	poster:
		'굵은 색면과 명확한 레이아웃의 그래픽 디자인 포스터. 대비가 강한 색상 2~3개(보색 또는 트라이어드 ' +
		'조합)를 명확히 정해서 쓰고, 큼직한 기하학적 도형과 사선/대각선 구도로 시선을 유도한다. 여백을 ' +
		'과감히 활용하고, 장식용 작은 도형(점, 선, 줄무늬)을 1~2곳에 리듬감 있게 배치한다.',
	minimal:
		'넉넉한 여백과 단순한 형태의 미니멀 배경. 단색이나 부드러운 단일 톤 그라디언트를 기본으로, ' +
		'장식 요소는 최소화하되 완전히 비워두지 말고 은은한 형태 1~2개(원, 부드러운 곡선)로 공간에 ' +
		'리듬을 준다. 채도를 낮추고 명도 차이로만 레이어를 구분한다.',
	typography:
		'텍스트가 화면의 주인공이 되는 구도. 배경은 텍스트 가독성을 해치지 않는 저채도 단순 패턴이나 ' +
		'그라디언트로만 구성하고, 텍스트 뒤나 주변에 옅은 보조 도형(기하학적 프레임, 밑줄, 강조 블록)을 ' +
		'배치해 완성도를 높인다. 텍스트와 배경의 명도 대비를 충분히 확보한다.',
	branding:
		'고급스러운 브랜드 캠페인 비주얼. 정제된 색상 팔레트(주색 1개 + 중립색 1~2개), 균형 잡힌 여백, ' +
		'상업적으로 세련된 톤을 유지한다. 얇은 라인 요소나 미묘한 그라디언트로 프리미엄한 질감을 더하고, ' +
		'과도한 장식 없이 절제된 완성도로 마무리한다.',
};

/**
 * 1순위 경로: LLM에게 완성된 SVG 마크업을 직접 작성하게 한다.
 * 성공하면 { data_url, mime_type, ... }를 반환하고, 실패(모델 오류·유효하지
 * 않은 SVG)하면 null을 반환해 2순위로 넘어가게 한다.
 *
 * ⚠️ 이 경로는 한글이 그대로 화면에 보여도 안전하므로(벡터 텍스트),
 * topic/subtitle 원문을 프롬프트에 그대로 포함시킨다.
 */
async function generateSvgWithLLM( env, body, style, width, height ) {
	// AI 바인딩이 없는 설치에서는 호출 자체를 하지 않는다. 이전에는 여기서
	// 예외를 낸 뒤 이미지 모델 풀을 전부 순회해 불필요한 경고와 지연을 만들었다.
	if ( ! env || ! env.AI || typeof env.AI.run !== 'function' ) return null;

	const directive = SVG_STYLE_DIRECTIVES[ style ] || SVG_STYLE_DIRECTIVES.minimal;
	const prompt   = sanitizeImageText( body.prompt, 1200 );
	const title    = sanitizeImageText( body.topic, 90 );
	const subtitle = sanitizeImageText( body.subtitle, 140 );
	const subject  = title || prompt || subtitle;

	const systemPrompt =
		'당신은 SVG 마크업만으로 완성된 썸네일 비주얼을 그리는 시니어 그래픽 디자이너입니다. ' +
		'설명이나 코드블록 표시(```) 없이, <svg> 태그로 시작해서 </svg> 태그로 끝나는 ' +
		'완전한 SVG 마크업 "그 자체"만 출력하세요. 다른 텍스트는 절대 출력하지 마세요.\n\n' +
		`캔버스 크기는 viewBox="0 0 ${ width } ${ height }" 로 고정합니다.\n\n` +
		'[텍스트 레이어 규칙]\n' +
		'제목 텍스트가 있다면 <text> 요소로 화면에 큼직하게(전체 높이의 8~12% 폰트 크기) 배치하고, ' +
		'한글이 잘리거나 뷰박스를 벗어나지 않도록 폰트 크기와 좌측/여백 위치를 신중히 정하세요. ' +
		'부제목이 있다면 제목보다 뚜렷이 작은 크기(전체 높이의 4~5%)로 제목 아래 배치해 위계를 만드세요. ' +
		'font-family는 "Pretendard, \'Apple SD Gothic Neo\', \'Malgun Gothic\', sans-serif"로 지정하고, ' +
		'제목은 font-weight="700" 이상으로 굵게 처리하세요. 텍스트와 배경의 명도 대비가 충분해 ' +
		'가독성이 확실히 보장되도록 하세요(필요하면 텍스트 뒤에 반투명 블록이나 그림자를 추가).\n\n' +
		'[구성 규칙]\n' +
		'이 요청의 핵심 주제를 장식용 추상 도형으로만 대체하지 마세요. 핵심 주제를 알아볼 수 있는 ' +
		'주요 오브젝트/장면을 직접 제작하고, 그 오브젝트가 화면 면적의 상당 부분을 차지하게 하세요. ' +
		'주제와 관련된 보조 오브젝트와 배경 맥락도 함께 그리되, 요청과 무관한 사람·동물·아이콘을 넣지 마세요.\n' +
		'반드시 (1) 배경 레이어(그라디언트 포함), (2) 배경 장식/텍스처 레이어, (3) 주제를 표현하는 ' +
		'전경 오브젝트 레이어, (4) 제목 텍스트 레이어, (5) 부제목 텍스트 레이어(있는 경우) — 이렇게 ' +
		'레이어를 명확히 분리된 SVG 요소로 구성하세요. CSS나 외부 이미지, <image>, foreignObject는 ' +
		'사용하지 마세요. 첫 번째 자식으로 요청의 핵심 주제를 설명하는 <title>을 넣으세요.\n\n' +
		'[색상·디테일 규칙]\n' +
		'전체 배색은 서로 조화로운 3~5개 색상으로 제한하고, 스타일 톤에 맞는 명확한 주조색을 정하세요. ' +
		'그라디언트(linearGradient/radialGradient), 은은한 필터(feGaussianBlur 등), 도형, 패턴을 활용해 ' +
		'배경을 밋밋하지 않게 풍부하게 만들되 텍스트 가독성을 해치지 않는 선에서 절제하세요.\n\n' +
		`디자인 톤: ${ directive }`;

	const userPrompt = [
		prompt   ? `원본 이미지 프롬프트(가장 중요한 시각 요구사항): ${ prompt }` : '',
		title    ? `제목: ${ title }`    : '',
		subtitle ? `부제목: ${ subtitle }` : '',
		`핵심 주제: ${ subject }`,
		'위 요구사항을 만족하는, 주제와 시각적으로 직접 관련된 완성형 썸네일을 SVG로 그려주세요.',
	].filter( Boolean ).join( '\n' );

	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	];

	// 첫 시도 실패(모델 오류 또는 유효하지 않은 SVG) 시 1회 재시도한다.
	// 재시도 시에는 이전 실패를 알려 더 신중하게 규칙을 지키도록 유도한다.
	const attempts = [ null, '이전 시도가 유효하지 않은 SVG를 생성했습니다. 반드시 <svg>로 시작해서 </svg>로 ' +
		'끝나는 완전한 마크업만, 다른 설명 없이 출력하세요. viewBox 속성을 지시받은 크기 그대로(예: ' +
		`"0 0 ${ width } ${ height }") 정확히 넣고, width/height 고정 속성은 넣지 마세요. ` +
		'<title> 요소를 첫 번째 자식으로 반드시 포함하세요.' ];

	for ( const retryNote of attempts ) {
		const callMessages = retryNote
			? [ ...messages, { role: 'user', content: retryNote } ]
			: messages;

		try {
			const result = await env.AI.run( SVG_TEXT_MODEL, {
				messages: callMessages,
				max_tokens: 3000,
			} );

			const raw = result && result.response ? String( result.response ) : '';
			const svg = extractSvgMarkup( raw, width, height );
			if ( svg ) {
				return {
					data_url:      'data:image/svg+xml;base64,' + btoa( unescape( encodeURIComponent( svg ) ) ),
					mime_type:     'image/svg+xml',
					width,
					height,
					provider:      'svg-llm:' + SVG_TEXT_MODEL.split( '/' ).pop(),
					model_used:    'SVG (Llama 3.3 70B Instruct)',
					fallback_used: false,
				};
			}
		} catch ( err ) {
			console.warn( `[image-core] SVG LLM 생성 실패(${ retryNote ? '재시도' : '1차' }): ${ err && err.message ? err.message : err }` );
		}
	}

	return null;
}

/**
 * LLM 응답에서 실제 <svg>...</svg> 마크업만 추출하고, 형태가 최소한
 * 유효한지(태그 짝, viewBox 존재) 가볍게 검증한다. 완전한 XML 검증은
 * 하지 않지만, 명백히 깨진 응답(코드블록 설명이 섞이거나 태그가
 * 안 닫힌 경우)은 걸러내 2순위로 안전하게 넘어가게 한다.
 *
 * width/height가 주어지면 viewBox가 실제로 존재하는지, 그리고 SVG 루트에
 * 요청 비율과 크게 어긋나는 고정 width/height 속성이 박혀 있어 반응형
 * 렌더링을 깨뜨리지 않는지도 함께 확인한다.
 */
function extractSvgMarkup( raw, width, height ) {
	if ( ! raw ) return null;
	const start = raw.indexOf( '<svg' );
	const end   = raw.lastIndexOf( '</svg>' );
	if ( start === -1 || end === -1 || end <= start ) return null;

	const svg = raw.slice( start, end + '</svg>'.length ).trim();
	// 아주 짧으면(모델이 태그만 흉내내고 내용은 못 채운 경우) 신뢰하지 않는다.
	if ( svg.length < 300 ) return null;
	// SVG는 data URL이라도 script/event handler/외부 리소스를 포함할 수 있다.
	// LLM 결과는 신뢰할 수 없는 입력으로 취급하고, 완성형 벡터 요소만 허용한다.
	if ( /<(?:script|foreignObject|iframe|image)\b|\son\w+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test( svg ) ) return null;
	if ( ! /<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i.test( svg ) ) return null;

	// <svg ...> 여는 태그만 뽑아 viewBox와 고정 width/height 속성을 확인한다.
	const openTagMatch = svg.match( /<svg\b[^>]*>/i );
	const openTag = openTagMatch ? openTagMatch[ 0 ] : '';
	const viewBoxMatch = openTag.match( /viewBox\s*=\s*["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i );
	if ( ! viewBoxMatch ) return null; // viewBox 자체가 없으면 스케일링이 불안정하므로 신뢰하지 않는다.

	if ( width && height ) {
		const vbWidth = parseFloat( viewBoxMatch[ 1 ] );
		const vbHeight = parseFloat( viewBoxMatch[ 2 ] );
		if ( vbWidth > 0 && vbHeight > 0 ) {
			const requestedRatio = width / height;
			const vbRatio = vbWidth / vbHeight;
			// 요청 비율과 30% 넘게 어긋나면 모델이 지시받은 viewBox를 무시하고
			// 임의의 크기로 그렸다는 뜻이므로 신뢰하지 않고 2순위로 넘어간다.
			if ( Math.abs( vbRatio - requestedRatio ) / requestedRatio > 0.3 ) return null;
		}
		// 루트에 고정 width/height(px 등 절대단위)가 박혀 있으면 컨테이너
		// 크기에 맞춰 반응형으로 늘어나지 않는다 — 있다면 제거해 viewBox만으로
		// 스케일링되게 한다.
		const stripped = openTag.replace( /\s(?:width|height)\s*=\s*["'][^"']*["']/gi, '' );
		if ( stripped !== openTag ) {
			return svg.replace( openTag, stripped );
		}
	}

	return svg;
}

function sanitizeImageText( value, maxLength ) {
	return String( value || '' )
		.replace( /[\u0000-\u001F\u007F]/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim()
		.slice( 0, maxLength );
}

// ──────────────────────────────────────────────────────────────────────
// 4. 3순위 경로: 자체 내장 최종 폴백 SVG 카드. 외부 모델 호출 없이 항상
//    성공하는 안전망이며, 이 파일 밖의 어떤 함수에도 의존하지 않는다.
// ──────────────────────────────────────────────────────────────────────

// [배경 시작색, 배경 끝색, 장식용 강조색] — 강조색은 텍스트 색과 대비되게
// 장식 도형(원/스트라이프)에만 낮은 불투명도로 사용해 카드에 깊이감을 준다.
const FALLBACK_STYLE_COLORS = {
	photo_realistic: [ '#1f2937', '#4b5563', '#f59e0b' ],
	poster:          [ '#dc2626', '#7c2d12', '#fbbf24' ],
	minimal:         [ '#f8fafc', '#e2e8f0', '#94a3b8' ],
	typography:      [ '#111827', '#374151', '#60a5fa' ],
	branding:        [ '#312e81', '#4338ca', '#a5b4fc' ],
};

function escapeXml( str ) {
	return String( str )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' )
		.replace( /'/g, '&apos;' );
}

function buildFallbackSvgCard( topic, subtitle, style, width, height ) {
	const [ c1, c2, accent ] = FALLBACK_STYLE_COLORS[ style ] || FALLBACK_STYLE_COLORS.minimal;
	const title = escapeXml( ( topic || '' ).toString().slice( 0, 40 ) );
	const sub   = escapeXml( ( subtitle || '' ).toString().slice( 0, 60 ) );
	const textColor = style === 'minimal' ? '#0f172a' : '#ffffff';
	const scrimOpacity = style === 'minimal' ? 0 : 0.16;

	// 스타일별로 장식 도형의 배치를 다르게 해 카드마다 구도가 단조롭지
	// 않도록 한다(포스터: 대각선 스트라이프, 미니멀: 큰 원 하나, 그 외:
	// 우상단 원 + 좌하단 원의 균형 구도).
	const decoration = style === 'poster'
		? `<g opacity="0.25"><rect x="${ width * 0.62 }" y="${ -height * 0.1 }" width="${ width * 0.14 }" height="${ height * 1.3 }" fill="${ accent }" transform="rotate(18 ${ width * 0.7 } ${ height * 0.5 })"/></g>`
		: style === 'minimal'
			? `<circle cx="${ width * 0.86 }" cy="${ height * 0.28 }" r="${ height * 0.32 }" fill="${ accent }" opacity="0.14"/>`
			: `<circle cx="${ width * 0.9 }" cy="${ height * 0.14 }" r="${ height * 0.22 }" fill="${ accent }" opacity="0.18"/>` +
			  `<circle cx="${ width * 0.06 }" cy="${ height * 0.96 }" r="${ height * 0.16 }" fill="${ accent }" opacity="0.12"/>`;

	const scrim = scrimOpacity > 0
		? `<rect x="0" y="${ height * 0.34 }" width="${ width * 0.72 }" height="${ height * 0.36 }" fill="#000000" opacity="${ scrimOpacity }"/>`
		: '';

	return `<svg viewBox="0 0 ${ width } ${ height }" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${ c1 }"/>
      <stop offset="100%" stop-color="${ c2 }"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  ${ decoration }
  ${ scrim }
  <text x="${ width * 0.08 }" y="${ height * 0.5 }" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="${ Math.round( height * 0.09 ) }" font-weight="700" fill="${ textColor }">${ title }</text>
  <text x="${ width * 0.08 }" y="${ height * 0.62 }" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="${ Math.round( height * 0.045 ) }" fill="${ textColor }" opacity="0.85">${ sub }</text>
  <rect x="${ width * 0.08 }" y="${ height * 0.68 }" width="${ width * 0.1 }" height="${ Math.max( 4, height * 0.006 ) }" fill="${ accent }" opacity="0.9"/>
</svg>`;
}

/**
 * 이 모듈의 진입점. worker.js(또는 worker-search.js)의 /api/image 핸들러가
 * 이 함수를 호출한다.
 *
 * @param {object} env   Worker 환경(바인딩된 env.AI 포함).
 * @param {object} body  { prompt, topic, subtitle, style, width, height }
 * @returns {object} { data_url, mime_type, width, height, provider, model_used, fallback_used }
 *
 * 1순위(SVG-LLM) → 2순위(이미지 모델 풀) → 3순위(자체 내장 SVG 카드, 항상 성공)
 * 순서로 시도한다.
 */
export async function generateImage( env, body ) {
	body = body && typeof body === 'object' ? body : {};
	const requestedStyle = String( body.style || 'minimal' ).toLowerCase();
	const style  = SVG_STYLE_DIRECTIVES[ requestedStyle ] ? requestedStyle : 'minimal';
	const width  = Math.min( Math.max( parseInt( body.width, 10 )  || 1600, 256 ), 2048 );
	const height = Math.min( Math.max( parseInt( body.height, 10 ) || 900,  256 ), 2048 );

	const svgResult = await generateSvgWithLLM( env, body, style, width, height );
	if ( svgResult ) return svgResult;

	const modelResult = await generateWithImageModelPool( env, body, style, width, height );
	if ( modelResult ) return { ...modelResult, fallback_used: true };

	// 1·2순위 모두 실패 — 이 파일 안에서 완결되는 최종 안전망.
	const svg = buildFallbackSvgCard( body.topic, body.subtitle, style, width, height );
	return {
		data_url:      'data:image/svg+xml;base64,' + btoa( unescape( encodeURIComponent( svg ) ) ),
		mime_type:     'image/svg+xml',
		width,
		height,
		provider:      'fallback-svg-card',
		model_used:    'fallback-svg-card',
		fallback_used: true,
	};
}

/**
 * /api/image의 HTTP 어댑터. 생성 로직은 generateImage에만 두고, Worker와
 * Pages Functions가 같은 입력 검증/JSON 응답을 사용하도록 이 파일에서 제공한다.
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
	const prompt = sanitizeImageText( body.prompt || body.q, 1200 );
	const topic = sanitizeImageText( body.topic, 90 );
	if ( ! prompt && ! topic ) {
		return json( {
			error: 'prompt 또는 topic이 필요합니다.',
			endpoint: 'POST /api/image { prompt, topic?, subtitle?, style?, width?, height? }',
		}, 400 );
	}

	try {
		return json( await generateImage( env, { ...body, prompt, topic } ) );
	} catch ( err ) {
		console.error( `[image-core] 이미지 생성 실패: ${ err && err.message ? err.message : err }` );
		return json( { error: 'image_generation_failed', success: false }, 500 );
	}
}

export { CORS_HEADERS };
