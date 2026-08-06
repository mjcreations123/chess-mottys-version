// Move generation and attack detection. Works on ANY board state — it only
// reads actual square contents, so three queens generate three queens'
// worth of moves and a deleted bishop generates nothing. legalMoves() is
// the player's entire rulebook; the honest bot uses the same function.

import {
  EMPTY, P, N, B, R, Q, K,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
  F_CAPTURE, F_DOUBLE, F_EP, F_CASTLE_K, F_CASTLE_Q, F_PROMO,
  makeMv, SQ_E1, SQ_E8,
} from './constants.js';

export function isAttacked(board, s, byColor) {
  const sqs = board.squares;
  if (byColor > 0) {
    let t = s - 15;
    if (!(t & 0x88) && sqs[t] === P) return true;
    t = s - 17;
    if (!(t & 0x88) && sqs[t] === P) return true;
  } else {
    let t = s + 15;
    if (!(t & 0x88) && sqs[t] === -P) return true;
    t = s + 17;
    if (!(t & 0x88) && sqs[t] === -P) return true;
  }
  const knight = N * byColor;
  for (let i = 0; i < 8; i++) {
    const t = s + KNIGHT_DELTAS[i];
    if (!(t & 0x88) && sqs[t] === knight) return true;
  }
  const king = K * byColor;
  for (let i = 0; i < 8; i++) {
    const t = s + KING_DELTAS[i];
    if (!(t & 0x88) && sqs[t] === king) return true;
  }
  const bishop = B * byColor, queen = Q * byColor, rook = R * byColor;
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_DIRS[i];
    let t = s + d;
    while (!(t & 0x88)) {
      const p = sqs[t];
      if (p !== EMPTY) {
        if (p === bishop || p === queen) return true;
        break;
      }
      t += d;
    }
  }
  for (let i = 0; i < 4; i++) {
    const d = ROOK_DIRS[i];
    let t = s + d;
    while (!(t & 0x88)) {
      const p = sqs[t];
      if (p !== EMPTY) {
        if (p === rook || p === queen) return true;
        break;
      }
      t += d;
    }
  }
  return false;
}

function pushPromos(moves, from, to, flags) {
  moves.push(makeMv(from, to, flags | F_PROMO, Q));
  moves.push(makeMv(from, to, flags | F_PROMO, R));
  moves.push(makeMv(from, to, flags | F_PROMO, B));
  moves.push(makeMv(from, to, flags | F_PROMO, N));
}

function genPawn(board, s, color, moves) {
  const sqs = board.squares;
  const fwd = 16 * color;
  const promoRank = color > 0 ? 7 : 0;
  const homeRank = color > 0 ? 1 : 6;
  const one = s + fwd;
  if (!(one & 0x88) && sqs[one] === EMPTY) {
    if (one >> 4 === promoRank) pushPromos(moves, s, one, 0);
    else {
      moves.push(makeMv(s, one));
      const two = one + fwd;
      if (s >> 4 === homeRank && !(two & 0x88) && sqs[two] === EMPTY) {
        moves.push(makeMv(s, two, F_DOUBLE));
      }
    }
  }
  for (const d of [fwd + 1, fwd - 1]) {
    const t = s + d;
    if (t & 0x88) continue;
    const target = sqs[t];
    if (target !== EMPTY && (target > 0) !== (color > 0)) {
      if (t >> 4 === promoRank) pushPromos(moves, s, t, F_CAPTURE);
      else moves.push(makeMv(s, t, F_CAPTURE));
    } else if (t === board.epSquare && target === EMPTY) {
      moves.push(makeMv(s, t, F_EP | F_CAPTURE));
    }
  }
}

function genLeaper(board, s, color, deltas, moves) {
  const sqs = board.squares;
  for (let i = 0; i < deltas.length; i++) {
    const t = s + deltas[i];
    if (t & 0x88) continue;
    const target = sqs[t];
    if (target === EMPTY) moves.push(makeMv(s, t));
    else if ((target > 0) !== (color > 0)) moves.push(makeMv(s, t, F_CAPTURE));
  }
}

