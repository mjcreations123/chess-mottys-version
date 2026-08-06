// One board that tolerates arbitrary states (three black queens, ignored
// checks, pieces that were never born). Legality is a policy applied per
// side by movegen/game — never a property of the board itself.
//
// Two ways to touch squares:
//   makeMove/unmakeMove — rule-shaped moves, incremental hash, undoable.
//   force*              — MottyBot's cheats. Arbitrary, rehash from scratch.
//
// Invariant: exactly one king per side, always. forceRemove/forceSet throw
// rather than delete or overwrite a king; captures of kings are impossible
// (game.js intercepts with the king-dodge protocol before it gets here).

import {
  EMPTY, P, N, B, R, Q, K, WHITE, BLACK,
  CASTLE_WK, CASTLE_WQ, CASTLE_BK, CASTLE_BQ,
  F_CAPTURE, F_DOUBLE, F_EP, F_CASTLE_K, F_CASTLE_Q, F_PROMO,
  mvFrom, mvTo, mvFlags, mvPromo,
  PIECE_LETTERS, parseSquare, alg,
  SQ_A1, SQ_E1, SQ_H1, SQ_A8, SQ_E8, SQ_H8,
} from './constants.js';
import { mulberry32 } from './rng.js';

// --- Zobrist tables (deterministic seed => stable hashes across runs) ---
const zr = mulberry32(0xc0ffee);
const rand32 = () => (zr() * 0x100000000) | 0;

const Z_PIECE_LO = new Int32Array(13 * 128);
const Z_PIECE_HI = new Int32Array(13 * 128);
for (let i = 0; i < 13 * 128; i++) {
  Z_PIECE_LO[i] = rand32();
  Z_PIECE_HI[i] = rand32();
}
const Z_CASTLE_LO = new Int32Array(16);
const Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  Z_CASTLE_LO[i] = rand32();
  Z_CASTLE_HI[i] = rand32();
}
const Z_EP_LO = new Int32Array(16);
const Z_EP_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  Z_EP_LO[i] = rand32();
  Z_EP_HI[i] = rand32();
}
const Z_TURN_LO = rand32();
const Z_TURN_HI = rand32();

// castling rights surviving a move touching square s: rights &= CASTLE_MASK[s]
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[SQ_E1] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[SQ_H1] = 15 & ~CASTLE_WK;
CASTLE_MASK[SQ_A1] = 15 & ~CASTLE_WQ;
CASTLE_MASK[SQ_E8] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[SQ_H8] = 15 & ~CASTLE_BK;
CASTLE_MASK[SQ_A8] = 15 & ~CASTLE_BQ;

export class Board {
  constructor() {
    this.squares = new Int8Array(128);
    this.turn = WHITE;
    this.castling = 0;
    this.epSquare = -1;
    this.kingW = -1;
    this.kingB = -1;
    this.ply = 0;
    this.hashLo = 0;
    this.hashHi = 0;
    // Real-game capture trays (game.js fills these on commit; search never
    // touches them). white: white pieces now in MottyBot's tray; black:
    // black pieces the player captured — MottyBot's resurrection fuel.
    this.captured = { white: [], black: [] };
  }

  static fromFEN(fen) {
    const b = new Board();
    const parts = fen.trim().split(/\s+/);
    const [placement, turn = 'w', castle = '-', ep = '-'] = parts;
    let rank = 7, file = 0;
    for (const ch of placement) {
      if (ch === '/') { rank--; file = 0; continue; }
      if (ch >= '1' && ch <= '8') { file += ch.charCodeAt(0) - 48; continue; }
      const lower = ch.toLowerCase();
      const type = PIECE_LETTERS.indexOf(lower);
      if (type <= 0) throw new Error(`bad FEN piece: ${ch}`);
      const piece = ch === lower ? -type : type;
      const s = rank * 16 + file;
      b.squares[s] = piece;
      if (piece === K) b.kingW = s;
      if (piece === -K) b.kingB = s;
      file++;
    }
    b.turn = turn === 'b' ? BLACK : WHITE;
    b.castling =
      (castle.includes('K') ? CASTLE_WK : 0) |
      (castle.includes('Q') ? CASTLE_WQ : 0) |
      (castle.includes('k') ? CASTLE_BK : 0) |
      (castle.includes('q') ? CASTLE_BQ : 0);
    b.epSquare = ep !== '-' ? parseSquare(ep) : -1;
    if (b.kingW < 0 || b.kingB < 0) throw new Error('FEN must include both kings');
    b.rehash();
    return b;
  }

  static startpos() {
    return Board.fromFEN(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    );
  }

