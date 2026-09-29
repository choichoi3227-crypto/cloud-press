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
 * 생성 경로 우선순위 (SVG 경로가 1순위)
 * ════════════════════════════════════════════════════════════════════════
 * 1순위) 프롬프트 충실 SVG — Workers AI LLM이 전달된 프롬프트 원문을 그대로 읽고 장면을
 *        직접 그린다. 실물 느낌이 필요한 사물은 라이브러리 심볼(<use href="#obj-laptop">)로
 *        가져다 쓸 수 있고, 결과는 svg-safe.js의 복구·검증과 최소 요소 수 검사를 통과해야 한다.
 *        (AI 바인딩이 없거나 provider:"svg-scene" / env.SVG_FREEHAND="false" 면 건너뜀)
 * 2순위) 오브젝트 씬 합성(svg-scene.js + svg-objects.js) — 프롬프트·주제에서 사물과 색을 골라
 *        24종 벡터 오브젝트로 조립한다. 시드별로 레이아웃·배경 모티프·색이 달라지고, 항상
 *        well-formed 이며 AI 없이도 동작한다.
 * 3순위) Cloudflare Workers AI 이미지 생성 모델 풀 — provider:"ai-model"이면 1순위보다 먼저,
 *        아니면 위 경로가 실패했을 때 시도한다(스타일별 풀에서 무작위 선택, 실패 시 다음 모델).
 * 4순위) 이 파일 자체에 내장된 최종 SVG 카드 생성기(항상 성공).
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
import { escapeXml, finalizeSvg, svgToDataUrl, scanXml, countDrawn } from './svg-safe.js';
import { buildSymbols, symbolCatalog, OBJECT_KEYS } from './svg-objects.js';
import { planScene, composeSceneSvg } from './svg-scene.js';
import KOREAN_FONT_TTF from './assets/fonts/NotoSansKR-Bold.ttf';

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
 * 프롬프트 충실 경로: LLM이 "전달된 프롬프트 그대로" 장면을 직접 그린다.
 *
 * - 프롬프트 원문을 가장 앞에 두고, 프롬프트의 모든 명사·장소·시간대·색·분위기가
 *   화면에 보이도록 요구한다(고정된 사물 목록에서 고르는 방식이 아니다).
 * - 실물 느낌이 필요한 사물은 라이브러리 심볼(<use href="#obj-laptop" .../>)을 가져다 쓸 수
 *   있게 하고, 없는 사물은 LLM이 도형으로 직접 그린다. 심볼 정의는 응답에 없어도 서버가
 *   <defs>에 주입하므로 참조가 끊기지 않는다.
 * - 결과는 복구·검증(finalizeSvg) + 최소 요소 수 검사를 통과해야만 채택한다. 실패하면
 *   호출부가 오브젝트 씬 합성으로 넘어간다.
 */
const MIN_DRAWN_ELEMENTS = 30;

