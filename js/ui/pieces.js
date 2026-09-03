// Original piece set: flat solid silhouette, thin single-weight accent line,
// no cartoon shading or "cute" detail (the old set's knight had a drawn eye
// dot and a heavy uniform 4.35px outline that read as a toy/mascot set, not
// a chess set). Geometry composed from scratch, not traced from any existing
// set or engine.

const THEME = {
  w: { fill: '#F4F1E8', line: '#2B2620' },
  b: { fill: '#23282C', line: '#0C0E0F' },
};

const SW = 2.4; // crisp thin line, not a coloring-book outline

function wrap(color, inner) {
  const c = THEME[color];
  return inner
    .replaceAll('{F}', c.fill)
    .replaceAll('{L}', c.line)
    .replaceAll('{W}', String(SW));
}

const SHAPES = {
  // Pawn: ball head, tapered body, plinth. Three shapes, nothing more.
  p: `
    <circle cx="50" cy="30" r="12" fill="{F}" stroke="{L}" stroke-width="{W}"/>
    <path d="M38,58 C39,48 43,42 50,42 C57,42 61,48 62,58 L67,72 H33 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M28,72 H72 L75,84 H25 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Rook: square crenellated tower, straight shaft, plinth.
  r: `
    <path d="M32,24 H42 V32 H48 V24 H52 V32 H58 V24 H68 V40 L62,46 V70 H38 V46 L32,40 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M30,70 H70 L74,84 H26 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Knight: horse-head profile, cut ear notch (not a drawn eye), plinth.
  n: `
    <path d="M30,84 C29,66 33,54 42,48 L36,45 L34,40.5 L40.5,38.5 L40,26 C42,22 47,21 50,24
             L54,28 C62,26 69,31 71,40 L74,58 C75,68 74,77 72,84 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M25,84 H75 L78,92 H22 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Bishop: ball finial, tapered mitre with a single diagonal slit, plinth.
  b: `
    <circle cx="50" cy="16" r="4" fill="{F}" stroke="{L}" stroke-width="{W}"/>
    <path d="M50,23 C58,32 63,42 61,54 C60,62 55,68 50,68 C45,68 40,62 39,54 C37,42 42,32 50,23 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M40,34 L60,50" stroke="{L}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    <path d="M33,68 H67 L70,80 H30 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // Queen: five-point coronet, bell gown, plinth.
  q: `
    <path d="M24,54 L20,30 L32,40 L38,20 L50,34 L62,20 L68,40 L80,30 L76,54 L70,68 H30 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <circle cx="20" cy="27" r="3.2" fill="{F}" stroke="{L}" stroke-width="2"/>
    <circle cx="38" cy="17" r="3.2" fill="{F}" stroke="{L}" stroke-width="2"/>
    <circle cx="50" cy="14" r="3.2" fill="{F}" stroke="{L}" stroke-width="2"/>
    <circle cx="62" cy="17" r="3.2" fill="{F}" stroke="{L}" stroke-width="2"/>
    <circle cx="80" cy="27" r="3.2" fill="{F}" stroke="{L}" stroke-width="2"/>
    <path d="M28,68 H72 L76,82 H24 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
  `,
  // King: cross finial, two-lobe crown, mantle, plinth.
  k: `
    <path d="M47,6 H53 V13 H60 V19 H53 V26 H47 V19 H40 V13 H47 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M36,58 C28,52 26,42 32,35 C37,29 45,29 50,35 C55,29 63,29 68,35 C74,42 72,52 64,58 Z"
          fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M35,58 H65 L68,70 H32 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
    <path d="M28,70 H72 L76,84 H24 Z" fill="{F}" stroke="{L}" stroke-width="{W}" stroke-linejoin="round"/>
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
