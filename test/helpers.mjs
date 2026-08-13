import { Chess } from '../js/vendor/chess.js';

export function findKing(chess, color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  throw new Error(`no ${color} king`);
}

// Multiset of pieces on the board as a sorted string, e.g. "bB,bK,wK,wQ"
export function materialSignature(chess) {
  const items = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) items.push(cell.color + cell.type);
    }
  }
  return items.sort().join(',');
}

export function checkersOn(fenOrChess, color) {
  const chess = typeof fenOrChess === 'string' ? new Chess(fenOrChess) : fenOrChess;
  const king = findKing(chess, color);
  return chess.attackers(king, color === 'w' ? 'b' : 'w').slice().sort();
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

let passed = 0;
export function ok(name) { passed++; console.log(`  ok - ${name}`); }
export function summary(file) { console.log(`${file}: ${passed} checks passed`); }
