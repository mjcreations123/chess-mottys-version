// A fast 0x88 board used ONLY by the search.
//
// The authoritative game state stays in chess.js: it owns the rules, the
// weekly house effects and the result. But chess.js allocates an object per move and
// rebuilds strings as it goes, which capped the search at roughly 1,500
// positions a second, i.e. three plies. Three plies is a beginner.
//
// This module is the opposite: a flat Int8Array, integer-encoded moves, and
// make/unmake that mutates in place with zero allocation. Correctness is
// pinned by perft against the published node counts (see perft.test.mjs), and
// every move the search finally returns is re-validated against chess.js
// before it is played, so a bug here can never produce an illegal move.

import { makeRng, seedFromString } from './rng.js';

export const EMPTY = 0;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;

// piece = type | (color << 3): white pawn 1, black pawn 9
export const colorOf = (piece) => piece >> 3;
export const typeOf = (piece) => piece & 7;

// 0x88: index = rank * 16 + file, with a1 = 0. A square is off-board when
// (index & 0x88) is non-zero, which makes bounds checks a single test.
export const sq0x88 = (file, rank) => rank * 16 + file;
export const fileOf = (sq) => sq & 15;
export const rankOf = (sq) => sq >> 4;
const onBoard = (sq) => (sq & 0x88) === 0;

const KNIGHT_DIRS = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_DIRS = [17, 15, -17, -15];
const ROOK_DIRS = [16, 1, -16, -1];
const KING_DIRS = [17, 16, 15, 1, -17, -16, -15, -1];

// Move packing: from | to<<7 | promo<<14 | kind<<17
export const KIND_NORMAL = 0, KIND_DOUBLE = 1, KIND_EP = 2, KIND_CASTLE = 3;
export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromo = (m) => (m >> 14) & 7;
export const moveKind = (m) => (m >> 17) & 7;
const encode = (from, to, promo, kind) => from | (to << 7) | (promo << 14) | (kind << 17);

// Castling rights bits
const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

const FEN_PIECES = {
  p: PAWN | 8, n: KNIGHT | 8, b: BISHOP | 8, r: ROOK | 8, q: QUEEN | 8, k: KING | 8,
  P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING,
};

/* ---------- Zobrist hashing ---------- */
// A 64-bit key carried as two 32-bit halves, because that is what JavaScript's
// bitwise operators actually work on. The numbers are drawn from a fixed seed,
// so the same position always hashes the same way in every process: the engine
// has to stay reproducible for a given (fen, seed).
//
// What is hashed: the pieces, the side to move, the castling mask, and the FILE
// of the en passant square. What is NOT hashed: the halfmove clock and the ply,
// which the search never reads, and which would make every node unique.
const ZOBRIST = (() => {
  const rng = makeRng(seedFromString('mottybot-zobrist-v1'));
  const word = () => (Math.floor(rng.next() * 4294967296) | 0);
  const pair = (n) => {
    const lo = new Int32Array(n);
    const hi = new Int32Array(n);
    for (let i = 0; i < n; i++) { lo[i] = word(); hi[i] = word(); }
    return { lo, hi };
  };
  return {
    piece: pair(16 * 128),   // (piece code << 7) | square
    castle: pair(16),        // the whole 4-bit mask, so repeated clears are safe
    epFile: pair(8),
    sideLo: word(),
    sideHi: word(),
  };
})();

const pieceIndex = (piece, square) => (piece << 7) | square;

export class FastBoard {
  constructor(fen) {
    this.squares = new Int8Array(128);
    this.kings = new Int32Array(2);
    this.undoStack = [];
    this.ply = 0;
    if (fen) this.loadFen(fen);
  }

  loadFen(fen) {
    this.squares.fill(EMPTY);
    const [placement, turn, castling, ep, half] = fen.trim().split(/\s+/);
    let rank = 7;
    let file = 0;
    for (const ch of placement) {
      if (ch === '/') { rank--; file = 0; continue; }
      if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
      const piece = FEN_PIECES[ch];
      const sq = sq0x88(file, rank);
      this.squares[sq] = piece;
      if (typeOf(piece) === KING) this.kings[colorOf(piece)] = sq;
      file++;
    }
    this.turn = turn === 'w' ? WHITE : BLACK;
    this.castling = 0;
    if (castling && castling !== '-') {
      if (castling.includes('K')) this.castling |= CASTLE_WK;
      if (castling.includes('Q')) this.castling |= CASTLE_WQ;
      if (castling.includes('k')) this.castling |= CASTLE_BK;
      if (castling.includes('q')) this.castling |= CASTLE_BQ;
    }
    this.ep = (ep && ep !== '-')
      ? sq0x88(ep.charCodeAt(0) - 97, ep.charCodeAt(1) - 49)
      : -1;
    this.half = Number(half) || 0;
    this.undoStack.length = 0;
    this.ply = 0;
    this.rehash();
  }

