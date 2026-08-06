// Negamax + alpha-beta + quiescence + transposition table, iterative
// deepening under a millisecond budget. Pure and synchronous; identical in
// browser and Node.
//
// Asymmetric terminals (the never-lose contract):
//   White to move, no moves, in check  -> real mate (huge score).
//   White to move, no moves, no check  -> stalemate, 0 (the referee's
//     post-condition guards the real game from ever landing here).
//   Black to move, no moves            -> DOOM flat, never mate: in the
//     real game the Referee bails Black out, so the honest search must not
//     panic (or gloat) about a fate that cannot occur.

import {
  EMPTY, WHITE, F_CAPTURE, F_PROMO,
  mvFrom, mvTo, mvFlags, mvPromo,
} from './constants.js';
import { pseudoMoves, isAttacked } from './movegen.js';
import { evaluate, VALUES } from './eval.js';

export const MATE = 30000;
// Sentinel for "Black has no legal reply" — far below any real material
// count so the referee can tell A GENUINE MATE THREAT from merely being
// down a lot of material. Those are very different emergencies.
export const DOOM = -6000;
const TIMEOUT = Symbol('search-timeout');

const TT_SIZE = 1 << 20;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

const now = () => performance.now();

export class Search {
  constructor() {
    this.ttLo = new Int32Array(TT_SIZE);
    this.ttHi = new Int32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE);
    this.ttData = new Int32Array(TT_SIZE); // depth | flag<<6 | (score+32768)<<8
    this.killers = new Int32Array(2 * 64);
    this.history = new Int32Array(128 * 128);
    this.nodes = 0;
    this.deadline = Infinity;
  }

  clearHeuristics() {
    this.killers.fill(0);
    this.history.fill(0);
  }

  // Iterative deepening. Returns the best move for board.turn plus every
  // root move's score from the last fully completed iteration (fuel for
  // the personality layer's jitter).
  think(board, { msBudget = 700, maxDepth = 32, avoidHashes = null } = {}) {
    this.nodes = 0;
    this.deadline = now() + msBudget;
    this.clearHeuristics();

    const color = board.turn;
    const rootMoves = [];
    for (const m of pseudoMoves(board, color)) {
      const u = board.makeMove(m);
      const kingSq = color > 0 ? board.kingW : board.kingB;
      const legal = !isAttacked(board, kingSq, -color);
      const repeat = legal && avoidHashes?.has(board.hashKey());
      board.unmakeMove(u);
      if (legal) rootMoves.push({ m, score: -Infinity, repeat });
    }
    if (rootMoves.length === 0) {
      return { move: 0, score: 0, depth: 0, rootScores: [] };
    }

    let best = rootMoves[0].m;
    let bestScore = 0;
    let completedDepth = 0;
    let lastCompleted = null;

    // A TIMEOUT abort unwinds through #negamax without unmaking the moves
    // on the stack — the snapshot puts the board back exactly as it was.
    const snap = board.snapshot();

    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -Infinity;
      const iter = [];
      try {
        for (const rm of rootMoves) {
          const u = board.makeMove(rm.m);
          let score = -this.#negamax(board, depth - 1, -Infinity, -alpha, 1);
          board.unmakeMove(u);
          if (rm.repeat) score -= 50;
          iter.push({ m: rm.m, score });
          if (score > alpha) alpha = score;
        }
      } catch (e) {
        board.restore(snap);
        if (e === TIMEOUT) break;
        throw e;
      }
      iter.sort((a, b) => b.score - a.score);
      best = iter[0].m;
      bestScore = iter[0].score;
      completedDepth = depth;
      lastCompleted = iter;
      // re-order roots so the best line searches first next iteration
      rootMoves.sort((a, b) => {
        const sa = iter.find((x) => x.m === a.m)?.score ?? -Infinity;
        const sb = iter.find((x) => x.m === b.m)?.score ?? -Infinity;
        return sb - sa;
      });
      if (bestScore > MATE - 1000 || now() > this.deadline) break;
    }

    return {
      move: best,
      score: bestScore,
      depth: completedDepth,
      nodes: this.nodes,
      rootScores: lastCompleted ?? [],
    };
  }

  #negamax(board, depth, alpha, beta, ply) {
    if ((++this.nodes & 2047) === 0 && now() > this.deadline) throw TIMEOUT;
    if (depth <= 0) return this.#qsearch(board, alpha, beta, ply);

    const alphaOrig = alpha;
    const idx = (board.hashLo ^ board.hashHi) & TT_MASK;
    let ttBest = 0;
    if (this.ttLo[idx] === board.hashLo && this.ttHi[idx] === board.hashHi) {
      const data = this.ttData[idx];
      const ttDepth = data & 63;
      const ttFlag = (data >> 6) & 3;
      const ttScore = ((data >> 8) & 0xffff) - 32768;
      ttBest = this.ttMove[idx];
      if (ttDepth >= depth) {
        if (ttFlag === TT_EXACT) return ttScore;
        if (ttFlag === TT_LOWER && ttScore >= beta) return ttScore;
        if (ttFlag === TT_UPPER && ttScore <= alpha) return ttScore;
      }
    }

    const color = board.turn;
    const moves = pseudoMoves(board, color);
    this.#order(moves, board, ttBest, ply);

    let bestScore = -Infinity;
    let bestMove = 0;
    let legalCount = 0;

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const u = board.makeMove(m);
      const kingSq = color > 0 ? board.kingW : board.kingB;
      if (isAttacked(board, kingSq, -color)) {
        board.unmakeMove(u);
        continue;
      }
      legalCount++;
      const score = -this.#negamax(board, depth - 1, -beta, -alpha, ply + 1);
      board.unmakeMove(u);
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!(mvFlags(m) & (F_CAPTURE | F_PROMO)) && ply < 64) {
          const k = 2 * ply;
          if (this.killers[k] !== m) {
            this.killers[k + 1] = this.killers[k];
            this.killers[k] = m;
          }
          this.history[mvFrom(m) * 128 + mvTo(m)] += depth * depth;
        }
        break;
      }
    }

    if (legalCount === 0) {
      if (color === WHITE) {
        const kingSq = board.kingW;
        return isAttacked(board, kingSq, -color) ? -MATE + ply : 0;
      }
      return DOOM; // Black never truly dies; the Referee bails it out.
    }

    // store (skip near-mate scores; avoids ply-adjustment subtleties)
    if (bestScore < MATE - 1000 && bestScore > -MATE + 1000) {
      const flag =
        bestScore <= alphaOrig ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
      this.ttLo[idx] = board.hashLo;
      this.ttHi[idx] = board.hashHi;
      this.ttMove[idx] = bestMove;
      this.ttData[idx] =
        (Math.min(depth, 63) & 63) | (flag << 6) | ((bestScore + 32768) << 8);
    }

    return bestScore;
  }

  #qsearch(board, alpha, beta, ply) {
    if ((++this.nodes & 2047) === 0 && now() > this.deadline) throw TIMEOUT;
    const color = board.turn;
    const standPat = color > 0 ? evaluate(board) : -evaluate(board);
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
    if (ply > 40) return standPat;

    const moves = pseudoMoves(board, color);
    const noisy = [];
    for (let i = 0; i < moves.length; i++) {
      if (mvFlags(moves[i]) & (F_CAPTURE | F_PROMO)) noisy.push(moves[i]);
    }
    this.#order(noisy, board, 0, ply);

    let best = standPat;
    for (let i = 0; i < noisy.length; i++) {
      const m = noisy[i];
      // delta pruning
      const victim = board.squares[mvTo(m)];
      const gain = victim === EMPTY ? 0 : VALUES[victim > 0 ? victim : -victim];
      if (standPat + gain + 200 < alpha && !(mvFlags(m) & F_PROMO)) continue;

      const u = board.makeMove(m);
      const kingSq = color > 0 ? board.kingW : board.kingB;
      if (isAttacked(board, kingSq, -color)) {
        board.unmakeMove(u);
        continue;
      }
      const score = -this.#qsearch(board, -beta, -alpha, ply + 1);
      board.unmakeMove(u);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  #order(moves, board, ttBest, ply) {
    const sqs = board.squares;
    const k0 = ply < 64 ? this.killers[2 * ply] : 0;
    const k1 = ply < 64 ? this.killers[2 * ply + 1] : 0;
    const scores = moves.map((m) => {
      if (m === ttBest) return 1e9;
      const flags = mvFlags(m);
      if (flags & F_CAPTURE) {
        const victim = sqs[mvTo(m)];
        const attacker = sqs[mvFrom(m)];
        const v = victim === EMPTY ? 100 : VALUES[victim > 0 ? victim : -victim];
        const a = VALUES[attacker > 0 ? attacker : -attacker];
        return 1e6 + v * 16 - a;
      }
      if (flags & F_PROMO) return 1e6 + VALUES[mvPromo(m)];
      if (m === k0) return 900000;
      if (m === k1) return 800000;
      return this.history[mvFrom(m) * 128 + mvTo(m)];
    });
    // insertion sort by score desc (move lists are short)
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i], s = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < s) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = m;
      scores[j + 1] = s;
    }
  }
}
