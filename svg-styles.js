/**
 * svg-styles.js — "디자인 스타일" 6종 전용 SVG 합성기.
 *
 * svg-scene.js 의 composeSceneSvg 는 기존 5개 스타일(poster/minimal/photo_realistic/
 * typography/branding)을 같은 뼈대(배경 + 오브젝트 + 텍스트) 위에서 색·배경만 바꿔 그린다.
 * 이 파일의 스타일들은 그 뼈대 자체가 서로 다르다. 같은 주제라도
 *
 *   gradient    — 어두운 바탕 위에 오로라 메시 그라디언트 + 유리(글래스모피즘) 카드
 *   infographic — 상단 헤더 + 번호 카드 + 미니 차트가 있는 정보 전달형 레이아웃
 *   isometric   — 등각(30°) 투영 플랫폼·큐브·막대 위에 오브젝트가 서 있는 3D 느낌
 *   neon        — 검은 배경, 네온 글로우 링·원근 그리드 바닥·발광 텍스트
 *   papercut    — 겹겹이 쌓인 종이 물결 + 종이 원판 + 종이 라벨(드롭 섀도)
 *   blueprint   — 청사진 방안 + 치수선·지시선·도면 표제란
 *
 * 처럼 배경, 구도, 텍스트 처리, 장식 언어가 모두 달라 한눈에 구분된다.
 *
 * 공통 규칙(기존 씬 합성기와 동일):
 *   - 주제 매칭: plan.hero / plan.supports (planScene 결과)의 벡터 오브젝트를 그대로 사용한다.
 *   - 필터(blur 등) 미사용 — 그라디언트·반투명 도형·겹침으로만 표현해 resvg CPU를 낮춘다.
 *   - 제목은 opts.topic, 부제는 opts.subtitle(= 표시용 부제)만 그린다. 조사용 설명문은 그리지 않는다.
 *   - 결과는 항상 well-formed SVG 문자열이다.
 */

import { OBJECTS, makePalette, hslToHex, lighten, darken } from './svg-objects.js';
import { escapeXml } from './svg-safe.js';
import { fitText, toRenderable, hashString, mulberry32, hueFromText, FONT } from './svg-scene.js';

export const STYLED_KEYS = [ 'gradient', 'infographic', 'isometric', 'neon', 'papercut', 'blueprint' ];

const f = ( v ) => Number( v ).toFixed( 1 );
const hs = ( h, s, l ) => hslToHex( h, s, l );
const clamp = ( v, a, b ) => Math.min( Math.max( v, a ), b );

// ──────────────────────────────────────────────────────────────
// 공통 컨텍스트 / 배치 / 텍스트
// ──────────────────────────────────────────────────────────────
function makeCtx( plan, opts ) {
	const { style, width: W, height: H } = opts;
	const topic = toRenderable( opts.topic );
	const subtitle = toRenderable( opts.subtitle );
	const promptText = toRenderable( opts.prompt );
	const title = topic || subtitle;
	const sub = topic ? subtitle : '';
	const heroDef = OBJECTS[ plan.hero ] || OBJECTS.bulb;
	const rand = mulberry32( hashString( `${ topic }|${ subtitle }|${ promptText }|${ style }` ) );
	const namedHue = hueFromText( `${ promptText } ${ topic } ${ subtitle }` );
	const hueShift = Math.round( ( rand() - 0.5 ) * 50 );
	const hue = namedHue !== null ? namedHue : heroDef.hue + hueShift;
	let counter = 0;
	const ctx = {
		style, W, H, title, sub, noText: ! title, plan, heroDef, rand, hue,
		P: makePalette( hue ),
		portrait: W / H < 1.15,
		defs: [], layers: [],
		u: ( name ) => `${ name }${ ++counter }`,
		shadowAlpha: 0.3,
	};
	ctx.supports = ( plan.supports || [] ).filter( ( k ) => OBJECTS[ k ] ).slice( 0, 3 );
	return ctx;
}

/** 오브젝트 하나를 (x, y)에 크기 s(정사각 박스)로 배치한다. 접지 그림자 포함. */
function makePlacer( ctx ) {
	const { W, defs, u, plan, hue } = ctx;
	const shadowId = u( 'shd' );
	defs.push( `<radialGradient id="${ shadowId }"><stop offset="0" stop-color="#000" stop-opacity="${ ctx.shadowAlpha }"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` );
	return ( key, x, y, s, rot = 0, o = {} ) => {
		const def = OBJECTS[ key ];
		if ( ! def ) return '';
		x = clamp( x, s * 0.52 + W * 0.01, W - s * 0.52 - W * 0.01 );
		const pal = makePalette( key === plan.hero ? hue : def.hue );
		const { defs: d, body } = def.draw( pal, u );
		defs.push( d );
		const out = [];
		if ( o.shadow !== false ) {
			out.push( def.floating
				? `<ellipse cx="${ f( x ) }" cy="${ f( y + s * 0.62 ) }" rx="${ f( s * 0.3 ) }" ry="${ f( s * 0.04 ) }" fill="url(#${ shadowId })" opacity="0.6"/>`
				: `<ellipse cx="${ f( x ) }" cy="${ f( y + s * 0.5 ) }" rx="${ f( s * 0.46 ) }" ry="${ f( s * 0.065 ) }" fill="url(#${ shadowId })"/>` );
		}
		out.push( `<g transform="translate(${ f( x ) } ${ f( y ) }) rotate(${ f( rot ) }) scale(${ ( s / 100 ).toFixed( 4 ) })">${ body }</g>` );
		return out.join( '' );
	};
}

/** 제목/부제 줄바꿈·크기 계산. 실제 그리기는 각 스타일이 한다. */
function layoutText( ctx, { w, startRatio = 0.088, minRatio = 0.04, maxLines = 3, subMaxLines = 2 } ) {
	const { H, title, sub } = ctx;
	const t = fitText( title, w, maxLines, Math.round( H * startRatio ), Math.round( H * minRatio ) );
	const tLead = t.size * 1.22;
	const s = sub ? fitText( sub, w, subMaxLines, Math.round( t.size * 0.5 ), Math.round( H * 0.026 ) ) : null;
	const sLead = s ? s.size * 1.45 : 0;
	const gap = s ? t.size * 0.35 : 0;
	const blockH = t.lines.length * tLead + gap + ( s ? s.lines.length * sLead : 0 );
	return { t, s, tLead, sLead, gap, blockH };
}

/** 왼쪽 정렬 텍스트 줄들을 만든다. lineFn(text, x, y, size, kind) 이 각 줄의 SVG 문자열을 돌려준다. */
function emitText( L, x, centerY, lineFn ) {
	const out = [];
	let y = centerY - L.blockH / 2 + L.t.size * 0.95;
	L.t.lines.forEach( ( line, i ) => out.push( lineFn( line, x, y + i * L.tLead, L.t.size, 'title' ) ) );
	y += ( L.t.lines.length - 1 ) * L.tLead;
	if ( L.s ) {
		y += L.gap + L.s.size * 0.95 + L.t.size * 0.3;
		L.s.lines.forEach( ( line, i ) => out.push( lineFn( line, x, y + i * L.sLead, L.s.size, 'sub' ) ) );
	}
	return out.join( '' );
}

function baseLayout( ctx, { heroScale = 1, heroX = 0.72, heroY = 0.5, textW = 0.44 } = {} ) {
	const { W, H, portrait, noText } = ctx;
	if ( noText ) {
		return { heroS: portrait ? Math.min( W * 0.78, H * 0.6 ) : Math.min( W * 0.42, H * 0.74 ) * heroScale, cx: W * 0.5, cy: H * 0.5, textX: 0, textW: 0, textCY: H * 0.5 };
	}
	if ( portrait ) {
		return { heroS: Math.min( W * 0.66, H * 0.42 ) * heroScale, cx: W * 0.5, cy: H * 0.33, textX: W * 0.08, textW: W * 0.84, textCY: H * 0.76 };
	}
	return { heroS: Math.min( W * 0.32, H * 0.62 ) * heroScale, cx: W * heroX, cy: H * heroY, textX: W * 0.07, textW: W * textW, textCY: H * 0.5 };
}

