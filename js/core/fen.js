// Small FEN helpers shared by the board UI and replay tooling.

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
