// Piece codes: positive = White, negative = Black (MottyBot).
export const EMPTY = 0;
export const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

export const WHITE = 1;
export const BLACK = -1;

// 0x88 board: square = rank * 16 + file, rank 0 = rank "1" (White's home).
export const FILES = 'abcdefgh';

export const offboard = (s) => (s & 0x88) !== 0;
export const fileOf = (s) => s & 15;
export const rankOf = (s) => s >> 4;
export const square = (file, rank) => rank * 16 + file;
export const alg = (s) => FILES[s & 15] + ((s >> 4) + 1);
export const parseSquare = (str) =>
  (str.charCodeAt(1) - 49) * 16 + (str.charCodeAt(0) - 97);

export const KNIGHT_DELTAS = [33, 31, 18, 14, -14, -18, -31, -33];
export const KING_DELTAS = [17, 16, 15, 1, -1, -15, -16, -17];
export const BISHOP_DIRS = [17, 15, -15, -17];
export const ROOK_DIRS = [16, 1, -1, -16];
export const QUEEN_DIRS = [17, 16, 15, 1, -1, -15, -16, -17];

// Castling-rights bits.
export const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

// Move flags.
export const F_CAPTURE = 1, F_DOUBLE = 2, F_EP = 4,
             F_CASTLE_K = 8, F_CASTLE_Q = 16, F_PROMO = 32;

// Packed move: from | to<<7 | flags<<14 | promoType<<20
export const makeMv = (from, to, flags = 0, promo = 0) =>
  from | (to << 7) | (flags << 14) | (promo << 20);
export const mvFrom = (m) => m & 0x7f;
export const mvTo = (m) => (m >> 7) & 0x7f;
export const mvFlags = (m) => (m >> 14) & 0x3f;
export const mvPromo = (m) => (m >> 20) & 0x7;

export const PIECE_LETTERS = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
export const typeOf = (piece) => (piece < 0 ? -piece : piece);
export const colorOf = (piece) => (piece > 0 ? WHITE : piece < 0 ? BLACK : 0);

// Home squares that affect castling rights.
export const SQ_A1 = 0, SQ_E1 = 4, SQ_H1 = 7,
             SQ_A8 = 112, SQ_E8 = 116, SQ_H8 = 119;

export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