  // Recompute the key from scratch. Called once when a position is loaded, and
  // by the test that proves the incremental updates never drift.
  rehash() {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const piece = this.squares[sq];
      if (piece === EMPTY) continue;
      const i = pieceIndex(piece, sq);
      lo ^= ZOBRIST.piece.lo[i];
      hi ^= ZOBRIST.piece.hi[i];
    }
    lo ^= ZOBRIST.castle.lo[this.castling];
    hi ^= ZOBRIST.castle.hi[this.castling];
    if (this.ep >= 0) {
      const f = fileOf(this.ep);
      lo ^= ZOBRIST.epFile.lo[f];
      hi ^= ZOBRIST.epFile.hi[f];
    }
    if (this.turn !== WHITE) { lo ^= ZOBRIST.sideLo; hi ^= ZOBRIST.sideHi; }
    this.keyLo = lo | 0;
    this.keyHi = hi | 0;
  }

  #xorPiece(piece, square) {
    const i = pieceIndex(piece, square);
    this.keyLo ^= ZOBRIST.piece.lo[i];
    this.keyHi ^= ZOBRIST.piece.hi[i];
  }

  /* ---------- attacks ---------- */
  // Is `sq` attacked by any piece of `by`? Used for legality and for check.
  isAttacked(sq, by) {
    const pawn = by === WHITE ? PAWN : (PAWN | 8);
    // a white pawn on sq-15/sq-17 attacks sq; mirrored for black
    if (by === WHITE) {
      let f = sq - 17;
      if (onBoard(f) && this.squares[f] === pawn) return true;
      f = sq - 15;
      if (onBoard(f) && this.squares[f] === pawn) return true;
    } else {
      let f = sq + 17;
      if (onBoard(f) && this.squares[f] === pawn) return true;
      f = sq + 15;
      if (onBoard(f) && this.squares[f] === pawn) return true;
    }

    const knight = by === WHITE ? KNIGHT : (KNIGHT | 8);
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_DIRS[i];
      if (onBoard(t) && this.squares[t] === knight) return true;
    }

    const king = by === WHITE ? KING : (KING | 8);
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_DIRS[i];
      if (onBoard(t) && this.squares[t] === king) return true;
    }

    const bishop = by === WHITE ? BISHOP : (BISHOP | 8);
    const queen = by === WHITE ? QUEEN : (QUEEN | 8);
    for (let i = 0; i < 4; i++) {
      const dir = BISHOP_DIRS[i];
      for (let t = sq + dir; onBoard(t); t += dir) {
        const piece = this.squares[t];
        if (piece !== EMPTY) {
          if (piece === bishop || piece === queen) return true;
          break;
        }
      }
    }

    const rook = by === WHITE ? ROOK : (ROOK | 8);
    for (let i = 0; i < 4; i++) {
      const dir = ROOK_DIRS[i];
      for (let t = sq + dir; onBoard(t); t += dir) {
        const piece = this.squares[t];
        if (piece !== EMPTY) {
          if (piece === rook || piece === queen) return true;
          break;
        }
      }
    }
    return false;
  }

  inCheck(color = this.turn) {
    return this.isAttacked(this.kings[color], color ^ 1);
  }

  /* ---------- move generation ---------- */
  // Appends pseudo-legal moves into `out` (an array) and returns its length.
  // `capturesOnly` drives quiescence.
  generate(out, capturesOnly = false) {
    out.length = 0;
    const us = this.turn;
    const them = us ^ 1;
    const forward = us === WHITE ? 16 : -16;
    const startRank = us === WHITE ? 1 : 6;
    const promoRank = us === WHITE ? 7 : 0;

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const piece = this.squares[sq];
      if (piece === EMPTY || colorOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const one = sq + forward;
        if (onBoard(one) && this.squares[one] === EMPTY) {
          if (!capturesOnly) {
            if (rankOf(one) === promoRank) {
              out.push(encode(sq, one, QUEEN, KIND_NORMAL), encode(sq, one, ROOK, KIND_NORMAL),
                encode(sq, one, BISHOP, KIND_NORMAL), encode(sq, one, KNIGHT, KIND_NORMAL));
            } else {
              out.push(encode(sq, one, 0, KIND_NORMAL));
              const two = one + forward;
              if (rankOf(sq) === startRank && this.squares[two] === EMPTY) {
                out.push(encode(sq, two, 0, KIND_DOUBLE));
              }
            }
          } else if (rankOf(one) === promoRank) {
            out.push(encode(sq, one, QUEEN, KIND_NORMAL));
          }
        }
        for (const side of [-1, 1]) {
          const t = sq + forward + side;
          if (!onBoard(t)) continue;
          const target = this.squares[t];
          if (target !== EMPTY && colorOf(target) === them) {
            if (rankOf(t) === promoRank) {
              out.push(encode(sq, t, QUEEN, KIND_NORMAL), encode(sq, t, ROOK, KIND_NORMAL),
                encode(sq, t, BISHOP, KIND_NORMAL), encode(sq, t, KNIGHT, KIND_NORMAL));
            } else {
              out.push(encode(sq, t, 0, KIND_NORMAL));
            }
          } else if (t === this.ep && target === EMPTY) {
            out.push(encode(sq, t, 0, KIND_EP));
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const dirs = type === KNIGHT ? KNIGHT_DIRS : KING_DIRS;
        for (let i = 0; i < 8; i++) {
          const t = sq + dirs[i];
          if (!onBoard(t)) continue;
          const target = this.squares[t];
          if (target === EMPTY) { if (!capturesOnly) out.push(encode(sq, t, 0, KIND_NORMAL)); }
          else if (colorOf(target) === them) out.push(encode(sq, t, 0, KIND_NORMAL));
        }
        continue;
      }

      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_DIRS;
      const count = type === QUEEN ? 8 : 4;
      for (let i = 0; i < count; i++) {
        const dir = dirs[i];
        for (let t = sq + dir; onBoard(t); t += dir) {
          const target = this.squares[t];
          if (target === EMPTY) {
            if (!capturesOnly) out.push(encode(sq, t, 0, KIND_NORMAL));
            continue;
          }
          if (colorOf(target) === them) out.push(encode(sq, t, 0, KIND_NORMAL));
          break;
        }
      }
    }

    if (!capturesOnly) this.#generateCastles(out, us);
    return out.length;
  }

  #generateCastles(out, us) {
    const them = us ^ 1;
    if (us === WHITE) {
      if ((this.castling & CASTLE_WK) && this.squares[5] === EMPTY && this.squares[6] === EMPTY
        && !this.isAttacked(4, them) && !this.isAttacked(5, them) && !this.isAttacked(6, them)) {
        out.push(encode(4, 6, 0, KIND_CASTLE));
      }
      if ((this.castling & CASTLE_WQ) && this.squares[3] === EMPTY && this.squares[2] === EMPTY && this.squares[1] === EMPTY
        && !this.isAttacked(4, them) && !this.isAttacked(3, them) && !this.isAttacked(2, them)) {
        out.push(encode(4, 2, 0, KIND_CASTLE));
      }
    } else {
      if ((this.castling & CASTLE_BK) && this.squares[117] === EMPTY && this.squares[118] === EMPTY
        && !this.isAttacked(116, them) && !this.isAttacked(117, them) && !this.isAttacked(118, them)) {
        out.push(encode(116, 118, 0, KIND_CASTLE));
      }
      if ((this.castling & CASTLE_BQ) && this.squares[115] === EMPTY && this.squares[114] === EMPTY && this.squares[113] === EMPTY
        && !this.isAttacked(116, them) && !this.isAttacked(115, them) && !this.isAttacked(114, them)) {
        out.push(encode(116, 114, 0, KIND_CASTLE));
      }
    }
  }

  /* ---------- make / unmake ---------- */
  make(move) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const kind = moveKind(move);
    const promo = movePromo(move);
    const piece = this.squares[from];
    const us = colorOf(piece);
    const type = typeOf(piece);

    let capturedSq = to;
    if (kind === KIND_EP) capturedSq = us === WHITE ? to - 16 : to + 16;
    const captured = this.squares[capturedSq];

    this.undoStack.push({
      move, captured, capturedSq,
      castling: this.castling, ep: this.ep, half: this.half,
      keyLo: this.keyLo, keyHi: this.keyHi,
    });

    const castlingBefore = this.castling;
    const epBefore = this.ep;
    const placed = promo ? (promo | (us << 3)) : piece;
    if (captured !== EMPTY) this.#xorPiece(captured, capturedSq);
    this.#xorPiece(piece, from);
    this.#xorPiece(placed, to);

    this.squares[capturedSq] = EMPTY;
    this.squares[from] = EMPTY;
    this.squares[to] = promo ? (promo | (us << 3)) : piece;

    if (type === KING) {
      this.kings[us] = to;
      this.castling &= us === WHITE ? ~(CASTLE_WK | CASTLE_WQ) : ~(CASTLE_BK | CASTLE_BQ);
      if (kind === KIND_CASTLE) {
        // shuffle the rook across
        let rookFrom = -1;
        let rookTo = -1;
        if (to === 6) { rookFrom = 7; rookTo = 5; }
        else if (to === 2) { rookFrom = 0; rookTo = 3; }
        else if (to === 118) { rookFrom = 119; rookTo = 117; }
        else if (to === 114) { rookFrom = 112; rookTo = 115; }
        if (rookFrom >= 0) {
          const rook = this.squares[rookFrom];
          this.squares[rookTo] = rook;
          this.squares[rookFrom] = EMPTY;
          this.#xorPiece(rook, rookFrom);
          this.#xorPiece(rook, rookTo);
        }
      }
    }

    // a rook leaving or being captured on a corner kills that right
    if (from === 0 || to === 0) this.castling &= ~CASTLE_WQ;
    if (from === 7 || to === 7) this.castling &= ~CASTLE_WK;
    if (from === 112 || to === 112) this.castling &= ~CASTLE_BQ;
    if (from === 119 || to === 119) this.castling &= ~CASTLE_BK;

    this.ep = kind === KIND_DOUBLE ? (us === WHITE ? from + 16 : from - 16) : -1;
    this.half = (type === PAWN || captured !== EMPTY) ? 0 : this.half + 1;
    this.turn ^= 1;
    this.ply++;

    // The castling mask is folded as a whole, because the clears above are
    // idempotent and XORing per bit would undo itself on a repeat.
    if (this.castling !== castlingBefore) {
      this.keyLo ^= ZOBRIST.castle.lo[castlingBefore] ^ ZOBRIST.castle.lo[this.castling];
      this.keyHi ^= ZOBRIST.castle.hi[castlingBefore] ^ ZOBRIST.castle.hi[this.castling];
    }
    if (epBefore >= 0) {
      const f = fileOf(epBefore);
      this.keyLo ^= ZOBRIST.epFile.lo[f];
      this.keyHi ^= ZOBRIST.epFile.hi[f];
    }
    if (this.ep >= 0) {
      const f = fileOf(this.ep);
      this.keyLo ^= ZOBRIST.epFile.lo[f];
      this.keyHi ^= ZOBRIST.epFile.hi[f];
    }
    this.keyLo ^= ZOBRIST.sideLo;
    this.keyHi ^= ZOBRIST.sideHi;
  }

  unmake() {
    const undo = this.undoStack.pop();
    const { move, captured, capturedSq } = undo;
    const from = moveFrom(move);
    const to = moveTo(move);
    const kind = moveKind(move);
    const promo = movePromo(move);

    this.turn ^= 1;
    this.ply--;
    const us = this.turn;

    const moved = promo ? (PAWN | (us << 3)) : this.squares[to];
    this.squares[from] = moved;
    this.squares[to] = EMPTY;
    if (captured !== EMPTY) this.squares[capturedSq] = captured;

    if (typeOf(moved) === KING) {
      this.kings[us] = from;
      if (kind === KIND_CASTLE) {
        if (to === 6) { this.squares[7] = this.squares[5]; this.squares[5] = EMPTY; }
        else if (to === 2) { this.squares[0] = this.squares[3]; this.squares[3] = EMPTY; }
        else if (to === 118) { this.squares[119] = this.squares[117]; this.squares[117] = EMPTY; }
        else if (to === 114) { this.squares[112] = this.squares[115]; this.squares[115] = EMPTY; }
      }
    }

    this.castling = undo.castling;
    this.ep = undo.ep;
    this.half = undo.half;
    this.keyLo = undo.keyLo;
    this.keyHi = undo.keyHi;
  }

  // Make only if the move leaves our own king safe. Returns false (and leaves
  // the board untouched) otherwise.
  makeIfLegal(move) {
    const us = this.turn;
    this.make(move);
    if (this.isAttacked(this.kings[us], us ^ 1)) { this.unmake(); return false; }
    return true;
  }

  legalMoves() {
    const pseudo = [];
    this.generate(pseudo);
    const legal = [];
    for (let i = 0; i < pseudo.length; i++) {
      if (this.makeIfLegal(pseudo[i])) { legal.push(pseudo[i]); this.unmake(); }
    }
    return legal;
  }
}

/* ---------- conversion helpers ---------- */
const FILES = 'abcdefgh';
export const squareName = (sq) => FILES[fileOf(sq)] + (rankOf(sq) + 1);
export const nameToSquare = (name) => sq0x88(name.charCodeAt(0) - 97, name.charCodeAt(1) - 49);
const PROMO_LETTER = { [QUEEN]: 'q', [ROOK]: 'r', [BISHOP]: 'b', [KNIGHT]: 'n' };

export function moveToUci(move) {
  const promo = movePromo(move);
  return {
    from: squareName(moveFrom(move)),
    to: squareName(moveTo(move)),
    promotion: promo ? PROMO_LETTER[promo] : undefined,
  };
}

export function perft(board, depth) {
  if (depth === 0) return 1;
  const moves = [];
  board.generate(moves);
  let nodes = 0;
  for (let i = 0; i < moves.length; i++) {
    if (!board.makeIfLegal(moves[i])) continue;
    nodes += depth === 1 ? 1 : perft(board, depth - 1);
    board.unmake();
  }
  return nodes;
}