function svgWrap( ctx, extraDesc = '' ) {
	const { W, H, title, heroDef, style, defs, layers } = ctx;
	const label = escapeXml( title || heroDef.label );
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ W }" height="${ H }" viewBox="0 0 ${ W } ${ H }" role="img" aria-label="${ label }">
<title>${ label }</title>
<desc>${ escapeXml( `${ heroDef.label } · ${ style }${ extraDesc }` ) }</desc>
<defs>${ defs.join( '' ) }</defs>
${ layers.join( '\n' ) }
</svg>`;
}

const RG = ( id, cx, cy, r, color, a0, a1 = 0 ) =>
	`<radialGradient id="${ id }" gradientUnits="userSpaceOnUse" cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( r ) }"><stop offset="0" stop-color="${ color }" stop-opacity="${ a0 }"/><stop offset="1" stop-color="${ color }" stop-opacity="${ a1 }"/></radialGradient>`;
const LG = ( id, x1, y1, x2, y2, stops, units = 'userSpaceOnUse' ) =>
	`<linearGradient id="${ id }" gradientUnits="${ units }" x1="${ x1 }" y1="${ y1 }" x2="${ x2 }" y2="${ y2 }">${ stops.map( ( [ o, c, a ] ) => `<stop offset="${ o }" stop-color="${ c }"${ a !== undefined ? ` stop-opacity="${ a }"` : '' }/>` ).join( '' ) }</linearGradient>`;

// ──────────────────────────────────────────────────────────────
// 1) GRADIENT — 오로라 메시 + 글래스 카드
// ──────────────────────────────────────────────────────────────
function composeGradient( ctx ) {
	const { W, H, defs, layers, u, rand, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	const L = baseLayout( ctx, { heroScale: 0.92, heroX: 0.73 } );
	const { cx, cy, heroS } = L;
	const h1 = hue, h2 = hue + 58, h3 = hue - 48, h4 = hue + 135;

	const bg = u( 'bg' );
	defs.push( LG( bg, 0, 0, W, H, [ [ 0, hs( h1, 62, 13 ) ], [ 1, hs( h2, 66, 24 ) ] ] ) );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bg })"/>` );

	const blobs = [
		[ W * 0.12, H * 0.08, W * 0.58, hs( h1, 96, 58 ), 0.95 ],
		[ W * 0.92, H * 0.18, W * 0.5, hs( h2, 96, 62 ), 0.9 ],
		[ W * 0.78, H * 1.02, W * 0.62, hs( h3, 96, 60 ), 0.92 ],
		[ W * 0.08, H * 0.98, W * 0.42, hs( h4, 92, 62 ), 0.8 ],
		[ cx, cy, heroS * 1.25, hs( h2 + 24, 100, 72 ), 0.5 ],
	];
	blobs.forEach( ( [ x, y, r, c, a ] ) => {
		const id = u( 'mesh' );
		defs.push( RG( id, x, y, r, c, a ) );
		layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ id })"/>` );
	} );

	// 은은한 곡선 리본
	layers.push( `<path d="M${ f( -W * 0.05 ) } ${ f( H * 0.78 ) } C${ f( W * 0.25 ) } ${ f( H * 0.5 ) } ${ f( W * 0.55 ) } ${ f( H * 1.02 ) } ${ f( W * 1.05 ) } ${ f( H * 0.6 ) }" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="${ f( H * 0.006 ) }"/>` );
	layers.push( `<path d="M${ f( -W * 0.05 ) } ${ f( H * 0.86 ) } C${ f( W * 0.3 ) } ${ f( H * 0.6 ) } ${ f( W * 0.6 ) } ${ f( H * 1.05 ) } ${ f( W * 1.05 ) } ${ f( H * 0.7 ) }" fill="none" stroke="#fff" stroke-opacity="0.10" stroke-width="${ f( H * 0.004 ) }"/>` );

	// 글래스 카드 (오브젝트 뒤)
	const gl = u( 'glass' ), glEdge = u( 'gedge' );
	defs.push( LG( gl, cx - heroS, cy - heroS, cx + heroS, cy + heroS, [ [ 0, '#ffffff', 0.34 ], [ 1, '#ffffff', 0.07 ] ] ) );
	defs.push( LG( glEdge, cx - heroS, cy - heroS, cx + heroS, cy + heroS, [ [ 0, '#ffffff', 0.85 ], [ 0.5, '#ffffff', 0.15 ], [ 1, '#ffffff', 0.5 ] ] ) );
	const cardS = heroS * 1.42;
	layers.push( `<rect x="${ f( cx - cardS / 2 ) }" y="${ f( cy - cardS / 2 ) }" width="${ f( cardS ) }" height="${ f( cardS ) }" rx="${ f( cardS * 0.2 ) }" fill="url(#${ gl })" stroke="url(#${ glEdge })" stroke-width="2.5"/>` );
	layers.push( `<path d="M${ f( cx - cardS * 0.42 ) } ${ f( cy - cardS * 0.34 ) } Q${ f( cx - cardS * 0.3 ) } ${ f( cy - cardS * 0.46 ) } ${ f( cx - cardS * 0.08 ) } ${ f( cy - cardS * 0.47 ) }" fill="none" stroke="#fff" stroke-opacity="0.7" stroke-width="${ f( Math.max( 3, H * 0.006 ) ) }" stroke-linecap="round"/>` );

	// 조연: 작은 글래스 오브(구슬)
	const orbs = ctx.supports.slice( 0, 2 );
	const orbPos = portrait ? [ [ -0.52, -0.42, 0.34 ], [ 0.52, -0.42, 0.34 ] ] : [ [ -0.66, 0.5, 0.4 ], [ 0.66, -0.46, 0.34 ] ];
	orbs.forEach( ( k, i ) => {
		const [ ox, oy, os ] = orbPos[ i ];
		const r = heroS * os * 0.72;
		const ocx = clamp( cx + cardS * ox * 0.85, r + 6, W - r - 6 ), ocy = clamp( cy + cardS * oy * 0.85, r + 6, H - r - 6 );
		const og = u( 'orb' );
		defs.push( RG( og, ocx - r * 0.3, ocy - r * 0.35, r * 1.3, '#ffffff', 0.55, 0.08 ) );
		layers.push( `<circle cx="${ f( ocx ) }" cy="${ f( ocy ) }" r="${ f( r ) }" fill="url(#${ og })" stroke="#fff" stroke-opacity="0.6" stroke-width="2"/>` );
		layers.push( place( k, ocx, ocy - r * 0.04, r * 1.25, ( i ? 1 : -1 ) * 5, { shadow: false } ) );
	} );

	layers.push( place( ctx.plan.hero, cx, cy, heroS, ( rand() - 0.5 ) * 6 ) );

	// 반짝이는 입자
	for ( let i = 0; i < 16; i++ ) {
		layers.push( `<circle cx="${ f( rand() * W ) }" cy="${ f( rand() * H ) }" r="${ f( 1.5 + rand() * 4 ) }" fill="#fff" opacity="${ ( 0.25 + rand() * 0.55 ).toFixed( 2 ) }"/>` );
	}

	if ( ! noText ) {
		const T = layoutText( ctx, { w: L.textW, startRatio: portrait ? 0.058 : 0.092 } );
		const acc = u( 'pill' );
		defs.push( LG( acc, L.textX, 0, L.textX + W * 0.08, 0, [ [ 0, '#ffffff', 0.95 ], [ 1, '#ffffff', 0 ] ] ) );
		layers.push( `<rect x="${ f( L.textX ) }" y="${ f( L.textCY - T.blockH / 2 - H * 0.05 ) }" width="${ f( W * 0.08 ) }" height="${ f( Math.max( 6, H * 0.011 ) ) }" rx="${ f( H * 0.006 ) }" fill="url(#${ acc })"/>` );
		layers.push( emitText( T, L.textX, L.textCY, ( line, x, y, size, kind ) =>
			kind === 'title'
				? `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="#ffffff">${ escapeXml( line ) }</text>`
				: `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="#ffffff" opacity="0.86">${ escapeXml( line ) }</text>` ) );
	}
}

