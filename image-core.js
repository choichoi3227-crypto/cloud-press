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
 *   (Llama 3.1 8B Instruct)을 사용하므로 topic/subtitle 원문 그대로 전달한다.
 * - 2순위(이미지 모델): 전부 영어 중심 학습 모델이므로, zorlinq32가 이미
 *   만들어 보낸 영어 prompt를 그대로 쓰고, 비어 있을 때만 이 Worker가
 *   topic/subtitle을 바탕으로 최소한의 영어 배경 묘사를 즉석에서 구성한다
 *   (완벽한 번역이 아니라 "배경 생성에 방해되지 않는" 수준이 목표).
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
	'extra limbs, deformed, ugly, jpeg artifacts, oversaturated, noisy';

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

	const styleHint = {
		photo_realistic: 'photorealistic photography, natural lighting, shallow depth of field',
		poster: 'graphic design poster background, bold flat composition, clean layout',
		minimal: 'minimalist background, plenty of negative space, soft single-tone gradient',
		typography: 'abstract simple background suited for large text overlay, low visual noise',
		branding: 'premium brand campaign visual, polished commercial look',
	}[ style ] || 'clean background, high quality';

	// topic/subtitle은 한국어일 가능성이 높으므로, 모델에는 주제를 "장면"으로
	// 변환한 general English framing만 넘기고 한글 원문 자체는 넣지 않는다
	// (확산 모델이 한글을 그대로 화면에 그리려 시도하는 것을 방지).
	const subjectHint = subtitle || topic || 'a relevant conceptual scene';
	return `A background image representing the concept of "${ subjectHint }" (described abstractly, no on-image text), ${ styleHint }, no people's faces in focus, high resolution, 16:9 composition`;
}

/**
 * 선택된 모델 하나를 실제로 호출한다. 성공 시 { base64, mime } 반환,
 * 실패 시 null을 반환해 호출부가 다음 모델로 넘어갈 수 있게 한다.
 */
