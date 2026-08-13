// Hand-drawn piece set in the clean flat "app chess" style: bold rounded
// outline, soft fills, one shade accent. Original vector art (drawn by eye,
// not traced), tuned to read instantly at 40-90px.

const THEME = {
  w: { line: '#30373C', fill: '#F5F2E9', shade: '#CBC5B8', eye: '#30373C' },
  b: { line: '#121619', fill: '#354149', shade: '#667681', eye: '#E8E4DA' },
};

const SW = 4.35; // crisp at phone sizes without the toy-like heavy outline

function wrap(color, inner) {
  const c = THEME[color];
  return inner
    .replaceAll('{L}', c.line)
    .replaceAll('{F}', c.fill)
    .replaceAll('{S}', c.shade)
    .replaceAll('{E}', c.eye)
    .replaceAll('{W}', String(SW));
}

const SHAPES = {
  // Pawn: ball head, collar, flared cone, chunky pedestal
  p: `
    <path d="M40,46 C39.5,57 36,65.5 31.5,72.5 L68.5,72.5 C64,65.5 60.5,57 60,46 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <circle cx="50" cy="28.5" r="13.5" fill="{F}" stroke="{L}" stroke-width="{W}"/>
    <path d="M41,42 h18 c2.2,0 3.6,1.5 3.6,3.3 c0,1.8 -1.4,3.3 -3.6,3.3 h-18 c-2.2,0 -3.6,-1.5 -3.6,-3.3 c0,-1.8 1.4,-3.3 3.6,-3.3 z"
          fill="{F}" stroke="{L}" stroke-width="4.2" stroke-linejoin="round"/>
    <path d="M31,73 h38 c3,0 5,2 5,5 v5 c0,3 -2,5 -5,5 h-38 c-3,0 -5,-2 -5,-5 v-5 c0,-3 2,-5 5,-5 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Rook: wide crown with two notches, straight tower, stepped foot
  r: `
    <path d="M36.5,44 L34,40 V24 h9.5 v6.5 h6.5 V24 h9.5 V40 L63.5,44 L65,70 H35 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M33,70.5 h34 c2,0 3.5,1.5 3.5,3.5 v4 h-41 v-4 c0,-2 1.5,-3.5 3.5,-3.5 z"
          fill="{F}" stroke="{L}" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M30,78.5 h40 c3,0 5,2 5,4.75 c0,2.75 -2,4.75 -5,4.75 h-40 c-3,0 -5,-2 -5,-4.75 c0,-2.75 2,-4.75 5,-4.75 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M36.5,44.5 h27" stroke="{L}" stroke-width="3.6" stroke-linecap="round" fill="none"/>
  `,
  // Knight: muzzle left, deep jaw, two small ears, mane sweep down the back
  n: `
    <path d="M38,80 C36,66 30,58.5 24,53.5 C20,50.5 17,47.5 15.8,44.5 L13.6,39.8
             C12.6,37.2 14.2,35 16.8,35 C19.4,35 21.2,33.6 22.6,31.2
             C26.4,25 31.4,20.4 37.4,18.2 C38.6,17.8 39.5,17 39.9,15.7
             L41.9,9.6 C42.8,6.9 46.2,6.9 46.9,9.7 L48.2,15.4
             L52.6,8.4 C54.2,5.8 57.6,6.8 57.7,9.9 L57.9,17.3
             C64.6,22.4 69,30.6 70.3,40.5 C71.9,52.5 70.6,67 68.3,80 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M56,21.5 C62,26.8 65.8,34.6 66.9,44 C68.1,55.5 66.9,68 64.9,78.5 L59.3,78.5
             C61.4,65.5 61.7,51.5 58.7,42 C56.7,35.5 55.5,27.5 56,21.5 Z"
          fill="{S}" stroke="none"/>
    <circle cx="30.5" cy="30" r="2.5" fill="{E}"/>
    <path d="M17,40 c1.5,0.5 2.8,1.4 3.6,2.6" stroke="{L}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    <path d="M30,88 h40 c3,0 5,-2 5,-4 c0,-2.5 -2,-4.5 -5,-4.5 h-40 c-3,0 -5,2 -5,4.5 c0,2 2,4 5,4 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Bishop: ball, pointed mitre with a bold slit, collar, plinth
  b: `
    <circle cx="50" cy="12.5" r="4.6" fill="{F}" stroke="{L}" stroke-width="4.2"/>
    <path d="M50,19.5 C54.5,24.5 60.5,31.5 63,40.5 C65.2,48.5 63.8,57.5 58.5,62.5
             C54.5,66.2 45.5,66.2 41.5,62.5 C36.2,57.5 34.8,48.5 37,40.5
             C39.5,31.5 45.5,24.5 50,19.5 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M50.5,29 L58.5,40.5" stroke="{L}" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M39,66.5 h22 c2.2,0 3.6,1.5 3.6,3.3 c0,1.8 -1.4,3.3 -3.6,3.3 h-22 c-2.2,0 -3.6,-1.5 -3.6,-3.3 c0,-1.8 1.4,-3.3 3.6,-3.3 z"
          fill="{F}" stroke="{L}" stroke-width="4.2" stroke-linejoin="round"/>
    <path d="M36,74 C35,76.5 33.5,78 31.5,79.5 L68.5,79.5 C66.5,78 65,76.5 64,74 Z"
          fill="{F}" stroke="{L}" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M31,80 h38 c3,0 5,2 5,4 c0,2.5 -2,4 -5,4 h-38 c-3,0 -5,-1.5 -5,-4 c0,-2 2,-4 5,-4 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Queen: five-ball coronet with shallow points, smooth bell gown
  q: `
    <path d="M27.5,58 L20.5,32 L33.5,42.5 L36,24 L45,40.5 L50,21.5 L55,40.5 L64,24 L66.5,42.5 L79.5,32 L72.5,58
             C70,64 68.5,68 68,72 H32 C31.5,68 30,64 27.5,58 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <circle cx="19.5" cy="27" r="4.3" fill="{F}" stroke="{L}" stroke-width="3.8"/>
    <circle cx="35" cy="19.5" r="4.3" fill="{F}" stroke="{L}" stroke-width="3.8"/>
    <circle cx="50" cy="16.5" r="4.3" fill="{F}" stroke="{L}" stroke-width="3.8"/>
    <circle cx="65" cy="19.5" r="4.3" fill="{F}" stroke="{L}" stroke-width="3.8"/>
    <circle cx="80.5" cy="27" r="4.3" fill="{F}" stroke="{L}" stroke-width="3.8"/>
    <path d="M34,73 C33.5,75.5 32.5,77.5 31,79.5 L69,79.5 C67.5,77.5 66.5,75.5 66,73 Z"
          fill="{F}" stroke="{L}" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M30,80 h40 c3,0 5,2 5,4 c0,2.5 -2,4 -5,4 h-40 c-3,0 -5,-1.5 -5,-4 c0,-2 2,-4 5,-4 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // King: bold cross over a two-lobed crown with a center dip, skirt, plinth
  k: `
    <path d="M46.8,7.5 h6.4 v6.2 h6.2 v6.4 h-6.2 v6.2 h-6.4 v-6.2 h-6.2 v-6.4 h6.2 z"
          fill="{F}" stroke="{L}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M50,34.5 C52,30.5 56,28 60.5,28 C68,28 73.5,33.5 73.5,41.5 C73.5,50 67,56.5 60,60.5 L40,60.5
             C33,56.5 26.5,50 26.5,41.5 C26.5,33.5 32,28 39.5,28 C44,28 48,30.5 50,34.5 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M38.5,61 L37,72.5 H63 L61.5,61 Z"
          fill="{F}" stroke="{L}" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M35,73 C34.5,75.5 33.5,77.5 32,79.5 L68,79.5 C66.5,77.5 65.5,75.5 65,73 Z"
          fill="{F}" stroke="{L}" stroke-width="4.4" stroke-linejoin="round"/>
    <path d="M30,80 h40 c3,0 5,2 5,4 c0,2.5 -2,4 -5,4 h-40 c-3,0 -5,-1.5 -5,-4 c0,-2 2,-4 5,-4 z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M50,37 C50,44 50,50 50,57" stroke="{L}" stroke-width="3.2" stroke-linecap="round" fill="none"/>
  `,
};

export const PIECE_KEYS = ['wk', 'wq', 'wr', 'wb', 'wn', 'wp', 'bk', 'bq', 'br', 'bb', 'bn', 'bp'];

export function pieceSpriteSVG() {
  let symbols = '';
  for (const color of ['w', 'b']) {
    for (const [type, tpl] of Object.entries(SHAPES)) {
      symbols += `<symbol id="pc-${color}${type}" viewBox="0 0 100 100">${wrap(color, tpl)}</symbol>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>${symbols}</defs></svg>`;
}

export function pieceUse(color, type, extra = '') {
  return `<svg viewBox="0 0 100 100" ${extra}><use href="#pc-${color}${type}"/></svg>`;
}