// ──────────────────────────────────────────────────────────────
// 2) INFOGRAPHIC — 헤더 + 히어로 서클 + 번호 카드/미니 차트
// ──────────────────────────────────────────────────────────────
function miniViz( kind, x, y, w, h, color, alt ) {
	// 숫자·라벨 없이 형태만 있는 장식용 미니 차트(가짜 통계를 만들지 않는다)
	if ( kind === 0 ) {
		const n = 5, bw = w / ( n * 1.6 );
		return [ 0.45, 0.7, 0.55, 0.9, 0.75 ].map( ( r, i ) => `<rect x="${ f( x + i * bw * 1.6 ) }" y="${ f( y + h * ( 1 - r ) ) }" width="${ f( bw ) }" height="${ f( h * r ) }" rx="${ f( bw * 0.25 ) }" fill="${ i === 3 ? alt : color }"/>` ).join( '' );
	}
	if ( kind === 1 ) {
		const r = h * 0.48, cxx = x + r + 4, cyy = y + h / 2, C = 2 * Math.PI * r;
		return `<circle cx="${ f( cxx ) }" cy="${ f( cyy ) }" r="${ f( r ) }" fill="none" stroke="${ color }" stroke-opacity="0.2" stroke-width="${ f( h * 0.2 ) }"/>` +
			`<circle cx="${ f( cxx ) }" cy="${ f( cyy ) }" r="${ f( r ) }" fill="none" stroke="${ alt }" stroke-width="${ f( h * 0.2 ) }" stroke-linecap="round" stroke-dasharray="${ f( C * 0.68 ) } ${ f( C ) }" transform="rotate(-90 ${ f( cxx ) } ${ f( cyy ) })"/>` +
			`<rect x="${ f( cxx + r + h * 0.35 ) }" y="${ f( cyy - h * 0.16 ) }" width="${ f( w - r * 2 - h * 0.5 ) }" height="${ f( h * 0.12 ) }" rx="${ f( h * 0.06 ) }" fill="${ color }" opacity="0.5"/>` +
			`<rect x="${ f( cxx + r + h * 0.35 ) }" y="${ f( cyy + h * 0.08 ) }" width="${ f( ( w - r * 2 - h * 0.5 ) * 0.6 ) }" height="${ f( h * 0.12 ) }" rx="${ f( h * 0.06 ) }" fill="${ color }" opacity="0.3"/>`;
	}
	// 진행 막대 3줄
	return [ 0.9, 0.62, 0.78 ].map( ( r, i ) => {
		const yy = y + i * h / 3 + h * 0.06;
		return `<rect x="${ f( x ) }" y="${ f( yy ) }" width="${ f( w ) }" height="${ f( h * 0.16 ) }" rx="${ f( h * 0.08 ) }" fill="${ color }" opacity="0.16"/>` +
			`<rect x="${ f( x ) }" y="${ f( yy ) }" width="${ f( w * r ) }" height="${ f( h * 0.16 ) }" rx="${ f( h * 0.08 ) }" fill="${ i === 0 ? alt : color }"/>`;
	} ).join( '' );
}

