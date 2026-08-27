// MottyBot's exchange judgment: given several candidate positions that all
// have the OPPONENT to move (the plain capture, and each possible
// homecoming), decide which one the deciding side likes best.
//
// The sign convention is the whole trick and deserves stating plainly:
// think() reports its score from the perspective of the side to move in the
// position it is given. Every candidate here has the opponent to move, so a
// candidate's score for the DECIDER is the negation of what think() returns.
// Getting this backwards would make MottyBot systematically donate material.

import { Chess } from '../vendor/chess.js';
import { think } from './engine-ai.js';

export function scoreForDecider(fen, level, seed, probeMs) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return 1000000; // the opponent is mated: perfect
  if (chess.isStalemate()) return 0;       // a dead draw
  const stats = {};
  think(fen, level, seed, { stats, blunderChance: 0, endgameBonus: 0, timeMs: probeMs });
  return -(stats.score ?? 0);
}

// Index of the best candidate for the decider. Ties keep the earliest index,
// so callers list the plain chess move first and a homecoming must strictly
// beat it.
export function chooseIndex(fens, level, seed, probeMs) {
  const scores = fens.map((fen, i) => scoreForDecider(fen, level, `${seed}#choice#${i}`, probeMs));
  let index = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[index]) index = i;
  }
  return { index, scores };
}
