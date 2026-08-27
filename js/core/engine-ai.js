// MottyBot's brain: negamax with alpha-beta, principal variation search,
// quiescence, killer/history move ordering and check extensions, running on the
// 0x88 board in fastboard.js.
//
// The search knows one house rule directly: a dead piece with a clear
// starting square and a matching enemy piece still on the board is a standing
// claim on that much material. Everything else about Prisoner Exchange is
// judged outside the search, by comparing the positions each choice produces.

import { Chess } from '../vendor/chess.js';
import {
  FastBoard, moveFrom, moveTo, movePromo, moveKind, moveToUci,
  KIND_EP, EMPTY, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
  WHITE, colorOf, typeOf, fileOf, rankOf, nameToSquare,
} from './fastboard.js';
import { makeRng, seedFromString } from './rng.js';

const VAL = [0, 100, 320, 330, 500, 950, 0];
const MATE = 100000;
const MATE_THRESHOLD = MATE - 1000;
const MAX_PLY = 64;
const ABORT = Symbol('abort');

/* ---------------- evaluation tables (index 0 = a8, 63 = h1) ------------- */
const PST = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20],
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20],
};
const KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50];

// Manhattan distance from the centre: 0 in the middle, 6 in a corner.
const CENTER_DIST = new Int8Array(64);
for (let r = 0; r < 8; r++) {
  for (let f = 0; f < 8; f++) CENTER_DIST[r * 8 + f] = Math.max(3 - f, f - 4) + Math.max(3 - r, r - 4);
}

const pstIndex = (sq, color) => (color === WHITE ? (7 - rankOf(sq)) * 8 + fileOf(sq) : rankOf(sq) * 8 + fileOf(sq));

/* ---------------- levels ---------------- */
// Every level weighs a homecoming to the same depth. Judging the house rule is
// not a difficulty setting: the rules are the rules, and a weak opponent that
// did not understand its own graveyard would just look broken.
const PROBE_DEPTH = 4;

// Three genuinely different opponents. They differ along three axes on
// purpose, because depth alone does not separate them: with captures resolved
// at every leaf, even a two-ply search never hangs a piece, which is why the
// old Casual beat a careful beginner in 96 games out of 100.
//
//   maxDepth   how far ahead it looks
//   scoreNoise how clearly it sees what it looked at
//   flatEval   whether it understands anything beyond material
//
// All three understand this week's house rule completely and judge a
// homecoming at the same depth. A weak level is weak at CHESS; it is never
// confused about what the rules let it do.
export const LEVELS = {
  easy: {
    label: 'Casual', maxDepth: 1, timeMs: 300,
    scoreNoise: 300, flatEval: true, endgameBonus: 2, probeDepth: PROBE_DEPTH,
  },
  medium: {
    label: 'Average', maxDepth: 3, timeMs: 1100,
    scoreNoise: 55, endgameBonus: 4, probeDepth: PROBE_DEPTH,
  },
  hard: {
    label: 'Expert', maxDepth: 24, timeMs: 4500,
    scoreNoise: 0, endgameBonus: 12, probeDepth: PROBE_DEPTH,
  },
};

/* ---------------- the weekly rule, seen from inside the search ----------- */
// A dead knight, bishop, rook or queen can be redeemed by capturing an enemy
// piece of the same kind, which puts it back on its own starting square. So a
// graveyard entry is worth real material when three things hold at once: an
// enemy piece of that kind is still on the board, one of its home squares is
// empty, and it has not already been spent. The two weights below are the
// engine's opinion of how likely each is to be cashed.
const CLAIM_LIVE = 0.35;    // a home square stands clear right now
const CLAIM_BLOCKED = 0.08; // the claim is real but the home is occupied
const TYPE_CODE = { n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN };

// Turn the match's graveyards into something the 0x88 board can read fast.
// Duplicate claims on one kind decay, because a single turn redeems one.
export function compileClaims(vouchers) {
  if (!vouchers) return null;
  const side = (list) => {
    const seen = new Map();
    const out = [];
    for (const entry of list || []) {
      const type = TYPE_CODE[entry.type];
      if (!type || !entry.homes?.length) continue;
      const rank = seen.get(type) || 0;
      seen.set(type, rank + 1);
      out.push({
        type,
        homes: entry.homes.map(nameToSquare),
        weight: 1 / (rank + 1),
      });
    }
    return out;
  };
  const w = side(vouchers.w);
  const b = side(vouchers.b);
  return w.length || b.length ? { w, b } : null;
}

