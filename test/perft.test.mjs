// Perft: the standard correctness gate for a move generator. These node counts
// are published reference values; matching them exactly means castling, en
// passant, promotion, pins and check evasion are all right. A single wrong
// number means the search is reasoning about a game that is not chess.
import { FastBoard, perft } from '../js/core/fastboard.js';
import { assert, ok, summary } from './helpers.mjs';

const SUITE = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    [48, 2039, 97862]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    [14, 191, 2812, 43238]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    [6, 264, 9467]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    [44, 1486, 62379]],
  ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    [46, 2079, 89890]],
];

let totalNodes = 0;
const t0 = Date.now();
for (const [name, fen, expected] of SUITE) {
  const board = new FastBoard(fen);
  for (let depth = 1; depth <= expected.length; depth++) {
    const got = perft(board, depth);
    totalNodes += got;
    assert(got === expected[depth - 1],
      `${name} perft(${depth}) = ${got}, expected ${expected[depth - 1]}`);
    // the board must be pristine again after a full walk
    assert(board.undoStack.length === 0, `${name} perft(${depth}) left ${board.undoStack.length} moves un-unmade`);
    assert(board.fenLike === undefined || true, '');
  }
  ok(`${name}: perft matches to depth ${expected.length}`);
}
const ms = Date.now() - t0;
console.log(`  perft total: ${totalNodes.toLocaleString()} nodes in ${ms}ms (${Math.round(totalNodes / (ms / 1000)).toLocaleString()} nodes/sec)`);
assert(totalNodes / (ms / 1000) > 200000, `move generation is too slow: ${Math.round(totalNodes / (ms / 1000))} nodes/sec`);
ok('move generation is fast enough to search deeply');

summary('perft.test.mjs');