function composeInfographic( ctx ) {
	const { W, H, defs, layers, u, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	ctx.shadowAlpha = 0.18;
	const c1 = hs( hue, 70, 46 ), cDark = hs( hue, 62, 30 ), cAcc = hs( hue + 165, 82, 52 ), cSoft = hs( hue, 60, 94 );
	const paper = hs( hue, 28, 97 );

	const bg = u( 'bg' ), dots = u( 'dots' ), hd = u( 'hd' );
	defs.push( LG( bg, 0, 0, 0, H, [ [ 0, paper ], [ 1, hs( hue, 30, 92 ) ] ] ) );
	defs.push( `<pattern id="${ dots }" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="14" cy="14" r="1.8" fill="${ c1 }" opacity="0.16"/></pattern>` );
	defs.push( LG( hd, 0, 0, W, 0, [ [ 0, cDark ], [ 1, c1 ] ] ) );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bg })"/>` );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ dots })"/>` );

	// 헤더
	const headH = noText ? H * 0.12 : ( portrait ? H * 0.24 : H * 0.29 );
	layers.push( `<rect x="0" y="0" width="${ W }" height="${ f( headH ) }" fill="url(#${ hd })"/>` );
	layers.push( `<circle cx="${ f( W * 0.94 ) }" cy="${ f( headH * 0.2 ) }" r="${ f( headH * 0.9 ) }" fill="#fff" opacity="0.07"/>` );
	layers.push( `<circle cx="${ f( W * 0.86 ) }" cy="${ f( headH * 1.0 ) }" r="${ f( headH * 0.5 ) }" fill="#fff" opacity="0.06"/>` );
	layers.push( `<rect x="0" y="${ f( headH ) }" width="${ W }" height="${ f( Math.max( 5, H * 0.008 ) ) }" fill="${ cAcc }"/>` );

	if ( ! noText ) {
		const tx = W * 0.05, tw = W * 0.9;
		const T = layoutText( ctx, { w: tw, startRatio: portrait ? 0.05 : 0.08, minRatio: 0.036, maxLines: 2, subMaxLines: 1 } );
		layers.push( emitText( T, tx, headH / 2, ( line, x, y, size, kind ) =>
			kind === 'title'
				? `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="#ffffff">${ escapeXml( line ) }</text>`
				: `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="#ffffff" opacity="0.85">${ escapeXml( line ) }</text>` ) );
	}

	// 본문 영역
	const bodyTop = headH + H * 0.05, bodyBot = H * 0.95;
	const bodyH = bodyBot - bodyTop;
	const cards = ctx.supports.length ? ctx.supports.slice( 0, 3 ) : [ ctx.plan.hero ];
	const n = cards.length;

	let heroCx, heroCy, heroR, cardsX, cardsY, cardsW, cardsH;
	if ( portrait ) {
		heroR = Math.min( W * 0.3, bodyH * 0.26 );
		heroCx = W * 0.5; heroCy = bodyTop + heroR * 1.02;
		cardsX = W * 0.06; cardsW = W * 0.88;
		cardsY = heroCy + heroR + H * 0.05; cardsH = bodyBot - cardsY;
	} else {
		heroR = Math.min( bodyH * 0.43, W * 0.16 );
		heroCx = W * 0.05 + heroR * 1.08; heroCy = bodyTop + bodyH * 0.47;
		cardsX = heroCx + heroR + W * 0.06; cardsW = W * 0.95 - cardsX;
		cardsY = bodyTop + bodyH * 0.04; cardsH = bodyH * 0.92;
	}

	// 히어로 서클 (링 + 도트 링)
	const hg = u( 'hg' );
	defs.push( RG( hg, heroCx, heroCy - heroR * 0.2, heroR * 1.1, '#ffffff', 1, 1 ) );
	layers.push( `<circle cx="${ f( heroCx ) }" cy="${ f( heroCy ) }" r="${ f( heroR * 1.12 ) }" fill="none" stroke="${ c1 }" stroke-opacity="0.35" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>` );
	layers.push( `<circle cx="${ f( heroCx ) }" cy="${ f( heroCy ) }" r="${ f( heroR ) }" fill="#ffffff" stroke="${ c1 }" stroke-width="${ f( Math.max( 4, H * 0.008 ) ) }"/>` );
	layers.push( `<circle cx="${ f( heroCx ) }" cy="${ f( heroCy ) }" r="${ f( heroR * 0.86 ) }" fill="${ cSoft }"/>` );
	layers.push( place( ctx.plan.hero, heroCx, heroCy - heroR * 0.04, heroR * 1.32, 0, { shadow: false } ) );
	// 히어로 라벨 태그
	const heroLabel = escapeXml( ctx.heroDef.label );
	const tagW = Math.max( heroR * 1.1, heroLabel.length * H * 0.03 + H * 0.05 ), tagH = H * 0.06;
	layers.push( `<rect x="${ f( heroCx - tagW / 2 ) }" y="${ f( heroCy + heroR - tagH * 0.5 ) }" width="${ f( tagW ) }" height="${ f( tagH ) }" rx="${ f( tagH / 2 ) }" fill="${ cAcc }"/>` );
	layers.push( `<text x="${ f( heroCx ) }" y="${ f( heroCy + heroR + tagH * 0.17 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( tagH * 0.5 ) }" font-weight="700" fill="#ffffff">${ heroLabel }</text>` );

	// 번호 카드
	const gap = ( portrait ? W : cardsW ) * 0.025;
	const colW = portrait ? ( cardsW - gap * ( n - 1 ) ) / n : ( cardsW - gap * ( n - 1 ) ) / n;
	cards.forEach( ( key, i ) => {
		const x = cardsX + i * ( colW + gap ), y = cardsY, w = colW, h = cardsH;
		// 히어로 서클 → 카드 연결선
		if ( ! portrait && i === 0 ) {
			layers.push( `<path d="M${ f( heroCx + heroR * 1.12 ) } ${ f( heroCy ) } H${ f( x ) }" stroke="${ c1 }" stroke-width="3" stroke-dasharray="6 8" opacity="0.6"/>` );
			layers.push( `<path d="M${ f( x - 14 ) } ${ f( heroCy - 9 ) } L${ f( x ) } ${ f( heroCy ) } L${ f( x - 14 ) } ${ f( heroCy + 9 ) }" fill="none" stroke="${ c1 }" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` );
		}
		layers.push( `<rect x="${ f( x + 3 ) }" y="${ f( y + 8 ) }" width="${ f( w ) }" height="${ f( h ) }" rx="${ f( H * 0.026 ) }" fill="${ cDark }" opacity="0.12"/>` );
		layers.push( `<rect x="${ f( x ) }" y="${ f( y ) }" width="${ f( w ) }" height="${ f( h ) }" rx="${ f( H * 0.026 ) }" fill="#ffffff" stroke="${ c1 }" stroke-opacity="0.25" stroke-width="2"/>` );
		layers.push( `<rect x="${ f( x ) }" y="${ f( y ) }" width="${ f( w ) }" height="${ f( Math.max( 8, H * 0.012 ) ) }" rx="4" fill="${ i % 2 ? cAcc : c1 }"/>` );
		// 번호 배지
		const br = Math.min( w * 0.13, H * 0.05 );
		layers.push( `<circle cx="${ f( x + br * 1.5 ) }" cy="${ f( y + br * 1.75 ) }" r="${ f( br ) }" fill="${ i % 2 ? cAcc : c1 }"/>` );
		layers.push( `<text x="${ f( x + br * 1.5 ) }" y="${ f( y + br * 1.75 + br * 0.36 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( br * 1.0 ) }" font-weight="800" fill="#fff">${ i + 1 }</text>` );
		// 아이콘
		const isz = Math.min( w * 0.62, h * 0.4 );
		const icy = y + h * 0.42;
		layers.push( `<circle cx="${ f( x + w / 2 ) }" cy="${ f( icy ) }" r="${ f( isz * 0.6 ) }" fill="${ cSoft }"/>` );
		layers.push( place( key, x + w / 2, icy - isz * 0.02, isz, 0, { shadow: false } ) );
		// 라벨 + 미니 차트
		const lab = escapeXml( OBJECTS[ key ].label );
		const lsz = Math.min( h * 0.07, w * 0.13 );
		layers.push( `<text x="${ f( x + w / 2 ) }" y="${ f( y + h * 0.75 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( lsz ) }" font-weight="700" fill="${ cDark }">${ lab }</text>` );
		layers.push( miniViz( ( i + hueIdx( hue ) ) % 3, x + w * 0.14, y + h * 0.8, w * 0.72, h * 0.14, c1, cAcc ) );
	} );
}
const hueIdx = ( h ) => Math.abs( Math.round( h ) ) % 3;

// ──────────────────────────────────────────────────────────────
// 3) ISOMETRIC — 등각 투영 플랫폼/큐브/막대
// ──────────────────────────────────────────────────────────────
const COS30 = Math.cos( Math.PI / 6 ), SIN30 = 0.5;

/** 바닥 중심 (gx, gy), 한 변 길이 a, 높이 h 의 등각 큐브(3면). 슬랩은 h 를 작게 준다. */
function isoBox( gx, gy, a, h, top, left, right, stroke ) {
	const dx = a * COS30, dy = a * SIN30;
	const P = ( x, y ) => `${ f( x ) } ${ f( y ) }`;
	const T = ( yo ) => [ [ gx, gy - dy + yo ], [ gx + dx, gy + yo ], [ gx, gy + dy + yo ], [ gx - dx, gy + yo ] ];
	const b = T( 0 ), t = T( -h );
	const st = stroke ? ` stroke="${ stroke }" stroke-width="1.5" stroke-linejoin="round"` : '';
	return `<path d="M${ P( ...t[ 3 ] ) } L${ P( ...b[ 3 ] ) } L${ P( ...b[ 2 ] ) } L${ P( ...t[ 2 ] ) } Z" fill="${ left }"${ st }/>` +
		`<path d="M${ P( ...t[ 2 ] ) } L${ P( ...b[ 2 ] ) } L${ P( ...b[ 1 ] ) } L${ P( ...t[ 1 ] ) } Z" fill="${ right }"${ st }/>` +
		`<path d="M${ P( ...t[ 0 ] ) } L${ P( ...t[ 1 ] ) } L${ P( ...t[ 2 ] ) } L${ P( ...t[ 3 ] ) } Z" fill="${ top }"${ st }/>`;
}

function composeIsometric( ctx ) {
	const { W, H, defs, layers, u, rand, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	ctx.shadowAlpha = 0.22;
	const L = baseLayout( ctx, { heroScale: 1.0, heroX: 0.7, heroY: 0.46 } );
	const cx = L.cx, heroS = L.heroS;

	const bg = u( 'bg' );
	defs.push( LG( bg, 0, 0, W, H, [ [ 0, hs( hue, 62, 95 ) ], [ 1, hs( hue + 32, 58, 86 ) ] ] ) );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bg })"/>` );
	// 배경 큰 등각 격자 무늬(아주 옅게)
	let grid = '';
	const step = H * 0.11;
	for ( let i = -12; i < 28; i++ ) {
		const x0 = i * step * COS30 * 2;
		grid += `M${ f( x0 ) } 0 L${ f( x0 + H * 1.732 ) } ${ f( H ) } M${ f( x0 + H * 1.732 ) } 0 L${ f( x0 ) } ${ f( H ) } `;
	}
	layers.push( `<path d="${ grid }" stroke="${ hs( hue, 50, 60 ) }" stroke-opacity="0.09" stroke-width="1.5" fill="none"/>` );

	const A = heroS * 0.78;                       // 플랫폼 한 변
	const slab = A * 0.14;
	const topY = L.cy + heroS * 0.3;              // 플랫폼 윗면 중심 y
	const gy = topY + slab;
	const dx = A * COS30, dy = A * SIN30;
	const t1 = hs( hue, 55, 92 ), l1 = hs( hue, 55, 70 ), r1 = hs( hue, 58, 58 );
	const acc = hs( hue + 165, 78, 60 );
	const boxC = ( base, l ) => [ hs( base, 72, 68 + l ), hs( base, 68, 52 + l ), hs( base, 70, 40 + l ) ];
	// 윗면 좌표(u: 오른쪽 아래 축, v: 왼쪽 아래 축, 각각 -0.5..0.5)
	const G = ( uu, vv ) => [ cx + ( uu - vv ) * dx, topY + ( uu + vv ) * dy ];

	// 플랫폼 그림자 + 슬랩 + 타일 라인
	const sh = u( 'psh' );
	defs.push( RG( sh, cx, gy + slab * 0.6, A * 1.3, '#000000', 0.22 ) );
	layers.push( `<ellipse cx="${ f( cx + A * 0.12 ) }" cy="${ f( gy + slab * 0.7 ) }" rx="${ f( A * 1.3 ) }" ry="${ f( A * 0.55 ) }" fill="url(#${ sh })"/>` );
	layers.push( isoBox( cx, gy, A, slab, t1, l1, r1 ) );
	let tiles = '';
	for ( let i = 1; i < 4; i++ ) {
		const k = i / 4;
		tiles += `M${ f( cx - dx + dx * k ) } ${ f( topY - dy * k ) } L${ f( cx + dx * k ) } ${ f( topY + dy - dy * k ) } M${ f( cx + dx * k ) } ${ f( topY - dy + dy * k ) } L${ f( cx - dx + dx * k ) } ${ f( topY + dy * k ) } `;
	}
	layers.push( `<path d="${ tiles }" stroke="${ hs( hue, 45, 76 ) }" stroke-width="2" fill="none"/>` );

	// 깊이(u+v) 순으로 그려 앞뒤가 자연스럽게 겹치게 한다.
	const items = [];
	const hp = G( 0, 0 );
	const heroSize = heroS * 0.72;
	items.push( { d: 0, svg: place( ctx.plan.hero, hp[ 0 ], hp[ 1 ] - heroSize * 0.5 + heroSize * 0.04, heroSize, ( rand() - 0.5 ) * 2 ) } );
	// 뒤쪽 큐브 스택
	const bk = G( -0.3, -0.12 );
	items.push( { d: -0.42, svg: isoBox( bk[ 0 ], bk[ 1 ], A * 0.2, A * 0.22, ...boxC( hue + 20, 6 ) ) + isoBox( bk[ 0 ], bk[ 1 ] - A * 0.22, A * 0.13, A * 0.14, ...boxC( hue - 30, 8 ) ) } );
	// 앞쪽 막대 3개
	[ [ 0.3, 0.16, 0.16 ], [ 0.4, -0.02, 0.26 ], [ 0.18, 0.34, 0.2 ] ].forEach( ( [ uu, vv, hh ], i ) => {
		const g = G( uu, vv );
		const cs = i === 1 ? boxC( hue + 165, 0 ) : boxC( hue + 40, 2 );
		items.push( { d: uu + vv, svg: isoBox( g[ 0 ], g[ 1 ], A * 0.15, A * hh * 1.5, ...cs ) } );
	} );
	// 조연: 플랫폼 위에 직접
	const supPos = [ [ -0.36, 0.34 ], [ 0.36, -0.34 ] ];
	ctx.supports.slice( 0, 2 ).forEach( ( k, i ) => {
		const g = G( ...supPos[ i ] ), ss = A * 0.3;
		items.push( { d: supPos[ i ][ 0 ] + supPos[ i ][ 1 ], svg: place( k, g[ 0 ], g[ 1 ] - ss * 0.5 + ss * 0.03, ss, 0 ) } );
	} );
	items.sort( ( p, q ) => p.d - q.d ).forEach( ( it ) => layers.push( it.svg ) );

	// 떠 있는 작은 다이아몬드/원
	for ( let i = 0; i < 5; i++ ) {
		const x = cx + ( rand() - 0.5 ) * A * 2.4, y = H * ( 0.1 + rand() * 0.22 );
		const r = H * ( 0.012 + rand() * 0.02 );
		layers.push( i % 2
			? `<path d="M${ f( x ) } ${ f( y - r ) } L${ f( x + r ) } ${ f( y ) } L${ f( x ) } ${ f( y + r ) } L${ f( x - r ) } ${ f( y ) } Z" fill="${ acc }" opacity="0.85"/>`
			: `<circle cx="${ f( x ) }" cy="${ f( y ) }" r="${ f( r * 0.7 ) }" fill="none" stroke="${ hs( hue, 60, 45 ) }" stroke-width="3" opacity="0.6"/>` );
	}

	if ( ! noText ) {
		const T = layoutText( ctx, { w: L.textW, startRatio: portrait ? 0.056 : 0.088 } );
		const dark = hs( hue, 55, 16 );
		layers.push( `<rect x="${ f( L.textX ) }" y="${ f( L.textCY - T.blockH / 2 - H * 0.055 ) }" width="${ f( W * 0.06 ) }" height="${ f( Math.max( 6, H * 0.011 ) ) }" rx="3" fill="${ acc }"/>` );
		layers.push( emitText( T, L.textX, L.textCY, ( line, x, y, size, kind ) =>
			kind === 'title'
				? `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="${ dark }">${ escapeXml( line ) }</text>`
				: `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="${ hs( hue, 45, 30 ) }" opacity="0.9">${ escapeXml( line ) }</text>` ) );
	}
}