function claimValue(squares, claims, enemyCounts) {
  let total = 0;
  for (const claim of claims) {
    const targets = enemyCounts[claim.type];
    if (!targets) continue;          // nothing left to redeem it against
    let open = false;
    for (const home of claim.homes) {
      if (squares[home] === EMPTY) { open = true; break; }
    }
    // One lone enemy piece of that kind is a harder capture to arrange than
    // a choice of two, so a single target is discounted.
    const reach = targets > 1 ? 1 : 0.7;
    total += VAL[claim.type] * claim.weight * reach * (open ? CLAIM_LIVE : CLAIM_BLOCKED);
  }
  return total;
}

/* ---------------- evaluation ---------------- */
function evaluate(board) {
  const sq = board.squares;
  // A flat evaluation counts material and nothing else. No development, no
  // king safety, no pawn structure: the mating drive stays so a won game
  // still gets finished.
  const flat = board.flatEval === true;
  let score = 0;                 // white's point of view
  let forceW = 0, forceB = 0;    // non-king, non-pawn+pawn material
  let nonPawn = 0;
  let bishopsW = 0, bishopsB = 0;
  const pawnFilesW = [0, 0, 0, 0, 0, 0, 0, 0];
  const pawnFilesB = [0, 0, 0, 0, 0, 0, 0, 0];
  const countW = [0, 0, 0, 0, 0, 0, 0];
  const countB = [0, 0, 0, 0, 0, 0, 0];
  let kingW = -1, kingB = -1;

  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = sq[s];
    if (piece === EMPTY) continue;
    const color = colorOf(piece);
    const type = typeOf(piece);
    if (color === WHITE) countW[type]++; else countB[type]++;
    if (type === KING) { if (color === WHITE) kingW = s; else kingB = s; continue; }
    const base = VAL[type];
    if (color === WHITE) forceW += base; else forceB += base;
    if (type !== PAWN) nonPawn += base;
    if (type === BISHOP) { if (color === WHITE) bishopsW++; else bishopsB++; }
    if (type === PAWN) {
      if (color === WHITE) pawnFilesW[fileOf(s)]++; else pawnFilesB[fileOf(s)]++;
    }
    const v = flat ? base : base + PST[type][pstIndex(s, color)];
    score += color === WHITE ? v : -v;
  }

  const endgame = nonPawn <= 2200;
  if (!flat) {
    const kingTable = endgame ? KING_END : PST[KING];
    if (kingW >= 0) score += kingTable[pstIndex(kingW, WHITE)];
    if (kingB >= 0) score -= kingTable[pstIndex(kingB, 1)];

    if (bishopsW >= 2) score += 28;
    if (bishopsB >= 2) score -= 28;
  }

  for (let f = 0; f < 8; f++) {
    if (flat) break;
    if (pawnFilesW[f] > 1) score -= (pawnFilesW[f] - 1) * 12;
    if (pawnFilesB[f] > 1) score += (pawnFilesB[f] - 1) * 12;
    const isolatedW = pawnFilesW[f] && !(pawnFilesW[f - 1] || 0) && !(pawnFilesW[f + 1] || 0);
    const isolatedB = pawnFilesB[f] && !(pawnFilesB[f - 1] || 0) && !(pawnFilesB[f + 1] || 0);
    if (isolatedW) score -= pawnFilesW[f] * 8;
    if (isolatedB) score += pawnFilesB[f] * 8;
  }

  // Mating drive: against a bare king material is flat, so herd it to the edge
  // and walk the other king in, otherwise a won endgame shuffles to a draw.
  const lead = forceW - forceB;
  if (Math.abs(lead) >= 300 && kingW >= 0 && kingB >= 0) {
    const strongWhite = lead > 0;
    const weak = strongWhite ? forceB : forceW;
    if (weak <= 100) {
      const loser = strongWhite ? kingB : kingW;
      const winner = strongWhite ? kingW : kingB;
      const apart = Math.abs(rankOf(loser) - rankOf(winner)) + Math.abs(fileOf(loser) - fileOf(winner));
      const drive = 4.7 * CENTER_DIST[(7 - rankOf(loser)) * 8 + fileOf(loser)] + 1.6 * (14 - apart);
      score += strongWhite ? drive : -drive;
    }
  }

  // This week's rule: what each side is still owed, and can still collect.
  if (board.claims) {
    score += claimValue(sq, board.claims.w, countB);
    score -= claimValue(sq, board.claims.b, countW);
  }

  return board.turn === WHITE ? score : -score;
}

