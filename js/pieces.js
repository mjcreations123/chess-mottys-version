// Neo-soft piece set (45×45 viewBox) + the Bureau badge. Original artwork:
// chunky rounded silhouettes in the register of modern chess apps — soft
// curves, stubby proportions, minimal interior detail. Color travels via
// CSS custom properties (--pf fill, --ps stroke, --psw stroke width), the
// only styles that pierce <use> shadow DOM.

const BASE = 'M14 33.4 H31 C33.4 33.4 35 35 35 37 C35 38.8 33.6 40 31.8 40 H13.2 C11.4 40 10 38.8 10 37 C10 35 11.6 33.4 14 33.4 Z';

const KNIGHT_BODY = 'M12.9 19.2 C10.9 18.8 10.3 16.4 11.8 15.2 L14.3 13.2 C14.9 9.7 16.8 7 19.6 5.7 L20.9 2.9 C21.2 2.2 22.1 2.1 22.6 2.7 L24.3 4.9 C29.2 5.6 32.5 9.4 33.3 15.1 C33.9 19.6 34.1 26.2 34 33.4 H17.9 C19 29.3 19.3 25.9 18.3 23.4 C17.6 21.7 16 20.4 13.9 19.9 Z';

const DEFS = `
<symbol id="p-p" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="M17.2 12.3 a5.3 5.3 0 1 1 10.6 0 a5.3 5.3 0 1 1 -10.6 0 Z
    M19.4 16.8 H25.6 C25.8 20.2 26.8 23 28.4 25.6 C29.5 27.6 30.2 30 30.4 33.4 H14.6 C14.8 30 15.5 27.6 16.6 25.6 C18.2 23 19.2 20.2 19.4 16.8 Z
    ${BASE}"/>
</symbol>
<symbol id="p-r" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="M13.2 12.4 V8.8 Q13.2 6.8 15.2 6.8 H16.4 Q18.4 6.8 18.4 8.8 V10.2 H19.9 V8.8 Q19.9 6.8 21.9 6.8 H23.1 Q25.1 6.8 25.1 8.8 V10.2 H26.6 V8.8 Q26.6 6.8 28.6 6.8 H29.8 Q31.8 6.8 31.8 8.8 V12.4 Q31.8 13.8 30.8 14.6 L29.6 15.6 V28.6 L31.2 31 Q31.9 32.2 30.9 33.4 H14.1 Q13.1 32.2 13.8 31 L15.4 28.6 V15.6 L14.2 14.6 Q13.2 13.8 13.2 12.4 Z
    ${BASE}"/>
  <path class="detail" fill="none" stroke="var(--pd, var(--ps))" stroke-width="1.2" stroke-linecap="round" d="M16.8 15.9 H28.2 M17 28.3 H28"/>
</symbol>
<symbol id="p-n" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="${KNIGHT_BODY}
    ${BASE}"/>
  <path class="eye" fill="var(--pd, var(--ps))" d="M18.5 11.6 a1.3 1.3 0 1 1 2.6 0 a1.3 1.3 0 1 1 -2.6 0 Z"/>
  <path class="detail" fill="none" stroke="var(--pd, var(--ps))" stroke-width="1.2" stroke-linecap="round" d="M24.9 8.3 C27.7 9.6 29.6 12.2 30.3 15.8"/>
</symbol>
<symbol id="p-b" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="M20.4 5.4 a2.1 2.1 0 1 1 4.2 0 a2.1 2.1 0 1 1 -4.2 0 Z
    M22.5 9 C27 12.1 29.2 15.9 29.2 19.9 C29.2 24.3 26.4 27.1 22.5 27.1 C18.6 27.1 15.8 24.3 15.8 19.9 C15.8 15.9 18 12.1 22.5 9 Z
    M18.7 27.1 H26.3 C27.7 27.1 28.7 28.3 28.4 29.7 L27.6 33.4 H17.4 L16.6 29.7 C16.3 28.3 17.3 27.1 18.7 27.1 Z
    ${BASE}"/>
  <path class="detail" fill="none" stroke="var(--pd, var(--ps))" stroke-width="1.2" stroke-linecap="round" d="M20.2 19.6 L24.9 14.3"/>
</symbol>
<symbol id="p-q" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="M10.4 10.8 a2.2 2.2 0 1 1 4.4 0 a2.2 2.2 0 1 1 -4.4 0 Z
    M20.3 7 a2.2 2.2 0 1 1 4.4 0 a2.2 2.2 0 1 1 -4.4 0 Z
    M30.2 10.8 a2.2 2.2 0 1 1 4.4 0 a2.2 2.2 0 1 1 -4.4 0 Z
    M13.5 13.6 L16.4 24 H28.6 L31.5 13.6 C29.3 16.2 27.2 17.5 25.5 17.5 C24 17.5 22.9 15.9 22.5 12.9 C22.1 15.9 21 17.5 19.5 17.5 C17.8 17.5 15.7 16.2 13.5 13.6 Z
    M16 24 C16.7 27.3 16.2 30.3 14.8 33.4 H30.2 C28.8 30.3 28.3 27.3 29 24 Z
    ${BASE}"/>
</symbol>
<symbol id="p-k" viewBox="0 0 45 45">
  <path class="body" fill="var(--pf)" stroke="var(--ps)" stroke-width="var(--psw)" stroke-linejoin="round" stroke-linecap="round" d="M21.1 2.6 H23.9 Q24.6 2.6 24.6 3.3 V5 H26.3 Q27 5 27 5.7 V8.1 Q27 8.8 26.3 8.8 H24.6 V10.4 Q24.6 11.1 23.9 11.1 H21.1 Q20.4 11.1 20.4 10.4 V8.8 H18.7 Q18 8.8 18 8.1 V5.7 Q18 5 18.7 5 H20.4 V3.3 Q20.4 2.6 21.1 2.6 Z
    M22.5 11.6 C28.2 11.6 32.2 14.9 32.2 19.5 C32.2 22.7 30.3 25.3 27.3 26.6 H17.7 C14.7 25.3 12.8 22.7 12.8 19.5 C12.8 14.9 16.8 11.6 22.5 11.6 Z
    M18.2 26.6 H26.8 C28.2 26.6 29.2 27.8 28.9 29.2 L28 33.4 H17 L16.1 29.2 C15.8 27.8 16.8 26.6 18.2 26.6 Z
    ${BASE}"/>
  <path class="detail" fill="none" stroke="var(--pd, var(--ps))" stroke-width="1.2" stroke-linecap="round" d="M14.4 18.6 H30.6"/>
</symbol>
<symbol id="crest" viewBox="0 0 52 62">
  <path d="M26 2 L47 13 L47 41 L26 54 L5 41 L5 13 Z" fill="#10151d" stroke="var(--accent, #45e3ff)" stroke-width="2.5" stroke-linejoin="round"/>
  <g transform="translate(8.6, 8.5) scale(0.78)">
    <path d="${KNIGHT_BODY}" fill="#e7edf4"/>
  </g>
  <rect x="6" y="44" width="40" height="8" rx="2" fill="var(--accent, #45e3ff)"/>
  <text x="26" y="49.8" text-anchor="middle" font-family="Bricolage Grotesque, sans-serif" font-size="4.7" font-weight="800" letter-spacing="0.55" fill="#06232b">LEX MOTTUS</text>
</symbol>`;

export function injectSprite() {
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'absolute';
  holder.style.width = '0';
  holder.style.height = '0';
  holder.style.overflow = 'hidden';
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${DEFS}</svg>`;
  document.body.prepend(holder);
}

export const pieceSVG = (type) =>
  `<svg viewBox="0 0 45 45" aria-hidden="true"><use href="#p-${type}"/></svg>`;

export const crestSVG = () =>
  `<svg viewBox="0 0 52 62" aria-hidden="true"><use href="#crest"/></svg>`;

export const PIECE_NAMES = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};
