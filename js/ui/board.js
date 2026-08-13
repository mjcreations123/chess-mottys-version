// BoardView: renders the 8x8, the pieces, highlights, drag + tap input,
// promotion picker, and the teleport flight animation. Pure view; the match
// logic lives in core/chaos.js.

import { pieceUse } from './pieces.js';

const FILES = 'abcdefgh';

export class BoardView {
  constructor(el, { onUserMove } = {}) {
    this.el = el;
    this.onUserMove = onUserMove || (() => {});
    this.flipped = false;
    this.pieces = new Map();       // square -> element
    this.overlays = new Map();     // key -> element
    this.interactiveColor = null;
    this.legalProvider = () => [];
    this.selected = null;
    this.drag = null;
    this.busy = false;             // true while an animation runs
    this.focusSq = 'e2';
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('tabindex', '0');
    this.el.setAttribute('aria-label', 'Chess board. Use arrow keys to move between squares and Enter to select.');
    this.#buildSquares();
    this.#bindPointer();
    this.#bindKeyboard();
    new ResizeObserver(() => {
      this.el.style.setProperty('--sqpx', `${this.el.clientWidth / 8}px`);
    }).observe(this.el);
  }

  /* ---------- geometry ---------- */
  squareToRC(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]);
    const col = this.flipped ? 7 - f : f;
    const row = this.flipped ? r - 1 : 8 - r;
    return { row, col };
  }
  rcToSquare(row, col) {
    const f = this.flipped ? 7 - col : col;
    const r = this.flipped ? row + 1 : 8 - row;
    if (f < 0 || f > 7 || r < 1 || r > 8) return null;
    return FILES[f] + r;
  }
  #place(elm, sq) {
    const { row, col } = this.squareToRC(sq);
    elm.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
  }
  #pxOf(sq) {
    const { row, col } = this.squareToRC(sq);
    const s = this.el.clientWidth / 8;
    return { x: col * s, y: row * s };
  }

  /* ---------- static layers ---------- */
  #buildSquares() {
    let html = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.rcToSquare(row, col);
        const light = (row + col) % 2 === 0;
        html += `<div class="sq sq--${light ? 'light' : 'dark'}" id="sq-${sq}" role="gridcell" aria-label="${sq}, empty" data-sq="${sq}" style="transform:translate(${col * 100}%,${row * 100}%)">`;
        if (col === 0) html += `<span class="coord coord--rank coord--on-${light ? 'light' : 'dark'}">${sq[1]}</span>`;
        if (row === 7) html += `<span class="coord coord--file coord--on-${light ? 'light' : 'dark'}">${sq[0]}</span>`;
        html += '</div>';
      }
    }
    this.el.insertAdjacentHTML('afterbegin', html);
    this.#syncFocus();
  }

  setOrientation(color) {
    const want = color === 'b';
    if (want === this.flipped) return;
    this.flipped = want;
    for (const sq of this.el.querySelectorAll('.sq')) sq.remove();
    this.#buildSquares();
    for (const [sq, elm] of this.pieces) this.#place(elm, sq);
    for (const [, o] of this.overlays) o.remove();
    this.overlays.clear();
  }

  /* ---------- pieces ---------- */
  setPosition(map) {
    for (const [, elm] of this.pieces) elm.remove();
    this.pieces.clear();
    for (const [sq, p] of map) this.#spawn(sq, p);
    this.#updateSquareLabels();
  }
  #spawn(sq, p) {
    const elm = document.createElement('div');
    elm.className = 'piece';
    elm.dataset.color = p.color;
    elm.dataset.type = p.type;
    elm.innerHTML = pieceUse(p.color, p.type);
    this.#place(elm, sq);
    this.el.appendChild(elm);
    this.pieces.set(sq, elm);
    return elm;
  }
  // hard sync guard: rebuild if the DOM drifted from truth
  verify(map) {
    let ok = this.pieces.size === map.size;
    if (ok) {
      for (const [sq, p] of map) {
        const elm = this.pieces.get(sq);
        if (!elm || elm.dataset.color !== p.color || elm.dataset.type !== p.type) { ok = false; break; }
      }
    }
    if (!ok) this.setPosition(map);
    else this.#updateSquareLabels();
  }

  /* ---------- animations ---------- */
  async animateMove({ from, to, rookFrom, rookTo, epSquare, promotion, color }) {
    this.busy = true;
    const mover = this.pieces.get(from);
    if (!mover) { this.busy = false; return; }

    const victimSq = epSquare || (this.pieces.has(to) ? to : null);

    this.pieces.delete(from);
    mover.classList.add('piece--sliding');
    this.#place(mover, to);

    if (rookFrom && this.pieces.has(rookFrom)) {
      const rook = this.pieces.get(rookFrom);
      this.pieces.delete(rookFrom);
      rook.classList.add('piece--sliding');
      this.#place(rook, rookTo);
      this.pieces.set(rookTo, rook);
    }

    await wait(this.reduceMotion ? 0 : 165);
    if (victimSq && this.pieces.has(victimSq)) {
      this.pieces.get(victimSq).remove();
      this.pieces.delete(victimSq);
    }
    this.pieces.set(to, mover);
    mover.classList.remove('piece--sliding');

    if (promotion) {
      mover.dataset.type = promotion;
      mover.innerHTML = pieceUse(color, promotion);
    }
    this.busy = false;
  }

  async animateTeleport({ from, to }) {
    this.busy = true;
    const elm = this.pieces.get(from);
    if (!elm) { this.busy = false; return; }
    this.pieces.delete(from);

    if (this.reduceMotion) {
      this.#place(elm, to);
      this.pieces.set(to, elm);
      this.#updateSquareLabels();
      this.busy = false;
      return;
    }

    // ghost left behind (fill forwards + hard timeout so it can never stick)
    const ghost = elm.cloneNode(true);
    ghost.style.opacity = '.55';
    this.el.appendChild(ghost);
    ghost.animate([{ opacity: .55 }, { opacity: 0 }], { duration: 330, easing: 'ease-out', fill: 'forwards' })
      .finished.then(() => ghost.remove()).catch(() => {});
    setTimeout(() => ghost.remove(), 600);

    // flight (never allowed to hang the game loop)
    const a = this.#pxOf(from);
    const b = this.#pxOf(to);
    elm.style.transform = `translate(${b.x}px, ${b.y}px)`; // final resting spot (px == %*size)
    const anim = elm.animate([
      { transform: `translate(${a.x}px, ${a.y}px) scale(1)` },
      { transform: `translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2 - this.el.clientWidth * 0.045}px) scale(1.22)`, offset: .5 },
      { transform: `translate(${b.x}px, ${b.y}px) scale(1)` },
    ], { duration: 430, easing: 'cubic-bezier(.25,.8,.3,1)' });
    await Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
    this.#place(elm, to);
    this.pieces.set(to, elm);
    this.#updateSquareLabels();
    try { navigator.vibrate?.(22); } catch {}

    // landing ring
    const ring = document.createElement('div');
    ring.className = 'land-ring';
    const { row, col } = this.squareToRC(to);
    ring.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
    ring.style.left = '0'; ring.style.top = '0';
    this.el.appendChild(ring);
    setTimeout(() => ring.remove(), 520);
    this.busy = false;
  }

  /* ---------- overlays ---------- */
  #overlay(key, sq, cls) {
    const elm = document.createElement('div');
    elm.className = `overlay ${cls}`;
    this.#place(elm, sq);
    this.el.appendChild(elm);
    this.overlays.set(key, elm);
  }
  #clearOverlays(prefix) {
    for (const [k, o] of this.overlays) {
      if (k.startsWith(prefix)) { o.remove(); this.overlays.delete(k); }
    }
  }
  setLastMove(from, to) {
    this.#clearOverlays('last:');
    if (from) { this.#overlay(`last:${from}`, from, 'overlay--hl'); this.#overlay(`last:${to}`, to, 'overlay--hl'); }
  }
  setTeleportMarks(pairs) {
    this.#clearOverlays('tele:');
    for (const { from, to } of pairs) {
      this.#overlay(`tele:f${from}`, from, 'overlay--tele');
      this.#overlay(`tele:t${to}`, to, 'overlay--tele');
    }
    if (pairs.length) setTimeout(() => this.#clearOverlays('tele:'), 1600);
  }
  setCheck(sq) {
    this.#clearOverlays('check:');
    if (sq) this.#overlay(`check:${sq}`, sq, 'overlay--check');
  }
  #showHints(moves) {
    this.#clearOverlays('hint:');
    for (const m of moves) {
      const cap = m.captured ? 'overlay--ring' : 'overlay--dot';
      this.#overlay(`hint:${m.to}`, m.to, cap);
    }
  }
  #select(sq) {
    this.selected = sq;
    this.#clearOverlays('sel:');
    if (sq) {
      this.#overlay(`sel:${sq}`, sq, 'overlay--hl');
      this.#showHints(this.legalProvider(sq));
    } else {
      this.#showHints([]);
    }
    this.#updateSquareLabels();
  }

  /* ---------- input ---------- */
  setInteractive(color, legalProvider) {
    this.interactiveColor = color;
    this.legalProvider = legalProvider || (() => []);
    this.#select(null);
    for (const [, elm] of this.pieces) {
      elm.classList.toggle('piece--draggable', !!color && elm.dataset.color === color);
    }
    this.el.setAttribute('aria-disabled', color ? 'false' : 'true');
    this.#updateSquareLabels();
  }

  #bindPointer() {
    this.el.addEventListener('pointerdown', (e) => this.#down(e));
    this.el.addEventListener('pointermove', (e) => this.#move(e));
    this.el.addEventListener('pointerup', (e) => this.#up(e));
    this.el.addEventListener('pointercancel', () => this.#cancelDrag());
  }
  #bindKeyboard() {
    this.el.addEventListener('keydown', (e) => {
      const { row, col } = this.squareToRC(this.focusSq);
      let next = null;
      if (e.key === 'ArrowUp') next = this.rcToSquare(Math.max(0, row - 1), col);
      if (e.key === 'ArrowDown') next = this.rcToSquare(Math.min(7, row + 1), col);
      if (e.key === 'ArrowLeft') next = this.rcToSquare(row, Math.max(0, col - 1));
      if (e.key === 'ArrowRight') next = this.rcToSquare(row, Math.min(7, col + 1));
      if (next) {
        e.preventDefault();
        this.focusSq = next;
        this.#syncFocus();
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && this.interactiveColor && !this.busy) {
        e.preventDefault();
        this.#activateSquare(this.focusSq);
      }
    });
  }
  #syncFocus() {
    for (const sq of this.el.querySelectorAll('.sq')) {
      sq.toggleAttribute('data-focus', sq.dataset.sq === this.focusSq);
    }
    this.el.setAttribute('aria-activedescendant', `sq-${this.focusSq}`);
  }
  #updateSquareLabels() {
    const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    for (const sq of this.el.querySelectorAll('.sq')) {
      const piece = this.pieces.get(sq.dataset.sq);
      const suffix = piece ? `${piece.dataset.color === 'w' ? 'white' : 'black'} ${names[piece.dataset.type]}` : 'empty';
      const selected = this.selected === sq.dataset.sq ? ', selected' : '';
      sq.setAttribute('aria-label', `${sq.dataset.sq}, ${suffix}${selected}`);
    }
  }
  #activateSquare(sq) {
    const elm = this.pieces.get(sq);
    if (elm && elm.dataset.color === this.interactiveColor) {
      this.#select(sq);
      return;
    }
    if (!this.selected) return;
    const legal = this.legalProvider(this.selected).find((m) => m.to === sq);
    if (legal) this.#commit(this.selected, sq, legal);
    else this.#select(null);
  }
  #squareFromEvent(e) {
    const rect = this.el.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / (rect.width / 8));
    const row = Math.floor((e.clientY - rect.top) / (rect.height / 8));
    return this.rcToSquare(row, col);
  }
  #down(e) {
    if (!this.interactiveColor || this.busy) return;
    const sq = this.#squareFromEvent(e);
    if (!sq) return;
    const elm = this.pieces.get(sq);

    if (elm && elm.dataset.color === this.interactiveColor) {
      // pick up own piece
      this.#select(sq);
      this.el.setPointerCapture(e.pointerId);
      this.drag = { from: sq, elm, moved: false, startX: e.clientX, startY: e.clientY };
      return;
    }
    if (this.selected) this.#activateSquare(sq);
  }
  #move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    d.elm.classList.add('piece--dragging');
    const rect = this.el.getBoundingClientRect();
    const s = rect.width / 8;
    d.elm.style.transform = `translate(${e.clientX - rect.left - s / 2}px, ${e.clientY - rect.top - s / 2}px)`;
  }
  #up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.moved) return; // simple selection; wait for second tap
    d.elm.classList.remove('piece--dragging');
    const target = this.#squareFromEvent(e);
    const legal = target && this.legalProvider(d.from).find((m) => m.to === target);
    if (legal) {
      // snap into place instantly; commit without slide animation
      this.#place(d.elm, target);
      this.#commit(d.from, target, legal, { instant: true });
    } else {
      this.#place(d.elm, d.from); // snap back
    }
  }
  #cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.elm.classList.remove('piece--dragging');
    this.#place(d.elm, d.from);
  }
  async #commit(from, to, legalMove, { instant = false } = {}) {
    this.#select(null);
    let promotion;
    if (legalMove.promotion || (legalMove.flags && legalMove.flags.includes('p'))) {
      promotion = await this.askPromotion(to, this.interactiveColor);
      if (!promotion) {
        // cancelled: put the piece back
        const elm = this.pieces.get(from);
        if (elm) this.#place(elm, from);
        return;
      }
    }
    this.onUserMove({ from, to, promotion, instant });
  }

  askPromotion(sq, color) {
    return new Promise((resolve) => {
      const { row, col } = this.squareToRC(sq);
      const box = document.createElement('div');
      box.className = 'promo';
      const goingDown = row === 0;
      box.style.left = `${col * 12.5}%`;
      box.style[goingDown ? 'top' : 'bottom'] = '0';
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = pieceUse(color, t);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); box.remove(); resolve(t); });
        box.appendChild(b);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'promo__close';
      x.textContent = '×';
      x.addEventListener('pointerdown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); box.remove(); resolve(null); });
      box.appendChild(x);
      this.el.appendChild(box);
    });
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
