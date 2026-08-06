// Board rendering: squares, coordinates, highlights, and the piece layer.
// All piece motion is transform-only; this module owns final positions and
// the square -> element bookkeeping. animate.js borrows elements to move
// them; after every full turn main.js calls syncFromState() so the visual
// board can never drift from the engine's truth.

import { pieceSVG } from '../pieces.js';

const FILES = 'abcdefgh';

export const fileOf = (sq) => FILES.indexOf(sq[0]);
export const rankOf = (sq) => Number(sq[1]) - 1;
export const xyOf = (sq) => ({ x: fileOf(sq) * 100, y: (7 - rankOf(sq)) * 100 });

export class BoardView {
  constructor(root) {
    this.root = root;
    this.squaresEl = root.querySelector('#board-squares');
    this.hlEl = root.querySelector('#board-highlights');
    this.piecesEl = root.querySelector('#board-pieces');
    this.fxEl = root.querySelector('#board-fx');
    this.pieces = new Map(); // 'e4' -> element
    this.caption = null;
    this.#buildSquares();
  }

  #buildSquares() {
    const frag = document.createDocumentFragment();
    for (let rank = 7; rank >= 0; rank--) {
      for (let file = 0; file < 8; file++) {
        const el = document.createElement('div');
        el.className = 'board__square' + ((file + rank) % 2 === 0 ? ' board__square--dark' : '');
        el.dataset.square = FILES[file] + (rank + 1);
        if (rank === 0) el.dataset.fileLabel = FILES[file];
        if (file === 0) el.dataset.rankLabel = String(rank + 1);
        frag.appendChild(el);
      }
    }
    this.squaresEl.appendChild(frag);
  }

  // --- pieces -----------------------------------------------------------

  makePieceEl(type, color) {
    const el = document.createElement('div');
    el.className = `piece piece--${color}`;
    el.dataset.type = type;
    el.dataset.color = color;
    el.innerHTML = pieceSVG(type);
    return el;
  }

  place(sq, type, color) {
    this.removeAt(sq);
    const el = this.makePieceEl(type, color);
    this.setTransform(el, sq);
    this.pieces.set(sq, el);
    this.piecesEl.appendChild(el);
    return el;
  }

  setTransform(el, sq) {
    const { x, y } = xyOf(sq);
    el.style.transform = `translate(${x}%, ${y}%)`;
    el.dataset.square = sq;
  }

  pieceAt(sq) {
    return this.pieces.get(sq) ?? null;
  }

  // relocate bookkeeping + final transform (no animation)
  settle(from, to) {
    const el = this.pieces.get(from);
    if (!el) return null;
    this.pieces.delete(from);
    this.removeAt(to);
    this.pieces.set(to, el);
    this.setTransform(el, to);
    return el;
  }

  removeAt(sq) {
    const el = this.pieces.get(sq);
    if (el) {
      this.pieces.delete(sq);
      el.remove();
    }
    return el ?? null;
  }

  convertAt(sq, type, color) {
    const el = this.pieces.get(sq);
    if (!el) return null;
    el.dataset.type = type;
    el.dataset.color = color;
    el.className = `piece piece--${color}`;
    el.innerHTML = pieceSVG(type);
    return el;
  }

  // authoritative reconciliation — the engine is always right
  syncFromState(state) {
    const want = new Map();
    for (const { square, type, color } of state.squares) {
      want.set(square, { type, color });
    }
    for (const [sq, el] of [...this.pieces]) {
      const w = want.get(sq);
      if (!w) { this.pieces.delete(sq); el.remove(); continue; }
      if (el.dataset.type !== w.type || el.dataset.color !== w.color) {
        this.convertAt(sq, w.type, w.color);
      }
      this.setTransform(el, sq);
      want.delete(sq);
    }
    for (const [sq, w] of want) this.place(sq, w.type, w.color);
  }

  // --- highlights -------------------------------------------------------

  #hl(cls, sq) {
    const el = document.createElement('div');
    el.className = `hl ${cls}`;
    const { x, y } = xyOf(sq);
    el.style.transform = `translate(${x}%, ${y}%)`;
    this.hlEl.appendChild(el);
    return el;
  }

  clearHighlights(kinds = null) {
    for (const el of [...this.hlEl.children]) {
      if (!kinds || kinds.some((k) => el.classList.contains(k))) el.remove();
    }
  }

  showLastMove(from, to) {
    this.clearHighlights(['hl--lastmove']);
    this.#hl('hl--lastmove', from);
    this.#hl('hl--lastmove', to);
  }

  showSelection(sq, targets) {
    this.clearSelection();
    this.#hl('hl--selected', sq);
    const el = this.pieces.get(sq);
    if (el) el.classList.add('is-lifted');
    for (const t of targets) {
      this.#hl(this.pieces.has(t.to) ? 'hl--ring' : 'hl--dot', t.to);
    }
  }

  clearSelection() {
    this.clearHighlights(['hl--selected', 'hl--dot', 'hl--ring']);
    for (const el of this.piecesEl.querySelectorAll('.is-lifted')) {
      el.classList.remove('is-lifted');
    }
  }

  showCheck(sq) {
    this.clearHighlights(['hl--check']);
    this.#hl('hl--check', sq);
  }

  clearCheck() {
    this.clearHighlights(['hl--check']);
  }

  flashDenied(sq) {
    const el = this.#hl('hl--deny', sq);
    setTimeout(() => el.remove(), 450);
  }

  rejectPiece(sq) {
    const el = this.pieces.get(sq);
    if (!el) return;
    el.classList.remove('is-rejected');
    void el.offsetWidth; // restart the animation
    el.classList.add('is-rejected');
    setTimeout(() => el.classList.remove('is-rejected'), 350);
  }

  setCaption(text) {
    this.clearCaption();
    const el = document.createElement('div');
    el.className = 'board-caption';
    el.textContent = text;
    this.root.appendChild(el);
    this.caption = el;
  }

  clearCaption() {
    this.caption?.remove();
    this.caption = null;
  }
}
