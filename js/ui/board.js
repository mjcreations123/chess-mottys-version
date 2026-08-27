// BoardView: renders the 8x8, pieces, drag + tap input, promotion, and the
// homecoming animation for a resurrected piece. Pure view; the match logic
// lives in core/exchange.js.

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
    this.squareSelector = null;
    this.busy = false;             // true while an animation runs
    this.renderVersion = 0;        // invalidates animation work after a new position
    this.promotionCancel = null;
    this.focusSq = 'e2';
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('tabindex', '-1');
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
      html += '<div class="board-row" role="row">';
      for (let col = 0; col < 8; col++) {
        const sq = this.rcToSquare(row, col);
        const light = (row + col) % 2 === 0;
        html += `<div class="sq sq--${light ? 'light' : 'dark'}" id="sq-${sq}" role="gridcell" aria-label="${sq}, empty" data-sq="${sq}" style="transform:translate(${col * 100}%,${row * 100}%)">`;
        if (col === 0) html += `<span class="coord coord--rank coord--on-${light ? 'light' : 'dark'}">${sq[1]}</span>`;
        if (row === 7) html += `<span class="coord coord--file coord--on-${light ? 'light' : 'dark'}">${sq[0]}</span>`;
        html += '</div>';
      }
      html += '</div>';
    }
    this.el.insertAdjacentHTML('afterbegin', html);
    this.#syncFocus();
  }

  setOrientation(color) {
    const want = color === 'b';
    if (want === this.flipped) return;
    this.#invalidateTransientState();
    this.flipped = want;
    for (const row of this.el.querySelectorAll('.board-row')) row.remove();
    this.#buildSquares();
    for (const [sq, elm] of this.pieces) this.#place(elm, sq);
    for (const [, o] of this.overlays) o.remove();
    this.overlays.clear();
    this.#applySquareStates();
  }

  /* ---------- pieces ---------- */
  setPosition(map) {
    this.#invalidateTransientState();
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
    elm.setAttribute('aria-hidden', 'true');
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
    const version = this.renderVersion;
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
    if (version !== this.renderVersion) return;
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

  // A dead piece coming home: a burst on the home square, and the piece
  // scales in from nothing where it started the game.
  async animateResurrection({ square, color, type }) {
    const version = this.renderVersion;
    this.busy = true;
    const cell = this.el.querySelector(`[data-sq="${square}"]`);
    const burst = document.createElement('div');
    burst.className = 'return-burst';
    burst.setAttribute('aria-hidden', 'true');
    this.#place(burst, square);
    this.el.appendChild(burst);
    cell?.classList.add('sq--homecoming');

    const piece = this.#spawn(square, { color, type });
    if (!this.reduceMotion) {
      const resting = piece.style.transform;
      const animation = piece.animate([
        { transform: `${resting} scale(.05) rotate(-22deg)`, opacity: 0, filter: 'blur(2px)' },
        { transform: `${resting} scale(1.14) rotate(4deg)`, opacity: 1, filter: 'blur(0)', offset: .72 },
        { transform: `${resting} scale(1) rotate(0deg)`, opacity: 1, filter: 'blur(0)' },
      ], { duration: 560, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill: 'forwards' });
      await Promise.race([animation.finished.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 820))]);
    }

    burst.remove();
    cell?.classList.remove('sq--homecoming');
    if (version !== this.renderVersion) return;
    try { navigator.vibrate?.([24, 20, 18]); } catch {}
    this.busy = false;
  }

  /* ---------- overlays ---------- */
  #overlay(key, sq, cls) {
    // Reusing a key must never orphan the previous node. The map would simply
    // point at the new one and the old element would stay on the board with
    // nothing tracking it, which is how stray dots used to survive a whole game.
    const previous = this.overlays.get(key);
    if (previous) previous.remove();
    const elm = document.createElement('div');
    elm.className = `overlay ${cls}`;
    elm.setAttribute('aria-hidden', 'true');
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
  #applySquareStates() {
    for (const cell of this.el.querySelectorAll('.sq')) {
      const square = cell.dataset.sq;
      cell.classList.toggle('sq--home-choice', !!this.squareSelector?.eligible.has(square));
    }
    this.#updateSquareLabels();
  }
  setCheck(sq) {
    this.#clearOverlays('check:');
    if (sq) this.#overlay(`check:${sq}`, sq, 'overlay--check');
  }
  #showHints(moves) {
    this.#clearOverlays('hint:');
    // A promoting pawn returns four moves to the same square, one per piece it
    // could become. That is one destination, so it gets one marker.
    const seen = new Set();
    for (const m of moves) {
      if (seen.has(m.to)) continue;
      seen.add(m.to);
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
    this.#cancelPromotion();
    this.squareSelector = null;
    this.interactiveColor = color;
    this.legalProvider = legalProvider || (() => []);
    this.#select(null);
    for (const [, elm] of this.pieces) {
      elm.classList.toggle('piece--draggable', !!color && elm.dataset.color === color);
    }
    this.el.setAttribute('aria-disabled', color ? 'false' : 'true');
    this.el.tabIndex = color ? 0 : -1;
    this.el.setAttribute('aria-label', 'Chess board. Use arrow keys to move between squares and Enter to select.');
    this.#applySquareStates();
  }

  // Offer a set of squares to tap (used to pick which home square a
  // returning piece lands on).
  setSquareSelection(squares, onSelect, {
    instruction = 'Choose a highlighted square. Use arrow keys and press Enter to select, or Escape to cancel.',
    choiceLabel = 'available',
    onCancel = null,
  } = {}) {
    this.#cancelPromotion();
    this.interactiveColor = null;
    this.legalProvider = () => [];
    this.#select(null);
    this.squareSelector = {
      eligible: new Set(squares || []),
      onSelect: onSelect || (() => {}),
      choiceLabel,
      onCancel,
    };
    for (const [, elm] of this.pieces) elm.classList.remove('piece--draggable');
    if (!this.squareSelector.eligible.has(this.focusSq)) {
      this.focusSq = this.squareSelector.eligible.values().next().value || this.focusSq;
      this.#syncFocus();
    }
    this.el.setAttribute('aria-disabled', 'false');
    this.el.tabIndex = 0;
    this.el.setAttribute('aria-label', instruction);
    this.#applySquareStates();
  }

  #bindPointer() {
    this.el.addEventListener('pointerdown', (e) => this.#down(e));
    this.el.addEventListener('pointermove', (e) => this.#move(e));
    this.el.addEventListener('pointerup', (e) => this.#up(e));
    this.el.addEventListener('pointercancel', () => this.#cancelDrag());
    this.el.addEventListener('click', (e) => {
      if (!this.squareSelector || this.busy) return;
      const square = this.#squareFromEvent(e);
      if (square) this.#activateSquare(square);
    });
  }
  #bindKeyboard() {
    this.el.addEventListener('keydown', (e) => {
      // Keys steer the board only when the board itself is focused. The
      // promotion popup's buttons live inside the board element, and
      // swallowing their Enter/Space here made promotion unreachable by
      // keyboard.
      if (e.target !== this.el) return;
      if (e.key === 'Escape' && this.squareSelector?.onCancel && !this.busy) {
        e.preventDefault();
        const callback = this.squareSelector.onCancel;
        this.squareSelector = null;
        this.#applySquareStates();
        callback();
        return;
      }
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
      if ((e.key === 'Enter' || e.key === ' ') && (this.interactiveColor || this.squareSelector) && !this.busy) {
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
      const choice = this.squareSelector?.eligible.has(sq.dataset.sq) ? `, ${this.squareSelector.choiceLabel}` : '';
      sq.setAttribute('aria-label', `${sq.dataset.sq}, ${suffix}${choice}${selected}`);
    }
  }
  #activateSquare(sq) {
    if (this.squareSelector) {
      if (!this.squareSelector.eligible.has(sq)) return;
      const callback = this.squareSelector.onSelect;
      this.squareSelector = null;
      this.#applySquareStates();
      callback(sq);
      return;
    }
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
    if (this.squareSelector || !this.interactiveColor || this.busy) return;
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
    this.#cancelPromotion();
    return new Promise((resolve) => {
      const { row, col } = this.squareToRC(sq);
      const box = document.createElement('div');
      box.className = 'promo';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (this.promotionCancel === cancel) this.promotionCancel = null;
        box.remove();
        resolve(value);
      };
      const cancel = () => finish(null);
      this.promotionCancel = cancel;
      const goingDown = row === 0;
      box.style.left = `${col * 12.5}%`;
      box.style[goingDown ? 'top' : 'bottom'] = '0';
      const promoNames = { q: 'queen', n: 'knight', r: 'rook', b: 'bishop' };
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `Promote to ${promoNames[t]}`);
        b.innerHTML = pieceUse(color, t);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); finish(t); });
        box.appendChild(b);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'promo__close';
      x.setAttribute('aria-label', 'Cancel promotion');
      x.textContent = '×';
      x.addEventListener('pointerdown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); finish(null); });
      box.appendChild(x);
      this.el.appendChild(box);
    });
  }

  #cancelPromotion() {
    const cancel = this.promotionCancel;
    this.promotionCancel = null;
    cancel?.();
  }

  #invalidateTransientState() {
    this.renderVersion++;
    this.busy = false;
    if (this.drag) {
      this.drag.elm.classList.remove('piece--dragging');
      this.drag = null;
    }
    this.#cancelPromotion();
    for (const transient of this.el.querySelectorAll('.return-burst, .promo')) transient.remove();
    for (const cell of this.el.querySelectorAll('.sq--homecoming')) {
      cell.classList.remove('sq--homecoming');
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