  toFEN() {
    let out = '';
    for (let rank = 7; rank >= 0; rank--) {
      let run = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.squares[rank * 16 + file];
        if (piece === EMPTY) { run++; continue; }
        if (run) { out += run; run = 0; }
        const letter = PIECE_LETTERS[piece < 0 ? -piece : piece];
        out += piece > 0 ? letter.toUpperCase() : letter;
      }
      if (run) out += run;
      if (rank) out += '/';
    }
    let castle = '';
    if (this.castling & CASTLE_WK) castle += 'K';
    if (this.castling & CASTLE_WQ) castle += 'Q';
    if (this.castling & CASTLE_BK) castle += 'k';
    if (this.castling & CASTLE_BQ) castle += 'q';
    return [
      out,
      this.turn === WHITE ? 'w' : 'b',
      castle || '-',
      this.epSquare >= 0 ? alg(this.epSquare) : '-',
      0,
      (this.ply >> 1) + 1,
    ].join(' ');
  }

  rehash() {
    let lo = 0, hi = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.squares[s];
      if (p !== EMPTY) {
        const i = (p + 6) * 128 + s;
        lo ^= Z_PIECE_LO[i];
        hi ^= Z_PIECE_HI[i];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.epSquare >= 0) {
      lo ^= Z_EP_LO[this.epSquare & 15];
      hi ^= Z_EP_HI[this.epSquare & 15];
    }
    if (this.turn === BLACK) { lo ^= Z_TURN_LO; hi ^= Z_TURN_HI; }
    this.hashLo = lo | 0;
    this.hashHi = hi | 0;
  }

  hashKey() {
    return this.hashLo + ':' + this.hashHi;
  }

  // --- rule-shaped moves (undoable, incremental hash) ---

  makeMove(m) {
    const from = mvFrom(m), to = mvTo(m), flags = mvFlags(m);
    const piece = this.squares[from];
    const color = piece > 0 ? 1 : -1;
    const undo = {
      m, piece,
      captured: EMPTY, capturedSq: -1,
      castling: this.castling, ep: this.epSquare,
      kingW: this.kingW, kingB: this.kingB,
      hashLo: this.hashLo, hashHi: this.hashHi,
      turn: this.turn,
    };

    this.hashLo ^= Z_CASTLE_LO[this.castling];
    this.hashHi ^= Z_CASTLE_HI[this.castling];
    if (this.epSquare >= 0) {
      this.hashLo ^= Z_EP_LO[this.epSquare & 15];
      this.hashHi ^= Z_EP_HI[this.epSquare & 15];
    }

    let capSq = -1;
    if (flags & F_EP) capSq = to - 16 * color;
    else if (this.squares[to] !== EMPTY) capSq = to;
    if (capSq >= 0) {
      const cap = this.squares[capSq];
      undo.captured = cap;
      undo.capturedSq = capSq;
      const ci = (cap + 6) * 128 + capSq;
      this.hashLo ^= Z_PIECE_LO[ci];
      this.hashHi ^= Z_PIECE_HI[ci];
      this.squares[capSq] = EMPTY;
    }

    const fi = (piece + 6) * 128 + from;
    this.hashLo ^= Z_PIECE_LO[fi];
    this.hashHi ^= Z_PIECE_HI[fi];
    this.squares[from] = EMPTY;

    const placed = flags & F_PROMO ? mvPromo(m) * color : piece;
    const ti = (placed + 6) * 128 + to;
    this.hashLo ^= Z_PIECE_LO[ti];
    this.hashHi ^= Z_PIECE_HI[ti];
    this.squares[to] = placed;

    if (flags & (F_CASTLE_K | F_CASTLE_Q)) {
      const rook = R * color;
      const rFrom = flags & F_CASTLE_K ? to + 1 : to - 2;
      const rTo = flags & F_CASTLE_K ? to - 1 : to + 1;
      const rfi = (rook + 6) * 128 + rFrom;
      const rti = (rook + 6) * 128 + rTo;
      this.hashLo ^= Z_PIECE_LO[rfi] ^ Z_PIECE_LO[rti];
      this.hashHi ^= Z_PIECE_HI[rfi] ^ Z_PIECE_HI[rti];
      this.squares[rFrom] = EMPTY;
      this.squares[rTo] = rook;
    }

    if (piece === K) this.kingW = to;
    else if (piece === -K) this.kingB = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    this.epSquare = flags & F_DOUBLE ? from + 16 * color : -1;

    this.hashLo ^= Z_CASTLE_LO[this.castling];
    this.hashHi ^= Z_CASTLE_HI[this.castling];
    if (this.epSquare >= 0) {
      this.hashLo ^= Z_EP_LO[this.epSquare & 15];
      this.hashHi ^= Z_EP_HI[this.epSquare & 15];
    }
    this.hashLo ^= Z_TURN_LO;
    this.hashHi ^= Z_TURN_HI;

    this.turn = -this.turn;
    this.ply++;
    return undo;
  }

  unmakeMove(u) {
    const from = mvFrom(u.m), to = mvTo(u.m), flags = mvFlags(u.m);
    const color = u.piece > 0 ? 1 : -1;
    this.squares[to] = EMPTY;
    this.squares[from] = u.piece;
    if (u.capturedSq >= 0) this.squares[u.capturedSq] = u.captured;
    if (flags & F_CASTLE_K) {
      this.squares[to + 1] = R * color;
      this.squares[to - 1] = EMPTY;
    } else if (flags & F_CASTLE_Q) {
      this.squares[to - 2] = R * color;
      this.squares[to + 1] = EMPTY;
    }
    this.castling = u.castling;
    this.epSquare = u.ep;
    this.kingW = u.kingW;
    this.kingB = u.kingB;
    this.hashLo = u.hashLo;
    this.hashHi = u.hashHi;
    this.turn = u.turn;
    this.ply--;
  }

  // --- forced mutations (MottyBot's cheats; not undoable, full rehash) ---

  forceSet(s, piece) {
    const existing = this.squares[s];
    if (existing === K || existing === -K) throw new Error('kings are never overwritten');
    if (piece === K || piece === -K) throw new Error('kings are only moved, never placed');
    this.squares[s] = piece;
    this.#afterForce();
    return existing;
  }

  forceRemove(s) {
    const p = this.squares[s];
    if (p === K || p === -K) throw new Error('kings are never removed');
    this.squares[s] = EMPTY;
    this.#afterForce();
    return p;
  }

  forceMove(from, to) {
    const p = this.squares[from];
    const target = this.squares[to];
    if (target === K || target === -K) throw new Error('kings are never captured');
    this.squares[to] = p;
    this.squares[from] = EMPTY;
    if (p === K) this.kingW = to;
    else if (p === -K) this.kingB = to;
    this.#afterForce();
    return target;
  }

  forceConvert(s, piece) {
    const p = this.squares[s];
    if (p === K || p === -K) throw new Error('kings are never converted');
    if (piece === K || piece === -K) throw new Error('nothing converts into a king');
    this.squares[s] = piece;
    this.#afterForce();
    return p;
  }

  forceSwap(a, b) {
    const pa = this.squares[a], pb = this.squares[b];
    this.squares[a] = pb;
    this.squares[b] = pa;
    if (pa === K) this.kingW = b;
    else if (pa === -K) this.kingB = b;
    if (pb === K) this.kingW = a;
    else if (pb === -K) this.kingB = a;
    this.#afterForce();
  }

  setTurn(turn) {
    this.turn = turn;
    this.rehash();
  }

  #afterForce() {
    // Rights track board reality after arbitrary mutation.
    if (this.squares[SQ_E1] !== K) this.castling &= ~(CASTLE_WK | CASTLE_WQ);
    if (this.squares[SQ_H1] !== R) this.castling &= ~CASTLE_WK;
    if (this.squares[SQ_A1] !== R) this.castling &= ~CASTLE_WQ;
    if (this.squares[SQ_E8] !== -K) this.castling &= ~(CASTLE_BK | CASTLE_BQ);
    if (this.squares[SQ_H8] !== -R) this.castling &= ~CASTLE_BK;
    if (this.squares[SQ_A8] !== -R) this.castling &= ~CASTLE_BQ;
    this.epSquare = -1;
    this.rehash();
  }

  // --- snapshots (cheat trial-and-error) ---

  snapshot() {
    return {
      squares: this.squares.slice(),
      turn: this.turn,
      castling: this.castling,
      epSquare: this.epSquare,
      kingW: this.kingW,
      kingB: this.kingB,
      ply: this.ply,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
      captured: {
        white: this.captured.white.slice(),
        black: this.captured.black.slice(),
      },
    };
  }

  restore(s) {
    this.squares.set(s.squares);
    this.turn = s.turn;
    this.castling = s.castling;
    this.epSquare = s.epSquare;
    this.kingW = s.kingW;
    this.kingB = s.kingB;
    this.ply = s.ply;
    this.hashLo = s.hashLo;
    this.hashHi = s.hashHi;
    this.captured = {
      white: s.captured.white.slice(),
      black: s.captured.black.slice(),
    };
  }
}
