// Small pooled visual effects on the fx layer: ghosts, rings, specks,
// flashes, and the rubber stamp. Transform/opacity only.

import { xyOf } from './board.js';
import { pieceSVG } from '../pieces.js';

const position = (el, sq) => {
  const { x, y } = xyOf(sq);
  el.style.transform = `translate(${x}%, ${y}%)`;
};

export class Effects {
  constructor(fxEl) {
    this.fxEl = fxEl;
  }

  ghost(sq, type, color, ms = 400) {
    const el = document.createElement('div');
    el.className = `fx-ghost piece--${color}`;
    el.innerHTML = pieceSVG(type);
    position(el, sq);
    this.fxEl.appendChild(el);
    el.animate(
      [{ opacity: 0.3 }, { opacity: 0 }],
      { duration: ms, easing: 'ease-out', fill: 'forwards' }
    ).finished.finally(() => el.remove());
  }

  ring(sq, ms = 380) {
    const el = document.createElement('div');
    el.className = 'fx-ring';
    const { x, y } = xyOf(sq);
    el.style.transform = `translate(${x}%, ${y}%) scale(0.5)`;
    this.fxEl.appendChild(el);
    el.animate(
      [
        { transform: `translate(${x}%, ${y}%) scale(0.5)`, opacity: 0.9 },
        { transform: `translate(${x}%, ${y}%) scale(1.4)`, opacity: 0 },
      ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' }
    ).finished.finally(() => el.remove());
  }

  flash(sq, ms = 140) {
    const el = document.createElement('div');
    el.className = 'fx-flash';
    position(el, sq);
    this.fxEl.appendChild(el);
    el.animate(
      [{ opacity: 0.95 }, { opacity: 0 }],
      { duration: ms, easing: 'ease-out', fill: 'forwards' }
    ).finished.finally(() => el.remove());
  }

  specks(sq, count = 7, ms = 360) {
    const { x, y } = xyOf(sq);
    const boardPct = 12.5;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'fx-speck';
      el.style.left = `${(x / 100) * boardPct + boardPct / 2}%`;
      el.style.top = `${(y / 100) * boardPct + boardPct / 2}%`;
      this.fxEl.appendChild(el);
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.7;
      const dist = 14 + Math.random() * 14;
      el.animate(
        [
          { transform: 'translate(0, 0)', opacity: 0.85 },
          {
            transform: `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`,
            opacity: 0,
          },
        ],
        { duration: ms, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)', fill: 'forwards' }
      ).finished.finally(() => el.remove());
    }
  }

  // The rubber stamp. Slams in, lingers, fades. Returns a promise that
  // resolves when the slam lands (not when it fades) so the sequence can
  // continue while the ink dries.
  stamp(sq, text, { linger = 900 } = {}) {
    const el = document.createElement('div');
    el.className = 'stamp fx-stamp';
    el.textContent = text;
    const { x, y } = xyOf(sq);
    // stamp is bigger than a square: center it over the square
    el.style.left = `${(x / 100) * 12.5 + 6.25}%`;
    el.style.top = `${(y / 100) * 12.5 + 6.25}%`;
    el.style.transform = 'translate(-50%, -50%) rotate(-8deg) scale(1.6)';
    this.fxEl.appendChild(el);
    const slam = el.animate(
      [
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1.6)', opacity: 0 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(0.97)', opacity: 1, offset: 0.7 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1 },
      ],
      { duration: 140, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: 'forwards' }
    );
    slam.finished.then(() => {
      setTimeout(() => {
        el.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: 350, fill: 'forwards' }
        ).finished.finally(() => el.remove());
      }, linger);
    }).catch(() => el.remove());
    return slam.finished.catch(() => {});
  }
}
