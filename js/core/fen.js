// FEN parsing and surgical edits for teleports. We never trust a library to
// guess castling/en-passant consequences of a teleport; the fields are edited
// here explicitly, so the rules are exactly what the site says they are.

const FILES = 'abcdefgh';

export const SQUARES = (() => {
  const all = [];
  for (let r = 8; r >= 1; r--) for (let f = 0; f < 8; f++) all.push(FILES[f] + r);
  return all;
})();

export function parseFen(fen) {
  const [placement, turn, castling, ep, half, full] = fen.split(' ');
  const board = new Map(); // 'e4' -> { type: 'p', color: 'w' }
  let rank = 8;
  let file = 0;
  for (const ch of placement) {
    if (ch === '/') { rank--; file = 0; }
    else if (ch >= '1' && ch <= '8') file += Number(ch);
    else {
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      board.set(FILES[file] + rank, { type: ch.toLowerCase(), color });
      file++;
    }
  }
  return { board, turn, castling, ep, half: Number(half), full: Number(full) };
}

export function serializeFen(pos) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let run = 0;
    for (let f = 0; f < 8; f++) {
      const piece = pos.board.get(FILES[f] + rank);
      if (!piece) { run++; continue; }
      if (run) { row += run; run = 0; }
      row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    if (run) row += run;
    rows.push(row);
  }
  return `${rows.join('/')} ${pos.turn} ${pos.castling} ${pos.ep} ${pos.half} ${pos.full}`;
}

// Move a piece from -> to (to must be empty), fixing castling and ep fields.
// Mutates and returns pos.
export function applyTeleport(pos, from, to) {
  const piece = pos.board.get(from);
  if (!piece) throw new Error(`no piece on ${from}`);
  if (pos.board.has(to)) throw new Error(`teleport target ${to} occupied`);
  pos.board.delete(from);
  pos.board.set(to, piece);

  // Castling rights: a teleported king or a rook leaving its home corner
  // counts as having moved, permanently.
  let c = pos.castling === '-' ? '' : pos.castling;
  const strip = (letters) => { for (const L of letters) c = c.replace(L, ''); };
  if (piece.type === 'k') strip(piece.color === 'w' ? 'KQ' : 'kq');
  if (piece.type === 'r') {
    if (from === 'h1') strip('K');
    if (from === 'a1') strip('Q');
    if (from === 'h8') strip('k');
    if (from === 'a8') strip('q');
  }
  pos.castling = c || '-';

  // En passant stays valid only if the double-moved pawn is still in place
  // and the capture square is still empty.
  if (pos.ep !== '-') {
    const epFile = pos.ep[0];
    const epRank = Number(pos.ep[1]);
    const pawnSq = epFile + (epRank === 3 ? 4 : 5);
    const wantColor = epRank === 3 ? 'w' : 'b';
    const pawn = pos.board.get(pawnSq);
    if (!pawn || pawn.type !== 'p' || pawn.color !== wantColor || pos.board.has(pos.ep)) {
      pos.ep = '-';
    }
  }
  return pos;
}