// A testing seam: the static verdict on one position, with no search at all.
export function evaluateFen(fen, vouchers, { flatEval = false } = {}) {
  const board = new FastBoard(fen);
  board.claims = compileClaims(vouchers);
  board.flatEval = flatEval;
  return evaluate(board);
}

// Box-Muller on the seeded generator, so a level's sloppiness is reproducible
// for a given game seed.
function gaussian(rng) {
  const u = 1 - rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------------- search ---------------- */
class Search {
  constructor(board, deadline) {
    this.board = board;
    this.deadline = deadline;
    this.nodes = 0;
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(16 * 128);
    this.moveLists = [];
    for (let i = 0; i < MAX_PLY + 8; i++) this.moveLists.push([]);
  }

  #checkTime() {
    if ((++this.nodes & 2047) === 0 && Date.now() > this.deadline) throw ABORT;
  }

  // Higher scores are searched first. Captures by MVV-LVA, then the two killer
  // moves for this ply, then the history heuristic.
  #scoreMove(move, ply, ttMove) {
    if (move === ttMove) return 1 << 24;
    const to = moveTo(move);
    const victim = this.board.squares[to];
    if (victim !== EMPTY || moveKind(move) === KIND_EP) {
      const attacker = this.board.squares[moveFrom(move)];
      const victimVal = victim === EMPTY ? VAL[PAWN] : VAL[typeOf(victim)];
      return (1 << 20) + victimVal * 16 - VAL[typeOf(attacker)];
    }
    const promo = movePromo(move);
    if (promo) return (1 << 19) + VAL[promo];
    if (move === this.killers[ply * 2]) return 1 << 18;
    if (move === this.killers[ply * 2 + 1]) return (1 << 18) - 1;
    return this.history[this.board.squares[moveFrom(move)] * 128 + to];
  }

  #sort(moves, ply, ttMove) {
    const scores = new Array(moves.length);
    for (let i = 0; i < moves.length; i++) scores[i] = this.#scoreMove(moves[i], ply, ttMove);
    // insertion sort: move lists are short and mostly ordered already
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i];
      const s = scores[i];
      let j = i - 1;
      while (j >= 0 && scores[j] < s) { moves[j + 1] = moves[j]; scores[j + 1] = scores[j]; j--; }
      moves[j + 1] = m;
      scores[j + 1] = s;
    }
  }

  quiesce(alpha, beta, ply) {
    this.#checkTime();
    const stand = evaluate(this.board);
    if (stand >= beta) return stand;
    let best = stand;
    if (stand > alpha) alpha = stand;
    if (ply >= MAX_PLY - 1) return best;

    const moves = this.moveLists[ply];
    this.board.generate(moves, true);
    this.#sort(moves, ply, 0);
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (!this.board.makeIfLegal(move)) continue;
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      this.board.unmake();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  negamax(depth, alpha, beta, ply) {
    this.#checkTime();
    const inCheck = this.board.inCheck();
    if (inCheck) depth++; // never evaluate a position with checks hanging over it
    if (depth <= 0) return this.quiesce(alpha, beta, ply);

    const moves = this.moveLists[ply];
    this.board.generate(moves);
    this.#sort(moves, ply, 0);

    let best = -Infinity;
    let legal = 0;
    let bestMove = 0;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (!this.board.makeIfLegal(move)) continue;
      legal++;
      let score;
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      } else {
        score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) score = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      }
      this.board.unmake();

      if (score > best) { best = score; bestMove = move; }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        // quiet move that caused a cutoff: remember it for sibling nodes
        if (this.board.squares[moveTo(move)] === EMPTY && moveKind(move) !== KIND_EP) {
          const k = ply * 2;
          if (this.killers[k] !== move) { this.killers[k + 1] = this.killers[k]; this.killers[k] = move; }
          this.history[this.board.squares[moveFrom(move)] * 128 + moveTo(move)] += depth * depth;
        }
        break;
      }
    }

    if (legal === 0) return inCheck ? -MATE + ply : 0; // mate or stalemate
    return best;
  }
}

/* ---------------- public entry ---------------- */
function endgameDepthBonus(board) {
  let pieces = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    if (board.squares[s] !== EMPTY) pieces++;
  }
  if (pieces <= 5) return 12;
  if (pieces <= 7) return 10;
  if (pieces <= 10) return 6;
  if (pieces <= 14) return 3;
  return 0;
}

