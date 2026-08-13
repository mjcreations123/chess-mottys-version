// Fair chess engine: negamax + alpha-beta + iterative deepening over the
// vendored chess.js. No cheating anywhere. It cannot see the future, and it
// cannot see teleports coming, exactly like you.

import { Chess } from '../vendor/chess.js';
import { makeRng, seedFromString } from './rng.js';

const VAL = { p: 100, n: 310, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;
const ABORT = Symbol('abort');
const TT_LIMIT = 90000;

const KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

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

// Iterative deepening means maxDepth is an ambition, not a promise: the search
// keeps the best move from the last COMPLETED depth when timeMs runs out. So
// raising both makes the bot genuinely stronger on quiet positions without
// ever risking a stall.
export const LEVELS = {
  easy: { maxDepth: 2, timeMs: 600, jitter: 70, randomChance: 0.14, quiesce: false },
  medium: { maxDepth: 4, timeMs: 1800, jitter: 10, randomChance: 0, quiesce: true },
  hard: { maxDepth: 7, timeMs: 4200, jitter: 0, randomChance: 0, quiesce: true },
};

function evaluate(chess) {
  // score from the perspective of the side to move
  let score = 0;
  const rows = chess.board();
  let nonPawnMaterial = 0;
  const bishops = { w: 0, b: 0 };
  const pawnFiles = { w: Array(8).fill(0), b: Array(8).fill(0) };
  for (const row of rows) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.type === 'b') bishops[cell.color]++;
      if (cell.type === 'p') pawnFiles[cell.color][cell.square.charCodeAt(0) - 97]++;
      else if (cell.type !== 'k') nonPawnMaterial += VAL[cell.type];
    }
  }
  const endgame = nonPawnMaterial <= 2200;
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    for (let f = 0; f < 8; f++) {
      const cell = row[f];
      if (!cell) continue;
      const base = VAL[cell.type];
      const idx = cell.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      const positional = cell.type === 'k' && endgame ? KING_END[idx] : PST[cell.type][idx];
      const v = base + positional;
      score += cell.color === 'w' ? v : -v;
    }
  }

  // Small, stable strategic terms make quiet play substantially less random.
  if (bishops.w >= 2) score += 28;
  if (bishops.b >= 2) score -= 28;
  for (const color of ['w', 'b']) {
    let structure = 0;
    for (let file = 0; file < 8; file++) {
      const count = pawnFiles[color][file];
      if (count > 1) structure -= (count - 1) * 12;
      if (count && !pawnFiles[color][file - 1] && !pawnFiles[color][file + 1]) structure -= count * 8;
    }
    score += color === 'w' ? structure : -structure;
  }

  let view = chess.turn() === 'w' ? score : -score;
  if (chess.isCheck()) view -= 32;
  return view;
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
  const table = new Map();
  const fromTable = (score, ply) => score > MATE - 1000 ? score - ply : score < -MATE + 1000 ? score + ply : score;
  const forTable = (score, ply) => score > MATE - 1000 ? score + ply : score < -MATE + 1000 ? score - ply : score;

  const checkTime = () => {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw ABORT;
  };

  // Fail-SOFT. Returning the incoming alpha/beta bound instead of a real score
  // poisons the parent: under a narrow window an ordinary position comes back
  // wearing a mate score, and quiet king moves get preferred over actual mate.
  function quiesce(alpha, beta, depthLeft) {
    checkTime();
    const stand = evaluate(chess);
    if (stand >= beta) return stand;
    let best = stand;
    if (stand > alpha) alpha = stand;
    if (depthLeft <= 0) return best;
    const caps = chess.moves({ verbose: true }).filter((m) => m.captured);
    for (const m of orderMoves(caps)) {
      chess.move(m);
      const score = -quiesce(-beta, -alpha, depthLeft - 1);
      chess.undo();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(depth, alpha, beta, plyFromRoot) {
    checkTime();
    if (depth === 0) {
      return cfg.quiesce ? quiesce(alpha, beta, 6) : evaluate(chess);
    }
    const key = chess.fen();
    const alphaStart = alpha;
    const betaStart = beta;
    const cached = table.get(key);
    if (cached && cached.depth >= depth) {
      const cachedScore = fromTable(cached.score, plyFromRoot);
      if (cached.flag === 'exact') return cachedScore;
      if (cached.flag === 'lower') alpha = Math.max(alpha, cachedScore);
      if (cached.flag === 'upper') beta = Math.min(beta, cachedScore);
      if (alpha >= beta) return cachedScore;
    }

    const moves = chess.moves({ verbose: true });
    if (!moves.length) {
      return chess.isCheck() ? -MATE + plyFromRoot : 0;
    }
    let best = -Infinity;
    let bestMove = null;
    for (const m of orderMoves(moves, cached?.move)) {
      chess.move(m);
      const score = -negamax(depth - 1, -beta, -alpha, plyFromRoot + 1);
      chess.undo();
      if (score > best) { best = score; bestMove = uciStr(uciOf(m)); }
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    const flag = best <= alphaStart ? 'upper' : best >= betaStart ? 'lower' : 'exact';
    if (table.size >= TT_LIMIT) table.clear();
    table.set(key, { depth, score: forTable(best, plyFromRoot), flag, move: bestMove });
    return best;
  }

  let bestUci = uciOf(rootMoves[0]);
  let lastCompletedBest = bestUci;

  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    let iterBest = null;
    let iterBestRank = -Infinity;
    let alpha = -Infinity; // TRUE scores only; jitter must never touch this
    try {
      // search the previous iteration's best move first: that is most of what
      // makes iterative deepening pay for itself
      let first = true;
      for (const m of orderMoves(rootMoves, uciStr(lastCompletedBest))) {
        chess.move(m);
        let score;
        if (first || alpha === -Infinity) {
          score = -negamax(depth - 1, -Infinity, Infinity, 1);
        } else {
          // Null-window scout. A fail-high result is only a BOUND, not a
          // score, and a bound can come back wearing a mate magnitude. Any
          // move that beats alpha must be re-searched with a full window
          // before its number is believed.
          score = -negamax(depth - 1, -alpha - 1, -alpha, 1);
          if (score > alpha) score = -negamax(depth - 1, -Infinity, Infinity, 1);
        }
        chess.undo();
        first = false;
        if (score > alpha) alpha = score;

        // Jitter is a handicap knob for the weaker levels. It ranks moves, it
        // does not score them, and it never argues with a forced mate.
        const nearMate = Math.abs(score) > MATE - 1000;
        const rank = (cfg.jitter && !nearMate)
          ? score + Math.round((rng.next() - 0.5) * 2 * cfg.jitter)
          : score;
        if (rank > iterBestRank) {
          iterBestRank = rank;
          iterBest = uciOf(m);
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

function uciStr(m) {
  return m ? m.from + m.to + (m.promotion || '') : null;
}