function genSlider(board, s, color, dirs, moves) {
  const sqs = board.squares;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    let t = s + d;
    while (!(t & 0x88)) {
      const target = sqs[t];
      if (target === EMPTY) moves.push(makeMv(s, t));
      else {
        if ((target > 0) !== (color > 0)) moves.push(makeMv(s, t, F_CAPTURE));
        break;
      }
      t += d;
    }
  }
}

function genCastles(board, s, color, moves) {
  // Piece-presence checks matter here: on cheated boards a rights bit can
  // outlive its rook for one mutation, and rights never imply reality.
  const sqs = board.squares;
  const enemy = -color;
  if (color > 0 && s === SQ_E1) {
    if (
      board.castling & CASTLE_WK &&
      sqs[5] === EMPTY && sqs[6] === EMPTY && sqs[7] === R &&
      !isAttacked(board, 4, enemy) &&
      !isAttacked(board, 5, enemy) &&
      !isAttacked(board, 6, enemy)
    ) {
      moves.push(makeMv(4, 6, F_CASTLE_K));
    }
    if (
      board.castling & CASTLE_WQ &&
      sqs[3] === EMPTY && sqs[2] === EMPTY && sqs[1] === EMPTY && sqs[0] === R &&
      !isAttacked(board, 4, enemy) &&
      !isAttacked(board, 3, enemy) &&
      !isAttacked(board, 2, enemy)
    ) {
      moves.push(makeMv(4, 2, F_CASTLE_Q));
    }
  } else if (color < 0 && s === SQ_E8) {
    if (
      board.castling & CASTLE_BK &&
      sqs[117] === EMPTY && sqs[118] === EMPTY && sqs[119] === -R &&
      !isAttacked(board, 116, enemy) &&
      !isAttacked(board, 117, enemy) &&
      !isAttacked(board, 118, enemy)
    ) {
      moves.push(makeMv(116, 118, F_CASTLE_K));
    }
    if (
      board.castling & CASTLE_BQ &&
      sqs[115] === EMPTY && sqs[114] === EMPTY && sqs[113] === EMPTY && sqs[112] === -R &&
      !isAttacked(board, 116, enemy) &&
      !isAttacked(board, 115, enemy) &&
      !isAttacked(board, 114, enemy)
    ) {
      moves.push(makeMv(116, 114, F_CASTLE_Q));
    }
  }
}

export function pseudoMoves(board, color) {
  const moves = [];
  const sqs = board.squares;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const piece = sqs[s];
    if (piece === EMPTY || (piece > 0) !== (color > 0)) continue;
    const type = piece > 0 ? piece : -piece;
    switch (type) {
      case P: genPawn(board, s, color, moves); break;
      case N: genLeaper(board, s, color, KNIGHT_DELTAS, moves); break;
      case B: genSlider(board, s, color, BISHOP_DIRS, moves); break;
      case R: genSlider(board, s, color, ROOK_DIRS, moves); break;
      case Q: genSlider(board, s, color, QUEEN_DIRS, moves); break;
      case K:
        genLeaper(board, s, color, KING_DELTAS, moves);
        genCastles(board, s, color, moves);
        break;
    }
  }
  return moves;
}

export function legalMoves(board, color) {
  const out = [];
  const pseudo = pseudoMoves(board, color);
  for (let i = 0; i < pseudo.length; i++) {
    const m = pseudo[i];
    const u = board.makeMove(m);
    const kingSq = color > 0 ? board.kingW : board.kingB;
    if (!isAttacked(board, kingSq, -color)) out.push(m);
    board.unmakeMove(u);
  }
  return out;
}

export const inCheck = (board, color) =>
  isAttacked(board, color > 0 ? board.kingW : board.kingB, -color);

export function perft(board, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(board, board.turn);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    const u = board.makeMove(moves[i]);
    nodes += perft(board, depth - 1);
    board.unmakeMove(u);
  }
  return nodes;
}
