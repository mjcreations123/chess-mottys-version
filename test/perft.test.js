// Perft against published node counts. Both sides share one movegen, so
// this certifies the player's entire rulebook (pins, ep, castling, promos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../js/engine/board.js';
import { perft, legalMoves } from '../js/engine/movegen.js';

const CASES = [
  ['startpos',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    [20, 400, 8902, 197281]],
  ['kiwipete',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    [48, 2039, 97862]],
  ['pos3 (ep pins)',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    [14, 191, 2812, 43238, 674624]],
  ['pos4 (promos)',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    [6, 264, 9467, 422333]],
  ['pos5',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    [44, 1486, 62379]],
  ['pos6',
    'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    [46, 2079, 89890]],
];

for (const [name, fen, counts] of CASES) {
  test(`perft: ${name}`, () => {
    const board = Board.fromFEN(fen);
    const before = board.toFEN();
    counts.forEach((expected, i) => {
      assert.equal(perft(board, i + 1), expected, `${name} depth ${i + 1}`);
    });
    assert.equal(board.toFEN(), before, 'perft must leave the board untouched');
  });
}

// Deep pass (slow): PERFT_DEEP=1 node --test
if (process.env.PERFT_DEEP) {
  test('perft deep: startpos d5', () => {
    assert.equal(perft(Board.startpos(), 5), 4865609);
  });
  test('perft deep: kiwipete d4', () => {
    const board = Board.fromFEN(
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'
    );
    assert.equal(perft(board, 4), 4085603);
  });
}

test('FEN round-trip', () => {
  for (const [, fen] of CASES) {
    const emitted = Board.fromFEN(fen).toFEN();
    assert.equal(emitted.split(' ').slice(0, 4).join(' '),
      fen.split(' ').slice(0, 4).join(' '));
  }
});

test('incremental hash matches rehash after make/unmake chains', () => {
  const board = Board.fromFEN(CASES[1][1]);
  const walk = (depth) => {
    if (depth === 0) return;
    for (const m of legalMoves(board, board.turn).slice(0, 5)) {
      const u = board.makeMove(m);
      const lo = board.hashLo, hi = board.hashHi;
      board.rehash();
      assert.equal(board.hashLo, lo, 'hashLo drifted');
      assert.equal(board.hashHi, hi, 'hashHi drifted');
      walk(depth - 1);
      board.unmakeMove(u);
    }
  };
  walk(3);
});
