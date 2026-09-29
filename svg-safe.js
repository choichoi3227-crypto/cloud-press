/**
 * svg-safe.js — SVG 문자열을 "반드시 렌더링되는" 상태로 만드는 유틸.
 *
 * 왜 필요한가
 * ─────────────────────────────────────────────────────────────
 * /api/image가 돌려주는 SVG는 <img>, <canvas>(zorlinq32 합성), resvg(PNG 변환),
 * WordPress 미디어 업로드 등 여러 소비자를 거친다. 이 소비자들은 XML이
 * 단 한 글자만 깨져도(bare `&`, 닫히지 않은 태그, 중복 속성, 토큰 초과로
 * 잘린 응답 등) 이미지를 통째로 버린다. 또한 루트 <svg>에 width/height가
 * 없으면 Firefox 캔버스 합성이나 WordPress가 크기를 못 읽어 실패한다.
 *
 * 이 모듈은
 *   1) XML에 안 맞는 문자/엔티티를 고치고,
 *   2) 잘린 응답은 마지막으로 온전한 태그까지만 살려 태그를 닫아 주고,
 *   3) 태그 짝·속성 문법을 직접 검증하고,
 *   4) 루트에 xmlns / viewBox / width / height를 보장한다.
 * 외부 의존성이 없어 Workers 어디서든 동작한다.
 */

const HTML_ENTITY_MAP = {
	nbsp: ' ', copy: '©', reg: '®', trade: '™', middot: '·', hellip: '…',
	ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
	times: '×', bull: '•', laquo: '«', raquo: '»', hearts: '♥', larr: '←',
	rarr: '→', uarr: '↑', darr: '↓', deg: '°', plusmn: '±', euro: '€', won: '₩',
};

const BAD_ENTITY_RE = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