async function generateSvgWithLLM( env, body, style, width, height ) {
	if ( ! env || ! env.AI || typeof env.AI.run !== 'function' ) return null;

	const directive = SVG_STYLE_DIRECTIVES[ style ] || SVG_STYLE_DIRECTIVES.minimal;
	const prompt   = sanitizeImageText( body.prompt, 1500 );
	const title    = sanitizeImageText( body.topic, 90 );
	const subtitle = sanitizeImageText( body.subtitle, 140 );
	const scene    = prompt || [ title, subtitle ].filter( Boolean ).join( ' - ' );
	if ( ! scene ) return null;

	const systemPrompt =
		'You are a senior vector illustrator. Draw ONE finished, detailed illustration as raw SVG that depicts the ' +
		'IMAGE PROMPT as literally and specifically as possible. Every subject, object, setting, color, time of day, ' +
		'weather, mood and quantity mentioned in the prompt must be clearly recognizable in the picture. Do not replace ' +
		'the requested subject with generic abstract shapes, and do not add unrelated subjects.\n\n' +
		'OUTPUT FORMAT: output only the SVG markup, starting with <svg and ending with </svg>. No explanation, no code fences.\n' +
		`Canvas: <svg xmlns="http://www.w3.org/2000/svg" width="${ width }" height="${ height }" viewBox="0 0 ${ width } ${ height }">. ` +
		'The first child must be a <title> describing the scene.\n\n' +
		'COMPOSITION (build in this order, back to front): 1) background: sky / wall / room / landscape that matches the prompt\n' +
		'with a gradient; 2) environment details that belong to the setting (furniture, buildings, hills, trees, windows, horizon, ...); ' +
		'3) the MAIN SUBJECT drawn large (at least 35% of the canvas), built from many overlapping shapes with gradients, ' +
		'highlights, shading and a contact shadow so it looks solid and realistic; 4) secondary objects from the prompt; ' +
		'5) small foreground details, light effects and depth (overlapping layers, lighter far away, darker near). ' +
		'Use at least 40 shapes. Use the colors and lighting named in the prompt; otherwise choose a coherent 4-6 color palette.\n\n' +
		'LIBRARY SYMBOLS (optional, already defined, do not redefine): ' + symbolCatalog() + '. ' +
		'Place one with <use href="#obj-laptop" x="..." y="..." width="..." height="..."/> (keep width equal to height). ' +
		'Use a symbol when the prompt asks for exactly that object; draw everything else yourself, and draw the scene around them.\n\n' +
		'RULES: valid XML. Escape & < > as &amp; &lt; &gt; in text. Never repeat an attribute on one tag. ' +
		'No <script>, <image>, <foreignObject>, external links, CSS @import or filters (use gradients and semi-transparent shapes instead). ' +
		'Every shape needs explicit fill or stroke. Keep all important content inside the canvas.\n\n' +
		( title
			? `TEXT: add the title "${ title }"` + ( subtitle ? ` and the smaller subtitle "${ subtitle }"` : '' ) +
				' as <text> (font-family="Noto Sans KR, sans-serif", font-weight="700" for the title) on a translucent dark or light band ' +
				'in an empty area (usually the lower-left), sized 6-9% of the canvas height, high contrast, never covering the main subject. ' +
				'Break long titles into several <text> lines so nothing leaves the canvas.\n\n'
			: 'TEXT: do not put any text in the image.\n\n' ) +
		`Overall look: ${ directive }`;

	const userPrompt =
		`IMAGE PROMPT (draw exactly this):\n${ scene }` +
		( title && prompt ? `\n\nTitle: ${ title }` + ( subtitle ? `\nSubtitle: ${ subtitle }` : '' ) : '' ) +
		'\n\nNow output the complete SVG.';

	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	];

	const attempts = [ null,
		'The previous answer was rejected (invalid XML, too few shapes, wrong canvas, or extra text around the SVG). ' +
		`Output ONLY a complete, valid SVG with viewBox="0 0 ${ width } ${ height }", at least 40 shapes, closed tags and escaped &. ` +
		'The picture must show what the prompt describes.' ];

	for ( const retryNote of attempts ) {
		const callMessages = retryNote ? [ ...messages, { role: 'user', content: retryNote } ] : messages;
		try {
			const result = await env.AI.run( SVG_TEXT_MODEL, {
				messages: callMessages,
				max_tokens: 6000,
				temperature: 0.7,
			} );
			const raw = result && result.response ? String( result.response ) : '';
			let svg = extractSvgMarkup( raw, width, height );
			if ( ! svg ) continue;
			svg = injectSymbols( svg );
			if ( ! svg || countDrawn( svg ) < MIN_DRAWN_ELEMENTS ) continue;
			return {
				data_url:      svgToDataUrl( svg ),
				mime_type:     'image/svg+xml',
				format:        'svg',
				width,
				height,
				provider:      'svg-llm:' + SVG_TEXT_MODEL.split( '/' ).pop(),
				model_used:    'SVG (Llama 3.3 70B Instruct)',
				fallback_used: false,
				raw_svg:       svg,
			};
		} catch ( err ) {
			console.warn( `[image-core] SVG LLM 생성 실패(${ retryNote ? '재시도' : '1차' }): ${ err && err.message ? err.message : err }` );
		}
	}
	return null;
}

/**
 * 응답이 참조한 라이브러리 심볼 정의를 <defs>로 주입하고, 존재하지 않는 #obj-* 참조(<use>)는 제거한다.
 * 검증을 통과하지 못하면 null.
 */
function injectSymbols( svg ) {
	const known = new Set( OBJECT_KEYS.map( ( k ) => 'obj-' + k ) );
	const used = new Set();
	let out = svg.replace( /<use\b[^>]*?(?:xlink:)?href\s*=\s*["']#([\w-]+)["'][^>]*?\/>|<use\b[^>]*?(?:xlink:)?href\s*=\s*["']#([\w-]+)["'][^>]*?>\s*<\/use>/gi, ( m, a, b ) => {
		const id = a || b;
		if ( known.has( id ) ) { used.add( id ); return m; }
		// 모델이 자기 <defs>에 직접 정의한 id면 그대로 두고, 아니면 끊어진 참조이므로 제거한다.
		return new RegExp( `id\\s*=\\s*["']${ id }["']` ).test( svg ) ? m : '';
	} );
	if ( used.size ) {
		const defs = '<defs>' + buildSymbols( [ ...used ].map( ( id ) => id.slice( 4 ) ) ) + '</defs>';
		out = out.replace( /^(<svg\b[^>]*>)/, `$1${ defs }` );
	}
	return scanXml( out ).ok ? out : null;
}

/**
 * LLM 응답에서 SVG를 뽑아 "반드시 렌더링되는" 상태로 만든다(svg-safe.js 위임).
 *
 * 예전 구현은 루트의 width/height를 일부러 제거했는데, 그러면 Firefox 캔버스
 * 합성·WordPress 미디어 업로드처럼 고유 크기가 필요한 소비자가 이미지를 못 읽는다.
 * 지금은 요청 픽셀 크기를 width/height + viewBox로 모두 명시한다. 또한
 * bare `&`, 닫히지 않은 태그, 중복 속성, 토큰 초과로 잘린 응답을 복구하거나
 * 거부해서 깨진 SVG가 그대로 나가지 않게 한다.
 */
