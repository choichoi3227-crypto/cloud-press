/**
 * svg-audit.js — LLM이 그린 SVG의 "글자" 검수/보정.
 *
 * 목적
 *  - 제목이 이미지 안에 정확히 한 번만 그려졌는지 확인한다(2중 제목 방지).
 *    같은 자리에 겹쳐 그린 글로우/그림자용 복사본은 "한 번"으로 친다.
 *  - 제목이 틀린 글자로 바뀌었거나 빠졌으면 걸러낸다.
 *  - 글자가 캔버스 밖으로 나가면 font-size를 줄여 자동 보정한다.
 *
 * 외부 의존성 없는 순수 함수만 둔다(Worker/Node 모두에서 테스트 가능).
 */

import { textUnits } from './image-styles.js';

const TEXT_RE = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
const ATTR_RE = /([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities( s ) {
	return String( s )
		.replace( /&#x([0-9a-fA-F]+);/g, ( _, h ) => String.fromCodePoint( parseInt( h, 16 ) ) )
		.replace( /&#(\d+);/g, ( _, d ) => String.fromCodePoint( parseInt( d, 10 ) ) )
		.replace( /&lt;/g, '<' ).replace( /&gt;/g, '>' ).replace( /&quot;/g, '"' ).replace( /&apos;/g, "'" )
		.replace( /&amp;/g, '&' );
}

function parseAttrs( attrText ) {
	const a = {};
	ATTR_RE.lastIndex = 0;
	let m;
	while ( ( m = ATTR_RE.exec( attrText ) ) ) a[ m[ 1 ] ] = m[ 2 ] !== undefined ? m[ 2 ] : m[ 3 ];
	return a;
}

const num = ( v, W ) => {
	if ( v === undefined || v === null || v === '' ) return NaN;
	const s = String( v ).trim();
	if ( s.endsWith( '%' ) ) return ( parseFloat( s ) / 100 ) * W;
	const n = parseFloat( s );
	return Number.isFinite( n ) ? n : NaN;
};

function fontSizeOf( attrs ) {
	if ( attrs[ 'font-size' ] ) return parseFloat( attrs[ 'font-size' ] );
	const m = /font-size\s*:\s*([\d.]+)/.exec( attrs.style || '' );
	return m ? parseFloat( m[ 1 ] ) : NaN;
}

/** SVG 안의 모든 <text>를 { content, x, y, size, anchor, transform, index, length, attrs } 목록으로 돌려준다. */
export function extractTexts( svg, W = 1600 ) {
	const out = [];
	TEXT_RE.lastIndex = 0;
	let m;
	while ( ( m = TEXT_RE.exec( svg ) ) ) {
		const attrs = parseAttrs( m[ 1 ] );
		const content = decodeEntities( m[ 2 ].replace( /<[^>]+>/g, '' ) ).replace( /\s+/g, ' ' ).trim();
		out.push( {
			content,
			x: num( String( attrs.x || '0' ).split( /[\s,]+/ )[ 0 ], W ) || 0,
			y: num( String( attrs.y || '0' ).split( /[\s,]+/ )[ 0 ], W ) || 0,
			size: fontSizeOf( attrs ),
			anchor: attrs[ 'text-anchor' ] || 'start',
			transform: attrs.transform || '',
			letterSpacing: parseFloat( attrs[ 'letter-spacing' ] ) || 0,
			index: m.index,
			length: m[ 0 ].length,
			openTagLength: m[ 0 ].indexOf( '>' ) + 1,
			attrs,
		} );
	}
	return out;
}

const nospace = ( s ) => String( s ).replace( /\s+/g, '' );

/** 같은 자리에 겹쳐 쌓은 동일 문구(글로우/그림자용)를 하나로 합친다. */
function dedupeStacks( texts ) {
	const seen = [];
	const kept = [];
	for ( const t of texts ) {
		const cell = Math.max( 6, ( Number.isFinite( t.size ) ? t.size : 20 ) * 0.25 );
		const dup = seen.find( ( s ) => s.key === nospace( t.content ) && Math.abs( s.x - t.x ) <= cell && Math.abs( s.y - t.y ) <= cell );
		if ( dup ) continue;
		seen.push( { key: nospace( t.content ), x: t.x, y: t.y } );
		kept.push( t );
	}
	return kept;
}

function countOccurrences( hay, needle ) {
	if ( ! needle ) return 0;
	let c = 0, i = 0;
	while ( ( i = hay.indexOf( needle, i ) ) !== -1 ) { c++; i += needle.length; }
	return c;
}

/**
 * 제목 검수.
 * @returns {{ok:boolean, issues:string[], count:number, texts:number}}
 */
export function auditTitle( svg, title, plan, W = 1600 ) {
	const issues = [];
	const texts = dedupeStacks( extractTexts( svg, W ).filter( ( t ) => t.content ) );
	if ( ! title ) {
		if ( texts.length ) issues.push( 'The brief has no headline, so the picture must contain no text at all.' );
		return { ok: ! issues.length, issues, count: 0, texts: texts.length };
	}

	const target = nospace( title );
	const joined = texts.map( ( t ) => nospace( t.content ) ).join( '' );
	let count = countOccurrences( joined, target );

	if ( count === 0 && plan && plan.lines && plan.lines.length ) {
		// 줄 순서가 섞여 있어도 줄 단위로 전부 존재하면 인정한다.
		const lineKeys = plan.lines.map( nospace );
		const present = lineKeys.every( ( k ) => texts.some( ( t ) => nospace( t.content ) === k ) );
		if ( present ) count = 1;
	}
	if ( count === 0 ) {
		issues.push( `The exact headline "${ title }" is missing or mis-spelled in the <text> elements. Copy it character by character (one <text> per line).` );
	} else if ( count > 1 ) {
		issues.push( 'The headline is printed more than once at different positions. It may appear only once (glow/shadow layers must use stroke on the same element, not copies).' );
	}
	if ( texts.length > 16 ) issues.push( 'Too many <text> elements; keep decorative text to a minimum.' );
	return { ok: ! issues.length, issues, count, texts: texts.length };
}

/** 제목이 없는 요청이면 모든 <text>를 제거한다. */
export function stripAllText( svg ) {
	return svg.replace( TEXT_RE, '' );
}

/**
 * 글자가 캔버스를 벗어나면 font-size를 줄여 맞춘다.
 * 회전/행렬 변환이 걸린 글자는 폭 계산이 부정확하므로 건드리지 않는다.
 * @returns {{svg:string, fixed:number, unfixable:string[]}}
 */
export function fitTextOverflow( svg, W, H ) {
	const texts = extractTexts( svg, W );
	if ( ! texts.length ) return { svg, fixed: 0, unfixable: [] };
	const margin = W * 0.025;
	let out = '';
	let cursor = 0;
	let fixed = 0;
	const unfixable = [];

	for ( const t of texts ) {
		out += svg.slice( cursor, t.index );
		let piece = svg.slice( t.index, t.index + t.length );
		cursor = t.index + t.length;

		const complex = /rotate|matrix|skew|scale/i.test( t.transform );
		const size = t.size;
		if ( ! complex && Number.isFinite( size ) && size > 0 && t.content ) {
			const chars = Array.from( t.content ).length;
			const width = textUnits( t.content ) * size + t.letterSpacing * Math.max( chars - 1, 0 );
			let allowed;
			if ( t.anchor === 'middle' ) allowed = 2 * Math.min( t.x - margin, W - margin - t.x );
			else if ( t.anchor === 'end' ) allowed = t.x - margin;
			else allowed = W - margin - t.x;

			if ( width > allowed + 1 ) {
				const factor = ( allowed / width ) * 0.97;
				const newSize = Math.floor( size * factor );
				if ( allowed <= 0 || newSize < size * 0.4 || newSize < 10 ) {
					unfixable.push( t.content.slice( 0, 24 ) );
				} else {
					const open = piece.slice( 0, t.openTagLength );
					let newOpen;
					if ( t.attrs[ 'font-size' ] ) {
						newOpen = open.replace( /font-size\s*=\s*("[^"]*"|'[^']*')/, `font-size="${ newSize }"` );
					} else {
						newOpen = open.replace( /(font-size\s*:\s*)[\d.]+/, `$1${ newSize }` );
					}
					if ( t.letterSpacing && /letter-spacing\s*=/.test( newOpen ) ) {
						newOpen = newOpen.replace( /letter-spacing\s*=\s*("[^"]*"|'[^']*')/, `letter-spacing="${ ( t.letterSpacing * factor ).toFixed( 2 ) }"` );
					}
					piece = newOpen + piece.slice( t.openTagLength );
					fixed++;
				}
			}
			// 세로: 캔버스 밖에 베이스라인이 있으면 보정 불가로 알린다.
			if ( t.y < size * 0.5 || t.y > H + size * 0.2 ) unfixable.push( `${ t.content.slice( 0, 24 ) } (y=${ Math.round( t.y ) })` );
		}
		out += piece;
	}
	out += svg.slice( cursor );
	return { svg: out, fixed, unfixable };
}
