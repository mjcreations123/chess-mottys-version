// BoardView: renders the 8x8, pieces, the player's visible secret black hole,
// drag + tap input, promotion, and the one-use trap animation. Pure view; the
// match logic lives in core/black-hole.js.

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
    this.holeSelector = null;
    this.ownBlackHole = null;
    this.spentSquare = null;
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

  async animateBlackHole({ square }) {
    this.busy = true;
    const piece = this.pieces.get(square);
    const cell = this.el.querySelector(`[data-sq="${square}"]`);
    const burst = document.createElement('div');
    burst.className = 'hole-burst';
    burst.setAttribute('aria-hidden', 'true');
    this.#place(burst, square);
    this.el.appendChild(burst);
    cell?.classList.add('sq--imploding');

    if (!this.reduceMotion && piece) {
      const resting = piece.style.transform;
      const animation = piece.animate([
        { transform: `${resting} scale(1) rotate(0deg)`, opacity: 1, filter: 'blur(0)' },
        { transform: `${resting} scale(.64) rotate(8deg)`, opacity: .86, filter: 'blur(.3px)', offset: .58 },
        { transform: `${resting} scale(.05) rotate(26deg)`, opacity: 0, filter: 'blur(2px)' },
      ], { duration: 520, easing: 'cubic-bezier(.4,0,.8,.25)', fill: 'forwards' });
      await Promise.race([animation.finished.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 760))]);
    } else if (!this.reduceMotion) {
      await wait(360);
    }

    if (piece) {
      piece.remove();
      this.pieces.delete(square);
    }
    burst.remove();
    if (this.ownBlackHole === square) this.ownBlackHole = null;
    this.spentSquare = square;
    this.#applySquareStates();
    cell?.classList.remove('sq--imploding');
    cell?.classList.add('sq--reopening');
    if (!this.reduceMotion) await wait(240);
    cell?.classList.remove('sq--reopening');
    try { navigator.vibrate?.([18, 28, 24]); } catch {}
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
  setBlackHoleState({ own = null, spent = null } = {}) {
    this.ownBlackHole = own;
    this.spentSquare = spent;
    this.#applySquareStates();
  }
  #applySquareStates() {
    for (const cell of this.el.querySelectorAll('.sq')) {
      const square = cell.dataset.sq;
      cell.classList.toggle('sq--own-hole', square === this.ownBlackHole);
      cell.classList.toggle('sq--hole-choice', !!this.holeSelector?.eligible.has(square));
      cell.classList.toggle('sq--repeat-choice', square === this.holeSelector?.previousSquare);
      cell.classList.toggle('sq--spent', square === this.spentSquare);
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
    this.holeSelector = null;
    this.interactiveColor = color;
    this.legalProvider = legalProvider || (() => []);
    this.#select(null);
    for (const [, elm] of this.pieces) {
      elm.classList.toggle('piece--draggable', !!color && elm.dataset.color === color);
    }
    this.el.setAttribute('aria-disabled', color ? 'false' : 'true');
    this.el.setAttribute('aria-label', 'Chess board. Use arrow keys to move between squares and Enter to select.');
    this.#applySquareStates();
  }

  setHoleSelection(squares, onSelect, { previousSquare = null } = {}) {
    this.interactiveColor = null;
    this.legalProvider = () => [];
    this.#select(null);
    this.holeSelector = {
      eligible: new Set(squares || []),
      onSelect: onSelect || (() => {}),
      previousSquare,
    };
    for (const [, elm] of this.pieces) elm.classList.remove('piece--draggable');
    if (previousSquare && this.holeSelector.eligible.has(previousSquare)) {
      this.focusSq = previousSquare;
      this.#syncFocus();
    } else if (!this.holeSelector.eligible.has(this.focusSq)) {
      this.focusSq = this.holeSelector.eligible.values().next().value || this.focusSq;
      this.#syncFocus();
    }
    this.el.setAttribute('aria-disabled', 'false');
    this.el.setAttribute('aria-label', 'Choose an empty square for your secret black hole. Use arrow keys and press Enter to place it.');
    this.#applySquareStates();
  }

  #bindPointer() {
    this.el.addEventListener('pointerdown', (e) => this.#down(e));
    this.el.addEventListener('pointermove', (e) => this.#move(e));
    this.el.addEventListener('pointerup', (e) => this.#up(e));
    this.el.addEventListener('pointercancel', () => this.#cancelDrag());
    this.el.addEventListener('click', (e) => {
      if (!this.holeSelector || this.busy) return;
      const square = this.#squareFromEvent(e);
      if (square) this.#activateSquare(square);
    });
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
      if ((e.key === 'Enter' || e.key === ' ') && (this.interactiveColor || this.holeSelector) && !this.busy) {
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
      const ownHole = this.ownBlackHole === sq.dataset.sq ? ', your active black hole' : '';
      const choice = this.holeSelector?.eligible.has(sq.dataset.sq) ? ', available for your black hole' : '';
      const repeat = this.holeSelector?.previousSquare === sq.dataset.sq
        ? ', previous black-hole square, available again'
        : this.spentSquare === sq.dataset.sq ? ', black hole spent, square is open again' : '';
      sq.setAttribute('aria-label', `${sq.dataset.sq}, ${suffix}${ownHole}${choice}${repeat}${selected}`);
    }
  }
  #activateSquare(sq) {
    if (this.holeSelector) {
      if (!this.holeSelector.eligible.has(sq)) return;
      const callback = this.holeSelector.onSelect;
      this.holeSelector = null;
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
    if (this.holeSelector || !this.interactiveColor || this.busy) return;
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
