// The WinDirector. Never losing is table stakes — MottyBot must WIN, and
// every win must be a genuine checkmate by White's own rulebook (that's
// both the punchline and what makes the invariant testable).
//
// Per activated turn, in order:
//   1. Instant mate: can placing/teleporting one piece checkmate right now?
//   2. Real forced mate with the current (cheated) army — the most
//      satisfying ending is Motty winning "legitimately" with three queens.
//   3. Preparation cheat: delete a defender / spawn a heavy near the king.
//   4. After 8 fruitless turns: the fallback wipe, then mate follows.

import {
  EMPTY, N, R, Q, K, P, WHITE, BLACK, alg, PIECE_LETTERS,
} from '../constants.js';
import { legalMoves, inCheck } from '../movegen.js';
import { MATE } from '../search.js';
import { VALUES } from '../eval.js';
import { verifyCheat, buildFallback } from './verify.js';

export function whiteNonKingMaterial(board) {
  let total = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = board.squares[s];
    if (piece > 0 && piece !== K) total += VALUES[piece];
  }
  return total;
}

const chebyshev = (a, b) => {
  const df = Math.abs((a & 15) - (b & 15));
  const dr = Math.abs((a >> 4) - (b >> 4));
  return Math.max(df, dr);
};

function squaresNearKing(board, maxDist) {
  const wk = board.kingW;
  const out = [];
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const d = chebyshev(s, wk);
    if (d >= 1 && d <= maxDist) out.push(s);
  }
  out.sort((a, b) => chebyshev(a, wk) - chebyshev(b, wk));
  return out;
}

export class WinDirector {
  constructor() {
    this.active = false;
    this.turns = 0;
  }

  // The director wakes ONLY when the player is genuinely about to win
  // (real mate threat / mate on the board) or the game has dragged past
  // any reasonable length. Pressure and material deficits are NOT
  // activation causes — that is what the sneaky tiers are for.
  maybeActivate(game, assess) {
    const marathon = game.moveNumber > 55;
    if (assess.botIsMated || assess.whiteMateThreat || marathon) {
      this.active = true;
    } else if (!marathon) {
      this.active = false; // crisis passed; the director stands down
    }
    return this.active;
  }

  plan(game) {
    const board = game.board;

    // a real forced mate with the current army is always the first choice
    const res = game.refSearch.think(board, {
      msBudget: game.budgets.finisherMs ?? 250,
      maxDepth: game.budgets.finisherDepth ?? 6,
    });
    if (res.move && res.score >= MATE - 64) return { kind: 'honest', move: res.move };

    // sneaky-first endgame: for the first stretch the director stays out
    // of the way — the normal pipeline keeps grinding with honest moves
    // and sneaky cheats. Blatant machinery only wakes up when the game
    // refuses to end.
    if (this.turns <= 6) return null;

    const instant = this.#instantMateScan(board);
    if (instant) return { kind: 'cheat', candidate: instant };

    if (this.turns < 14) {
      const prep = this.#preparation(game);
      if (prep) return { kind: 'cheat', candidate: prep };
    }
    for (const fb of buildFallback(board)) {
      const v = verifyCheat(board, game.refSearch, fb, 100, game.budgets);
      if (v.ok) return { kind: 'cheat', candidate: fb };
    }
    return null; // caller plays the honest best move and we go again
  }

  #instantMateScan(board) {
    const snap = board.snapshot();
    const near = squaresNearKing(board, 3);
    try {
      // spawn a piece that mates on the spot
      for (const s of near) {
        if (board.squares[s] !== EMPTY) continue;
        for (const type of [Q, R, N]) {
          board.forceSet(s, -type);
          board.setTurn(WHITE);
          const mated = inCheck(board, WHITE) && legalMoves(board, WHITE).length === 0;
          board.restore(snap);
          if (mated) {
            return {
              id: 'SPAWN', tier: 3, drama: 95, score: 5000,
              muts: [{ op: 'set', sq: s, piece: -type }],
              events: [{
                type: 'spawn', square: alg(s),
                piece: { type: PIECE_LETTERS[type], color: 'b' },
                cheat: { id: 'SPAWN', tier: 3 },
              }],
              notation: `${PIECE_LETTERS[type].toUpperCase()}@${alg(s)}#`,
            };
          }
        }
      }
      // teleport an existing heavy piece onto the mating square
      const heavies = [];
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const piece = board.squares[s];
        if (piece === -Q || piece === -R) heavies.push({ sq: s, piece });
      }
      for (const { sq, piece } of heavies) {
        for (const s of near) {
          const target = board.squares[s];
          if (target < 0 || target === K) continue;
          board.forceMove(sq, s);
          board.setTurn(WHITE);
          const mated = inCheck(board, WHITE) && legalMoves(board, WHITE).length === 0;
          board.restore(snap);
          if (mated) {
            const type = -piece;
            return {
              id: 'TELEPORT', tier: 3, drama: 92, score: 5000,
              muts: [{ op: 'move', from: sq, to: s }],
              events: [{
                type: 'teleport', from: alg(sq), to: alg(s),
                piece: { type: PIECE_LETTERS[type], color: 'b' },
                ...(target > 0 ? { captured: { type: PIECE_LETTERS[target], color: 'w' } } : {}),
                cheat: { id: 'TELEPORT', tier: 3 },
              }],
              notation: `${PIECE_LETTERS[type].toUpperCase()}⇒${alg(s)}#`,
            };
          }
        }
      }
    } finally {
      board.restore(snap);
    }
    return null;
  }

  #preparation(game) {
    const board = game.board;
    const candidates = [];

    // delete White's most valuable remaining defender
    let best = null;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const piece = board.squares[s];
      if (piece > 0 && piece !== K && piece !== P) {
        if (!best || VALUES[piece] > VALUES[best.piece]) best = { sq: s, piece };
      }
    }
    if (best) {
      candidates.push({
        id: 'DELETE', tier: 3, drama: 45, score: VALUES[best.piece],
        muts: [{ op: 'remove', sq: best.sq }],
        events: [{
          type: 'remove', square: alg(best.sq),
          piece: { type: PIECE_LETTERS[best.piece], color: 'w' },
          cheat: { id: 'DELETE', tier: 3 },
        }],
        notation: null,
      });
    }

    // spawn a heavy piece two squares from the king
    for (const s of squaresNearKing(board, 2)) {
      if (board.squares[s] !== EMPTY) continue;
      if (chebyshev(s, board.kingW) < 2) continue; // not adjacent: no free snacks
      for (const type of [Q, R]) {
        candidates.push({
          id: 'SPAWN', tier: 3, drama: 60, score: 300,
          muts: [{ op: 'set', sq: s, piece: -type }],
          events: [{
            type: 'spawn', square: alg(s),
            piece: { type: PIECE_LETTERS[type], color: 'b' },
            cheat: { id: 'SPAWN', tier: 3 },
          }],
          notation: `${PIECE_LETTERS[type].toUpperCase()}@${alg(s)}`,
        });
      }
    }

    for (const c of candidates) {
      const v = verifyCheat(board, game.refSearch, c, 250, game.budgets);
      if (v.ok) return c;
    }
    return null;
  }
}
