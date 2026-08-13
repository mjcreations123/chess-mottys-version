// Fair chess engine: negamax + alpha-beta + iterative deepening over the
// vendored chess.js. No cheating anywhere. It cannot see the future, and it
// cannot see teleports coming, exactly like you.

import { Chess } from '../vendor/chess.js';
import { makeRng, seedFromString } from './rng.js';

const VAL = { p: 100, n: 310, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;
const ABORT = Symbol('abort');

// Simplified evaluation tables (Michniewski), index 0 = a8 ... 63 = h1.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

export const LEVELS = {
  easy: { maxDepth: 1, timeMs: 250, jitter: 90, randomChance: 0.22, quiesce: false },
  medium: { maxDepth: 3, timeMs: 700, jitter: 18, randomChance: 0, quiesce: false },
  hard: { maxDepth: 5, timeMs: 1500, jitter: 0, randomChance: 0, quiesce: true },
};

function evaluate(chess) {
  // score from the perspective of the side to move
  let score = 0;
  const rows = chess.board();
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    for (let f = 0; f < 8; f++) {
      const cell = row[f];
      if (!cell) continue;
      const base = VAL[cell.type];
      const idx = cell.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      const v = base + PST[cell.type][idx];
      score += cell.color === 'w' ? v : -v;
    }
  }
  return chess.turn() === 'w' ? score : -score;
}

function orderMoves(moves, preferUci) {
  return moves.slice().sort((a, b) => {
    const au = a.from + a.to + (a.promotion || '');
    const bu = b.from + b.to + (b.promotion || '');
    if (preferUci) {
      if (au === preferUci) return -1;
      if (bu === preferUci) return 1;
    }
    const av = (a.captured ? VAL[a.captured] * 10 - VAL[a.piece] : 0) + (a.promotion ? 800 : 0);
    const bv = (b.captured ? VAL[b.captured] * 10 - VAL[b.piece] : 0) + (b.promotion ? 800 : 0);
    return bv - av;
  });
}

export function think(fen, level, seed, opts = {}) {
  const cfg = { ...LEVELS[level] || LEVELS.medium, ...opts };
  const rng = makeRng(seedFromString(String(seed ?? 'mottybot')));
  const chess = new Chess(fen);
  const rootMoves = chess.moves({ verbose: true });
  if (!rootMoves.length) return null;
  if (rootMoves.length === 1) return uciOf(rootMoves[0]);

  if (cfg.randomChance && rng.next() < cfg.randomChance) {
    return uciOf(rootMoves[rng.int(rootMoves.length)]);
  }

  const deadline = Date.now() + cfg.timeMs;
  let nodes = 0;

  const checkTime = () => {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw ABORT;
  };

  function quiesce(alpha, beta, depthLeft) {
    checkTime();
    const stand = evaluate(chess);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (depthLeft <= 0) return alpha;
    const caps = chess.moves({ verbose: true }).filter((m) => m.captured);
    for (const m of orderMoves(caps)) {
      chess.move(m);
      const score = -quiesce(-beta, -alpha, depthLeft - 1);
      chess.undo();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(depth, alpha, beta, plyFromRoot) {
    checkTime();
    if (depth === 0) {
      return cfg.quiesce ? quiesce(alpha, beta, 6) : evaluate(chess);
    }
    const moves = chess.moves({ verbose: true });
    if (!moves.length) {
      return chess.isCheck() ? -MATE + plyFromRoot : 0;
    }
    let best = -Infinity;
    for (const m of orderMoves(moves)) {
      chess.move(m);
      const score = -negamax(depth - 1, -beta, -alpha, plyFromRoot + 1);
      chess.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  let bestUci = uciOf(rootMoves[0]);
  let lastCompletedBest = bestUci;

  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    let iterBest = null;
    let iterBestScore = -Infinity;
    let alpha = -Infinity;
    try {
      for (const m of orderMoves(rootMoves, lastCompletedBest)) {
        chess.move(m);
        let score = -negamax(depth - 1, -Infinity, -alpha, 1);
        chess.undo();
        if (cfg.jitter) score += Math.round((rng.next() - 0.5) * 2 * cfg.jitter);
        if (score > iterBestScore) {
          iterBestScore = score;
          iterBest = uciOf(m);
          if (score > alpha) alpha = score;
        }
      }
      if (iterBest) {
        lastCompletedBest = iterBest;
        bestUci = iterBest;
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      break; // keep best from last completed depth
    }
    if (Date.now() > deadline) break;
  }
  return bestUci;
}

function uciOf(m) {
  return { from: m.from, to: m.to, promotion: m.promotion || undefined };
}
