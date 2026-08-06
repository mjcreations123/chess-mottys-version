// Tap-tap input with strict refereeing feedback. Selection -> legal dots ->
// move; illegal attempts get the shake, the red flash, and a stern log
// entry. The black king's square shows up as a capturable target on
// purpose — it is bait.

import { pieceSVG } from '../pieces.js';

export class Input {
  constructor(boardView, game, { onPlayerMove, isBusy }) {
    this.board = boardView;
    this.game = game;
    this.onPlayerMove = onPlayerMove;
    this.isBusy = isBusy;
    this.selected = null;
    this.targets = [];
    this.promoResolve = null;
    boardView.root.addEventListener('pointerdown', (e) => this.#tap(e));
    this.#buildPromoSheet();
  }

  #tap(e) {
    if (this.isBusy()) return;
    const squareEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.board__square');
    const sq = squareEl?.dataset.square;
    if (!sq) return;

    if (this.selected) {
      if (sq === this.selected) { this.#clear(); return; }
      const target = this.targets.find((t) => t.to === sq);
      const pieceHere = this.board.pieceAt(sq);
      if (target) {
        const from = this.selected;
        this.#clear();
        this.#submit(from, sq, target.promo != null);
        return;
      }
      if (pieceHere?.dataset.color === 'w') { this.#select(sq); return; }
      // an illegal destination: the rules apply to you
      const from = this.selected;
      this.#clear();
      this.board.rejectPiece(from);
      this.board.flashDenied(sq);
      navigator.vibrate?.(60);
      this.onPlayerMove({ from, to: sq, illegalProbe: true });
      return;
    }

    const pieceHere = this.board.pieceAt(sq);
    if (pieceHere?.dataset.color === 'w') this.#select(sq);
  }

  #select(sq) {
    this.selected = sq;
    this.targets = this.game.legalMovesFor(sq);
    // the king-capture bait: if the black king is adjacent to a legal
    // capture pattern it already appears in legalMovesFor. Nothing to add.
    this.board.showSelection(sq, this.targets);
  }

  #clear() {
    this.selected = null;
    this.targets = [];
    this.board.clearSelection();
  }

  async #submit(from, to, needsPromo) {
    let promo;
    if (needsPromo) {
      promo = await this.#askPromotion();
      if (!promo) return;
    }
    this.onPlayerMove({ from, to, promo });
  }

  #buildPromoSheet() {
    const wrap = document.getElementById('promo-choices');
    wrap.innerHTML = ['q', 'r', 'b', 'n']
      .map((t) => `<button type="button" data-promo="${t}" aria-label="${t}">${pieceSVG(t)}</button>`)
      .join('');
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn && this.promoResolve) {
        document.getElementById('sheet-promo').hidden = true;
        const resolve = this.promoResolve;
        this.promoResolve = null;
        resolve(btn.dataset.promo);
      }
    });
  }

  #askPromotion() {
    document.getElementById('sheet-promo').hidden = false;
    return new Promise((resolve) => { this.promoResolve = resolve; });
  }
}