// ──────────────────────────────────────────────────────────────
// 4) NEON — 검은 배경, 글로우 링, 원근 그리드, 발광 텍스트
// ──────────────────────────────────────────────────────────────
function glowStrokes( shapeFn, color, widths = [ 26, 16, 9 ], alphas = [ 0.07, 0.14, 0.3 ] ) {
	return widths.map( ( w, i ) => shapeFn( color, w, alphas[ i ] ) ).join( '' );
}

function composeNeon( ctx ) {
	const { W, H, defs, layers, u, rand, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	ctx.shadowAlpha = 0.6;
	const L = baseLayout( ctx, { heroScale: 0.9, heroX: 0.73, heroY: 0.47 } );
	const { cx, cy, heroS } = L;
	const nA = hs( hue, 100, 60 ), nB = hs( hue + 145, 100, 62 );
	const horizon = H * 0.68;

	const bg = u( 'bg' );
	defs.push( LG( bg, 0, 0, 0, H, [ [ 0, hs( hue + 230, 55, 4 ) ], [ 0.7, hs( hue + 230, 50, 8 ) ], [ 1, hs( hue + 200, 55, 12 ) ] ] ) );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bg })"/>` );

	// 별
	for ( let i = 0; i < 40; i++ ) {
		layers.push( `<circle cx="${ f( rand() * W ) }" cy="${ f( rand() * horizon * 0.95 ) }" r="${ f( 0.8 + rand() * 1.8 ) }" fill="#fff" opacity="${ ( 0.2 + rand() * 0.6 ).toFixed( 2 ) }"/>` );
	}
	// 히어로 뒤 후광
	const halo = u( 'halo' ), halo2 = u( 'halo' );
	defs.push( RG( halo, cx, cy, heroS * 1.5, nA, 0.42 ) );
	defs.push( RG( halo2, W * 0.2, H * 0.9, W * 0.5, nB, 0.28 ) );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ halo })"/>` );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ halo2 })"/>` );

	// 원근 그리드 바닥
	const gf = u( 'gf' );
	defs.push( LG( gf, 0, horizon, 0, H, [ [ 0, nB, 0 ], [ 0.25, nB, 0.55 ], [ 1, nB, 0.95 ] ] ) );
	let gridPath = '';
	const vx = W * 0.5;
	for ( let i = -14; i <= 14; i++ ) gridPath += `M${ f( vx + i * W * 0.012 ) } ${ f( horizon ) } L${ f( vx + i * W * 0.11 ) } ${ f( H ) } `;
	for ( let k = 1; k <= 9; k++ ) { const y = horizon + ( H - horizon ) * Math.pow( k / 9, 2 ); gridPath += `M0 ${ f( y ) } H${ W } `; }
	layers.push( `<rect x="0" y="${ f( horizon ) }" width="${ W }" height="${ f( H - horizon ) }" fill="${ hs( hue + 230, 55, 5 ) }" opacity="0.7"/>` );
	layers.push( `<path d="${ gridPath }" stroke="url(#${ gf })" stroke-width="2.2" fill="none"/>` );
	layers.push( `<rect x="0" y="${ f( horizon - 1.5 ) }" width="${ W }" height="3" fill="${ nB }" opacity="0.9"/>` );
	layers.push( `<rect x="0" y="${ f( horizon - 8 ) }" width="${ W }" height="16" fill="${ nB }" opacity="0.10"/>` );

	// 히어로 원판 + 네온 링
	const R = heroS * 0.66;
	layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R ) }" fill="${ hs( hue + 230, 50, 8 ) }" opacity="0.82"/>` );
	layers.push( glowStrokes( ( c, w, a ) => `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R ) }" fill="none" stroke="${ c }" stroke-width="${ w }" opacity="${ a }"/>`, nA ) );
	layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R ) }" fill="none" stroke="#ffffff" stroke-width="3.5"/>` );
	layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R ) }" fill="none" stroke="${ nA }" stroke-width="2" opacity="0.9"/>` );
	// 바깥 반쪽 아크 (마젠타)
	const R2 = R * 1.24, arc = ( a0, a1 ) => `M${ f( cx + Math.cos( a0 ) * R2 ) } ${ f( cy + Math.sin( a0 ) * R2 ) } A${ f( R2 ) } ${ f( R2 ) } 0 0 1 ${ f( cx + Math.cos( a1 ) * R2 ) } ${ f( cy + Math.sin( a1 ) * R2 ) }`;
	[ [ -2.6, -1.3 ], [ 0.2, 1.1 ] ].forEach( ( [ a0, a1 ] ) => {
		layers.push( `<path d="${ arc( a0, a1 ) }" fill="none" stroke="${ nB }" stroke-width="14" opacity="0.14" stroke-linecap="round"/>` );
		layers.push( `<path d="${ arc( a0, a1 ) }" fill="none" stroke="${ nB }" stroke-width="4" stroke-linecap="round"/>` );
	} );

	// 조연: 작은 네온 링 안
	ctx.supports.slice( 0, 2 ).forEach( ( k, i ) => {
		const r = heroS * 0.2;
		const sx = cx + ( i ? R * 1.05 : -R * 1.08 ), sy = cy + R * ( portrait ? ( i ? 0.5 : -0.62 ) : ( i ? -0.72 : 0.78 ) );
		layers.push( `<circle cx="${ f( sx ) }" cy="${ f( sy ) }" r="${ f( r ) }" fill="${ hs( hue + 230, 50, 8 ) }" opacity="0.88"/>` );
		layers.push( glowStrokes( ( c, w, a ) => `<circle cx="${ f( sx ) }" cy="${ f( sy ) }" r="${ f( r ) }" fill="none" stroke="${ c }" stroke-width="${ w * 0.6 }" opacity="${ a }"/>`, nB ) );
		layers.push( `<circle cx="${ f( sx ) }" cy="${ f( sy ) }" r="${ f( r ) }" fill="none" stroke="${ nB }" stroke-width="2.5"/>` );
		layers.push( place( k, sx, sy, r * 1.4, 0, { shadow: false } ) );
	} );

	layers.push( place( ctx.plan.hero, cx, cy, heroS * 0.9, ( rand() - 0.5 ) * 6 ) );

	// 코너 브래킷
	const m = Math.min( W, H ) * 0.045, bl = Math.min( W, H ) * 0.09;
	const corner = ( x, y, sx, sy ) => `M${ f( x + sx * bl ) } ${ f( y ) } H${ f( x ) } V${ f( y + sy * bl ) }`;
	const bracket = [ corner( m, m, 1, 1 ), corner( W - m, m, -1, 1 ), corner( m, H - m, 1, -1 ), corner( W - m, H - m, -1, -1 ) ].join( ' ' );
	layers.push( `<path d="${ bracket }" fill="none" stroke="${ nB }" stroke-width="10" opacity="0.16" stroke-linejoin="round"/>` );
	layers.push( `<path d="${ bracket }" fill="none" stroke="${ nB }" stroke-width="3" stroke-linejoin="round"/>` );

	if ( ! noText ) {
		const T = layoutText( ctx, { w: L.textW, startRatio: portrait ? 0.058 : 0.09 } );
		// 슬래시 장식
		const sy0 = L.textCY - T.blockH / 2 - H * 0.075;
		[ 0, 1, 2 ].forEach( ( i ) => layers.push( `<path d="M${ f( L.textX + i * W * 0.02 ) } ${ f( sy0 + H * 0.035 ) } l${ f( W * 0.012 ) } ${ f( -H * 0.035 ) } h${ f( W * 0.008 ) } l${ f( -W * 0.012 ) } ${ f( H * 0.035 ) } Z" fill="${ i === 0 ? nA : nB }" opacity="${ 1 - i * 0.25 }"/>` ) );
		layers.push( emitText( T, L.textX, L.textCY, ( line, x, y, size, kind ) => {
			const t = escapeXml( line );
			if ( kind === 'title' ) {
				return [ [ 18, 0.10 ], [ 10, 0.22 ], [ 5, 0.55 ] ].map( ( [ w, a ] ) =>
					`<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="none" stroke="${ nA }" stroke-width="${ w }" stroke-linejoin="round" opacity="${ a }">${ t }</text>` ).join( '' ) +
					`<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="#ffffff">${ t }</text>`;
			}
			return `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="${ nB }">${ t }</text>`;
		} ) );
	}
}