export function think(fen, level, seed, opts = {}) {
  const cfg = { ...(LEVELS[level] || LEVELS.medium), ...opts };
  const rng = makeRng(seedFromString(String(seed ?? 'mottybot')));
  const board = new FastBoard(fen);
  board.claims = compileClaims(cfg.vouchers);
  board.flatEval = cfg.flatEval === true;
  const rootMoves = board.legalMoves();
  if (!rootMoves.length) return null;

  cfg.maxDepth += Math.min(endgameDepthBonus(board), cfg.endgameBonus ?? 0);
  const deadline = Date.now() + cfg.timeMs;
  const search = new Search(board, deadline);

  const scored = rootMoves.map((move) => ({ move, score: -Infinity }));
  const exactRoot = Boolean(cfg.scoreNoise);
  let completedDepth = 0;

  for (let depth = 1; depth <= cfg.maxDepth; depth++) {
    // search last iteration's best first
    scored.sort((a, b) => b.score - a.score);
    let alpha = -Infinity;
    let aborted = false;
    const fresh = scored.map((e) => ({ move: e.move, score: -Infinity }));
    try {
      for (let i = 0; i < fresh.length; i++) {
        const entry = fresh[i];
        board.makeIfLegal(entry.move);
        let score;
        if (i === 0 || exactRoot) {
          // A hazy level compares root moves against each other, so every one
          // of them needs a real score. The null window below is faster, but a
          // move that fails low comes back with an upper BOUND, and several
          // moves fail low at the same bound: haze those and a level picks a
          // blunder that scored the same as the best move only because neither
          // was searched properly.
          score = -search.negamax(depth - 1, -Infinity, Infinity, 1);
        } else {
          score = -search.negamax(depth - 1, -alpha - 1, -alpha, 1);
          if (score > alpha) score = -search.negamax(depth - 1, -Infinity, Infinity, 1);
        }
        board.unmake();
        entry.score = score;
        if (score > alpha) alpha = score;
      }
    } catch (err) {
      if (err !== ABORT) throw err;
      aborted = true;
    }
    if (!aborted) {
      for (let i = 0; i < fresh.length; i++) scored[i] = fresh[i];
      completedDepth = depth;
      if (cfg.stats) {
        cfg.stats.depth = depth;
        cfg.stats.nodes = search.nodes;
        cfg.stats.ms = Date.now() - (deadline - cfg.timeMs);
        cfg.stats.score = Math.max(...fresh.map((e) => e.score));
      }
      // a forced mate is not going to get better with more thinking
      if (Math.abs(alpha) > MATE_THRESHOLD) break;
    }
    if (aborted || Date.now() > deadline) break;
  }

  scored.sort((a, b) => b.score - a.score);
  let chosen = scored[0];

  // Weaker levels see the position through a haze. Every root move's score is
  // nudged before the best one is picked, so a weak level overlooks things by
  // degrees the way a person does: usually the second-best move, sometimes a
  // real mistake. A forced mate is never traded away and a forced loss is
  // never walked into, so even Casual finishes what it starts.
  if (cfg.scoreNoise && scored.length > 1 && Math.abs(chosen.score) < MATE_THRESHOLD) {
    let bestHazed = -Infinity;
    for (const entry of scored) {
      if (!Number.isFinite(entry.score) || entry.score <= -MATE_THRESHOLD) continue;
      const hazed = entry.score + gaussian(rng) * cfg.scoreNoise;
      if (hazed > bestHazed) { bestHazed = hazed; chosen = entry; }
    }
  }

  if (cfg.stats) {
    cfg.stats.completedDepth = completedDepth;
    cfg.stats.candidates = scored
      .filter((entry) => Number.isFinite(entry.score))
      .map((entry) => ({ ...moveToUci(entry.move), score: entry.score }));
  }

  const picked = moveToUci(chosen.move);
  // Safety net: the authoritative rules engine has the final say. If the fast
  // board and chess.js ever disagree, play something chess.js accepts.
  const referee = new Chess(fen);
  const legal = referee.moves({ verbose: true });
  if (!legal.some((m) => m.from === picked.from && m.to === picked.to
    && (m.promotion || undefined) === picked.promotion)) {
    const fallback = legal[0];
    return fallback ? { from: fallback.from, to: fallback.to, promotion: fallback.promotion || undefined } : null;
  }
  return picked;
}
