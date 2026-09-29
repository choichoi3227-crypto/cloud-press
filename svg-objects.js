/**
 * svg-objects.js — 주제별 "실물 느낌" 벡터 오브젝트 라이브러리.
 *
 * 각 오브젝트는 -50..50 크기의 로컬 좌표계(중심이 원점)에 그려진다.
 * 씬 합성기(svg-scene.js)가 translate/scale로 원하는 위치·크기에 배치한다.
 * 그라디언트·하이라이트·유리 반사·재질 표현을 넣어 납작한 아이콘이 아니라
 * 스튜디오에서 찍은 사물처럼 보이게 하는 것이 목표이며, 모든 그라디언트는
 * userSpaceOnUse + 고유 id라 어떤 조합으로 배치해도 충돌하지 않는다.
 * 필터(blur 등)는 쓰지 않는다 — resvg CPU 비용을 낮춰 무료 플랜에서도
 * PNG 변환이 통과하도록 하기 위함이다.
 */

// ── 색상 유틸 ───────────────────────────────────────────────
export function hslToHex( h, s, l ) {
	h = ( ( h % 360 ) + 360 ) % 360;
	s /= 100;
	l /= 100;
	const k = ( n ) => ( n + h / 30 ) % 12;
	const a = s * Math.min( l, 1 - l );
	const f = ( n ) => l - a * Math.max( -1, Math.min( k( n ) - 3, Math.min( 9 - k( n ), 1 ) ) );
	return '#' + [ f( 0 ), f( 8 ), f( 4 ) ].map( ( x ) => Math.round( x * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
}
function hexToRgb( hex ) {
	const v = parseInt( hex.slice( 1 ), 16 );
	return [ ( v >> 16 ) & 255, ( v >> 8 ) & 255, v & 255 ];
}
export function mix( a, b, t ) {
	const A = hexToRgb( a ), B = hexToRgb( b );
	return '#' + A.map( ( x, i ) => Math.round( x + ( B[ i ] - x ) * t ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
}
export const lighten = ( c, t ) => mix( c, '#ffffff', t );
export const darken = ( c, t ) => mix( c, '#000000', t );

/** 색상(hue) 하나로 씬 전체 팔레트를 만든다. */
export function makePalette( hue ) {
	const warm = hue > 15 && hue < 70;
	return {
		c1:    hslToHex( hue, 72, 50 ),
		c2:    hslToHex( hue + 22, 66, 34 ),
		acc:   warm ? hslToHex( hue + 185, 80, 55 ) : hslToHex( 42, 95, 56 ),
		dark:  hslToHex( hue, 45, 11 ),
		light: hslToHex( hue, 70, 96 ),
		hue,
	};
}

// ── SVG 조각 헬퍼 ────────────────────────────────────────────
const stops = ( arr ) => arr.map( ( [ o, c, a ] ) => `<stop offset="${ o }" stop-color="${ c }"${ a !== undefined ? ` stop-opacity="${ a }"` : '' }/>` ).join( '' );
const LG = ( id, x1, y1, x2, y2, st ) => `<linearGradient id="${ id }" gradientUnits="userSpaceOnUse" x1="${ x1 }" y1="${ y1 }" x2="${ x2 }" y2="${ y2 }">${ stops( st ) }</linearGradient>`;
const RG = ( id, cx, cy, r, st, fx = cx, fy = cy ) => `<radialGradient id="${ id }" gradientUnits="userSpaceOnUse" cx="${ cx }" cy="${ cy }" r="${ r }" fx="${ fx }" fy="${ fy }">${ stops( st ) }</radialGradient>`;

const GLASS = '#dbeafe';

// ── 오브젝트 정의 ────────────────────────────────────────────
// draw(P, u) → { defs, body }.  u(name)은 씬 전체에서 유일한 id를 돌려준다.
export const OBJECTS = {

	laptop: {
		label: '노트북', hue: 215,
		draw( P, u ) {
			const scr = u( 'scr' ), bez = u( 'bez' ), met = u( 'met' ), gl = u( 'gl' );
			const defs = LG( scr, 0, -38, 0, 8, [ [ 0, lighten( P.c1, 0.28 ) ], [ 1, darken( P.c2, 0.15 ) ] ] ) +
				LG( bez, 0, -42, 0, 12, [ [ 0, '#2b3442' ], [ 1, '#0b111b' ] ] ) +
				LG( met, 0, 12, 0, 23, [ [ 0, '#f8fafc' ], [ 0.6, '#cbd5e1' ], [ 1, '#94a3b8' ] ] ) +
				LG( gl, -38, -38, 6, 8, [ [ 0, '#ffffff', 0.32 ], [ 1, '#ffffff', 0 ] ] );
			const side = [ 0, 1, 2, 3, 4 ].map( ( i ) => `<rect x="-35" y="${ -27 + i * 7 }" width="8" height="2.6" rx="1.3" fill="#fff" opacity="0.55"/>` ).join( '' );
			const bars = [ 5, 9, 6, 11 ].map( ( h, i ) => `<rect x="${ -18 + i * 5.5 }" y="${ 5 - h }" width="3.4" height="${ h }" rx="0.8" fill="${ P.acc }"/>` ).join( '' );
			const body = `<g transform="translate(0 9)">
<rect x="-42" y="-42" width="84" height="54" rx="4" fill="url(#${ bez })"/>
<rect x="-38" y="-38" width="76" height="46" rx="1.5" fill="url(#${ scr })"/>
<rect x="-38" y="-38" width="76" height="6" fill="${ darken( P.c2, 0.3 ) }" opacity="0.85"/>
<circle cx="-34" cy="-35" r="1.2" fill="#f87171"/><circle cx="-30" cy="-35" r="1.2" fill="#fbbf24"/><circle cx="-26" cy="-35" r="1.2" fill="#34d399"/>
<rect x="-38" y="-32" width="14" height="40" fill="#fff" opacity="0.12"/>${ side }
<rect x="-20" y="-28" width="30" height="4" rx="2" fill="#fff" opacity="0.92"/>
<rect x="-20" y="-21" width="52" height="2.4" rx="1.2" fill="#fff" opacity="0.5"/>
<rect x="-20" y="-16.5" width="44" height="2.4" rx="1.2" fill="#fff" opacity="0.4"/>
<rect x="-20" y="-12" width="48" height="2.4" rx="1.2" fill="#fff" opacity="0.4"/>
<rect x="-20" y="-7" width="26" height="14" rx="2" fill="#fff" opacity="0.16"/>${ bars }
<circle cx="22" cy="0" r="8" fill="none" stroke="#fff" stroke-opacity="0.25" stroke-width="3.2"/>
<circle cx="22" cy="0" r="8" fill="none" stroke="${ P.acc }" stroke-width="3.2" stroke-dasharray="32 50" transform="rotate(-90 22 0)"/>
<path d="M-38 -38 L-4 -38 L-26 8 L-38 8 Z" fill="url(#${ gl })"/>
<circle cx="0" cy="-40" r="0.9" fill="#475569"/>
<path d="M-46 12 H46 L50 20 Q50 23 47 23 H-47 Q-50 23 -50 20 Z" fill="url(#${ met })"/>
<rect x="-9" y="12" width="18" height="2.6" rx="1.3" fill="#64748b" opacity="0.55"/>
<rect x="-50" y="21" width="100" height="2" rx="1" fill="#64748b" opacity="0.4"/>
</g>`;
			return { defs, body };
		},
	},

	phone: {
		label: '스마트폰', hue: 262,
		draw( P, u ) {
			const bd = u( 'bd' ), sc = u( 'sc' ), gl = u( 'gl' );
			const defs = LG( bd, -22, 0, 22, 0, [ [ 0, '#111827' ], [ 0.5, '#374151' ], [ 1, '#111827' ] ] ) +
				LG( sc, 0, -41, 0, 41, [ [ 0, lighten( P.c1, 0.3 ) ], [ 1, darken( P.c2, 0.1 ) ] ] ) +
				LG( gl, -19, -41, 19, 10, [ [ 0, '#fff', 0.3 ], [ 1, '#fff', 0 ] ] );
			const cols = [ P.acc, '#fff', lighten( P.c1, 0.5 ), '#fb7185', '#34d399', '#fbbf24', lighten( P.c2, 0.4 ), '#60a5fa', P.acc, '#fff', '#a78bfa', '#f472b6' ];
			const tiles = cols.map( ( c, i ) => `<rect x="${ -15 + ( i % 3 ) * 11 }" y="${ -20 + Math.floor( i / 3 ) * 13 }" width="8.5" height="8.5" rx="2.4" fill="${ c }" opacity="${ i % 2 ? 0.85 : 0.95 }"/>` ).join( '' );
			const body = `<rect x="22" y="-20" width="1.6" height="12" rx="0.8" fill="#4b5563"/>
<rect x="-22" y="-44" width="44" height="88" rx="8" fill="url(#${ bd })"/>
<rect x="-19" y="-41" width="38" height="82" rx="6" fill="url(#${ sc })"/>
<rect x="-7" y="-38.5" width="14" height="4" rx="2" fill="#0b111b"/>
<text x="0" y="-25" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" opacity="0.95" font-family="Noto Sans KR, sans-serif">12:30</text>
${ tiles }
<rect x="-15" y="33" width="30" height="5" rx="2.5" fill="#fff" opacity="0.25"/>
<rect x="-7" y="38" width="14" height="1.4" rx="0.7" fill="#fff" opacity="0.7"/>
<path d="M-19 -41 H8 L-19 12 Z" fill="url(#${ gl })"/>`;
			return { defs, body };
		},
	},

	coffee: {
		label: '커피', hue: 26,
		draw( P, u ) {
			const cer = u( 'cer' ), cof = u( 'cof' ), sau = u( 'sau' );
			const defs = LG( cer, -30, 0, 30, 0, [ [ 0, '#e5e7eb' ], [ 0.35, '#ffffff' ], [ 1, '#cbd5e1' ] ] ) +
				RG( cof, 0, -14, 28, [ [ 0, '#8a5a34' ], [ 0.6, '#5a3520' ], [ 1, '#2e180c' ] ] ) +
				LG( sau, 0, 30, 0, 46, [ [ 0, '#f1f5f9' ], [ 1, '#94a3b8' ] ] );
			const body = `<ellipse cx="0" cy="38" rx="45" ry="8.5" fill="url(#${ sau })"/>
<ellipse cx="0" cy="36" rx="30" ry="5" fill="#cbd5e1" opacity="0.7"/>
<path d="M29 -6 C50 -6 50 22 25 22" fill="none" stroke="url(#${ cer })" stroke-width="6.5" stroke-linecap="round"/>
<path d="M-30 -14 L-24 28 Q-23 37 -13 37 H13 Q23 37 24 28 L30 -14 Z" fill="url(#${ cer })"/>
<ellipse cx="0" cy="-14" rx="30" ry="8.5" fill="#f8fafc"/>
<ellipse cx="0" cy="-14" rx="27" ry="6.8" fill="url(#${ cof })"/>
<path d="M0 -9.5 C-8 -12 -6 -17 0 -15.5 C6 -17 8 -12 0 -9.5 Z" fill="#f5e6d3" opacity="0.85"/>
<path d="M-22 -8 L-18 26" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.7"/>
<g fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3" opacity="0.5">
<path d="M-10 -24 C-16 -30 -6 -34 -12 -42"/><path d="M2 -24 C-4 -31 8 -36 2 -46"/><path d="M14 -24 C8 -30 18 -34 12 -41"/></g>`;
			return { defs, body };
		},
	},

	plant: {
		label: '식물', hue: 140,
		draw( P, u ) {
			const pot = u( 'pot' ), l1 = u( 'l1' ), l2 = u( 'l2' );
			const defs = LG( pot, -22, 0, 22, 0, [ [ 0, '#a8552a' ], [ 0.45, '#d9803f' ], [ 1, '#8f4a24' ] ] ) +
				LG( l1, 0, 0, 0, -40, [ [ 0, '#14532d' ], [ 1, '#4ade80' ] ] ) +
				LG( l2, 0, 0, 0, -40, [ [ 0, '#166534' ], [ 1, '#86efac' ] ] );
			const leaf = 'M0 0 C-11 -10 -11 -28 0 -42 C11 -28 11 -10 0 0 Z';
			const leaves = [ [ -62, 0.85, l2 ], [ 60, 0.85, l2 ], [ -36, 1.0, l1 ], [ 38, 1.0, l1 ], [ -12, 1.12, l2 ], [ 14, 1.05, l1 ] ]
				.map( ( [ a, s, g ] ) => `<g transform="translate(0 6) rotate(${ a }) scale(${ s })"><path d="${ leaf }" fill="url(#${ g })"/><path d="M0 -2 L0 -36" stroke="#dcfce7" stroke-width="0.9" opacity="0.5"/></g>` ).join( '' );
			const body = `${ leaves }
<path d="M-20 12 H20 L15.5 42 Q14.5 47 10 47 H-10 Q-14.5 47 -15.5 42 Z" fill="url(#${ pot })"/>
<rect x="-24" y="4" width="48" height="10" rx="3.5" fill="url(#${ pot })"/>
<rect x="-24" y="4" width="48" height="3" rx="1.5" fill="#fff" opacity="0.22"/>
<ellipse cx="0" cy="5" rx="21" ry="2.2" fill="#3b2314"/>
<path d="M-13 18 L-10 40" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity="0.22"/>`;
			return { defs, body };
		},
	},

	book: {
		label: '책', hue: 24,
		draw( P, u ) {
			const pg = u( 'pg' ), b1 = u( 'b1' ), b2 = u( 'b2' ), b3 = u( 'b3' );
			const defs = LG( pg, 0, -40, 0, -5, [ [ 0, '#ffffff' ], [ 1, '#e2e8f0' ] ] ) +
				LG( b1, 0, 22, 0, 37, [ [ 0, lighten( P.c1, 0.15 ) ], [ 1, darken( P.c1, 0.3 ) ] ] ) +
				LG( b2, 0, 8, 0, 22, [ [ 0, lighten( P.acc, 0.1 ) ], [ 1, darken( P.acc, 0.3 ) ] ] ) +
				LG( b3, 0, -6, 0, 8, [ [ 0, lighten( P.c2, 0.25 ) ], [ 1, darken( P.c2, 0.25 ) ] ] );
			const spine = ( x, y, w, g ) => `<rect x="${ x }" y="${ y }" width="${ w }" height="14" rx="1.6" fill="url(#${ g })"/><rect x="${ x + w - 4 }" y="${ y + 1 }" width="3" height="12" fill="#fff" opacity="0.85"/><rect x="${ x + 6 }" y="${ y + 3 }" width="${ w * 0.4 }" height="1.6" fill="#fff" opacity="0.7"/><rect x="${ x + 6 }" y="${ y + 7 }" width="${ w * 0.28 }" height="1.6" fill="#fff" opacity="0.5"/>`;
			const body = `<g transform="translate(0 4)">
${ spine( -40, 22, 80, b1 ) }${ spine( -34, 8, 72, b2 ) }${ spine( -30, -6, 62, b3 ) }
<path d="M0 -10 Q-18 -18 -38 -12 L-38 -38 Q-18 -44 0 -35 Z" fill="url(#${ pg })"/>
<path d="M0 -10 Q18 -18 38 -12 L38 -38 Q18 -44 0 -35 Z" fill="url(#${ pg })"/>
<path d="M0 -35 V-10" stroke="#94a3b8" stroke-width="1.2"/>
<g stroke="#94a3b8" stroke-width="1.3" stroke-linecap="round" opacity="0.8"><path d="M-33 -31 Q-18 -35 -6 -29"/><path d="M-33 -25 Q-18 -29 -6 -23"/><path d="M-33 -19 Q-18 -23 -6 -17"/><path d="M6 -29 Q18 -35 33 -31"/><path d="M6 -23 Q18 -29 33 -25"/></g>
<rect x="8" y="-20" width="20" height="5" rx="1" fill="${ P.acc }" opacity="0.85" transform="rotate(-8 18 -18)"/>
</g>`;
			return { defs, body };
		},
	},

	chart: {
		label: '성장 차트', hue: 152,
		draw( P, u ) {
			const card = u( 'card' ), bar = u( 'bar' );
			const defs = LG( card, 0, -38, 0, 38, [ [ 0, '#ffffff' ], [ 1, '#e8eef5' ] ] ) +
				LG( bar, 0, -30, 0, 26, [ [ 0, lighten( P.c1, 0.2 ) ], [ 1, darken( P.c2, 0.1 ) ] ] );
			const hs = [ 14, 22, 18, 32, 44 ];
			const bars = hs.map( ( h, i ) => `<rect x="${ -30 + i * 13.5 }" y="${ 28 - h }" width="9.5" height="${ h }" rx="2" fill="url(#${ bar })"/>` ).join( '' );
			const pts = hs.map( ( h, i ) => `${ -25.2 + i * 13.5 },${ 28 - h - 6 }` );
			const dots = pts.map( ( p ) => `<circle cx="${ p.split( ',' )[ 0 ] }" cy="${ p.split( ',' )[ 1 ] }" r="2.4" fill="#fff" stroke="${ P.acc }" stroke-width="1.8"/>` ).join( '' );
			const body = `<rect x="-42" y="-38" width="84" height="76" rx="8" fill="url(#${ card })"/>
<rect x="-42" y="-38" width="84" height="76" rx="8" fill="none" stroke="#cbd5e1" stroke-width="1"/>
<rect x="-34" y="-31" width="26" height="4.5" rx="2.2" fill="${ P.c2 }" opacity="0.85"/>
<rect x="-34" y="-24" width="16" height="2.6" rx="1.3" fill="#94a3b8" opacity="0.7"/>
<g stroke="#cbd5e1" stroke-width="0.8"><path d="M-34 -8 H34"/><path d="M-34 5 H34"/><path d="M-34 18 H34"/></g>
${ bars }
<path d="M-34 28.5 H34" stroke="#94a3b8" stroke-width="1.2"/>
<polyline points="${ pts.join( ' ' ) }" fill="none" stroke="${ P.acc }" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
${ dots }
<path d="M24 -21 L34 -30 L34 -21 Z" fill="${ P.acc }" transform="translate(4 -2)"/>`;
			return { defs, body };
		},
	},

	house: {
		label: '집', hue: 18,
		draw( P, u ) {
			const wall = u( 'wall' ), roof = u( 'roof' ), win = u( 'win' ), door = u( 'door' );
			const defs = LG( wall, 0, -4, 0, 40, [ [ 0, '#fff7ed' ], [ 1, '#fed7aa' ] ] ) +
				LG( roof, 0, -38, 0, -2, [ [ 0, lighten( P.c1, 0.1 ) ], [ 1, darken( P.c2, 0.25 ) ] ] ) +
				LG( win, 0, 6, 0, 18, [ [ 0, '#bfe3ff' ], [ 1, '#4f8fc0' ] ] ) +
				LG( door, 0, 14, 0, 40, [ [ 0, lighten( P.acc, 0.05 ) ], [ 1, darken( P.acc, 0.35 ) ] ] );
			const body = `<rect x="16" y="-33" width="9" height="20" fill="${ darken( P.c2, 0.35 ) }"/>
<rect x="-30" y="-4" width="60" height="43" fill="url(#${ wall })"/>
<path d="M-40 -1 L0 -40 L40 -1 Z" fill="url(#${ roof })"/>
<path d="M-40 -1 L0 -40 L40 -1" fill="none" stroke="${ darken( P.c2, 0.45 ) }" stroke-width="2" stroke-linejoin="round"/>
<path d="M-30 -1 H30" stroke="#000" stroke-width="3" opacity="0.12"/>
<rect x="-7" y="14" width="14" height="25" rx="1.5" fill="url(#${ door })"/>
<circle cx="3.4" cy="27" r="1.1" fill="#fde68a"/>
<g><rect x="-25" y="6" width="12" height="12" rx="1" fill="url(#${ win })" stroke="#fff" stroke-width="1.6"/><path d="M-19 6 V18 M-25 12 H-13" stroke="#fff" stroke-width="1.2"/>
<rect x="13" y="6" width="12" height="12" rx="1" fill="url(#${ win })" stroke="#fff" stroke-width="1.6"/><path d="M19 6 V18 M13 12 H25" stroke="#fff" stroke-width="1.2"/></g>
<circle cx="0" cy="-14" r="4" fill="url(#${ win })" stroke="#fff" stroke-width="1.5"/>
<rect x="-34" y="38" width="68" height="3" rx="1.5" fill="#9ca3af" opacity="0.6"/>`;
			return { defs, body };
		},
	},

	car: {
		label: '자동차', hue: 6,
		draw( P, u ) {
			const bd = u( 'bd' ), gl = u( 'gl' ), rim = u( 'rim' );
			const defs = LG( bd, 0, -27, 0, 16, [ [ 0, lighten( P.c1, 0.25 ) ], [ 0.55, P.c1 ], [ 1, darken( P.c2, 0.25 ) ] ] ) +
				LG( gl, 0, -22, 0, -8, [ [ 0, '#d7ecff' ], [ 1, '#5c8fb6' ] ] ) +
				RG( rim, 0, 0, 7, [ [ 0, '#f8fafc' ], [ 1, '#94a3b8' ] ] );
			const wheel = ( x ) => `<g transform="translate(${ x } 16)"><circle r="11.5" fill="#0f172a"/><circle r="7" fill="url(#${ rim })"/><circle r="2.2" fill="#475569"/><path d="M0 -7 V7 M-7 0 H7 M-5 -5 L5 5 M5 -5 L-5 5" stroke="#64748b" stroke-width="1"/></g>`;
			const body = `<g transform="translate(0 4)">
<path d="M-47 14 L-47 2 Q-47 -4 -39 -6 L-24 -9 L-14 -24 Q-12 -27 -6 -27 L14 -27 Q20 -27 24 -22 L32 -9 L42 -7 Q49 -5 49 2 L49 14 Z" fill="url(#${ bd })"/>
<path d="M-12 -9 L-5 -22 L3 -22 L3 -9 Z" fill="url(#${ gl })"/>
<path d="M6 -22 L14 -22 Q17 -22 19 -19 L25 -9 L6 -9 Z" fill="url(#${ gl })"/>
<path d="M-40 -1 L44 -1" stroke="#fff" stroke-width="1.6" opacity="0.35"/>
<path d="M-44 6 Q0 2 47 6" stroke="#000" stroke-width="1.2" opacity="0.18" fill="none"/>
<rect x="43" y="-2" width="7" height="4.5" rx="1.6" fill="#fef3c7"/><rect x="-49" y="-1" width="4" height="5" rx="1.4" fill="#ef4444"/>
<rect x="-47" y="11" width="96" height="4" fill="#0f172a" opacity="0.55"/>
<circle cx="-27" cy="16" r="13.5" fill="#0b111b"/><circle cx="28" cy="16" r="13.5" fill="#0b111b"/>
${ wheel( -27 ) }${ wheel( 28 ) }
</g>`;
			return { defs, body };
		},
	},

	mountain: {
		label: '자연 풍경', hue: 200,
		draw( P, u ) {
			const sky = u( 'sky' ), m1 = u( 'm1' ), m2 = u( 'm2' ), sun = u( 'sun' ), clip = u( 'clip' );
			const defs = LG( sky, 0, -44, 0, 30, [ [ 0, '#5aa6e6' ], [ 1, '#fde9c8' ] ] ) +
				LG( m1, 0, -14, 0, 30, [ [ 0, '#94a3b8' ], [ 1, '#cbd5e1' ] ] ) +
				LG( m2, 0, -30, 0, 34, [ [ 0, '#1f6f4a' ], [ 1, '#0f3d2a' ] ] ) +
				RG( sun, 22, -22, 16, [ [ 0, '#fff7cc' ], [ 0.4, '#ffe08a', 0.9 ], [ 1, '#ffe08a', 0 ] ] ) +
				`<clipPath id="${ clip }"><circle cx="0" cy="0" r="44"/></clipPath>`;
			const pines = [ [ -28, 22, 1 ], [ -18, 26, 0.8 ], [ 24, 24, 1.1 ], [ 33, 28, 0.85 ] ]
				.map( ( [ x, y, s ] ) => `<g transform="translate(${ x } ${ y }) scale(${ s })"><path d="M0 -14 L7 -2 H3 L9 8 H-9 L-3 -2 H-7 Z" fill="#0b3d24"/><rect x="-1" y="8" width="2" height="4" fill="#3b2314"/></g>` ).join( '' );
			const body = `<g clip-path="url(#${ clip })">
<rect x="-46" y="-46" width="92" height="92" fill="url(#${ sky })"/>
<circle cx="22" cy="-22" r="16" fill="url(#${ sun })"/>
<path d="M-46 8 L-26 -14 L-12 2 L6 -20 L30 6 L46 -6 V46 H-46 Z" fill="url(#${ m1 })"/>
<path d="M6 -20 L-1 -9 L4 -11 L8 -7 L12 -12 L18 -9 Z" fill="#fff" opacity="0.9"/>
<path d="M-46 22 L-30 4 L-14 20 L4 6 L24 22 L46 8 V46 H-46 Z" fill="url(#${ m2 })"/>
<path d="M-46 34 Q-10 26 46 36 V46 H-46 Z" fill="#134e35"/>
${ pines }</g>
<circle cx="0" cy="0" r="44" fill="none" stroke="#fff" stroke-width="3" opacity="0.85"/>
<circle cx="0" cy="0" r="46.5" fill="none" stroke="#000" stroke-width="1" opacity="0.15"/>`;
			return { defs, body };
		},
	},

	globe: {
		label: '지구본', hue: 205,
		draw( P, u ) {
			const oc = u( 'oc' ), hl = u( 'hl' ), clip = u( 'clip' ), atm = u( 'atm' );
			const defs = RG( oc, -12, -14, 56, [ [ 0, '#67c3ff' ], [ 0.55, '#1e78d6' ], [ 1, '#0b3a86' ] ] ) +
				RG( hl, -18, -22, 26, [ [ 0, '#fff', 0.55 ], [ 1, '#fff', 0 ] ] ) +
				RG( atm, 0, 0, 48, [ [ 0.82, '#7dd3fc', 0 ], [ 1, '#7dd3fc', 0.55 ] ] ) +
				`<clipPath id="${ clip }"><circle cx="0" cy="0" r="38"/></clipPath>`;
			const body = `<circle cx="0" cy="0" r="48" fill="url(#${ atm })"/>
<circle cx="0" cy="0" r="38" fill="url(#${ oc })"/>
<g clip-path="url(#${ clip })">
<path d="M-30 -16 C-24 -30 -6 -30 -2 -20 C2 -12 -8 -6 -12 2 C-16 10 -24 4 -30 -4 Z" fill="#4ade80" opacity="0.92"/>
<path d="M6 -22 C16 -30 30 -22 30 -10 C30 0 20 2 14 -4 C8 -8 2 -14 6 -22 Z" fill="#22c55e" opacity="0.9"/>
<path d="M-6 10 C2 6 10 10 12 20 C14 30 6 38 -2 34 C-8 28 -12 16 -6 10 Z" fill="#4ade80" opacity="0.92"/>
<path d="M18 14 C24 10 32 14 30 22 C28 28 20 28 18 22 Z" fill="#22c55e" opacity="0.9"/>
<g fill="none" stroke="#fff" stroke-width="0.8" opacity="0.28"><ellipse cx="0" cy="0" rx="38" ry="12"/><ellipse cx="0" cy="0" rx="12" ry="38"/><ellipse cx="0" cy="0" rx="28" ry="38"/><path d="M-38 -20 H38 M-38 20 H38"/></g>
<circle cx="0" cy="0" r="38" fill="url(#${ hl })"/></g>
<ellipse cx="0" cy="4" rx="49" ry="12" fill="none" stroke="${ P.acc }" stroke-width="2.2" transform="rotate(-20)" opacity="0.95" stroke-dasharray="60 8"/>
<circle cx="44" cy="-10" r="3.2" fill="#fff" stroke="${ P.acc }" stroke-width="1.6"/>`;
			return { defs, body, };
		},
	},

	bulb: {
		label: '전구(아이디어)', hue: 44, floating: true,
		draw( P, u ) {
			const glass = u( 'glass' ), glow = u( 'glow' ), metal = u( 'metal' );
			const defs = RG( glass, -6, -20, 30, [ [ 0, '#fffbe0' ], [ 0.55, '#fde047' ], [ 1, '#f59e0b' ] ] ) +
				RG( glow, 0, -10, 50, [ [ 0, '#fde68a', 0.55 ], [ 1, '#fde68a', 0 ] ] ) +
				LG( metal, -12, 0, 12, 0, [ [ 0, '#64748b' ], [ 0.45, '#e2e8f0' ], [ 1, '#64748b' ] ] );
			const rays = [ ...Array( 9 ).keys() ].map( ( i ) => { const a = ( -180 + i * 22.5 ) * Math.PI / 180; return `<path d="M${ ( Math.cos( a ) * 34 ).toFixed( 1 ) } ${ ( -10 + Math.sin( a ) * 34 ).toFixed( 1 ) } L${ ( Math.cos( a ) * 44 ).toFixed( 1 ) } ${ ( -10 + Math.sin( a ) * 44 ).toFixed( 1 ) }"/>`; } ).join( '' );
			const body = `<circle cx="0" cy="-10" r="50" fill="url(#${ glow })"/>
<g stroke="${ P.acc }" stroke-width="2.6" stroke-linecap="round" opacity="0.9">${ rays }</g>
<path d="M-11 12 C-11 4 -26 -2 -26 -18 C-26 -32 -14 -40 0 -40 C14 -40 26 -32 26 -18 C26 -2 11 4 11 12 Z" fill="url(#${ glass })"/>
<path d="M-15 -30 C-20 -26 -22 -18 -20 -10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.7"/>
<path d="M-6 12 V-6 L-3 -12 L0 -6 L3 -12 L6 -6 V12" fill="none" stroke="#b45309" stroke-width="1.6" stroke-linejoin="round"/>
<rect x="-11" y="12" width="22" height="6" rx="2" fill="url(#${ metal })"/>
<rect x="-10" y="19" width="20" height="5" rx="2" fill="url(#${ metal })"/>
<rect x="-9" y="26" width="18" height="5" rx="2" fill="url(#${ metal })"/>
<path d="M-5 32 H5 L3 36 H-3 Z" fill="#334155"/>`;
			return { defs, body };
		},
	},

	coins: {
		label: '돈·금융', hue: 44,
		draw( P, u ) {
			const gold = u( 'gold' ), top = u( 'top' );
			const defs = LG( gold, -22, 0, 22, 0, [ [ 0, '#b7791f' ], [ 0.4, '#fde68a' ], [ 1, '#a16207' ] ] ) +
				RG( top, -6, -6, 26, [ [ 0, '#fff3b0' ], [ 1, '#f2b705' ] ] );
			const coin = ( x, y ) => `<g transform="translate(${ x } ${ y })"><path d="M-20 0 V7 A20 7 0 0 0 20 7 V0 Z" fill="url(#${ gold })"/><ellipse cx="0" cy="0" rx="20" ry="7" fill="url(#${ top })"/><ellipse cx="0" cy="0" rx="14.5" ry="4.8" fill="none" stroke="#b7791f" stroke-width="1" opacity="0.6"/></g>`;
			const body = `<g transform="translate(-12 6)">${ coin( 0, 30 ) }${ coin( 2, 22 ) }${ coin( -1, 14 ) }${ coin( 1, 6 ) }${ coin( 0, -2 ) }</g>
<g transform="translate(22 6)"><circle r="19" fill="url(#${ gold })"/><circle r="15.5" fill="url(#${ top })" stroke="#b7791f" stroke-width="1.2"/>
<g stroke="#a16207" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="-9,-7 -4.5,7 0,-3 4.5,7 9,-7"/><path d="M-11 -2 H11 M-11 2.6 H11"/></g>
<path d="M-11 -9 A15 15 0 0 1 4 -14" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="0.7"/></g>
<g fill="#fff" opacity="0.95"><path d="M-30 -30 l1.8 5 5 1.8 -5 1.8 -1.8 5 -1.8 -5 -5 -1.8 5 -1.8 Z"/><path d="M32 -30 l1.2 3.4 3.4 1.2 -3.4 1.2 -1.2 3.4 -1.2 -3.4 -3.4 -1.2 3.4 -1.2 Z"/></g>`;
			return { defs, body };
		},
	},

	bag: {
		label: '쇼핑', hue: 340,
		draw( P, u ) {
			const b1 = u( 'b1' ), b2 = u( 'b2' );
			const defs = LG( b1, -28, 0, 28, 0, [ [ 0, darken( P.c1, 0.2 ) ], [ 0.5, lighten( P.c1, 0.15 ) ], [ 1, darken( P.c1, 0.3 ) ] ] ) +
				LG( b2, -22, 0, 22, 0, [ [ 0, darken( P.acc, 0.25 ) ], [ 0.5, lighten( P.acc, 0.1 ) ], [ 1, darken( P.acc, 0.3 ) ] ] );
			const body = `<g transform="translate(14 4) rotate(9)"><path d="M-9 -14 C-9 -34 9 -34 9 -14" fill="none" stroke="${ darken( P.acc, 0.4 ) }" stroke-width="2.6"/><rect x="-22" y="-14" width="44" height="52" rx="3" fill="url(#${ b2 })"/><rect x="-22" y="-14" width="44" height="6" fill="#000" opacity="0.15"/></g>
<g transform="translate(-10 6) rotate(-6)"><path d="M-12 -14 C-12 -38 12 -38 12 -14" fill="none" stroke="${ darken( P.c1, 0.45 ) }" stroke-width="3"/>
<rect x="-28" y="-14" width="56" height="58" rx="4" fill="url(#${ b1 })"/><rect x="-28" y="-14" width="56" height="7" fill="#000" opacity="0.16"/>
<circle cx="-12" cy="-14" r="1.8" fill="#fff" opacity="0.8"/><circle cx="12" cy="-14" r="1.8" fill="#fff" opacity="0.8"/>
<circle cx="0" cy="18" r="10" fill="#fff" opacity="0.92"/><path d="M-5 18 L-1 22 L6 13" fill="none" stroke="${ P.c1 }" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M-24 -6 V38" stroke="#fff" stroke-width="2" opacity="0.18"/></g>`;
			return { defs, body };
		},
	},

	camera: {
		label: '카메라', hue: 230,
		draw( P, u ) {
			const bd = u( 'bd' ), ln = u( 'ln' ), ring = u( 'ring' );
			const defs = LG( bd, 0, -22, 0, 34, [ [ 0, '#4b5563' ], [ 1, '#111827' ] ] ) +
				RG( ln, -4, -4, 14, [ [ 0, '#a5b4fc' ], [ 0.45, '#3730a3' ], [ 1, '#0b0b1f' ] ] ) +
				LG( ring, 0, -24, 0, 24, [ [ 0, '#f1f5f9' ], [ 0.5, '#94a3b8' ], [ 1, '#475569' ] ] );
			const body = `<path d="M-16 -20 L-10 -30 H10 L16 -20 Z" fill="#1f2937"/>
<rect x="24" y="-28" width="10" height="7" rx="2" fill="#dc2626"/>
<rect x="-42" y="-20" width="84" height="54" rx="9" fill="url(#${ bd })"/>
<rect x="-42" y="-8" width="16" height="42" rx="6" fill="#0b111b" opacity="0.55"/>
<rect x="-42" y="-20" width="84" height="7" rx="4" fill="#fff" opacity="0.14"/>
<rect x="-34" y="-15" width="12" height="7" rx="1.5" fill="#fef9c3"/>
<circle cx="4" cy="8" r="25" fill="#0b111b"/><circle cx="4" cy="8" r="22" fill="url(#${ ring })"/><circle cx="4" cy="8" r="18" fill="#0b0b12"/>
<circle cx="4" cy="8" r="14" fill="url(#${ ln })"/>
<circle cx="4" cy="8" r="5" fill="#05050c"/>
<ellipse cx="-2" cy="1" rx="4.5" ry="2.6" fill="#fff" opacity="0.6" transform="rotate(-35 -2 1)"/>
<circle cx="33" cy="-10" r="2.2" fill="#f87171"/>`;
			return { defs, body };
		},
	},

	health: {
		label: '건강·의료', hue: 350,
		draw( P, u ) {
			const hr = u( 'hr' ), hl = u( 'hl' );
			const defs = RG( hr, -12, -18, 60, [ [ 0, '#ff8ba0' ], [ 0.6, '#e11d48' ], [ 1, '#9f1239' ] ] ) +
				LG( hl, 0, -36, 0, -10, [ [ 0, '#fff', 0.55 ], [ 1, '#fff', 0 ] ] );
			const body = `<path d="M0 36 C-48 6 -46 -30 -23 -37 C-11 -41 -2 -33 0 -26 C2 -33 11 -41 23 -37 C46 -30 48 6 0 36 Z" fill="url(#${ hr })"/>
<path d="M-30 -24 C-24 -32 -12 -33 -6 -26" fill="none" stroke="url(#${ hl })" stroke-width="5" stroke-linecap="round"/>
<polyline points="-36,2 -20,2 -13,-12 -3,16 5,-6 11,2 36,2" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
<g transform="translate(28 26)"><circle r="14" fill="#fff"/><circle r="14" fill="none" stroke="#e2e8f0" stroke-width="1"/><path d="M-3.5 -9 H3.5 V-3.5 H9 V3.5 H3.5 V9 H-3.5 V3.5 H-9 V-3.5 H-3.5 Z" fill="#16a34a"/></g>`;
			return { defs, body };
		},
	},

	food: {
		label: '음식', hue: 22,
		draw( P, u ) {
			const bowl = u( 'bowl' ), soup = u( 'soup' );
			const defs = LG( bowl, -38, 0, 38, 0, [ [ 0, '#d6dde6' ], [ 0.4, '#ffffff' ], [ 1, '#c3ccd8' ] ] ) +
				RG( soup, 0, -6, 38, [ [ 0, '#f59e42' ], [ 1, '#c2410c' ] ] );
			const body = `<g fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3" opacity="0.5"><path d="M-14 -22 C-20 -30 -10 -34 -16 -44"/><path d="M0 -24 C-6 -32 6 -36 0 -46"/><path d="M14 -22 C8 -30 18 -34 12 -43"/></g>
<rect x="-6" y="-38" width="3" height="40" rx="1.5" fill="#7c4a21" transform="rotate(28 0 -8) translate(-14 -6)"/>
<rect x="2" y="-38" width="3" height="40" rx="1.5" fill="#a0632c" transform="rotate(38 0 -8) translate(-6 -8)"/>
<path d="M-40 -6 H40 C40 20 24 36 0 36 C-24 36 -40 20 -40 -6 Z" fill="url(#${ bowl })"/>
<path d="M-38 12 H38" stroke="${ P.c1 }" stroke-width="3.2" opacity="0.85"/><path d="M-33 20 H33" stroke="${ P.acc }" stroke-width="2" opacity="0.9"/>
<rect x="-14" y="36" width="28" height="6" rx="2" fill="#cbd5e1"/>
<ellipse cx="0" cy="-6" rx="40" ry="10" fill="#f1f5f9"/><ellipse cx="0" cy="-6" rx="36" ry="8.2" fill="url(#${ soup })"/>
<g fill="none" stroke="#fde68a" stroke-width="2.2" stroke-linecap="round"><path d="M-28 -6 C-20 -12 -12 0 -4 -6 S10 -12 18 -6"/><path d="M-24 -2 C-16 -8 -8 4 0 -2 S14 -8 24 -3"/></g>
<g transform="translate(-12 -8)"><ellipse rx="8" ry="5" fill="#fff"/><circle cx="1" cy="0" r="2.8" fill="#f59e0b"/></g>
<g fill="#4ade80"><circle cx="12" cy="-9" r="1.6"/><circle cx="18" cy="-5" r="1.4"/><circle cx="6" cy="-4" r="1.4"/><circle cx="22" cy="-9" r="1.3"/></g>
<path d="M-32 6 C-30 16 -22 26 -12 30" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>`;
			return { defs, body };
		},
	},

	shield: {
		label: '보안', hue: 218,
		draw( P, u ) {
			const sh = u( 'sh' ), in2 = u( 'in' );
			const defs = LG( sh, -34, -42, 34, 44, [ [ 0, lighten( P.c1, 0.35 ) ], [ 1, darken( P.c2, 0.2 ) ] ] ) +
				LG( in2, 0, -36, 0, 40, [ [ 0, lighten( P.c1, 0.1 ) ], [ 1, darken( P.c1, 0.2 ) ] ] );
			const body = `<path d="M0 -44 L35 -31 V0 C35 23 17 37 0 45 C-17 37 -35 23 -35 0 V-31 Z" fill="url(#${ sh })"/>
<path d="M0 -37 L28 -27 V-1 C28 18 14 30 0 37 C-14 30 -28 18 -28 -1 V-27 Z" fill="url(#${ in2 })"/>
<path d="M0 -37 L28 -27 V-1 C28 5 26 11 23 16 C10 8 -6 -8 -10 -34 Z" fill="#fff" opacity="0.12"/>
<polyline points="-13,2 -4,13 15,-12" fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`;
			return { defs, body };
		},
	},

	airplane: {
		label: '여행·항공', hue: 200, floating: true,
		draw( P, u ) {
			const fu = u( 'fu' ), wg = u( 'wg' );
			const defs = LG( fu, -8, 0, 8, 0, [ [ 0, '#cbd5e1' ], [ 0.5, '#ffffff' ], [ 1, '#b6c2d1' ] ] ) +
				LG( wg, 0, -10, 0, 22, [ [ 0, '#f8fafc' ], [ 1, '#a3b1c4' ] ] );
			const body = `<g transform="rotate(-38)">
<path d="M-40 42 C-30 30 -20 20 -6 16" stroke="${ P.acc }" stroke-width="2.4" fill="none" stroke-dasharray="1 6" stroke-linecap="round" opacity="0.0"/>
<path d="M7 -8 L47 16 L47 23 L7 9 Z" fill="url(#${ wg })"/><path d="M-7 -8 L-47 16 L-47 23 L-7 9 Z" fill="url(#${ wg })"/>
<path d="M7 18 L22 32 L22 37 L7 31 Z" fill="url(#${ wg })"/><path d="M-7 18 L-22 32 L-22 37 L-7 31 Z" fill="url(#${ wg })"/>
<path d="M0 -47 C5.5 -47 8 -39 8 -28 V22 L0 28 L-8 22 V-28 C-8 -39 -5.5 -47 0 -47 Z" fill="url(#${ fu })"/>
<path d="M-4 -40 C-4 -44 4 -44 4 -40 L3 -34 H-3 Z" fill="${ P.c1 }"/>
<g fill="${ P.c2 }" opacity="0.8"><rect x="-2" y="-28" width="4" height="2.4" rx="1"/><rect x="-2" y="-22" width="4" height="2.4" rx="1"/><rect x="-2" y="-16" width="4" height="2.4" rx="1"/><rect x="-2" y="-10" width="4" height="2.4" rx="1"/></g>
<ellipse cx="24" cy="12" rx="3.4" ry="6" fill="#64748b"/><ellipse cx="-24" cy="12" rx="3.4" ry="6" fill="#64748b"/>
<path d="M0 -20 V20" stroke="${ P.c1 }" stroke-width="2.2" opacity="0.7"/></g>`;
			return { defs, body };
		},
	},

	chip: {
		label: 'AI·기술', hue: 252,
		draw( P, u ) {
			const bd = u( 'bd' ), core = u( 'core' );
			const defs = LG( bd, 0, -26, 0, 26, [ [ 0, '#2a3346' ], [ 1, '#0d1220' ] ] ) +
				RG( core, 0, 0, 16, [ [ 0, lighten( P.c1, 0.4 ) ], [ 1, darken( P.c2, 0.1 ) ] ] );
			const pins = [ -16, -8, 0, 8, 16 ].map( ( v ) => `<rect x="${ v - 2 }" y="-35" width="4" height="10" rx="1" fill="#cbd5e1"/><rect x="${ v - 2 }" y="25" width="4" height="10" rx="1" fill="#cbd5e1"/><rect x="-35" y="${ v - 2 }" width="10" height="4" rx="1" fill="#cbd5e1"/><rect x="25" y="${ v - 2 }" width="10" height="4" rx="1" fill="#cbd5e1"/>` ).join( '' );
			const body = `<g stroke="${ P.acc }" stroke-width="1.6" fill="none" opacity="0.9"><path d="M-16 -35 V-44 H-30"/><path d="M16 -35 V-42 H30 V-48"/><path d="M35 -8 H44 V4"/><path d="M-35 8 H-44 V22"/><path d="M8 35 V44 H24"/></g>
<g fill="${ P.acc }"><circle cx="-30" cy="-44" r="2"/><circle cx="30" cy="-48" r="2"/><circle cx="44" cy="4" r="2"/><circle cx="-44" cy="22" r="2"/><circle cx="24" cy="44" r="2"/></g>
${ pins }
<rect x="-26" y="-26" width="52" height="52" rx="7" fill="url(#${ bd })"/>
<rect x="-26" y="-26" width="52" height="52" rx="7" fill="none" stroke="#475569" stroke-width="1"/>
<rect x="-17" y="-17" width="34" height="34" rx="4" fill="url(#${ core })"/>
<text x="0" y="6.2" text-anchor="middle" font-size="16" font-weight="700" fill="#fff" font-family="Noto Sans KR, sans-serif">AI</text>
<rect x="-26" y="-26" width="52" height="8" rx="4" fill="#fff" opacity="0.08"/>`;
			return { defs, body };
		},
	},

	calendar: {
		label: '일정·시간', hue: 262,
		draw( P, u ) {
			const card = u( 'card' ), head = u( 'head' );
			const defs = LG( card, 0, -34, 0, 40, [ [ 0, '#ffffff' ], [ 1, '#e6ebf3' ] ] ) +
				LG( head, 0, -34, 0, -16, [ [ 0, lighten( P.c1, 0.15 ) ], [ 1, darken( P.c2, 0.1 ) ] ] );
			const cells = [ ...Array( 15 ).keys() ].map( ( i ) => { const c = i % 5, r = Math.floor( i / 5 ); const hi = i === 7; return `<rect x="${ -29 + c * 12.5 }" y="${ -10 + r * 12 }" width="9" height="8" rx="2" fill="${ hi ? P.acc : '#cbd5e1' }" opacity="${ hi ? 1 : 0.7 }"/>`; } ).join( '' );
			const body = `<rect x="-36" y="-34" width="72" height="72" rx="8" fill="url(#${ card })" stroke="#cbd5e1"/>
<path d="M-36 -26 A8 8 0 0 1 -28 -34 H28 A8 8 0 0 1 36 -26 V-16 H-36 Z" fill="url(#${ head })"/>
<rect x="-22" y="-40" width="5" height="12" rx="2.5" fill="#94a3b8"/><rect x="17" y="-40" width="5" height="12" rx="2.5" fill="#94a3b8"/>
<text x="0" y="-21" text-anchor="middle" font-size="8" font-weight="700" fill="#fff" font-family="Noto Sans KR, sans-serif">CALENDAR</text>
${ cells }
<g transform="translate(24 28)"><circle r="17" fill="#fff" stroke="${ P.c2 }" stroke-width="3"/><path d="M0 -10 V0 L7 4" stroke="${ P.c2 }" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle r="1.8" fill="${ P.acc }"/></g>`;
			return { defs, body };
		},
	},

	dumbbell: {
		label: '운동', hue: 12,
		draw( P, u ) {
			const pl = u( 'pl' ), bar = u( 'bar' );
			const defs = LG( pl, 0, -22, 0, 22, [ [ 0, '#4b5563' ], [ 0.5, '#1f2937' ], [ 1, '#0b111b' ] ] ) +
				LG( bar, 0, -4, 0, 4, [ [ 0, '#f1f5f9' ], [ 0.5, '#94a3b8' ], [ 1, '#e2e8f0' ] ] );
			const plate = ( x, w, h ) => `<rect x="${ x }" y="${ -h / 2 }" width="${ w }" height="${ h }" rx="3" fill="url(#${ pl })"/><rect x="${ x + 1.5 }" y="${ -h / 2 + 2 }" width="1.8" height="${ h - 4 }" rx="0.9" fill="#fff" opacity="0.25"/>`;
			const body = `<g transform="rotate(-24)">
<rect x="-34" y="-3.2" width="68" height="6.4" rx="3" fill="url(#${ bar })"/>
${ plate( -36, 8, 46 ) }${ plate( -45, 9, 34 ) }${ plate( 28, 8, 46 ) }${ plate( 36, 9, 34 ) }
<rect x="-45" y="-2" width="2.6" height="4" fill="${ P.acc }"/><rect x="42.4" y="-2" width="2.6" height="4" fill="${ P.acc }"/>
<rect x="-12" y="-3.6" width="24" height="7.2" rx="2" fill="#0b111b" opacity="0.5"/>
</g>`;
			return { defs, body };
		},
	},

	cap: {
		label: '교육·학위', hue: 232,
		draw( P, u ) {
			const top = u( 'top' ), base = u( 'base' );
			const defs = LG( top, -46, -22, 46, 10, [ [ 0, '#374151' ], [ 1, '#0b111b' ] ] ) +
				LG( base, 0, 0, 0, 30, [ [ 0, '#1f2937' ], [ 1, '#05080f' ] ] );
			const body = `<path d="M-25 2 V20 Q0 36 25 20 V2 Q0 14 -25 2 Z" fill="url(#${ base })"/>
<path d="M0 -24 L47 -6 L0 12 L-47 -6 Z" fill="url(#${ top })"/>
<path d="M0 -24 L47 -6 L0 -6 Z" fill="#fff" opacity="0.1"/>
<path d="M0 -6 L38 -2 V22" stroke="${ P.acc }" stroke-width="2" fill="none" stroke-linecap="round"/>
<rect x="35.5" y="20" width="5" height="12" rx="2" fill="${ P.acc }"/>
<circle cx="0" cy="-6" r="3" fill="${ P.acc }"/>`;
			return { defs, body };
		},
	},

	document: {
		label: '서류·신청', hue: 210,
		draw( P, u ) {
			const pg = u( 'pg' );
			const defs = LG( pg, 0, -40, 0, 38, [ [ 0, '#ffffff' ], [ 1, '#e5ebf3' ] ] );
			const rows = [ 0, 1, 2, 3 ].map( ( i ) => `<rect x="-19" y="${ -6 + i * 12 }" width="7" height="7" rx="1.6" fill="none" stroke="${ P.c1 }" stroke-width="1.5"/><path d="M-17.6 ${ -2.4 + i * 12 } l2 2 l3.4 -4.6" stroke="${ P.acc }" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${ i === 3 ? 0 : 1 }"/><rect x="-7" y="${ -4 + i * 12 }" width="${ 30 - i * 3 }" height="3" rx="1.5" fill="#94a3b8" opacity="0.7"/>` ).join( '' );
			const body = `<rect x="-26" y="-38" width="56" height="76" rx="3" fill="#cbd5e1" transform="rotate(6 0 0)"/>
<path d="M-30 -40 H14 L30 -24 V36 A3 3 0 0 1 27 39 H-27 A3 3 0 0 1 -30 36 Z" fill="url(#${ pg })" stroke="#cbd5e1"/>
<path d="M14 -40 V-27 A3 3 0 0 0 17 -24 H30 Z" fill="#cbd5e1"/>
<rect x="-22" y="-32" width="26" height="5" rx="2" fill="${ P.c1 }"/><rect x="-22" y="-23" width="18" height="2.6" rx="1.3" fill="#94a3b8" opacity="0.7"/>
${ rows }
<g transform="translate(16 30) rotate(-14)"><circle r="10" fill="none" stroke="#dc2626" stroke-width="2" opacity="0.85"/><circle r="7.4" fill="none" stroke="#dc2626" stroke-width="0.8" opacity="0.85"/><path d="M-4 0 l3 3 l5 -6" stroke="#dc2626" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/></g>`;
			return { defs, body };
		},
	},

	cloud: {
		label: '클라우드·서버', hue: 208, floating: true,
		draw( P, u ) {
			const cl = u( 'cl' ), sv = u( 'sv' );
			const defs = LG( cl, 0, -34, 0, 22, [ [ 0, '#ffffff' ], [ 1, lighten( P.c1, 0.55 ) ] ] ) +
				LG( sv, 0, 22, 0, 46, [ [ 0, '#334155' ], [ 1, '#0f172a' ] ] );
			const body = `<g transform="translate(0 -6)"><g fill="url(#${ cl })"><circle cx="-18" cy="0" r="15"/><circle cx="2" cy="-10" r="21"/><circle cx="23" cy="0" r="16"/><rect x="-32" y="0" width="70" height="16" rx="8"/></g>
<path d="M0 -2 V16 M-8 6 L0 -2 L8 6" stroke="${ P.c1 }" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
<g transform="translate(0 6)"><rect x="-18" y="24" width="36" height="8" rx="2.5" fill="url(#${ sv })"/><rect x="-18" y="34" width="36" height="8" rx="2.5" fill="url(#${ sv })"/>
<circle cx="-12" cy="28" r="1.5" fill="#34d399"/><circle cx="-12" cy="38" r="1.5" fill="${ P.acc }"/><rect x="-4" y="27" width="16" height="2" rx="1" fill="#64748b"/><rect x="-4" y="37" width="16" height="2" rx="1" fill="#64748b"/>
<path d="M0 22 V24" stroke="#94a3b8" stroke-width="2" stroke-dasharray="1 2"/></g>`;
			return { defs, body };
		},
	},

	magnifier: {
		label: '검색·분석', hue: 196,
		draw( P, u ) {
			const rim = u( 'rim' ), lens = u( 'lens' ), hd = u( 'hd' );
			const defs = LG( rim, -30, -30, 30, 30, [ [ 0, '#f8fafc' ], [ 0.5, '#94a3b8' ], [ 1, '#475569' ] ] ) +
				RG( lens, -8, -10, 30, [ [ 0, '#e0f2fe', 0.95 ], [ 1, lighten( P.c1, 0.5 ), 0.8 ] ] ) +
				LG( hd, 0, 0, 0, 20, [ [ 0, darken( P.c2, 0.3 ) ], [ 1, darken( P.c2, 0.6 ) ] ] );
			const body = `<g transform="rotate(-45) translate(0 -2)"><rect x="-6" y="30" width="12" height="26" rx="5" fill="url(#${ hd })" transform="translate(0 -6)"/><rect x="-3.5" y="27" width="7" height="8" fill="#64748b"/></g>
<circle cx="-6" cy="-6" r="30" fill="url(#${ lens })"/>
<g opacity="0.9"><rect x="-22" y="0" width="7" height="14" rx="1.6" fill="${ P.c1 }"/><rect x="-12" y="-8" width="7" height="22" rx="1.6" fill="${ P.c2 }"/><rect x="-2" y="-14" width="7" height="28" rx="1.6" fill="${ P.acc }"/><rect x="8" y="-4" width="7" height="18" rx="1.6" fill="${ P.c1 }"/></g>
<circle cx="-6" cy="-6" r="30" fill="none" stroke="url(#${ rim })" stroke-width="6"/>
<path d="M-26 -18 C-22 -28 -12 -33 -2 -33" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" opacity="0.8"/>`;
			return { defs, body };
		},
	},
};

export const OBJECT_KEYS = Object.keys( OBJECTS );

/**
 * LLM이 <use href="#obj-키" x y width height/> 로 가져다 쓸 수 있는 <symbol> 모음.
 * 각 심볼은 100x100 박스(viewBox -50 -50 100 100)에 그려진다. 자체 팔레트를 쓰고
 * 내부 id는 키 접두어로 유일하게 만들어 서로 충돌하지 않는다.
 */
export function buildSymbols( keys ) {
	return keys.filter( ( k ) => OBJECTS[ k ] ).map( ( key ) => {
		const P = makePalette( OBJECTS[ key ].hue );
		let n = 0;
		const { defs, body } = OBJECTS[ key ].draw( P, ( name ) => `sym-${ key }-${ name }${ ++n }` );
		return `<symbol id="obj-${ key }" viewBox="-50 -50 100 100" overflow="visible">${ defs }${ body }</symbol>`;
	} ).join( '' );
}

/** 프롬프트에 안내할 심볼 목록(키: 설명). */
export function symbolCatalog() {
	return OBJECT_KEYS.map( ( k ) => `obj-${ k } (${ OBJECTS[ k ].label })` ).join( ', ' );
}