// ──────────────────────────────────────────────────────────────
// 5) PAPERCUT — 종이 물결 레이어 + 종이 원판 + 종이 라벨
// ──────────────────────────────────────────────────────────────
function composePapercut( ctx ) {
	const { W, H, defs, layers, u, rand, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	ctx.shadowAlpha = 0.28;
	const L = baseLayout( ctx, { heroScale: 0.8, heroX: 0.76, heroY: 0.5 } );
	const { cx, cy, heroS } = L;
	const base = hs( hue, 66, 58 );
	const tones = [ lighten( base, 0.62 ), lighten( base, 0.38 ), lighten( base, 0.12 ), darken( base, 0.1 ), darken( base, 0.3 ) ];
	const acc = hs( hue + 165, 78, 58 ), cream = '#fff8ec';

	layers.push( `<rect width="${ W }" height="${ H }" fill="${ tones[ 0 ] }"/>` );
	const wave = ( y0, amp, ph ) => `M0 ${ f( y0 ) } C${ f( W * 0.2 ) } ${ f( y0 - amp * ph ) } ${ f( W * 0.35 ) } ${ f( y0 + amp * ph ) } ${ f( W * 0.55 ) } ${ f( y0 ) } S${ f( W * 0.85 ) } ${ f( y0 - amp * ph ) } ${ f( W ) } ${ f( y0 + amp * 0.3 ) } V${ H } H0 Z`;
	const layerDefs = [ [ 0.3, 0.09, 1 ], [ 0.46, 0.08, -1 ], [ 0.62, 0.075, 1 ], [ 0.78, 0.07, -1 ] ];
	layerDefs.forEach( ( [ yr, ar, ph ], i ) => {
		const d = wave( H * yr, H * ar, ph );
		layers.push( `<path d="${ d }" fill="#000" opacity="0.07" transform="translate(0 -14)"/>` );
		layers.push( `<path d="${ d }" fill="#000" opacity="0.10" transform="translate(0 -7)"/>` );
		layers.push( `<path d="${ d }" fill="${ tones[ i + 1 ] }"/>` );
	} );

	// 종이 구름/별 (상단)
	const cloud = ( x, y, s ) => {
		const sh = ( dy, o ) => `<g opacity="${ o }" transform="translate(0 ${ dy })" fill="#000"><circle cx="${ f( x ) }" cy="${ f( y ) }" r="${ f( s * 0.5 ) }"/><circle cx="${ f( x + s * 0.55 ) }" cy="${ f( y - s * 0.22 ) }" r="${ f( s * 0.62 ) }"/><circle cx="${ f( x + s * 1.15 ) }" cy="${ f( y ) }" r="${ f( s * 0.46 ) }"/><rect x="${ f( x ) }" y="${ f( y ) }" width="${ f( s * 1.15 ) }" height="${ f( s * 0.46 ) }"/></g>`;
		return sh( 9, 0.08 ) + sh( 4, 0.1 ) + `<g fill="#ffffff"><circle cx="${ f( x ) }" cy="${ f( y ) }" r="${ f( s * 0.5 ) }"/><circle cx="${ f( x + s * 0.55 ) }" cy="${ f( y - s * 0.22 ) }" r="${ f( s * 0.62 ) }"/><circle cx="${ f( x + s * 1.15 ) }" cy="${ f( y ) }" r="${ f( s * 0.46 ) }"/><rect x="${ f( x ) }" y="${ f( y ) }" width="${ f( s * 1.15 ) }" height="${ f( s * 0.46 ) }"/></g>`;
	};
	layers.push( cloud( W * ( portrait ? 0.12 : 0.55 ), H * 0.13, H * 0.075 ) );
	layers.push( cloud( W * ( portrait ? 0.62 : 0.9 ), H * 0.09, H * 0.055 ) );

	// 종이 원판 (3겹)
	[ [ 1.02, lighten( base, 0.7 ) ], [ 0.86, lighten( acc, 0.55 ) ], [ 0.7, cream ] ].forEach( ( [ k, c ], i ) => {
		const r = heroS * 0.62 * k * 1.12;
		layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy + 16 ) }" r="${ f( r ) }" fill="#000" opacity="0.07"/>` );
		layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy + 8 ) }" r="${ f( r ) }" fill="#000" opacity="0.12"/>` );
		layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( r ) }" fill="${ c }"/>` );
	} );
	// 종이 별
	const star = ( x, y, r, c ) => {
		let d = '';
		for ( let i = 0; i < 10; i++ ) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; d += `${ i ? 'L' : 'M' }${ f( x + Math.cos( a ) * rr ) } ${ f( y + Math.sin( a ) * rr ) } `; }
		return `<path d="${ d }Z" fill="#000" opacity="0.12" transform="translate(0 6)"/><path d="${ d }Z" fill="${ c }"/>`;
	};
	layers.push( star( cx + heroS * 0.62, cy - heroS * 0.58, heroS * 0.11, acc ) );
	layers.push( star( cx - heroS * 0.7, cy + heroS * 0.42, heroS * 0.07, lighten( acc, 0.3 ) ) );

	// 조연: 작은 종이 원판
	ctx.supports.slice( 0, 2 ).forEach( ( k, i ) => {
		const r = heroS * 0.2;
		const sx = cx + ( i ? heroS * 0.66 : -heroS * 0.7 ), sy = cy + ( i ? heroS * 0.5 : -heroS * 0.32 );
		layers.push( `<circle cx="${ f( sx ) }" cy="${ f( sy + 10 ) }" r="${ f( r ) }" fill="#000" opacity="0.14"/>` );
		layers.push( `<circle cx="${ f( sx ) }" cy="${ f( sy ) }" r="${ f( r ) }" fill="#ffffff"/>` );
		layers.push( place( k, sx, sy, r * 1.35, ( i ? 1 : -1 ) * 6, { shadow: false } ) );
	} );

	layers.push( place( ctx.plan.hero, cx, cy, heroS * 0.86, ( rand() - 0.5 ) * 5 ) );

	// 제목 종이 라벨
	if ( ! noText ) {
		const T = layoutText( ctx, { w: L.textW * 0.86, startRatio: portrait ? 0.056 : 0.08 } );
		const padX = W * 0.03, padY = H * 0.05;
		const lx = L.textX - padX, ly = L.textCY - T.blockH / 2 - padY, lw = L.textW * 0.86 + padX * 2, lh = T.blockH + padY * 2;
		const rot = -1.6;
		const g = `transform="rotate(${ rot } ${ f( lx + lw / 2 ) } ${ f( ly + lh / 2 ) })"`;
		layers.push( `<g ${ g }>` +
			`<rect x="${ f( lx ) }" y="${ f( ly + 16 ) }" width="${ f( lw ) }" height="${ f( lh ) }" rx="${ f( H * 0.02 ) }" fill="#000" opacity="0.08"/>` +
			`<rect x="${ f( lx ) }" y="${ f( ly + 8 ) }" width="${ f( lw ) }" height="${ f( lh ) }" rx="${ f( H * 0.02 ) }" fill="#000" opacity="0.14"/>` +
			`<rect x="${ f( lx ) }" y="${ f( ly ) }" width="${ f( lw ) }" height="${ f( lh ) }" rx="${ f( H * 0.02 ) }" fill="${ cream }"/>` +
			`<rect x="${ f( lx + padX * 0.5 ) }" y="${ f( ly + padY * 0.42 ) }" width="${ f( W * 0.06 ) }" height="${ f( Math.max( 6, H * 0.011 ) ) }" rx="3" fill="${ acc }"/>` +
			emitText( T, L.textX, L.textCY + H * 0.008, ( line, x, y, size, kind ) =>
				kind === 'title'
					? `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="${ hs( hue, 55, 20 ) }">${ escapeXml( line ) }</text>`
					: `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="${ hs( hue, 40, 32 ) }" opacity="0.9">${ escapeXml( line ) }</text>` ) +
			'</g>' );
	}
}