export function escapeXml( str ) {
	return cleanXmlChars( String( str == null ? '' : str ) )
		.replace( /&/g, '&amp;' )
		.replace( /</g, '&lt;' )
		.replace( />/g, '&gt;' )
		.replace( /"/g, '&quot;' )
		.replace( /'/g, '&apos;' );
}

/** XML 1.0에서 허용되지 않는 제어문자·짝 없는 서로게이트를 제거한다. */
export function cleanXmlChars( str ) {
	return String( str )
		.replace( /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '' )
		.replace( /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '' )
		.replace( /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '' );
}

/** `&nbsp;` 같은 HTML 전용 엔티티를 실제 문자로 바꾸고, 남은 bare `&`는 `&amp;`로 이스케이프한다. */
function fixEntities( s ) {
	return s
		.replace( /&([a-zA-Z]+);/g, ( m, name ) => {
			if ( [ 'amp', 'lt', 'gt', 'quot', 'apos' ].includes( name ) ) return m;
			return Object.prototype.hasOwnProperty.call( HTML_ENTITY_MAP, name ) ? HTML_ENTITY_MAP[ name ] : '&amp;' + name + ';';
		} )
		.replace( /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;' );
}

const TAG_RE = /<(\/?)([A-Za-z_][\w:.\-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/y;
const ATTR_RE = /\s+([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

/**
 * 가벼운 XML well-formedness 스캐너.
 * @returns {{ok:boolean, error?:string, pos?:number, lastGood:number, stackAtGood:string[]}}
 *   lastGood: 여기까지는 온전하다고 확인된 문자열 위치, stackAtGood: 그 시점에 열려 있는 태그들.
 */
export function scanXml( svg ) {
	const stack = [];
	let stackAtGood = [];
	let lastGood = 0;
	let i = 0;
	let rootClosed = false;
	let sawRoot = false;
	const n = svg.length;

	const fail = ( error, pos ) => ( { ok: false, error, pos, lastGood, stackAtGood } );

	while ( i < n ) {
		const lt = svg.indexOf( '<', i );
		const text = svg.slice( i, lt === -1 ? n : lt );

		if ( BAD_ENTITY_RE.test( text ) ) return fail( 'bad-entity', i );
		if ( ( rootClosed || ! sawRoot ) && /\S/.test( text ) ) return fail( 'stray-text', i );
		if ( lt === -1 ) {
			lastGood = n;
			stackAtGood = stack.slice();
			break;
		}
		lastGood = lt;
		stackAtGood = stack.slice();

		if ( svg.startsWith( '<!--', lt ) ) {
			const end = svg.indexOf( '-->', lt + 4 );
			if ( end === -1 ) return fail( 'unterminated-comment', lt );
			i = end + 3;
		} else if ( svg.startsWith( '<![CDATA[', lt ) ) {
			const end = svg.indexOf( ']]>', lt + 9 );
			if ( end === -1 ) return fail( 'unterminated-cdata', lt );
			i = end + 3;
		} else if ( svg.startsWith( '<?', lt ) ) {
			const end = svg.indexOf( '?>', lt + 2 );
			if ( end === -1 ) return fail( 'unterminated-pi', lt );
			i = end + 2;
		} else if ( svg.startsWith( '<!', lt ) ) {
			const end = svg.indexOf( '>', lt + 2 );
			if ( end === -1 ) return fail( 'unterminated-decl', lt );
			i = end + 1;
		} else {
			TAG_RE.lastIndex = lt;
			const m = TAG_RE.exec( svg );
			if ( ! m ) return fail( 'bad-tag', lt );
			const [ whole, closing, name, attrText, selfClose ] = m;

			if ( closing ) {
				if ( /\S/.test( attrText ) || selfClose ) return fail( 'bad-close-tag', lt );
				if ( stack.pop() !== name ) return fail( 'tag-mismatch', lt );
				if ( stack.length === 0 ) rootClosed = true;
			} else {
				if ( rootClosed ) return fail( 'multiple-roots', lt );
				if ( ! sawRoot ) {
					if ( name !== 'svg' ) return fail( 'root-not-svg', lt );
					sawRoot = true;
				}
				// 속성 문법·중복 검사
				const seen = new Set();
				let p = 0;
				ATTR_RE.lastIndex = 0;
				while ( p < attrText.length ) {
					ATTR_RE.lastIndex = p;
					const am = ATTR_RE.exec( attrText );
					if ( ! am ) break;
					if ( seen.has( am[ 1 ] ) ) return fail( 'duplicate-attribute', lt );
					seen.add( am[ 1 ] );
					if ( BAD_ENTITY_RE.test( am[ 2 ] !== undefined ? am[ 2 ] : am[ 3 ] ) ) return fail( 'bad-entity-in-attr', lt );
					p = ATTR_RE.lastIndex;
				}
				if ( /\S/.test( attrText.slice( p ) ) ) return fail( 'bad-attribute', lt );
				if ( ! selfClose ) stack.push( name );
				else if ( stack.length === 0 ) rootClosed = true;
			}
			i = lt + whole.length;
		}
		lastGood = i;
		stackAtGood = stack.slice();
	}

	if ( ! sawRoot ) return fail( 'no-root', 0 );
	if ( stack.length > 0 ) return fail( 'unclosed-tags', n );
	return { ok: true, lastGood: n, stackAtGood: [] };
}

/**
 * LLM/외부 입력 SVG를 최대한 살려서 well-formed 상태로 만든다.
 * 살릴 수 없으면 null.
 */
export function repairSvg( raw ) {
	if ( ! raw ) return null;
	let s = cleanXmlChars( String( raw ) );
	const start = s.indexOf( '<svg' );
	if ( start === -1 ) return null;
	s = s.slice( start );
	const end = s.lastIndexOf( '</svg>' );
	if ( end !== -1 ) s = s.slice( 0, end + '</svg>'.length );
	s = fixEntities( s ).trim();

	let scan = scanXml( s );
	if ( scan.ok ) return s;

	// 토큰 초과 등으로 잘렸거나 중간 태그가 깨진 경우: 마지막으로 온전한 위치까지만
	// 남기고 열려 있는 태그를 닫아 준다. (열린 <text> 안의 잘린 글자는 버려진다.)
	if ( scan.lastGood > 0 && scan.stackAtGood.length > 0 ) {
		const closers = scan.stackAtGood.slice().reverse().map( ( t ) => `</${ t }>` ).join( '' );
		const repaired = s.slice( 0, scan.lastGood ) + closers;
		scan = scanXml( repaired );
		if ( scan.ok ) return repaired;
	}
	return null;
}

const FORBIDDEN_RE = /<(?:script|foreignObject|iframe|image|audio|video|embed|object|animate|set)\b|\son\w+\s*=|@import|(?:href|xlink:href)\s*=\s*["']\s*(?!#)|url\(\s*["']?\s*(?!#)/i;

/**
 * 최종 관문: 복구 → 금지 요소 검사 → 루트 속성(xmlns/viewBox/width/height) 보정.
 * @param {string} raw     SVG 원문(LLM 출력 또는 자체 생성).
 * @param {number} width   요청 픽셀 너비.
 * @param {number} height  요청 픽셀 높이.
 * @returns {string|null}  안전하고 well-formed한 SVG, 불가능하면 null.
 */
export function finalizeSvg( raw, width, height ) {
	const svg = repairSvg( raw );
	if ( ! svg ) return null;
	if ( svg.length < 120 ) return null;
	if ( FORBIDDEN_RE.test( svg ) ) return null;

	const openMatch = svg.match( /^<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/ );
	if ( ! openMatch ) return null;
	const attrText = openMatch[ 1 ].replace( /\/\s*$/, '' );

	// 기존 속성 파싱
	const attrs = {};
	const order = [];
	let p = 0;
	while ( p < attrText.length ) {
		ATTR_RE.lastIndex = p;
		const am = ATTR_RE.exec( attrText );
		if ( ! am ) break;
		attrs[ am[ 1 ] ] = am[ 2 ] !== undefined ? am[ 2 ] : am[ 3 ];
		order.push( am[ 1 ] );
		p = ATTR_RE.lastIndex;
	}

	// viewBox: 없으면 요청 크기로 만든다. 있는데 비율이 크게 다르면 모델이 지시를
	// 무시한 것이므로 왜곡된 이미지를 내보내는 대신 거부한다.
	let viewBox = attrs.viewBox;
	if ( viewBox ) {
		const nums = viewBox.trim().split( /[\s,]+/ ).map( Number );
		if ( nums.length !== 4 || nums.some( ( v ) => ! isFinite( v ) ) || nums[ 2 ] <= 0 || nums[ 3 ] <= 0 ) return null;
		if ( width && height ) {
			const ratio = ( nums[ 2 ] / nums[ 3 ] ) / ( width / height );
			if ( Math.abs( ratio - 1 ) > 0.3 ) return null;
		}
	} else {
		viewBox = `0 0 ${ width } ${ height }`;
	}

	const extra = order
		.filter( ( k ) => ! [ 'xmlns', 'width', 'height', 'viewBox' ].includes( k ) )
		.map( ( k ) => ` ${ k }="${ attrs[ k ] }"` )
		.join( '' );
	// xlink:href를 쓰면서 xmlns:xlink 선언을 빠뜨리는 것도 흔한 LLM 실수다(선언 없는 접두어는 XML 오류).
	const needXlink = /\sxlink:/.test( svg.slice( openMatch[ 0 ].length ) ) && ! ( 'xmlns:xlink' in attrs );
	const openTag = `<svg xmlns="http://www.w3.org/2000/svg"${ needXlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '' } width="${ width }" height="${ height }" viewBox="${ viewBox }"${ extra }>`;
	const fixed = openTag + svg.slice( openMatch[ 0 ].length );

	return scanXml( fixed ).ok ? fixed : null;
}

/** UTF-8 안전 base64 (btoa + unescape 조합 대신 TextEncoder 사용). */
export function svgToDataUrl( svg ) {
	const bytes = new TextEncoder().encode( svg );
	let binary = '';
	const chunk = 0x8000;
	for ( let i = 0; i < bytes.length; i += chunk ) {
		binary += String.fromCharCode.apply( null, bytes.subarray( i, i + chunk ) );
	}
	return 'data:image/svg+xml;base64,' + btoa( binary );
}

/** 화면에 실제로 그려지는 요소 수(너무 빈약한 LLM 결과를 걸러내는 품질 기준). */
export function countDrawn( svg ) {
	return ( String( svg ).match( /<(?:path|rect|circle|ellipse|polygon|polyline|line|use|text)\b/g ) || [] ).length;
}
