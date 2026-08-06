// The mandatory verification pass: no cheat ships without proof it works.
// Snapshot -> apply -> let White search for its best revenge -> restore.
// A cheat must clear its tier's eval floor AND never leave White silently
// stalemated (a draw is a loss, and MottyBot does not lose).

import { EMPTY, P, Q, K, WHITE, BLACK, alg, PIECE_LETTERS } from '../constants.js';
import { legalMoves, inCheck, isAttacked } from '../movegen.js';
import { MATE } from '../search.js';
import { VALUES } from '../eval.js';

// Eval floors by tier: audacity must pay for itself.
export const TIER_FLOOR = { 1: -50, 2: 100, 3: 250 };

export function applyMutations(board, muts) {
  const removedWhite = [], removedBlack = [];
  for (const mu of muts) {
    let displaced = EMPTY;
    switch (mu.op) {
      case 'move': displaced = board.forceMove(mu.from, mu.to); break;
      case 'set': displaced = board.forceSet(mu.sq, mu.piece); break;
      case 'remove': displaced = board.forceRemove(mu.sq); break;
      case 'convert': board.forceConvert(mu.sq, mu.piece); break;
      case 'swap': board.forceSwap(mu.a, mu.b); break;
      default: throw new Error(`unknown mutation op: ${mu.op}`);
    }
    if (displaced > 0) removedWhite.push(displaced);
    else if (displaced < 0) removedBlack.push(displaced);
  }
  return { removedWhite, removedBlack };
}

export function verifyCheat(board, search, candidate, floor, opts = {}) {
  const snap = board.snapshot();
  try {
    applyMutations(board, candidate.muts);
    board.setTurn(WHITE);

    // no black pawns may ever sit on a back rank
    for (const rank of [0, 7]) {
      for (let f = 0; f < 8; f++) {
        if (board.squares[rank * 16 + f] === -P) return { ok: false, reason: 'pawn-on-back-rank' };
      }
    }

    const whiteMoves = legalMoves(board, WHITE);
    const whiteInCheck = inCheck(board, WHITE);
    if (whiteMoves.length === 0) {
      if (whiteInCheck) return { ok: true, evalAfter: MATE, mate: true };
      return { ok: false, reason: 'white-stalemated' };
    }
    if (!candidate.allowsKingEnPrise && isAttacked(board, board.kingB, WHITE)) {
      return { ok: false, reason: 'king-en-prise' };
    }

    const res = search.think(board, {
      msBudget: opts.verifyMs ?? 35,
      maxDepth: opts.verifyDepth ?? 2,
    });
    const evalAfter = -res.score; // Black's (MottyBot's) perspective
    return { ok: evalAfter >= floor, evalAfter };
  } finally {
    board.restore(snap);
  }
}

// The terminal fallback that always verifies: every White piece except the
// king and pawns "was captured earlier", and a fresh queen reports for
// duty. Iterates queen squares until one passes verification.
export function buildFallback(board) {
  const removals = [];
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = board.squares[s];
    if (piece > 0 && piece !== K && piece !== P) removals.push({ op: 'remove', sq: s });
  }
  const candidates = [];
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    if (board.squares[s] !== EMPTY) continue;
    candidates.push({
      id: 'MASS_DELETE', tier: 3, drama: 75,
      score: 2000,
      muts: [...removals, { op: 'set', sq: s, piece: -Q }],
      events: [
        ...removals.map((mu) => ({
          type: 'remove',
          square: alg(mu.sq),
          piece: { type: PIECE_LETTERS[board.squares[mu.sq]], color: 'w' },
          cheat: { id: 'MASS_DELETE', tier: 3 },
        })),
        { type: 'spawn', square: alg(s), piece: { type: 'q', color: 'b' }, cheat: { id: 'MASS_DELETE', tier: 3 } },
      ],
      notation: null,
      isFallback: true,
    });
  }
  return candidates;
}