// ──────────────────────────────────────────────────────────────
// 6) BLUEPRINT — 청사진 방안, 치수선, 지시선, 표제란
// ──────────────────────────────────────────────────────────────
function composeBlueprint( ctx ) {
	const { W, H, defs, layers, u, hue, portrait, noText } = ctx;
	const place = makePlacer( ctx );
	ctx.shadowAlpha = 0.18;
	const L = baseLayout( ctx, { heroScale: 0.9, heroX: 0.66, heroY: 0.47 } );
	const { cx, cy, heroS } = L;
	const bH = 216;                                  // 청사진은 항상 파란색 계열(주제 색은 오브젝트가 담당)
	const ink = '#eaf3ff', inkSoft = '#9fc4ff', cy1 = '#5ee6ff';

	const bg = u( 'bg' ), grid = u( 'grid' );
	defs.push( `<radialGradient id="${ bg }" gradientUnits="userSpaceOnUse" cx="${ f( W * 0.5 ) }" cy="${ f( H * 0.5 ) }" r="${ f( W * 0.75 ) }"><stop offset="0" stop-color="${ hs( bH, 78, 36 ) }"/><stop offset="1" stop-color="${ hs( bH, 82, 22 ) }"/></radialGradient>` );
	defs.push( `<pattern id="${ grid }" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M0 0H100M0 20H100M0 40H100M0 60H100M0 80H100M0 0V100M20 0V100M40 0V100M60 0V100M80 0V100" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1" fill="none"/><path d="M0 0H100M0 0V100" stroke="#ffffff" stroke-opacity="0.17" stroke-width="1.5" fill="none"/></pattern>` );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ bg })"/>` );
	layers.push( `<rect width="${ W }" height="${ H }" fill="url(#${ grid })"/>` );

	// 도면 테두리
	const m1 = Math.min( W, H ) * 0.03;
	layers.push( `<rect x="${ f( m1 ) }" y="${ f( m1 ) }" width="${ f( W - m1 * 2 ) }" height="${ f( H - m1 * 2 ) }" fill="none" stroke="${ ink }" stroke-width="3" opacity="0.9"/>` );
	layers.push( `<rect x="${ f( m1 * 1.6 ) }" y="${ f( m1 * 1.6 ) }" width="${ f( W - m1 * 3.2 ) }" height="${ f( H - m1 * 3.2 ) }" fill="none" stroke="${ ink }" stroke-width="1.2" opacity="0.5"/>` );

	// 히어로: 트레이싱 페이퍼 원 + 십자선 + 치수선
	const R = heroS * 0.5;
	layers.push( `<path d="M${ f( cx - R * 1.4 ) } ${ f( cy ) } H${ f( cx + R * 1.4 ) } M${ f( cx ) } ${ f( cy - R * 1.36 ) } V${ f( cy + R * 1.36 ) }" stroke="${ cy1 }" stroke-width="1.6" stroke-dasharray="16 5 3 5" opacity="0.85"/>` );
	layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R * 1.2 ) }" fill="none" stroke="${ inkSoft }" stroke-width="1.8" stroke-dasharray="9 7" opacity="0.8"/>` );
	layers.push( `<circle cx="${ f( cx ) }" cy="${ f( cy ) }" r="${ f( R ) }" fill="#e9f2ff" fill-opacity="0.94" stroke="${ ink }" stroke-width="4"/>` );
	layers.push( place( ctx.plan.hero, cx, cy - R * 0.02, heroS * 0.7, 0, { shadow: false } ) );

	// 가로 치수선(원 아래)
	const dyy = cy + R * 1.3;
	layers.push( `<path d="M${ f( cx - R ) } ${ f( dyy - 12 ) } V${ f( dyy + 12 ) } M${ f( cx + R ) } ${ f( dyy - 12 ) } V${ f( dyy + 12 ) } M${ f( cx - R ) } ${ f( dyy ) } H${ f( cx + R ) }" stroke="${ ink }" stroke-width="2" fill="none"/>` +
		`<path d="M${ f( cx - R + 16 ) } ${ f( dyy - 6 ) } L${ f( cx - R ) } ${ f( dyy ) } L${ f( cx - R + 16 ) } ${ f( dyy + 6 ) } M${ f( cx + R - 16 ) } ${ f( dyy - 6 ) } L${ f( cx + R ) } ${ f( dyy ) } L${ f( cx + R - 16 ) } ${ f( dyy + 6 ) }" stroke="${ ink }" stroke-width="2" fill="none"/>` );
	layers.push( `<rect x="${ f( cx - 22 ) }" y="${ f( dyy - 13 ) }" width="44" height="26" fill="${ hs( bH, 78, 30 ) }"/>` );
	layers.push( `<text x="${ f( cx ) }" y="${ f( dyy + 7 ) }" text-anchor="middle" font-family="${ FONT }" font-size="20" font-weight="700" fill="${ ink }">A</text>` );

	// 지시선 + 라벨: ① 히어로(위쪽), ②③ 조연(오른쪽 원)
	const lblSz = H * 0.033;
	const x0 = cx - R * 0.42, y0 = cy - R * 0.86, x1 = cx - R * 0.2, y1 = cy - R * 1.32;
	layers.push( `<path d="M${ f( x0 ) } ${ f( y0 ) } L${ f( x1 ) } ${ f( y1 ) } H${ f( x1 + 10 ) }" fill="none" stroke="${ cy1 }" stroke-width="2"/><circle cx="${ f( x0 ) }" cy="${ f( y0 ) }" r="5" fill="${ cy1 }"/>` );
	layers.push( `<text x="${ f( x1 + 20 ) }" y="${ f( y1 + 8 ) }" font-family="${ FONT }" font-size="${ f( lblSz ) }" font-weight="700" fill="${ ink }">① ${ escapeXml( ctx.heroDef.label ) }</text>` );
	const supSlots = portrait ? [ [ -1.25, 0.55 ], [ 1.25, 0.55 ] ] : [ [ 1.5, -0.32 ], [ 1.36, 0.78 ] ];
	ctx.supports.slice( 0, 2 ).forEach( ( k, i ) => {
		const r = heroS * 0.15;
		const sx = cx + R * supSlots[ i ][ 0 ], sy = cy + R * supSlots[ i ][ 1 ];
		layers.push( `<path d="M${ f( cx + ( sx - cx ) * 0.62 ) } ${ f( cy + ( sy - cy ) * 0.62 ) } L${ f( sx - Math.sign( sx - cx ) * r ) } ${ f( sy ) }" stroke="${ inkSoft }" stroke-width="1.6" stroke-dasharray="6 6"/>` );
		layers.push( `<circle cx="${ f( sx ) }" cy="${ f( sy ) }" r="${ f( r ) }" fill="#e9f2ff" fill-opacity="0.94" stroke="${ ink }" stroke-width="3"/>` );
		layers.push( place( k, sx, sy, r * 1.4, 0, { shadow: false } ) );
		layers.push( `<text x="${ f( sx ) }" y="${ f( sy + r + lblSz * 1.2 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( lblSz * 0.86 ) }" font-weight="700" fill="${ ink }">${ i ? '③' : '②' } ${ escapeXml( OBJECTS[ k ].label ) }</text>` );
	} );

	// 제목 + 표제란
	if ( ! noText ) {
		const T = layoutText( ctx, { w: L.textW, startRatio: portrait ? 0.056 : 0.085 } );
		layers.push( `<rect x="${ f( L.textX ) }" y="${ f( L.textCY - T.blockH / 2 - H * 0.05 ) }" width="${ f( W * 0.06 ) }" height="${ f( Math.max( 5, H * 0.008 ) ) }" fill="${ cy1 }"/>` );
		layers.push( emitText( T, L.textX, L.textCY, ( line, x, y, size, kind ) =>
			kind === 'title'
				? `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="800" fill="#ffffff">${ escapeXml( line ) }</text>`
				: `<text x="${ f( x ) }" y="${ f( y ) }" font-family="${ FONT }" font-size="${ size }" font-weight="400" fill="${ inkSoft }">${ escapeXml( line ) }</text>` ) );
	}
	// 표제란(우하단): 장식용 도면 정보
	const tbW = portrait ? W * 0.52 : W * 0.24, tbH = H * 0.11, tbX = W - m1 * 1.6 - tbW, tbY = H - m1 * 1.6 - tbH;
	layers.push( `<rect x="${ f( tbX ) }" y="${ f( tbY ) }" width="${ f( tbW ) }" height="${ f( tbH ) }" fill="${ hs( bH, 80, 26 ) }" fill-opacity="0.7" stroke="${ ink }" stroke-width="1.8"/>` );
	layers.push( `<path d="M${ f( tbX ) } ${ f( tbY + tbH / 2 ) } H${ f( tbX + tbW ) } M${ f( tbX + tbW * 0.5 ) } ${ f( tbY + tbH / 2 ) } V${ f( tbY + tbH ) }" stroke="${ ink }" stroke-width="1.2" fill="none"/>` );
	const tbf = H * 0.026;
	layers.push( `<text x="${ f( tbX + tbW / 2 ) }" y="${ f( tbY + tbH * 0.36 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( tbf ) }" font-weight="700" fill="${ ink }">${ escapeXml( ctx.heroDef.label ) } 도면</text>` );
	layers.push( `<text x="${ f( tbX + tbW * 0.25 ) }" y="${ f( tbY + tbH * 0.82 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( tbf * 0.8 ) }" fill="${ inkSoft }">축척 1:1</text>` );
	layers.push( `<text x="${ f( tbX + tbW * 0.75 ) }" y="${ f( tbY + tbH * 0.82 ) }" text-anchor="middle" font-family="${ FONT }" font-size="${ f( tbf * 0.8 ) }" fill="${ inkSoft }">SHEET 01</text>` );
}

// ──────────────────────────────────────────────────────────────
// 진입점
// ──────────────────────────────────────────────────────────────
const COMPOSERS = {
	gradient: composeGradient,
	infographic: composeInfographic,
	isometric: composeIsometric,
	neon: composeNeon,
	papercut: composePapercut,
	blueprint: composeBlueprint,
};

/**
 * @param {{hero:string, supports:string[]}} plan  planScene 결과
 * @param {{topic?:string, subtitle?:string, prompt?:string, style:string, width:number, height:number}} opts
 *        subtitle 은 "화면에 표시할 부제"만 넣는다(조사 설명문 금지).
 * @returns {string} well-formed SVG 문자열
 */
export function composeStyledSvg( plan, opts ) {
	const fn = COMPOSERS[ opts.style ];
	if ( ! fn ) throw new Error( `지원하지 않는 디자인 스타일: ${ opts.style }` );
	const ctx = makeCtx( plan, opts );
	fn( ctx );
	return svgWrap( ctx );
}