async function callOneModel( env, modelKey, prompt, width, height ) {
	const model = IMAGE_MODELS[ modelKey ];
	if ( ! model ) return null;

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
			const negative = model.supportsNegative ? COMMON_NEGATIVE_PROMPT : undefined;
			const input = model.buildInput( prompt, width, height, negative );
			result = await env.AI.run( model.id, input );
		}

		if ( ! result ) return null;

		// Workers AI 이미지 모델은 대개 ReadableStream(바이너리 이미지) 또는
		// { image: base64 } 형태를 반환한다. 두 경우를 모두 처리한다.
		if ( result instanceof ReadableStream ) {
			const buf = await new Response( result ).arrayBuffer();
			const base64 = arrayBufferToBase64( buf );
			return { base64, mime: 'image/png', modelKey, modelId: model.id, modelLabel: model.label };
		}
		if ( result.image ) {
			return { base64: result.image, mime: 'image/jpeg', modelKey, modelId: model.id, modelLabel: model.label };
		}

		return null;
	} catch ( err ) {
		console.warn( `[image-core] 모델 실패: ${ model.id } — ${ err && err.message ? err.message : err }` );
		return null;
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
 */
async function generateWithImageModelPool( env, body, style, width, height ) {
	const prompt = buildBackgroundPrompt( body.prompt, body.topic, body.subtitle, style );
	const order  = pickModelOrder( style );

	for ( const modelKey of order ) {
		const picked = await callOneModel( env, modelKey, prompt, width, height );
		if ( picked ) {
			return {
				data_url:      `data:${ picked.mime };base64,${ picked.base64 }`,
				mime_type:     picked.mime,
				width,
				height,
				provider:      'workers-ai:' + picked.modelKey.toLowerCase(),
				model_used:    picked.modelLabel,
				fallback_used: order[ 0 ] !== modelKey,
			};
		}
	}
	return null;
}

// ──────────────────────────────────────────────────────────────────────
// 3. 1순위 경로: SVG 필터 기반 생성 (텍스트 LLM이 SVG 마크업을 직접 작성).
//    한글 텍스트가 벡터로 정확히 렌더링되고, 색상/레이아웃 커스터마이징이
//    쉬운 것이 핵심 장점이다. 스타일별 프롬프트(요청하신 그대로)를 시스템
//    프롬프트로 사용해 톤을 맞춘다.
// ──────────────────────────────────────────────────────────────────────

const SVG_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// 기존 이미지 모델 프롬프트에서 이미 확립된 스타일별 톤을 그대로 재사용한다
// (요청사항: "스타일별 프롬프트 그대로 이용").
const SVG_STYLE_DIRECTIVES = {
	photo_realistic: '사실적인 사진처럼 보이는 장면을 벡터 도형(그라디언트, 다중 레이어 도형, 은은한 그림자)으로 표현하라. 인물의 얼굴을 세밀하게 그리려 하지 말고, 실루엣과 조명감(빛 번짐, 그림자 대비)으로 사실적 분위기를 낸다.',
	poster: '굵은 색면과 명확한 레이아웃의 그래픽 디자인 포스터. 대비가 강한 색상 2~3개, 큼직한 도형, 여백을 활용한 시선 유도 구도.',
	minimal: '넉넉한 여백과 단순한 형태의 미니멀 배경. 단색이나 부드러운 단일 톤 그라디언트, 장식 요소는 최소화.',
	typography: '텍스트가 화면의 주인공이 되는 구도. 배경은 텍스트 가독성을 해치지 않는 저채도 단순 패턴이나 그라디언트로만 구성.',
	branding: '고급스러운 브랜드 캠페인 비주얼. 정제된 색상 팔레트, 균형 잡힌 여백, 상업적으로 세련된 톤.',
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
	const directive = SVG_STYLE_DIRECTIVES[ style ] || SVG_STYLE_DIRECTIVES.minimal;
	const title    = ( body.topic || '' ).toString().slice( 0, 60 );
	const subtitle = ( body.subtitle || '' ).toString().slice( 0, 80 );

	const systemPrompt =
		'당신은 SVG 마크업만으로 완성된 썸네일 비주얼을 그리는 디자이너입니다. ' +
		'설명이나 코드블록 표시(```) 없이, <svg> 태그로 시작해서 </svg> 태그로 끝나는 ' +
		'완전한 SVG 마크업 "그 자체"만 출력하세요. 다른 텍스트는 절대 출력하지 마세요.\n\n' +
		`캔버스 크기는 viewBox="0 0 ${ width } ${ height }" 로 고정합니다.\n` +
		'제목 텍스트가 있다면 <text> 요소로 화면에 큼직하게 배치하고, 한글이 잘리거나 ' +
		'뷰박스를 벗어나지 않도록 폰트 크기와 위치를 신중히 정하세요. ' +
		'font-family는 "Pretendard, \'Apple SD Gothic Neo\', \'Malgun Gothic\', sans-serif"로 지정하세요.\n' +
		'그라디언트(linearGradient/radialGradient), 도형, 은은한 패턴을 활용해 배경을 풍부하게 만드세요.\n\n' +
		`디자인 톤: ${ directive }`;

	const userPrompt = [
		title    ? `제목: ${ title }`    : '',
		subtitle ? `부제목: ${ subtitle }` : '',
		'위 내용을 담은 썸네일을 SVG로 그려주세요.',
	].filter( Boolean ).join( '\n' );

	try {
		const result = await env.AI.run( SVG_TEXT_MODEL, {
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: 3000,
		} );

		const raw = result && result.response ? String( result.response ) : '';
		const svg = extractSvgMarkup( raw );
		if ( ! svg ) return null;

		return {
			data_url:      'data:image/svg+xml;base64,' + btoa( unescape( encodeURIComponent( svg ) ) ),
			mime_type:     'image/svg+xml',
			width,
			height,
			provider:      'svg-llm:' + SVG_TEXT_MODEL.split( '/' ).pop(),
			model_used:    'SVG (Llama 3.1 8B Instruct)',
			fallback_used: false,
		};
	} catch ( err ) {
		console.warn( `[image-core] SVG LLM 생성 실패: ${ err && err.message ? err.message : err }` );
		return null;
	}
}

/**
 * LLM 응답에서 실제 <svg>...</svg> 마크업만 추출하고, 형태가 최소한
 * 유효한지(태그 짝, viewBox 존재) 가볍게 검증한다. 완전한 XML 검증은
 * 하지 않지만, 명백히 깨진 응답(코드블록 설명이 섞이거나 태그가
 * 안 닫힌 경우)은 걸러내 2순위로 안전하게 넘어가게 한다.
 */
function extractSvgMarkup( raw ) {
	if ( ! raw ) return null;
	const start = raw.indexOf( '<svg' );
	const end   = raw.lastIndexOf( '</svg>' );
	if ( start === -1 || end === -1 || end <= start ) return null;

	const svg = raw.slice( start, end + '</svg>'.length ).trim();
	// 아주 짧으면(모델이 태그만 흉내내고 내용은 못 채운 경우) 신뢰하지 않는다.
	if ( svg.length < 80 ) return null;
	return svg;
}

// ──────────────────────────────────────────────────────────────────────
// 4. 3순위 경로: 자체 내장 최종 폴백 SVG 카드. 외부 모델 호출 없이 항상
//    성공하는 안전망이며, 이 파일 밖의 어떤 함수에도 의존하지 않는다.
// ──────────────────────────────────────────────────────────────────────

const FALLBACK_STYLE_COLORS = {
	photo_realistic: [ '#1f2937', '#4b5563' ],
	poster:          [ '#dc2626', '#7c2d12' ],
	minimal:         [ '#f8fafc', '#e2e8f0' ],
	typography:      [ '#111827', '#374151' ],
	branding:        [ '#312e81', '#4338ca' ],
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
	const [ c1, c2 ] = FALLBACK_STYLE_COLORS[ style ] || FALLBACK_STYLE_COLORS.minimal;
	const title = escapeXml( ( topic || '' ).toString().slice( 0, 40 ) );
	const sub   = escapeXml( ( subtitle || '' ).toString().slice( 0, 60 ) );
	const textColor = style === 'minimal' ? '#0f172a' : '#ffffff';

	return `<svg viewBox="0 0 ${ width } ${ height }" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${ c1 }"/>
      <stop offset="100%" stop-color="${ c2 }"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="${ width * 0.08 }" y="${ height * 0.5 }" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="${ Math.round( height * 0.09 ) }" font-weight="700" fill="${ textColor }">${ title }</text>
  <text x="${ width * 0.08 }" y="${ height * 0.62 }" font-family="Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif" font-size="${ Math.round( height * 0.045 ) }" fill="${ textColor }" opacity="0.85">${ sub }</text>
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
	const style  = body.style || 'minimal';
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
