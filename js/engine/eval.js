// Static evaluation, centipawns from White's perspective. Reads the real
// board only — a cheated third queen is naturally worth 900, a deleted
// bishop is naturally gone. No assumptions about standard material.

import { EMPTY, P, N, B, R, Q, K } from './constants.js';

export const VALUES = [0, 100, 320, 330, 500, 900, 0];

// Piece-square tables (the classic public-domain "simplified evaluation"
// set), written as printed: first row = rank 8, from White's point of view.
const PST_P = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
const PST_N = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
const PST_B = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
const PST_R = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];
const PST_Q = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
const PST_K_MID = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
const PST_K_END = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

// Expand to 0x88-indexed tables: PST_MID/END[(piece+6)*128 + sq].
const PST_MID = new Int16Array(13 * 128);
const PST_END = new Int16Array(13 * 128);
{
  const printed = [null, PST_P, PST_N, PST_B, PST_R, PST_Q, null];
  for (let type = P; type <= K; type++) {
    const midTable = type === K ? PST_K_MID : printed[type];
    const endTable = type === K ? PST_K_END : printed[type];
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const s = rank * 16 + file;
        const whiteIdx = (7 - rank) * 8 + file;
        const blackIdx = rank * 8 + file;
        PST_MID[(type + 6) * 128 + s] = midTable[whiteIdx];
        PST_END[(type + 6) * 128 + s] = endTable[whiteIdx];
        PST_MID[(-type + 6) * 128 + s] = -midTable[blackIdx];
        PST_END[(-type + 6) * 128 + s] = -endTable[blackIdx];
      }
    }
  }
}

const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0]; // by piece type; startpos total 24
const PASSED_BONUS = [0, 5, 10, 20, 35, 60, 100, 0]; // by rank of advancement

// Score from White's perspective. `sideToMove` gets a small tempo bonus.
export function evaluate(board) {
  const sqs = board.squares;
  let material = 0, mid = 0, end = 0, phase = 0;
  let whiteBishops = 0, blackBishops = 0;

  // pawn info: per-file counts and extremes for doubled/passed detection
  const wPawnCount = [0, 0, 0, 0, 0, 0, 0, 0];
  const bPawnCount = [0, 0, 0, 0, 0, 0, 0, 0];
  const wPawnMinRank = [8, 8, 8, 8, 8, 8, 8, 8];
  const bPawnMaxRank = [-1, -1, -1, -1, -1, -1, -1, -1];
  const wPawns = [], bPawns = [];

  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = sqs[s];
    if (piece === EMPTY) continue;
    const type = piece > 0 ? piece : -piece;
    const idx = (piece + 6) * 128 + s;
    material += piece > 0 ? VALUES[type] : -VALUES[type];
    mid += PST_MID[idx];
    end += PST_END[idx];
    phase += PHASE_WEIGHT[type];
    if (piece === B) whiteBishops++;
    else if (piece === -B) blackBishops++;
    else if (piece === P) {
      const f = s & 15, r = s >> 4;
      wPawnCount[f]++;
      if (r < wPawnMinRank[f]) wPawnMinRank[f] = r;
      wPawns.push(s);
    } else if (piece === -P) {
      const f = s & 15, r = s >> 4;
      bPawnCount[f]++;
      if (r > bPawnMaxRank[f]) bPawnMaxRank[f] = r;
      bPawns.push(s);
    }
  }

  let score = material;
  const midWeight = Math.min(phase, 24) / 24;
  score += Math.round(mid * midWeight + end * (1 - midWeight));

  if (whiteBishops >= 2) score += 30;
  if (blackBishops >= 2) score -= 30;

  for (let f = 0; f < 8; f++) {
    if (wPawnCount[f] > 1) score -= 15 * (wPawnCount[f] - 1);
    if (bPawnCount[f] > 1) score += 15 * (bPawnCount[f] - 1);
  }

  for (const s of wPawns) {
    const f = s & 15, r = s >> 4;
    let passed = true;
    for (let ff = f - 1; ff <= f + 1; ff++) {
      if (ff >= 0 && ff < 8 && bPawnMaxRank[ff] > r) { passed = false; break; }
    }
    if (passed) score += PASSED_BONUS[r];
  }
  for (const s of bPawns) {
    const f = s & 15, r = s >> 4;
    let passed = true;
    for (let ff = f - 1; ff <= f + 1; ff++) {
      if (ff >= 0 && ff < 8 && wPawnMinRank[ff] < r) { passed = false; break; }
    }
    if (passed) score -= PASSED_BONUS[7 - r];
  }

  // king pawn shield, midgame only, kings on their first two ranks
  if (midWeight > 0.3) {
    const wk = board.kingW;
    if (wk >> 4 <= 1) {
      for (const d of [15, 16, 17]) {
        const t = wk + d;
        if (!(t & 0x88) && sqs[t] === P) score += 10;
      }
    }
    const bk = board.kingB;
    if (bk >> 4 >= 6) {
      for (const d of [-15, -16, -17]) {
        const t = bk + d;
        if (!(t & 0x88) && sqs[t] === -P) score -= 10;
      }
    }
  }

  score += board.turn > 0 ? 10 : -10; // tempo
  return score;
}

// Fast material-only diff (White's perspective) for referee bookkeeping.
export function materialDiff(board) {
  const sqs = board.squares;
  let material = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = sqs[s];
    if (piece === EMPTY) continue;
    material += piece > 0 ? VALUES[piece] : -VALUES[-piece];
  }
  return material;
}