function extractSvgMarkup( raw, width, height ) {
	return finalizeSvg( raw, width, height );
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

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ width }" height="${ height }" viewBox="0 0 ${ width } ${ height }" role="img" aria-label="${ title }">
  <title>${ title || 'thumbnail' }</title>
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
 * null을 반환하고, 호출부(generateImage)가 원본 SVG를 그대로 반환하는
 * 폴백을 수행한다 — /api/image 자체는 이 때문에 항상 성공한다.
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

/**
 * 이 모듈의 진입점. worker.js(또는 worker-search.js)의 /api/image 핸들러가
 * 이 함수를 호출한다.
 *
 * @param {object} env   Worker 환경(바인딩된 env.AI 포함).
 * @param {object} body  { prompt, topic, subtitle, style, width, height }
 * @returns {object} { data_url, mime_type, width, height, provider, model_used, fallback_used }
 *
 * 1순위(SVG-LLM) → 2순위(이미지 모델 풀) → 3순위(자체 내장 SVG 카드, 항상 성공)
 * 순서로 시도한 뒤, SVG 결과(1·3순위)는 PNG로 래스터라이즈를 시도한다.
 * PNG 변환이 실패해도 원본 SVG를 그대로 반환하므로 이 함수는 항상 성공한다.
 */
export async function generateImage( env, body ) {
	body = body && typeof body === 'object' ? body : {};
	const requestedStyle = String( body.style || 'minimal' ).toLowerCase();
	const style  = SVG_STYLE_DIRECTIVES[ requestedStyle ] ? requestedStyle : 'minimal';
	const width  = Math.min( Math.max( parseInt( body.width, 10 )  || 1600, 256 ), 2048 );
	const height = Math.min( Math.max( parseInt( body.height, 10 ) || 900,  256 ), 2048 );
	const provider = String( body.provider || '' ).toLowerCase();

	// 요청에서 확산 모델을 명시한 경우에만 그림 생성 모델 풀을 먼저 시도한다.
	if ( 'ai-model' === provider ) {
		const modelFirst = await generateWithImageModelPool( env, body, style, width, height );
		if ( modelFirst ) return { ...modelFirst, fallback_used: false };
	}

	// 1순위: LLM이 프롬프트를 그대로 읽고 장면을 직접 그린다(AI 바인딩이 있고 강제 해제하지 않은 경우).
	// provider:"svg-scene" 이거나 env.SVG_FREEHAND="false" 면 건너뛴다.
	const freehandOff = 'svg-scene' === provider || String( env && env.SVG_FREEHAND ).toLowerCase() === 'false';
	if ( ! freehandOff ) {
		const svgResult = await generateSvgWithLLM( env, body, style, width, height );
		if ( svgResult ) return tryConvertToPng( env, svgResult );
	}

	// 2순위: 주제·프롬프트에서 사물을 골라 조립하는 오브젝트 씬(항상 well-formed, AI 없이도 동작).
	try {
		const plan = await planScene( env, body );
		const composed = composeSceneSvg( plan, {
			topic: body.topic, subtitle: body.subtitle, prompt: body.prompt, style, width, height,
		} );
		const svg = finalizeSvg( composed, width, height );
		if ( svg ) {
			return tryConvertToPng( env, {
				data_url:      svgToDataUrl( svg ),
				mime_type:     'image/svg+xml',
				format:        'svg',
				width,
				height,
				provider:      'svg-scene:' + plan.planner,
				model_used:    `SVG Scene (${ [ plan.hero, ...plan.supports ].join( ' + ' ) })`,
				fallback_used: ! freehandOff && !! ( env && env.AI ),
				scene:         { hero: plan.hero, supports: plan.supports, planner: plan.planner },
				raw_svg:       svg,
			} );
		}
		console.warn( '[image-core] 씬 SVG가 검증을 통과하지 못해 다음 경로로 넘어갑니다.' );
	} catch ( err ) {
		console.warn( `[image-core] 씬 합성 실패: ${ err && err.message ? err.message : err }` );
	}

	if ( 'ai-model' !== provider ) {
		const modelResult = await generateWithImageModelPool( env, body, style, width, height );
		if ( modelResult ) return { ...modelResult, fallback_used: true };
	}

	// 위 경로가 모두 실패 — 이 파일 안에서 완결되는 최종 안전망.
	const svg = buildFallbackSvgCard( body.topic || body.subtitle || body.prompt, body.subtitle, style, width, height );
	const fallbackResult = {
		data_url:      svgToDataUrl( svg ),
		mime_type:     'image/svg+xml',
		format:        'svg',
		width,
		height,
		provider:      'fallback-svg-card',
		model_used:    'fallback-svg-card',
		fallback_used: true,
		raw_svg:       svg,
	};
	return tryConvertToPng( env, fallbackResult );
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
