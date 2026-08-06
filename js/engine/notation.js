// Standard algebraic notation for rule-shaped moves. Cheat moves carry
// their own deranged notation strings from the generators; this module is
// for the moves that are actually legal. A player move that "mates" Black
// happily gets its '#' — the fact that the game then continues is not this
// module's problem. (It is, officially, nobody's problem.)

import {
  P, FILES, PIECE_LETTERS, alg,
  mvFrom, mvTo, mvFlags, mvPromo,
  F_CAPTURE, F_CASTLE_K, F_CASTLE_Q, F_PROMO,
} from './constants.js';
import { legalMoves, inCheck } from './movegen.js';

// board must be in the state BEFORE the move.
export function toSAN(board, m) {
  const flags = mvFlags(m);
  const from = mvFrom(m), to = mvTo(m);
  const piece = board.squares[from];
  const type = piece > 0 ? piece : -piece;
  const color = piece > 0 ? 1 : -1;
  let san;

  if (flags & F_CASTLE_K) san = 'O-O';
  else if (flags & F_CASTLE_Q) san = 'O-O-O';
  else if (type === P) {
    san = flags & F_CAPTURE ? FILES[from & 15] + 'x' + alg(to) : alg(to);
    if (flags & F_PROMO) san += '=' + PIECE_LETTERS[mvPromo(m)].toUpperCase();
  } else {
    let sameFile = false, sameRank = false, others = 0;
    for (const lm of legalMoves(board, color)) {
      const lf = mvFrom(lm);
      if (lf === from || mvTo(lm) !== to) continue;
      if (board.squares[lf] !== piece) continue;
      others++;
      if ((lf & 15) === (from & 15)) sameFile = true;
      if (lf >> 4 === from >> 4) sameRank = true;
    }
    let disamb = '';
    if (others) {
      if (!sameFile) disamb = FILES[from & 15];
      else if (!sameRank) disamb = String((from >> 4) + 1);
      else disamb = alg(from);
    }
    san =
      PIECE_LETTERS[type].toUpperCase() +
      disamb +
      (flags & F_CAPTURE ? 'x' : '') +
      alg(to);
  }

  const u = board.makeMove(m);
  if (inCheck(board, -color)) {
    san += legalMoves(board, -color).length === 0 ? '#' : '+';
  }
  board.unmakeMove(u);
  return san;
}
